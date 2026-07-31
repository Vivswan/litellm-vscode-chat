import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DeclaredServerView } from "../extension/serverSync";
import { GROUP_UPDATE_UNAVAILABLE_MESSAGE } from "../extension/serverSync";
import { CMD, VENDOR_ID } from "../shared/commandIds";
import type { SecretFieldId } from "../shared/serverEntry";
import { CONFIG_SECTION } from "../shared/settingSpec";
import { SERVERS_SETTING_KEY } from "../shared/settings";
import { STACK_DEFAULTS } from "./envFile";
import { COMMAND_SIGIL } from "./fakeStack/commands";
import { PLAYBACK_MODEL } from "./fakeStack/models";
import { FAKE_OAUTH_CLIENT_ID, FAKE_OAUTH_CLIENT_SECRET, FAKE_OAUTH_TOKEN_PREFIX } from "./fakeStack/oauth";
import { collectStream, ensureActivated, extractText, waitForHostModels } from "./hostApiHelpers";
import { expectDefined } from "./testUtils";

/**
 * Docker server-sync suite: the REAL declarative chain, end to end. Every
 * scenario drives litellm-vscode-chat.servers -> serverSync ->
 * lm.addLanguageModelsProviderGroup -> discovery -> chat against the docker
 * LiteLLM proxy (and, for OAuth, the fake backend's bearer-guarded /authed
 * mirror), observing through the host model list, the engine's declared
 * views, and the fake identity provider's counters.
 *
 * Provider groups are ADD-ONLY for the host lifetime (no removal command),
 * so this suite runs in its own fresh extension host (own vscode-test
 * label), every scenario uses a unique label, and groups from earlier
 * scenarios persist through later ones. The scenarios are sequential and
 * order-dependent on purpose: each builds on the groups the previous ones
 * created. Run via `bun run test:docker`.
 */

const BASE_URL = process.env.LITELLM_DOCKER_BASE_URL || "";
const API_KEY = process.env.LITELLM_DOCKER_API_KEY || STACK_DEFAULTS.LITELLM_MASTER_KEY;
const FAKE_URL = process.env.LITELLM_DOCKER_FAKE_URL || "";

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

/** Scenario 3's dormant stored value; scenario 5d scans the log buffer for it. */
const GARBAGE_KEY = "sk-garbage-MARKER";
/** Scenario 5a's rejected client secret; scenario 5d scans the log buffer for it. */
const WRONG_OAUTH_SECRET = "not-the-secret";

