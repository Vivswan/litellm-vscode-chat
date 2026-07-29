import * as assert from "node:assert";
import * as vscode from "vscode";
import { StreamProcessor } from "../../provider/streaming";
import type { DataPartCtor } from "../../shared/dataPart";
import { resetDataPartLogOnce } from "../../shared/dataPart";
import type { ThinkingPartCtor } from "../../shared/thinkingPart";
import { resetThinkingPartLogOnce } from "../../shared/thinkingPart";
import { expectDefined } from "../testUtils";

/** A standalone tool-call ID source with an observable count, mirroring the ChatClient's. */
function idSource(): { next(): number; readonly count: number } {
	let count = 0;
	return {
		next: () => ++count,
		get count() {
			return count;
		},
	};
}

function collector(): {
	parts: vscode.LanguageModelResponsePart[];
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
} {
	const parts: vscode.LanguageModelResponsePart[] = [];
	return { parts, progress: { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) } };
}

function toolCallsOf(parts: vscode.LanguageModelResponsePart[]): vscode.LanguageModelToolCallPart[] {
	return parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart[];
}

function visibleTextOf(parts: vscode.LanguageModelResponsePart[]): string {
	return parts
		.filter((p) => p instanceof vscode.LanguageModelTextPart)
		.map((p) => (p as vscode.LanguageModelTextPart).value)
		.join("");
}

/** Normalized event sequence: adjacent text parts merge, tool calls keep order. */
function eventSequenceOf(parts: vscode.LanguageModelResponsePart[]): string[] {
	const events: string[] = [];
	for (const part of parts) {
		if (part instanceof vscode.LanguageModelTextPart) {
			const last = events[events.length - 1];
			if (last?.startsWith("text:")) {
				events[events.length - 1] = last + part.value;
			} else {
				events.push(`text:${part.value}`);
			}
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			events.push(`tool:${part.name}`);
		}
	}
	return events;
}

function sseStream(chunks: string[], onEnd?: () => void): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(encoder.encode(chunks[i++]));
			} else {
				onEnd?.();
				controller.close();
			}
		},
	});
}

suite("provider/streaming", () => {
	test("processDelta emits text content from string delta", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		const emitted = stream.processDelta({ choices: [{ delta: { content: "Hello world" } }] }, progress);

		assert.ok(emitted, "Should report emitted = true");
		assert.ok(parts.length > 0, "Should emit at least one part");
		const textPart = parts.find((p) => p instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart;
		assert.ok(textPart, "Should emit a text part");
		assert.ok(textPart.value.includes("Hello world"), "Text should contain the content");
	});

	test("processDelta handles tool calls in delta", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		stream.processDelta(
			{
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, id: "call_123", function: { name: "test_tool", arguments: '{"key":"value"}' } }],
						},
					},
				],
			},
			progress
		);

		assert.ok(parts.length > 0, "Should emit tool call part");
		const toolPart = parts.find(
			(p) => p instanceof vscode.LanguageModelToolCallPart
		) as vscode.LanguageModelToolCallPart;
		assert.ok(toolPart, "Should emit a LanguageModelToolCallPart");
		assert.equal(toolPart.name, "test_tool");
	});

	test("processDelta logs token usage", async () => {
		const logs: string[] = [];
		const stream = new StreamProcessor(idSource(), (msg, data) => {
			logs.push(data !== undefined ? `${msg}: ${JSON.stringify(data)}` : msg);
		});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		stream.processDelta(
			{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
			progress
		);

		assert.ok(
			logs.some((l) => l.includes("Token usage")),
			"Should log token usage"
		);
	});

	test("processTextContent strips control tokens", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		const result = stream.processTextContent(
			"Hello <|tool_calls_section_begin|>world<|tool_calls_section_end|>",
			progress
		);

		assert.ok(result.emittedText, "Should emit text");
		const textPart = parts.find((p) => p instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart;
		assert.ok(textPart, "Should emit a text part");
		assert.ok(!textPart.value.includes("<|"), "Should not contain control tokens");
		assert.ok(textPart.value.includes("Hello"), "Should preserve visible text");
		assert.ok(textPart.value.includes("world"), "Should preserve visible text");
	});

	test("processTextContent parses inline tool calls", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		stream.processTextContent(
			'<|tool_call_begin|>my_tool<|tool_call_argument_begin|>{"arg":"val"}<|tool_call_end|>',
			progress
		);

		const toolPart = parts.find(
			(p) => p instanceof vscode.LanguageModelToolCallPart
		) as vscode.LanguageModelToolCallPart;
		assert.ok(toolPart, "Should emit a tool call from inline control tokens");
		assert.equal(toolPart.name, "my_tool");
		assert.deepEqual(toolPart.input, { arg: "val" });
	});

	test("a complete inline call with invalid JSON args is dropped with a classification-only log", () => {
		const logs: Array<{ msg: string; data?: unknown }> = [];
		const stream = new StreamProcessor(idSource(), (msg, data) => logs.push({ msg, data }));
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		stream.processTextContent(
			"<|tool_call_begin|>secret_tool<|tool_call_argument_begin|>{oops<|tool_call_end|> after",
			progress
		);

		assert.equal(toolCallsOf(parts).length, 0, "invalid args must not emit a call");
		const drop = logs.find((l) => l.msg.includes("Dropping inline tool call with invalid JSON arguments"));
		assert.ok(drop, "the drop must be logged");
		assert.deepStrictEqual(drop.data, { argsLength: "{oops".length }, "classification only");
		assert.ok(!JSON.stringify(logs).includes("secret_tool"), "the tool name is response text and must not be logged");
	});

	test("buffered tool call without id gets generated call_N id and advances the counter", async () => {
		const ids = idSource();
		const stream = new StreamProcessor(ids, () => {});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		stream.processDelta(
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "no_id_tool", arguments: "{}" } }] } }] },
			progress
		);

		const toolPart = parts.find(
			(p) => p instanceof vscode.LanguageModelToolCallPart
		) as vscode.LanguageModelToolCallPart;
		assert.ok(toolPart, "Should emit the buffered tool call");
		assert.equal(toolPart.callId, "call_1");
		assert.equal(ids.count, 1);
	});

	test("a terminal finish_reason flushes buffered state without the [DONE] fallback", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		// A buffered call with complete arguments but no name cannot emit early
		// (only the end-of-stream flush names it unknown_tool), and no [DONE] or
		// EOF follows here, so the finish_reason chunk alone must flush it.
		stream.processDelta(
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { arguments: '{"a":1}' } }] } }] },
			progress
		);
		assert.equal(parts.length, 0, "a nameless buffered call must not emit before the flush");

		stream.processDelta({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }, progress);

		const toolParts = toolCallsOf(parts);
		assert.equal(toolParts.length, 1, "the finish chunk itself must flush the buffer");
		const toolPart = expectDefined(toolParts[0]);
		assert.equal(toolPart.callId, "call_x");
		assert.equal(toolPart.name, "unknown_tool");
		assert.deepEqual(toolPart.input, { a: 1 });
	});

	test("tool call arguments split across deltas emit exactly once, including after finish_reason", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		stream.processDelta(
			{
				choices: [
					{
						delta: { tool_calls: [{ index: 0, id: "call_abc", function: { name: "split_tool", arguments: '{"a"' } }] },
					},
				],
			},
			progress
		);
		assert.equal(parts.length, 0, "Should not emit while arguments are incomplete JSON");

		stream.processDelta(
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"b"}' } }] } }] },
			progress
		);
		stream.processDelta({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }, progress);

		const toolParts = parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
		assert.equal(toolParts.length, 1, "Should emit exactly one tool call part");
		const toolPart = toolParts[0] as vscode.LanguageModelToolCallPart;
		assert.equal(toolPart.callId, "call_abc");
		assert.equal(toolPart.name, "split_tool");
		assert.deepEqual(toolPart.input, { a: "b" });
	});

	test("partial inline begin token held across chunk boundary", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		stream.processTextContent("Hello <|tool_", progress);
		stream.processTextContent('call_begin|>my_tool<|tool_call_argument_begin|>{"x":1}<|tool_call_end|> done', progress);

		const visible = parts
			.filter((p) => p instanceof vscode.LanguageModelTextPart)
			.map((p) => (p as vscode.LanguageModelTextPart).value)
			.join("");
		assert.equal(visible, "Hello  done");
		const toolParts = parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
		assert.equal(toolParts.length, 1, "Should emit exactly one tool call");
		assert.equal((toolParts[0] as vscode.LanguageModelToolCallPart).name, "my_tool");
		assert.deepEqual((toolParts[0] as vscode.LanguageModelToolCallPart).input, { x: 1 });
	});

	test("a spacer text part is emitted between assistant text and the first tool call delta", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		stream.processDelta({ choices: [{ delta: { content: "Answer" } }] }, progress);
		stream.processDelta(
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "t", arguments: "{}" } }] } }] },
			progress
		);

		const values = parts.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : "<tool>"));
		assert.deepEqual(values, ["Answer", " ", "<tool>"]);
	});

	test("structured content block arrays emit their text blocks", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		stream.processDelta(
			{
				choices: [
					{
						delta: {
							content: [{ type: "text", text: "block one " }, { type: "unknown" }, { type: "text", text: "block two" }],
						},
					},
				],
			},
			progress
		);

		const visible = parts
			.filter((p) => p instanceof vscode.LanguageModelTextPart)
			.map((p) => (p as vscode.LanguageModelTextPart).value)
			.join("");
		assert.equal(visible, "block one block two");
	});
});

