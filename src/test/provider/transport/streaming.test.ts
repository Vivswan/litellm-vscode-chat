/**
 * StreamProcessor's core: text and tool-call assembly, tool-call index normalization,
 * dedup across channels, and inline tokens split at byte boundaries.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import { StreamProcessor } from "../../../provider/transport/streaming";
import { expectDefined } from "../../pureHelpers";
import { collector, eventSequenceOf, idSource, toolCallsOf, visibleTextOf } from "./streamingHelpers";

suite("provider/transport/streaming", () => {
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
		assert.equal(toolPart.callId, "call_123", "the server's id passes through; nothing re-mints it");
		assert.deepEqual(toolPart.input, { key: "value" }, "the arguments string parses into the call's input");
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

		// A nameless buffered call cannot emit early (only the end-of-stream flush
		// names it unknown_tool), and no [DONE] or EOF follows here.
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
