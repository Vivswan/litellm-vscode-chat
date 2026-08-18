import * as assert from "node:assert";
import * as fc from "fast-check";
import * as vscode from "vscode";
import { convertMessages } from "../../../shared/conversion/messages";
import { setTextTokenCounting } from "../../../shared/conversion/textTokens";
import { thinkingPartCtor } from "../../../shared/conversion/thinkingPart";
import { estimateMessagesTokens } from "../../../shared/conversion/tokenEstimation";
import type { OpenAIChatMessage } from "../../../shared/conversion/wire";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 100;
// Pinned by default; FUZZ_SEED overrides so the nightly explores fresh seeds.
const SEED = resolveFuzzSeed();

/**
 * The one-pipeline guard: whatever part shapes a request holds, the text the
 * token estimate prices is exactly the text conversion ships. The estimate
 * reads conversion's own output, so this property is what makes a second
 * message-part walk impossible to reintroduce silently - the last one drifted,
 * the budget undercounted, the host skipped trimming, and the request
 * overflowed server-side.
 */

const textArb = fc.oneof(
	fc.string({ maxLength: 24 }),
	// Multibyte text exercises the decode paths (UTF-8 text parts, CJK pricing).
	fc.constantFrom("你好世界", "こんにちは、テスト", "signature-payload", "")
);

/** Every mime class the wire-form seam distinguishes, mappable and not. */
const mimeArb = fc.constantFrom(
	"image/png",
	"image/foo+json",
	"application/pdf",
	"audio/wav",
	"audio/mpeg",
	"audio/ogg",
	"text/plain",
	"application/json",
	"video/mp4"
);

const dataPartArb = fc
	.tuple(fc.uint8Array({ maxLength: 24 }), mimeArb)
	.map(([data, mime]) => new vscode.LanguageModelDataPart(data, mime));

const circularInput = ((): object => {
	const self: { self?: object } = {};
	self.self = self;
	return self;
})();

/** Tool-call inputs across the whole serialization behavior space: plain JSON, no rendering, throwing, circular. */
const toolCallInputArb = fc.oneof(
	fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), fc.jsonValue({ maxDepth: 1 }), { maxKeys: 3 }),
	fc.constant(undefined),
	fc.constant({ toJSON: (): undefined => undefined }),
	fc.constant({
		toJSON: (): never => {
			throw new Error("no rendering");
		},
	}),
	fc.constant(circularInput)
);

// An empty callId takes the generated-id path; ids are wire scaffolding and unpriced.
const toolCallPartArb = fc
	.tuple(fc.constantFrom("call_1", "call_2", ""), fc.stringMatching(/^[a-z_]{1,10}$/), toolCallInputArb)
	.map(([callId, name, input]) => new vscode.LanguageModelToolCallPart(callId, name, input as object));

const promptTsxPartArb = fc
	.oneof(
		textArb,
		fc.jsonValue({ maxDepth: 1 }),
		fc.constant(undefined),
		fc.constant(() => {}),
		fc.constant({ toJSON: (): undefined => undefined })
	)
	.map((value) => new vscode.LanguageModelPromptTsxPart(value));

/** Entries a tool result's content array can hold, recognized classes and raw junk alike. */
const toolResultEntryArb: fc.Arbitrary<unknown> = fc.oneof(
	textArb.map((text) => new vscode.LanguageModelTextPart(text)),
	dataPartArb,
	promptTsxPartArb,
	textArb,
	fc.jsonValue({ maxDepth: 1 }),
	fc.constant(undefined),
	fc.constant(() => {}),
	fc.constant({
		toJSON: (): never => {
			throw new Error("boom");
		},
	}),
	// A nested tool call is nothing the tool-result walk recognizes; it ships
	// as the JSON fallback's rendering like any other stray object.
	toolCallPartArb
);

const toolResultPartArb = fc
	.tuple(fc.constantFrom("call_1", "call_9"), fc.array(toolResultEntryArb, { maxLength: 4 }))
	.map(
		([callId, content]) => new vscode.LanguageModelToolResultPart(callId, content as vscode.LanguageModelTextPart[])
	);

/**
 * Thinking-shaped history objects: signed, redacted, plain, and wrong-typed
 * fields, plus real host thinking parts when this host exposes the class.
 */