suite("provider/streaming tool call index normalization", () => {
	test("numeric-string index from a proxy shares the buffer with its numeric twin", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		stream.processDelta(
			{ choices: [{ delta: { tool_calls: [{ index: "0", id: "c9", function: { name: "s", arguments: '{"k"' } }] } }] },
			progress
		);
		stream.processDelta(
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"v"}' } }] } }] },
			progress
		);
		stream.processDelta({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }, progress);

		const toolParts = toolCallsOf(parts);
		assert.equal(toolParts.length, 1, "String and numeric index must address the same buffer");
		const dedupCall = expectDefined(toolParts[0]);
		assert.equal(dedupCall.callId, "c9");
		assert.deepEqual(dedupCall.input, { k: "v" });
	});
});

suite("provider/streaming dedup across channels", () => {
	const INLINE_DUP = '<|tool_call_begin|>dup<|tool_call_argument_begin|>{"x":1}<|tool_call_end|>';

	test("delta-then-inline emits exactly one part", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [{ delta: { tool_calls: [{ index: 0, id: "d1", function: { name: "dup", arguments: '{"x":1}' } }] } }],
			},
			progress
		);
		stream.processTextContent(INLINE_DUP, progress);

		assert.equal(toolCallsOf(parts).length, 1);
	});

	test("inline-then-delta emits exactly one part", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		stream.processTextContent(INLINE_DUP, progress);
		stream.processDelta(
			{
				choices: [{ delta: { tool_calls: [{ index: 0, id: "d1", function: { name: "dup", arguments: '{"x":1}' } }] } }],
			},
			progress
		);
		stream.processDelta({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }, progress);

		assert.equal(toolCallsOf(parts).length, 1);
	});

	test("two identical calls at different delta indices both emit", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: "a", function: { name: "dup", arguments: '{"x":1}' } },
								{ index: 1, id: "b", function: { name: "dup", arguments: '{"x":1}' } },
							],
						},
					},
				],
			},
			progress
		);

		const toolParts = toolCallsOf(parts);
		assert.equal(toolParts.length, 2, "Parallel identical calls must not be deduped");
		assert.deepEqual(
			toolParts.map((p) => p.callId),
			["a", "b"]
		);
	});

	test("suppression consumes one pending count: inline, then two delta twins emit one more", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		stream.processTextContent(INLINE_DUP, progress);
		stream.processDelta(
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: "a", function: { name: "dup", arguments: '{"x":1}' } },
								{ index: 1, id: "b", function: { name: "dup", arguments: '{"x":1}' } },
							],
						},
					},
				],
			},
			progress
		);
		stream.processDelta({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }, progress);

		assert.equal(
			toolCallsOf(parts).length,
			2,
			"One delta twin matches the inline call; the second is a distinct parallel call"
		);
	});

	test("two delta twins then two inline copies emit exactly two calls", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: "a", function: { name: "dup", arguments: '{"x":1}' } },
								{ index: 1, id: "b", function: { name: "dup", arguments: '{"x":1}' } },
							],
						},
					},
				],
			},
			progress
		);
		stream.processTextContent(INLINE_DUP, progress);
		stream.processTextContent(INLINE_DUP, progress);

		assert.equal(toolCallsOf(parts).length, 2, "Both inline copies are duplicates of the two delta calls");
	});

	test("an inline replay of a consumed cross-channel duplicate stays suppressed", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [{ delta: { tool_calls: [{ index: 0, id: "d1", function: { name: "dup", arguments: '{"x":1}' } }] } }],
			},
			progress
		);
		stream.processTextContent(INLINE_DUP, progress);
		stream.processTextContent(INLINE_DUP, progress);

		assert.equal(toolCallsOf(parts).length, 1, "The replayed inline duplicate must not emit after consumption");
	});
});

suite("provider/streaming inline token byte-boundary splits", () => {
	test("full inline call split at every byte offset yields identical output", () => {
		const full = 'Hello <|tool_call_begin|>my_tool<|tool_call_argument_begin|>{"a":1}<|tool_call_end|> world';
		for (let i = 1; i < full.length; i++) {
			const stream = new StreamProcessor(idSource(), () => {});
			const { parts, progress } = collector();
			stream.processTextContent(full.slice(0, i), progress);
			stream.processTextContent(full.slice(i), progress);

			assert.equal(visibleTextOf(parts), "Hello  world", `Visible text diverged at split offset ${i}`);
			assert.deepEqual(
				eventSequenceOf(parts),
				["text:Hello ", "tool:my_tool", "text: world"],
				`Event order diverged at split offset ${i}`
			);
			const toolParts = toolCallsOf(parts);
			assert.equal(toolParts.length, 1, `Tool call count diverged at split offset ${i}`);
			const call = expectDefined(toolParts[0]);
			assert.equal(call.name, "my_tool", `Tool name diverged at split offset ${i}`);
			assert.deepEqual(call.input, { a: 1 }, `Tool args diverged at split offset ${i}`);
		}
	});

	test("argument-less inline call split at every byte offset yields identical output", () => {
		const full = "before <|tool_call_begin|>ping<|tool_call_end|> after";
		for (let i = 1; i < full.length; i++) {
			const stream = new StreamProcessor(idSource(), () => {});
			const { parts, progress } = collector();
			stream.processTextContent(full.slice(0, i), progress);
			stream.processTextContent(full.slice(i), progress);

			assert.equal(visibleTextOf(parts), "before  after", `Visible text diverged at split offset ${i}`);
			assert.deepEqual(
				eventSequenceOf(parts),
				["text:before ", "tool:ping", "text: after"],
				`Event order diverged at split offset ${i}`
			);
			const toolParts = toolCallsOf(parts);
			assert.equal(toolParts.length, 1, `Tool call count diverged at split offset ${i}`);
			const call = expectDefined(toolParts[0]);
			assert.equal(call.name, "ping", `Tool name diverged at split offset ${i}`);
			assert.deepEqual(call.input, {}, `Tool args diverged at split offset ${i}`);
		}
	});
});

