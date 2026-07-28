import * as assert from "node:assert";
import * as vscode from "vscode";
import { COMMAND_SIGIL } from "./fakeStack/commands";
import type { FuzzEvent } from "./fuzzCorpus";
import { FUZZ_CORPUS } from "./fuzzCorpus";
import { fuzzShardSalt, logFuzzSeed, resolveDockerFuzzSeed } from "./fuzzSeed";
import { assemble, chunkOf, generateEvents, mulberry32 } from "./fuzzStream";
import {
	addServer,
	clearServers,
	collectStream,
	ensureActivated,
	extractText,
	extractToolCalls,
	waitForHostModels,
} from "./hostApiHelpers";
import { expectDefined } from "./testUtils";

/**
 * Generative stream fuzzer for the docker LiteLLM stack. The event generators
 * and the assembly oracle live in fuzzStream.ts, shared with the in-process
 * property suites.
 *
 * Each iteration builds a random stream as a list of serializable events
 * (text, delta/inline/duplicated/interleaved tool calls, refusals, citations,
 * reasoning, junk), registers it on the fake backend, selects it by sending
 * %play:<name> as the user message, streams it through the VS Code LM API,
 * and asserts the exact expected outcome: text arrives verbatim (including
 * the space hint and citation trailer the extension adds), tool calls
 * reassemble exactly, and IDs stay unique.
 *
 * Two targets share the generator: through the LiteLLM proxy, and directly
 * against the fake backend. Direct mode additionally generates what the
 * proxy would reject (malformed chunks, multi-part refusals), fuzzing the
 * extension's leniency contract over a real socket. A random-cancellation
 * pass checks streams die promptly and silently when cancelled.
 *
 * Failures shrink to a minimal failing event list before reporting, and the
 * corpus in fuzzCorpus.ts replays past failures first. Reproduce any run
 * with `FUZZ_SEED=<seed> bun run test:docker` (the seed is always logged).
 */

const BASE_URL = process.env.LITELLM_DOCKER_BASE_URL || "";
const API_KEY = process.env.LITELLM_DOCKER_API_KEY || "sk-test-1234";
const FAKE_URL = process.env.LITELLM_DOCKER_FAKE_URL || "";
// Explicit seeds reproduce exactly, including 0; anything unset or invalid
// draws a fresh seed, shard-salted so parallel CI shards diverge even when
// they start in the same instant (see src/test/fuzzSeed.ts).
const SEED = resolveDockerFuzzSeed(fuzzShardSalt());
const ITERATIONS = Math.max(1, Math.floor(Number(process.env.FUZZ_ITERATIONS)) || 10);
const MAX_SHRINK_RUNS = 32;

// ── Suite plumbing ────────────────────────────────────────────────────────────

async function registerScenario(name: string, config: Record<string, unknown>): Promise<void> {
	const registered = await fetch(`${FAKE_URL}/_test/custom-scenario`, {
		method: "PUT",
		body: JSON.stringify({ name, config }),
	});
	assert.ok(registered.ok, `custom-scenario registration failed (${name}): ${registered.status}`);
}

/** Run one assembled stream and assert the exact expected outcome. */
async function runStream(model: vscode.LanguageModelChat, name: string, events: FuzzEvent[]): Promise<void> {
	const assembled = assemble(events);
	await registerScenario(name, { type: "sse", chunks: assembled.chunks });
	const response = await model.sendRequest(
		[vscode.LanguageModelChatMessage.User(`${COMMAND_SIGIL}play:${name}`)],
		{},
		new vscode.CancellationTokenSource().token
	);
	const parts = await collectStream(response);

	const text = extractText(parts);
	assert.strictEqual(text, assembled.expectedText, "text diverged");

	const calls = extractToolCalls(parts);
	assert.strictEqual(calls.length, assembled.expectedToolCalls.length, "tool call count diverged");
	const actualSorted = calls
		.map((c) => ({ name: c.name, args: c.input as Record<string, unknown> }))
		.sort((a, b) => Number(a.args.seq) - Number(b.args.seq));
	assert.deepStrictEqual(actualSorted, assembled.expectedToolCalls, "tool calls diverged");
	const ids = calls.map((c) => c.callId);
	assert.strictEqual(new Set(ids).size, ids.length, `duplicate tool call IDs: ${ids.join(", ")}`);
}

/**
 * Shrink a failing event list to a minimal one that still fails: try removing
 * spans, halving the span size down to single events, bounded by
 * MAX_SHRINK_RUNS extra runs. A transient infrastructure failure during a
 * candidate run counts as a reproduction, so the bound also limits how far a
 * flake can distort the minimized output.
 */
async function shrinkFailure(
	model: vscode.LanguageModelChat,
	namePrefix: string,
	events: FuzzEvent[]
): Promise<FuzzEvent[]> {
	let current = events;
	let budget = MAX_SHRINK_RUNS;
	let step = Math.max(1, Math.floor(current.length / 2));
	while (budget > 0) {
		let shrunk = false;
		for (let start = 0; start < current.length && budget > 0; start += step) {
			const candidate = [...current.slice(0, start), ...current.slice(start + step)];
			if (candidate.length === 0) {
				continue;
			}
			budget--;
			try {
				await runStream(model, `${namePrefix}-shrink-${budget}`, candidate);
			} catch {
				current = candidate;
				shrunk = true;
				break;
			}
		}
		if (shrunk) {
			step = Math.min(step, Math.max(1, Math.floor(current.length / 2)));
		} else if (step > 1) {
			step = Math.max(1, Math.floor(step / 2));
		} else {
			break;
		}
	}
	return current;
}