type ServersSettingEntry = Record<string, string | Readonly<Record<string, Readonly<Record<string, unknown>>>>>;

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

	function serversConfig(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(CONFIG_SECTION);
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
	 * Each provider group registers its own copy of the proxy's models (the
	 * host namespaces per group), so the number of ALIAS entries in the host
	 * list is the number of proxy-backed groups whose discovery succeeded.
	 * That count is the only host-visible signal that distinguishes a NEW
	 * group's success from the earlier groups' models merely persisting.
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

	suiteSetup(async function () {
		this.timeout(90000);
		await ensureActivated();
		originalServersSetting = serversConfig().inspect(SERVERS_SETTING_KEY)?.globalValue;
		assert.deepStrictEqual(readServersSetting(), [], "the suite needs a fresh host with no declared servers");
		// A recycled tmpdir pid can inherit provider groups from an earlier run,
		// so the count oracle baselines on what the host already serves instead
		// of assuming zero.
		proxyGroups = countModels(await vscode.lm.selectChatModels({ vendor: VENDOR_ID }), ALIAS);
	});

	suiteTeardown(async function () {
		this.timeout(30000);
		// The SecretStorage blobs written by scenarios 2/3 outlive the setting;
		// clear them so a recycled user-data directory cannot inherit live
		// credentials. Restoring the setting and forcing one more sync pass also
		// prunes the suite labels from the persisted fingerprint map.
		await setStoredSecret(LABEL_STORED, "apiKey", undefined);
		await setStoredSecret(LABEL_PRECEDENCE, "apiKey", undefined);
		await serversConfig().update(SERVERS_SETTING_KEY, originalServersSetting, vscode.ConfigurationTarget.Global);
		await syncNow();
	});

	test("scenario 1: an inline apiKey entry becomes a provider group that serves chat", async function () {
		this.timeout(90000);
		await declareServer({ label: LABEL_INLINE, baseUrl: BASE_URL, apiKey: API_KEY });
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
		// The secret lands BEFORE the entry is declared, so the very first sync
		// pass already resolves it; the entry itself carries no apiKey at all.
		// The count oracle rests on groupClientId fingerprinting the RESOLVED
		// credential material: the stored key resolving to the master key mints
		// the same client id as scenario 1's group (its discovery cache may even
		// serve the models), while a wrong or missing key would mint a different
		// id, miss that cache, and 401 into an empty group.
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
		await declareServer({ label: LABEL_PRECEDENCE, baseUrl: BASE_URL, apiKey: API_KEY });
		proxyGroups += 1;
		// Models appearing IS the precedence proof: had the stored garbage won,
		// the group's client id would fingerprint the garbage key (groupClientId
		// hashes the resolved credentials), miss every discovery cache, and 401
		// against the key-requiring proxy into a group that stays empty forever.
		await waitForProxyGroupCount(proxyGroups);
		const view = await declaredFor(LABEL_PRECEDENCE);
		assert.strictEqual(view.secrets.apiKey, "settings", "the inline value wins the location report too");
	});

	test("scenario 4: a virtual key header authenticates discovery and chat without an apiKey", async function () {
		this.timeout(90000);
		await declareServer({
			label: LABEL_VIRTUAL,
			baseUrl: BASE_URL,
			virtualKeyHeader: "x-litellm-api-key",
			virtualKeyValue: API_KEY,
		});
		proxyGroups += 1;
		// This group carries no other credential, so its discovery succeeding
		// (the count increment) proves LiteLLM honored x-litellm-api-key. The
		// host does NOT expose group identity on the model object (id stays the
		// raw alias across groups - the earlier scenarios match on exactly that;
		// the group-namespaced id exists only in host logs), so the chat cannot
		// select this group's object directly. Instead it runs through EVERY
		// alias-bearing model: each object carries its own group's credentials
		// across the host round trip, so the set deterministically includes the
		// virtual-key group's, and a dead virtual key would fail that chat.
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
			oauthTokenUrl: `${FAKE_URL}/oauth/token`,
			oauthClientId: FAKE_OAUTH_CLIENT_ID,
			oauthClientSecret: WRONG_OAUTH_SECRET,
		});
		await waitUntil(
			"the token endpoint to reject this group's exchange",
			30000,
			async () => (await oauthStats()).rejected > before.rejected
		);
		// This is the only group targeting the fake backend directly, so any
		// fake- upstream id in the host list would mean the failed exchange
		// still produced credentials. Absence is asserted across a settle
		// window because the host ingests model lists asynchronously.
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
			oauthTokenUrl: `${FAKE_URL}/oauth/token`,
			oauthClientId: FAKE_OAUTH_CLIENT_ID,
			oauthClientSecret: FAKE_OAUTH_CLIENT_SECRET,
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
		// The cached token is now dead server-side: the chat sends it, gets the
		// LiteLLM-shaped 401, and fails classified as an auth error (the mapped
		// message is AUTH_MESSAGE's "Authentication failed..." - matching that
		// text keeps a network or certificate failure, whose message would still
		// contain the "/authed" base URL, from satisfying this assertion). The
		// 401 invalidates the cached token (OAuthTokenSource.invalidate over a
		// real socket).
		await assert.rejects(
			() => chat(model, `${COMMAND_SIGIL}echo:revoked`),
			(error: unknown) => /Authentication failed/.test(String(error)),
			"the revoked token's chat must fail auth-classified"
		);
		const afterFailure = await oauthStats();
		// Chat never retries: the failed request hit the guarded chat endpoint
		// exactly once. The wire-attempt counter is the honest oracle here; the
		// issuance counter is not, because a background host sweep may
		// legitimately re-exchange at any time.
		assert.strictEqual(
			afterFailure.authedChatRequests,
			before.authedChatRequests + 1,
			"exactly one wire attempt for the rejected chat"
		);
		assert.strictEqual(await chat(model, `${COMMAND_SIGIL}echo:fresh token`), "fresh token");
		assert.ok((await oauthStats()).issued > before.issued, "the follow-up chat performed a fresh exchange");
	});

	test("scenario 5d: the log buffer never carries any credential material", async () => {
		const logs = (await vscode.commands.executeCommand("litellm._test.getRecentLogs")) as string[];
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

	test("scenario 7: removing an entry keeps the group's models but drops the declared view", async function () {
		this.timeout(90000);
		await writeServersSetting(readServersSetting().filter((entry) => entry.label !== LABEL_STORED));
		await syncNow();
		const views = await getDeclared();
		assert.ok(
			views.every((view) => view.label !== LABEL_STORED),
			"the declared views must drop the removed label"
		);
		// No programmatic group removal exists, so the host keeps serving the
		// removed entry's models; proxyGroups still counts its group.
		const models = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
		assert.ok(countModels(models, ALIAS) >= proxyGroups, "provider groups survive their setting entry's removal");
	});

	test("scenario 8: two same-URL entries each send their own per-entry model parameters", async function () {
		this.timeout(180000);
		// Same base URL, same key: only the labels tell these entries apart, so
		// the temperatures below can only reach the wire through the label-keyed
		// entry lookup at request time.
		await declareServer({
			label: LABEL_PARAMS_A,
			baseUrl: BASE_URL,
			apiKey: API_KEY,
			modelParameters: { [ALIAS]: { temperature: 0.31 } },
		});
		await declareServer({
			label: LABEL_PARAMS_B,
			baseUrl: BASE_URL,
			apiKey: API_KEY,
			modelParameters: { [ALIAS]: { temperature: 0.62 } },
		});
		proxyGroups += 2;
		const models = await waitForProxyGroupCount(proxyGroups);
		// The host does not expose group identity on the model object (see
		// scenario 4), so the chat runs through EVERY alias model and collects
		// the temperature each request carried to the fake backend. Exactly the
		// two new entries' values must appear, once each: the earlier groups'
		// entries declare no parameters, so their requests carry no temperature.
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
});