suite("provider/streaming thinking parts", () => {
	class FakeThinkingPart {
		constructor(
			public text: string,
			public id?: string,
			public metadata?: unknown
		) {}
	}
	const fakeCtor = FakeThinkingPart as unknown as ThinkingPartCtor;

	test("structured thinking object emits a thinking part", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { thinking: { text: "deep", id: "t1" } } }] }, progress);

		assert.equal(parts.length, 1);
		const part = parts[0] as unknown as FakeThinkingPart;
		assert.ok(part instanceof FakeThinkingPart);
		assert.equal(part.text, "deep");
		assert.equal(part.id, "t1");
	});

	test("reasoning_content string emits a thinking part", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { reasoning_content: "steps" } }] }, progress);

		assert.equal(parts.length, 1);
		assert.equal((parts[0] as unknown as FakeThinkingPart).text, "steps");
	});

	test("reasoning string emits a thinking part", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { reasoning: "why" } }] }, progress);

		assert.equal(parts.length, 1);
		assert.equal((parts[0] as unknown as FakeThinkingPart).text, "why");
	});

	test("a throwing thinking constructor is logged and text in the same delta still emits", async () => {
		const logs: string[] = [];
		const throwingCtor = class {
			constructor() {
				throw new Error("boom");
			}
		} as unknown as ThinkingPartCtor;
		const stream = new StreamProcessor(idSource(), (msg) => logs.push(msg), throwingCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { thinking: "x", content: "visible" } }] }, progress);

		assert.ok(
			logs.some((l) => l.includes("Failed to construct thinking part")),
			"Constructor failure must be logged"
		);
		assert.equal(visibleTextOf(parts), "visible");
	});

	test("no thinking part is emitted when the constructor is unavailable", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, null);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { reasoning_content: "hidden" } }] }, progress);

		assert.equal(parts.length, 0);
	});

	test("thinking_blocks emit one part per block and suppress the duplicate reasoning_content", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [
					{
						delta: {
							reasoning_content: "step one",
							thinking_blocks: [{ type: "thinking", thinking: "step one", signature: "sig-1" }],
						},
					},
				],
			},
			progress
		);

		assert.equal(parts.length, 1, "The block and reasoning_content carry the same text; only the block may emit");
		const part = parts[0] as unknown as FakeThinkingPart;
		assert.equal(part.text, "step one");
		assert.deepEqual(part.metadata, { type: "thinking", signature: "sig-1" });
	});

	test("a redacted thinking block emits an empty-text part carrying the opaque data", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta(
			{ choices: [{ delta: { thinking_blocks: [{ type: "redacted_thinking", data: "opaque" }] } }] },
			progress
		);

		assert.equal(parts.length, 1);
		const part = parts[0] as unknown as FakeThinkingPart;
		assert.equal(part.text, "");
		assert.deepEqual(part.metadata, { type: "redacted_thinking", data: "opaque" });
	});

	test("an empty choice-level thinking string does not suppress populated delta thinking", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ thinking: "", delta: { thinking: "deep" } }] }, progress);

		assert.equal(parts.length, 1);
		assert.equal((parts[0] as unknown as FakeThinkingPart).text, "deep");
	});

	test("an empty reasoning_content does not suppress populated reasoning", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { reasoning_content: "", reasoning: "why" } }] }, progress);

		assert.equal(parts.length, 1);
		assert.equal((parts[0] as unknown as FakeThinkingPart).text, "why");
	});

	test("contentless thinking_blocks do not suppress populated reasoning_content", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { thinking_blocks: [{}], reasoning_content: "steps" } }] }, progress);

		assert.equal(parts.length, 1);
		assert.equal((parts[0] as unknown as FakeThinkingPart).text, "steps");
	});
});

suite("provider/streaming thinking part pass-through", () => {
	class FakeThinkingPart {
		constructor(
			public text: string,
			public id?: string,
			public metadata?: unknown
		) {}
	}
	const fakeCtor = FakeThinkingPart as unknown as ThinkingPartCtor;

	setup(() => resetThinkingPartLogOnce());
	teardown(() => resetThinkingPartLogOnce());

	function thinkingPartsOf(parts: vscode.LanguageModelResponsePart[]): FakeThinkingPart[] {
		return parts.filter((p) => p instanceof FakeThinkingPart) as unknown as FakeThinkingPart[];
	}

	test("wire-provided ids pass through untouched", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { thinking: { text: "a1", id: "wire-a" } } }] }, progress);
		stream.processDelta({ choices: [{ delta: { thinking: { text: "a2", id: "wire-a" } } }] }, progress);
		stream.processDelta({ choices: [{ delta: { thinking: { text: "b1", id: "wire-b" } } }] }, progress);

		assert.deepEqual(
			thinkingPartsOf(parts).map((p) => p.id),
			["wire-a", "wire-a", "wire-b"]
		);
	});

	test("id-less thinking deltas emit with no id; the host mints its own unique one", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { reasoning_content: "step one " } }] }, progress);
		stream.processDelta({ choices: [{ delta: { reasoning: "step two " } }] }, progress);
		stream.processDelta(
			{ choices: [{ delta: { thinking_blocks: [{ type: "thinking", thinking: "three" }] } }] },
			progress
		);

		assert.deepEqual(
			thinkingPartsOf(parts).map((p) => p.id),
			[undefined, undefined, undefined]
		);
	});

	test("an empty-text signature part is emitted, not dropped: the host treats empty chunks as thinking separators", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta(
			{ choices: [{ delta: { thinking_blocks: [{ type: "thinking", signature: "sig-2" }] } }] },
			progress
		);

		const emitted = thinkingPartsOf(parts);
		assert.equal(emitted.length, 1);
		assert.equal(expectDefined(emitted[0]).text, "");
		assert.equal(expectDefined(emitted[0]).id, undefined);
		assert.deepEqual(expectDefined(emitted[0]).metadata, { type: "thinking", signature: "sig-2" });
	});

	test("signature and redacted metadata pass through emission byte-identical, with no minted id", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta(
			{ choices: [{ delta: { thinking_blocks: [{ type: "thinking", thinking: "final", signature: "sig-1" }] } }] },
			progress
		);
		stream.processDelta(
			{ choices: [{ delta: { thinking_blocks: [{ type: "redacted_thinking", data: "opaque" }] } }] },
			progress
		);

		const emitted = thinkingPartsOf(parts);
		assert.equal(emitted.length, 2);
		assert.deepEqual(
			emitted.map((p) => ({ id: p.id, metadata: p.metadata })),
			[
				{ id: undefined, metadata: { type: "thinking", signature: "sig-1" } },
				{ id: undefined, metadata: { type: "redacted_thinking", data: "opaque" } },
			]
		);
	});

	test("a missing thinking class is logged once across processors and reasoning is dropped", async () => {
		const logs: string[] = [];
		const first = new StreamProcessor(idSource(), (msg) => logs.push(msg), null);
		const second = new StreamProcessor(idSource(), (msg) => logs.push(msg), null);
		const { parts, progress } = collector();

		first.processDelta({ choices: [{ delta: { reasoning_content: "hidden" } }] }, progress);
		first.processDelta({ choices: [{ delta: { reasoning_content: "still hidden" } }] }, progress);
		second.processDelta({ choices: [{ delta: { reasoning: "also hidden" } }] }, progress);

		assert.equal(parts.length, 0, "Reasoning must be dropped, not emitted as text");
		assert.deepEqual(logs, ["Host does not support thinking parts; reasoning output will not be displayed"]);
	});
});

