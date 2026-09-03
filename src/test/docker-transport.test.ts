import * as assert from "node:assert";
import * as vscode from "vscode";
import { createTitleAndDescriptionProvider } from "../extension/features/prGen/provider";
import { FIM_MAX_TOKENS, FIM_TIMEOUT_MS } from "../provider/transport/fim";
import { OneShotClient } from "../provider/transport/oneShotClient";
import { CONFIG_SECTION } from "../shared/config/settingSpec";
import { STACK_DEFAULTS } from "./envFile";
import { COMMAND_SIGIL } from "./fakeStack/commands";
import {
	assertIdsUnserved,
	refreshEntryModels,
	restoreServersSettingAfterRun,
	uniqueName,
	waitForGroupStatus,
	writeServerEntry,
} from "./groupApiHelpers";
import { catalogOff, ensureActivated, extractText, waitForHostModels } from "./hostApiHelpers";
import { expectDefined } from "./pureHelpers";

/**
 * Transport-failure suite for the docker LiteLLM stack: streams that die instead
 * of finishing. The fake backend's transport verbs (%abort, %nodone, %stall) and
 * raw custom scenarios produce the failures; the tests pin how the extension
 * surfaces them through the real VS Code LM API.
 *
 * Every scenario runs against two targets: through the LiteLLM proxy (the
 * playback model) and directly against the fake backend. Directed tests only, no
 * seeds. Assertions hold classifications and user-facing message text, never raw
 * response bytes. Raw-framing scenarios run direct only: the proxy re-serializes
 * streams, so malformed bytes cannot survive the hop.
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

/**
 * One declared entry and resolved model per target (proxy/direct) for the whole
 * label host, shared by the transport and error-mapping suites: the stack's model
 * ids are fixed, so a second same-URL group would serve indistinguishable twins.
 * The memo key IS the target, and each target's URL and key are derived here so
 * the memo cannot disagree with a caller's arguments.
 */
const targetModels = new Map<string, Promise<vscode.LanguageModelChat>>();
function resolveTargetModel(directMode: boolean): Promise<vscode.LanguageModelChat> {
	const target = directMode ? "direct" : "proxy";
	let resolved = targetModels.get(target);
	if (resolved === undefined) {
		resolved = (async () => {
			await ensureActivated();
			await catalogOff();
			// Single-deployment on purpose: responses cannot vary by routing.
			const wantedId = directMode ? "fake-mini" : "gpt-5.2-mini";
			await assertIdsUnserved([wantedId]);
			await writeServerEntry(
				{
					label: uniqueName(`transport-${target}`),
					baseUrl: directMode ? FAKE_URL : BASE_URL,
					auth: { apiKey: directMode ? "fake-key" : API_KEY },
				},
				60000
			);
			const models = await waitForHostModels(
				60000,
				(candidates) => candidates.some((m) => m.id === wantedId),
				`host to expose ${wantedId}`
			);
			return expectDefined(models.find((m) => m.id === wantedId));
		})();
		targetModels.set(target, resolved);
	}
	return resolved;
}

