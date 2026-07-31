import * as assert from "node:assert";
import * as fc from "fast-check";
import * as vscode from "vscode";
import { convertMessages } from "../../shared/messages";
import { validateRequest } from "../../shared/validation";
import { resolveFuzzSeed } from "../fuzzStream";
import { expectDefined } from "../testUtils";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 100;
// Pinned by default; FUZZ_SEED overrides so the nightly explores fresh seeds.
const SEED = resolveFuzzSeed();

/** Minimal 1x1 PNG; convertMessages only inspects the MIME type and bytes. */
const PNG_DATA = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

type ConversationEvent =
	| { kind: "user-text"; text: string }
	| { kind: "assistant-text"; text: string }
	| { kind: "user-image"; text: string }
	| { kind: "tool-exchange"; callId: string; name: string; args: Record<string, unknown>; result: string };

// Nonempty: the converter intentionally drops messages whose only content is
// the empty string, and an empty conversation is rejected by validateRequest.
const textArb = fc.string({ minLength: 1, maxLength: 40 });
const callIdArb = fc
	.tuple(fc.constantFrom("call", "tool", "fn"), fc.nat({ max: 99999 }))
	.map(([prefix, n]) => `${prefix}_${n}`);
const argsArb = fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/), fc.jsonValue({ maxDepth: 1 }), { maxKeys: 3 });

const eventArb: fc.Arbitrary<ConversationEvent> = fc.oneof(
	textArb.map((text): ConversationEvent => ({ kind: "user-text", text })),
	textArb.map((text): ConversationEvent => ({ kind: "assistant-text", text })),
	textArb.map((text): ConversationEvent => ({ kind: "user-image", text })),
	fc
		.record({ callId: callIdArb, name: fc.stringMatching(/^[a-z_]{1,12}$/), args: argsArb, result: textArb })
		.map((exchange): ConversationEvent => ({ kind: "tool-exchange", ...exchange }))
);

function message(
	role: vscode.LanguageModelChatMessageRole,
	content: unknown[]
): vscode.LanguageModelChatRequestMessage {
	return { role, content, name: undefined } as vscode.LanguageModelChatRequestMessage;
}

/** Expand events into a well-paired VS Code message list. */
function buildMessages(events: ConversationEvent[]): vscode.LanguageModelChatRequestMessage[] {
	const messages: vscode.LanguageModelChatRequestMessage[] = [];
	let toolSequence = 0;
	for (const event of events) {
		if (event.kind === "user-text") {
			messages.push(message(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart(event.text)]));
		} else if (event.kind === "assistant-text") {
			messages.push(
				message(vscode.LanguageModelChatMessageRole.Assistant, [new vscode.LanguageModelTextPart(event.text)])
			);
		} else if (event.kind === "user-image") {
			messages.push(
				message(vscode.LanguageModelChatMessageRole.User, [
					new vscode.LanguageModelTextPart(event.text),
					new vscode.LanguageModelDataPart(PNG_DATA, "image/png"),
				])
			);
		} else {
			// Suffix keeps generated call IDs unique across the conversation.
			const callId = `${event.callId}_${toolSequence++}`;
			messages.push(
				message(vscode.LanguageModelChatMessageRole.Assistant, [
					new vscode.LanguageModelToolCallPart(callId, event.name, event.args),
				])
			);
			messages.push(
				message(vscode.LanguageModelChatMessageRole.User, [
					new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart(event.result)]),
				])
			);
		}
	}
	return messages;
}

interface WireMessage {
	role: string;
	content?: unknown;
	tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
}

