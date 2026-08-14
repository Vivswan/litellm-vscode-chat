import * as assert from "node:assert";
import * as vscode from "vscode";
import { DEFAULT_REASONING_EFFORT_LEVELS, reasoningEffortSchema } from "../provider/catalog/modelConfiguration";
import { CMD } from "../shared/config/commandIds";
import { CONFIG_SECTION } from "../shared/config/settingSpec";
import {
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	SERVERS_SETTING_KEY,
} from "../shared/config/settings";
import { catalogFixtureJson } from "./catalogFixture";
import { STACK_DEFAULTS } from "./envFile";
import { COMMAND_SIGIL } from "./fakeStack/commands";
import { PLAYBACK_MODEL } from "./fakeStack/models";
import { NO_DISCOVERY_PREFIX } from "./fakeStack/noDiscovery";
import {
	assertIdsUnserved,
	refreshEntryModels,
	removeServerEntry,
	uniqueName,
	writeServerEntry,
} from "./groupApiHelpers";
import {
	blockCatalogNetwork,
	catalogOff,
	collectStream,
	ensureActivated,
	extractText,
	OPENROUTER_CATALOG_SETTING_ID,
	waitForHostModels,
} from "./hostApiHelpers";
import { expectDefined } from "./pureHelpers";

/** The menu the built-in default level list produces; fixtures here carry no per-level server flags. */
const REASONING_EFFORT_SCHEMA = reasoningEffortSchema(DEFAULT_REASONING_EFFORT_LEVELS);

/**
 * Docker resolution suite: catalog-ON capability backfill and the parameter
 * record directives, pinned end to end on a real host.
 *
 * Two deliberately separate worlds, one label:
 *
 * 1. The OpenRouter catalog path. Every other docker host runs catalog-OFF
 *    for hermeticity (hostApiHelpers.catalogOff, called in every docker
 *    suiteSetup), so the catalog-ON behavior documented in
 *    docs/models.md#the-openrouter-catalog gets its
 *    deterministic coverage HERE: the suite seeds the pinned fixture
 *    (src/test/fixtures/openrouter-models.json) into the catalog store's
 *    globalStorage cache file through the non-production seam
 *    (litellm._test.seedOpenRouterCatalog reloads the store through its real
 *    cache-read path), opts this host in, and pins implicit exact-ID
 *    backfill, unambiguous post-vendor suffix backfill, ambiguity skipping
 *    the level, an explicit `_openrouter_model` directive beating the
 *    implicit match, and the min(4096, ...) wire clamp on catalog-derived
 *    output limits. The hermetic state (catalog off, cache file absent) is
 *    restored afterwards. The fake-stack canary
 *    (src/test/fakeStack/models.test.ts) guarantees no fake-stack model can
 *    collide with this fixture, so the suite's declared IDs are the only
 *    models the seeded catalog can touch.
 *
 * 2. The models.parameters record directives on the wire, catalog-OFF:
 *    `_force` beating runtime options (including an uncapped forced
 *    max_tokens), `_inheritable` fields reaching a more specific record,
 *    an `_inherit_from: false` barrier keeping broader fields out, and an
 *    entry record beating the global record - all configured through the
 *    real settings API and observed on the request LiteLLM forwarded
 *    (docs/models.md#which-record-applies, #forcing-parameters-_force).
 *
 * Run via `bun run test:docker` (label docker-resolution).
 */

