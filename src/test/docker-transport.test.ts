import * as assert from "node:assert";
import * as vscode from "vscode";
import { CONFIG_SECTION } from "../shared/settingSpec";
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

// -- Suite plumbing ------------------------------------------------------------

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

		// -- Malformed SSE framing over a real socket (direct target only) --------
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
							`${sseEvent(rawChunk("alpha "))}data: this is not JSON {\n\n${sseEvent(rawChunk("beta"))}${SSE_DONE}`,
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

// -- Timeouts and error mapping through the real stack -----------------------
//
// The suites below extend the transport file with deliberate HTTP errors
// (%error), the real whole-call timeout bound, a real key rejection from
// LiteLLM's own master-key gate, and a closing sweep over the issue-report
// log buffer.
// Discovery-timeout e2e is deliberately skipped: the fake backend's command
// grammar only controls chat completions, so /v1/models cannot be delayed
// here, and the discovery surface's timeout mapping is already pinned by the
// msw unit suites.

/** The statuses %error covers minus 400/401/429, which docker-litellm.test.ts already exercises through the proxy. */
const ERROR_SWEEP = [403, 404, 408, 409, 422, 500, 502, 503, 504] as const;

/**
 * What the proxy actually answers when the upstream returns each swept
 * status, pinned from observation against the docker stack (LiteLLM v1.93):
 * identity for all nine - LiteLLM wraps each upstream body in its own
 * exception envelope but forwards the status code unchanged. The direct
 * target always carries the exact upstream status; the proxy is asserted
 * against this record so a proxy upgrade that starts rewriting shows up as
 * a diff here, not a mystery failure.
 */
const PROXY_FORWARDED_STATUS: Readonly<Record<number, number>> = {
	403: 403,
	404: 404,
	408: 408,
	409: 409,
	422: 422,
	500: 500,
	502: 502,
	503: 503,
	504: 504,
};

/** The wrong-key scenario's credential marker; the secrecy assertions grep for its MARKER suffix. */
const WRONG_MASTER_KEY = "sk-wrong-master-key-MARKER";

/** The shared per-target setup: a clean registry with one server, resolved to the wanted model. */
async function setUpTargetModel(
	label: string,
	directMode: boolean,
	serverUrl: string,
	serverKey: string
): Promise<vscode.LanguageModelChat> {
	await ensureActivated();
	await clearServers();
	await addServer(label, serverUrl, serverKey);
	// Single-deployment on purpose, like the transport suites above.
	const wantedId = directMode ? "fake-mini" : "gpt-5.2-mini";
	const models = await waitForHostModels(
		60000,
		(candidates) => candidates.some((m) => m.id === wantedId),
		`host to expose ${wantedId}`
	);
	return expectDefined(models.find((m) => m.id === wantedId));
}

async function getRecentLogs(): Promise<string[]> {
	const logs = (await vscode.commands.executeCommand("litellm._test.getRecentLogs")) as string[];
	assert.ok(Array.isArray(logs), "litellm._test.getRecentLogs returns the buffer array");
	return logs;
}

function errorMappingSuite(title: string, directMode: boolean, serverUrl: string, serverKey: string): void {
	suite(title, () => {
		let model: vscode.LanguageModelChat;

		/** One green request proving the sweep neither wedged the model nor cooled the deployment down. */
		async function assertModelStillAnswers(): Promise<void> {
			const recovered = await runToOutcome(model, `${COMMAND_SIGIL}echo:recovered`);
			assert.strictEqual(recovered.error, undefined, `the next request must succeed, got ${String(recovered.error)}`);
			assert.strictEqual(extractText(recovered.parts), "recovered");
		}

		suiteSetup(async function () {
			this.timeout(90000);
			model = await setUpTargetModel(title, directMode, serverUrl, serverKey);
		});

		// Own cleanup rather than relying on the next suite's setup clearing.
		suiteTeardown(async function () {
			this.timeout(60000);
			await clearServers();
		});

		suite("deliberate HTTP error statuses", () => {
			for (const status of ERROR_SWEEP) {
				test(`${COMMAND_SIGIL}error:${status} rejects with a status-bearing message`, async function () {
					this.timeout(60000);
					const outcome = await runToOutcome(model, `${COMMAND_SIGIL}error:${status}`);
					assert.ok(outcome.error !== undefined, `a deliberate ${status} must reject the request`);
					const expected = directMode ? status : expectDefined(PROXY_FORWARDED_STATUS[status]);
					assert.match(
						String(outcome.error),
						new RegExp(`LiteLLM API error: ${expected}\\b`),
						directMode
							? "the direct target must carry the exact upstream status"
							: `the proxy's observed forwarding of ${status} is pinned as ${expected}`
					);
				});
			}

			test("after the sweep the model still answers: deliberate errors never cool the deployment down", async function () {
				this.timeout(60000);
				await assertModelStillAnswers();
			});
		});

		suite("real whole-call timeout bound", () => {
			let priorTimeout: unknown;

			suiteSetup(async () => {
				priorTimeout = vscode.workspace.getConfiguration(CONFIG_SECTION).inspect("requestTimeout")?.globalValue;
				await vscode.workspace
					.getConfiguration(CONFIG_SECTION)
					.update("requestTimeout", 3000, vscode.ConfigurationTarget.Global);
			});

			// Runs even when a test fails, so the 3s bound never leaks into later suites.
			suiteTeardown(async () => {
				await vscode.workspace
					.getConfiguration(CONFIG_SECTION)
					.update("requestTimeout", priorTimeout, vscode.ConfigurationTarget.Global);
			});

			test(`${COMMAND_SIGIL}delay:15000 fails at the 3000ms bound, not when the delay elapses`, async function () {
				this.timeout(60000);
				const outcome = await runToOutcome(model, `${COMMAND_SIGIL}delay:15000`);
				assert.ok(outcome.error !== undefined, "the delayed reply must not outlive the timeout");
				assert.match(String(outcome.error), /LiteLLM request timed out after 3000ms/);
				assert.ok(outcome.elapsedMs >= 2900, `the timeout must not fire early: ${outcome.elapsedMs}ms`);
				// The configured timeout is a hard whole-call bound: ~3s, never the
				// 15s the backend would take. The ceiling leaves slack for slow CI
				// runners while still proving the bound fired at 3s, not 15s.
				assert.ok(outcome.elapsedMs < 8000, `the bound must fire at ~3s, took ${outcome.elapsedMs}ms`);
			});

			test("a follow-up request succeeds after the timed-out one", async function () {
				this.timeout(60000);
				await assertModelStillAnswers();
			});
		});
	});
}