function transportSuite(title: string, directMode: boolean): void {
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
			model = await resolveTargetModel(directMode);
		});

		test(`${COMMAND_SIGIL}abort:3 keeps the streamed text and leaves the model usable: a classified death direct, a swallowed drop through the proxy`, async function () {
			this.timeout(60000);
			const outcome = await runToOutcome(model, `${COMMAND_SIGIL}abort:3`);
			// The playback's flush delay before the destroy tail makes this a
			// genuine MID-STREAM death: all three chunks stream out, then the
			// socket drops with the chunked body unterminated.
			assert.strictEqual(extractText(outcome.parts), "chunk1 chunk2 chunk3 ");
			if (directMode) {
				assert.ok(outcome.error !== undefined, "a mid-stream destroy must surface as an error, not a clean completion");
				assert.ok(outcome.elapsedMs < 30000, `the failure must be prompt, took ${outcome.elapsedMs}ms`);
				// The body-read termination (undici's bare "terminated") maps to the
				// classified mid-stream network message, never the raw TypeError.
				assert.match(
					String(outcome.error),
					/The connection dropped before the model finished replying[\s\S]*closed mid-response/
				);
				assert.ok(!String(outcome.error).startsWith("TypeError"), "the raw undici error must never surface");
			} else {
				// Observed against LiteLLM v1.93: the proxy SWALLOWS the upstream's
				// socket drop. Its HTTP client reads the unterminated body as end of
				// stream, the proxy synthesizes a finish and its own [DONE], and the
				// extension sees a clean completion carrying the text that got
				// through - the truncation is invisible on this side of the proxy.
				// Pinned so a proxy upgrade that starts forwarding the death shows up
				// as a diff. (Until bun 1.4.0 the fake backend's destroy tail leaked
				// stray header bytes into the chunked body, a bun 1.3.x bug the proxy
				// reacted to by hanging; the whole-call timeout test below now drives
				// that hang with a %stall, a genuine upstream hang.)
				assert.strictEqual(
					outcome.error,
					undefined,
					`LiteLLM v1.93 swallows an upstream socket drop; got ${String(outcome.error)}`
				);
				assert.ok(
					outcome.elapsedMs < 30000,
					`the swallowed drop must still complete promptly, took ${outcome.elapsedMs}ms`
				);
			}
			await assertModelStillAnswers();
		});

		test(`${COMMAND_SIGIL}stall:3:30000 under a 10s chat.timeout fails at the whole-call bound with the streamed text`, async function () {
			this.timeout(60000);
			// A genuine mid-stream hang: three chunks, then the upstream holds the
			// connection silent for 30s. Through the proxy, LiteLLM forwards the
			// chunks and then waits with it; direct, the extension waits alone.
			// requestTimeout is the hard whole-call bound that makes the hang
			// observable, lowered here for this one request.
			const configuration = vscode.workspace.getConfiguration("litellm-vscode-chat");
			await configuration.update("chat.timeout", 10000, vscode.ConfigurationTarget.Global);
			let outcome: StreamOutcome;
			try {
				outcome = await runToOutcome(model, `${COMMAND_SIGIL}stall:3:30000`);
			} finally {
				await configuration.update("chat.timeout", undefined, vscode.ConfigurationTarget.Global);
			}
			assert.ok(outcome.error !== undefined, "the hung stream must surface the whole-call timeout");
			assert.ok(outcome.elapsedMs < 30000, `the timeout must bound the hang, took ${outcome.elapsedMs}ms`);
			assert.match(String(outcome.error), /LiteLLM request timed out after 10000ms/);
			// The wire went silent after the third chunk, so what text arrived before
			// the timeout is buffering's business (the proxy's or the host's); it
			// must still be a prefix of the chunk text.
			const text = extractText(outcome.parts);
			assert.ok(
				"chunk1 chunk2 chunk3 ".startsWith(text),
				`text before the timeout must be a chunk-text prefix, got ${JSON.stringify(text)}`
			);
			await assertModelStillAnswers();
		});

		test(`${COMMAND_SIGIL}nodone:5 completes cleanly: EOF without [DONE] is tolerated end to end`, async function () {
			this.timeout(60000);
			const outcome = await runToOutcome(model, `${COMMAND_SIGIL}nodone:5`);
			// Pinned from observation on both targets. Direct: the stream loop treats
			// plain EOF as end of stream (finishStream runs on reader exhaustion).
			// Proxy: LiteLLM v1.93 tolerates the missing sentinel the same way,
			// forwarding all five deltas and ending with its own [DONE].
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
			// The http classification carries the status in its user-facing message.
			// Observed on both targets: the direct leg is the extension's own mapping,
			// and LiteLLM v1.93 maps the upstream 503 to its ServiceUnavailableError.
			// The HTML body text is deliberately never asserted; the buffer-secrecy
			// suite below pins its absence from the log buffer instead.
			assert.match(String(outcome.error), /LiteLLM 503\b/);
			await assertModelStillAnswers();
		});

		// -- Malformed SSE framing over a real socket (direct target only) --------
		// The proxy re-serializes streams, so malformed bytes cannot survive the hop.
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
					// contract), so that event's text never surfaces.
					assert.strictEqual(extractText(outcome.parts), "crlf one crlf two");
				});

				test("a truncated final event then destroy fails observably with prior text intact", async function () {
					this.timeout(60000);
					// The frame delay is load-bearing: destroying right after the writes
					// puts the RST in the same burst as the data and the client drops the
					// never-read bytes, leaving the intact-text half nothing to observe.
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
					// The shape LiteLLM's own proxy emits when an upstream dies after the
					// 200: valid chunks, an error frame, then a clean end with no [DONE].
					// Silently completing would be an unobservable truncation.
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
					assert.match(String(outcome.error), /LiteLLM stream error/);
					assert.strictEqual(extractText(outcome.parts), "before ");
				});
			});
		}
	});
}