suite("shared/messages convertMessages properties", () => {
	test("well-paired conversations convert without throwing and pass validation", () => {
		fc.assert(
			fc.property(fc.array(eventArb, { minLength: 1, maxLength: 8 }), (events) => {
				const messages = buildMessages(events);
				validateRequest(messages);
				const converted = convertMessages(messages, { imageInput: true }) as WireMessage[];
				for (const wireMessage of converted) {
					assert.ok(
						["system", "user", "assistant", "tool"].includes(wireMessage.role),
						`unexpected role ${wireMessage.role}`
					);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("every tool result references an earlier assistant tool call", () => {
		fc.assert(
			fc.property(fc.array(eventArb, { maxLength: 8 }), (events) => {
				const converted = convertMessages(buildMessages(events), { imageInput: true }) as WireMessage[];
				const seenCallIds = new Set<string>();
				for (const wireMessage of converted) {
					for (const call of wireMessage.tool_calls ?? []) {
						seenCallIds.add(call.id);
						JSON.parse(call.function.arguments);
					}
					if (wireMessage.role === "tool") {
						const id = wireMessage.tool_call_id ?? "";
						assert.ok(seenCallIds.has(id), `tool result ${id} has no preceding tool call`);
					}
				}
				const expectedExchanges = events.filter((e) => e.kind === "tool-exchange").length;
				assert.strictEqual(seenCallIds.size, expectedExchanges, "every generated tool call must survive conversion");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("user text arrives verbatim and in order", () => {
		fc.assert(
			fc.property(fc.array(textArb, { minLength: 1, maxLength: 6 }), (texts) => {
				const messages = texts.map((text) =>
					message(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart(text)])
				);
				const converted = convertMessages(messages) as WireMessage[];
				const contents = converted.filter((m) => m.role === "user").map((m) => m.content);
				assert.deepStrictEqual(contents, texts, "user text content must survive conversion verbatim and ordered");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("interleaved text and image parts keep their order as content blocks", () => {
		fc.assert(
			fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }), (isImageFlags) => {
				const parts = isImageFlags.map((isImage, i) =>
					isImage ? new vscode.LanguageModelDataPart(PNG_DATA, "image/png") : new vscode.LanguageModelTextPart(`t${i} `)
				);
				const converted = convertMessages([message(vscode.LanguageModelChatMessageRole.User, parts)], {
					imageInput: true,
				}) as WireMessage[];
				const [userMessage] = converted;
				assert.ok(userMessage, "conversion must produce a message");
				if (!isImageFlags.includes(true)) {
					assert.strictEqual(typeof userMessage.content, "string");
					return;
				}
				const blocks = userMessage.content as Array<{ type: string }>;
				assert.ok(Array.isArray(blocks), "multimodal content must be a block array");
				const imageCount = blocks.filter((b) => b.type === "image_url").length;
				assert.strictEqual(imageCount, isImageFlags.filter(Boolean).length, "every image part must survive");
				// Adjacent text parts may merge, but relative text/image order must hold.
				const kinds = blocks.map((b) => (b.type === "image_url" ? "i" : "t")).join("");
				const expected = isImageFlags
					.map((isImage) => (isImage ? "i" : "t"))
					.join("")
					.replace(/t+/g, "t");
				assert.strictEqual(kinds, expected, "text/image ordering must be preserved");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("without imageInput no image_url block is ever produced and the text survives", () => {
		fc.assert(
			fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }), (isImageFlags) => {
				const parts = isImageFlags.map((isImage, i) =>
					isImage ? new vscode.LanguageModelDataPart(PNG_DATA, "image/png") : new vscode.LanguageModelTextPart(`t${i} `)
				);
				const converted = convertMessages([message(vscode.LanguageModelChatMessageRole.User, parts)]) as WireMessage[];
				assert.ok(
					!JSON.stringify(converted).includes("image_url"),
					"a non-vision model must never receive an image block"
				);
				const expectedText = isImageFlags.flatMap((isImage, i) => (isImage ? [] : [`t${i} `])).join("");
				const [userMessage] = converted;
				if (expectedText) {
					assert.strictEqual(expectDefined(userMessage).content, expectedText, "the text survives the image drop");
				} else {
					assert.strictEqual(userMessage, undefined, "an image-only message has nothing left to send");
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
