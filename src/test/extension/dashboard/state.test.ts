import * as assert from "node:assert";
import type { AdoptableGroupCredentials } from "../../../extension/dashboard/adopt";
import { resolveAdoptableCredentials, resolveExternalGroupIdentity } from "../../../extension/dashboard/adopt";
import type { DashboardIntent } from "../../../extension/dashboard/intentSchema";
import { webviewMessageSchema } from "../../../extension/dashboard/intentSchema";
import type { IntentEnvironment } from "../../../extension/dashboard/intents";
import {
	DashboardOperationError,
	executeDashboardIntent,
	readInlineSecretValues,
	validateHeadersRecord,
	validateModelParametersRecord,
	validateNumberSetting,
	validateSaveServerSetting,
} from "../../../extension/dashboard/intents";
import type { NumberSettingId } from "../../../extension/dashboard/protocol";
import {
	BOOLEAN_SETTING_IDS,
	draftSyncKey,
	equivalence,
	failuresAfterStatePush,
	formatHeaderValue,
	isExtensionMessageType,
	NUMBER_SETTING_IDS,
	parseHeaderValue,
	parseJsonValue,
	parseNumberDraft,
} from "../../../extension/dashboard/protocol";
import type { ServerFormDraft } from "../../../extension/dashboard/serverForm";
import { applyInlinePrefill, EMPTY_SERVER_FORM, parseServerForm } from "../../../extension/dashboard/serverForm";
import type { SettingsInspection, SettingsReader } from "../../../extension/dashboard/state";
import {
	buildDashboardState,
	readDashboardSettings,
	resolveConfiguredScope,
	resolveUpdateScope,
} from "../../../extension/dashboard/state";
import type { DeclaredServerView } from "../../../extension/servers/serverSync";
import { REASONING_EFFORT_SCHEMA } from "../../../provider/catalog/modelConfiguration";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { makeModelInfo, makeServerStatus } from "../../testUtils";

/** The intent body a clean draft parses to; fails the test if the draft has problems. */
function parseClean(draft: ServerFormDraft, originalLabel: string) {
	const parse = parseServerForm(draft, { originalLabel });
	assert.ok(parse.ok, "the draft must parse clean");
	return parse.intent;
}

/** A declared-server view with every secret absent; overrides fill in the specifics. */
function makeDeclared(overrides: Partial<DeclaredServerView> = {}): DeclaredServerView {
	return {
		label: "Prod",
		baseUrl: "http://prod.test",
		secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
		...overrides,
	};
}

const KEEP_ALL = {
	apiKey: { action: "keep" },
	oauthClientSecret: { action: "keep" },
	virtualKeyValue: { action: "keep" },
} as const;

/**
 * A SettingsReader over fixture values: `values` back get() and double as the
 * global scope, `defaults` mirror package.json, and `scopes` sets per-scope
 * values explicitly for the scoped-record tests.
 */
function makeReader(
	values: Record<string, unknown>,
	defaults: Record<string, unknown> = {},
	scopes: Record<string, Omit<SettingsInspection, "defaultValue">> = {}
): SettingsReader {
	return {
		get: (key) => values[key],
		inspect: (key) => ({
			defaultValue: defaults[key],
			...(Object.hasOwn(values, key) ? { globalValue: values[key] } : {}),
			...scopes[key],
		}),
	};
}

interface RecordedEnv {
	updates: [string, unknown][];
	/** Every removeSetting call (the resetSetting intent's removals). */
	removals: string[];
	commands: [string, ...unknown[]][];
	/** Every writeServersSetting call, whole arrays. */
	serverWrites: unknown[][];
	/** Every storeServerSecret call. */
	secretOps: [string, string, string | undefined][];
	/** Every copyServerSecrets call. */
	secretCopies: [string, string][];
	/** Every deleteServerSecrets call. */
	secretDeletes: string[];
	/** Every mutation in call order, for atomicity-ordering assertions. */
	ops: string[];
	/** The fake secure store's blobs by label; mutated by the secret operations like the real one. */
	storedSecrets: Map<string, Record<string, string>>;
	/** Every env.log call; classifications only. */
	logs: [string, unknown][];
	syncRequests: number;
	/** When set, writeServersSetting rejects with this error. */
	failWrites?: Error;
	/** When set, storeServerSecret rejects with this error on deletes (value === undefined). */
	failUnstore?: Error;
	/** When set, this many delete-side storeServerSecret calls reject before recovering. */
	failUnstoreTimes?: number;
	/** When set, storeServerSecret rejects when storing a value for this field. */
	failStoreField?: string;
	/** When set, readServerSecrets rejects once this many reads have succeeded. */
	failSecretReadsAfter?: number;
	/** When set, deleteServerSecrets rejects with this error. */
	failBlobDeletes?: Error;
	/** What resolveAdoptionCredentials returns; every call is recorded in adoptionLookups. */
	adoptionCredentials?: AdoptableGroupCredentials;
	adoptionLookups: [string, string][];
	/** What resolveExternalGroup returns; every call is recorded in externalLookups. */
	externalGroup?: { label: string; baseUrl: string };
	externalLookups: [string, string][];
	/** Every hideGroup call. */
	hidden: { label: string; baseUrl: string }[];
	/** Every unhideGroup call; unhideResult is what the fake reports back. */
	unhidden: { label: string; baseUrl: string }[];
	unhideResult: boolean;
	env: IntentEnvironment;
}

function makeEnv(serversSetting: unknown = []): RecordedEnv {
	const recorded: RecordedEnv = {
		updates: [],
		removals: [],
		commands: [],
		serverWrites: [],
		secretOps: [],
		secretCopies: [],
		secretDeletes: [],
		ops: [],
		storedSecrets: new Map(),
		logs: [],
		syncRequests: 0,
		adoptionLookups: [],
		externalLookups: [],
		hidden: [],
		unhidden: [],
		unhideResult: true,
		env: {
			updateSetting: async (key, value) => {
				recorded.updates.push([key, value]);
			},
			removeSetting: async (key) => {
				recorded.removals.push(key);
			},
			executeCommand: async (command, ...args) => {
				recorded.commands.push([command, ...args]);
			},
			readServersSetting: () => serversSetting,
			writeServersSetting: async (value) => {
				if (recorded.failWrites !== undefined) {
					throw recorded.failWrites;
				}
				recorded.serverWrites.push([...value]);
				recorded.ops.push("write");
			},
			storeServerSecret: async (label, field, value) => {
				if (value === undefined && recorded.failUnstore !== undefined) {
					throw recorded.failUnstore;
				}
				if (value === undefined && (recorded.failUnstoreTimes ?? 0) > 0) {
					recorded.failUnstoreTimes = (recorded.failUnstoreTimes ?? 0) - 1;
					throw new Error("keychain locked");
				}
				if (value !== undefined && recorded.failStoreField === field) {
					throw new Error("keychain locked");
				}
				recorded.secretOps.push([label, field, value]);
				recorded.ops.push(`${value === undefined ? "unstore" : "store"}:${label}.${field}`);
				const blob = { ...recorded.storedSecrets.get(label) };
				if (value === undefined) {
					delete blob[field];
				} else {
					blob[field] = value;
				}
				recorded.storedSecrets.set(label, blob);
			},
			readServerSecrets: async (label) => {
				if (recorded.failSecretReadsAfter !== undefined) {
					if (recorded.failSecretReadsAfter <= 0) {
						throw new Error("keychain locked");
					}
					recorded.failSecretReadsAfter -= 1;
				}
				return { ...recorded.storedSecrets.get(label) };
			},
			copyServerSecrets: async (fromLabel, toLabel) => {
				recorded.secretCopies.push([fromLabel, toLabel]);
				recorded.ops.push(`copy:${fromLabel}->${toLabel}`);
				const source = recorded.storedSecrets.get(fromLabel);
				if (source !== undefined && Object.keys(source).length > 0) {
					recorded.storedSecrets.set(toLabel, { ...source });
				}
			},
			deleteServerSecrets: async (label) => {
				if (recorded.failBlobDeletes !== undefined) {
					throw recorded.failBlobDeletes;
				}
				recorded.secretDeletes.push(label);
				recorded.ops.push(`deleteBlob:${label}`);
				recorded.storedSecrets.delete(label);
			},
			requestServerSync: () => {
				recorded.syncRequests += 1;
			},
			resolveAdoptionCredentials: (baseUrl, sourceHandle) => {
				recorded.adoptionLookups.push([baseUrl, sourceHandle]);
				return recorded.adoptionCredentials;
			},
			resolveExternalGroup: (baseUrl, sourceHandle) => {
				recorded.externalLookups.push([baseUrl, sourceHandle]);
				return recorded.externalGroup;
			},
			hideGroup: async (identity) => {
				recorded.hidden.push({ ...identity });
			},
			unhideGroup: async (identity) => {
				recorded.unhidden.push({ ...identity });
				return recorded.unhideResult;
			},
			log: (message, data) => {
				recorded.logs.push([message, data]);
			},
		},
	};
	return recorded;
}