suite("provider/streaming refusal and annotations", () => {
	test("refusal deltas surface as response text and are logged once", async () => {
		const logs: string[] = [];
		const stream = new StreamProcessor(idSource(), (msg) => logs.push(msg));
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { refusal: "I cannot help" } }] }, progress);
		stream.processDelta({ choices: [{ delta: { refusal: " with that." } }] }, progress);

		assert.equal(visibleTextOf(parts), "I cannot help with that.");
		assert.equal(logs.filter((l) => l.includes("Model refused the request")).length, 1);
	});

	test("url citations from annotations emit one sources trailer at end of stream", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [
					{
						delta: {
							content: "The sky is blue.",
							annotations: [
								{ type: "url_citation", url_citation: { url: "https://example.test/sky", title: "Sky" } },
								{ type: "url_citation", url_citation: { url: "https://example.test/sky", title: "Sky again" } },
							],
						},
					},
				],
			},
			progress
		);
		stream.processDelta({ choices: [{ delta: {}, finish_reason: "stop" }] }, progress);
		// The [DONE] line runs the end-of-stream path a second time; the trailer must not repeat.
		stream.processDelta({ choices: [{ delta: {}, finish_reason: "stop" }] }, progress);

		const text = visibleTextOf(parts);
		assert.ok(text.includes("The sky is blue."), "Content must still render");
		assert.equal(text.match(/Sources:/g)?.length, 1, "Exactly one sources trailer");
		assert.ok(text.includes("[Sky](https://example.test/sky)"), "Citation renders as a markdown link");
		assert.equal(text.match(/example\.test\/sky/g)?.length, 1, "Duplicate URLs collapse to one entry");
	});

	test("annotations without a url are ignored", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		stream.processDelta(
			{ choices: [{ delta: { content: "text", annotations: [{ type: "url_citation" }] } }] },
			progress
		);
		stream.processDelta({ choices: [{ delta: {}, finish_reason: "stop" }] }, progress);

		assert.equal(visibleTextOf(parts), "text");
	});

	test("citation titles and urls are escaped in the sources trailer", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [
					{
						delta: {
							content: "cited",
							annotations: [
								{
									type: "url_citation",
									url_citation: { url: "https://example.test/a (b)", title: "Line]\nbreak [x]" },
								},
							],
						},
					},
				],
			},
			progress
		);
		stream.processDelta({ choices: [{ delta: {}, finish_reason: "stop" }] }, progress);

		const text = visibleTextOf(parts);
		assert.ok(text.includes("[Line\\] break \\[x\\]]"), `title must be escaped and newline-flattened, got ${text}`);
		assert.ok(text.includes("(https://example.test/a%20%28b%29)"), `url must be percent-encoded, got ${text}`);
	});
});

suite("provider/streaming pass-through of unhandled modern fields", () => {
	test("usage token detail objects are logged wholesale", async () => {
		const logged: { message: string; data?: unknown }[] = [];
		const stream = new StreamProcessor(idSource(), (message, data) => logged.push({ message, data }));
		const { progress } = collector();

		stream.processDelta(
			{
				choices: [],
				usage: {
					prompt_tokens: 120,
					completion_tokens: 80,
					total_tokens: 200,
					prompt_tokens_details: { cached_tokens: 90 },
					completion_tokens_details: { reasoning_tokens: 40 },
				},
			},
			progress
		);

		const usageLog = logged.find((l) => l.message === "Token usage");
		const data = expectDefined(usageLog?.data) as Record<string, unknown>;
		assert.deepEqual(data.prompt_tokens_details, { cached_tokens: 90 });
		assert.deepEqual(data.completion_tokens_details, { reasoning_tokens: 40 });
	});
});

