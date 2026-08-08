import * as assert from "node:assert";
import * as vscode from "vscode";
import { CONFIG_SECTION } from "../shared/config/settingSpec";
import { SERVERS_SETTING_KEY } from "../shared/config/settings";
import { STACK_DEFAULTS } from "./envFile";
import { logFuzzSeed, resolveDockerFuzzSeed } from "./fuzzSeed";
import { mulberry32 } from "./fuzzStream";
import { ensureActivated } from "./hostApiHelpers";
import { MONKEY_CORPUS } from "./monkeyCorpus";
import type { MonkeyAction } from "./monkeyFuzz";
import { generateWalk, MAX_SHRINK_RUNS, MonkeySession, monkeyFailureReport, shrinkMonkeyFailure } from "./monkeyFuzz";

/**
 * Interaction (monkey) fuzzer for the docker LiteLLM stack: random walks
 * over the extension's whole management surface - the declarative servers
 * setting, SecretStorage, dashboard intents (valid and junk), settings
 * writes, chats, and cancellations - with a cross-cutting oracle checked
 * after every step and a probe bundle every few steps (responsiveness,
 * model-list floors, declared-view and settings agreement, secret hygiene,
 * storage-key hygiene). The alphabet, oracle, and executor live in
 * monkeyFuzz.ts.
 *
 * The suite runs LAST in the docker orchestrator and in its own fresh
 * extension host: provider groups are add-only for the host lifetime, so
 * walks deliberately dirty host state that no later suite should inherit.
 * Pre-existing groups are tolerated via a baseline snapshot. Reproduce any
 * run with `FUZZ_SEED=<seed> bun run test:docker` (the seed is always
 * logged); failing walks shrink to a minimal action trace to pin in
 * monkeyCorpus.ts.
 */

const BASE_URL = process.env.LITELLM_DOCKER_BASE_URL || "";
const API_KEY = process.env.LITELLM_DOCKER_API_KEY || STACK_DEFAULTS.LITELLM_MASTER_KEY;
const FAKE_URL = process.env.LITELLM_DOCKER_FAKE_URL || "";

// An explicit FUZZ_SEED reproduces exactly; otherwise a fresh pid- and
// time-mixed seed is drawn (see src/test/fuzzSeed.ts).
const SEED = resolveDockerFuzzSeed();
const WALKS = Math.max(1, Math.floor(Number(process.env.MONKEY_ITERATIONS)) || 5);
const MIN_STEPS = 12;
const MAX_STEPS = 20;
/** Generous per-walk budget: declares wait on host model propagation and every step can sync. */
const WALK_BUDGET_MS = 300000;

suite("Docker LiteLLM monkey fuzzer", () => {
	if (!BASE_URL || !FAKE_URL) {
		test("SKIPPED: LITELLM_DOCKER_BASE_URL/FAKE_URL not set; run via `bun run test:docker`", () => {});
		return;
	}

	let session: MonkeySession;
	let originalServersSetting: unknown;

	suiteSetup(async function () {
		this.timeout(120000);
		await ensureActivated();
		originalServersSetting = vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.inspect(SERVERS_SETTING_KEY)?.globalValue;
		session = new MonkeySession({ baseUrl: BASE_URL, fakeUrl: FAKE_URL, apiKey: API_KEY, seed: SEED });
		await session.setup();
	});

	suiteTeardown(async function () {
		this.timeout(30000);
		await vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.update(SERVERS_SETTING_KEY, originalServersSetting, vscode.ConfigurationTarget.Global);
	});

	async function runReported(tag: string, label: string, actions: MonkeyAction[]): Promise<void> {
		try {
			await session.runActions(tag, actions);
		} catch (error) {
			const minimal = await shrinkMonkeyFailure(session, tag, actions);
			throw monkeyFailureReport(label, error, minimal);
		}
	}

	test("replays the regression corpus", async function () {
		// Shrink time is budgeted like the walks test: a regressing corpus
		// entry must emit its minimal trace, not die at the mocha timeout.
		this.timeout(Math.max(60000, (MONKEY_CORPUS.length + MAX_SHRINK_RUNS) * WALK_BUDGET_MS));
		for (const entry of MONKEY_CORPUS) {
			await runReported(`corpus-${entry.name}`, `corpus entry "${entry.name}"`, entry.actions);
		}
	});

	test(`runs ${WALKS} monkey walks (seed ${SEED})`, async function () {
		this.timeout(Math.max(WALK_BUDGET_MS, WALKS * WALK_BUDGET_MS + MAX_SHRINK_RUNS * WALK_BUDGET_MS));
		// Nightly's failure handler greps this exact format for the repro command.
		logFuzzSeed(SEED, WALKS, "monkey");
		const random = mulberry32(SEED ^ 0x6d6f6e6b);

		for (let walk = 0; walk < WALKS; walk++) {
			const steps = MIN_STEPS + Math.floor(random() * (MAX_STEPS - MIN_STEPS + 1));
			const actions = generateWalk(random, steps);
			await runReported(`w${walk}`, `seed=${SEED} walk=${walk} mode=monkey`, actions);
		}
	});

	test("the walk generator is deterministic for a fixed seed", () => {
		// The cheap in-process half of the determinism contract: identical seeds
		// must yield identical action traces, or FUZZ_SEED replays lie.
		const first = generateWalk(mulberry32(SEED ^ 0x6d6f6e6b), 20);
		const second = generateWalk(mulberry32(SEED ^ 0x6d6f6e6b), 20);
		assert.deepStrictEqual(first, second);
	});
});