const hostThinkingCtor = thinkingPartCtor;
const thinkingShapedArb: fc.Arbitrary<unknown> = fc.oneof(
	fc.record({ value: textArb }),
	fc.record({ value: textArb, metadata: fc.record({ signature: textArb }) }),
	fc.record({ value: textArb, metadata: fc.record({ type: fc.constant("redacted_thinking"), data: textArb }) }),
	fc.constant({ metadata: { type: "redacted_thinking", data: "value-less payload" } }),
	fc.constant({ value: 42, metadata: { signature: "sig-without-text" } }),
	fc.constant({ value: "v", metadata: { signature: 5 } }),
	...(hostThinkingCtor === undefined ? [] : [textArb.map((text) => new hostThinkingCtor(text))])
);

const partArb: fc.Arbitrary<unknown> = fc.oneof(
	textArb.map((text) => new vscode.LanguageModelTextPart(text)),
	toolCallPartArb,
	toolResultPartArb,
	dataPartArb,
	promptTsxPartArb,
	thinkingShapedArb,
	fc.constantFrom<unknown>(null, 17, "a stray string", { some: "object" })
);

// Role 3 is the proposed system role; 7 pins the unknown-role fallback.
const roleArb = fc.constantFrom(
	vscode.LanguageModelChatMessageRole.User,
	vscode.LanguageModelChatMessageRole.Assistant,
	3 as vscode.LanguageModelChatMessageRole,
	7 as vscode.LanguageModelChatMessageRole
);

const messagesArb = fc.array(
	fc
		.tuple(roleArb, fc.array(partArb, { maxLength: 6 }))
		.map(([role, content]) => ({ role, content, name: undefined }) as vscode.LanguageModelChatRequestMessage),
	{ maxLength: 6 }
);

const gatesArb = fc.record({ imageInput: fc.boolean(), audioInput: fc.boolean() });

/**
 * The transmitted text of a converted request as the exact segments the
 * estimator must price, walked independently of the estimator: content strings
 * and text blocks, tool-call name+arguments, and replayed thinking blocks, in
 * wire order. Token counting is non-linear (each priced string ceils on its
 * own; BPE splits at boundaries), so the guard compares segment sequences, not
 * summed characters - a walk that joins or splits differently fails even when
 * the totals happen to agree. Binary payloads (base64 images, files, audio)
 * are not text on either side; roles, ids, and JSON punctuation are wire
 * scaffolding neither side prices.
 */
function shippedTextSegments(messages: OpenAIChatMessage[]): string[] {
	const segments: string[] = [];
	for (const message of messages) {
		const content = message.content;
		if (typeof content === "string") {
			segments.push(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "text") {
					segments.push(block.text);
				}
			}
		}
		if (message.role === "assistant") {
			for (const call of message.tool_calls ?? []) {
				segments.push(call.function.name + call.function.arguments);
			}
			for (const block of message.thinking_blocks ?? []) {
				segments.push(block.type === "thinking" ? block.thinking + block.signature : block.data);
			}
		}
	}
	return segments;
}

suite("shared/conversion/tokenEstimation properties", () => {
	suiteTeardown(() => {
		setTextTokenCounting({ kind: "heuristic" });
	});

	test("the text the estimate prices is exactly the text conversion ships, segment by segment", () => {
		const priced: string[] = [];
		setTextTokenCounting({
			kind: "tokenizer",
			countTokens: (text) => {
				priced.push(text);
				return text.length;
			},
		});
		try {
			fc.assert(
				fc.property(messagesArb, gatesArb, (messages, gates) => {
					priced.length = 0;
					estimateMessagesTokens(messages, gates);
					// The estimator converted internally; this second conversion must
					// agree because every generated part serializes deterministically
					// (only the unpriced generated tool-call ids differ between runs).
					assert.deepStrictEqual(
						priced,
						shippedTextSegments(convertMessages(messages, gates)),
						"the estimator priced text the wire does not carry, missed text it does, or segmented it differently"
					);
				}),
				{ numRuns: NUM_RUNS, seed: SEED }
			);
		} finally {
			setTextTokenCounting({ kind: "heuristic" });
		}
	});

	test("estimation is total and finite on hostile part shapes", () => {
		fc.assert(
			fc.property(messagesArb, gatesArb, (messages, gates) => {
				const estimate = estimateMessagesTokens(messages, gates);
				assert.ok(Number.isFinite(estimate) && estimate >= 0, `estimate must be a finite count, got ${estimate}`);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
