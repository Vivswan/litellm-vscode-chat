/**
 * The usage DataPart at the end of a stream and the ChatResponseStream adapter.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import { StreamProcessor } from "../../../provider/transport/streaming";
import { chatResponseStreamSink } from "../../../provider/transport/streaming/processor";
import type { DataPartCtor } from "../../../shared/conversion/dataPart";
import { resetDataPartLogOnce } from "../../../shared/conversion/dataPart";
import { expectDefined } from "../../pureHelpers";
import { collector, idSource, sseStream, visibleTextOf } from "./streamingHelpers";

suite("provider/streaming usage DataPart", () => {
	class FakeDataPart {
		constructor(
			public data: Uint8Array,
			public mimeType: string
		) {}
	}
	const fakeDataCtor = FakeDataPart as unknown as DataPartCtor;

	setup(() => resetDataPartLogOnce());
	teardown(() => resetDataPartLogOnce());

	function token(): vscode.CancellationToken {
		return new vscode.CancellationTokenSource().token;
	}

	function usageProcessor(log: (message: string, data?: unknown) => void = () => {}): StreamProcessor {
		return new StreamProcessor(idSource(), log, null, fakeDataCtor);
	}

	function usagePartsOf(parts: vscode.LanguageModelResponsePart[]): Record<string, unknown>[] {
		return parts
			.filter((p): p is FakeDataPart => p instanceof FakeDataPart && p.mimeType === "usage")
			.map((p) => JSON.parse(new TextDecoder().decode(p.data)) as Record<string, unknown>);
	}

	const TRAILER = 'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":80,"total_tokens":200}}\n';

	test("the empty-choices trailer emits exactly one usage DataPart despite the repeated end-of-stream runs", async () => {
		const stream = usageProcessor();
		const { parts, progress } = collector();
		// finish_reason, [DONE], and EOF each run finishStream; the trailer
		// arrives between the first two, the standard OpenAI stream shape.
		const body = sseStream([
			'data: {"choices":[{"delta":{"content":"answer"}}]}\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
			TRAILER,
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, token());

		assert.strictEqual(visibleTextOf(parts), "answer");
		const usages = usagePartsOf(parts);
		assert.strictEqual(usages.length, 1, "one usage part per stream, however many times finishStream runs");
		assert.deepStrictEqual(usages[0], { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 });
	});

	test("usage riding the finish_reason chunk itself is captured", async () => {
		const stream = usageProcessor();
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n',
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, token());

		const usages = usagePartsOf(parts);
		assert.strictEqual(usages.length, 1);
		assert.deepStrictEqual(usages[0], { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
	});

	test("an interim usage object does not pin stale counts: the final trailer wins", async () => {
		// Some providers stamp running usage onto ordinary chunks. Emission is
		// reserved for the post-loop run, so the interim counts never ship.
		const stream = usageProcessor();
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
			TRAILER,
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, token());

		const usages = usagePartsOf(parts);
		assert.strictEqual(usages.length, 1, "exactly one usage part despite interim usage objects");
		assert.deepStrictEqual(
			usages[0],
			{ prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
			"the final trailer's counts win over the interim ones"
		);
	});

	test("a straggler trailer behind [DONE] still wins: emission happens only at the true end", async () => {
		const stream = usageProcessor();
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
			TRAILER,
			"data: [DONE]\n",
			'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n',
		]);

		await stream.processStreamingResponse(body, progress, token());

		assert.deepStrictEqual(
			usagePartsOf(parts),
			[{ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }],
			"[DONE] continues the loop, so the post-loop run sees the very last trailer"
		);
	});

	test("non-finite counts are rejected: JSON.stringify would null them and the consumer drops the payload", async () => {
		// A wire literal like 1e999 parses to Infinity. As a required count it
		// kills the emission outright; as an optional detail it is omitted
		// while the finite trio still ships.
		const stream = usageProcessor();
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":1e999}}\n',
			'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":1e999}}}\n',
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, token());

		assert.deepStrictEqual(
			usagePartsOf(parts),
			[{ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }],
			"the Infinity detail is omitted; an Infinity required count would have emitted nothing"
		);
	});

	test("NaN counts injected through processDelta neither emit nor reach the usage log", () => {
		const logged: { message: string; data?: unknown }[] = [];
		const stream = new StreamProcessor(
			idSource(),
			(message, data) => logged.push({ message, data }),
			null,
			fakeDataCtor
		);
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [],
				usage: { prompt_tokens: Number.NaN, completion_tokens: 2, total_tokens: Number.POSITIVE_INFINITY },
			},
			progress
		);
		stream.processDelta({ choices: [{ delta: {}, finish_reason: "stop" }] }, progress);

		assert.strictEqual(usagePartsOf(parts).length, 0, "a payload missing finite required counts must not emit");
		const usageLog = logged.find((l) => l.message === "Token usage");
		assert.deepStrictEqual(expectDefined(usageLog?.data), { completion_tokens: 2 }, "only finite counts are logged");
	});

	test("OpenAI-style detail groups round-trip into the payload", async () => {
		const stream = usageProcessor();
		const { parts, progress } = collector();
		const usage = {
			prompt_tokens: 100,
			completion_tokens: 50,
			total_tokens: 150,
			prompt_tokens_details: { cached_tokens: 90, cache_creation_input_tokens: 10 },
			completion_tokens_details: { reasoning_tokens: 40 },
		};
		const body = sseStream([`data: {"choices":[],"usage":${JSON.stringify(usage)}}\n`, "data: [DONE]\n"]);

		await stream.processStreamingResponse(body, progress, token());

		assert.deepStrictEqual(usagePartsOf(parts), [
			{
				prompt_tokens: 100,
				completion_tokens: 50,
				total_tokens: 150,
				prompt_tokens_details: { cached_tokens: 90, cache_creation_input_tokens: 10 },
				completion_tokens_details: { reasoning_tokens: 40 },
			},
		]);
	});

	test("Anthropic-style top-level cache fields map into prompt_tokens_details", async () => {
		const stream = usageProcessor();
		const { parts, progress } = collector();
		const usage = {
			prompt_tokens: 100,
			completion_tokens: 50,
			total_tokens: 150,
			cache_read_input_tokens: 70,
			cache_creation_input_tokens: 30,
		};
		const body = sseStream([`data: {"choices":[],"usage":${JSON.stringify(usage)}}\n`, "data: [DONE]\n"]);

		await stream.processStreamingResponse(body, progress, token());

		assert.deepStrictEqual(usagePartsOf(parts), [
			{
				prompt_tokens: 100,
				completion_tokens: 50,
				total_tokens: 150,
				prompt_tokens_details: { cached_tokens: 70, cache_creation_input_tokens: 30 },
			},
		]);
	});

	test("the OpenAI-style detail keys outrank the top-level cache fields when both are present", async () => {
		const stream = usageProcessor();
		const { parts, progress } = collector();
		const usage = {
			prompt_tokens: 100,
			completion_tokens: 50,
			total_tokens: 150,
			cache_read_input_tokens: 1,
			prompt_tokens_details: { cached_tokens: 90 },
		};
		const body = sseStream([`data: {"choices":[],"usage":${JSON.stringify(usage)}}\n`, "data: [DONE]\n"]);

		await stream.processStreamingResponse(body, progress, token());

		const usages = usagePartsOf(parts);
		assert.deepStrictEqual(expectDefined(usages[0]).prompt_tokens_details, { cached_tokens: 90 });
	});

	test("arbitrary server keys never reach the emitted payload", async () => {
		const stream = usageProcessor();
		const { parts, progress } = collector();
		const usage = {
			prompt_tokens: 1,
			completion_tokens: 2,
			total_tokens: 3,
			gateway_debug: "internal-usage-MARKER",
			prompt_tokens_details: { cached_tokens: 0, gateway_note: "internal-usage-MARKER" },
		};
		const body = sseStream([`data: {"choices":[],"usage":${JSON.stringify(usage)}}\n`, "data: [DONE]\n"]);

		await stream.processStreamingResponse(body, progress, token());

		const usages = usagePartsOf(parts);
		assert.strictEqual(usages.length, 1);
		assert.ok(
			!JSON.stringify(usages[0]).includes("internal-usage-MARKER"),
			"the trailer is response-owned; only the sanitized numeric counts pass"
		);
		assert.deepStrictEqual(expectDefined(usages[0]).prompt_tokens_details, { cached_tokens: 0 });
	});

	test("a trailer missing a required count emits nothing", async () => {
		for (const usage of [
			{ prompt_tokens: 1, completion_tokens: 2 },
			{ prompt_tokens: 1, completion_tokens: 2, total_tokens: "3" },
			{ total_tokens: 3 },
		]) {
			const stream = usageProcessor();
			const { parts, progress } = collector();
			const body = sseStream([`data: {"choices":[],"usage":${JSON.stringify(usage)}}\n`, "data: [DONE]\n"]);

			await stream.processStreamingResponse(body, progress, token());

			assert.strictEqual(
				usagePartsOf(parts).length,
				0,
				`usage ${JSON.stringify(usage)} fails the consumer's shape check and must not emit`
			);
		}
	});

	test("a cancelled stream emits no usage part", async () => {
		const stream = usageProcessor();
		const { parts, progress } = collector();
		const source = new vscode.CancellationTokenSource();
		const body = sseStream([TRAILER], () => source.cancel());

		await stream.processStreamingResponse(body, progress, source.token);

		assert.strictEqual(usagePartsOf(parts).length, 0);
	});

	test("a host without the DataPart class drops the usage silently, without the generated-media notice", async () => {
		const logs: string[] = [];
		const stream = new StreamProcessor(idSource(), (msg) => logs.push(msg), null, null);
		const { parts, progress } = collector();
		const body = sseStream(['data: {"choices":[{"delta":{"content":"text"}}]}\n', TRAILER, "data: [DONE]\n"]);

		await stream.processStreamingResponse(body, progress, token());

		assert.strictEqual(visibleTextOf(parts), "text");
		assert.strictEqual(parts.length, 1, "no usage part without the class");
		assert.ok(!logs.some((l) => l.includes("generated media")), "the missing-support notice is about media, not usage");
	});

	test("the usage part is bookkeeping: a reasoning-only stream fails loudly and forfeits its usage", async () => {
		// The reasoning-only error fires at the [DONE] run; usage emission is
		// reserved for the final post-loop run, which the throw never reaches.
		const stream = new StreamProcessor(idSource(), () => {}, null, fakeDataCtor);
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n',
			TRAILER,
			"data: [DONE]\n",
		]);

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			(e: unknown) => e instanceof Error && e.message.startsWith("The model produced only reasoning output"),
			"the retained usage must not suppress the reasoning-only error"
		);
		assert.strictEqual(parts.length, 0, "the failed request emits nothing, usage included");
	});

	test("a reasoning-only stream that fails at its finish_reason chunk forfeits the later trailer too", async () => {
		// Same forfeit through the other route: the throw at finish_reason
		// aborts the request before the trailer is even parsed.
		const stream = new StreamProcessor(idSource(), () => {}, null, fakeDataCtor);
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
			TRAILER,
			"data: [DONE]\n",
		]);

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			(e: unknown) => e instanceof Error && e.message.startsWith("The model produced only reasoning output")
		);
		assert.strictEqual(parts.length, 0, "the failed request emits nothing, usage included");
	});

	test("reasoning-only plus citations plus a usage trailer: the throw wins and nothing emits", async () => {
		// The three-way collision: terminal checks run before either trailer,
		// so the failed request ships neither the Sources list nor the
		// accounting part.
		const stream = new StreamProcessor(idSource(), () => {}, null, fakeDataCtor);
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}],"citations":["https://example.test/cited"]}\n',
			TRAILER,
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		]);

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			(e: unknown) => e instanceof Error && e.message.startsWith("The model produced only reasoning output")
		);
		assert.strictEqual(parts.length, 0, "no parts at all: no sources trailer, no usage part");
	});

	test("a failure surfacing only at EOF still forfeits the usage part", async () => {
		// No finish_reason and no [DONE]: the post-loop EOF run is the first
		// end-of-stream run, and its invalid buffered tool call must throw
		// before the trailers emit.
		const stream = new StreamProcessor(idSource(), () => {}, null, fakeDataCtor);
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{\\"a\\":"}}]}}]}\n',
			TRAILER,
		]);

		await assert.rejects(
			() => stream.processStreamingResponse(body, progress, token()),
			(e: unknown) => e instanceof Error && e.message.startsWith("The model sent a broken tool call")
		);
		assert.strictEqual(usagePartsOf(parts).length, 0, "an EOF-only failure ships no usage");
		assert.strictEqual(parts.length, 0, "nor any other part");
	});

	test("the sources trailer precedes the usage DataPart at end of stream", async () => {
		// Citations are chat content, usage is metadata: the visible trailer
		// renders before the accounting part.
		const stream = usageProcessor();
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"content":"hi"}}],"citations":["https://example.test/o"]}\n',
			TRAILER,
			"data: [DONE]\n",
		]);

		await stream.processStreamingResponse(body, progress, token());

		assert.strictEqual(usagePartsOf(parts).length, 1);
		const last = parts[parts.length - 1];
		assert.ok(last instanceof FakeDataPart && last.mimeType === "usage", "the usage part is the final part");
		const secondToLast = parts[parts.length - 2];
		assert.ok(
			secondToLast instanceof vscode.LanguageModelTextPart && secondToLast.value.includes("Sources:"),
			"the sources trailer immediately precedes it"
		);
	});

	test("the usage log line carries the top-level cache fields as numbers only", () => {
		const logged: { message: string; data?: unknown }[] = [];
		const stream = new StreamProcessor(idSource(), (message, data) => logged.push({ message, data }));
		const { progress } = collector();

		stream.processDelta(
			{
				choices: [],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
					cache_read_input_tokens: 7,
					cache_creation_input_tokens: 3,
					prompt_tokens_details: { cache_creation_input_tokens: "not-a-number" },
				},
			},
			progress
		);

		const usageLog = logged.find((l) => l.message === "Token usage");
		assert.deepStrictEqual(expectDefined(usageLog?.data), {
			prompt_tokens: 10,
			completion_tokens: 5,
			total_tokens: 15,
			cache_read_input_tokens: 7,
			cache_creation_input_tokens: 3,
		});
	});
});

suite("provider/streaming ChatResponseStream adapter", () => {
	/** A recording stand-in for the participant API's stream; only markdown is consulted by the adapter. */
	function recordingStream(rendered: string[]): vscode.ChatResponseStream {
		return {
			markdown: (value: string | vscode.MarkdownString) => {
				rendered.push(typeof value === "string" ? value : value.value);
			},
		} as vscode.ChatResponseStream;
	}

	test("text parts render as markdown; tool-call parts are dropped by design", () => {
		const rendered: string[] = [];
		const sink = chatResponseStreamSink(recordingStream(rendered));
		sink.report(new vscode.LanguageModelTextPart("hello "));
		sink.report(new vscode.LanguageModelToolCallPart("id-1", "some_tool", { a: 1 }));
		sink.report(new vscode.LanguageModelTextPart("world"));
		assert.deepStrictEqual(rendered, ["hello ", "world"]);
	});

	test("the adapter satisfies the processor's structural sink: a delta streams straight into markdown", () => {
		const rendered: string[] = [];
		const sink = chatResponseStreamSink(recordingStream(rendered));
		const stream = new StreamProcessor(idSource(), () => {});
		stream.processDelta({ choices: [{ delta: { content: "chunk" } }] }, sink);
		assert.deepStrictEqual(rendered, ["chunk"]);
	});
});
