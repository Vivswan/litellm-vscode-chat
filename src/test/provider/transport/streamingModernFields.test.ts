/**
 * StreamProcessor and the modern chunk fields: refusals and annotations, unhandled
 * fields passing through, and generated media with and without DataPart support.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import { StreamProcessor } from "../../../provider/transport/streaming";
import type { DataPartCtor } from "../../../shared/conversion/dataPart";
import { resetDataPartLogOnce } from "../../../shared/conversion/dataPart";
import type { ThinkingPartCtor } from "../../../shared/conversion/thinkingPart";
import { assertContains, assertEndsWith, assertShows, expectDefined } from "../../pureHelpers";
import { BUILTIN_SCENARIOS } from "../../scenarios";
import { collector, idSource, playChunks, sseStream, visibleTextOf } from "./streamingHelpers";

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

		await playChunks(
			stream,
			[
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
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
				// A replayed finish_reason runs the end-of-stream path again; the trailer must not repeat.
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
			],
			progress
		);

		const text = visibleTextOf(parts);
		assert.ok(text.includes("The sky is blue."), "Content must still render");
		assert.equal(text.match(/Sources:/g)?.length, 1, "Exactly one sources trailer");
		assertContains(text, "[Sky](https://example.test/sky)", "Citation renders as a markdown link");
		assert.equal(text.match(/example\.test\/sky/g)?.length, 1, "Duplicate URLs collapse to one entry");
	});

	test("annotations without a url are ignored", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		await playChunks(
			stream,
			[
				{ choices: [{ delta: { content: "text", annotations: [{ type: "url_citation" }] } }] },
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
			],
			progress
		);

		assert.equal(visibleTextOf(parts), "text");
	});

	test("citation titles and urls are escaped in the sources trailer", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		await playChunks(
			stream,
			[
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
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
			],
			progress
		);

		const text = visibleTextOf(parts);
		assert.ok(text.includes("[Line\\] break \\[x\\]]"), `title must be escaped and newline-flattened, got ${text}`);
		assertContains(text, "(https://example.test/a%20%28b%29)", `url must be percent-encoded, got ${text}`);
	});

	test("chunk-root citations and search_results repeated per chunk dedupe into one titled sources trailer", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		const scenario = expectDefined(BUILTIN_SCENARIOS["citations-chunk-level"]);
		assert.ok(scenario.type === "sse");
		await playChunks(stream, [...scenario.chunks], progress);

		const text = visibleTextOf(parts);
		assert.equal(text.match(/Sources:/g)?.length, 1, "Exactly one sources trailer");
		assert.equal(
			text.match(/example\.test\/grass/g)?.length,
			1,
			`each unique URL must be listed once despite per-chunk repetition, got ${text}`
		);
		assert.equal(text.match(/example\.test\/sky/g)?.length, 1, `got ${text}`);
		assert.ok(text.includes("[Grass color]"), `search_results titles must label bare citation URLs, got ${text}`);
		assert.ok(text.includes("[Sky color]"), `got ${text}`);
	});

	test("delta-level provider_specific_fields.search_results feed the sources trailer", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		await playChunks(
			stream,
			[
				{
					choices: [
						{
							index: 0,
							delta: {
								content: "searched",
								provider_specific_fields: {
									search_results: [{ url: "https://example.test/psf", title: "PSF result" }],
								},
							},
						},
					],
				},
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
			],
			progress
		);

		const text = visibleTextOf(parts);
		assertContains(text, "[PSF result](https://example.test/psf)", `got ${text}`);
	});

	test("malformed chunk-root source shapes are skipped without aborting the stream", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		await playChunks(
			stream,
			[
				{
					choices: [{ index: 0, delta: { content: "resilient" } }],
					citations: [42, null, { url: "https://example.test/object" }, "https://example.test/ok"],
					search_results: "not-an-array",
				},
				{
					choices: [],
					citations: { not: "an array" },
					search_results: [17, { title: "no url" }, { url: "https://example.test/valid", title: "Valid" }],
				},
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
			],
			progress
		);

		const text = visibleTextOf(parts);
		assert.ok(text.startsWith("resilient"), `the content must survive malformed sources, got ${text}`);
		assert.equal(text.match(/Sources:/g)?.length, 1);
		assertContains(text, "(https://example.test/ok)", `the valid string citation collects, got ${text}`);
		assertContains(text, "[Valid](https://example.test/valid)", `the valid search result collects, got ${text}`);
		assert.ok(!text.includes("object"), "a record inside citations is not a URL and must not surface");
		assert.ok(!text.includes("no url"), "a URL-less search result has nothing to cite");
	});

	test("a titled search result upgrades a self-titled citation URL but never overwrites a real title", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		await playChunks(
			stream,
			[
				{
					choices: [{ index: 0, delta: { content: "x" } }],
					citations: ["https://example.test/a", "https://example.test/b"],
				},
				{
					choices: [],
					search_results: [{ url: "https://example.test/a", title: "Title A" }, { url: "https://example.test/b" }],
				},
				{
					choices: [],
					search_results: [{ url: "https://example.test/a", title: "Title A later" }],
				},
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
			],
			progress
		);

		const text = visibleTextOf(parts);
		assertContains(text, "[Title A](https://example.test/a)", `the titled result labels the bare URL, got ${text}`);
		assert.ok(!text.includes("Title A later"), "an established title is first-seen-wins");
		assertContains(
			text,
			"[https://example.test/b](https://example.test/b)",
			`an untitled result leaves the URL self-titled, got ${text}`
		);
	});

	test("an empty-string title is no title: it never labels a source and never blocks an upgrade", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		await playChunks(
			stream,
			[
				{
					choices: [{ index: 0, delta: { content: "x" } }],
					search_results: [{ url: "https://example.test/e", title: "" }],
				},
				{
					choices: [],
					search_results: [{ url: "https://example.test/e", title: "Real title" }],
				},
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
			],
			progress
		);

		const text = visibleTextOf(parts);
		assert.ok(!text.includes("[]("), `an empty markdown label must never render, got ${text}`);
		assertContains(text, "[Real title](https://example.test/e)", `the real title wins the placeholder, got ${text}`);
	});

	test("a titled annotation upgrades a bare root citation under the same rule", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		await playChunks(
			stream,
			[
				{
					choices: [{ index: 0, delta: { content: "x" } }],
					citations: ["https://example.test/p"],
				},
				{
					choices: [
						{
							delta: {
								content: "y",
								annotations: [
									{ type: "url_citation", url_citation: { url: "https://example.test/p", title: "Proper title" } },
									{ type: "url_citation", url_citation: { url: "https://example.test/q", title: "" } },
								],
							},
						},
					],
				},
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
			],
			progress
		);

		const text = visibleTextOf(parts);
		assertContains(
			text,
			"[Proper title](https://example.test/p)",
			`the annotation title labels the bare citation, got ${text}`
		);
		assertContains(
			text,
			"[https://example.test/q](https://example.test/q)",
			`an empty annotation title self-titles the URL, got ${text}`
		);
	});

	test("sources and titles arriving after finish_reason still land, and the trailer renders after all content", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		await playChunks(
			stream,
			[
				{
					choices: [{ index: 0, delta: { content: "before" } }],
					citations: ["https://example.test/late"],
				},
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
				{
					choices: [{ index: 0, delta: { content: " after" } }],
					search_results: [{ url: "https://example.test/late", title: "Late title" }],
				},
			],
			progress
		);

		const text = visibleTextOf(parts);
		assert.equal(text.match(/Sources:/g)?.length, 1, `exactly one trailer however late the sources, got ${text}`);
		assertContains(
			text,
			"[Late title](https://example.test/late)",
			`a title arriving after finish_reason still upgrades the placeholder, got ${text}`
		);
		assert.ok(
			text.startsWith("before after"),
			`content streamed after finish_reason still renders before the trailer, got ${text}`
		);
		assertEndsWith(text, "(https://example.test/late)", `nothing may render after the trailer, got ${text}`);
	});

	test("a source arriving after [DONE] still lands in the trailer", async () => {
		// Mirrors the straggling usage trailer: [DONE] continues the loop, so
		// the post-loop run is the one that renders the sources.
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const body = sseStream([
			'data: {"choices":[{"delta":{"content":"hi"}}],"citations":["https://example.test/early"]}\n',
			"data: [DONE]\n",
			'data: {"choices":[],"search_results":[{"url":"https://example.test/straggler","title":"Straggler"}]}\n',
		]);

		await stream.processStreamingResponse(body, progress, new vscode.CancellationTokenSource().token);

		const text = visibleTextOf(parts);
		assert.equal(text.match(/Sources:/g)?.length, 1, `got ${text}`);
		assertShows(text, "https://example.test/early", "the pre-[DONE] source stays listed");
		assertContains(
			text,
			"[Straggler](https://example.test/straggler)",
			`the post-[DONE] source must not be lost, got ${text}`
		);
	});

	test("a cancelled stream emits no sources trailer", async () => {
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();
		const source = new vscode.CancellationTokenSource();
		const body = sseStream(
			['data: {"choices":[{"delta":{"content":"hi"}}],"citations":["https://example.test/c"]}\n'],
			() => source.cancel()
		);

		await stream.processStreamingResponse(body, progress, source.token);

		assert.ok(!visibleTextOf(parts).includes("Sources:"), "a cancelled request ships no trailer");
	});

	test("a citations-only stream without dropped reasoning resolves with its trailer", async () => {
		// The trailer never counts as substantive output for the reasoning-only
		// check, but with nothing dropped there is nothing to report.
		const stream = new StreamProcessor(idSource(), () => {});
		const { parts, progress } = collector();

		await playChunks(
			stream,
			[{ choices: [], citations: ["https://example.test/only"] }, { choices: [{ delta: {}, finish_reason: "stop" }] }],
			progress
		);

		const text = visibleTextOf(parts);
		assert.equal(text.match(/Sources:/g)?.length, 1, `got ${text}`);
		assertShows(text, "https://example.test/only", "the lone citation renders");
	});
});

suite("provider/streaming pass-through of unhandled modern fields", () => {
	test("usage logging is restricted to the known numeric token counts", async () => {
		// The usage record is response-owned: unknown keys and non-numeric values
		// in known slots must never ride into the log data.
		const cases = [
			{
				usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
				expected: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
				reason: "a details-less record logs exactly its three counts",
			},
			{
				usage: {
					prompt_tokens: 120,
					completion_tokens: 80,
					total_tokens: 200,
					prompt_tokens_details: { cached_tokens: 90, gateway_note: "internal-usage-MARKER" },
					completion_tokens_details: { reasoning_tokens: 40 },
					gateway_debug: "internal-usage-MARKER",
				},
				expected: {
					prompt_tokens: 120,
					completion_tokens: 80,
					total_tokens: 200,
					"prompt_tokens_details.cached_tokens": 90,
					"completion_tokens_details.reasoning_tokens": 40,
				},
				reason: "known nested counts flatten in; unknown keys at either level stay out",
			},
		];
		for (const { usage, expected, reason } of cases) {
			const logged: { message: string; data?: unknown }[] = [];
			const stream = new StreamProcessor(idSource(), (message, data) => logged.push({ message, data }));
			const { progress } = collector();

			stream.processDelta({ choices: [], usage }, progress);

			const usageLog = logged.find((l) => l.message === "Token usage");
			assert.deepStrictEqual(expectDefined(usageLog?.data), expected, reason);
		}
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
		// Bare/short padding and noncanonical pad bits, which Buffer would silently
		// decode to empty or truncated bytes, plus bad alphabet, length, URL-safe.
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

	test("the audio part flushes before the citations trailer", async () => {
		const stream = mediaProcessor();
		const { parts, progress } = collector();

		await playChunks(
			stream,
			[
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
				finish,
			],
			progress
		);

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