suite("provider/streaming generated media", () => {
	class FakeDataPart {
		constructor(
			public data: Uint8Array,
			public mimeType: string
		) {}
	}
	const fakeDataCtor = FakeDataPart as unknown as DataPartCtor;

	setup(() => resetDataPartLogOnce());
	teardown(() => resetDataPartLogOnce());

	function mediaProcessor(log: (message: string, data?: unknown) => void = () => {}): StreamProcessor {
		return new StreamProcessor(idSource(), log, null, fakeDataCtor);
	}

	function dataPartsOf(parts: vscode.LanguageModelResponsePart[]): FakeDataPart[] {
		return parts.filter((p) => p instanceof FakeDataPart) as unknown as FakeDataPart[];
	}

	const finish = { choices: [{ delta: {}, finish_reason: "stop" }] };

	test("a delta.images data URL becomes one DataPart with decoded bytes and the header mime", () => {
		const stream = mediaProcessor();
		const { parts, progress } = collector();

		const emitted = stream.processDelta(
			{
				choices: [{ delta: { images: [{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }] } }],
			},
			progress
		);

		assert.ok(emitted, "an image DataPart counts as emitted output");
		const images = dataPartsOf(parts);
		assert.equal(images.length, 1);
		const image = expectDefined(images[0]);
		assert.equal(image.mimeType, "image/png");
		assert.deepStrictEqual(image.data, new Uint8Array([1, 2, 3]));
	});

	test("images emit in stream order relative to text", () => {
		const stream = mediaProcessor();
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { content: "before " } }] }, progress);
		stream.processDelta(
			{
				choices: [
					{
						delta: {
							images: [
								{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
								{ type: "image_url", image_url: { url: "data:image/jpeg;base64,BAUG" } },
							],
						},
					},
				],
			},
			progress
		);
		stream.processDelta({ choices: [{ delta: { content: "after" } }] }, progress);

		const kinds = parts.map((p) => (p instanceof FakeDataPart ? `data:${p.mimeType}` : "text"));
		assert.deepEqual(kinds, ["text", "data:image/png", "data:image/jpeg", "text"]);
		assert.equal(visibleTextOf(parts), "before after");
	});

	test("a malformed base64 image is skipped with one classification log per request, never a flood", () => {
		const logs: string[] = [];
		const stream = mediaProcessor((msg) => logs.push(msg));
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [
					{
						delta: {
							images: [
								{ type: "image_url", image_url: { url: "data:image/png;base64,@@not-base64@@" } },
								{ type: "image_url", image_url: { url: "data:image/png;base64,%%also-bad%%" } },
								{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
							],
						},
					},
				],
			},
			progress
		);
		stream.processDelta(
			{ choices: [{ delta: { images: [{ type: "image_url", image_url: { url: "data:x;base64,AQID" } }] } }] },
			progress
		);
		stream.processDelta({ choices: [{ delta: { content: "still streaming" } }] }, progress);

		assert.equal(dataPartsOf(parts).length, 1, "the decodable sibling must still emit");
		assert.equal(visibleTextOf(parts), "still streaming");
		const skipLogs = logs.filter((l) => l.includes("Skipping generated image"));
		assert.equal(skipLogs.length, 1, "the skip is logged once per request, however many entries are bad");
		assert.ok(!logs.some((l) => l.includes("@@not-base64@@")), "logs must never carry response-derived content");
	});

	test("base64 validation is canonical: truncated groups and noncanonical pad bits skip instead of corrupting", () => {
		// codex's cases: bare/short padding and noncanonical pad bits, which
		// Buffer would silently decode to empty or truncated bytes; plus the
		// cases the first round already rejected (alphabet, length, URL-safe).
		const rejected = ["=", "==", "AA=", "AAA==", "AB==", "U", "UklGRg", "AQI_", "AQI-", "@@@@", "AQ=A", "===="];
		for (const payload of rejected) {
			const logs: string[] = [];
			const stream = mediaProcessor((msg) => logs.push(msg));
			const { parts, progress } = collector();
			stream.processDelta(
				{
					choices: [
						{ delta: { images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${payload}` } }] } },
					],
				},
				progress
			);
			assert.equal(dataPartsOf(parts).length, 0, `payload ${JSON.stringify(payload)} must be rejected`);
			assert.ok(
				logs.some((l) => l.includes("Skipping generated image")),
				`payload ${JSON.stringify(payload)} must be logged as a skip`
			);
		}

		const accepted: Array<[string, number[]]> = [
			["AQID", [1, 2, 3]],
			["UklGRg==", [0x52, 0x49, 0x46, 0x46]],
			["AAA=", [0, 0]],
			["AA==", [0]],
			// MIME-style wrapped base64: ASCII whitespace strips before validation.
			["UklG\r\nRg==", [0x52, 0x49, 0x46, 0x46]],
			["Ukl GRg==", [0x52, 0x49, 0x46, 0x46]],
		];
		for (const [payload, bytes] of accepted) {
			const stream = mediaProcessor();
			const { parts, progress } = collector();
			stream.processDelta(
				{
					choices: [
						{ delta: { images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${payload}` } }] } },
					],
				},
				progress
			);
			const images = dataPartsOf(parts);
			assert.equal(images.length, 1, `payload ${JSON.stringify(payload)} must decode`);
			assert.deepStrictEqual(expectDefined(images[0]).data, new Uint8Array(bytes));
		}
	});

	test("an empty base64 payload is skipped: no zero-byte DataParts", () => {
		const logs: string[] = [];
		const stream = mediaProcessor((msg) => logs.push(msg));
		const { parts, progress } = collector();

		stream.processDelta(
			{ choices: [{ delta: { images: [{ type: "image_url", image_url: { url: "data:image/png;base64," } }] } }] },
			progress
		);

		assert.equal(dataPartsOf(parts).length, 0);
		assert.ok(logs.some((l) => l.includes("Skipping generated image")));
	});

	test("a model-controlled mime that is not a safe type/subtype is rejected at the source", () => {
		// Each bad mime carries the marker "zq9" so the log assertion cannot
		// trip on innocent substrings of the classification message itself.
		const badMimes = ["not a zq9 mime", "imagezq9", "image/zq9; charset=x", `image/zq9${"y".repeat(120)}`, "a/zq9/c"];
		for (const mime of badMimes) {
			const logs: string[] = [];
			const stream = mediaProcessor((msg, data) => logs.push(`${msg} ${JSON.stringify(data)}`));
			const { parts, progress } = collector();
			stream.processDelta(
				{ choices: [{ delta: { images: [{ type: "image_url", image_url: { url: `data:${mime};base64,AQID` } }] } }] },
				progress
			);
			assert.equal(dataPartsOf(parts).length, 0, `mime ${JSON.stringify(mime)} must be rejected`);
			assert.ok(
				logs.some((l) => l.includes("Skipping generated image")),
				`mime ${JSON.stringify(mime)} must be logged as a skip`
			);
			assert.ok(!logs.some((l) => l.includes("zq9")), "the rejected mime must not reach the logs");
		}
	});

	test("an image entry that is not a base64 data URL is skipped with a classification log", () => {
		const logs: string[] = [];
		const stream = mediaProcessor((msg) => logs.push(msg));
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [{ delta: { images: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }] } }],
			},
			progress
		);

		assert.equal(dataPartsOf(parts).length, 0);
		assert.ok(logs.some((l) => l.includes("Skipping generated image")));
	});

	test("audio data emits one audio/wav DataPart at end of stream; the transcript streams as ordinary text", () => {
		const stream = mediaProcessor();
		const { parts, progress } = collector();

		stream.processDelta(
			{ choices: [{ delta: { audio: { id: "a1", data: "UklGRg==", transcript: "spoken words" } } }] },
			progress
		);
		assert.equal(dataPartsOf(parts).length, 0, "audio accumulates; the clip may not emit before the stream finishes");
		assert.equal(visibleTextOf(parts), "spoken words", "the transcript is the model's text and streams immediately");

		stream.processDelta(finish, progress);

		const audio = dataPartsOf(parts);
		assert.equal(audio.length, 1);
		const part = expectDefined(audio[0]);
		assert.equal(part.mimeType, "audio/wav");
		assert.deepStrictEqual(part.data, new Uint8Array([0x52, 0x49, 0x46, 0x46]));
		assert.equal(visibleTextOf(parts), "spoken words", "finishing must not duplicate the transcript");
	});

	test("fragmented transcripts concatenate like the data field: one text run, one DataPart, no duplication", () => {
		const stream = mediaProcessor();
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { audio: { id: "a1", data: "U", transcript: "Hel" } } }] }, progress);
		stream.processDelta({ choices: [{ delta: { audio: { data: "klGRg==", transcript: "lo" } } }] }, progress);
		stream.processDelta(finish, progress);

		assert.equal(visibleTextOf(parts), "Hello");
		const audio = dataPartsOf(parts);
		assert.equal(audio.length, 1);
		assert.deepStrictEqual(expectDefined(audio[0]).data, new Uint8Array([0x52, 0x49, 0x46, 0x46]));
	});

	test("audio fragments sharing an id concatenate into one part even when no fragment decodes alone", () => {
		const stream = mediaProcessor();
		const { parts, progress } = collector();

		// "U" alone is undecodable base64; only the concatenation is valid.
		stream.processDelta({ choices: [{ delta: { audio: { id: "a1", data: "U" } } }] }, progress);
		stream.processDelta({ choices: [{ delta: { audio: { data: "klGRg==" } } }] }, progress);
		stream.processDelta(finish, progress);

		const audio = dataPartsOf(parts);
		assert.equal(audio.length, 1, "fragments must merge into a single DataPart");
		assert.deepStrictEqual(expectDefined(audio[0]).data, new Uint8Array([0x52, 0x49, 0x46, 0x46]));
	});

	test("a new audio id flushes the previous accumulation as its own part", () => {
		const stream = mediaProcessor();
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { audio: { id: "a1", data: "AQID" } } }] }, progress);
		stream.processDelta({ choices: [{ delta: { audio: { id: "a2", data: "BAUG" } } }] }, progress);
		stream.processDelta(finish, progress);

		const audio = dataPartsOf(parts);
		assert.equal(audio.length, 2);
		assert.deepStrictEqual(expectDefined(audio[0]).data, new Uint8Array([1, 2, 3]));
		assert.deepStrictEqual(expectDefined(audio[1]).data, new Uint8Array([4, 5, 6]));
	});

	test("undecodable accumulated audio is logged as a classification and dropped; the stream still completes", () => {
		const logs: string[] = [];
		const stream = mediaProcessor((msg) => logs.push(msg));
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { audio: { id: "a1", data: "!!!bad!!!" } } }] }, progress);
		stream.processDelta({ choices: [{ delta: { content: "text survives" } }] }, progress);
		stream.processDelta(finish, progress);

		assert.equal(dataPartsOf(parts).length, 0);
		assert.equal(visibleTextOf(parts), "text survives");
		assert.ok(logs.some((l) => l.includes("Skipping generated audio")));
		assert.ok(!logs.some((l) => l.includes("!!!bad!!!")), "logs must never carry response-derived content");
	});

	test("the audio DataPart mime derives from the request's audio.format, falling back to audio/wav", () => {
		const cases: Array<[string | undefined, string]> = [
			["mp3", "audio/mpeg"],
			["wav", "audio/wav"],
			["flac", "audio/flac"],
			["opus", "audio/opus"],
			["aac", "audio/aac"],
			["pcm16", "audio/pcm"],
			["MP3", "audio/mpeg"],
			["something-new", "audio/wav"],
			[undefined, "audio/wav"],
		];
		for (const [format, expectedMime] of cases) {
			const stream = new StreamProcessor(idSource(), () => {}, null, fakeDataCtor, format);
			const { parts, progress } = collector();
			stream.processDelta({ choices: [{ delta: { audio: { id: "a1", data: "AQID" } } }] }, progress);
			stream.processDelta(finish, progress);
			const audio = dataPartsOf(parts);
			assert.equal(audio.length, 1, `format ${JSON.stringify(format)} must still emit`);
			assert.equal(expectDefined(audio[0]).mimeType, expectedMime, `format ${JSON.stringify(format)}`);
		}
	});

	test("whitespace-only audio data is skipped: no zero-byte DataParts", () => {
		const logs: string[] = [];
		const stream = mediaProcessor((msg) => logs.push(msg));
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { audio: { id: "a1", data: "\n" } } }] }, progress);
		stream.processDelta(finish, progress);

		assert.equal(dataPartsOf(parts).length, 0, "whitespace strips to nothing; an empty clip must not emit");
		assert.ok(logs.some((l) => l.includes("Skipping generated audio")));
	});

	test("a well-formed data URL with a non-image mime is rejected: no mislabeled DataParts", () => {
		const logs: string[] = [];
		const stream = mediaProcessor((msg) => logs.push(msg));
		const { parts, progress } = collector();

		// "AQID" under text/html would otherwise round-trip its bytes back
		// into assistant text on the next turn via the history converter.
		stream.processDelta(
			{
				choices: [
					{
						delta: {
							images: [
								{ type: "image_url", image_url: { url: "data:text/html;base64,AQID" } },
								{ type: "image_url", image_url: { url: "data:application/octet-stream;base64,AQID" } },
							],
						},
					},
				],
			},
			progress
		);

		assert.equal(dataPartsOf(parts).length, 0);
		assert.ok(logs.some((l) => l.includes("Skipping generated image")));
	});

	test("repeated end-of-stream runs do not duplicate the audio part", () => {
		const stream = mediaProcessor();
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { audio: { id: "a1", data: "AQID" } } }] }, progress);
		stream.processDelta(finish, progress);
		// The [DONE] line runs the end-of-stream path a second time.
		stream.processDelta(finish, progress);

		assert.equal(dataPartsOf(parts).length, 1);
	});

	test("id-less fragments before the first id'd fragment merge into that id's single part", () => {
		const stream = mediaProcessor();
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { audio: { data: "U" } } }] }, progress);
		stream.processDelta({ choices: [{ delta: { audio: { id: "a1", data: "klGRg==" } } }] }, progress);
		stream.processDelta(finish, progress);

		const audio = dataPartsOf(parts);
		assert.equal(audio.length, 1, "the late id adopts the open accumulation instead of splitting it");
		assert.deepStrictEqual(expectDefined(audio[0]).data, new Uint8Array([0x52, 0x49, 0x46, 0x46]));
	});

	test("cancellation mid-accumulation drops the audio without emitting, and nothing leaks into the next request", async () => {
		const stream = mediaProcessor();
		const { parts, progress } = collector();
		const source = new vscode.CancellationTokenSource();
		const body = sseStream(
			[`data: ${JSON.stringify({ choices: [{ delta: { audio: { id: "a1", data: "UklGRg==" } } }] })}\n\n`],
			() => source.cancel()
		);

		await stream.processStreamingResponse(body, progress, source.token);
		assert.equal(dataPartsOf(parts).length, 0, "a cancelled request must not emit a partial clip");

		// The same processor serving a subsequent stream must start clean.
		stream.processDelta(finish, progress);
		assert.equal(dataPartsOf(parts).length, 0, "the dropped accumulation must not resurface later");
	});

	test("resetState clears an in-flight audio accumulation", () => {
		const stream = mediaProcessor();
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { audio: { id: "a1", data: "AQID" } } }] }, progress);
		stream.resetState();
		stream.processDelta(finish, progress);

		assert.equal(dataPartsOf(parts).length, 0);
	});

	test("the audio part flushes before the citations trailer", () => {
		const stream = mediaProcessor();
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [
					{
						delta: {
							content: "cited",
							annotations: [{ type: "url_citation", url_citation: { url: "https://example.test/a", title: "A" } }],
							audio: { id: "a1", data: "AQID" },
						},
					},
				],
			},
			progress
		);
		stream.processDelta(finish, progress);

		const kinds = parts.map((p) => (p instanceof FakeDataPart ? "data" : "text"));
		assert.deepEqual(kinds, ["text", "data", "text"], "audio flushes between the body text and the sources trailer");
		assert.ok(visibleTextOf(parts).includes("Sources:"), "the trailer still renders");
	});

	test("text, image, thinking, and a tool call in ONE delta emit in the pinned order", () => {
		class FakeThinkingPart {
			constructor(
				public text: string,
				public id?: string,
				public metadata?: unknown
			) {}
		}
		const stream = new StreamProcessor(
			idSource(),
			() => {},
			FakeThinkingPart as unknown as ThinkingPartCtor,
			fakeDataCtor
		);
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [
					{
						delta: {
							reasoning_content: "pondering",
							content: "answer ",
							images: [{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }],
							tool_calls: [{ index: 0, id: "c1", function: { name: "t", arguments: "{}" } }],
						},
					},
				],
			},
			progress
		);

		const kinds = parts.map((p) =>
			p instanceof FakeThinkingPart
				? "thinking"
				: p instanceof FakeDataPart
					? "data"
					: p instanceof vscode.LanguageModelToolCallPart
						? "tool"
						: `text:${(p as vscode.LanguageModelTextPart).value}`
		);
		assert.deepEqual(kinds, ["thinking", "text:answer ", "data", "text: ", "tool"]);
	});

	test("within a single delta, that delta's text precedes its images, and images keep list order", () => {
		const stream = mediaProcessor();
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [
					{
						delta: {
							content: "caption ",
							images: [
								{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
								{ type: "image_url", image_url: { url: "data:image/jpeg;base64,BAUG" } },
							],
						},
					},
				],
			},
			progress
		);

		const kinds = parts.map((p) => (p instanceof FakeDataPart ? `data:${p.mimeType}` : "text"));
		assert.deepEqual(kinds, ["text", "data:image/png", "data:image/jpeg"]);
	});

	test("a throwing DataPart constructor is logged and the stream continues", () => {
		const logs: string[] = [];
		const throwingCtor = class {
			constructor() {
				throw new Error("boom");
			}
		} as unknown as DataPartCtor;
		const stream = new StreamProcessor(idSource(), (msg) => logs.push(msg), null, throwingCtor);
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [
					{
						delta: {
							content: "visible",
							images: [{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }],
						},
					},
				],
			},
			progress
		);

		assert.ok(
			logs.some((l) => l.includes("Failed to construct data part")),
			"Constructor failure must be logged"
		);
		assert.equal(visibleTextOf(parts), "visible");
	});

	test("an SSE stream carrying an audio delta surfaces the host's real LanguageModelDataPart", async () => {
		// Default constructor arguments: the module probe finds the host's
		// stable LanguageModelDataPart class in the extension test host.
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const body = sseStream([
			`data: ${JSON.stringify({
				choices: [{ delta: { role: "assistant", audio: { id: "a1", data: "UklGRg==", transcript: "spoken" } } }],
			})}\n\n`,
			`data: ${JSON.stringify({ choices: [{ delta: { content: "Text alongside audio." } }] })}\n\n`,
			"data: [DONE]\n\n",
		]);

		await stream.processStreamingResponse(body, progress, new vscode.CancellationTokenSource().token);

		assert.equal(visibleTextOf(parts), "spokenText alongside audio.", "transcript streams as text before the content");
		const dataParts = parts.filter((p) => p instanceof vscode.LanguageModelDataPart);
		assert.equal(dataParts.length, 1);
		const part = expectDefined(dataParts[0]) as vscode.LanguageModelDataPart;
		assert.equal(part.mimeType, "audio/wav");
		assert.deepStrictEqual(part.data, new Uint8Array([0x52, 0x49, 0x46, 0x46]));
	});
});

