import * as assert from "node:assert";
import * as vscode from "vscode";
import { STACK_DEFAULTS } from "./envFile";
import { COMMAND_SIGIL } from "./fakeStack/commands";
import { addServer, clearServers, ensureActivated, extractText, waitForHostModels } from "./hostApiHelpers";
import { expectDefined } from "./testUtils";

/**
 * Transport-failure suite for the docker LiteLLM stack: streams that die
 * instead of finishing. The fake backend's transport verbs (%abort, %nodone,
 * %stall; src/test/fakeStack/commands.ts) and raw custom scenarios
 * (src/test/scenarios.ts) produce the failures; the tests pin how the
 * extension surfaces them through the real VS Code LM API.
 *
 * Like the stream fuzzer, every scenario runs against two targets: through
 * the LiteLLM proxy (the playback model) and directly against the fake
 * backend. Directed tests only - no seeds. Assertions hold classifications
 * and user-facing message text, never raw response bytes. Raw-framing
 * scenarios run direct only: the proxy re-serializes streams, so malformed
 * bytes cannot survive the hop.
 */

const BASE_URL = process.env.LITELLM_DOCKER_BASE_URL || "";
const API_KEY = process.env.LITELLM_DOCKER_API_KEY || STACK_DEFAULTS.LITELLM_MASTER_KEY;
const FAKE_URL = process.env.LITELLM_DOCKER_FAKE_URL || "";

// ── Suite plumbing ────────────────────────────────────────────────────────────

/** Raw scenarios register on the fake backend; the proxy leg reaches them through %play like any other scenario. */
async function registerScenario(name: string, config: Record<string, unknown>): Promise<void> {
	const registered = await fetch(`${FAKE_URL}/_test/custom-scenario`, {
		method: "PUT",
		body: JSON.stringify({ name, config }),
	});
	assert.ok(registered.ok, `custom-scenario registration failed (${name}): ${registered.status}`);
}

interface StreamOutcome {
	parts: unknown[];
	/** Undefined when the stream completed cleanly. */
	error: unknown;
	elapsedMs: number;
}

/** Send one text turn and drain the stream, keeping whatever arrived before a failure. */
async function runToOutcome(model: vscode.LanguageModelChat, text: string): Promise<StreamOutcome> {
	const started = Date.now();
	const parts: unknown[] = [];
	let error: unknown;
	const source = new vscode.CancellationTokenSource();
	try {
		const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(text)], {}, source.token);
		for await (const part of response.stream) {
			parts.push(part);
		}
	} catch (e) {
		error = e;
	} finally {
		source.dispose();
	}
	return { parts, error, elapsedMs: Date.now() - started };
}