function wrongMasterKeySuite(): void {
	suite("Docker wrong master key (a real rejection from LiteLLM's own gate)", () => {
		suiteSetup(async function () {
			this.timeout(60000);
			await ensureActivated();
			await clearServers();
		});

		// The rejected server must not linger into later suites or reruns.
		suiteTeardown(async function () {
			this.timeout(60000);
			await clearServers();
		});

		test("adding a server with a rejected key resolves with an EMPTY model list", async function () {
			this.timeout(60000);
			// The silent-refresh invariant over a real rejection from the proxy's
			// master-key gate: the add's refresh runs silent, so the discovery
			// failure surfaces as an empty list, never a throw.
			const { modelIds } = await addServer("WrongMasterKey", BASE_URL, WRONG_MASTER_KEY);
			assert.deepStrictEqual(modelIds, [], "a silent refresh over a real key rejection must resolve empty");
		});

		test("the log buffer carries the http classification and no key material or body text", async () => {
			const logs = await getRecentLogs();
			// Pinned from observation: THE PINNED LITELLM VERSION (v1.93, the
			// docker stack) rejects an unknown master key with HTTP 400 (a
			// BadRequestError wrapping an auth_error body), NOT 401, on both
			// /v1/model/info and /v1/models. So the silent refresh's fetch
			// failure logs the http classification, not the 401 auth template.
			// If a proxy bump starts answering a proper 401 this assertion fails
			// loudly and should be repinned to the AUTH_MESSAGE template line
			// (the real-401 path keeps live coverage in docker-serversync's
			// revoked-bearer scenario and the errorMapping unit pins).
			assert.ok(
				logs.some(
					(line) =>
						line.includes("Failed to fetch models from server") && line.includes("RequestError(http, status 400)")
				),
				"the gate's 400 must land in the buffer as the fixed http classification"
			);
			for (const line of logs) {
				assert.ok(!line.includes(WRONG_MASTER_KEY), "the buffer leaked the rejected key");
				assert.ok(!line.includes(API_KEY), "the buffer leaked the real master key");
				// LiteLLM's gate envelope wordings; response bodies never reach the buffer.
				assert.ok(!line.includes("Invalid proxy server token"), "the buffer leaked the gate's response body");
				assert.ok(!line.includes("No api key passed in"), "the buffer leaked the gate's response body");
			}
		});
	});
}

function bufferSecrecySuite(): void {
	// Declared LAST on purpose: mocha tdd runs suites in declaration order, so
	// this consolidation observes the buffer only AFTER the raw-503 HTML test,
	// the %error sweeps, and the wrong-key scenario above have pushed real
	// error traffic through it. (The buffer caps at 50 entries, so the suites
	// closest to this one are the ones it reliably still sees.)
	suite("Docker issue-report buffer secrecy (runs last)", () => {
		test("no response bodies or credential markers ever reached the buffer", async () => {
			const logs = await getRecentLogs();
			assert.ok(logs.length > 0, "the suites above must have produced log traffic");
			assert.ok(
				logs.some((line) => line.includes("RequestError(")),
				"the error traffic above must be visible as classifications"
			);
			for (const line of logs) {
				// The fake backend's %error body wording (fakeStack/commands.ts).
				assert.ok(!line.includes("fake error with status"), "%error body text leaked into the buffer");
				// The raw-503 test's HTML marker.
				assert.ok(!line.includes("Service Unavailable"), "the raw 503 HTML body leaked into the buffer");
				// Any credential marker (this file's wrong-key scenario and friends).
				assert.ok(!line.includes("MARKER"), "a marker credential leaked into the buffer");
			}
		});
	});
}

if (!BASE_URL) {
	suite("Docker LiteLLM transport failures", () => {
		test("SKIPPED: LITELLM_DOCKER_BASE_URL not set; run via `bun run test:docker`", () => {});
	});
} else {
	transportSuite("Docker transport failures (proxy)", false, BASE_URL, API_KEY);
	transportSuite("Docker transport failures (direct)", true, FAKE_URL, "fake-key");
	errorMappingSuite("Docker error mapping and timeouts (proxy)", false, BASE_URL, API_KEY);
	errorMappingSuite("Docker error mapping and timeouts (direct)", true, FAKE_URL, "fake-key");
	wrongMasterKeySuite();
	bufferSecrecySuite();
}