// -- Timeouts and error mapping through the real stack -----------------------
//
// Discovery-timeout e2e is deliberately skipped: the fake backend's command
// grammar only controls chat completions, so /v1/models cannot be delayed here,
// and the discovery surface's timeout mapping is pinned by the msw unit suites.

/** The statuses %error covers minus 400/401/429, which docker-litellm.test.ts already exercises through the proxy. */
const ERROR_SWEEP = [403, 404, 408, 409, 422, 500, 502, 503, 504] as const;

/**
 * What the proxy answers when the upstream returns each swept status, pinned
 * from observation against the docker stack (LiteLLM v1.93): identity for all
 * nine - it wraps each upstream body in its own exception envelope but forwards
 * the status unchanged. The direct target always carries the exact upstream
 * status; pinning the proxy here turns a rewriting upgrade into a diff.
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

/**
 * Every issue-report log line of this session, through the lossless test tee:
 * unlike the production buffer's 50-entry rolling window it cannot rotate a line
 * out before the secrecy sweep reads it, and it carries every error snapshot's
 * public rendering too.
 */
async function sessionLogLines(): Promise<string[]> {
	const batch = (await vscode.commands.executeCommand("litellm._test.getSessionLogs", 0)) as {
		lines: string[];
		dropped: number;
	};
	assert.strictEqual(batch.dropped, 0, "the session log tee must not have evicted lines");
	return batch.lines;
}

