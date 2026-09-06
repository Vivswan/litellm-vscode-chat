/**
 * How a stream ends: the end-of-stream policy, reasoning-only empty responses, the
 * progress funnel, and the SSE transport itself.
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { RequestError } from "../../../provider/transport/errorMapping";
import { StreamProcessor } from "../../../provider/transport/streaming";
import type { ThinkingPartCtor } from "../../../shared/conversion/thinkingPart";
import { resetThinkingPartLogOnce } from "../../../shared/conversion/thinkingPart";
import { expectDefined } from "../../pureHelpers";
import { collector, idSource, sseStream, toolCallsOf, visibleTextOf } from "./streamingHelpers";

suite("provider/streaming end-of-stream policy", () => {
	function token(): vscode.CancellationToken {
		return new vscode.CancellationTokenSource().token;
	}

	test("an in-band error frame terminates the stream with a classified error, prior text intact", async () => {
		// The shape LiteLLM streams when an upstream dies after the 200: valid
		// chunks, then data: {"error": {...}}, then a clean end. Swallowing it
		// would deliver a silent truncation; aborts must be observable.
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"content":"before "}}]}\n',
			'data: {"error":{"message":"upstream exploded","code":"500"}}\n',
		]);

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			(e: unknown) => {
				assert.ok(e instanceof RequestError, `expected a RequestError, got ${String(e)}`);
				assert.strictEqual(e.kind, "http");
				assert.ok(e.message.startsWith("The server reported an error while it was streaming this reply"), e.message);
				assert.ok(
					e.message.endsWith("\n\nDetails: LiteLLM stream error (500): upstream exploded"),
					`the envelope fields ride the compact detail line: ${e.message}`
				);
				return true;
			}
		);
		assert.strictEqual(visibleTextOf(parts), "before ", "text emitted before the error frame stands");
	});

	test("an error frame alongside usable choices does not terminate the stream", async () => {
		// The termination rule is scoped to frames with NO usable choices; a chunk
		// still carrying deltas keeps the log-and-skip spirit.
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"error":{"message":"noise"},"choices":[{"delta":{"content":"kept"}}]}\n',
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, token());
		assert.strictEqual(visibleTextOf(parts), "kept");
	});

	test("an error frame after [DONE] does not turn a completed response into a failure", async () => {
		// [DONE] already finished the stream; a straggling error frame behind it
		// must not retroactively fail the request the user just watched succeed.
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"content":"done "}}]}\n',
			"data: [DONE]\n",
			'data: {"error":{"message":"late straggler"}}\n',
		]);

		await stream.processStreamingResponse(body, progress, token());
		assert.strictEqual(visibleTextOf(parts), "done ");
	});

	test("a non-record error value stays junk under the leniency rules", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"error":"not an envelope"}\n',
			'data: {"choices":[{"delta":{"content":"still fine"}}]}\n',
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, token());
		assert.strictEqual(visibleTextOf(parts), "still fine");
	});

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

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			/The model sent a broken tool call/
		);
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

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			/The model sent a broken tool call/
		);
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

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			/The model sent a broken tool call/
		);
	});

	test("a no-argument tool call (arguments empty throughout) emits with empty input instead of failing (#281)", async () => {
		// The OpenAI-style shape for a no-parameter tool: `arguments: ""` in
		// every frame. At end of stream no more deltas can arrive, so the empty
		// accumulation reads as the empty object - the same rule the inline
		// parser and outbound history conversion already apply.
		for (const frames of [
			// [DONE] route, empty string args.
			[
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":""}}]}}]}\n',
				"data: [DONE]\n",
			],
			// finish_reason route, arguments field never sent at all.
			[
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t"}}]}}]}\n',
				'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
			],
			// EOF route (no [DONE]), whitespace-only args.
			[
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"  "}}]}}]}\n',
			],
		]) {
			const stream = new StreamProcessor(idSource(), () => {});
			const { parts, progress } = collector();
			await stream.processStreamingResponse(sseStream(frames), progress, token());
			const calls = toolCallsOf(parts);
			assert.strictEqual(calls.length, 1, `the call must emit for frames: ${frames[0]}`);
			assert.strictEqual(calls[0]?.name, "t");
			assert.deepStrictEqual(calls[0]?.input, {}, "a no-argument call carries the empty object");
		}
	});

	test("an argument-less inline tool call left unterminated emits with empty input at [DONE]", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"content":"<|tool_call_begin|>t<|tool_call_argument_begin|>"}}]}\n',
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, token());
		const calls = toolCallsOf(parts);
		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0]?.input, {});
	});

	test("a COMPLETE inline call with an explicit empty argument section emits with empty input", async () => {
		// The end token proves the argument section is final; only a call with
		// no argument-begin token gets the parser's own synthesized "{}".
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"content":"<|tool_call_begin|>t<|tool_call_argument_begin|><|tool_call_end|>"}}]}\n',
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, token());
		const calls = toolCallsOf(parts);
		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0]?.input, {});
	});

	test("a non-final flush HOLDS an empty buffer: arguments arriving after finish_reason still land", async () => {
		// finish_reason and [DONE] can be followed by more chunks; finalizing an
		// empty buffer there would retire the index and drop the late arguments.
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":""}}]}}]}\n',
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]}}]}\n',
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, token());
		const calls = toolCallsOf(parts);
		assert.strictEqual(calls.length, 1, "one call, not an empty twin plus the real one");
		assert.deepStrictEqual(calls[0]?.input, { a: 1 }, "the late arguments win over the empty reading");
	});

	test("a name-only call cut by the output limit classifies instead of emitting an empty call", async () => {
		// The limit arrived before ANY argument bytes: emitting {} would run a
		// tool the model never finished parameterizing.
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":""}}]}}]}\n',
			'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n',
			"data: [DONE]\n",
		]);

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			/output limit in the middle of a tool call/
		);
		assert.strictEqual(toolCallsOf(parts).length, 0, "nothing may emit for the cut-off call");
	});

	test("an inline call cut by the output limit classifies instead of emitting", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"content":"<|tool_call_begin|>t<|tool_call_argument_begin|>"}}]}\n',
			'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n',
			"data: [DONE]\n",
		]);

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			/output limit in the middle of a tool call/
		);
	});

	test("the empty-args rule stays at end of stream: null-literal arguments still reject", async () => {
		// "null" is a modeled decision, not absent text; dispatching it as {}
		// would invent arguments the model did not send.
		const stream = new StreamProcessor(idSource(), () => {});
		const { progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"null"}}]}}]}\n',
			"data: [DONE]\n",
		]);

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			/The model sent a broken tool call/
		);
	});

	test("an output limit that cuts a tool call mid-arguments names the limit, not a retry (#281)", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{\\"a\\":"}}]}}]}\n',
			'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n',
			"data: [DONE]\n",
		]);

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			(error: unknown) => {
				assert.match(String(error), /output limit in the middle of a tool call/);
				assert.strictEqual(
					(error as { englishMessage?: string }).englishMessage,
					"Tool call flush failed at end of stream: output limit cut 1 tool call(s) mid-arguments"
				);
				return true;
			}
		);
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

	test("cancellation drops an empty-args call instead of emitting it (#281)", async () => {
		// A name-only call at cancellation is an unfinished call, not a
		// no-argument one: emitting {} could run a tool the user just cancelled.
		for (const frames of [
			// Delta channel, name arrived, arguments never did.
			['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":""}}]}}]}\n'],
			// Inline channel, argument section opened and empty.
			['data: {"choices":[{"delta":{"content":"<|tool_call_begin|>t<|tool_call_argument_begin|>"}}]}\n'],
		]) {
			const stream = new StreamProcessor(idSource(), () => {});
			const { parts, progress } = collector();
			const source = new vscode.CancellationTokenSource();
			const body = sseStream(frames, () => source.cancel());

			await stream.processStreamingResponse(body, progress, source.token);
			assert.strictEqual(toolCallsOf(parts).length, 0, `nothing may emit for frames: ${frames[0]}`);
		}
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

		await assert.rejects(stream.processStreamingResponse(body, progress, token()), /The model sent a broken tool call/);
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

suite("provider/streaming reasoning-only empty responses", () => {
	class FakeThinkingPart {
		constructor(
			public text: string,
			public id?: string,
			public metadata?: unknown
		) {}
	}
	const fakeCtor = FakeThinkingPart as unknown as ThinkingPartCtor;

	const REASONING_ONLY_MESSAGE =
		"The model produced only reasoning output, which this version of VS Code could not display: the LanguageModelThinkingPart API is missing or failed. Update VS Code to a version that supports thinking parts, or use a model that returns final text.";
	const DROP_LOG = "Dropped reasoning output; LanguageModelThinkingPart missing or failed";

	setup(() => resetThinkingPartLogOnce());
	teardown(() => resetThinkingPartLogOnce());

	function token(): vscode.CancellationToken {
		return new vscode.CancellationTokenSource().token;
	}

	test("a reasoning-only stream without the thinking class rejects with the fixed message instead of resolving empty", async () => {
		const logs: Array<{ msg: string; data?: unknown }> = [];
		const stream = new StreamProcessor(idSource(), (msg, data) => logs.push({ msg, data }), null);
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"reasoning_content":"step one "}}]}\n',
			'data: {"choices":[{"delta":{"reasoning_content":"step two"}}]}\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		]);

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			(e: unknown) => {
				assert.ok(e instanceof Error, `expected an Error, got ${String(e)}`);
				assert.strictEqual(e.message, REASONING_ONLY_MESSAGE, "the message is a fixed string, never response-derived");
				// The display message localizes; under the English fallback its mirror
				// must be the identical string, so English-by-policy log surfaces
				// stay English in every locale.
				assert.strictEqual(
					(e as Error & { englishMessage?: string }).englishMessage,
					e.message,
					"the English mirror must match the English display"
				);
				return true;
			}
		);
		assert.strictEqual(parts.length, 0, "nothing may be emitted for a reasoning-only stream without the class");
		const drops = logs.filter((l) => l.msg === DROP_LOG);
		assert.strictEqual(drops.length, 1, "exactly one per-request drop classification");
		assert.deepStrictEqual(
			expectDefined(drops[0]).data,
			{ parts: 2, totalLength: "step one ".length + "step two".length },
			"the aggregate carries counts and lengths only"
		);
		assert.ok(!JSON.stringify(logs).includes("step one"), "reasoning text must never reach the logs");
		assert.ok(!JSON.stringify(logs).includes("step two"), "reasoning text must never reach the logs");
	});

	test("the same stream with the thinking class emits thinking parts, resolves, and logs no drop", async () => {
		const logs: Array<{ msg: string; data?: unknown }> = [];
		const stream = new StreamProcessor(idSource(), (msg, data) => logs.push({ msg, data }), fakeCtor);
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"reasoning_content":"step one "}}]}\n',
			'data: {"choices":[{"delta":{"reasoning_content":"step two"}}]}\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, token());

		assert.strictEqual(parts.filter((p) => p instanceof FakeThinkingPart).length, 2);
		assert.ok(!logs.some((l) => l.msg === DROP_LOG), "a host with the class drops nothing and must not log a drop");
	});

	test("a reasoning-plus-text stream without the class emits the text, resolves, and logs the drop aggregate once", async () => {
		const logs: Array<{ msg: string; data?: unknown }> = [];
		const stream = new StreamProcessor(idSource(), (msg, data) => logs.push({ msg, data }), null);
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"reasoning_content":"quietly reasoning"}}]}\n',
			'data: {"choices":[{"delta":{"content":"final answer"}}]}\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, token());

		assert.strictEqual(visibleTextOf(parts), "final answer");
		// finishStream runs three times here (finish_reason, [DONE], EOF); the
		// drop classification must still appear exactly once.
		const drops = logs.filter((l) => l.msg === DROP_LOG);
		assert.strictEqual(drops.length, 1);
		assert.deepStrictEqual(expectDefined(drops[0]).data, { parts: 1, totalLength: "quietly reasoning".length });
	});

	test("a cancelled reasoning-only stream does not gain a new failure", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, null);
		const { parts, progress } = collector();
		const source = new vscode.CancellationTokenSource();
		const body = sseStream(['data: {"choices":[{"delta":{"reasoning_content":"partial thoughts"}}]}\n'], () =>
			source.cancel()
		);

		// finishedNormally is false, so the empty-response error must not fire.
		await stream.processStreamingResponse(body, progress, source.token);

		assert.strictEqual(parts.length, 0);
	});

	test("an empty stream with no reasoning keeps today's silent empty resolution", async () => {
		// A model that genuinely returned nothing dropped nothing, so the request
		// resolves empty. Only the reasoning-drop case errors, because there the
		// extension itself discarded the output.
		const logs: Array<{ msg: string; data?: unknown }> = [];
		const stream = new StreamProcessor(idSource(), (msg, data) => logs.push({ msg, data }), null);
		const { parts, progress } = collector();
		const body = sseStream(["data: [DONE]\n"]);

		await stream.processStreamingResponse(body, progress, token());

		assert.strictEqual(parts.length, 0);
		assert.ok(!logs.some((l) => l.msg === DROP_LOG));
	});

	test("repeated end-of-stream runs after the throw cannot double-throw", async () => {
		// processStreamingResponse stops at the first rejection, but processDelta
		// is a public entry point: a finish_reason replay after the error must
		// not throw a second time.
		const stream = new StreamProcessor(idSource(), () => {}, null);
		const { progress } = collector();

		stream.processDelta({ choices: [{ delta: { reasoning_content: "hidden" } }] }, progress);
		assert.throws(
			() => stream.processDelta({ choices: [{ delta: {}, finish_reason: "stop" }] }, progress),
			(e: unknown) => e instanceof Error && e.message === REASONING_ONLY_MESSAGE
		);
		stream.processDelta({ choices: [{ delta: {}, finish_reason: "stop" }] }, progress);
	});

	test("a host class whose constructor always throws is the same empty response and rejects identically", async () => {
		// Issue #215's symptom via the other route: the class exists but every
		// construction fails, so the request would still resolve with zero parts.
		const logs: Array<{ msg: string; data?: unknown }> = [];
		const throwingCtor = class {
			constructor() {
				throw new Error("boom");
			}
		} as unknown as ThinkingPartCtor;
		const stream = new StreamProcessor(idSource(), (msg, data) => logs.push({ msg, data }), throwingCtor);
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"reasoning_content":"lost thoughts"}}]}\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		]);

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			(e: unknown) => e instanceof Error && e.message === REASONING_ONLY_MESSAGE
		);
		assert.strictEqual(parts.length, 0);
		assert.ok(
			logs.some((l) => l.msg === "Failed to construct thinking part"),
			"each failed construction stays individually logged"
		);
		const drops = logs.filter((l) => l.msg === DROP_LOG);
		assert.strictEqual(drops.length, 1);
		assert.deepStrictEqual(expectDefined(drops[0]).data, { parts: 1, totalLength: "lost thoughts".length });
	});

	test("an invalid buffered tool call outranks the reasoning-only error at end of stream", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, null);
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{\\"a\\":"}}]}}]}\n',
			"data: [DONE]\n",
		]);

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			(e: unknown) =>
				e instanceof Error &&
				e.message.startsWith("The model sent a broken tool call") &&
				e.message.endsWith("\n\nDetails: 1 tool call arrived with arguments that were not valid JSON") &&
				// The English mirror deliberately diverges from the localized
				// display: it is the distinctive count-only line the output channel
				// and issue-report buffer record.
				(e as Error & { englishMessage?: string }).englishMessage ===
					"Tool call flush failed at end of stream: 1 tool call(s) with invalid JSON arguments"
		);
		assert.strictEqual(parts.length, 0);
	});

	test("a reasoning-dropping stream whose only emission is a tool call resolves, with the drop logged", async () => {
		const logs: Array<{ msg: string; data?: unknown }> = [];
		const stream = new StreamProcessor(idSource(), (msg, data) => logs.push({ msg, data }), null);
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{}"}}]}}]}\n',
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, token());

		assert.strictEqual(toolCallsOf(parts).length, 1, "the tool call is the response; no error may replace it");
		assert.strictEqual(logs.filter((l) => l.msg === DROP_LOG).length, 1);
	});

	test("a reasoning-dropping stream whose only other output is citations throws instead of resolving as sources", async () => {
		// The Sources trailer is not the response: it must not satisfy the
		// empty-response check, and the terminal checks run before it would emit.
		const stream = new StreamProcessor(idSource(), () => {}, null);
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}],"citations":["https://example.test/cited"]}\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		]);

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			(e: unknown) => e instanceof Error && e.message === REASONING_ONLY_MESSAGE
		);
		assert.strictEqual(parts.length, 0, "no sources trailer may soften the failure into visible output");
	});

	test("a request failing on an in-band error frame still logs the drop aggregate", async () => {
		// The error frame throws out of the transport loop before any finishStream
		// runs; the cleanup path must still tie the lost reasoning to this turn.
		const logs: Array<{ msg: string; data?: unknown }> = [];
		const stream = new StreamProcessor(idSource(), (msg, data) => logs.push({ msg, data }), null);
		const { progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"reasoning_content":"lost thoughts"}}]}\n',
			'data: {"error":{"message":"upstream exploded"}}\n',
		]);

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			(e: unknown) => e instanceof RequestError && e.kind === "http"
		);
		const drops = logs.filter((l) => l.msg === DROP_LOG);
		assert.strictEqual(drops.length, 1);
		assert.deepStrictEqual(expectDefined(drops[0]).data, { parts: 1, totalLength: "lost thoughts".length });
	});
});

suite("provider/streaming progress funnel", () => {
	test("every emission goes through reportPart: progress.report appears exactly three times in the source", () => {
		// The empty-response check counts emissions via reportPart, so a direct
		// progress.report elsewhere would bypass it silently. Exactly three sites
		// are sanctioned: reportPart itself and the two end-of-stream trailers
		// (Sources, usage DataPart), which decorate an already-validated response
		// and must NOT count as substantive output for the reasoning-only check.
		const dir = path.resolve(__dirname, "..", "..", "..", "..", "src", "provider", "transport", "streaming");
		const source = fs
			.readdirSync(dir)
			.filter((name) => name.endsWith(".ts"))
			.sort()
			.map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
			.join("\n");
		const calls = source.match(/progress\.report\(/g) ?? [];
		assert.strictEqual(calls.length, 3, "part emission goes through reportPart, plus the two trailer sites");
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