const BASE_URL = (process.env.LITELLM_DOCKER_BASE_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.LITELLM_DOCKER_API_KEY || STACK_DEFAULTS.LITELLM_MASTER_KEY;
const FAKE_URL = (process.env.LITELLM_DOCKER_FAKE_URL || "").replace(/\/+$/, "");
const NO_DISCOVERY_URL = `${FAKE_URL}${NO_DISCOVERY_PREFIX}`;

/** The catalog suite's declared entry; the declared IDs below are its whole serve. */
const CATALOG_LABEL = uniqueName("ResolutionSuite Catalog");
/** Exact catalog-ID match: the fixture's anthropic/claude-sonnet-4.5 entry. */
const EXACT_ID = "anthropic/claude-sonnet-4.5";
/** Unambiguous post-vendor suffix: only openai/gpt-4o-mini carries it. */
const SUFFIX_ID = "gpt-4o-mini";
/** Ambiguous suffix: meta-llama/ and fireworks/ both serve llama-3-8b-instruct. */
const AMBIGUOUS_ID = "llama-3-8b-instruct";
/** Implicitly matches mistralai/mistral-tiny; the explicit directive points it at openai/gpt-4o-mini instead. */
const DIRECTIVE_ID = "mistral-tiny";
const DECLARED_IDS = [EXACT_ID, SUFFIX_ID, AMBIGUOUS_ID, DIRECTIVE_ID];

/** The built-in floors (128000 context, 16000 max output): input derives as the difference. */
const FLOOR_MAX_INPUT = 112000;
/** openai/gpt-4o-mini in the fixture: 128000 context, 16384 max completion. */
const GPT4O_MINI_MAX_INPUT = 128000 - 16384;
/** anthropic/claude-sonnet-4.5 in the fixture: 1000000 context, 64000 max completion. */
const CLAUDE_MAX_INPUT = 1000000 - 64000;

/** The directive suite's declared entry; its per-entry record is the entry-beats-global oracle. */
const ENTRY_LABEL = uniqueName("ResolutionSuite Entry");
const ALIAS = PLAYBACK_MODEL.alias;

type ServersSettingEntry = Record<string, unknown>;

suite("Docker resolution", () => {
	if (!BASE_URL || !FAKE_URL) {
		test("SKIPPED: LITELLM_DOCKER_BASE_URL/FAKE_URL not set; run via `bun run test:docker`", () => {});
		return;
	}

	const config = () => vscode.workspace.getConfiguration(CONFIG_SECTION);

	async function updateGlobal(key: string, value: unknown): Promise<void> {
		await config().update(key, value, vscode.ConfigurationTarget.Global);
	}

	async function chat(
		model: vscode.LanguageModelChat,
		text: string,
		options: vscode.LanguageModelChatRequestOptions = {}
	): Promise<string> {
		const response = await model.sendRequest(
			[vscode.LanguageModelChatMessage.User(text)],
			options,
			new vscode.CancellationTokenSource().token
		);
		return extractText(await collectStream(response));
	}

	async function hostModel(id: string): Promise<vscode.LanguageModelChat> {
		const models = await waitForHostModels(
			60000,
			(candidates) => candidates.some((candidate) => candidate.id === id),
			`the host to expose ${id}`
		);
		return expectDefined(models.find((candidate) => candidate.id === id));
	}

	async function refreshInfos(): Promise<Map<string, vscode.LanguageModelChatInformation>> {
		const infos = await refreshEntryModels(CATALOG_LABEL);
		return new Map(infos.map((info) => [info.id, info]));
	}

	function infoFor(
		infos: Map<string, vscode.LanguageModelChatInformation>,
		id: string
	): vscode.LanguageModelChatInformation {
		return expectDefined(infos.get(id), `${id} in refreshEntryModels`);
	}

	/** The wire max_tokens the %params report carries. */
	function reportedMaxTokens(reply: string): number {
		const match = /max_tokens: `(\d+)`/.exec(reply);
		return Number(expectDefined(match?.[1], `max_tokens in "${reply}"`));
	}

	/** The chat body LiteLLM (or a direct fake-backend route) last received. */
	async function lastForwardedRequest(): Promise<Record<string, unknown>> {
		const response = await fetch(`${FAKE_URL}/_test/last-request`);
		assert.ok(response.ok, `GET /_test/last-request failed: ${response.status}`);
		return (await response.json()) as Record<string, unknown>;
	}

	let originalServersSetting: unknown;
	// Torn down even when suiteSetup throws (Mocha runs suiteTeardown anyway);
	// the optional-chained dispose keeps that path from burying the original
	// failure.
	let catalogNetworkGuard: vscode.Disposable | undefined;

	suiteSetup(async function () {
		this.timeout(90000);
		await ensureActivated();
		await catalogOff();
		// Enabling the catalog below arms the store's periodic refresh, and a
		// live response replacing the seeded fixture mid-suite would be
		// invisible flakiness.
		catalogNetworkGuard = blockCatalogNetwork();
		// The suites below attribute chats and registrations to their own
		// entries by fixed model ids; a leftover group serving any of them
		// would be indistinguishable, so fail fast.
		await assertIdsUnserved([...DECLARED_IDS, ALIAS, "deepseek-r2", "llama-4-scout", "claude-opus-4-5", "gpt-5.2"]);
		originalServersSetting = config().inspect(SERVERS_SETTING_KEY)?.globalValue;
		await updateGlobal(SERVERS_SETTING_KEY, []);
	});

	suiteTeardown(async function () {
		this.timeout(60000);
		// Catalog off BEFORE the network guard lifts: an in-flight refresh
		// re-checks the setting ahead of every retry, so no attempt can escape
		// through the restored real fetch.
		await updateGlobal(OPENROUTER_CATALOG_SETTING_ID, false);
		catalogNetworkGuard?.dispose();
		await updateGlobal(SERVERS_SETTING_KEY, originalServersSetting);
		await updateGlobal(MODEL_PARAMETERS_SETTING_KEY, undefined);
		await updateGlobal(MODEL_CAPABILITIES_SETTING_KEY, undefined);
		// Force the removal reconciliation now: the debounced pass may not run
		// before host shutdown, and only a completed pass persists the
		// tombstones that keep this run's groups dark in a recycled directory.
		await vscode.commands.executeCommand(CMD.syncModels);
	});

	// ── World 1: the OpenRouter catalog path, fixture-seeded, catalog ON ──────

	suite("catalog backfill (seeded fixture, sequential)", () => {
		suiteSetup(async function () {
			this.timeout(120000);
			const fixture = catalogFixtureJson();
			const installed = (await vscode.commands.executeCommand(
				"litellm._test.seedOpenRouterCatalog",
				fixture
			)) as number;
			assert.strictEqual(installed, 6, "the pinned fixture parses to its six usable entries");
			// The directive target for DIRECTIVE_ID; every other declared ID is
			// deliberately record-free so only the catalog can describe it.
			await updateGlobal(MODEL_CAPABILITIES_SETTING_KEY, {
				[DIRECTIVE_ID]: { _openrouter_model: "openai/gpt-4o-mini" },
			});
			// A real declared entry on the no-discovery mirror: discovery fails
			// there (expectedly, so the non-silent refresh below serves the
			// declared set instead of throwing), and the declared IDs are the
			// entry's whole serve.
			await writeServerEntry(
				{
					label: CATALOG_LABEL,
					baseUrl: NO_DISCOVERY_URL,
					auth: { apiKey: "resolution-catalog-key" },
					discovery: { declared: [...DECLARED_IDS], expectedFailures: ["modelListing", "modelInfo"] },
				},
				60000
			);
			const modelIds = (await refreshEntryModels(CATALOG_LABEL)).map((info) => info.id);
			assert.deepStrictEqual(
				[...modelIds].sort(),
				[...DECLARED_IDS].sort(),
				"discovery fails on this entry, so the declared IDs are the whole serve"
			);
		});

		suiteTeardown(async function () {
			this.timeout(60000);
			// Restore the hermetic state: catalog off and the seeded cache file
			// deleted (a checkout carrying dist/openrouter-models.json falls back
			// to that bundled artifact, which the opt-out keeps out of implicit
			// matching anyway), records cleared, the entry removed (its group is
			// tombstoned; the host cannot remove it).
			await updateGlobal(OPENROUTER_CATALOG_SETTING_ID, false);
			await vscode.commands.executeCommand("litellm._test.seedOpenRouterCatalog", undefined);
			await updateGlobal(MODEL_CAPABILITIES_SETTING_KEY, undefined);
			await removeServerEntry(CATALOG_LABEL);
		});

		test("catalog off: implicit backfill stays dead while the explicit directive serves offline", async function () {
			this.timeout(60000);
			// The suiteSetup's catalogOff turned the catalog off; the fixture is
			// already seeded. Implicit matches (exact and suffix) must resolve to
			// the built-in floors, while the `_openrouter_model` directive keeps
			// answering byExactId - stated user intent needs no opt-in.
			const infos = await refreshInfos();
			for (const id of [EXACT_ID, SUFFIX_ID, AMBIGUOUS_ID]) {
				assert.strictEqual(infoFor(infos, id).maxInputTokens, FLOOR_MAX_INPUT, `${id} must sit on the floors`);
				assert.strictEqual(infoFor(infos, id).maxOutputTokens, 16000, `${id} must sit on the floor output limit`);
			}
			const directive = infoFor(infos, DIRECTIVE_ID);
			assert.strictEqual(
				directive.maxInputTokens,
				GPT4O_MINI_MAX_INPUT,
				"the directive backfills with the catalog off"
			);
			assert.strictEqual(directive.maxOutputTokens, 16384);
		});

		test("catalog on: an exact catalog-ID match backfills every gap", async function () {
			this.timeout(60000);
			await updateGlobal(OPENROUTER_CATALOG_SETTING_ID, true);
			const info = infoFor(await refreshInfos(), EXACT_ID);
			assert.strictEqual(info.maxInputTokens, CLAUDE_MAX_INPUT, "context minus output, both from the catalog entry");
			assert.strictEqual(info.maxOutputTokens, 64000);
			assert.strictEqual(info.capabilities?.imageInput, true, "the entry's image modality registers as imageInput");
			assert.deepStrictEqual(
				info.configurationSchema,
				REASONING_EFFORT_SCHEMA,
				"the entry's reasoning parameter surfaces the picker control"
			);
		});

		test("an unambiguous post-vendor suffix backfills like an exact match", async () => {
			const info = infoFor(await refreshInfos(), SUFFIX_ID);
			assert.strictEqual(info.maxInputTokens, GPT4O_MINI_MAX_INPUT);
			assert.strictEqual(info.maxOutputTokens, 16384);
			assert.strictEqual(info.capabilities?.imageInput, true);
			assert.ok(
				!("configurationSchema" in info),
				"gpt-4o-mini's catalog entry declares no reasoning, so no picker control may grow"
			);
		});

		test("an ambiguous suffix skips the catalog level entirely", async () => {
			// Two vendors serve llama-3-8b-instruct; guessing either would be
			// observable (meta-llama: 8192 context and no tools; fireworks:
			// 16384 context). The level is skipped, so the floors win.
			const info = infoFor(await refreshInfos(), AMBIGUOUS_ID);
			assert.strictEqual(info.maxInputTokens, FLOOR_MAX_INPUT, "neither vendor's entry may be guessed");
			assert.strictEqual(info.maxOutputTokens, 16000);
			assert.strictEqual(info.capabilities?.imageInput ?? false, false);
		});

		test("an explicit _openrouter_model directive beats the implicit match", async () => {
			// mistral-tiny implicitly matches mistralai/mistral-tiny (32000
			// context, no completion limit, no modalities); the directive names
			// openai/gpt-4o-mini and must win wholesale over that match.
			const info = infoFor(await refreshInfos(), DIRECTIVE_ID);
			assert.strictEqual(info.maxInputTokens, GPT4O_MINI_MAX_INPUT, "the directive's entry, not the implicit match");
			assert.strictEqual(info.maxOutputTokens, 16384);
			assert.strictEqual(info.capabilities?.imageInput, true, "vision comes from the directive's entry too");
		});

		test("catalog-derived output limits stay clamped at min(4096, ...) on the wire", async function () {
			this.timeout(120000);
			// Registration carries the catalog numbers (64000 and 16384 above),
			// but both catalog paths - implicit match and explicit directive -
			// count as guesses: the wire max_tokens stays at the 4096 clamp.
			for (const id of [EXACT_ID, SUFFIX_ID, DIRECTIVE_ID]) {
				const reply = await chat(await hostModel(id), `${COMMAND_SIGIL}params`);
				assert.strictEqual(reportedMaxTokens(reply), 4096, `${id} must carry the clamped guess, got: ${reply}`);
			}
			// The contrast arm: a max_output_tokens the USER writes on the same
			// catalog-backed model counts as declared and lifts the clamp, so an
			// implementation that always emits 4096 fails here.
			await updateGlobal(MODEL_CAPABILITIES_SETTING_KEY, {
				[DIRECTIVE_ID]: { _openrouter_model: "openai/gpt-4o-mini" },
				[SUFFIX_ID]: { max_output_tokens: 9000 },
			});
			const lifted = await chat(await hostModel(SUFFIX_ID), `${COMMAND_SIGIL}params`);
			assert.strictEqual(reportedMaxTokens(lifted), 9000, "a user-written output limit must go out unclamped");
		});
	});

	// ── World 2: parameter record directives on the wire, catalog OFF ─────────

	suite("parameter record directives on the wire", () => {
		suiteSetup(async function () {
			this.timeout(120000);
			// One declared entry against the real proxy; its per-entry record is
			// the entry-beats-global oracle. Everything else in this suite rides
			// the global models.parameters record, rewritten per test.
			const entry: ServersSettingEntry = {
				label: ENTRY_LABEL,
				baseUrl: BASE_URL,
				auth: { apiKey: API_KEY },
				models: { parameters: { [ALIAS]: { frequency_penalty: 0.9 } } },
			};
			await updateGlobal(SERVERS_SETTING_KEY, [entry]);
			await vscode.commands.executeCommand(CMD.syncModels);
			await waitForHostModels(
				60000,
				(candidates) => candidates.some((candidate) => candidate.id === ALIAS),
				`the entry's group to expose ${ALIAS}`
			);
		});

		teardown(async () => {
			await updateGlobal(MODEL_PARAMETERS_SETTING_KEY, undefined);
		});

		test("a _force'd parameter beats a runtime option", async function () {
			this.timeout(60000);
			await updateGlobal(MODEL_PARAMETERS_SETTING_KEY, { "deepseek-r2": { temperature: 0.25, _force: true } });
			const model = await hostModel("deepseek-r2");
			await chat(model, `${COMMAND_SIGIL}params`, { modelOptions: { temperature: 0.9 } });
			assert.strictEqual(
				(await lastForwardedRequest()).temperature,
				0.25,
				"the forced value must beat the runtime option"
			);

			// The control arm: without _force the same runtime option wins, so
			// the assertion above cannot pass by the record merely applying.
			await updateGlobal(MODEL_PARAMETERS_SETTING_KEY, { "deepseek-r2": { temperature: 0.25 } });
			await chat(model, `${COMMAND_SIGIL}params`, { modelOptions: { temperature: 0.9 } });
			assert.strictEqual((await lastForwardedRequest()).temperature, 0.9, "an unforced record must lose to runtime");
		});

		test("a forced max_tokens beats runtime options and is never clamped", async function () {
			this.timeout(60000);
			// llama-4-scout declares no limits, so an unconfigured request would
			// carry the min(4096, guess) cap - 50000 can only reach the wire as
			// a user-set, forced, uncapped value.
			await updateGlobal(MODEL_PARAMETERS_SETTING_KEY, {
				"llama-4-scout": { max_tokens: 50000, _force: ["max_tokens"] },
			});
			const model = await hostModel("llama-4-scout");
			await chat(model, `${COMMAND_SIGIL}params`, { modelOptions: { max_tokens: 123 } });
			assert.strictEqual((await lastForwardedRequest()).max_tokens, 50000, "forced max_tokens: uncapped, over runtime");

			// The control arm keeps the SAME record minus _force: runtime must
			// win again, so the assertion above can only pass through the
			// directive, never through configured max_tokens outranking runtime.
			await updateGlobal(MODEL_PARAMETERS_SETTING_KEY, { "llama-4-scout": { max_tokens: 50000 } });
			await chat(model, `${COMMAND_SIGIL}params`, { modelOptions: { max_tokens: 123 } });
			assert.strictEqual((await lastForwardedRequest()).max_tokens, 123, "without _force, runtime wins as-is");
		});

		test("an _inheritable catch-all field reaches a specific record's request", async function () {
			this.timeout(60000);
			await updateGlobal(MODEL_PARAMETERS_SETTING_KEY, {
				"*": { top_p: 0.77, _inheritable: true },
				"claude-opus-4-5": { temperature: 0.5 },
			});
			const model = await hostModel("claude-opus-4-5");
			const reply = await chat(model, `${COMMAND_SIGIL}params`);
			const wire = await lastForwardedRequest();
			assert.strictEqual(wire.temperature, 0.5, "the specific record's own field");
			assert.strictEqual(wire.top_p, 0.77, "the catch-all's inheritable field must ride along");
			assert.match(reply, /top_p: `0\.77`/, "%params must report the inherited field");
		});

		test("an _inherit_from: false barrier keeps broader fields out of the request", async function () {
			this.timeout(60000);
			// gpt-5.2-mini's own record is silent, so it inherits what reaches
			// it: gpt-5*'s inheritable temperature crosses, the catch-all's
			// top_p dies at the barrier. top_p on purpose: the inheritance test
			// above proves that exact field DOES traverse the proxy when a
			// barrier is absent, so these negatives cannot pass by the proxy
			// dropping the field.
			await updateGlobal(MODEL_PARAMETERS_SETTING_KEY, {
				"*": { top_p: 0.77, _inheritable: true },
				"gpt-5*": { temperature: 0.2, _inheritable: true, _inherit_from: false },
				[ALIAS]: { seed: 777 },
			});
			const model = await hostModel(ALIAS);
			await chat(model, `${COMMAND_SIGIL}params`);
			const wire = await lastForwardedRequest();
			assert.strictEqual(wire.seed, 777, "the model's own record applies");
			assert.strictEqual(wire.temperature, 0.2, "the barrier record's inheritable field crosses");
			assert.strictEqual(wire.top_p, undefined, "the catch-all's field must die at the barrier");

			// The wholesale side of the same shape: a model whose best match IS
			// the barrier record gets exactly that record.
			const sibling = await hostModel("gpt-5.2");
			await chat(sibling, `${COMMAND_SIGIL}params`);
			const siblingWire = await lastForwardedRequest();
			assert.strictEqual(siblingWire.temperature, 0.2);
			assert.strictEqual(siblingWire.top_p, undefined, "nothing broader flows past the barrier");

			// And the positive control in the same configuration: a model the
			// barrier does not match takes the catch-all wholesale, so the
			// field provably still reaches the wire under this very record set.
			const outsider = await hostModel("claude-opus-4-5");
			await chat(outsider, `${COMMAND_SIGIL}params`);
			assert.strictEqual(
				(await lastForwardedRequest()).top_p,
				0.77,
				"a model outside the barrier's match set still gets the catch-all"
			);
		});

		test("an entry-record field beats the global record on the wire", async function () {
			this.timeout(60000);
			await updateGlobal(MODEL_PARAMETERS_SETTING_KEY, { [ALIAS]: { frequency_penalty: 0.1, seed: 42 } });
			const model = await hostModel(ALIAS);
			const reply = await chat(model, `${COMMAND_SIGIL}params`);
			const wire = await lastForwardedRequest();
			assert.strictEqual(wire.frequency_penalty, 0.9, "the entry record's field must beat the global record's");
			assert.strictEqual(wire.seed, 42, "global fields the entry leaves unset still apply");
			assert.match(reply, /frequency_penalty: `0\.9`/);
		});
	});
});