suite("provider/streaming media without DataPart support", () => {
	setup(() => resetDataPartLogOnce());
	teardown(() => resetDataPartLogOnce());

	test("media deltas are skipped without crashing, logged once across processors, and text still flows", async () => {
		const logs: string[] = [];
		const first = new StreamProcessor(idSource(), (msg) => logs.push(msg), null, null);
		const second = new StreamProcessor(idSource(), (msg) => logs.push(msg), null, null);
		const { parts, progress } = collector();

		first.processDelta(
			{
				choices: [{ delta: { images: [{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }] } }],
			},
			progress
		);
		first.processDelta({ choices: [{ delta: { content: "still text" } }] }, progress);
		first.processDelta({ choices: [{ delta: {}, finish_reason: "stop" }] }, progress);
		second.processDelta(
			{ choices: [{ delta: { audio: { id: "a1", data: "UklGRg==", transcript: " and words" } } }] },
			progress
		);
		second.processDelta({ choices: [{ delta: {}, finish_reason: "stop" }] }, progress);

		assert.equal(
			visibleTextOf(parts),
			"still text and words",
			"the transcript is text, so it must flow even without DataPart support"
		);
		assert.equal(
			parts.filter((p) => !(p instanceof vscode.LanguageModelTextPart)).length,
			0,
			"no media part may be constructed when the class is unavailable"
		);
		assert.deepEqual(
			logs.filter((l) => l.includes("data parts")),
			["Host does not support data parts; generated media will not be displayed"]
		);
	});
});

