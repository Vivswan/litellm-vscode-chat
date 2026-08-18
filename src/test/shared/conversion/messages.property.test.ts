import * as assert from "node:assert";
import * as fc from "fast-check";
import * as vscode from "vscode";
import { convertMessages } from "../../../shared/conversion/messages";
import { validateRequest } from "../../../shared/validation";
import { resolveFuzzSeed } from "../../fuzzStream";
import { expectDefined } from "../../pureHelpers";

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

/**
 * How an adversarial generator corrupts one tool exchange. "empty-pair" is the
 * shape validation accepts and the mint repairs; "user-call",
 * "user-call-text", and "nested-call" are valid exotic shapes (the calls ride
 * user messages, so validation's positional walk never sees them); the rest
 * must be rejected before send.
 */
type ExchangeCorruption =
	| "none"
	| "empty-pair"
	| "empty-call"
	| "empty-result"
	| "drop-result"
	| "double-result"
	| "stray-result"
	| "user-call"
	| "user-call-text"
	| "nested-call";

interface AdversarialEvent {
	callId: string;
	corruption: ExchangeCorruption;
}

/** The corruption kinds whose exchange closes cleanly, so a history of only these must pass validation. */
const SENDABLE_CORRUPTIONS: ReadonlySet<ExchangeCorruption> = new Set([
	"none",
	"empty-pair",
	"user-call",
	"user-call-text",
	"nested-call",
]);

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

const corruptionArb: fc.Arbitrary<ExchangeCorruption> = fc.constantFrom(
	"none",
	"empty-pair",
	"empty-call",
	"empty-result",
	"drop-result",
	"double-result",
	"stray-result",
	"user-call",
	"user-call-text",
	"nested-call"
);

// A tiny id pool (with the mint's own prefix in it) makes cross-exchange
// reuse, duplicate-live ids, and mint collisions all reachable.
const adversarialEventArb: fc.Arbitrary<AdversarialEvent> = fc.record({
	callId: fc.constantFrom("call_1", "call_2", "call_synth_0"),
	corruption: corruptionArb,
});

/** Expand corruption-tagged exchanges into messages; only SENDABLE_CORRUPTIONS leave a sendable history. */
function buildAdversarialMessages(events: AdversarialEvent[]): vscode.LanguageModelChatRequestMessage[] {
	const messages: vscode.LanguageModelChatRequestMessage[] = [];
	const assistant = (id: string): void => {
		messages.push(
			message(vscode.LanguageModelChatMessageRole.Assistant, [new vscode.LanguageModelToolCallPart(id, "fn", {})])
		);
	};
	const user = (ids: string[]): void => {
		messages.push(
			message(
				vscode.LanguageModelChatMessageRole.User,
				ids.map((id) => new vscode.LanguageModelToolResultPart(id, [new vscode.LanguageModelTextPart("ok")]))
			)
		);
	};
	for (const event of events) {
		switch (event.corruption) {
			case "none":
				assistant(event.callId);
				user([event.callId]);
				break;
			case "empty-pair":
				assistant("");
				user([""]);
				break;
			case "empty-call":
				assistant("");
				user([event.callId]);
				break;
			case "empty-result":
				assistant(event.callId);
				user([""]);
				break;
			case "drop-result":
				assistant(event.callId);
				break;
			case "double-result":
				assistant(event.callId);
				user([event.callId, event.callId]);
				break;
			case "stray-result":
				user([event.callId]);
				break;
			// The two user-sourced shapes are sendable: pairing is role-agnostic
			// and validation's positional walk covers only assistant messages.
			case "user-call":
				messages.push(
					message(vscode.LanguageModelChatMessageRole.User, [
						new vscode.LanguageModelToolCallPart(event.callId, "fn", {}),
					])
				);
				messages.push(message(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("between")]));
				user([event.callId]);
				break;
			case "user-call-text":
				messages.push(
					message(vscode.LanguageModelChatMessageRole.User, [
						new vscode.LanguageModelToolCallPart(event.callId, "fn", {}),
						new vscode.LanguageModelTextPart("alongside"),
					])
				);
				user([event.callId]);
				break;
			case "nested-call": {
				// A second turn opens inside the first, with text between; the inner
				// id must differ or the history is a duplicate-live reject instead.
				const inner = event.callId === "call_1" ? "call_2" : "call_1";
				messages.push(
					message(vscode.LanguageModelChatMessageRole.User, [
						new vscode.LanguageModelToolCallPart(event.callId, "fn", {}),
					])
				);
				messages.push(
					message(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelToolCallPart(inner, "fn", {})])
				);
				messages.push(message(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("mid")]));
				user([inner]);
				user([event.callId]);
				break;
			}
			default:
				event.corruption satisfies never;
		}
	}
	return messages;
}

/**
 * The wire-pairing bijection LiteLLM's backends enforce: every tool message
 * answers an open tool_call and every tool_call gets exactly one answer,
 * with the answers directly following their tool_calls message - backends
 * reject a non-tool message interleaved into an open turn. An id may recur
 * once answered (some backends mint the same id every turn), so matching is
 * by open count, not global uniqueness.
 */
function assertWirePaired(converted: WireMessage[]): void {
	const open = new Map<string, number>();
	let openTotal = 0;
	for (const wireMessage of converted) {
		if (openTotal > 0) {
			assert.strictEqual(
				wireMessage.role,
				"tool",
				"a non-tool message may never land between a tool_calls message and its answers"
			);
		}
		const ids = (wireMessage.tool_calls ?? []).map((call) => call.id);
		assert.strictEqual(new Set(ids).size, ids.length, "one tool_calls array must not repeat an id");
		for (const id of ids) {
			assert.notStrictEqual(id, "", "an empty tool_call id must never ship");
			open.set(id, (open.get(id) ?? 0) + 1);
			openTotal++;
		}
		if (wireMessage.role === "tool") {
			const id = wireMessage.tool_call_id ?? "";
			const count = open.get(id) ?? 0;
			assert.ok(count > 0, `tool message ${id} answers no open tool call`);
			open.set(id, count - 1);
			openTotal--;
		}
	}
	for (const [id, count] of open) {
		assert.strictEqual(count, 0, `tool call ${id} never got its tool result`);
	}
}

suite("shared/messages convertMessages properties", () => {
	test("any history that passes validateRequest converts to wire-paired messages", () => {
		fc.assert(
			fc.property(fc.array(adversarialEventArb, { minLength: 1, maxLength: 8 }), (events) => {
				const messages = buildAdversarialMessages(events);
				let passed = true;
				try {
					validateRequest(messages);
				} catch (e) {
					assert.ok(e instanceof Error, "validation must reject with an Error");
					passed = false;
				}
				const repairable = events.every((e) => SENDABLE_CORRUPTIONS.has(e.corruption));
				if (repairable) {
					// Non-vacuity: whole-pair shapes (empty ids included) must stay sendable.
					assert.ok(passed, "a history of complete call/result pairs must pass validation");
				}
				if (passed) {
					assertWirePaired(convertMessages(messages, { imageInput: true }) as WireMessage[]);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

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