/** A minimal but valid streaming chunk for raw frames; parseChunk needs nothing beyond choices. */
const rawChunk = (content: string): Record<string, unknown> => ({ choices: [{ index: 0, delta: { content } }] });
const sseEvent = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\n\n`;
const SSE_DONE = "data: [DONE]\n\n";
const SSE_CONTENT_TYPE = { "Content-Type": "text/event-stream" };

function transportSuite(title: string, directMode: boolean, serverUrl: string, serverKey: string): void {
	suite(title, () => {
		let model: vscode.LanguageModelChat;

		/** One green request proving the model is not wedged (and, on the proxy leg, not cooled down). */
		async function assertModelStillAnswers(): Promise<void> {
			const recovered = await runToOutcome(model, `${COMMAND_SIGIL}echo:recovered`);
			assert.strictEqual(recovered.error, undefined, `the next request must succeed, got ${String(recovered.error)}`);
			assert.strictEqual(extractText(recovered.parts), "recovered");
		}

		suiteSetup(async function () {
			this.timeout(90000);
			await ensureActivated();
			await clearServers();
			await addServer(title, serverUrl, serverKey);
			// Single-deployment on purpose: responses cannot vary by routing.
			const wantedId = directMode ? "fake-mini" : "gpt-5.2-mini";
			const models = await waitForHostModels(
				60000,
				(candidates) => candidates.some((m) => m.id === wantedId),
				`host to expose ${wantedId}`
			);
			model = expectDefined(models.find((m) => m.id === wantedId));
		});

		test(`${COMMAND_SIGIL}abort:3 fails promptly, keeps the streamed text, and leaves the model usable`, async function () {
			this.timeout(60000);
			if (directMode) {
				const outcome = await runToOutcome(model, `${COMMAND_SIGIL}abort:3`);
				assert.ok(outcome.error !== undefined, "a mid-stream destroy must surface as an error, not a clean completion");
				assert.ok(outcome.elapsedMs < 30000, `the failure must be prompt, took ${outcome.elapsedMs}ms`);
				// The playback's flush delay before the destroy tail lets the chunks
				// reach the peer, so this is a genuine MID-STREAM death: all three
				// chunks stream out, then the request fails. The body-read
				// termination (undici's bare "terminated") maps to the classified
				// mid-stream network message, never the raw TypeError.
				assert.strictEqual(extractText(outcome.parts), "chunk1 chunk2 chunk3 ");
				assert.match(
					String(outcome.error),
					/Network Error: The connection to .+ was closed before the response completed/
				);
				assert.ok(!String(outcome.error).startsWith("TypeError"), "the raw undici error must never surface");
			} else {
				// Observed against LiteLLM v1.93: the proxy neither forwards the
				// upstream's mid-stream death nor ends the client stream - the
				// request just hangs. The extension's requestTimeout is the hard
				// whole-call bound that makes the failure observable, so the test
				// lowers it for this one request and pins the classified timeout.
				const configuration = vscode.workspace.getConfiguration("litellm-vscode-chat");
				await configuration.update("requestTimeout", 10000, vscode.ConfigurationTarget.Global);
				let outcome: StreamOutcome;
				try {
					outcome = await runToOutcome(model, `${COMMAND_SIGIL}abort:3`);
				} finally {
					await configuration.update("requestTimeout", undefined, vscode.ConfigurationTarget.Global);
				}
				assert.ok(outcome.error !== undefined, "the hung stream must surface the whole-call timeout");
				assert.ok(outcome.elapsedMs < 30000, `the timeout must bound the hang, took ${outcome.elapsedMs}ms`);
				assert.match(String(outcome.error), /LiteLLM request timed out after 10000ms/);
				// LiteLLM held the client stream while the upstream died, so what
				// text got through before the timeout is its buffering's business;
				// it must still be a prefix of the chunk text.
				const text = extractText(outcome.parts);
				assert.ok(
					"chunk1 chunk2 chunk3 ".startsWith(text),
					`text before the timeout must be a chunk-text prefix, got ${JSON.stringify(text)}`
				);
			}
			await assertModelStillAnswers();
		});

		test(`${COMMAND_SIGIL}nodone:5 completes cleanly: EOF without [DONE] is tolerated end to end`, async function () {
			this.timeout(60000);
			const outcome = await runToOutcome(model, `${COMMAND_SIGIL}nodone:5`);
			// Pinned from observation on both targets. Direct: the extension's
			// stream loop treats plain EOF as end of stream (finishStream runs on
			// reader exhaustion), so the request completes with every chunk's text
			// and no error. Proxy: LiteLLM v1.93 tolerates the missing sentinel the
			// same way - it forwards all five deltas and ends the client stream
			// cleanly with its own [DONE].
			assert.strictEqual(outcome.error, undefined, `clean EOF must not fail the request: ${String(outcome.error)}`);
			assert.strictEqual(extractText(outcome.parts), "chunk1 chunk2 chunk3 chunk4 chunk5 ");
			await assertModelStillAnswers();
		});

		test(`cancelling during a ${COMMAND_SIGIL}stall terminates promptly and emits nothing afterward`, async function () {
			this.timeout(60000);
			const source = new vscode.CancellationTokenSource();
			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User(`${COMMAND_SIGIL}stall:3:30000`)],
				{},
				source.token
			);
			const parts: unknown[] = [];
			let partsWhenCancelled = 0;
			let cancelledAt = 0;
			try {
				for await (const part of response.stream) {
					parts.push(part);
					if (cancelledAt === 0 && parts.length >= 3) {
						partsWhenCancelled = parts.length;
						cancelledAt = Date.now();
						source.cancel();
					}
				}
			} catch (e) {
				// Same tolerance as the fuzz suite's cancellation pass: the extension
				// throws vscode.CancellationError; the host may re-wrap it.
				assert.ok(
					e instanceof vscode.CancellationError || /cancel/i.test(String(e)),
					`expected a cancellation error, got ${String(e)}`
				);
			} finally {
				source.dispose();
			}
			assert.ok(cancelledAt > 0, `all three parts must arrive before the stall; got ${parts.length}`);
			const sinceCancel = Date.now() - cancelledAt;
			assert.ok(sinceCancel < 10000, `cancel must not wait out the 30s stall, took ${sinceCancel}ms`);
			// The wire is silent during the stall, so nothing can legitimately
			// follow the cancel.
			assert.strictEqual(parts.length, partsWhenCancelled, "no parts may be emitted after cancel");
			await assertModelStillAnswers();
		});

		test("a raw 503 with an HTML body rejects with an http-classified error", async function () {
			this.timeout(60000);
			await registerScenario("transport-html-503", {
				type: "raw",
				statusCode: 503,
				headers: { "Content-Type": "text/html" },
				frames: ["<html><body><h1>Service Unavailable</h1></body></html>"],
				tail: "end",
			});
			const outcome = await runToOutcome(model, `${COMMAND_SIGIL}play:transport-html-503`);
			assert.ok(outcome.error !== undefined, "a 503 must reject the request");
			// The http classification carries the status in its user-facing
			// message. Observed on both targets: the direct leg is the extension's
			// own mapping, and LiteLLM v1.93 maps the upstream 503 to its
			// ServiceUnavailableError, so the proxy answers 503 too. The HTML body
			// text is deliberately NOT asserted anywhere; a later phase pins the
			// log buffer instead.
			assert.match(String(outcome.error), /LiteLLM API error: 503/);
			await assertModelStillAnswers();
		});

		// ── Malformed SSE framing over a real socket (direct target only) ────────
		// The proxy re-serializes streams, so malformed bytes cannot survive the
		// hop; these scenarios only exist against the fake backend directly.
		if (directMode) {
			suite("malformed SSE framing", () => {
				test("a garbage non-JSON data line between two valid events is skipped", async function () {
					this.timeout(60000);
					await registerScenario("transport-garbage-line", {
						type: "raw",
						statusCode: 200,
						headers: SSE_CONTENT_TYPE,
						frames: [
							sseEvent(rawChunk("alpha ")) + "data: this is not JSON {\n\n" + sseEvent(rawChunk("beta")) + SSE_DONE,
						],
						tail: "end",
					});
					const outcome = await runToOutcome(model, `${COMMAND_SIGIL}play:transport-garbage-line`);
					// The pinned log-and-skip contract: both valid deltas surface, the
					// garbage line is skipped, the stream completes.
					assert.strictEqual(
						outcome.error,
						undefined,
						`must complete despite the garbage line: ${String(outcome.error)}`
					);
					assert.strictEqual(extractText(outcome.parts), "alpha beta");
				});

				test("one event split across two frames mid-JSON and mid-UTF-8 reassembles exactly", async function () {
					this.timeout(60000);
					// The delta text carries a two-byte character; the frame boundary cuts
					// BETWEEN its UTF-8 bytes (and therefore also mid-JSON-string), so the
					// decoder must reassemble across reads.
					const body = Buffer.from(sseEvent(rawChunk("caf\u00e9 latte")) + SSE_DONE, "utf8");
					const splitAt = body.indexOf(0xc3) + 1;
					assert.ok(splitAt > 0, "the fixture must contain the two-byte character");
					await registerScenario("transport-split-utf8", {
						type: "raw",
						statusCode: 200,
						headers: SSE_CONTENT_TYPE,
						frames: [body.subarray(0, splitAt).toString("latin1"), body.subarray(splitAt).toString("latin1")],
						frameDelayMs: 50,
						tail: "end",
					});
					const outcome = await runToOutcome(model, `${COMMAND_SIGIL}play:transport-split-utf8`);
					assert.strictEqual(
						outcome.error,
						undefined,
						`split frames must not fail the stream: ${String(outcome.error)}`
					);
					assert.strictEqual(extractText(outcome.parts), "caf\u00e9 latte");
				});

				test("CRLF line endings, a leading comment line, and data: with no space", async function () {
					this.timeout(60000);
					const crlfEvent = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\r\n\r\n`;
					await registerScenario("transport-crlf-comment", {
						type: "raw",
						statusCode: 200,
						headers: SSE_CONTENT_TYPE,
						frames: [
							": stream comment line\r\n" +
								crlfEvent(rawChunk("crlf one ")) +
								`data:${JSON.stringify(rawChunk("nospace "))}\r\n\r\n` +
								crlfEvent(rawChunk("crlf two")) +
								"data: [DONE]\r\n\r\n",
						],
						tail: "end",
					});
					const outcome = await runToOutcome(model, `${COMMAND_SIGIL}play:transport-crlf-comment`);
					assert.strictEqual(outcome.error, undefined, `leniency must hold: ${String(outcome.error)}`);
					// Pinned from observation: CRLF framing and the comment line are
					// tolerated, and the no-space "data:" line is SKIPPED, not parsed -
					// the stream loop reads only "data: " lines (the log-and-skip
					// contract), so that event's text never surfaces and the stream
					// still completes.
					assert.strictEqual(extractText(outcome.parts), "crlf one crlf two");
				});

				test("a truncated final event then destroy fails observably with prior text intact", async function () {
					this.timeout(60000);
					// The frame delay is load-bearing: destroying right after the writes
					// puts the RST in the same burst as the data, and the client then
					// drops the never-read bytes - the "prior text" event must be read
					// and emitted before the socket dies for the intact-text half of
					// this test to observe anything.
					await registerScenario("transport-truncated-destroy", {
						type: "raw",
						statusCode: 200,
						headers: SSE_CONTENT_TYPE,
						frames: [sseEvent(rawChunk("prior text")), 'data: {"choices":[{"index":0,"delta":{"content":"lost'],
						frameDelayMs: 150,
						tail: "destroy",
					});
					const outcome = await runToOutcome(model, `${COMMAND_SIGIL}play:transport-truncated-destroy`);
					assert.ok(outcome.error !== undefined, "the truncated stream must fail observably");
					assert.strictEqual(extractText(outcome.parts), "prior text");
				});

				test("an in-band error frame after valid chunks fails the request with prior text intact", async function () {
					this.timeout(60000);
					// The shape LiteLLM's own proxy emits when an upstream dies after
					// the 200: valid chunks, an error frame, then a clean end with no
					// [DONE]. Silently completing here would be an unobservable
					// truncation.
					await registerScenario("transport-error-frame", {
						type: "raw",
						statusCode: 200,
						headers: SSE_CONTENT_TYPE,
						frames: [
							sseEvent(rawChunk("before ")),
							'data: {"error":{"message":"upstream exploded mid-stream","code":"500"}}\n\n',
						],
						frameDelayMs: 50,
						tail: "end",
					});
					const outcome = await runToOutcome(model, `${COMMAND_SIGIL}play:transport-error-frame`);
					assert.ok(outcome.error !== undefined, "the error frame must fail the request, not truncate it silently");
					assert.match(String(outcome.error), /LiteLLM API error: the stream reported an error/);
					assert.strictEqual(extractText(outcome.parts), "before ");
				});
			});
		}
	});
}

if (!BASE_URL) {
	suite("Docker LiteLLM transport failures", () => {
		test("SKIPPED: LITELLM_DOCKER_BASE_URL not set; run via `bun run test:docker`", () => {});
	});
} else {
	transportSuite("Docker transport failures (proxy)", false, BASE_URL, API_KEY);
	transportSuite("Docker transport failures (direct)", true, FAKE_URL, "fake-key");
}
