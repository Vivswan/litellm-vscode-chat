import * as assert from "node:assert";
import * as fc from "fast-check";
import { applyPromptCacheBreakpoints, type PromptCachedRequest } from "../../../shared/conversion/promptCache";
import type { OpenAIChatContentBlock, OpenAIChatMessage, OpenAIFunctionToolDef } from "../../../shared/conversion/wire";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 100;
// Pinned by default; FUZZ_SEED overrides so the nightly explores fresh seeds.
const SEED = resolveFuzzSeed();

const textArb = fc.string({ maxLength: 30 });

const blockArb: fc.Arbitrary<OpenAIChatContentBlock> = fc.oneof(
	textArb.map((text): OpenAIChatContentBlock => ({ type: "text", text })),
	fc
		.constant("data:image/png;base64,AAAA")
		.map((url): OpenAIChatContentBlock => ({ type: "image_url", image_url: { url } }))
);

const messageArb: fc.Arbitrary<OpenAIChatMessage> = fc.oneof(
	fc.record({ role: fc.constantFrom("system" as const, "user" as const, "assistant" as const), content: textArb }),
	fc.record({
		role: fc.constant("user" as const),
		content: fc.array(blockArb, { minLength: 1, maxLength: 4 }),
	}),
	fc.record({
		role: fc.constant("tool" as const),
		tool_call_id: fc.constant("call_1"),
		content: textArb,
	}),
	fc.constant<OpenAIChatMessage>({
		role: "assistant",
		content: undefined,
		tool_calls: [{ id: "call_1", type: "function", function: { name: "t", arguments: "{}" } }],
	})
);

const toolArb: fc.Arbitrary<OpenAIFunctionToolDef> = fc
	.stringMatching(/^[a-z_]{1,12}$/)
	.map((name) => ({ type: "function", function: { name, parameters: { type: "object" } } }));

const requestArb = fc.record({
	messages: fc.array(messageArb, { maxLength: 12 }),
	tools: fc.option(fc.array(toolArb, { maxLength: 5 }), { nil: undefined }),
});

/**
 * The message-level marker, probed structurally rather than through the wire
 * type (which only admits it on tool-role messages): the budget property must
 * also catch a marker misplaced on a system/user/assistant message.
 */
function messageMarker(message: OpenAIChatMessage): unknown {
	return (message as { cache_control?: unknown }).cache_control;
}

function countMarkers(result: PromptCachedRequest): number {
	let count = (result.tools ?? []).filter((tool) => tool.cache_control !== undefined).length;
	for (const message of result.messages) {
		if (messageMarker(message) !== undefined) {
			count += 1;
		}
		if (Array.isArray(message.content)) {
			count += message.content.filter((block) => block.type === "text" && block.cache_control !== undefined).length;
		}
	}
	return count;
}

/** True when the message carries no marker anywhere. */
function isUnmarked(message: OpenAIChatMessage): boolean {
	return (
		messageMarker(message) === undefined &&
		(!Array.isArray(message.content) ||
			message.content.every((block) => block.type !== "text" || block.cache_control === undefined))
	);
}

/** The message's text, independent of string vs block-array form. */
function messageText(message: OpenAIChatMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	if (!Array.isArray(message.content)) {
		return "";
	}
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

suite("shared/promptCache properties", () => {
	test("never emits more than four cache_control markers", () => {
		fc.assert(
			fc.property(requestArb, (request) => {
				assert.ok(countMarkers(applyPromptCacheBreakpoints(request)) <= 4);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("preserves message count, order, roles, text, and unmarked messages verbatim", () => {
		fc.assert(
			fc.property(requestArb, (request) => {
				const result = applyPromptCacheBreakpoints(request);
				assert.strictEqual(result.messages.length, request.messages.length);
				assert.strictEqual(result.tools?.length, request.tools?.length);
				for (const [i, output] of result.messages.entries()) {
					const input = request.messages[i] as OpenAIChatMessage;
					assert.strictEqual(output.role, input.role);
					assert.strictEqual(messageText(output), messageText(input), "marking must not change text");
					if (isUnmarked(output)) {
						assert.deepStrictEqual(output, input, "non-anchor messages pass through verbatim");
					}
				}
				for (const [i, tool] of (result.tools ?? []).entries()) {
					const { cache_control, ...bare } = tool;
					assert.deepStrictEqual(bare, request.tools?.[i], "tool definitions survive unchanged");
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("is idempotent: a second application changes nothing", () => {
		fc.assert(
			fc.property(requestArb, (request) => {
				const once = applyPromptCacheBreakpoints(request);
				const twice = applyPromptCacheBreakpoints({ messages: once.messages, tools: once.tools });
				assert.deepStrictEqual(twice, once);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("never mutates its input", () => {
		fc.assert(
			fc.property(requestArb, (request) => {
				// structuredClone both sides: fast-check records carry a null
				// prototype, which deepStrictEqual would otherwise flag.
				const snapshot = structuredClone(request);
				applyPromptCacheBreakpoints(request);
				assert.deepStrictEqual(structuredClone(request), snapshot);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