suite("provider/streaming end-of-stream policy", () => {
	function token(): vscode.CancellationToken {
		return new vscode.CancellationTokenSource().token;
	}

	test("trailing text held back by the control-token scanner is emitted at end of stream", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const body = sseStream(['data: {"choices":[{"delta":{"content":"hello <|note"}}]}\n', "data: [DONE]\n"]);

		await stream.processStreamingResponse(body, progress, token());
		assert.strictEqual(visibleTextOf(parts), "hello <|note", "Ordinary text ending in <|identifier must not be lost");
	});

	test("a truncated structural tool-call token at end of stream is still dropped", async () => {
		const logs: Array<{ msg: string; data?: unknown }> = [];
		const stream = new StreamProcessor(idSource(), (msg, data) => logs.push({ msg, data }));
		const { parts, progress } = collector();
		const body = sseStream(['data: {"choices":[{"delta":{"content":"done <|tool_call_beg"}}]}\n', "data: [DONE]\n"]);

		await stream.processStreamingResponse(body, progress, token());
		assert.strictEqual(visibleTextOf(parts), "done ", "The truncated begin token must not leak");
		const drop = logs.find((l) => l.msg.includes("Dropping trailing partial control token text"));
		assert.ok(drop, "The drop must be logged");
		assert.deepStrictEqual(drop.data, { length: "<|tool_call_beg".length }, "classification only, never the text");
		assert.ok(!JSON.stringify(logs).includes("tool_call_beg"), "response content must not reach the logs");
	});

	test("call-internal held text never leaks when the stream truncates after argument-end", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const chunk = 'x <|tool_call_begin|>t<|tool_call_argument_begin|>{"x":1}<|tool_call_argument_end|><|';
		const body = sseStream([`data: {"choices":[{"delta":{"content":${JSON.stringify(chunk)}}}]}\n`, "data: [DONE]\n"]);

		await stream.processStreamingResponse(body, progress, token());
		assert.strictEqual(visibleTextOf(parts), "x ", "The held partial end token is call-internal, not visible text");
		const calls = toolCallsOf(parts);
		assert.strictEqual(calls.length, 1, "The provisional call has complete JSON args and must be recovered");
		assert.deepStrictEqual(calls[0]?.input, { x: 1 });
	});

	test("a truncated section marker at end of stream is dropped as protocol text", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const body = sseStream(['data: {"choices":[{"delta":{"content":"a<|calls_section_begin|"}}]}\n', "data: [DONE]\n"]);

		await stream.processStreamingResponse(body, progress, token());
		assert.strictEqual(visibleTextOf(parts), "a", "A half-received section marker must not leak");
	});

	test("a reply ending in a bare < or <| keeps those characters", async () => {
		for (const tail of ["5 <", "a <|"]) {
			const stream = new StreamProcessor(idSource(), () => {});
			const { parts, progress } = collector();
			const body = sseStream([`data: {"choices":[{"delta":{"content":${JSON.stringify(tail)}}}]}\n`, "data: [DONE]\n"]);
			await stream.processStreamingResponse(body, progress, token());
			assert.strictEqual(visibleTextOf(parts), tail, `Trailing ${JSON.stringify(tail)} must not be dropped`);
		}
	});

	test("a call opened by a complete begin token but never terminated is dropped at end of stream", async () => {
		const logs: string[] = [];
		const stream = new StreamProcessor(idSource(), (msg) => logs.push(msg));
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"content":"ok <|tool_call_begin|>get_weather"}}]}\n',
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, token());
		assert.strictEqual(visibleTextOf(parts), "ok ", "A truncated call must not leak its tokens into visible text");
		assert.ok(
			logs.some((l) => l.includes("Dropping trailing partial control token text")),
			"The drop must be logged"
		);
	});

	test("[DONE] without finish_reason rejects on truncated tool call JSON", async () => {
		const logs: Array<{ msg: string; data?: unknown }> = [];
		const stream = new StreamProcessor(idSource(), (msg, data) => logs.push({ msg, data }));
		const { progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{\\"a\\":"}}]}}]}\n',
			"data: [DONE]\n",
		]);

		await assert.rejects(() => stream.processStreamingResponse(body, progress, token()), /Invalid JSON for tool call/);
		const invalid = logs.find((l) => l.msg.includes("Invalid JSON for tool call"));
		assert.ok(invalid, "The invalid buffer must be logged");
		assert.deepStrictEqual(
			invalid.data,
			{ index: 0, argsLength: '{"a":'.length },
			"classification only, never the buffered arguments"
		);
	});

	test("finish_reason with truncated tool call JSON rejects instead of being swallowed as a malformed line", async () => {
		const logs: string[] = [];
		const stream = new StreamProcessor(idSource(), (msg) => logs.push(msg));
		const { progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{\\"a\\":"}}]}}]}\n',
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
		]);

		await assert.rejects(() => stream.processStreamingResponse(body, progress, token()), /Invalid JSON for tool call/);
		assert.ok(
			!logs.some((l) => l.includes("Skipping malformed SSE line")),
			"The flush error must not be misreported as a malformed SSE line"
		);
	});

	test("unterminated inline tool call with invalid JSON rejects at [DONE]", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"content":"<|tool_call_begin|>t<|tool_call_argument_begin|>{\\"a\\":"}}]}\n',
			"data: [DONE]\n",
		]);

		await assert.rejects(() => stream.processStreamingResponse(body, progress, token()), /Invalid JSON for tool call/);
	});

	test("cancellation downgrades unparseable leftovers to logged drops", async () => {
		const logs: string[] = [];
		const stream = new StreamProcessor(idSource(), (msg) => logs.push(msg));
		const { parts, progress } = collector();
		const source = new vscode.CancellationTokenSource();
		const body = sseStream(
			[
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{\\"a\\":"}}]}}]}\n',
			],
			() => source.cancel()
		);

		await stream.processStreamingResponse(body, progress, source.token);

		assert.equal(toolCallsOf(parts).length, 0);
		assert.ok(
			logs.some((l) => l.includes("Invalid JSON for tool call")),
			"The dropped buffer must be logged"
		);
	});

	test("stream end without [DONE] flushes buffered calls, falling back to unknown_tool", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n',
		]);

		await stream.processStreamingResponse(body, progress, token());

		const toolParts = toolCallsOf(parts);
		assert.equal(toolParts.length, 1);
		const call = expectDefined(toolParts[0]);
		assert.equal(call.name, "unknown_tool");
		assert.equal(call.callId, "call_1");
	});

	test("stream end without [DONE] rejects on truncated tool call JSON", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{\\"a\\":"}}]}}]}\n',
		]);

		await assert.rejects(stream.processStreamingResponse(body, progress, token()), /Invalid JSON for tool call/);
	});

	test("cancellation downgrades an unterminated inline call with invalid JSON to a logged drop", async () => {
		const logs: Array<{ msg: string; data?: unknown }> = [];
		const stream = new StreamProcessor(idSource(), (msg, data) => logs.push({ msg, data }));
		const { parts, progress } = collector();
		const source = new vscode.CancellationTokenSource();
		const body = sseStream(
			['data: {"choices":[{"delta":{"content":"<|tool_call_begin|>t<|tool_call_argument_begin|>{\\"a\\":"}}]}\n'],
			() => source.cancel()
		);

		await stream.processStreamingResponse(body, progress, source.token);

		assert.equal(toolCallsOf(parts).length, 0);
		const drop = logs.find((l) => l.msg.includes("Dropping unterminated inline tool call"));
		assert.ok(drop, "The dropped inline call must be logged");
		assert.deepStrictEqual(drop.data, { argsLength: '{"a":'.length }, "classification only, never name or args");
	});

	test("cancellation arriving with a finish_reason chunk downgrades invalid buffers to logged drops", async () => {
		const logs: string[] = [];
		const stream = new StreamProcessor(idSource(), (msg) => logs.push(msg));
		const { parts, progress } = collector();
		const source = new vscode.CancellationTokenSource();
		const encoder = new TextEncoder();
		let pullCount = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pullCount++;
				if (pullCount === 1) {
					controller.enqueue(
						encoder.encode(
							'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{\\"a\\":"}}]}}]}\n'
						)
					);
				} else if (pullCount === 2) {
					// Cancellation lands while this read is pending, so the finish
					// chunk is still processed but must no longer throw.
					source.cancel();
					controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n'));
				} else {
					controller.close();
				}
			},
		});

		await stream.processStreamingResponse(body, progress, source.token);

		assert.equal(toolCallsOf(parts).length, 0);
		assert.ok(
			logs.some((l) => l.includes("Invalid JSON for tool call")),
			"The dropped buffer must be logged"
		);
	});
});

suite("provider/streaming SSE transport", () => {
	test("mid-line splits reassemble and a malformed line is skipped, logged, and does not stop the stream", async () => {
		const logs: Array<{ msg: string; data?: unknown }> = [];
		const stream = new StreamProcessor(idSource(), (msg, data) => logs.push({ msg, data }));
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"del',
			'ta":{"content":"Hi"}}],"system_fingerprint":"fp","obfuscation":"x"}\n',
			"data: {oops\n",
			'data: {"choices":[{"delta":{"content":" there"}}]}\n',
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, new vscode.CancellationTokenSource().token);

		assert.equal(visibleTextOf(parts), "Hi there");
		const skipped = logs.filter((l) => l.msg === "Skipping malformed SSE line");
		assert.equal(skipped.length, 1, "Exactly the malformed line is skipped");
		// Classifications only: raw line content (and V8's JSON error message,
		// which quotes the input) must never reach the issue-report buffer.
		assert.deepEqual(expectDefined(skipped[0]).data, { length: "{oops".length, errorClass: "SyntaxError" });
	});
});