async function fuzzIteration(
	model: vscode.LanguageModelChat,
	name: string,
	events: FuzzEvent[],
	label: string,
	mode: "proxy" | "direct"
): Promise<void> {
	try {
		await runStream(model, name, events);
	} catch (error) {
		const minimal = await shrinkFailure(model, name, events);
		const entry = { name: `<issue-ref>`, mode, events: minimal };
		const serialized = JSON.stringify(entry, null, 1);
		const detail =
			serialized.length > 12000
				? `${serialized.slice(0, 12000)}\n... (truncated; full repro via the seed)`
				: serialized;
		throw new Error(`${label}: ${String(error)}\nMinimal failing corpus entry (add to fuzzCorpus.ts):\n${detail}`, {
			cause: error,
		});
	}
}

function fuzzSuite(title: string, directMode: boolean, serverUrl: string, serverKey: string): void {
	suite(title, () => {
		let fuzzModel: vscode.LanguageModelChat;

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
			fuzzModel = expectDefined(models.find((m) => m.id === wantedId));
		});

		test("replays the regression corpus", async function () {
			this.timeout(Math.max(60000, FUZZ_CORPUS.length * 5000));
			const mode = directMode ? "direct" : "proxy";
			for (const entry of FUZZ_CORPUS) {
				if (entry.mode !== "both" && entry.mode !== mode) {
					continue;
				}
				await fuzzIteration(fuzzModel, `corpus-${entry.name}`, entry.events, `corpus entry "${entry.name}"`, mode);
			}
		});

		test(`fuzzes ${ITERATIONS} generated streams (seed ${SEED})`, async function () {
			this.timeout(Math.max(120000, ITERATIONS * 10000));
			const mode = directMode ? "direct" : "proxy";
			logFuzzSeed(SEED, ITERATIONS, mode);
			const random = mulberry32(directMode ? SEED ^ 0x5f375a86 : SEED);

			for (let iteration = 0; iteration < ITERATIONS; iteration++) {
				const events = generateEvents(random, directMode);
				await fuzzIteration(
					fuzzModel,
					`fuzz-${SEED}-${iteration}`,
					events,
					`seed=${SEED} iteration=${iteration} mode=${mode}`,
					mode
				);
			}
		});

		test("cancellation mid-stream stops promptly and emits nothing afterward", async function () {
			this.timeout(60000);
			const random = mulberry32(SEED ^ 0x9e3779b9);
			const texts = Array.from({ length: 30 }, (_, i) => `slow${i} `);
			const name = `fuzz-cancel-${SEED}`;
			await registerScenario(name, {
				type: "sse-delayed",
				delayMs: 40,
				chunks: [
					chunkOf({ role: "assistant" }),
					...texts.map((text) => chunkOf({ content: text })),
					chunkOf({}, "stop"),
				],
			});

			const cancelAfter = 1 + Math.floor(random() * 5);
			const source = new vscode.CancellationTokenSource();
			const request = await fuzzModel.sendRequest(
				[vscode.LanguageModelChatMessage.User(`${COMMAND_SIGIL}play:${name}`)],
				{},
				source.token
			);
			const parts: unknown[] = [];
			const startedWaiting = Date.now();
			let partsWhenCancelled = 0;
			try {
				for await (const part of request.stream) {
					parts.push(part);
					if (parts.length === cancelAfter) {
						partsWhenCancelled = parts.length;
						source.cancel();
					}
				}
			} catch (e) {
				assert.ok(
					e instanceof vscode.CancellationError || /cancel/i.test(String(e)),
					`expected a cancellation error, got ${String(e)}`
				);
			}
			const elapsed = Date.now() - startedWaiting;
			assert.ok(parts.length < texts.length / 2, `stream must stop early: got ${parts.length} of ${texts.length}`);
			// A couple of parts may already be in flight when the cancel lands;
			// a stream that keeps delivering beyond that ignored it.
			assert.ok(
				parts.length - partsWhenCancelled <= 3,
				`stream kept emitting after cancel: ${parts.length - partsWhenCancelled} extra parts`
			);
			assert.ok(elapsed < 20000, `stream must terminate promptly after cancel, took ${elapsed}ms`);
		});
	});
}

if (!BASE_URL) {
	suite("Docker LiteLLM stream fuzzer", () => {
		test("SKIPPED: LITELLM_DOCKER_BASE_URL not set; run via `bun run test:docker`", () => {});
	});
} else {
	// Through the proxy: LiteLLM re-serializes everything, so only shapes it
	// forwards faithfully are generated.
	fuzzSuite("Docker LiteLLM stream fuzzer (proxy)", false, BASE_URL, API_KEY);
	// Directly against the fake backend (the extension treats it as a LiteLLM
	// server via the /v1/models discovery fallback): adds the shapes the proxy
	// rejects, fuzzing the extension's leniency contract over a real socket.
	fuzzSuite("Docker LiteLLM stream fuzzer (direct)", true, FAKE_URL, "fake-key");
}