function errorMappingSuite(title: string, directMode: boolean): void {
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
			model = await resolveTargetModel(directMode);
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
						new RegExp(`LiteLLM ${expected}\\b`),
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
				priorTimeout = vscode.workspace.getConfiguration(CONFIG_SECTION).inspect("chat.timeout")?.globalValue;
				await vscode.workspace
					.getConfiguration(CONFIG_SECTION)
					.update("chat.timeout", 3000, vscode.ConfigurationTarget.Global);
			});

			// Runs even when a test fails, so the 3s bound never leaks into later suites.
			suiteTeardown(async () => {
				await vscode.workspace
					.getConfiguration(CONFIG_SECTION)
					.update("chat.timeout", priorTimeout, vscode.ConfigurationTarget.Global);
			});

			test(`${COMMAND_SIGIL}delay:15000 fails at the 3000ms bound, not when the delay elapses`, async function () {
				this.timeout(60000);
				const outcome = await runToOutcome(model, `${COMMAND_SIGIL}delay:15000`);
				assert.ok(outcome.error !== undefined, "the delayed reply must not outlive the timeout");
				assert.match(String(outcome.error), /LiteLLM request timed out after 3000ms/);
				assert.ok(outcome.elapsedMs >= 2900, `the timeout must not fire early: ${outcome.elapsedMs}ms`);
				// The configured timeout is a hard whole-call bound: ~3s, never the 15s
				// the backend would take. The ceiling leaves slack for slow CI runners.
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
		const label = uniqueName("WrongMasterKey");

		suiteSetup(async function () {
			this.timeout(60000);
			await ensureActivated();
			await catalogOff();
		});

		test("a declared entry with a rejected key syncs its group into a 401-classified error serving nothing", async function () {
			this.timeout(90000);
			// Sampled BEFORE the entry lands: the stack's model ids are fixed, so the
			// only host-visible proof the rejected group serves nothing is its
			// arrival leaving the copy count alone.
			const countProxyCopies = async () =>
				(await vscode.lm.selectChatModels({ vendor: "litellm" })).filter((m) => m.id === "gpt-5.2-mini").length;
			const before = await countProxyCopies();
			// The entry syncs (credentials are opaque to the host), then the group's
			// discovery fails against the proxy's master-key gate: the silent
			// per-group refresh resolves EMPTY rather than throwing, recording the
			// truthful error status.
			await writeServerEntry({ label, baseUrl: BASE_URL, auth: { apiKey: WRONG_MASTER_KEY } }, 60000);
			const status = await waitForGroupStatus(label, (candidate) => candidate.state === "error", 30000);
			assert.ok(status.state === "error", "narrowed by the wait");
			assert.strictEqual(status.classification?.kind, "auth", "the gate's rejection classifies as auth");
			assert.strictEqual(status.classification?.status, 401, "a 401 is never re-wrapped as a network error");
			// Asserted across a settle window: the host ingests model lists
			// asynchronously, so one clean sample could be a transient. Bounded above
			// only - a healthy sibling's refresh dip must not be blamed on the
			// rejected group; only GROWTH would prove it served.
			const settleDeadline = Date.now() + 2500;
			while (Date.now() < settleDeadline) {
				assert.ok((await countProxyCopies()) <= before, "a rejected group must never add models");
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		});

		test("a non-silent refresh of the rejected entry throws auth-classified, never network-wrapped", async function () {
			this.timeout(60000);
			await assert.rejects(
				() => refreshEntryModels(label),
				(error: unknown) => /Authentication failed/.test(String(error)),
				"the gate's 401 must surface as the auth classification, not a rewrapped network error"
			);
		});

		test("the log buffer carries the auth classification and no key material or body text", async () => {
			const logs = await sessionLogLines();
			// Pinned from observation: the pinned stack (LiteLLM v1.93 in its database
			// flavor) rejects an unknown master key with an HTTP 401 on both
			// /v1/model/info and /v1/models, so the refresh failure logs the
			// AUTH_MESSAGE template (englishMessage; the buffer is English-only). The
			// DB-LESS v1.93 proxy answered 400 instead (a BadRequestError wrapping an
			// auth_error body); if a stack change resurfaces that shape, repin this to
			// the "RequestError(http, status 400)" classification.
			assert.ok(
				logs.some(
					(line) =>
						line.includes("Failed to fetch models for provider group") &&
						line.includes("Authentication failed: Your LiteLLM server requires an API key")
				),
				"the gate's 401 must land in the buffer as the English auth template"
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
	suite("Docker issue-report buffer secrecy", () => {
		test("no response bodies or credential markers ever reached the buffer", async () => {
			// The sweep runs over every line any test in this file pushed through the
			// issue-report stream, error snapshots included.
			const logs = await sessionLogLines();
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

/**
 * The FIM path end to end: one non-streaming completeFim through the real
 * LiteLLM proxy to the fake backend's /v1/completions arm. The backend's
 * reply is a pure function of the prompt, so the assertion derives the
 * expected text from the request alone; the observation route then proves
 * what actually reached the wire behind the proxy.
 */
function fimCompletionSuite(): void {
	suite("Docker FIM completion (proxy end to end)", () => {
		test("completeFim reaches the completion-mode model through the proxy and nothing extra rides the body", async function () {
			this.timeout(30000);
			const client = new OneShotClient({ userAgent: "litellm-vscode-chat-docker-test" });
			const prompt = "function add(a, b) {\n\treturn ";
			const suffix = ";\n}\n";
			const text = await client.completeFim(
				{ baseUrl: BASE_URL, apiKey: API_KEY, headers: {} },
				{ model: "codestral-fim", prompt, suffix, maxTokens: FIM_MAX_TOKENS },
				{ timeout: { ms: FIM_TIMEOUT_MS, setting: undefined }, token: new vscode.CancellationTokenSource().token }
			);
			// The fake backend's deterministic echo: fim(<last 24 of prompt>|<first 12 of suffix>).
			assert.strictEqual(text, `fim(${prompt.slice(-24)}|${suffix.slice(0, 12)})`);

			const observedResponse = await fetch(`${FAKE_URL}/_test/last-completion-request`);
			assert.ok(observedResponse.ok, `last-completion-request answered ${observedResponse.status}`);
			const observed = (await observedResponse.json()) as Record<string, unknown>;
			assert.strictEqual(observed.model, "fake-fim", "LiteLLM resolves the alias to its upstream id");
			assert.strictEqual(observed.prompt, prompt, "the prompt crosses the proxy unchanged");
			assert.strictEqual(observed.suffix, suffix, "the suffix crosses the proxy unchanged");
			assert.strictEqual(observed.max_tokens, FIM_MAX_TOKENS);
			assert.strictEqual(observed.stream, false, "FIM requests are non-streaming by contract");
			// The pass-through contract's negative half: nothing this extension
			// never sends may appear (a proxy-added bookkeeping field would carry
			// a litellm marker, not a bare OpenAI parameter name).
			for (const key of ["temperature", "top_p", "_fim_template"]) {
				assert.ok(!(key in observed), `unexpected ${key} reached the backend`);
			}
		});
	});
}

/**
 * The PR generation path end to end: the real prompt assembly, one
 * non-streaming completeChatOnce through the real LiteLLM proxy under the
 * prGeneration error surface, and the real lenient parse of what comes back.
 * The fake backend answers the LAST line of the prompt, and buildPrPrompt puts
 * the patches last, so a patch that IS a command makes the reply a pure
 * function of the request.
 */
function prGenerationSuite(): void {
	suite("Docker PR generation (proxy end to end)", () => {
		test("a generated title and description survive the round trip, and nothing extra rides the body", async function () {
			this.timeout(30000);
			const client = new OneShotClient({ userAgent: "litellm-vscode-chat-docker-test" });
			const provider = createTitleAndDescriptionProvider((prompt, token) =>
				client.completeChatOnce(
					{ baseUrl: BASE_URL, apiKey: API_KEY, headers: {} },
					{ model: "gpt-5.2-mini", messages: [{ role: "user", content: prompt }] },
					"prGeneration",
					{ timeout: { ms: 30000, setting: "chat.timeout" }, token }
				)
			);
			const result = await provider.provideTitleAndDescription(
				{
					commitMessages: ["feat: wire the docker leg", "test: cover it"],
					// The fake backend replies to the last line; %echon decodes \n so
					// one line produces the two-part answer the parse must read.
					patches: [`${COMMAND_SIGIL}echon:Title: feat: wire the docker leg\\nDescription:\\nIt reaches the proxy.`],
					compareBranch: "feature/docker-leg",
				},
				new vscode.CancellationTokenSource().token
			);
			assert.deepStrictEqual(result, {
				title: "feat: wire the docker leg",
				description: "It reaches the proxy.",
			});

			const observedResponse = await fetch(`${FAKE_URL}/_test/last-request`);
			assert.ok(observedResponse.ok, `last-request answered ${observedResponse.status}`);
			const observed = (await observedResponse.json()) as Record<string, unknown>;
			// This IS the request just sent: the assembled prompt is unmistakable.
			assert.match(JSON.stringify(observed.messages), /wire the docker leg/, JSON.stringify(observed));
			// Non-streaming by contract. The proxy re-serializes the body, so a
			// `stream: false` may reach the backend as an omission; what must never
			// happen is a streamed one.
			assert.notStrictEqual(observed.stream, true, `PR generation must not stream: ${JSON.stringify(observed.stream)}`);
			// The pass-through contract's negative half on a one-shot path: no
			// max_tokens (this surface sets none) and no injected parameters.
			for (const key of ["temperature", "top_p", "max_tokens", "tools", "tool_choice"]) {
				assert.ok(!(key in observed), `unexpected ${key} reached the backend`);
			}
		});
	});
}

if (!BASE_URL) {
	suite("Docker LiteLLM transport failures", () => {
		test("SKIPPED: LITELLM_DOCKER_BASE_URL not set; run via `bun run test:docker`", () => {});
	});
} else {
	restoreServersSettingAfterRun();
	transportSuite("Docker transport failures (proxy)", false);
	transportSuite("Docker transport failures (direct)", true);
	errorMappingSuite("Docker error mapping and timeouts (proxy)", false);
	errorMappingSuite("Docker error mapping and timeouts (direct)", true);
	wrongMasterKeySuite();
	fimCompletionSuite();
	prGenerationSuite();
	bufferSecrecySuite();
}
