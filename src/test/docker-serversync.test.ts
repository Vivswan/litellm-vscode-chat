import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DeclaredServerView } from "../extension/servers/serverSync";
import { GROUP_UPDATE_UNAVAILABLE_MESSAGE } from "../extension/servers/serverSync";
import { CMD, VENDOR_ID } from "../shared/config/commandIds";
import { CONFIG_SECTION } from "../shared/config/settingSpec";
import { MODEL_CAPABILITIES_SETTING_KEY, SERVERS_SETTING_KEY } from "../shared/config/settings";
import type { SecretFieldId } from "../shared/serverEntry";
import type { ServerStatus } from "../shared/servers";
import { STACK_DEFAULTS } from "./envFile";
import { COMMAND_SIGIL } from "./fakeStack/commands";
import { PLAYBACK_MODEL } from "./fakeStack/models";
import { NO_DISCOVERY_PREFIX, type NoDiscoveryAttemptCounts } from "./fakeStack/noDiscovery";
import { FAKE_OAUTH_CLIENT_ID, FAKE_OAUTH_CLIENT_SECRET, FAKE_OAUTH_TOKEN_PREFIX } from "./fakeStack/oauth";
import { catalogOff, collectStream, ensureActivated, extractText, waitForHostModels } from "./hostApiHelpers";
import { expectDefined } from "./pureHelpers";

/**
 * Pins the declarative chain end to end: the servers setting -> serverSync -> lm.addLanguageModelsProviderGroup
 * -> discovery -> chat against the docker LiteLLM proxy. Run via `bun run test:docker`.
 *
 * Provider groups are ADD-ONLY for the host lifetime, so this suite needs its own extension host label and a
 * unique label per scenario; the scenarios are sequential and each builds on the previous ones' groups.
 */