suite("extension/dashboard/state", () => {
	suite("buildDashboardState", () => {
		test("maps server statuses to dashboard servers, sorted by label", () => {
			const state = buildDashboardState(
				[
					{ status: makeServerStatus({ serverId: "b", label: "Zeta", hasApiKey: true }), models: [] },
					{
						status: makeServerStatus({
							serverId: "a",
							label: "Alpha",
							state: "error",
							error: "boom",
						}),
						models: [],
					},
				],
				makeReader({})
			);

			assert.deepStrictEqual(
				state.servers.map((s) => s.label),
				["Alpha", "Zeta"]
			);
			assert.strictEqual(state.servers[0]?.state, "error");
			assert.strictEqual(state.servers[0]?.error, "boom");
			assert.strictEqual(state.servers[0]?.hasApiKey, false, "absent hasApiKey narrows to false");
			assert.strictEqual(state.servers[0]?.origin, "external", "live rows without a settings entry are external");
			assert.strictEqual(state.servers[0]?.config, undefined);
			assert.strictEqual(state.servers[1]?.hasApiKey, true);
			assert.strictEqual(state.servers[1]?.baseUrl, "http://prod.test");
			assert.strictEqual(state.servers[1]?.lastChecked, "2026-07-26T00:00:00.000Z");
		});

		test("legacy registry servers with no row of their own are counted, never listed", () => {
			const state = buildDashboardState(
				[{ status: makeServerStatus(), models: [] }],
				makeReader({}),
				[],
				[
					{ baseUrl: "http://old.test" },
					// The same host the snapshot row shows (modulo the trailing
					// slash): already stated once, so it must not count again.
					{ baseUrl: "http://prod.test/" },
				]
			);

			assert.strictEqual(state.legacyServerCount, 1);
			assert.ok(!JSON.stringify(state.servers).includes("old.test"), "legacy servers contribute no row");
		});

		test("a declared row also shadows its legacy twin; without legacy input the count is zero", () => {
			const shadowed = buildDashboardState([], makeReader({}), [makeDeclared()], [{ baseUrl: "http://prod.test" }]);
			assert.strictEqual(shadowed.legacyServerCount, 0);

			assert.strictEqual(buildDashboardState([], makeReader({})).legacyServerCount, 0);
		});

		test("a down server's retained models list under its erroring row without a per-model stale marker", () => {
			// The provider retains a failed group's last known models in the
			// status window (bounded by the last successful discovery), so the
			// snapshot pairs an error status with a non-empty model list. The
			// dashboard lists those models unmarked, deliberately: the server
			// row they cite via serverLabel already renders the error and
			// lastChecked, snapshots carry undecorated pre-attach infos by type
			// (the picker's ThemeIcon decoration never enters this path), and
			// the models leave the table with the same ten-minute bound.
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({ serverId: "g1", label: "Prod", state: "error", error: "unreachable" }),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
				],
				makeReader({})
			);

			assert.strictEqual(state.servers[0]?.state, "error", "the row carries the staleness signal");
			assert.strictEqual(state.models.length, 1, "the retained models still list");
			const model = state.models[0];
			assert.strictEqual(model?.serverLabel, "Prod", "each model row cites the erroring server");
			assert.ok(!("statusIcon" in (model as object)), "no picker decoration leaks into the dashboard row");
			assert.ok(!("warningText" in (model as object)), "no picker decoration leaks into the dashboard row");
		});

		test("declared entries merge with their live group by label and base URL", () => {
			const state = buildDashboardState(
				[{ status: makeServerStatus({ label: "Prod", baseUrl: "http://prod.test", modelCount: 4 }), models: [] }],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://prod.test/",
						oauthTokenUrl: "https://idp.test/token",
						oauthClientId: "client",
						secrets: { apiKey: "secure", oauthClientSecret: "settings", virtualKeyValue: "none" },
					}),
				]
			);

			assert.strictEqual(state.servers.length, 1, "the declared entry and the live row merge into one");
			const server = state.servers[0];
			assert.strictEqual(server?.origin, "declared");
			assert.strictEqual(server?.state, "ok");
			assert.strictEqual(server?.modelCount, 4);
			assert.strictEqual(server?.hasApiKey, true, "a secure-side key counts");
			assert.strictEqual(server?.hasOAuth, true);
			assert.deepStrictEqual(server?.config?.secrets, {
				apiKey: "secure",
				oauthClientSecret: "settings",
				virtualKeyValue: "none",
			});
		});

		test("a declared entry joins its live group even when the snapshot label is the URL host", () => {
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({
							serverId: "g1",
							label: "x.example",
							baseUrl: "https://x.example",
							modelCount: 3,
						}),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
				],
				makeReader({}),
				[makeDeclared({ label: "Production", baseUrl: "https://x.example/" })]
			);

			assert.strictEqual(state.servers.length, 1, "no duplicate external row");
			const server = state.servers[0];
			assert.strictEqual(server?.label, "Production");
			assert.strictEqual(server?.origin, "declared");
			assert.strictEqual(server?.state, "ok");
			assert.strictEqual(server?.modelCount, 3);
			assert.strictEqual(state.models[0]?.serverLabel, "Production", "models adopt the declared label");
		});

		test("entries sharing a base URL pair by label first, so matching labels stay correctly paired", () => {
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({ serverId: "s1", label: "Staging", baseUrl: "http://x.test", modelCount: 1 }),
						models: [],
					},
					{
						status: makeServerStatus({ serverId: "s2", label: "Prod", baseUrl: "http://x.test", modelCount: 9 }),
						models: [],
					},
				],
				makeReader({}),
				[
					makeDeclared({ label: "Prod", baseUrl: "http://x.test" }),
					makeDeclared({ label: "Staging", baseUrl: "http://x.test" }),
				]
			);

			const byLabel = new Map(state.servers.map((server) => [server.label, server]));
			assert.strictEqual(state.servers.length, 2);
			assert.strictEqual(byLabel.get("Prod")?.modelCount, 9);
			assert.strictEqual(byLabel.get("Staging")?.modelCount, 1);
		});

		test("entries sharing a base URL with different credentials join by group client ID, never swapped", () => {
			// Both live snapshots are host-labeled identically, so no label pass
			// can tell them apart and the URL fallback would pair them by
			// position; the client ID the sync engine fingerprints is exact. The
			// declared order is chosen so the positional fallback would swap them.
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-staging:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							modelCount: 1,
						}),
						models: [],
					},
					{
						status: makeServerStatus({
							serverId: "group:fp-prod:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							modelCount: 9,
						}),
						models: [],
					},
				],
				makeReader({}),
				[
					makeDeclared({ label: "Prod", baseUrl: "http://x.test", expectedClientId: "group:fp-prod:http://x.test" }),
					makeDeclared({
						label: "Staging",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-staging:http://x.test",
					}),
				]
			);

			const byLabel = new Map(state.servers.map((server) => [server.label, server]));
			assert.strictEqual(state.servers.length, 2);
			assert.strictEqual(byLabel.get("Prod")?.modelCount, 9);
			assert.strictEqual(byLabel.get("Staging")?.modelCount, 1);
			assert.ok(!JSON.stringify(state).includes("fp-prod"), "the join key never reaches the webview state");
		});

		test("an entry whose client ID matches no snapshot still joins by URL", () => {
			// A stale fingerprint (a secret rotated but not yet re-synced) must
			// degrade to the URL join, like an entry with no fingerprint at all.
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-old:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							modelCount: 2,
						}),
						models: [],
					},
				],
				makeReader({}),
				[makeDeclared({ label: "Prod", baseUrl: "http://x.test/", expectedClientId: "group:fp-new:http://x.test" })]
			);

			assert.strictEqual(state.servers.length, 1, "no duplicate external row");
			assert.strictEqual(state.servers[0]?.modelCount, 2);
		});

		test("two declared entries mirroring one pre-label group share its snapshot instead of one reading unchecked", () => {
			// Two entries, one URL, one key: groups created before labels flowed
			// into their configurations report under ONE label-agnostic identity.
			// Both entries carry it as expectedConnectionId, and both rows must
			// render the live status - honest shared state beats a second row
			// stuck on "not checked" forever.
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-shared:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							modelCount: 3,
						}),
						models: [],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-prod-labeled:http://x.test",
						expectedConnectionId: "group:fp-shared:http://x.test",
					}),
					makeDeclared({
						label: "Staging",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-staging-labeled:http://x.test",
						expectedConnectionId: "group:fp-shared:http://x.test",
					}),
				]
			);

			const byLabel = new Map(state.servers.map((server) => [server.label, server]));
			assert.strictEqual(state.servers.length, 2, "no third external row for the shared snapshot");
			assert.strictEqual(byLabel.get("Prod")?.state, "ok");
			assert.strictEqual(byLabel.get("Prod")?.modelCount, 3);
			assert.strictEqual(byLabel.get("Staging")?.state, "ok", "the second entry shares the live status");
			assert.strictEqual(byLabel.get("Staging")?.modelCount, 3);
			assert.ok(!JSON.stringify(state).includes("fp-shared"), "the join key never reaches the webview state");
		});

		test("a snapshot shared by two declared entries lists its models under both labels", () => {
			// The host registers a group's models once PER GROUP (the picker shows
			// both servers' copies), so a pre-label snapshot claimed by several
			// declared entries must attribute its models to every claimant, not
			// render them once under the first label.
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-shared:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							modelCount: 2,
						}),
						models: [makeModelInfo({ id: "m1", name: "m1" }), makeModelInfo({ id: "m2", name: "m2" })],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-prod-labeled:http://x.test",
						expectedConnectionId: "group:fp-shared:http://x.test",
					}),
					makeDeclared({
						label: "Staging",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-staging-labeled:http://x.test",
						expectedConnectionId: "group:fp-shared:http://x.test",
					}),
				]
			);

			assert.deepStrictEqual(
				state.models.map((m) => `${m.serverLabel}/${m.name}`),
				["Prod/m1", "Prod/m2", "Staging/m1", "Staging/m2"]
			);
		});

		test("an upsertFailed claimant gets no models copy; its row still shows the shared status", () => {
			// One pre-label group exists and a second same-connection entry's
			// group add FAILED outright: the engine still emits the entry's
			// connection identity, so it claims the snapshot - but the picker has
			// ONE group, and duplicating the models would overcount it.
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-shared:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							modelCount: 2,
						}),
						models: [makeModelInfo({ id: "m1", name: "m1" }), makeModelInfo({ id: "m2", name: "m2" })],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://x.test",
						expectedConnectionId: "group:fp-shared:http://x.test",
					}),
					makeDeclared({
						label: "Staging",
						baseUrl: "http://x.test",
						expectedConnectionId: "group:fp-shared:http://x.test",
						syncError: "The host rejected the provider group upsert",
						syncErrorClass: "upsertFailed",
					}),
				]
			);

			assert.deepStrictEqual(
				state.models.map((m) => `${m.serverLabel}/${m.name}`),
				["Prod/m1", "Prod/m2"]
			);
			const staging = state.servers.find((server) => server.label === "Staging");
			assert.strictEqual(staging?.state, "ok", "the shared live status still rides the row");
			assert.strictEqual(staging?.modelCount, 2);
			assert.strictEqual(staging?.error, "The host rejected the provider group upsert");
		});

		test("a blocked claimant keeps its models copy: the duplicate refusal proves its group exists", () => {
			// A name-conflict refusal means a live group with that name IS
			// registering models; dropping the copy would under-report the picker.
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-shared:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							modelCount: 1,
						}),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://x.test",
						expectedConnectionId: "group:fp-shared:http://x.test",
					}),
					makeDeclared({
						label: "Staging",
						baseUrl: "http://x.test",
						expectedConnectionId: "group:fp-shared:http://x.test",
						syncError: "A provider group with this name already exists",
						syncErrorClass: "blocked",
					}),
				]
			);

			assert.deepStrictEqual(
				state.models.map((m) => `${m.serverLabel}/${m.name}`),
				["Prod/m1", "Staging/m1"]
			);
		});

		test("a snapshot whose only claimant is upsertFailed still lists its models once, under that label", () => {
			// The reporting group exists and serves (the snapshot is its live
			// report), so the models cannot vanish just because the entry's last
			// add failed; they render once, not zero times.
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-shared:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							modelCount: 1,
						}),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://x.test",
						expectedConnectionId: "group:fp-shared:http://x.test",
						syncError: "The host rejected the provider group upsert",
						syncErrorClass: "upsertFailed",
					}),
				]
			);

			assert.deepStrictEqual(
				state.models.map((m) => `${m.serverLabel}/${m.name}`),
				["Prod/m1"]
			);
		});

		test("two labeled groups on one connection each list their own copy of the models", () => {
			// The post-identity shape of the same setup: distinct labeled
			// snapshots carrying the same raw model IDs stay two registrations,
			// one row per server per model, matching the picker.
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({
							serverId: "group:labeled:fp-a:http://x.test",
							label: "Prod",
							baseUrl: "http://x.test",
							modelCount: 1,
						}),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
					{
						status: makeServerStatus({
							serverId: "group:labeled:fp-b:http://x.test",
							label: "Staging",
							baseUrl: "http://x.test",
							modelCount: 1,
						}),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://x.test",
						expectedClientId: "group:labeled:fp-a:http://x.test",
					}),
					makeDeclared({
						label: "Staging",
						baseUrl: "http://x.test",
						expectedClientId: "group:labeled:fp-b:http://x.test",
					}),
				]
			);

			assert.deepStrictEqual(
				state.models.map((m) => `${m.serverLabel}/${m.name}`),
				["Prod/m1", "Staging/m1"]
			);
		});

		test("an entry with modelParameters served by a pre-label group flags the inactive parameters", () => {
			// The connection-identity join means the live group carries no label,
			// so the request path never applies this entry's parameters. The row
			// must warn instead of rendering silently healthy - but only via the
			// classification; the copy stays webview-side.
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-shared:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							modelCount: 3,
						}),
						models: [],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-prod-labeled:http://x.test",
						expectedConnectionId: "group:fp-shared:http://x.test",
						modelParameters: { "gpt-4": { temperature: 0.2 } },
					}),
					makeDeclared({
						label: "Staging",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-staging-labeled:http://x.test",
						expectedConnectionId: "group:fp-shared:http://x.test",
					}),
				]
			);

			const byLabel = new Map(state.servers.map((server) => [server.label, server]));
			assert.strictEqual(byLabel.get("Prod")?.notice, "entry-params-inactive");
			assert.strictEqual(byLabel.get("Prod")?.state, "ok", "the notice never degrades the live status");
			assert.strictEqual(byLabel.get("Staging")?.notice, undefined, "no entry parameters, nothing to flag");
		});

		test("an entry with modelParameters joined by its exact labeled identity carries no notice", () => {
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-prod-labeled:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							modelCount: 3,
						}),
						models: [],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-prod-labeled:http://x.test",
						expectedConnectionId: "group:fp-shared:http://x.test",
						modelParameters: { "gpt-4": { temperature: 0.2 } },
					}),
				]
			);

			assert.strictEqual(state.servers[0]?.notice, undefined, "a labeled group serves the entry's parameters");
		});

		test("an entry with modelParameters joined by the label-and-URL fallback still flags them", () => {
			// The snapshot's display label is the URL host, so this pass can match
			// an unlabeled group whose credentials differ from the entry (neither
			// identity joins). Only the exact labeled-identity join proves the
			// group carries the entry's label; anything else must warn.
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-other:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							modelCount: 3,
						}),
						models: [],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "x.test",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-labeled:http://x.test",
						expectedConnectionId: "group:fp-conn:http://x.test",
						modelParameters: { "gpt-4": { temperature: 0.2 } },
					}),
				]
			);

			assert.strictEqual(state.servers[0]?.notice, "entry-params-inactive");
			assert.strictEqual(state.servers[0]?.state, "ok", "the notice never degrades the live status");
		});

		test("an entry with modelParameters joined by the URL-only fallback still flags them", () => {
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-other:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							modelCount: 3,
						}),
						models: [],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-labeled:http://x.test",
						expectedConnectionId: "group:fp-conn:http://x.test",
						modelParameters: { "gpt-4": { temperature: 0.2 } },
					}),
				]
			);

			assert.strictEqual(state.servers[0]?.notice, "entry-params-inactive");
		});

		test("the shared pass never crosses connections: a different-credential entry keeps its own outcome", () => {
			// One live group under key A. The entry declaring key B shares only
			// the URL, not the connection, so handing it key A's status would
			// claim a server it cannot reach is healthy; it must stay unchecked
			// (the URL fallback finds the snapshot already claimed).
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-a:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							modelCount: 3,
						}),
						models: [],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "KeyA",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-a-labeled:http://x.test",
						expectedConnectionId: "group:fp-a:http://x.test",
					}),
					makeDeclared({
						label: "KeyB",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-b-labeled:http://x.test",
						expectedConnectionId: "group:fp-b:http://x.test",
					}),
				]
			);

			const byLabel = new Map(state.servers.map((server) => [server.label, server]));
			assert.strictEqual(byLabel.get("KeyA")?.state, "ok");
			assert.strictEqual(byLabel.get("KeyB")?.state, "unchecked", "a different connection never shares status");
		});

		test("a declared entry no discovery pass has seen renders unchecked; a sync failure renders as its error", () => {
			const state = buildDashboardState([], makeReader({}), [
				makeDeclared({ label: "New", baseUrl: "http://new.test" }),
				makeDeclared({ label: "Broken", baseUrl: "http://broken.test", syncError: "upsert refused" }),
			]);

			const byLabel = new Map(state.servers.map((server) => [server.label, server]));
			assert.strictEqual(byLabel.get("New")?.state, "unchecked");
			assert.strictEqual(byLabel.get("New")?.lastChecked, undefined);
			assert.strictEqual(byLabel.get("Broken")?.state, "error");
			assert.strictEqual(byLabel.get("Broken")?.error, "upsert refused");
		});

		test("a sync error rides a reachable row without erasing the live facts", () => {
			// The host cannot update a group, so the reachable "ok" group is the
			// entry's OLD configuration. The sync error must not be hidden (the
			// error field carries it, outranking any live error text), while the
			// live state and counts keep rendering - diagnostics prints them
			// side by side ("OK (N models) - <sync error>").
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({ label: "Prod", baseUrl: "http://prod.test", state: "ok", modelCount: 4 }),
						models: [],
					},
				],
				makeReader({}),
				[makeDeclared({ label: "Prod", baseUrl: "http://prod.test", syncError: "group update unavailable" })]
			);

			assert.strictEqual(state.servers.length, 1);
			assert.strictEqual(state.servers[0]?.state, "ok", "the live group is genuinely serving");
			assert.strictEqual(state.servers[0]?.error, "group update unavailable");
			assert.strictEqual(state.servers[0]?.modelCount, 4);
		});

		test("external rows carry an opaque, push-stable adopt handle; declared rows do not", () => {
			const snapshots = [
				{
					status: makeServerStatus({
						serverId: "group:fp-a:http://ext.test",
						label: "ext.test",
						baseUrl: "http://ext.test",
					}),
					models: [],
				},
				{
					status: makeServerStatus({
						serverId: "group:fp-b:http://prod.test",
						label: "Prod",
						baseUrl: "http://prod.test",
					}),
					models: [],
				},
			];
			const declared = [makeDeclared({ label: "Prod", baseUrl: "http://prod.test" })];
			const state = buildDashboardState(snapshots, makeReader({}), declared);

			const byLabel = new Map(state.servers.map((server) => [server.label, server]));
			const external = byLabel.get("ext.test");
			assert.strictEqual(external?.origin, "external");
			assert.ok(typeof external?.adoptHandle === "string" && external.adoptHandle.length > 0);
			assert.strictEqual(byLabel.get("Prod")?.adoptHandle, undefined, "declared rows are not adoptable");
			// The webview holds a handle across background refreshes, so a rebuild
			// must mint the same one; and the handle must not leak what it derives
			// from (the serverId embeds the group's credential fingerprint).
			const rebuilt = buildDashboardState(snapshots, makeReader({}), declared);
			assert.strictEqual(rebuilt.servers.find((s) => s.label === "ext.test")?.adoptHandle, external.adoptHandle);
			assert.ok(!JSON.stringify(state).includes("fp-a"), "the handle never exposes the serverId it derives from");
		});

		test("no secret value ever reaches the state, only locations", () => {
			const state = buildDashboardState(
				[{ status: makeServerStatus({ hasApiKey: true }), models: [] }],
				makeReader({}),
				[makeDeclared({ secrets: { apiKey: "settings", oauthClientSecret: "secure", virtualKeyValue: "none" } })]
			);

			const serialized = JSON.stringify(state);
			assert.ok(!serialized.includes("sk-"), serialized);
			assert.ok(serialized.includes('"apiKey":"settings"'), "locations are reported");
		});

		test("colliding server labels get positional suffixes, on the servers and their models", () => {
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({ serverId: "s1", label: "litellm.test", baseUrl: "http://litellm.test" }),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
					{
						status: makeServerStatus({ serverId: "s2", label: "litellm.test", baseUrl: "http://litellm.test" }),
						models: [makeModelInfo({ id: "m2", name: "m2" })],
					},
					{ status: makeServerStatus({ serverId: "s3", label: "Other" }), models: [] },
				],
				makeReader({})
			);

			assert.deepStrictEqual(
				state.servers.map((s) => s.label),
				["litellm.test (1)", "litellm.test (2)", "Other"]
			);
			assert.deepStrictEqual(
				state.models.map((m) => m.serverLabel),
				["litellm.test (1)", "litellm.test (2)"]
			);
		});

		test("no serverId reaches the state", () => {
			const state = buildDashboardState(
				[{ status: makeServerStatus({ serverId: "group:secret-fingerprint:http://x" }), models: [makeModelInfo()] }],
				makeReader({})
			);

			assert.ok(!JSON.stringify(state).includes("secret-fingerprint"));
		});

		test("maps model infos to display facts including pricing and badges", () => {
			const info = makeModelInfo({
				id: "claude",
				name: "claude",
				family: "anthropic",
				inputCost: 3,
				outputCost: 15,
				cacheCost: 0.3,
				cacheWriteCost: 3.75,
				longContextInputCost: 6,
				longContextOutputCost: 22.5,
				capabilities: { toolCalling: true, imageInput: true },
				configurationSchema: REASONING_EFFORT_SCHEMA,
				litellm: { supportsPromptCaching: true, outputLimitSource: "provider" },
			});
			const state = buildDashboardState([{ status: makeServerStatus(), models: [info] }], makeReader({}));

			assert.strictEqual(state.models.length, 1);
			const model = state.models[0];
			assert.deepStrictEqual(model, {
				id: "claude",
				name: "claude",
				family: "anthropic",
				serverLabel: "Prod",
				maxInputTokens: 100000,
				maxOutputTokens: 8000,
				inputCost: 3,
				outputCost: 15,
				cacheReadCost: 0.3,
				cacheWriteCost: 3.75,
				longContextInputCost: 6,
				longContextOutputCost: 22.5,
				longContextCacheReadCost: undefined,
				longContextCacheWriteCost: undefined,
				toolCalling: true,
				imageInput: true,
				promptCaching: true,
				reasoning: true,
			});
		});

		test("models without pricing or capabilities stay minimal", () => {
			const state = buildDashboardState([{ status: makeServerStatus(), models: [makeModelInfo()] }], makeReader({}));

			const model = state.models[0];
			assert.strictEqual(model?.inputCost, undefined);
			assert.strictEqual(model?.toolCalling, false);
			assert.strictEqual(model?.imageInput, false);
			assert.strictEqual(model?.promptCaching, false);
			assert.strictEqual(model?.reasoning, false);
		});

		test("models from several servers are flattened and sorted by server label then name", () => {
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({ serverId: "srv2", label: "Zeta" }),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
					{
						status: makeServerStatus({ serverId: "srv1", label: "Alpha" }),
						models: [makeModelInfo({ id: "b", name: "b" }), makeModelInfo({ id: "a", name: "a" })],
					},
				],
				makeReader({})
			);

			assert.deepStrictEqual(
				state.models.map((m) => `${m.serverLabel}/${m.name}`),
				["Alpha/a", "Alpha/b", "Zeta/m1"]
			);
		});
	});

	suite("buildDashboardState: removed groups", () => {
		test("a tombstoned external snapshot leaves the table and the models list for hiddenGroups", () => {
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({ serverId: "g1", label: "Prod", baseUrl: "http://prod.test" }),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
					{
						status: makeServerStatus({ serverId: "g2", label: "Live", baseUrl: "http://live.test" }),
						models: [makeModelInfo({ id: "m2", name: "m2" })],
					},
				],
				makeReader({}),
				[],
				[],
				{ tombstones: [{ label: "Prod", baseUrl: "http://prod.test" }], origins: [] }
			);

			assert.deepStrictEqual(
				state.servers.map((server) => server.label),
				["Live"],
				"the tombstoned row is gone"
			);
			assert.deepStrictEqual(
				state.models.map((model) => model.serverLabel),
				["Live"],
				"the tombstoned snapshot contributes no models"
			);
			assert.deepStrictEqual(state.hiddenGroups, [{ label: "Prod", baseUrl: "http://prod.test" }]);
		});

		test("tombstones suppress by the raw status label, not the display ordinal", () => {
			// Two external groups share a label, so the table would render "Dup
			// (1)" and "Dup (2)"; the tombstone still stores the raw identity.
			const state = buildDashboardState(
				[
					{ status: makeServerStatus({ serverId: "g1", label: "Dup", baseUrl: "http://a.test" }), models: [] },
					{ status: makeServerStatus({ serverId: "g2", label: "Dup", baseUrl: "http://b.test" }), models: [] },
				],
				makeReader({}),
				[],
				[],
				{ tombstones: [{ label: "Dup", baseUrl: "http://b.test" }], origins: [] }
			);

			assert.deepStrictEqual(
				state.servers.map((server) => server.baseUrl),
				["http://a.test"],
				"exactly the tombstoned identity hides"
			);
		});

		test("a declared row is never suppressed, even when a tombstone matches its identity", () => {
			// The engine auto-clears such a tombstone on its next pass; until then
			// the declared entry the user just wrote must keep rendering.
			const state = buildDashboardState(
				[{ status: makeServerStatus({ label: "Prod", baseUrl: "http://prod.test" }), models: [] }],
				makeReader({}),
				[makeDeclared()],
				[],
				{ tombstones: [{ label: "Prod", baseUrl: "http://prod.test" }], origins: [] }
			);

			assert.strictEqual(state.servers.length, 1);
			assert.strictEqual(state.servers[0]?.origin, "declared");
		});

		test("hidden groups persist without a live snapshot, so unhide stays offered", () => {
			const state = buildDashboardState([], makeReader({}), [], [], {
				tombstones: [{ label: "Gone", baseUrl: "http://gone.test" }],
				origins: [],
			});

			assert.deepStrictEqual(state.servers, []);
			assert.deepStrictEqual(state.hiddenGroups, [{ label: "Gone", baseUrl: "http://gone.test" }]);
		});

		test("a registry-backed snapshot is never suppressed and its row is not hideable", () => {
			// In test mode (and pre-migration) the legacy registry contributes
			// external-looking rows; the registry sweep would keep serving their
			// models, so a tombstone must not hide them and the row offers no
			// Remove (hideable false).
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({ serverId: "registry-1", label: "Legacy", baseUrl: "http://legacy.test" }),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
				],
				makeReader({}),
				[],
				[],
				{ tombstones: [{ label: "Legacy", baseUrl: "http://legacy.test" }], origins: [] },
				() => false
			);

			assert.strictEqual(state.servers.length, 1, "the registry row stays visible");
			assert.strictEqual(state.servers[0]?.hideable, false);
			assert.strictEqual(state.models.length, 1, "its models stay listed");
			assert.deepStrictEqual(
				state.hiddenGroups,
				[{ label: "Legacy", baseUrl: "http://legacy.test" }],
				"the stale tombstone still lists, so it stays unhideable-away"
			);
		});

		test("group-backed external rows are hideable by default", () => {
			const state = buildDashboardState(
				[{ status: makeServerStatus({ serverId: "g1", label: "Prod" }), models: [] }],
				makeReader({})
			);
			assert.strictEqual(state.servers[0]?.hideable, true);
		});

		test("external rows carry their recorded provenance; unrecorded rows carry none", () => {
			const state = buildDashboardState(
				[
					{ status: makeServerStatus({ serverId: "g1", label: "Old", baseUrl: "http://host.test" }), models: [] },
					{ status: makeServerStatus({ serverId: "g2", label: "Other", baseUrl: "http://other.test" }), models: [] },
				],
				makeReader({}),
				[],
				[],
				{
					tombstones: [],
					origins: [
						{
							label: "Old",
							baseUrl: "http://host.test",
							origin: { kind: "rename-leftover", oldLabel: "Old", newLabel: "New" },
						},
					],
				}
			);

			const oldRow = state.servers.find((server) => server.label === "Old");
			const otherRow = state.servers.find((server) => server.label === "Other");
			assert.deepStrictEqual(oldRow?.provenance, { kind: "rename-leftover", oldLabel: "Old", newLabel: "New" });
			assert.strictEqual(otherRow?.provenance, undefined, "no recorded origin renders the honest default");
		});
	});

	suite("readDashboardSettings", () => {
		test("passes configured finite numbers through, even out of range", () => {
			const settings = readDashboardSettings(makeReader({ requestTimeout: 5, defaultMaxOutputTokens: 32000 }));

			assert.strictEqual(settings.numbers.requestTimeout, 5);
			assert.strictEqual(settings.numbers.defaultMaxOutputTokens, 32000);
		});

		test("falls back to the package.json default for unusable values", () => {
			const settings = readDashboardSettings(
				makeReader(
					{ requestTimeout: "soon", discoveryTimeout: Number.NaN },
					{ requestTimeout: 300000, discoveryTimeout: 30000 }
				)
			);

			assert.strictEqual(settings.numbers.requestTimeout, 300000);
			assert.strictEqual(settings.numbers.discoveryTimeout, 30000);
		});

		test("without a usable default, non-nullable numbers fall back to the minimum and nullable ones to null", () => {
			const settings = readDashboardSettings(makeReader({ requestTimeout: "soon", defaultMaxInputTokens: "many" }));

			assert.strictEqual(settings.numbers.requestTimeout, 1000);
			assert.strictEqual(settings.numbers.defaultMaxInputTokens, null);
		});

		test("nullable numbers keep null and configured values", () => {
			assert.strictEqual(
				readDashboardSettings(makeReader({ defaultMaxInputTokens: null })).numbers.defaultMaxInputTokens,
				null
			);
			assert.strictEqual(
				readDashboardSettings(makeReader({ defaultMaxInputTokens: 90000 })).numbers.defaultMaxInputTokens,
				90000
			);
		});

		test("booleans pass through and fall back to the default for junk", () => {
			const settings = readDashboardSettings(
				makeReader({ "promptCaching.enabled": false, maskApiKeyInput: "yes" }, { maskApiKeyInput: true })
			);

			assert.strictEqual(settings.booleans["promptCaching.enabled"], false);
			assert.strictEqual(settings.booleans.maskApiKeyInput, true);
		});

		test("every catalog entry is present in the snapshot", () => {
			const settings = readDashboardSettings(makeReader({}));

			for (const id of NUMBER_SETTING_IDS) {
				assert.ok(id in settings.numbers, `missing number setting ${id}`);
				assert.ok(id in settings.configuredScopes.numbers, `missing number scope ${id}`);
			}
			for (const id of BOOLEAN_SETTING_IDS) {
				assert.ok(id in settings.booleans, `missing boolean setting ${id}`);
				assert.ok(id in settings.configuredScopes.booleans, `missing boolean scope ${id}`);
			}
		});

		test("configuredScopes carry the highest scope that sets the key, or null when only the default applies", () => {
			const settings = readDashboardSettings(
				makeReader(
					{ requestTimeout: 60000, maskApiKeyInput: true },
					{},
					{
						discoveryTimeout: { workspaceValue: 5000 },
						discoveryCacheTtl: { globalValue: 1, workspaceValue: 2, workspaceFolderValue: 3 },
					}
				)
			);

			assert.strictEqual(settings.configuredScopes.numbers.requestTimeout, "global");
			assert.strictEqual(settings.configuredScopes.numbers.discoveryTimeout, "workspace");
			assert.strictEqual(settings.configuredScopes.numbers.discoveryCacheTtl, "workspaceFolder");
			assert.strictEqual(settings.configuredScopes.numbers.defaultMaxOutputTokens, null);
			assert.strictEqual(settings.configuredScopes.booleans.maskApiKeyInput, "global");
			assert.strictEqual(settings.configuredScopes.booleans["promptCaching.enabled"], null);
		});

		test("a value pinned to exactly its default still counts as configured", () => {
			const settings = readDashboardSettings(makeReader({ requestTimeout: 300000 }, { requestTimeout: 300000 }));

			assert.strictEqual(settings.numbers.requestTimeout, 300000);
			assert.strictEqual(settings.configuredScopes.numbers.requestTimeout, "global");
		});

		test("records come from the edit scope's own value, never the merged one", () => {
			const settings = readDashboardSettings(
				makeReader(
					{ headers: { "x-user": "secret", "x-shared": "team" } },
					{},
					{
						headers: {
							globalValue: { "x-user": "secret" },
							workspaceValue: { "x-shared": "team" },
						},
					}
				)
			);

			assert.strictEqual(settings.headers.editScope, "workspace");
			assert.deepStrictEqual(settings.headers.value, { "x-shared": "team" }, "the user-scope secret must not leak in");
			assert.deepStrictEqual(settings.headers.otherScopes, [{ scope: "global", value: { "x-user": "secret" } }]);
		});

		test("records default to the user scope when only it holds a value", () => {
			const settings = readDashboardSettings(
				makeReader({}, {}, { modelParameters: { globalValue: { "gpt-4": { temperature: 0.2 } } } })
			);

			assert.strictEqual(settings.modelParameters.editScope, "global");
			assert.deepStrictEqual(settings.modelParameters.value, { "gpt-4": { temperature: 0.2 } });
			assert.deepStrictEqual(settings.modelParameters.otherScopes, []);
		});

		test("a workspace-folder record shows up read-only and never becomes the edit scope", () => {
			const settings = readDashboardSettings(
				makeReader({}, {}, { headers: { workspaceFolderValue: { "x-folder": "v" } } })
			);

			assert.strictEqual(settings.headers.editScope, "global");
			assert.deepStrictEqual(settings.headers.otherScopes, [{ scope: "workspaceFolder", value: { "x-folder": "v" } }]);
		});

		test("modelParameters drops malformed and prototype-polluting entries but keeps the rest", () => {
			const settings = readDashboardSettings(
				makeReader(
					{},
					{},
					{
						modelParameters: {
							globalValue: JSON.parse(
								'{"gpt-4": {"temperature": 0.2}, "broken": "not-an-object", "__proto__": {"polluted": true}}'
							) as unknown,
						},
					}
				)
			);

			assert.deepStrictEqual(settings.modelParameters.value, { "gpt-4": { temperature: 0.2 } });
		});

		test("headers keep configured scalar types and drop non-scalars and unsafe keys", () => {
			const settings = readDashboardSettings(
				makeReader(
					{},
					{},
					{
						headers: {
							globalValue: JSON.parse(
								'{"x-key": "abc", "x-count": 2, "x-flag": true, "x-bad": {"nested": 1}, "__proto__": {"polluted": true}}'
							) as unknown,
						},
					}
				)
			);

			assert.deepStrictEqual(settings.headers.value, { "x-key": "abc", "x-count": 2, "x-flag": true });
		});

		test("a non-object headers or modelParameters value reads as empty", () => {
			const settings = readDashboardSettings(
				makeReader({}, {}, { headers: { globalValue: 7 }, modelParameters: { globalValue: [1, 2] } })
			);

			assert.deepStrictEqual(settings.headers.value, {});
			assert.deepStrictEqual(settings.modelParameters.value, {});
		});
	});

	suite("resolveUpdateScope", () => {
		test("workspace when the workspace holds a value, user scope otherwise", () => {
			assert.strictEqual(resolveUpdateScope({ workspaceValue: 2 }), "workspace");
			assert.strictEqual(resolveUpdateScope({}), "global");
			assert.strictEqual(resolveUpdateScope(undefined), "global");
		});

		test("never returns workspaceFolder: resource-less folder updates would throw", () => {
			const inspection: SettingsInspection = { workspaceFolderValue: 1 };
			assert.strictEqual(resolveUpdateScope(inspection), "global");
		});
	});

	suite("resolveConfiguredScope", () => {
		test("the highest-precedence configured scope wins; unconfigured keys resolve to null", () => {
			assert.strictEqual(
				resolveConfiguredScope({ globalValue: 1, workspaceValue: 2, workspaceFolderValue: 3 }),
				"workspaceFolder"
			);
			assert.strictEqual(resolveConfiguredScope({ globalValue: 1, workspaceValue: 2 }), "workspace");
			assert.strictEqual(resolveConfiguredScope({ globalValue: 1 }), "global");
			assert.strictEqual(resolveConfiguredScope({ defaultValue: 300000 }), null);
			assert.strictEqual(resolveConfiguredScope(undefined), null);
		});

		test("a folder value alone is the reset target even though writes never land there", () => {
			assert.strictEqual(resolveConfiguredScope({ workspaceFolderValue: 1 }), "workspaceFolder");
		});
	});

	suite("webviewMessageSchema", () => {
		test("accepts every intent shape", () => {
			const intents: unknown[] = [
				{ type: "ready" },
				{ type: "setNumberSetting", setting: "requestTimeout", value: 60000 },
				{ type: "setNumberSetting", setting: "defaultMaxInputTokens", value: null },
				{ type: "setBooleanSetting", setting: "promptCaching.enabled", value: false },
				{ type: "resetSetting", setting: "requestTimeout" },
				{ type: "resetSetting", setting: "maskApiKeyInput" },
				{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2, stop: ["\n"] } } },
				{ type: "setHeaders", value: { "x-key": "v", "x-n": 2, "x-b": true } },
				{
					type: "saveServerSetting",
					server: { label: "Prod", baseUrl: "http://prod.test" },
					secrets: KEEP_ALL,
					requestId: "req-1",
				},
				{
					type: "saveServerSetting",
					server: {
						label: "Prod",
						baseUrl: "http://prod.test",
						oauthTokenUrl: "https://idp.test/token",
						oauthClientId: "client",
						oauthScopes: "read",
						virtualKeyHeader: "x-litellm-api-key",
					},
					secrets: {
						apiKey: { action: "set", location: "secure", value: "sk-1" },
						oauthClientSecret: { action: "clear" },
						virtualKeyValue: { action: "set", location: "settings", value: "vk-1" },
					},
					replaceLabel: "Old Prod",
					requestId: "req-2",
				},
				{ type: "removeServerSetting", label: "Prod", requestId: "req-3" },
				{ type: "readInlineSecrets", label: "Prod", requestId: "req-inline" },
				{
					type: "adoptServer",
					label: "Adopted",
					baseUrl: "http://ext.test",
					sourceHandle: "handle-ext",
					secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "settings" },
					requestId: "req-4",
				},
				{ type: "executeCommand", command: "syncModels" },
			];
			for (const intent of intents) {
				assert.ok(webviewMessageSchema.safeParse(intent).success, `rejected ${JSON.stringify(intent)}`);
			}
		});

		test("rejects unknown types, unknown settings, unknown commands, and extra fields", () => {
			const rejected: unknown[] = [
				null,
				"ready",
				{ type: "detonate" },
				{ type: "setNumberSetting", setting: "notASetting", value: 1 },
				{ type: "setNumberSetting", setting: "requestTimeout", value: "1000" },
				{ type: "setNumberSetting", setting: "requestTimeout", value: Number.POSITIVE_INFINITY },
				{ type: "setBooleanSetting", setting: "promptCaching.enabled", value: "true" },
				{ type: "resetSetting", setting: "notASetting" },
				{ type: "resetSetting", setting: "requestTimeout", value: 1 },
				{ type: "setHeaders", value: { "x-bad": { nested: true } } },
				{ type: "executeCommand", command: "workbench.action.terminal.sendSequence" },
				{ type: "ready", extra: 1 },
				// saveServerSetting: strict everywhere, so no field rides along into the setting.
				{ type: "saveServerSetting", server: { label: "P", baseUrl: "http://x" }, requestId: "r" },
				{ type: "saveServerSetting", server: { label: "P" }, secrets: KEEP_ALL, requestId: "r" },
				{ type: "saveServerSetting", server: { baseUrl: "http://x" }, secrets: KEEP_ALL, requestId: "r" },
				{ type: "saveServerSetting", server: { label: "P", baseUrl: "http://x" }, secrets: KEEP_ALL },
				{ type: "saveServerSetting", server: { label: "P", baseUrl: "http://x" }, secrets: KEEP_ALL, requestId: "" },
				{
					type: "saveServerSetting",
					server: { label: "P", baseUrl: "http://x", apiKey: "inline-not-allowed-here" },
					secrets: KEEP_ALL,
					requestId: "r",
				},
				{
					type: "saveServerSetting",
					server: { label: "P", baseUrl: "http://x" },
					secrets: { ...KEEP_ALL, apiKey: { action: "set", value: "missing-location" } },
					requestId: "r",
				},
				{
					type: "saveServerSetting",
					server: { label: "P", baseUrl: "http://x" },
					secrets: { ...KEEP_ALL, apiKey: { action: "keep", value: "extra" } },
					requestId: "r",
				},
				{
					type: "saveServerSetting",
					server: { label: "P", baseUrl: "http://x" },
					secrets: { apiKey: { action: "keep" } },
					requestId: "r",
				},
				{ type: "removeServerSetting", requestId: "r" },
				{ type: "removeServerSetting", label: 4, requestId: "r" },
				{ type: "removeServerSetting", label: "P" },
				// readInlineSecrets: label and requestId only, nothing rides along.
				{ type: "readInlineSecrets", requestId: "r" },
				{ type: "readInlineSecrets", label: "P" },
				{ type: "readInlineSecrets", label: "P", requestId: "" },
				{ type: "readInlineSecrets", label: "P", requestId: "r", field: "apiKey" },
				// adoptServer: never a credential value, only storage locations.
				{
					type: "adoptServer",
					label: "A",
					baseUrl: "http://x",
					sourceHandle: "x",
					secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
				},
				{
					type: "adoptServer",
					label: "A",
					baseUrl: "http://x",
					sourceHandle: "x",
					secrets: { apiKey: "keychain", oauthClientSecret: "secure", virtualKeyValue: "secure" },
					requestId: "r",
				},
				{
					type: "adoptServer",
					label: "A",
					baseUrl: "http://x",
					sourceHandle: "x",
					secrets: { apiKey: "secure", oauthClientSecret: "secure" },
					requestId: "r",
				},
				{
					type: "adoptServer",
					label: "A",
					baseUrl: "http://x",
					sourceHandle: "x",
					secrets: {
						apiKey: "secure",
						oauthClientSecret: "secure",
						virtualKeyValue: "secure",
						apiKeyValue: "sk-smuggled",
					},
					requestId: "r",
				},
				{
					type: "adoptServer",
					label: "A",
					baseUrl: "http://x",
					secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
					requestId: "r",
				},
				{
					type: "adoptServer",
					label: "A",
					baseUrl: "http://x",
					sourceHandle: "",
					secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
					requestId: "r",
				},
			];
			for (const message of rejected) {
				assert.strictEqual(
					webviewMessageSchema.safeParse(message).success,
					false,
					`accepted ${JSON.stringify(message)}`
				);
			}
		});
	});

	suite("readInlineSecretValues", () => {
		const setting = [
			"junk entry",
			{ label: "Inline", baseUrl: "http://a.test", apiKey: " sk-inline ", virtualKeyValue: "vk-inline" },
			{ label: "Secure", baseUrl: "http://b.test" },
			{ label: "Mixed", baseUrl: "http://c.test", apiKey: "sk-mixed", oauthClientSecret: "   " },
		];

		test("returns inline values trimmed, one key per inline-stored field", () => {
			assert.deepStrictEqual(readInlineSecretValues(setting, "Inline"), {
				apiKey: "sk-inline",
				virtualKeyValue: "vk-inline",
			});
		});

		test("secure-side and absent fields get no key at all: absence, not an empty string", () => {
			// "Secure" holds nothing inline; whatever its SecretStorage blob holds
			// is not consulted here and must never come back.
			assert.deepStrictEqual(readInlineSecretValues(setting, "Secure"), {});
			const mixed = readInlineSecretValues(setting, "Mixed");
			assert.deepStrictEqual(mixed, { apiKey: "sk-mixed" });
			assert.ok(!("oauthClientSecret" in mixed), "a whitespace-only inline value counts as absent");
			assert.ok(!("virtualKeyValue" in mixed));
		});

		test("an unknown label, a junk setting, and a non-string field value all yield an empty record", () => {
			assert.deepStrictEqual(readInlineSecretValues(setting, "Nope"), {});
			assert.deepStrictEqual(readInlineSecretValues("not an array", "Inline"), {});
			assert.deepStrictEqual(readInlineSecretValues(undefined, "Inline"), {});
			assert.deepStrictEqual(readInlineSecretValues([{ label: "N", baseUrl: "http://x", apiKey: 42 }], "N"), {});
		});

		test("labels match trimmed, like entry lookup everywhere else", () => {
			assert.deepStrictEqual(
				readInlineSecretValues([{ label: " Prod ", baseUrl: "http://x", apiKey: "sk-1" }], "Prod"),
				{
					apiKey: "sk-1",
				}
			);
		});

		test("resolution agrees with parseServersSetting: a rejected same-label sibling cannot shadow the accepted entry", () => {
			// The first raw entry carries the label but has no usable baseUrl, so
			// the parser rejects it and the dashboard row describes the SECOND
			// entry; the prefill must read that same entry.
			const shadowed = [
				{ label: "Prod", apiKey: "sk-shadow" },
				{ label: "Prod", baseUrl: "http://real.test", apiKey: "sk-real" },
			];
			assert.deepStrictEqual(readInlineSecretValues(shadowed, "Prod"), { apiKey: "sk-real" });
		});

		test("a label the parser rejects yields nothing, even when a raw entry carries inline fields under it", () => {
			// The dashboard never declares this entry (reserved label), so a
			// crafted request must not be able to read its inline fields.
			const rejected = [{ label: "__proto__", baseUrl: "http://x.test", apiKey: "sk-hidden" }];
			assert.deepStrictEqual(readInlineSecretValues(rejected, "__proto__"), {});
		});

		test("duplicate accepted labels resolve to the first, matching the parser's first-entry-wins rule", () => {
			const duplicated = [
				{ label: "Prod", baseUrl: "http://a.test", apiKey: "sk-first" },
				{ label: "Prod", baseUrl: "http://b.test", apiKey: "sk-second" },
			];
			assert.deepStrictEqual(readInlineSecretValues(duplicated, "Prod"), { apiKey: "sk-first" });
		});
	});

	suite("intent value validation", () => {
		test("validateNumberSetting enforces the per-setting minimum", () => {
			assert.notStrictEqual(validateNumberSetting("requestTimeout", 999), undefined);
			assert.strictEqual(validateNumberSetting("requestTimeout", 1000), undefined);
			assert.strictEqual(validateNumberSetting("discoveryCacheTtl", 0), undefined);
		});

		test("null is legal only for nullable settings", () => {
			assert.strictEqual(validateNumberSetting("defaultMaxInputTokens", null), undefined);
			assert.notStrictEqual(validateNumberSetting("requestTimeout", null), undefined);
		});

		test("validateHeadersRecord enforces the request path's rules", () => {
			assert.strictEqual(validateHeadersRecord({ "x-litellm-api-key": "v", "x-n": 2 }), undefined);
			assert.notStrictEqual(validateHeadersRecord({ "bad name": "v" }), undefined, "spaces are not token chars");
			assert.notStrictEqual(validateHeadersRecord({ "x-key": "a\nb" }), undefined, "no line breaks in values");
			assert.notStrictEqual(
				validateHeadersRecord(JSON.parse('{"__proto__": "v"}') as Record<string, string>),
				undefined
			);
		});

		test("validateModelParametersRecord refuses prototype-polluting keys at both levels", () => {
			assert.strictEqual(validateModelParametersRecord({ "gpt-4": { temperature: 0.2 } }), undefined);
			assert.notStrictEqual(
				validateModelParametersRecord(JSON.parse('{"__proto__": {}}') as Record<string, Record<string, unknown>>),
				undefined
			);
			assert.notStrictEqual(
				validateModelParametersRecord(
					JSON.parse('{"gpt-4": {"constructor": 1}}') as Record<string, Record<string, unknown>>
				),
				undefined
			);
		});

		test("validateSaveServerSetting: the acceptance matrix", () => {
			const ok = (server: Parameters<typeof validateSaveServerSetting>[0]) =>
				assert.strictEqual(validateSaveServerSetting(server, KEEP_ALL), undefined, JSON.stringify(server));
			const bad = (server: Parameters<typeof validateSaveServerSetting>[0], why: string) =>
				assert.notStrictEqual(validateSaveServerSetting(server, KEEP_ALL), undefined, why);

			ok({ label: "Prod", baseUrl: "http://localhost:4000" });
			ok({ label: "Prod", baseUrl: "https://litellm.example.com/" });
			bad({ label: "", baseUrl: "http://x" }, "empty label");
			bad({ label: "   ", baseUrl: "http://x" }, "whitespace label");
			bad({ label: "__proto__", baseUrl: "http://x" }, "prototype-polluting label");
			bad({ label: "constructor", baseUrl: "http://x" }, "prototype-polluting label");
			bad({ label: "Prod", baseUrl: "" }, "missing baseUrl");
			bad({ label: "Prod", baseUrl: "localhost:4000" }, "URL without a scheme");
			bad({ label: "Prod", baseUrl: "ftp://host" }, "non-http scheme");
			bad({ label: "Prod", baseUrl: "not a url" }, "junk baseUrl");
			bad({ label: "Prod", baseUrl: "http://x", oauthTokenUrl: "idp.test/token" }, "bad OAuth URL");
			bad({ label: "Prod", baseUrl: "http://x", virtualKeyHeader: "bad header" }, "header name with a space");
		});

		test("validateSaveServerSetting: secret directives must carry sendable values", () => {
			const server = { label: "Prod", baseUrl: "http://x" };
			assert.notStrictEqual(
				validateSaveServerSetting(server, { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "" } }),
				undefined,
				"an empty set-value must be a clear, not a set"
			);
			assert.notStrictEqual(
				validateSaveServerSetting(server, {
					...KEEP_ALL,
					virtualKeyValue: { action: "set", location: "secure", value: "a\nb" },
				}),
				undefined,
				"a virtual key with line breaks can never travel as a header"
			);
			assert.strictEqual(
				validateSaveServerSetting(server, {
					...KEEP_ALL,
					apiKey: { action: "set", location: "settings", value: "sk-1" },
				}),
				undefined
			);
		});

		test("validateSaveServerSetting messages never repeat the entered values", () => {
			const problem = validateSaveServerSetting(
				{ label: "Prod", baseUrl: "http://x" },
				{ ...KEEP_ALL, virtualKeyValue: { action: "set", location: "secure", value: "vk-secret\n" } }
			);
			assert.ok(problem !== undefined);
			assert.ok(!problem.includes("vk-secret"), problem);
		});
	});

	suite("executeDashboardIntent", () => {
		test("setNumberSetting writes the setting key verbatim", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent(
				{ type: "setNumberSetting", setting: "requestTimeout", value: 120000 },
				recorded.env
			);

			assert.deepStrictEqual(recorded.updates, [["requestTimeout", 120000]]);
			assert.deepStrictEqual(recorded.commands, []);
		});

		test("setNumberSetting refuses values below the minimum without writing", async () => {
			const recorded = makeEnv();
			await assert.rejects(
				executeDashboardIntent({ type: "setNumberSetting", setting: "requestTimeout", value: 1 }, recorded.env)
			);

			assert.deepStrictEqual(recorded.updates, []);
		});

		test("setBooleanSetting writes the dotted key", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent(
				{ type: "setBooleanSetting", setting: "promptCaching.enabled", value: false },
				recorded.env
			);

			assert.deepStrictEqual(recorded.updates, [["promptCaching.enabled", false]]);
		});

		test("resetSetting removes the key through removeSetting, never a value write", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent({ type: "resetSetting", setting: "requestTimeout" }, recorded.env);
			await executeDashboardIntent({ type: "resetSetting", setting: "maskApiKeyInput" }, recorded.env);

			assert.deepStrictEqual(recorded.removals, ["requestTimeout", "maskApiKeyInput"]);
			assert.deepStrictEqual(recorded.updates, []);
			assert.deepStrictEqual(recorded.commands, []);
		});

		test("setModelParameters and setHeaders write the whole record", async () => {
			const recorded = makeEnv();
			const params = { "gpt-4": { temperature: 0.2 } };
			const headers = { "x-key": "v" };
			await executeDashboardIntent({ type: "setModelParameters", value: params }, recorded.env);
			await executeDashboardIntent({ type: "setHeaders", value: headers }, recorded.env);

			assert.deepStrictEqual(recorded.updates, [
				["modelParameters", params],
				["headers", headers],
			]);
		});

		test("record intents that fail validation write nothing", async () => {
			const recorded = makeEnv();
			await assert.rejects(executeDashboardIntent({ type: "setHeaders", value: { "bad name": "v" } }, recorded.env));
			await assert.rejects(
				executeDashboardIntent(
					{
						type: "setModelParameters",
						value: JSON.parse('{"__proto__": {}}') as Record<string, Record<string, unknown>>,
					},
					recorded.env
				)
			);

			assert.deepStrictEqual(recorded.updates, []);
		});

		test("every command ID maps to an allow-listed command", async () => {
			const recorded = makeEnv();
			const intents: DashboardIntent[] = [
				{ type: "executeCommand", command: "manageServers" },
				{ type: "executeCommand", command: "syncModels" },
				{ type: "executeCommand", command: "testConnection" },
				{ type: "executeCommand", command: "openSettings" },
				{ type: "executeCommand", command: "reportIssue" },
			];
			for (const intent of intents) {
				await executeDashboardIntent(intent, recorded.env);
			}

			assert.deepStrictEqual(recorded.commands, [
				["litellm.manageServers"],
				["litellm.syncModels"],
				["litellm.testConnection"],
				["workbench.action.openSettings", "@ext:vivswan.litellm-vscode-chat"],
				["litellm.reportIssue"],
			]);
		});
	});

	suite("executeDashboardIntent: the servers setting", () => {
		const save = (
			recorded: RecordedEnv,
			partial: Partial<Extract<DashboardIntent, { type: "saveServerSetting" }>>
		): Promise<string | undefined> =>
			executeDashboardIntent(
				{
					type: "saveServerSetting",
					server: { label: "Prod", baseUrl: "http://prod.test" },
					secrets: KEEP_ALL,
					requestId: "req-1",
					...partial,
				},
				recorded.env
			);

		test("a new entry appends to the array and requests a sync; empty optionals stay omitted", async () => {
			const recorded = makeEnv([{ label: "Existing", baseUrl: "http://old.test" }]);
			await save(recorded, {
				server: { label: "Prod", baseUrl: " http://prod.test ", oauthTokenUrl: "", oauthScopes: "  " },
			});

			assert.deepStrictEqual(recorded.serverWrites, [
				[
					{ label: "Existing", baseUrl: "http://old.test" },
					{ label: "Prod", baseUrl: "http://prod.test" },
				],
			]);
			assert.strictEqual(recorded.syncRequests, 1);
			assert.deepStrictEqual(recorded.secretOps, []);
		});

		test("an edit replaces the entry in place and keep-directives carry its inline secrets over", async () => {
			const recorded = makeEnv([
				{ label: "A", baseUrl: "http://a.test" },
				{ label: "Prod", baseUrl: "http://old.test", apiKey: "sk-inline", virtualKeyHeader: "x-old" },
				{ label: "Z", baseUrl: "http://z.test" },
			]);
			await save(recorded, { server: { label: "Prod", baseUrl: "http://new.test" }, replaceLabel: "Prod" });

			assert.deepStrictEqual(recorded.serverWrites, [
				[
					{ label: "A", baseUrl: "http://a.test" },
					{ label: "Prod", baseUrl: "http://new.test", apiKey: "sk-inline" },
					{ label: "Z", baseUrl: "http://z.test" },
				],
			]);
			assert.deepStrictEqual(recorded.secretCopies, [], "no rename, no copy");
			assert.deepStrictEqual(recorded.secretDeletes, []);
		});

		test("junk sibling entries survive a save verbatim", async () => {
			const junk = ["not an object", 42, { baseUrl: "http://no-label.test" }];
			const recorded = makeEnv([junk[0], { label: "Prod", baseUrl: "http://old.test" }, junk[1], junk[2]]);
			await save(recorded, { replaceLabel: "Prod" });

			assert.deepStrictEqual(recorded.serverWrites, [
				[junk[0], { label: "Prod", baseUrl: "http://prod.test" }, junk[1], junk[2]],
			]);
		});

		test("the save target is the parser-accepted entry: a rejected same-label sibling is not edited", async () => {
			// The first raw carrier of the label is rejected by parseServersSetting
			// (no usable baseUrl), so the dashboard row - and therefore this edit -
			// describes the second entry. The save must replace THAT one; the
			// invalid sibling survives verbatim like any junk entry, and the
			// keep-directive carries the accepted entry's inline key.
			const invalidSibling = { label: "Prod", apiKey: "sk-shadow" };
			const recorded = makeEnv([invalidSibling, { label: "Prod", baseUrl: "http://old.test", apiKey: "sk-real" }]);
			await save(recorded, { server: { label: "Prod", baseUrl: "http://new.test" }, replaceLabel: "Prod" });

			assert.deepStrictEqual(recorded.serverWrites, [
				[invalidSibling, { label: "Prod", baseUrl: "http://new.test", apiKey: "sk-real" }],
			]);
		});

		test("set-secure stores the value and keeps it out of the setting; set-settings inlines it and drops the secure copy after the write", async () => {
			const recorded = makeEnv([]);
			await save(recorded, {
				server: { label: "Prod", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" },
				secrets: {
					apiKey: { action: "set", location: "secure", value: "sk-secret" },
					oauthClientSecret: { action: "keep" },
					virtualKeyValue: { action: "set", location: "settings", value: "vk-visible" },
				},
			});

			assert.deepStrictEqual(recorded.secretOps, [
				["Prod", "apiKey", "sk-secret"],
				["Prod", "virtualKeyValue", undefined],
			]);
			assert.deepStrictEqual(recorded.serverWrites, [
				[{ label: "Prod", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk", virtualKeyValue: "vk-visible" }],
			]);
			const written = JSON.stringify(recorded.serverWrites);
			assert.ok(!written.includes("sk-secret"), "secure values never land in the setting");
			assert.deepStrictEqual(
				recorded.ops,
				["store:Prod.apiKey", "write", "unstore:Prod.virtualKeyValue"],
				"additive ops precede the write; destructive cleanup follows it"
			);
		});

		test("clear removes the secure copy only after the write lands", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-old" }]);
			await save(recorded, {
				secrets: { ...KEEP_ALL, apiKey: { action: "clear" } },
				replaceLabel: "Prod",
			});

			assert.deepStrictEqual(recorded.secretOps, [["Prod", "apiKey", undefined]]);
			assert.deepStrictEqual(recorded.serverWrites, [[{ label: "Prod", baseUrl: "http://prod.test" }]]);
			assert.deepStrictEqual(recorded.ops, ["write", "unstore:Prod.apiKey"]);
		});

		test("prefill round trip: an untouched inline value survives a save unchanged, still inline", async () => {
			const entry = { label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-inline" };
			const recorded = makeEnv([entry]);
			// The webview's edit flow end to end: prefill the draft from the
			// entry's inline values, leave everything untouched, assemble, save.
			const prefilled = applyInlinePrefill(
				{
					...EMPTY_SERVER_FORM,
					label: "Prod",
					baseUrl: "http://prod.test",
					apiKey: { value: "", location: "settings", clear: false, existing: "settings" },
				},
				readInlineSecretValues([entry], "Prod")
			);
			assert.strictEqual(prefilled.apiKey.value, "sk-inline", "the form shows the inline value");
			const assembled = parseClean(prefilled, "Prod");
			assert.deepStrictEqual(assembled.secrets.apiKey, { action: "keep" }, "untouched prefill assembles as keep");
			await executeDashboardIntent({ type: "saveServerSetting", ...assembled, requestId: "req-rt" }, recorded.env);

			assert.deepStrictEqual(recorded.serverWrites, [[entry]], "the value survives unchanged, storage stays inline");
			assert.deepStrictEqual(recorded.secretOps, [], "no secure-side traffic for an untouched prefill");
		});

		test("prefill round trip: an edited prefill lands the new value inline", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-old" }]);
			const prefilled = applyInlinePrefill(
				{
					...EMPTY_SERVER_FORM,
					label: "Prod",
					baseUrl: "http://prod.test",
					apiKey: { value: "", location: "settings", clear: false, existing: "settings" },
				},
				readInlineSecretValues(recorded.env.readServersSetting(), "Prod")
			);
			const edited = { ...prefilled, apiKey: { ...prefilled.apiKey, value: "sk-rotated" } };
			const assembled = parseClean(edited, "Prod");
			assert.deepStrictEqual(assembled.secrets.apiKey, { action: "set", location: "settings", value: "sk-rotated" });
			await executeDashboardIntent({ type: "saveServerSetting", ...assembled, requestId: "req-rt2" }, recorded.env);

			assert.deepStrictEqual(recorded.serverWrites, [
				[{ label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-rotated" }],
			]);
		});

		test("overwriting a live secure value whose settings write then fails restores the old value", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-old" });
			recorded.failWrites = new Error("disk full");
			await assert.rejects(
				save(recorded, {
					secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "sk-new" } },
					replaceLabel: "Prod",
				}),
				/disk full/
			);

			assert.strictEqual(
				recorded.storedSecrets.get("Prod")?.apiKey,
				"sk-old",
				"the entry still in the setting must resolve its old secret"
			);
			assert.deepStrictEqual(recorded.ops, ["store:Prod.apiKey", "store:Prod.apiKey"], "overwrite, then restore");
			assert.strictEqual(recorded.syncRequests, 0, "a clean rollback changes nothing durable, so no sync");
		});

		test("a failed settings write also removes a secure value that had no predecessor", async () => {
			// The unchanged entry resolves the label's blob, so a freshly stored
			// value must not survive the failed write as its new secret.
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.failWrites = new Error("disk full");
			await assert.rejects(
				save(recorded, {
					secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "sk-new" } },
					replaceLabel: "Prod",
				}),
				/disk full/
			);

			assert.strictEqual(recorded.storedSecrets.get("Prod")?.apiKey, undefined);
		});

		test("a second secure write failing rolls back the first and never writes the setting", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-old" });
			recorded.failStoreField = "oauthClientSecret";
			await assert.rejects(
				save(recorded, {
					server: {
						label: "Prod",
						baseUrl: "http://prod.test",
						oauthTokenUrl: "https://idp.test/token",
						oauthClientId: "client",
					},
					secrets: {
						apiKey: { action: "set", location: "secure", value: "sk-new" },
						oauthClientSecret: { action: "set", location: "secure", value: "cs-new" },
						virtualKeyValue: { action: "keep" },
					},
					replaceLabel: "Prod",
				})
			);

			assert.strictEqual(recorded.storedSecrets.get("Prod")?.apiKey, "sk-old", "the first write is rolled back");
			assert.strictEqual(recorded.storedSecrets.get("Prod")?.oauthClientSecret, undefined);
			assert.deepStrictEqual(recorded.serverWrites, [], "the settings write never runs");
			assert.strictEqual(recorded.syncRequests, 0);
		});

		test("a rename over an orphan blob whose settings write fails restores the orphan wholesale", async () => {
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Old", { apiKey: "sk-old" });
			recorded.storedSecrets.set("New", { virtualKeyValue: "vk-orphan" });
			recorded.failWrites = new Error("disk full");
			await assert.rejects(
				save(recorded, { server: { label: "New", baseUrl: "http://prod.test" }, replaceLabel: "Old" })
			);

			assert.deepStrictEqual(
				recorded.storedSecrets.get("New"),
				{ virtualKeyValue: "vk-orphan" },
				"the pre-copy blob is restored wholesale, copied-over fields removed"
			);
			assert.deepStrictEqual(recorded.storedSecrets.get("Old"), { apiKey: "sk-old" }, "the source blob is untouched");
		});

		test("a failed write whose rollback also fails reports an operation failure, not a clean validation one", async () => {
			// The freshly stored secret survived the rollback and now resolves for
			// the unchanged entry: durable state changed, so "nothing landed"
			// (rethrowing the write error as validation-kind) would be a lie.
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.failWrites = new Error("disk full");
			recorded.failUnstore = new Error("keychain locked");
			await assert.rejects(
				save(recorded, {
					secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "sk-new" } },
					replaceLabel: "Prod",
				}),
				(error: unknown) =>
					error instanceof DashboardOperationError &&
					error.message.includes("restoring a stored secret") &&
					error.message.includes("Set Server Secret")
			);

			assert.strictEqual(recorded.storedSecrets.get("Prod")?.apiKey, "sk-new", "the unrestored secret is live");
			assert.strictEqual(recorded.syncRequests, 1, "the changed secure value must reach the provider group");
			const logged = JSON.stringify(recorded.logs);
			assert.ok(logged.includes("left a secure value unrestored"), "the conversion is logged as a classification");
			assert.ok(!logged.includes("disk full") && !logged.includes("sk-new"), "names only, never messages or values");
		});

		test("a rename rollback that fails likewise fails the intent as an operation error", async () => {
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Old", { apiKey: "sk-old" });
			recorded.failWrites = new Error("disk full");
			recorded.failUnstore = new Error("keychain locked");
			await assert.rejects(
				save(recorded, { server: { label: "New", baseUrl: "http://prod.test" }, replaceLabel: "Old" }),
				(error: unknown) => error instanceof DashboardOperationError
			);

			assert.strictEqual(recorded.syncRequests, 1, "the unrestored blob must reach the provider group");
		});

		test("a clear whose deletion keeps failing fails the intent after the write landed, with an actionable message", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-old" });
			recorded.failUnstore = new Error("keychain locked");
			await assert.rejects(
				save(recorded, { secrets: { ...KEEP_ALL, apiKey: { action: "clear" } }, replaceLabel: "Prod" }),
				(error: unknown) =>
					error instanceof DashboardOperationError &&
					error.message.includes("Edit the server and retry") &&
					error.message.includes("Set Server Secret")
			);

			assert.strictEqual(recorded.serverWrites.length, 1, "the settings write landed");
			assert.strictEqual(recorded.syncRequests, 1, "the landed write still gets its sync");
			const logged = JSON.stringify(recorded.logs);
			assert.ok(logged.includes("still in effect"), "the failure is logged as a classification");
			assert.ok(!logged.includes("sk-old"), "no value reaches the log");
		});

		test("a clear deletion that fails once succeeds on the retry", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-old" });
			recorded.failUnstoreTimes = 1;
			await save(recorded, { secrets: { ...KEEP_ALL, apiKey: { action: "clear" } }, replaceLabel: "Prod" });

			assert.strictEqual(recorded.storedSecrets.get("Prod")?.apiKey, undefined, "the retry removed the secret");
		});

		test("dormant-leftover cleanup failures after the settings write landed do not fail the intent", async () => {
			// The stale secure copy behind a fresh inline value is outranked and
			// the old rename blob is orphaned, so both failures are log-only.
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Old", { apiKey: "sk-old" });
			recorded.failUnstore = new Error("keychain locked");
			recorded.failBlobDeletes = new Error("keychain locked");
			await save(recorded, {
				server: { label: "New", baseUrl: "http://prod.test" },
				secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "settings", value: "sk-inline" } },
				replaceLabel: "Old",
			});

			assert.strictEqual(recorded.serverWrites.length, 1);
			assert.strictEqual(recorded.syncRequests, 1);
			const logged = JSON.stringify(recorded.logs);
			assert.ok(logged.includes("dormant secure copy remains"), "the stale-copy failure is a classification");
			assert.ok(logged.includes("old label's blob remains"), "the rename-blob failure is a classification");
		});

		test("edits and removals find hand-written entries whose labels carry whitespace", async () => {
			const edited = makeEnv([{ label: " Prod ", baseUrl: "http://old.test" }]);
			await save(edited, { replaceLabel: "Prod" });
			assert.deepStrictEqual(edited.serverWrites, [[{ label: "Prod", baseUrl: "http://prod.test" }]]);

			const removed = makeEnv([{ label: " Prod ", baseUrl: "http://old.test" }]);
			await executeDashboardIntent({ type: "removeServerSetting", label: "Prod", requestId: "req-9" }, removed.env);
			assert.deepStrictEqual(removed.serverWrites, [[]]);
		});

		test("a rename with keep directives resolves pairing against the old label's secure value", async () => {
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Old", { virtualKeyValue: "vk-1" });
			await save(recorded, {
				server: { label: "New", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" },
				replaceLabel: "Old",
			});

			assert.strictEqual(recorded.serverWrites.length, 1, "the old label's secure value satisfies the pair");
			assert.deepStrictEqual(recorded.storedSecrets.get("New"), { virtualKeyValue: "vk-1" });
		});

		test("a rename with keep directives also resolves against an orphan blob under the new label", async () => {
			// copyServerSecrets is a no-op on an empty source, so the orphan
			// survives the save and the sync engine adopts it; the pairing check
			// must agree instead of refusing a save the engine would satisfy.
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("New", { virtualKeyValue: "vk-orphan" });
			await save(recorded, {
				server: { label: "New", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" },
				replaceLabel: "Old",
			});

			assert.strictEqual(recorded.serverWrites.length, 1);
		});

		test("a non-empty old blob replaces the orphan wholesale on rename, and pairing tracks that", async () => {
			// The copy overwrites the whole new-label blob, so a field only the
			// orphan held does not survive; the pairing check must refuse like the
			// engine would degrade.
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Old", { apiKey: "sk-1" });
			recorded.storedSecrets.set("New", { virtualKeyValue: "vk-orphan" });
			await assert.rejects(
				save(recorded, {
					server: { label: "New", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" },
					replaceLabel: "Old",
				}),
				/virtualKeyValue/
			);
		});

		test("a rename copies the blob before the write and deletes the old one after it", async () => {
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			await save(recorded, { server: { label: "New", baseUrl: "http://prod.test" }, replaceLabel: "Old" });

			assert.deepStrictEqual(recorded.secretCopies, [["Old", "New"]]);
			assert.deepStrictEqual(recorded.secretDeletes, ["Old"]);
			assert.deepStrictEqual(recorded.serverWrites, [[{ label: "New", baseUrl: "http://prod.test" }]]);
			assert.deepStrictEqual(recorded.ops, ["copy:Old->New", "write", "deleteBlob:Old"]);
		});

		test("a rename whose settings write rejects leaves the old label's secrets intact", async () => {
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.failWrites = new Error("disk full");
			await assert.rejects(
				save(recorded, { server: { label: "New", baseUrl: "http://prod.test" }, replaceLabel: "Old" }),
				/disk full/
			);

			assert.deepStrictEqual(recorded.secretCopies, [["Old", "New"]], "the additive copy may have happened");
			assert.deepStrictEqual(recorded.secretDeletes, [], "the old blob must survive the failed write");
			assert.deepStrictEqual(recorded.secretOps, [], "no clears before or after a failed write");
			assert.strictEqual(recorded.syncRequests, 0);
		});

		test("renaming onto an existing sibling label is refused before any effect", async () => {
			const recorded = makeEnv([
				{ label: "A", baseUrl: "http://a.test" },
				{ label: "B", baseUrl: "http://b.test" },
			]);
			await assert.rejects(
				save(recorded, { server: { label: "B", baseUrl: "http://a.test" }, replaceLabel: "A" }),
				/already exists/
			);

			assert.deepStrictEqual(recorded.serverWrites, []);
			assert.deepStrictEqual(recorded.secretCopies, []);
			assert.deepStrictEqual(recorded.secretOps, []);
		});

		test("an edit whose entry vanished from the setting is refused instead of appending a duplicate", async () => {
			const recorded = makeEnv([{ label: "Other", baseUrl: "http://other.test" }]);
			await assert.rejects(save(recorded, { replaceLabel: "Gone" }), /no longer exists/);

			assert.deepStrictEqual(recorded.serverWrites, []);
		});

		test("OAuth pairing is enforced at the boundary: a token URL without a client ID never saves", async () => {
			const recorded = makeEnv([]);
			await assert.rejects(
				save(recorded, {
					server: { label: "Prod", baseUrl: "http://prod.test", oauthTokenUrl: "https://idp.test/token" },
				}),
				/oauthClientId/
			);
			await assert.rejects(
				save(recorded, { server: { label: "Prod", baseUrl: "http://prod.test", oauthClientId: "client" } }),
				/oauthTokenUrl/
			);

			assert.deepStrictEqual(recorded.serverWrites, []);
		});

		test("OAuth semantics mirror the form: scopes or a resolving client secret require the full pair", async () => {
			const scopesOnly = makeEnv([]);
			await assert.rejects(
				save(scopesOnly, { server: { label: "Prod", baseUrl: "http://prod.test", oauthScopes: "read" } }),
				/oauthTokenUrl/
			);
			assert.deepStrictEqual(scopesOnly.serverWrites, []);

			const storedSecretOnly = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			storedSecretOnly.storedSecrets.set("Prod", { oauthClientSecret: "cs-stored" });
			await assert.rejects(save(storedSecretOnly, { replaceLabel: "Prod" }), /oauthTokenUrl/);

			const cleared = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			cleared.storedSecrets.set("Prod", { oauthClientSecret: "cs-stored" });
			await save(cleared, {
				secrets: { ...KEEP_ALL, oauthClientSecret: { action: "clear" } },
				replaceLabel: "Prod",
			});
			assert.strictEqual(cleared.serverWrites.length, 1, "clearing the dangling secret makes the entry savable");
		});

		test("a padded replaceLabel targets the trimmed label's secret blob, not a padded key", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-old" });
			await save(recorded, { server: { label: "Renamed", baseUrl: "http://prod.test" }, replaceLabel: " Prod " });

			assert.deepStrictEqual(recorded.secretCopies, [["Prod", "Renamed"]], "the copy reads the trimmed label");
			assert.deepStrictEqual(recorded.secretDeletes, ["Prod"], "the cleanup deletes the trimmed label");
			assert.deepStrictEqual(recorded.storedSecrets.get("Renamed"), { apiKey: "sk-old" });
		});

		test("virtual key pairing is enforced against the resolved secrets", async () => {
			const noValue = makeEnv([]);
			await assert.rejects(
				save(noValue, { server: { label: "Prod", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" } }),
				/virtualKeyValue/
			);

			const secureValue = makeEnv([]);
			secureValue.storedSecrets.set("Prod", { virtualKeyValue: "vk-stored" });
			await save(secureValue, {
				server: { label: "Prod", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" },
			});
			assert.strictEqual(secureValue.serverWrites.length, 1, "a kept secure value satisfies the pair");

			const valueWithoutHeader = makeEnv([]);
			await assert.rejects(
				save(valueWithoutHeader, {
					secrets: { ...KEEP_ALL, virtualKeyValue: { action: "set", location: "secure", value: "vk-1" } },
				}),
				/virtualKeyHeader/
			);
			assert.deepStrictEqual(valueWithoutHeader.secretOps, [], "pairing is checked before any secret write");
		});

		test("an invalid save writes nothing anywhere", async () => {
			const recorded = makeEnv([]);
			await assert.rejects(save(recorded, { server: { label: "__proto__", baseUrl: "http://x" } }));
			await assert.rejects(save(recorded, { server: { label: "P", baseUrl: "not-a-url" } }));
			await assert.rejects(save(recorded, { server: { label: "P", baseUrl: "" } }));

			assert.deepStrictEqual(recorded.serverWrites, []);
			assert.deepStrictEqual(recorded.secretOps, []);
			assert.strictEqual(recorded.syncRequests, 0);
		});

		test("removeServerSetting deletes the entry, keeps its secure-side secrets, and preserves junk siblings", async () => {
			const recorded = makeEnv([
				{ label: "A", baseUrl: "http://a.test" },
				"junk",
				{ label: "B", baseUrl: "http://b.test" },
			]);
			await executeDashboardIntent({ type: "removeServerSetting", label: "A", requestId: "req-2" }, recorded.env);

			assert.deepStrictEqual(recorded.serverWrites, [["junk", { label: "B", baseUrl: "http://b.test" }]]);
			assert.deepStrictEqual(recorded.secretOps, []);
			assert.deepStrictEqual(recorded.secretDeletes, []);
			assert.strictEqual(recorded.syncRequests, 1);
		});

		test("removing a label the setting does not hold refuses without writing", async () => {
			const recorded = makeEnv([{ label: "A", baseUrl: "http://a.test" }]);
			await assert.rejects(
				executeDashboardIntent({ type: "removeServerSetting", label: "External", requestId: "req-3" }, recorded.env)
			);

			assert.deepStrictEqual(recorded.serverWrites, []);
		});
	});

	suite("executeDashboardIntent: adoptServer", () => {
		const FULL_CREDENTIALS: AdoptableGroupCredentials = {
			apiKey: "sk-live",
			oauthTokenUrl: "https://idp.test/token",
			oauthClientId: "client-1",
			oauthClientSecret: "oauth-secret",
			oauthScopes: "read write",
			virtualKeyHeader: "x-litellm-api-key",
			virtualKeyValue: "vk-live",
		};

		const adopt = (
			recorded: RecordedEnv,
			partial: Partial<Extract<DashboardIntent, { type: "adoptServer" }>> = {}
		): Promise<string | undefined> =>
			executeDashboardIntent(
				{
					type: "adoptServer",
					label: "Adopted",
					baseUrl: "http://ext.test",
					sourceHandle: "handle-ext",
					secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
					requestId: "req-a",
					...partial,
				},
				recorded.env
			);

		test("writes the entry with non-secret fields and stores secure-side secrets, never logging a value", async () => {
			const recorded = makeEnv([{ label: "Existing", baseUrl: "http://other.test" }]);
			recorded.adoptionCredentials = FULL_CREDENTIALS;

			const notice = await adopt(recorded);

			assert.strictEqual(notice, undefined, "a full adoption carries no caveat");
			assert.deepStrictEqual(recorded.adoptionLookups, [["http://ext.test", "handle-ext"]]);
			assert.deepStrictEqual(recorded.serverWrites, [
				[
					{ label: "Existing", baseUrl: "http://other.test" },
					{
						label: "Adopted",
						baseUrl: "http://ext.test",
						oauthTokenUrl: "https://idp.test/token",
						oauthClientId: "client-1",
						oauthScopes: "read write",
						virtualKeyHeader: "x-litellm-api-key",
					},
				],
			]);
			assert.deepStrictEqual(recorded.storedSecrets.get("Adopted"), {
				apiKey: "sk-live",
				oauthClientSecret: "oauth-secret",
				virtualKeyValue: "vk-live",
			});
			assert.strictEqual(recorded.syncRequests, 1);
			const everything = JSON.stringify(recorded.logs);
			for (const secret of ["sk-live", "oauth-secret", "vk-live"]) {
				assert.ok(!everything.includes(secret), `logs must never carry ${secret}`);
			}
		});

		test("a settings-side storage choice inlines the value into the entry instead", async () => {
			const recorded = makeEnv([]);
			recorded.adoptionCredentials = { apiKey: "sk-live" };

			await adopt(recorded, {
				secrets: { apiKey: "settings", oauthClientSecret: "secure", virtualKeyValue: "secure" },
			});

			assert.deepStrictEqual(recorded.serverWrites, [
				[{ label: "Adopted", baseUrl: "http://ext.test", apiKey: "sk-live" }],
			]);
			assert.deepStrictEqual(recorded.secretOps, [], "nothing goes secure-side when settings was chosen");
		});

		test("refuses a label collision with an existing declared entry", async () => {
			const recorded = makeEnv([{ label: "Adopted", baseUrl: "http://other.test" }]);
			recorded.adoptionCredentials = FULL_CREDENTIALS;

			await assert.rejects(
				() => adopt(recorded),
				(error: unknown) =>
					error instanceof Error && error.name === "DashboardValidationError" && /already exists/.test(error.message)
			);
			assert.deepStrictEqual(recorded.serverWrites, []);
			assert.deepStrictEqual(recorded.secretOps, []);
		});

		test("refuses label and URL rule violations", async () => {
			const recorded = makeEnv([]);
			recorded.adoptionCredentials = FULL_CREDENTIALS;
			for (const partial of [
				{ label: "  " },
				{ label: "__proto__" },
				{ baseUrl: "not a url" },
				{ baseUrl: "ftp://x.test" },
			]) {
				await assert.rejects(
					() => adopt(recorded, partial),
					(error: unknown) => error instanceof Error && error.name === "DashboardValidationError",
					JSON.stringify(partial)
				);
			}
			assert.deepStrictEqual(recorded.serverWrites, []);
		});

		test("a missing credential lookup still adopts the plain entry and reports the caveat", async () => {
			const recorded = makeEnv([]);
			// adoptionCredentials stays unset: the group refreshed away.

			const notice = await adopt(recorded);

			assert.ok(notice !== undefined && /could not be read/.test(notice), notice ?? "expected a caveat notice");
			assert.deepStrictEqual(recorded.serverWrites, [[{ label: "Adopted", baseUrl: "http://ext.test" }]]);
			assert.deepStrictEqual(recorded.secretOps, [], "no secrets to copy");
			assert.strictEqual(recorded.syncRequests, 1);
		});

		test("a failed settings write rolls the copied secure secrets back", async () => {
			const recorded = makeEnv([]);
			recorded.adoptionCredentials = FULL_CREDENTIALS;
			recorded.failWrites = new Error("settings store unavailable");

			await assert.rejects(() => adopt(recorded));

			assert.deepStrictEqual(
				recorded.storedSecrets.get("Adopted"),
				{},
				"the copied secrets are removed again when the entry never landed"
			);
		});

		test("a stale secure blob under the new label is cleared, never inherited", async () => {
			// serverSync keeps a removed entry's blob on purpose (re-adding the
			// label picks it up), but an adoption under that label asked for the
			// GROUP's secrets, so leftovers from neither the group nor the user
			// must not resolve for the new entry.
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Adopted", { apiKey: "sk-stale", virtualKeyValue: "vk-stale" });
			recorded.adoptionCredentials = { apiKey: "sk-live" };

			await adopt(recorded);

			assert.deepStrictEqual(
				recorded.storedSecrets.get("Adopted"),
				{ apiKey: "sk-live" },
				"copied fields land; stale fields are removed"
			);
		});

		test("a stale blob field behind a settings-side copy is cleared too, like the save path's dormant copies", async () => {
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Adopted", { apiKey: "sk-stale" });
			recorded.adoptionCredentials = { apiKey: "sk-live" };

			await adopt(recorded, {
				secrets: { apiKey: "settings", oauthClientSecret: "secure", virtualKeyValue: "secure" },
			});

			assert.deepStrictEqual(recorded.serverWrites, [
				[{ label: "Adopted", baseUrl: "http://ext.test", apiKey: "sk-live" }],
			]);
			assert.deepStrictEqual(
				recorded.storedSecrets.get("Adopted"),
				{},
				"the stale secure copy behind the inline value is removed"
			);
		});

		test("a stale blob that survives cleanup surfaces in the success caveat, never silently", async () => {
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Adopted", { virtualKeyValue: "vk-stale" });
			recorded.adoptionCredentials = { apiKey: "sk-live" };
			recorded.failUnstore = new Error("keychain locked");

			const notice = await adopt(recorded);

			assert.ok(notice !== undefined, "expected a caveat");
			assert.ok(/could not be cleared/.test(notice), notice);
			assert.ok(notice.includes("Virtual key value"), "the caveat uses the display name");
			assert.ok(!notice.includes("vk-stale"), "the caveat names the field, never the value");
			assert.strictEqual(recorded.serverWrites.length, 1, "the entry write stands; only the caveat warns");
			assert.deepStrictEqual(recorded.storedSecrets.get("Adopted"), {
				apiKey: "sk-live",
				virtualKeyValue: "vk-stale",
			});
		});

		test("missing credentials and a failed stale-blob cleanup combine into one caveat", async () => {
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Adopted", { apiKey: "sk-stale" });
			recorded.failUnstore = new Error("keychain locked");
			// adoptionCredentials stays unset: nothing to copy.

			const notice = await adopt(recorded);

			assert.ok(notice !== undefined, "expected a caveat");
			assert.ok(/could not be read/.test(notice) && /could not be cleared/.test(notice), notice);
		});

		test("an unverifiable cleanup counts as failed: adoption completes with the caveat", async () => {
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Adopted", { apiKey: "sk-stale" });
			recorded.adoptionCredentials = { virtualKeyHeader: "x-litellm-api-key", virtualKeyValue: "vk-live" };
			// The initial blob read succeeds; the post-cleanup verification read
			// throws, so the cleanup outcome is unknowable and must warn.
			recorded.failSecretReadsAfter = 1;

			const notice = await adopt(recorded);

			assert.ok(notice !== undefined, "expected a caveat");
			assert.ok(/could not be cleared/.test(notice), notice);
			assert.ok(notice.includes("API key"), notice);
			assert.strictEqual(recorded.serverWrites.length, 1, "the adoption still completes");
		});

		test("a failed write whose rollback also fails reports the reachable recovery path", async () => {
			const recorded = makeEnv([]);
			recorded.adoptionCredentials = { apiKey: "sk-live" };
			recorded.failWrites = new Error("settings store unavailable");
			// The rollback deletes the copied secret (a store of undefined),
			// which this knob rejects.
			recorded.failUnstore = new Error("keychain locked");

			await assert.rejects(
				() => adopt(recorded),
				(error: unknown) =>
					error instanceof Error &&
					error.name === "DashboardOperationError" &&
					/Re-add a server under this label/.test(error.message)
			);
			assert.strictEqual(recorded.syncRequests, 1, "the unrestored secret must still reach the sync engine");
		});
	});

	suite("executeDashboardIntent: hidden groups", () => {
		test("hideExternalServer tombstones exactly the identity the handle resolves to", async () => {
			const recorded = makeEnv();
			// The resolved identity is the group's own status label and URL, not
			// what the intent claimed: the handle is the authority.
			recorded.externalGroup = { label: "Prod", baseUrl: "http://prod.test/" };
			await executeDashboardIntent(
				{ type: "hideExternalServer", baseUrl: "http://prod.test", sourceHandle: "handle-1", requestId: "req-1" },
				recorded.env
			);

			assert.deepStrictEqual(recorded.externalLookups, [["http://prod.test", "handle-1"]]);
			assert.deepStrictEqual(recorded.hidden, [{ label: "Prod", baseUrl: "http://prod.test/" }]);
		});

		test("hideExternalServer refuses an unusable base URL before any lookup", async () => {
			const recorded = makeEnv();
			await assert.rejects(
				executeDashboardIntent(
					{ type: "hideExternalServer", baseUrl: "not a url", sourceHandle: "h", requestId: "r" },
					recorded.env
				),
				/baseUrl/
			);
			assert.deepStrictEqual(recorded.externalLookups, []);
			assert.deepStrictEqual(recorded.hidden, []);
		});

		test("a handle that resolves to no still-external group hides nothing", async () => {
			const recorded = makeEnv();
			// recorded.externalGroup stays unset: the resolver answers undefined.
			await assert.rejects(
				executeDashboardIntent(
					{ type: "hideExternalServer", baseUrl: "http://prod.test", sourceHandle: "stale", requestId: "r" },
					recorded.env
				),
				/does not resolve to a hideable/
			);
			assert.deepStrictEqual(recorded.hidden, []);
		});

		test("unhideServer echoes the identity verbatim and fails when no tombstone matched", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent(
				{ type: "unhideServer", label: "Prod", baseUrl: "http://prod.test", requestId: "r1" },
				recorded.env
			);
			assert.deepStrictEqual(recorded.unhidden, [{ label: "Prod", baseUrl: "http://prod.test" }]);

			recorded.unhideResult = false;
			await assert.rejects(
				executeDashboardIntent(
					{ type: "unhideServer", label: "Ghost", baseUrl: "http://gone.test", requestId: "r2" },
					recorded.env
				),
				/No hidden group/
			);
		});

		test("unhideServer refuses a blank label", async () => {
			const recorded = makeEnv();
			await assert.rejects(
				executeDashboardIntent(
					{ type: "unhideServer", label: "  ", baseUrl: "http://prod.test", requestId: "r" },
					recorded.env
				),
				/label/
			);
			assert.deepStrictEqual(recorded.unhidden, []);
		});
	});

	suite("resolveAdoptableCredentials", () => {
		const groupServers = new Map([
			[
				"group:aaa:http://ext.test",
				{
					baseUrl: normalizeBaseUrl("http://ext.test"),
					apiKey: "sk-one",
				},
			],
			[
				"group:bbb:http://ext.test",
				{
					baseUrl: normalizeBaseUrl("http://ext.test"),
					apiKey: "",
					oauth: {
						tokenUrl: "https://idp.test/token",
						clientId: "client-1",
						clientSecret: "oauth-secret",
						scopes: "read",
					},
					virtualKey: { header: "x-litellm-api-key", value: "vk-1" },
				},
			],
		]);
		const lookup = (serverId: string) => groupServers.get(serverId);
		const snapshotFor = (serverId: string) => ({
			status: makeServerStatus({ serverId, label: "ext.test", baseUrl: "http://ext.test" }),
			models: [],
		});
		const OAUTH_CREDENTIALS = {
			oauthTokenUrl: "https://idp.test/token",
			oauthClientId: "client-1",
			oauthClientSecret: "oauth-secret",
			oauthScopes: "read",
			virtualKeyHeader: "x-litellm-api-key",
			virtualKeyValue: "vk-1",
		};
		/** The handle a row carries, obtained the way the webview obtains it: from the built state. */
		const handleOf = (
			snapshots: Parameters<typeof buildDashboardState>[0],
			declared: DeclaredServerView[],
			label: string
		): string => {
			const server = buildDashboardState(snapshots, makeReader({}), declared).servers.find((s) => s.label === label);
			assert.ok(server?.adoptHandle !== undefined, `no adopt handle on row ${label}`);
			return server.adoptHandle;
		};

		test("resolves by the row handle, immune to snapshot order churn on a shared base URL", () => {
			// Two groups on one host: the status window's Map re-inserts entries
			// on refresh, so the same rows arrive in either order. The handle
			// rides the serverId, so both orders resolve identically where the
			// old rendered-ordinal match could hand back the OTHER group's key.
			const snapshots = [snapshotFor("group:aaa:http://ext.test"), snapshotFor("group:bbb:http://ext.test")];
			const first = handleOf(snapshots, [], "ext.test (1)");
			const second = handleOf(snapshots, [], "ext.test (2)");
			for (const ordering of [snapshots, [...snapshots].reverse()]) {
				assert.deepStrictEqual(resolveAdoptableCredentials(ordering, [], "http://ext.test", first, lookup), {
					apiKey: "sk-one",
				});
				assert.deepStrictEqual(
					resolveAdoptableCredentials(ordering, [], "http://ext.test/", second, lookup),
					OAUTH_CREDENTIALS
				);
			}
		});

		test("refuses a source that is declared at intent time (a forged intent cannot clone a declared group's secret)", () => {
			const snapshots = [snapshotFor("group:aaa:http://ext.test"), snapshotFor("group:bbb:http://ext.test")];
			// The handles as pushed while both rows were external; the first
			// group's entry is then declared (adopted or hand-written) before the
			// intent lands.
			const first = handleOf(snapshots, [], "ext.test (1)");
			const second = handleOf(snapshots, [], "ext.test (2)");
			const declared = [
				makeDeclared({
					label: "Prod",
					baseUrl: "http://ext.test",
					expectedClientId: "group:aaa:http://ext.test",
				}),
			];
			assert.strictEqual(
				resolveAdoptableCredentials(snapshots, declared, "http://ext.test", first, lookup),
				undefined,
				"the declared group's credentials must not resolve for an adopt intent"
			);
			assert.deepStrictEqual(
				resolveAdoptableCredentials(snapshots, declared, "http://ext.test", second, lookup),
				OAUTH_CREDENTIALS,
				"the still-external sibling stays adoptable"
			);
		});

		test("binds the handle to the intent's base URL, so copied credentials cannot be re-pointed at another host", () => {
			const snapshots = [snapshotFor("group:aaa:http://ext.test")];
			const handle = handleOf(snapshots, [], "ext.test");
			assert.strictEqual(resolveAdoptableCredentials(snapshots, [], "http://attacker.test", handle, lookup), undefined);
		});

		test("returns undefined for an unknown handle or a snapshot without group credentials", () => {
			const snapshots = [snapshotFor("group:aaa:http://ext.test")];
			assert.strictEqual(
				resolveAdoptableCredentials(snapshots, [], "http://ext.test", "not-a-minted-handle", lookup),
				undefined,
				"a handle the extension never minted resolves nothing"
			);
			const registryOnly = [
				{
					status: makeServerStatus({ serverId: "registry-1", label: "ext.test", baseUrl: "http://ext.test" }),
					models: [],
				},
			];
			assert.strictEqual(
				resolveAdoptableCredentials(
					registryOnly,
					[],
					"http://ext.test",
					handleOf(registryOnly, [], "ext.test"),
					lookup
				),
				undefined,
				"a registry snapshot has no group credentials to adopt"
			);
		});

		test("resolveExternalGroupIdentity yields the raw status identity, under the same trust rules", () => {
			const snapshots = [snapshotFor("group:aaa:http://ext.test"), snapshotFor("group:bbb:http://ext.test")];
			const isGroup = (serverId: string) => groupServers.has(serverId);
			// Both ordinal rows resolve to the same raw status identity: the
			// tombstone is keyed by the snapshot's own label, never the display
			// ordinal.
			const handle = handleOf(snapshots, [], "ext.test (1)");
			assert.deepStrictEqual(resolveExternalGroupIdentity(snapshots, [], "http://ext.test", handle, isGroup), {
				label: "ext.test",
				baseUrl: "http://ext.test",
			});
			assert.strictEqual(
				resolveExternalGroupIdentity(snapshots, [], "http://attacker.test", handle, isGroup),
				undefined,
				"bound to the intent's base URL like the adopt path"
			);
			const declared = [
				makeDeclared({ label: "Prod", baseUrl: "http://ext.test", expectedClientId: "group:aaa:http://ext.test" }),
			];
			assert.strictEqual(
				resolveExternalGroupIdentity(snapshots, declared, "http://ext.test", handle, isGroup),
				undefined,
				"a declared group's identity must not resolve for a hide intent"
			);
		});

		test("resolveExternalGroupIdentity refuses registry-backed snapshots: there is no group to silence", () => {
			const registryOnly = [
				{
					status: makeServerStatus({ serverId: "registry-1", label: "ext.test", baseUrl: "http://ext.test" }),
					models: [],
				},
			];
			assert.strictEqual(
				resolveExternalGroupIdentity(
					registryOnly,
					[],
					"http://ext.test",
					handleOf(registryOnly, [], "ext.test"),
					() => false
				),
				undefined
			);
		});
	});

	suite("protocol value helpers", () => {
		test("failuresAfterStatePush: acked server-intent notices survive a push, push-signaled ones retire", () => {
			// The operation-kind save failure is the load-bearing case: the save
			// itself requests a sync whose push arrives moments later and must not
			// erase the warning that the stored secret is still in effect.
			const failures = {
				saveServerSetting: { seq: 1, message: "the stored secret remains", kind: "operation" },
				removeServerSetting: { seq: 2, message: "not applied", kind: "validation" },
				setHeaders: { seq: 3, message: "not applied", kind: "validation" },
				setNumberSetting: { seq: 4, message: "not applied", kind: "validation" },
			};

			const after = failuresAfterStatePush(failures);

			assert.deepStrictEqual(Object.keys(after).sort(), ["removeServerSetting", "saveServerSetting"]);
			assert.strictEqual(after.saveServerSetting, failures.saveServerSetting, "the surviving notice is unchanged");
		});

		test("failuresAfterStatePush returns the same object when nothing retires", () => {
			const failures = { saveServerSetting: { seq: 1, message: "m", kind: "operation" } };
			assert.strictEqual(failuresAfterStatePush(failures), failures);
		});

		test("isExtensionMessageType accepts exactly the extension-to-webview discriminants", () => {
			for (const type of ["state", "inlineSecrets", "intentSucceeded", "intentFailed"]) {
				assert.ok(isExtensionMessageType(type), type);
			}
			assert.ok(!isExtensionMessageType("saveServerSetting"), "webview-to-extension intents are not accepted");
			assert.ok(!isExtensionMessageType("__proto__"), "inherited names never pass the own-key test");
			assert.ok(!isExtensionMessageType(undefined));
			assert.ok(!isExtensionMessageType(42));
		});

		test("parseJsonValue is strict JSON with an error for junk and empty input", () => {
			assert.deepStrictEqual(parseJsonValue("0.2"), { ok: true, value: 0.2 });
			assert.deepStrictEqual(parseJsonValue(' ["stop"] '), { ok: true, value: ["stop"] });
			assert.strictEqual(parseJsonValue("hello").ok, false);
			assert.strictEqual(parseJsonValue("").ok, false);
		});

		test("parseHeaderValue takes JSON scalars typed and everything else as the literal string", () => {
			assert.strictEqual(parseHeaderValue("true"), true);
			assert.strictEqual(parseHeaderValue("42"), 42);
			assert.strictEqual(parseHeaderValue('"42"'), "42");
			assert.strictEqual(parseHeaderValue("abc def"), "abc def");
			assert.strictEqual(parseHeaderValue("[1]"), "[1]", "non-scalar JSON stays a string");
			// Overflowing numeric literals parse to Infinity, which isHeaderScalar
			// refuses at the intent boundary; the literal string is the only
			// reading that keeps Apply from being a silent no-op.
			assert.strictEqual(parseHeaderValue("1e999"), "1e999", "non-finite numbers stay strings");
			assert.strictEqual(parseHeaderValue("-1e999"), "-1e999", "non-finite numbers stay strings");
		});

		test("formatHeaderValue round-trips through parseHeaderValue", () => {
			const values = [true, 42, "42", "true", "plain", "x y"] as const;
			for (const value of values) {
				assert.strictEqual(parseHeaderValue(formatHeaderValue(value)), value);
			}
		});

		test("parseNumberDraft: invalid, clear, and value verdicts follow the spec", () => {
			assert.deepStrictEqual(parseNumberDraft("requestTimeout", " 300000 "), { kind: "value", value: 300000 });
			assert.deepStrictEqual(parseNumberDraft("requestTimeout", ""), {
				kind: "invalid",
				problem: "Enter a number",
			});
			assert.deepStrictEqual(parseNumberDraft("defaultMaxInputTokens", "  "), {
				kind: "clear",
			});
			assert.deepStrictEqual(parseNumberDraft("requestTimeout", "soon"), { kind: "invalid", problem: "Not a number" });
			assert.strictEqual(parseNumberDraft("requestTimeout", "999").kind, "invalid", "below the 1000 minimum");
			assert.deepStrictEqual(parseNumberDraft("discoveryCacheTtl", "0"), { kind: "value", value: 0 });
		});

		/** The hint the settings form shows for a draft: parse once, then the equivalence of the committed value. */
		function equivalenceOfDraft(id: NumberSettingId, draft: string): string | undefined {
			const parse = parseNumberDraft(id, draft);
			return parse.kind === "value" ? equivalence(id, parse.value) : undefined;
		}

		test("equivalence renders millisecond durations in clock units, pinned at the unit boundaries", () => {
			const cases: [string, string | undefined][] = [
				["59999", "= ~59 s"],
				["60000", "= 1 min"],
				["300000", "= 5 min"],
				["3599999", "= ~59 min 59 s"],
				["3600000", "= 1 h"],
				["3661000", "= ~1 h 1 min"],
			];
			for (const [draft, expected] of cases) {
				assert.strictEqual(equivalenceOfDraft("requestTimeout", draft), expected, `draft ${draft}`);
			}
		});

		test("equivalence yields nothing for empty, unparsable, below-minimum, or sub-second drafts", () => {
			assert.strictEqual(equivalenceOfDraft("requestTimeout", ""), undefined);
			assert.strictEqual(equivalenceOfDraft("requestTimeout", "soon"), undefined);
			assert.strictEqual(equivalenceOfDraft("requestTimeout", "999"), undefined, "below the 1000 minimum");
			assert.strictEqual(equivalenceOfDraft("discoveryCacheTtl", "500"), undefined, "sub-second reads as milliseconds");
		});

		test("equivalence reads the TTL's zero through zeroMeaning, and only where 0 is legal", () => {
			assert.strictEqual(equivalenceOfDraft("discoveryCacheTtl", "0"), "= every refresh");
			assert.strictEqual(equivalenceOfDraft("requestTimeout", "0"), undefined, "0 never parses below the minimum");
			assert.strictEqual(equivalence("requestTimeout", 0), undefined, "and the hint itself has no zero reading");
		});

		test("equivalence says nothing about token counts; the unit suffix carries the meaning", () => {
			assert.strictEqual(equivalenceOfDraft("defaultMaxOutputTokens", "128000"), undefined);
			assert.strictEqual(equivalenceOfDraft("defaultContextLength", "1000000"), undefined);
		});

		test("draftSyncKey changes on a reset that only removes the configured scope, so a stale draft resyncs", () => {
			// The sequence this pins: a setting explicitly set to exactly its
			// default holds a rejected draft, the user clicks Reset, and the push
			// that follows changes the configured scope but not the value. The
			// field's draft-resync effect keys on draftSyncKey, so the key must
			// change on that push (or the invalid draft and its error would
			// survive the successful reset).
			const beforeReset = draftSyncKey(300000, "workspace");
			const afterReset = draftSyncKey(300000, null);
			assert.notStrictEqual(afterReset, beforeReset);

			// Stable across pushes that change nothing, so typing is never
			// clobbered by an unrelated refresh; sensitive to value changes and
			// to null values becoming numbers.
			assert.strictEqual(draftSyncKey(300000, "workspace"), beforeReset);
			assert.notStrictEqual(draftSyncKey(60000, "workspace"), beforeReset);
			assert.notStrictEqual(draftSyncKey(null, null), draftSyncKey(300000, null));
		});
	});
});