// Env-derived URLs can arrive slash-suffixed; stripping keeps the derived NO_DISCOVERY_URL and every base-URL
// comparison canonical.
const BASE_URL = (process.env.LITELLM_DOCKER_BASE_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.LITELLM_DOCKER_API_KEY || STACK_DEFAULTS.LITELLM_MASTER_KEY;
const FAKE_URL = (process.env.LITELLM_DOCKER_FAKE_URL || "").replace(/\/+$/, "");
/** The fake backend's discovery-less mirror: chat serves, the discovery GETs 404. */
const NO_DISCOVERY_URL = `${FAKE_URL}${NO_DISCOVERY_PREFIX}`;

/** Discovery through a proxy group registers the consolidated aliases; this one anchors "models appeared". */
const ALIAS = PLAYBACK_MODEL.alias;
/** Discovery against the fake backend directly registers upstream ids; this one anchors the OAuth group. */
const OAUTH_MODEL = "fake-mini";

const LABEL_INLINE = "SyncSuite Inline";
const LABEL_STORED = "SyncSuite Stored";
const LABEL_PRECEDENCE = "SyncSuite Precedence";
const LABEL_VIRTUAL = "SyncSuite Virtual";
const LABEL_OAUTH_BAD = "SyncSuite OAuth Bad";
const LABEL_OAUTH = "SyncSuite OAuth";
const LABEL_PARAMS_A = "SyncSuite Params A";
const LABEL_PARAMS_B = "SyncSuite Params B";
const LABEL_CAPS = "SyncSuite Caps";
const LABEL_EXPECTED = "SyncSuite Expected";
const LABEL_DECLARED_UNEXPECTED = "SyncSuite Declared Unexpected";

/**
 * Scenario 9's override target: llama-4-scout declares no token limits, so un-overridden copies carry the
 * min(4096, guess) cap. The realistic alias can match the OpenRouter catalog, so those copies are asserted
 * against the clamp bound rather than one exact guess.
 */
const CAPS_MODEL = "llama-4-scout";
/** Scenario 11's declared model; the ID is not in the fake catalog, only the declared list creates it. */
const UNEXPECTED_DECLARED_MODEL = "fake-declared";
/** Scenario 11's entry key: its bucket in the fake backend's discovery-attempt counters. */
const UNEXPECTED_DECLARED_KEY = "declared-unexpected-key";
/** Scenario 10's entry-declared model. */
const EXPECTED_DECLARED_MODEL = "fake-expected";
/** Scenario 10's entry key, unique so its discovery-attempt bucket counts only its own group. */
const EXPECTED_FAILURES_KEY = "expected-failures-key";

/** Scenario 3's dormant stored value; scenario 5d scans the log buffer for it. */
const GARBAGE_KEY = "sk-garbage-MARKER";
/** Scenario 5a's rejected client secret; scenario 5d scans the log buffer for it. */
const WRONG_OAUTH_SECRET = "not-the-secret";

type ServersSettingEntry = Record<string, unknown>;

interface OAuthStats {
	issued: number;
	rejected: number;
	live: number;
	authedChatRequests: number;
}

suite("Docker server sync", () => {
	if (!BASE_URL || !FAKE_URL) {
		test("SKIPPED: LITELLM_DOCKER_BASE_URL/FAKE_URL not set; run via `bun run test:docker`", () => {});
		return;
	}

	/** How many proxy-backed groups have completed a successful discovery so far. */
	let proxyGroups = 0;
	/** The OAuth group's model object, captured in 5b for the revocation scenario. */
	let oauthModel: vscode.LanguageModelChat | undefined;
	let originalServersSetting: unknown;
	let originalCapabilitiesSetting: unknown;

	function serversConfig(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(CONFIG_SECTION);
	}

	function readCapabilitiesSetting(): Record<string, Record<string, unknown>> {
		return { ...(serversConfig().get<Record<string, Record<string, unknown>>>(MODEL_CAPABILITIES_SETTING_KEY) ?? {}) };
	}

	async function writeCapabilitiesSetting(value: Record<string, Record<string, unknown>> | undefined): Promise<void> {
		await serversConfig().update(MODEL_CAPABILITIES_SETTING_KEY, value, vscode.ConfigurationTarget.Global);
	}

	function readServersSetting(): ServersSettingEntry[] {
		return (serversConfig().get<ServersSettingEntry[]>(SERVERS_SETTING_KEY) ?? []).map((entry) => ({ ...entry }));
	}

	async function writeServersSetting(entries: readonly ServersSettingEntry[]): Promise<void> {
		// Global on purpose: the setting is machine-scoped (user settings only).
		await serversConfig().update(SERVERS_SETTING_KEY, entries, vscode.ConfigurationTarget.Global);
	}

	/** Sync Models Now: a forced sync pass first, so the 400ms settings debounce never gates a scenario. */
	async function syncNow(): Promise<void> {
		await vscode.commands.executeCommand(CMD.syncModels);
	}

	/** Append one entry to the servers setting and force a sync pass. */
	async function declareServer(entry: ServersSettingEntry): Promise<void> {
		await writeServersSetting([...readServersSetting(), entry]);
		await syncNow();
	}

	async function getDeclared(): Promise<readonly DeclaredServerView[]> {
		return (await vscode.commands.executeCommand("litellm._test.getDeclaredServers")) as readonly DeclaredServerView[];
	}

	async function declaredFor(label: string): Promise<DeclaredServerView> {
		return expectDefined(
			(await getDeclared()).find((view) => view.label === label),
			`declared view for ${label}`
		);
	}

	function setStoredSecret(label: string, field: SecretFieldId, value: string | undefined): Thenable<unknown> {
		return vscode.commands.executeCommand("litellm._test.setServerSecret", label, field, value);
	}

	function countModels(models: readonly vscode.LanguageModelChat[], id: string): number {
		return models.filter((model) => model.id === id).length;
	}

	/**
	 * Each provider group registers its own copy of the proxy's models, so the number of ALIAS entries in the
	 * host list is the number of proxy-backed groups whose discovery succeeded - the only host-visible signal
	 * that distinguishes a NEW group's success from earlier groups' models persisting.
	 */
	function waitForProxyGroupCount(minCount: number): Promise<vscode.LanguageModelChat[]> {
		return waitForHostModels(
			60000,
			(models) => countModels(models, ALIAS) >= minCount,
			`${minCount} proxy-backed provider group(s) to expose ${ALIAS}`
		);
	}

	async function chat(model: vscode.LanguageModelChat, text: string): Promise<string> {
		const response = await model.sendRequest(
			[vscode.LanguageModelChatMessage.User(text)],
			{},
			new vscode.CancellationTokenSource().token
		);
		return extractText(await collectStream(response));
	}

	async function oauthStats(): Promise<OAuthStats> {
		const response = await fetch(`${FAKE_URL}/_test/oauth-stats`);
		assert.ok(response.ok, `GET /_test/oauth-stats failed: ${response.status}`);
		return (await response.json()) as OAuthStats;
	}

	/** The fake backend's per-bearer counts of blanked discovery GETs (see fakeStack/noDiscovery.ts). */
	async function discoveryAttempts(bearer: string): Promise<NoDiscoveryAttemptCounts> {
		const response = await fetch(`${FAKE_URL}/_test/nodiscovery-stats`);
		assert.ok(response.ok, `GET /_test/nodiscovery-stats failed: ${response.status}`);
		const stats = (await response.json()) as Record<string, NoDiscoveryAttemptCounts>;
		return stats[bearer] ?? { models: 0, modelInfo: 0 };
	}

	/**
	 * The counters move whenever the host resolves the failing group (failures are never cached), so a
	 * meaningful snapshot must sit between sweeps: poll until the bearer's counts hold still for a beat.
	 */
	async function quiescedDiscoveryAttempts(bearer: string): Promise<NoDiscoveryAttemptCounts> {
		let last = await discoveryAttempts(bearer);
		let stableSince = Date.now();
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			const next = await discoveryAttempts(bearer);
			if (next.models !== last.models || next.modelInfo !== last.modelInfo) {
				last = next;
				stableSince = Date.now();
			} else if (Date.now() - stableSince >= 1500) {
				return last;
			}
		}
		throw new Error(`Timeout (30000ms) waiting for the discovery-attempt counters of "${bearer}" to settle`);
	}

	async function waitUntil(what: string, timeoutMs: number, check: () => Promise<boolean>): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await check()) {
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		throw new Error(`Timeout (${timeoutMs}ms) waiting for ${what}`);
	}

	/**
	 * Every issue-report log line of this session, through the lossless test tee: unlike getRecentLogs' rolling
	 * window, absence here means a line was never logged.
	 */
	async function sessionLogLines(): Promise<string[]> {
		const batch = (await vscode.commands.executeCommand("litellm._test.getSessionLogs", 0)) as {
			lines: string[];
			dropped: number;
		};
		assert.strictEqual(batch.dropped, 0, "the session log tee must not have evicted lines");
		return batch.lines;
	}

	suiteSetup(async function () {
		this.timeout(90000);
		await ensureActivated();
		await catalogOff();
		originalServersSetting = serversConfig().inspect(SERVERS_SETTING_KEY)?.globalValue;
		originalCapabilitiesSetting = serversConfig().inspect(MODEL_CAPABILITIES_SETTING_KEY)?.globalValue;
		assert.deepStrictEqual(readServersSetting(), [], "the suite needs a fresh host with no declared servers");
		// A recycled tmpdir pid can inherit provider groups from an earlier run, so the count oracle baselines on
		// what the host already serves.
		proxyGroups = countModels(await vscode.lm.selectChatModels({ vendor: VENDOR_ID }), ALIAS);
	});

	suiteTeardown(async function () {
		this.timeout(30000);
		// The SecretStorage blobs written by scenarios 2/3 outlive the setting; clear them so a recycled user-data
		// directory cannot inherit live credentials. The restore plus a final sync also prunes the suite labels
		// from the persisted fingerprint map.
		await setStoredSecret(LABEL_STORED, "apiKey", undefined);
		await setStoredSecret(LABEL_PRECEDENCE, "apiKey", undefined);
		await serversConfig().update(
			MODEL_CAPABILITIES_SETTING_KEY,
			originalCapabilitiesSetting,
			vscode.ConfigurationTarget.Global
		);
		await serversConfig().update(SERVERS_SETTING_KEY, originalServersSetting, vscode.ConfigurationTarget.Global);
		await syncNow();
	});

	test("scenario 1: an inline apiKey entry becomes a provider group that serves chat", async function () {
		this.timeout(90000);
		await declareServer({ label: LABEL_INLINE, baseUrl: BASE_URL, auth: { apiKey: API_KEY } });
		proxyGroups += 1;
		const models = await waitForProxyGroupCount(proxyGroups);
		const view = await declaredFor(LABEL_INLINE);
		assert.strictEqual(view.syncError, undefined, "the group add must succeed");
		assert.strictEqual(view.secrets.apiKey, "settings", "an inline key reads as settings-stored");
		const model = expectDefined(models.find((candidate) => candidate.id === ALIAS));
		assert.strictEqual(await chat(model, `${COMMAND_SIGIL}echo:serversync inline`), "serversync inline");
	});

	test("scenario 2: a SecretStorage-stored apiKey drives discovery with no inline value", async function () {
		this.timeout(90000);
		// The secret lands BEFORE the entry is declared, and the entry carries no apiKey at all. groupClientId
		// fingerprints the RESOLVED credential, so the stored key resolving to the master key mints scenario 1's
		// client id; a wrong or missing key would mint a different one and 401 into an empty group.
		await setStoredSecret(LABEL_STORED, "apiKey", API_KEY);
		await declareServer({ label: LABEL_STORED, baseUrl: BASE_URL });
		proxyGroups += 1;
		await waitForProxyGroupCount(proxyGroups);
		const view = await declaredFor(LABEL_STORED);
		assert.strictEqual(view.syncError, undefined);
		assert.strictEqual(view.secrets.apiKey, "secure", "the stored blob is the key's reported location");
	});

	test("scenario 3: an inline apiKey outranks a stored garbage value", async function () {
		this.timeout(90000);
		await setStoredSecret(LABEL_PRECEDENCE, "apiKey", GARBAGE_KEY);
		await declareServer({ label: LABEL_PRECEDENCE, baseUrl: BASE_URL, auth: { apiKey: API_KEY } });
		proxyGroups += 1;
		// Models appearing IS the precedence proof: had the stored garbage won, the group's client id would
		// fingerprint it, miss every discovery cache, and 401 into a group that stays empty forever.
		await waitForProxyGroupCount(proxyGroups);
		const view = await declaredFor(LABEL_PRECEDENCE);
		assert.strictEqual(view.secrets.apiKey, "settings", "the inline value wins the location report too");
	});

	test("scenario 4: a virtual key header authenticates discovery and chat without an apiKey", async function () {
		this.timeout(90000);
		await declareServer({
			label: LABEL_VIRTUAL,
			baseUrl: BASE_URL,
			auth: { virtualKey: { header: "x-litellm-api-key", value: API_KEY } },
		});
		proxyGroups += 1;
		// This group carries no other credential, so its discovery succeeding proves LiteLLM honored
		// x-litellm-api-key. The host exposes no group identity on the model object (the id stays the raw alias),
		// so running through EVERY alias-bearing model deterministically includes this group's; a dead virtual
		// key would fail that chat.
		const models = await waitForProxyGroupCount(proxyGroups);
		const aliasModels = models.filter((candidate) => candidate.id === ALIAS);
		assert.ok(aliasModels.length >= proxyGroups, "one alias model per proxy-backed group");
		for (const model of aliasModels) {
			assert.strictEqual(await chat(model, `${COMMAND_SIGIL}echo:serversync virtual`), "serversync virtual");
		}
	});

	test("scenario 5a: a wrong OAuth client secret leaves its group silently empty", async function () {
		this.timeout(90000);
		const before = await oauthStats();
		await declareServer({
			label: LABEL_OAUTH_BAD,
			baseUrl: `${FAKE_URL}/authed`,
			auth: {
				oauth: {
					tokenUrl: `${FAKE_URL}/oauth/token`,
					clientId: FAKE_OAUTH_CLIENT_ID,
					clientSecret: WRONG_OAUTH_SECRET,
				},
			},
		});
		await waitUntil(
			"the token endpoint to reject this group's exchange",
			30000,
			async () => (await oauthStats()).rejected > before.rejected
		);
		// This is the only group targeting the fake backend directly, so any fake-upstream id would mean the
		// failed exchange still produced credentials. Absence is asserted across a settle window because the
		// host ingests model lists asynchronously.
		const settleDeadline = Date.now() + 2500;
		while (Date.now() < settleDeadline) {
			const models = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
			assert.ok(
				models.every((model) => !model.id.startsWith("fake-")),
				"a wrong-secret group must never expose models"
			);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	});

	test("scenario 5b: OAuth discovery and chat run end to end against the authed fake backend", async function () {
		this.timeout(120000);
		const before = await oauthStats();
		await declareServer({
			label: LABEL_OAUTH,
			baseUrl: `${FAKE_URL}/authed`,
			auth: {
				oauth: {
					tokenUrl: `${FAKE_URL}/oauth/token`,
					clientId: FAKE_OAUTH_CLIENT_ID,
					clientSecret: FAKE_OAUTH_CLIENT_SECRET,
				},
			},
		});
		const models = await waitForHostModels(
			60000,
			(candidates) => candidates.some((model) => model.id === OAUTH_MODEL),
			`the OAuth group to expose ${OAUTH_MODEL}`
		);
		assert.ok((await oauthStats()).issued > before.issued, "discovery must have exchanged at least one token");
		oauthModel = expectDefined(models.find((model) => model.id === OAUTH_MODEL));
		assert.strictEqual(await chat(oauthModel, `${COMMAND_SIGIL}echo:oauth chat`), "oauth chat");
	});

	test("scenario 5c: revocation fails the next chat auth-classified; the one after re-exchanges", async function () {
		this.timeout(60000);
		const model = expectDefined(oauthModel, "scenario 5b registered the OAuth model");
		const revoke = await fetch(`${FAKE_URL}/_test/oauth-revoke`, { method: "POST" });
		assert.ok(revoke.ok, `POST /_test/oauth-revoke failed: ${revoke.status}`);
		const before = await oauthStats();
		// The cached token is now dead server-side, so the chat fails classified as an auth error and the 401
		// invalidates the cached token. Matching AUTH_MESSAGE's text keeps a network or certificate failure,
		// whose message also contains the "/authed" base URL, from satisfying this.
		await assert.rejects(
			() => chat(model, `${COMMAND_SIGIL}echo:revoked`),
			(error: unknown) => /Authentication failed/.test(String(error)),
			"the revoked token's chat must fail auth-classified"
		);
		const afterFailure = await oauthStats();
		// Chat never retries. The wire-attempt counter is the honest oracle; the issuance counter is not, because
		// a background host sweep may legitimately re-exchange at any time.
		assert.strictEqual(
			afterFailure.authedChatRequests,
			before.authedChatRequests + 1,
			"exactly one wire attempt for the rejected chat"
		);
		assert.strictEqual(await chat(model, `${COMMAND_SIGIL}echo:fresh token`), "fresh token");
		assert.ok((await oauthStats()).issued > before.issued, "the follow-up chat performed a fresh exchange");
	});

	test("scenario 5d: the log lines never carry any credential material", async () => {
		const logs = await sessionLogLines();
		assert.ok(logs.length > 0, "the scenarios above must have produced classifications");
		const secrets: ReadonlyArray<[string, string]> = [
			[FAKE_OAUTH_CLIENT_SECRET, "the OAuth client secret"],
			[FAKE_OAUTH_TOKEN_PREFIX, "an issued bearer token"],
			[API_KEY, "the master key"],
			[GARBAGE_KEY, "the stored garbage key"],
			[WRONG_OAUTH_SECRET, "the rejected OAuth secret"],
		];
		for (const line of logs) {
			for (const [needle, what] of secrets) {
				assert.ok(!line.includes(needle), `a log line leaked ${what}`);
			}
		}
	});

	test("scenario 6: re-declaring a taken label surfaces the add-only error; reverting clears it", async function () {
		this.timeout(90000);
		const entries = readServersSetting();
		const index = entries.findIndex((entry) => entry.label === LABEL_INLINE);
		assert.ok(index >= 0, "scenario 1's entry is still declared");
		const original = expectDefined(entries[index]);
		entries[index] = { ...original, baseUrl: `${BASE_URL}/changed` };
		await writeServersSetting(entries);
		await syncNow();
		const blocked = await declaredFor(LABEL_INLINE);
		assert.strictEqual(blocked.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
		// The original group keeps serving through the name conflict.
		const models = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
		assert.ok(countModels(models, ALIAS) >= proxyGroups, "existing groups must keep their models");

		entries[index] = original;
		await writeServersSetting(entries);
		await syncNow();
		const reverted = await declaredFor(LABEL_INLINE);
		assert.strictEqual(reverted.syncError, undefined, "reverting to the live group's content clears the error");
	});

	test("scenario 7: removing an entry hides the surviving group's models; re-declaring restores them", async function () {
		this.timeout(120000);
		await writeServersSetting(readServersSetting().filter((entry) => entry.label !== LABEL_STORED));
		await syncNow();
		const views = await getDeclared();
		assert.ok(
			views.every((view) => view.label !== LABEL_STORED),
			"the declared views must drop the removed label"
		);
		// No programmatic group removal exists, so the host keeps the group; the removal tombstone makes the
		// provider answer it with zero models. Exactly one fewer serving group pins the tombstone's precision
		// both ways, asserted across a settle window because the host ingests model lists asynchronously: a
		// tombstone that suppressed a same-URL sibling would settle below this count.
		await waitForHostModels(
			60000,
			(models) => countModels(models, ALIAS) === proxyGroups - 1,
			`exactly ${proxyGroups - 1} proxy-backed group(s) to expose ${ALIAS} (the tombstoned group serving none)`
		);
		const settleDeadline = Date.now() + 2500;
		while (Date.now() < settleDeadline) {
			const settled = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
			assert.strictEqual(
				countModels(settled, ALIAS),
				proxyGroups - 1,
				"only the removed entry's group may lose its models"
			);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		// Re-declaring the identity clears the tombstone. The re-add itself is refused by the add-only host (the
		// label's fingerprint was pruned with the entry), which must not matter: the models returning without a
		// successful add is the proof the host group survived the removal.
		await declareServer({ label: LABEL_STORED, baseUrl: BASE_URL });
		await waitForProxyGroupCount(proxyGroups);
		const view = await declaredFor(LABEL_STORED);
		assert.strictEqual(view.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE, "the re-add hits the add-only rejection");
		assert.strictEqual(view.secrets.apiKey, "secure", "the re-added label reads its kept SecretStorage blob");
	});

	test("scenario 8: two same-URL entries each send their own per-entry model parameters", async function () {
		this.timeout(180000);
		// Same base URL, same key: only the labels tell these entries apart, so the temperatures below can only
		// reach the wire through the label-keyed entry lookup at request time.
		await declareServer({
			label: LABEL_PARAMS_A,
			baseUrl: BASE_URL,
			auth: { apiKey: API_KEY },
			models: { parameters: { [ALIAS]: { temperature: 0.31 } } },
		});
		await declareServer({
			label: LABEL_PARAMS_B,
			baseUrl: BASE_URL,
			auth: { apiKey: API_KEY },
			models: { parameters: { [ALIAS]: { temperature: 0.62 } } },
		});
		proxyGroups += 2;
		const models = await waitForProxyGroupCount(proxyGroups);
		// The host exposes no group identity on the model object (see scenario 4), so the chat runs through EVERY
		// alias model and collects the temperature each request carried. Exactly the two new entries' values must
		// appear, once each: the earlier groups declare no parameters.
		const aliasModels = models.filter((candidate) => candidate.id === ALIAS);
		const temperatures: string[] = [];
		for (const model of aliasModels) {
			const reply = await chat(model, `${COMMAND_SIGIL}params`);
			const match = /temperature: `([^`]+)`/.exec(reply);
			if (match?.[1] !== undefined) {
				temperatures.push(match[1]);
			}
		}
		assert.deepStrictEqual(temperatures.sort(), ["0.31", "0.62"]);
	});

	test("scenario 9: entry and global modelCapabilities patch a listed model and lift the output clamp", async function () {
		this.timeout(180000);
		// The global record's exact matcher applies to every group's copy of the model; the entry record applies
		// to the new entry's group alone and merges key by key over the global winner, so only that copy's
		// requests may carry the overridden output limit.
		await writeCapabilitiesSetting({
			...readCapabilitiesSetting(),
			[CAPS_MODEL]: { max_input_tokens: 90000 },
		});
		await declareServer({
			label: LABEL_CAPS,
			baseUrl: BASE_URL,
			auth: { apiKey: API_KEY },
			models: { capabilities: { [CAPS_MODEL]: { max_output_tokens: 5000 } } },
		});
		proxyGroups += 1;
		const models = await waitForHostModels(
			60000,
			(candidates) =>
				countModels(candidates, ALIAS) >= proxyGroups &&
				countModels(candidates, CAPS_MODEL) === proxyGroups &&
				candidates.filter((m) => m.id === CAPS_MODEL).every((m) => m.maxInputTokens === 90000),
			`every ${CAPS_MODEL} copy to advertise the global input limit`
		);
		// The host exposes no group identity on the model object (see scenario 4), so the chat runs through EVERY
		// copy and collects the max_tokens each request carried. Exactly one copy (the entry's group) sends the
		// overridden declared limit; the model declares no limits itself, so every other copy keeps the
		// min(4096, guess) cap.
		const capsModels = models.filter((candidate) => candidate.id === CAPS_MODEL);
		const maxTokens: number[] = [];
		for (const model of capsModels) {
			const reply = await chat(model, `${COMMAND_SIGIL}params`);
			const match = /max_tokens: `(\d+)`/.exec(reply);
			maxTokens.push(Number(expectDefined(match?.[1], `max_tokens in "${reply}"`)));
		}
		assert.strictEqual(
			maxTokens.filter((value) => value === 5000).length,
			1,
			`exactly the entry's group sends the overridden declared limit, got: ${maxTokens.join(", ")}`
		);
		assert.ok(
			maxTokens.every((value) => value === 5000 || value <= 4096),
			`every other copy must keep a clamped guess, got: ${maxTokens.join(", ")}`
		);
	});

	test("scenario 10: expectedFailures downgrades the discovery failure and takes one attempt per endpoint", async function () {
		this.timeout(180000);
		await declareServer({
			label: LABEL_EXPECTED,
			baseUrl: NO_DISCOVERY_URL,
			auth: { apiKey: EXPECTED_FAILURES_KEY },
			discovery: { expectedFailures: ["modelListing", "modelInfo"], declared: [EXPECTED_DECLARED_MODEL] },
			models: {
				capabilities: {
					[EXPECTED_DECLARED_MODEL]: { context_length: 32000, max_output_tokens: 4000 },
				},
			},
		});
		const models = await waitForHostModels(
			60000,
			(candidates) => candidates.some((model) => model.id === EXPECTED_DECLARED_MODEL),
			`the expected-failures group to expose ${EXPECTED_DECLARED_MODEL}`
		);
		const model = expectDefined(models.find((candidate) => candidate.id === EXPECTED_DECLARED_MODEL));
		assert.strictEqual(
			model.maxInputTokens,
			28000,
			"the input limit derives from the declared context length minus the output limit"
		);
		const view = await declaredFor(LABEL_EXPECTED);
		assert.strictEqual(view.syncError, undefined, "the group add must succeed");

		// The status window records the TRUE outcome - an error - tagged expected with the declared count riding
		// along; the presentation layers derive the ok-with-note verdict from those fields.
		const statuses = (await vscode.commands.executeCommand("litellm._test.getServerStatuses")) as ServerStatus[];
		const status = expectDefined(
			statuses.find((candidate) => candidate.label === LABEL_EXPECTED),
			`status for ${LABEL_EXPECTED}`
		);
		assert.strictEqual(status.state, "error", "the window keeps the truthful discovery outcome");
		assert.strictEqual(status.expected, true, "the failure carries the expected tag");
		assert.strictEqual(status.declaredModelCount, 1, "the declared model rides the error status");

		// Info-level logging: the model/info fallback line and the boundary classification both carry the expected
		// marker. Polled, since the sweep emits them asynchronously.
		await waitUntil("the expected-failure classifications to appear in the logs", 30000, async () => {
			const logs = await sessionLogLines();
			return (
				logs.some((line) => line.includes("(expected: modelInfo)")) &&
				logs.some((line) => line.includes("Model discovery failed (expected: modelListing) for provider group"))
			);
		});
		// The session tee is lossless, so absence here means the error-level line was never logged at all.
		const logs = await sessionLogLines();
		assert.ok(
			logs.every((line) => !line.includes(`Failed to fetch models for provider group at ${NO_DISCOVERY_URL}`)),
			"an expected terminal failure must never log at error level"
		);

		// One attempt per endpoint. The blanked 404s carry x-should-retry: true (the SDK never retries a plain
		// 404), so only the zeroed per-endpoint retry budgets can hold these deltas at one.
		const before = await quiescedDiscoveryAttempts(EXPECTED_FAILURES_KEY);
		await syncNow();
		await waitUntil(
			"the forced sync's discovery pass to reach the fake backend",
			30000,
			async () => (await discoveryAttempts(EXPECTED_FAILURES_KEY)).models > before.models
		);
		const after = await quiescedDiscoveryAttempts(EXPECTED_FAILURES_KEY);
		assert.strictEqual(after.models - before.models, 1, "one models-listing attempt, no retries");
		assert.strictEqual(after.modelInfo - before.modelInfo, 1, "one model/info attempt, no retries");

		// The declared model stays usable end to end under the expected outage.
		assert.strictEqual(await chat(model, `${COMMAND_SIGIL}echo:expected declared chat`), "expected declared chat");
	});

	test("scenario 11: a declared model registers chat-capable when discovery fails UNEXPECTEDLY", async function () {
		this.timeout(120000);
		// The contract delta against scenario 10: declaration is active on ANY discovery failure type, so this
		// entry declares no expectedFailures. Runs LAST on purpose - its unexpected failures log at error level
		// with the no-discovery URL, which scenario 10's log scan must never see.
		await declareServer({
			label: LABEL_DECLARED_UNEXPECTED,
			baseUrl: NO_DISCOVERY_URL,
			auth: { apiKey: UNEXPECTED_DECLARED_KEY },
			discovery: { declared: [UNEXPECTED_DECLARED_MODEL] },
			models: {
				capabilities: {
					[UNEXPECTED_DECLARED_MODEL]: {
						max_input_tokens: 123000,
						max_output_tokens: 9000,
					},
				},
			},
		});
		const models = await waitForHostModels(
			60000,
			(candidates) => candidates.some((model) => model.id === UNEXPECTED_DECLARED_MODEL),
			`the host to expose ${UNEXPECTED_DECLARED_MODEL}`
		);
		const model = expectDefined(models.find((candidate) => candidate.id === UNEXPECTED_DECLARED_MODEL));
		assert.strictEqual(model.maxInputTokens, 123000, "the declared max_input_tokens drives registration");
		const view = await declaredFor(LABEL_DECLARED_UNEXPECTED);
		assert.strictEqual(view.syncError, undefined, "the group add must succeed");
		const statuses = (await vscode.commands.executeCommand("litellm._test.getServerStatuses")) as ServerStatus[];
		const status = expectDefined(
			statuses.find((candidate) => candidate.label === LABEL_DECLARED_UNEXPECTED),
			`status for ${LABEL_DECLARED_UNEXPECTED}`
		);
		assert.strictEqual(status.state, "error", "the discovery failure stays a truthful error");
		assert.notStrictEqual(status.expected, true, "nothing marks this failure expected");
		assert.strictEqual(status.declaredModelCount, 1, "the declared model rides the error status");

		const played = await chat(model, `${COMMAND_SIGIL}play:long-text`);
		assert.ok(
			played.includes("Blue is the color of the daytime sky"),
			`the declared model must stream the canned scenario, got: "${played}"`
		);
		const params = await chat(model, `${COMMAND_SIGIL}params`);
		assert.match(params, /max_tokens: `9000`/, "a user-declared output limit reaches the wire uncapped");
	});
});
