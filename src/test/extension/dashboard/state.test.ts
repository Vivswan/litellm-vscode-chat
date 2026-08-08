import * as assert from "node:assert";
import { resolveAdoptableCredentials, resolveExternalGroupIdentity } from "../../../extension/dashboard/adopt";
import { modelScopeKey } from "../../../extension/dashboard/adoptHandle";
import type { DashboardIntent } from "../../../extension/dashboard/intentSchema";
import { webviewMessageSchema } from "../../../extension/dashboard/intentSchema";
import {
	DashboardValidationError,
	executeDashboardIntent,
	readInlineSecretValues,
	validateModelParametersRecord,
	validateNumberSetting,
	validateSaveServerSetting,
	validateTestServerDraft,
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
import type { DashboardStateInputs, SettingsInspection, SettingsReader } from "../../../extension/dashboard/state";
import {
	buildDashboardState,
	EMPTY_CATALOG_STATUS,
	mostSpecificGlobalRecordKey,
	readDashboardSettings,
	resolveConfiguredScope,
	resolveDashboardModelCapabilities,
	resolveDashboardModelParameters,
	resolveUpdateScope,
} from "../../../extension/dashboard/state";
import type { DeclaredServerView } from "../../../extension/servers/serverSync";
import { REASONING_EFFORT_SCHEMA } from "../../../provider/catalog/modelConfiguration";
import { RequestError } from "../../../provider/transport/errorMapping";
import { EMPTY_CATALOG_LOOKUP } from "../../../shared/config/capabilityResolution";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { assertOmits, makeModelInfo, makeServerStatus } from "../../testUtils";
import { KEEP_ALL, makeEnv, type RecordedEnv } from "./recordedEnv";

/** A declared-server view with every secret absent; overrides fill in the specifics. */
function makeDeclared(overrides: Partial<DeclaredServerView> = {}): DeclaredServerView {
	return {
		label: "Prod",
		baseUrl: "http://prod.test",
		secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
		...overrides,
	};
}

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

/**
 * buildDashboardState in the positional shorthand these suites were written
 * against; inputs the shorthand does not cover (entryReports, catalog, usage,
 * diagnostics) go through buildDashboardState's options object directly.
 */
function buildState(
	snapshots: DashboardStateInputs["snapshots"],
	reader: SettingsReader,
	declared?: DashboardStateInputs["declared"],
	legacyServers?: DashboardStateInputs["legacyServers"],
	removedGroups?: DashboardStateInputs["removedGroups"],
	isGroupSnapshot?: DashboardStateInputs["isGroupSnapshot"]
) {
	return buildDashboardState({
		snapshots,
		reader,
		...(declared !== undefined ? { declared } : {}),
		...(legacyServers !== undefined ? { legacyServers } : {}),
		...(removedGroups !== undefined ? { removedGroups } : {}),
		...(isGroupSnapshot !== undefined ? { isGroupSnapshot } : {}),
	});
}

/** readDashboardSettings with the empty catalog status; the catalog row has its own coverage elsewhere. */
function readSettings(reader: SettingsReader) {
	return readDashboardSettings(reader, EMPTY_CATALOG_STATUS);
}

suite("extension/dashboard/state", () => {
	suite("buildDashboardState", () => {
		test("maps server statuses to dashboard servers, sorted by label", () => {
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ serverId: "b", label: "Zeta", hasApiKey: true }),
						models: [],
					},
					{
						discoveredRawIds: [],
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

		test("errorEnglish carries the status's log-safe rendering exactly when the display error is the transport error", () => {
			// The copyable diagnostics block stays English by policy; the webview
			// substitutes errorEnglish there while the on-screen row renders the
			// (possibly localized) error. A sync error has no separate English
			// mirror, so a row displaying one carries none.
			const external = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ state: "error", error: "LOCALIZED", logSafeError: "ENGLISH" }),
						models: [],
					},
				],
				makeReader({})
			);
			assert.strictEqual(external.servers[0]?.error, "LOCALIZED");
			assert.strictEqual(external.servers[0]?.errorEnglish, "ENGLISH");

			const declared = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ state: "error", error: "LOCALIZED", logSafeError: "ENGLISH" }),
						models: [],
					},
				],
				makeReader({}),
				[makeDeclared()]
			);
			assert.strictEqual(declared.servers[0]?.origin, "declared");
			assert.strictEqual(declared.servers[0]?.error, "LOCALIZED");
			assert.strictEqual(declared.servers[0]?.errorEnglish, "ENGLISH");

			const synced = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ state: "error", error: "LOCALIZED", logSafeError: "ENGLISH" }),
						models: [],
					},
				],
				makeReader({}),
				[makeDeclared({ syncError: "sync failed", syncErrorClass: "upsertFailed" })]
			);
			assert.strictEqual(synced.servers[0]?.error, "sync failed", "the sync error still masks the live error");
			assert.strictEqual(
				synced.servers[0]?.errorEnglish,
				undefined,
				"a masked transport error must not lend its mirror to the sync error"
			);
		});

		test("classification rides the error row under the same rule as errorEnglish", () => {
			// The webview maps the setup-hint id to a troubleshooting link; only
			// the classification crosses the boundary (enum ids, never text).
			const classification = { kind: "connection", setupHint: "proxy-not-running" } as const;
			const external = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ state: "error", error: "boom", classification }),
						models: [],
					},
				],
				makeReader({})
			);
			assert.strictEqual(external.servers[0]?.origin, "external");
			assert.deepStrictEqual(external.servers[0]?.classification, classification);

			const declared = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ state: "error", error: "boom", classification }),
						models: [],
					},
				],
				makeReader({}),
				[makeDeclared()]
			);
			assert.strictEqual(declared.servers[0]?.origin, "declared");
			assert.deepStrictEqual(declared.servers[0]?.classification, classification);

			// An unclassified failure carries no field at all (conditional spread,
			// never an explicit undefined).
			const unclassified = buildState(
				[{ discoveredRawIds: [], status: makeServerStatus({ state: "error", error: "boom" }), models: [] }],
				makeReader({})
			);
			const unclassifiedRow = unclassified.servers[0];
			assert.ok(unclassifiedRow !== undefined && !("classification" in unclassifiedRow));

			// A sync error masks the transport error and must not borrow the
			// masked error's classification: the hint would advise on a failure
			// the row is not displaying.
			const synced = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ state: "error", error: "boom", classification }),
						models: [],
					},
				],
				makeReader({}),
				[makeDeclared({ syncError: "sync failed", syncErrorClass: "upsertFailed" })]
			);
			assert.strictEqual(synced.servers[0]?.error, "sync failed");
			const syncedRow = synced.servers[0];
			assert.ok(syncedRow !== undefined && !("classification" in syncedRow));
		});

		test("legacy registry servers with no row of their own are counted, never listed", () => {
			const state = buildState(
				[{ discoveredRawIds: [], status: makeServerStatus(), models: [] }],
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
			assertOmits(JSON.stringify(state.servers), "old.test", "legacy servers contribute no row");
		});

		test("a declared row also shadows its legacy twin; without legacy input the count is zero", () => {
			const shadowed = buildState([], makeReader({}), [makeDeclared()], [{ baseUrl: "http://prod.test" }]);
			assert.strictEqual(shadowed.legacyServerCount, 0);

			assert.strictEqual(buildState([], makeReader({})).legacyServerCount, 0);
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ label: "Prod", baseUrl: "http://prod.test", modelCount: 4 }),
						models: [],
					},
				],
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ serverId: "s1", label: "Staging", baseUrl: "http://x.test", modelCount: 1 }),
						models: [],
					},
					{
						discoveredRawIds: [],
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({
							serverId: "group:fp-staging:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							modelCount: 1,
						}),
						models: [],
					},
					{
						discoveredRawIds: [],
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({
							serverId: "group:labeled:fp-a:http://x.test",
							label: "Prod",
							baseUrl: "http://x.test",
							modelCount: 1,
						}),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
					{
						discoveredRawIds: [],
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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
			assert.deepStrictEqual(byLabel.get("Prod")?.notices, ["entry-params-inactive"]);
			assert.strictEqual(byLabel.get("Prod")?.state, "ok", "the notice never degrades the live status");
			assert.strictEqual(byLabel.get("Staging")?.notices, undefined, "no entry parameters, nothing to flag");
		});

		test("an entry with modelParameters joined by its exact labeled identity carries no notice", () => {
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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

			assert.strictEqual(state.servers[0]?.notices, undefined, "a labeled group serves the entry's parameters");
		});

		test("an entry with modelParameters joined by the label-and-URL fallback still flags them", () => {
			// The snapshot's display label is the URL host, so this pass can match
			// an unlabeled group whose credentials differ from the entry (neither
			// identity joins). Only the exact labeled-identity join proves the
			// group carries the entry's label; anything else must warn.
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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

			assert.deepStrictEqual(state.servers[0]?.notices, ["entry-params-inactive"]);
			assert.strictEqual(state.servers[0]?.state, "ok", "the notice never degrades the live status");
		});

		test("an entry with modelParameters joined by the URL-only fallback still flags them", () => {
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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

			assert.deepStrictEqual(state.servers[0]?.notices, ["entry-params-inactive"]);
		});

		test("the shared pass never crosses connections: a different-credential entry keeps its own outcome", () => {
			// One live group under key A. The entry declaring key B shares only
			// the URL, not the connection, so handing it key A's status would
			// claim a server it cannot reach is healthy; it must stay unchecked
			// (the URL fallback finds the snapshot already claimed).
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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
			const state = buildState([], makeReader({}), [
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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
					discoveredRawIds: [],
					status: makeServerStatus({
						serverId: "group:fp-a:http://ext.test",
						label: "ext.test",
						baseUrl: "http://ext.test",
					}),
					models: [],
				},
				{
					discoveredRawIds: [],
					status: makeServerStatus({
						serverId: "group:fp-b:http://prod.test",
						label: "Prod",
						baseUrl: "http://prod.test",
					}),
					models: [],
				},
			];
			const declared = [makeDeclared({ label: "Prod", baseUrl: "http://prod.test" })];
			const state = buildState(snapshots, makeReader({}), declared);

			const byLabel = new Map(state.servers.map((server) => [server.label, server]));
			const external = byLabel.get("ext.test");
			assert.strictEqual(external?.origin, "external");
			assert.ok(typeof external?.adoptHandle === "string" && external.adoptHandle.length > 0);
			assert.strictEqual(byLabel.get("Prod")?.adoptHandle, undefined, "declared rows are not adoptable");
			// The webview holds a handle across background refreshes, so a rebuild
			// must mint the same one; and the handle must not leak what it derives
			// from (the serverId embeds the group's credential fingerprint).
			const rebuilt = buildState(snapshots, makeReader({}), declared);
			assert.strictEqual(rebuilt.servers.find((s) => s.label === "ext.test")?.adoptHandle, external.adoptHandle);
			assert.ok(!JSON.stringify(state).includes("fp-a"), "the handle never exposes the serverId it derives from");
		});

		test("no secret value ever reaches the state, only locations", () => {
			const state = buildState(
				[{ discoveredRawIds: [], status: makeServerStatus({ hasApiKey: true }), models: [] }],
				makeReader({}),
				[makeDeclared({ secrets: { apiKey: "settings", oauthClientSecret: "secure", virtualKeyValue: "none" } })]
			);

			const serialized = JSON.stringify(state);
			assert.ok(!serialized.includes("sk-"), serialized);
			assert.ok(serialized.includes('"apiKey":"settings"'), "locations are reported");
		});

		test("colliding server labels get positional suffixes, on the servers and their models", () => {
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ serverId: "s1", label: "litellm.test", baseUrl: "http://litellm.test" }),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
					{
						discoveredRawIds: [],
						status: makeServerStatus({ serverId: "s2", label: "litellm.test", baseUrl: "http://litellm.test" }),
						models: [makeModelInfo({ id: "m2", name: "m2" })],
					},
					{ discoveredRawIds: [], status: makeServerStatus({ serverId: "s3", label: "Other" }), models: [] },
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ serverId: "group:secret-fingerprint:http://x" }),
						models: [makeModelInfo()],
					},
				],
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
				litellm: {
					supportsPromptCaching: true,
					outputLimitSource: "provider",
					serverDeclared: { kind: "discovered", values: {}, outputDeclared: true },
				},
			});
			const state = buildState([{ discoveredRawIds: [], status: makeServerStatus(), models: [info] }], makeReader({}));

			assert.strictEqual(state.models.length, 1);
			const model = state.models[0];
			assert.deepStrictEqual(model, {
				id: "claude",
				rawId: "claude",
				scopeKey: modelScopeKey("srv1"),
				name: "claude",
				family: "anthropic",
				serverLabel: "Prod",
				maxInputTokens: 100000,
				maxOutputTokens: 8000,
				outputLimitDeclared: true,
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
			const state = buildState(
				[{ discoveredRawIds: [], status: makeServerStatus(), models: [makeModelInfo()] }],
				makeReader({})
			);

			const model = state.models[0];
			assert.strictEqual(model?.inputCost, undefined);
			assert.strictEqual(model?.toolCalling, false);
			assert.strictEqual(model?.imageInput, false);
			assert.strictEqual(model?.promptCaching, false);
			assert.strictEqual(model?.reasoning, false);
		});

		test("models from several servers are flattened and sorted by server label then name", () => {
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ serverId: "srv2", label: "Zeta" }),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
					{
						discoveredRawIds: [],
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ serverId: "g1", label: "Prod", baseUrl: "http://prod.test" }),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
					{
						discoveredRawIds: [],
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ serverId: "g1", label: "Dup", baseUrl: "http://a.test" }),
						models: [],
					},
					{
						discoveredRawIds: [],
						status: makeServerStatus({ serverId: "g2", label: "Dup", baseUrl: "http://b.test" }),
						models: [],
					},
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
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ label: "Prod", baseUrl: "http://prod.test" }),
						models: [],
					},
				],
				makeReader({}),
				[makeDeclared()],
				[],
				{ tombstones: [{ label: "Prod", baseUrl: "http://prod.test" }], origins: [] }
			);

			assert.strictEqual(state.servers.length, 1);
			assert.strictEqual(state.servers[0]?.origin, "declared");
		});

		test("hidden groups persist without a live snapshot, so unhide stays offered", () => {
			const state = buildState([], makeReader({}), [], [], {
				tombstones: [{ label: "Gone", baseUrl: "http://gone.test" }],
				origins: [],
			});

			assert.deepStrictEqual(state.servers, []);
			assert.deepStrictEqual(state.hiddenGroups, [{ label: "Gone", baseUrl: "http://gone.test" }]);
		});

		test("a tombstone whose group was never observed this session is a ghost and stays off the hidden line", () => {
			// The user can delete a tombstoned group from the models file directly;
			// after the restart the host never calls for it, so offering Unhide
			// would reference nothing. The panel's session-sticky observation set
			// feeds this gate; the observed identity keeps its row even with no
			// live snapshot in this push (snapshot aging must not flap it off).
			const state = buildDashboardState({
				snapshots: [],
				reader: makeReader({}),
				removedGroups: {
					tombstones: [
						{ label: "Ghost", baseUrl: "http://ghost.test" },
						{ label: "Seen", baseUrl: "http://seen.test" },
					],
					origins: [],
				},
				wasGroupObserved: (label) => label === "Seen",
			});

			assert.deepStrictEqual(state.hiddenGroups, [{ label: "Seen", baseUrl: "http://seen.test" }]);
		});

		test("a registry-backed snapshot is never suppressed and its row is not hideable", () => {
			// In test mode (and pre-migration) the legacy registry contributes
			// external-looking rows; the registry sweep would keep serving their
			// models, so a tombstone must not hide them and the row offers no
			// Remove (hideable false).
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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
			const state = buildState(
				[{ discoveredRawIds: [], status: makeServerStatus({ serverId: "g1", label: "Prod" }), models: [] }],
				makeReader({})
			);
			assert.strictEqual(state.servers[0]?.hideable, true);
		});

		test("external rows carry their recorded provenance; unrecorded rows carry none", () => {
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ serverId: "g1", label: "Old", baseUrl: "http://host.test" }),
						models: [],
					},
					{
						discoveredRawIds: [],
						status: makeServerStatus({ serverId: "g2", label: "Other", baseUrl: "http://other.test" }),
						models: [],
					},
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

	suite("buildDashboardState: request scopes", () => {
		test("models carry the raw ID with the legacy multi-server namespace stripped", () => {
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ serverId: "srv1" }),
						models: [makeModelInfo({ id: "srv1/gpt-4", name: "gpt-4" })],
					},
				],
				makeReader({})
			);
			assert.strictEqual(state.models[0]?.id, "srv1/gpt-4", "the exposed ID stays the row identity");
			assert.strictEqual(state.models[0]?.rawId, "gpt-4", "the raw ID is what requests and prefixes match");
		});

		test("group models are already raw, and outputLimitDeclared mirrors the litellm provenance", () => {
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ serverId: "g1" }),
						models: [
							makeModelInfo({ id: "gpt-4", name: "a" }),
							makeModelInfo({
								id: "claude",
								name: "b",
								litellm: {
									supportsPromptCaching: false,
									outputLimitSource: "provider",
									serverDeclared: { kind: "discovered", values: {}, outputDeclared: true },
								},
							}),
						],
					},
				],
				makeReader({})
			);
			assert.deepStrictEqual(
				state.models.map((model) => [model.rawId, model.outputLimitDeclared]),
				[
					["gpt-4", false],
					["claude", true],
				]
			);
		});

		test("every model's scopeKey resolves through the readModelParameters responder; a stale key answers nothing", () => {
			const snapshots = [
				{
					discoveredRawIds: [],
					status: makeServerStatus({ serverId: "g1", label: "Prod", baseUrl: "http://prod.test/" }),
					models: [makeModelInfo({ id: "m1", name: "m1" })],
				},
			];
			const state = buildState(snapshots, makeReader({}));
			const model = state.models[0];
			assert.ok(model !== undefined);
			const query = { snapshots, reader: makeReader({}), resolveEntryParameters: () => undefined };
			const answer = resolveDashboardModelParameters(query, model.scopeKey, model.rawId);
			assert.ok(answer !== undefined, "the pushed scope key resolves");
			assert.strictEqual(answer.entryLabel, undefined, "no declared entry matched, so no label rides the answer");
			assert.strictEqual(
				resolveDashboardModelParameters(query, modelScopeKey("no-such-server"), model.rawId),
				undefined,
				"a key minted for a departed snapshot de-resolves instead of hitting another server"
			);
		});

		test("the injected resolver's entry parameters reach only the resolving snapshot's models", () => {
			// Two same-label groups at one URL: the responder resolves by the scope
			// key's server ID, so only the snapshot whose server ID resolves gets
			// the entry's parameters - a label-keyed lookup would hand them to both.
			const entryParameters = { "*": { temperature: 0.2 } };
			const snapshots = [
				{
					discoveredRawIds: [],
					status: makeServerStatus({ serverId: "g1", label: "Team", baseUrl: "http://prod.test" }),
					models: [makeModelInfo({ id: "m1", name: "m1" })],
				},
				{
					discoveredRawIds: [],
					status: makeServerStatus({ serverId: "g2", label: "Team", baseUrl: "http://prod.test" }),
					models: [makeModelInfo({ id: "m2", name: "m2" })],
				},
			];
			const state = buildState(snapshots, makeReader({}));
			const query = {
				snapshots,
				reader: makeReader({}),
				resolveEntryParameters: (serverId: string) =>
					serverId === "g1" ? { entryLabel: "Team", entryParameters } : undefined,
			};
			const modelByRaw = (rawId: string) => state.models.find((model) => model.rawId === rawId);
			const answerFor = (rawId: string) => {
				const model = modelByRaw(rawId);
				assert.ok(model !== undefined, rawId);
				return resolveDashboardModelParameters(query, model.scopeKey, model.rawId);
			};
			const resolving = answerFor("m1");
			assert.strictEqual(resolving?.entryLabel, "Team");
			const row = resolving?.projection.rows.find((candidate) => candidate.name === "temperature");
			assert.strictEqual(row?.value, 0.2);
			assert.deepStrictEqual(row?.source, { layer: "entry", key: "*" });
			const other = answerFor("m2");
			assert.ok(other !== undefined);
			assert.strictEqual(other.entryLabel, undefined, "the sibling group carries no entry resolution");
			assert.deepStrictEqual(other.projection.rows, [], "no entry parameters reach the sibling's models");
			assert.notStrictEqual(modelByRaw("m1")?.scopeKey, modelByRaw("m2")?.scopeKey);
		});

		test("a tombstoned snapshot contributes no models and the remaining scope keys stay resolvable", () => {
			const snapshots = [
				{
					discoveredRawIds: [],
					status: makeServerStatus({ serverId: "g1", label: "Hidden", baseUrl: "http://hidden.test" }),
					models: [makeModelInfo({ id: "m1", name: "m1" })],
				},
				{
					discoveredRawIds: [],
					status: makeServerStatus({ serverId: "g2", label: "Live", baseUrl: "http://live.test" }),
					models: [makeModelInfo({ id: "m2", name: "m2" })],
				},
			];
			const state = buildState(snapshots, makeReader({}), [], [], {
				tombstones: [{ label: "Hidden", baseUrl: "http://hidden.test" }],
				origins: [],
			});
			assert.deepStrictEqual(
				state.models.map((model) => model.serverLabel),
				["Live"]
			);
			const query = { snapshots, reader: makeReader({}), resolveEntryParameters: () => undefined };
			for (const model of state.models) {
				assert.ok(
					resolveDashboardModelParameters(query, model.scopeKey, model.rawId) !== undefined,
					"every surviving model's scope resolves"
				);
			}
		});
	});

	suite("buildDashboardState: capabilities and expected failures", () => {
		test("the config prefill carries the entry's modelCapabilities and expectedFailures", () => {
			const state = buildState([], makeReader({}), [
				makeDeclared({
					modelCapabilities: { "my-model": { context_length: 128000 } },
					expectedFailures: ["modelListing"],
				}),
			]);
			const server = state.servers[0];
			assert.ok(server?.origin === "declared");
			assert.deepStrictEqual(server.config.modelCapabilities, {
				"my-model": { context_length: 128000 },
			});
			assert.deepStrictEqual(server.config.expectedFailures, ["modelListing"]);
		});

		test("a non-identity join flags capabilities and expected failures inactive, beside the params notice", () => {
			const state = buildState(
				[
					{
						discoveredRawIds: [],
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
						modelCapabilities: { "gpt-4": { supports_vision: true } },
					}),
				]
			);
			assert.deepStrictEqual(state.servers[0]?.notices, ["entry-params-inactive", "entry-capabilities-inactive"]);
		});

		test("expectedFailures alone also raises the capabilities-inactive notice on a non-identity join", () => {
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({
							serverId: "group:fp-other:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
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
						expectedFailures: ["modelInfo"],
					}),
				]
			);
			assert.deepStrictEqual(state.servers[0]?.notices, ["entry-capabilities-inactive"]);
		});

		test("an expected failure rides the row with its declared count as the model count", () => {
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({
							serverId: "group:fp-prod-labeled:http://x.test",
							label: "Prod",
							baseUrl: "http://x.test",
							state: "error",
							error: "404 on /models",
							expected: true,
							declaredModelCount: 2,
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
						expectedFailures: ["modelListing"],
					}),
				]
			);
			const server = state.servers[0];
			assert.ok(server?.state === "error");
			assert.strictEqual(server.expected, true);
			assert.strictEqual(server.declaredModelCount, 2);
			assert.strictEqual(server.modelCount, 2, "declared models join the row's count");
			assert.strictEqual(server.notices, undefined, "declared models mean nothing to flag");
		});

		test("an expected failure with nothing declared raises the needs-declare notice", () => {
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({
							serverId: "group:fp-prod-labeled:http://x.test",
							label: "Prod",
							baseUrl: "http://x.test",
							state: "error",
							error: "404 on /models",
							expected: true,
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
						expectedFailures: ["modelListing"],
					}),
				]
			);
			const server = state.servers[0];
			assert.ok(server?.state === "error");
			assert.strictEqual(server.modelCount, 0);
			assert.deepStrictEqual(server.notices, ["expected-failures-nothing-declared"]);
		});

		test("a declared model's badge marker rides the dashboard model; discovered models carry none", () => {
			const state = buildState(
				[
					{
						discoveredRawIds: [],
						status: makeServerStatus({ serverId: "g1" }),
						models: [
							makeModelInfo({ id: "gpt-4", name: "a" }),
							makeModelInfo({
								id: "my-model",
								name: "b",
								litellm: {
									supportsPromptCaching: false,
									outputLimitSource: "defaults",
									declared: true,
									serverDeclared: { kind: "declared" },
								},
							}),
						],
					},
				],
				makeReader({})
			);
			assert.deepStrictEqual(
				state.models.map((model) => [model.rawId, model.declared]),
				[
					["gpt-4", undefined],
					["my-model", true],
				]
			);
		});
	});

	suite("mostSpecificGlobalRecordKey", () => {
		test("names the most specific matching key of the addressed map, or nothing", () => {
			const reader = makeReader({
				"models.parameters": { "*": { temperature: 0.7 }, "gpt*": { temperature: 0.3 } },
				"models.capabilities": { "claude-4": { supports_vision: true } },
			});
			assert.strictEqual(mostSpecificGlobalRecordKey(reader, "parameters", "gpt-4"), "gpt*");
			assert.strictEqual(mostSpecificGlobalRecordKey(reader, "parameters", "claude-4"), "*");
			assert.strictEqual(mostSpecificGlobalRecordKey(reader, "capabilities", "claude-4"), "claude-4");
			assert.strictEqual(mostSpecificGlobalRecordKey(reader, "capabilities", "gpt-4"), undefined);
			assert.strictEqual(mostSpecificGlobalRecordKey(makeReader({}), "parameters", "gpt-4"), undefined);
		});
	});

	suite("resolveDashboardModelCapabilities", () => {
		const snapshots = [
			{
				discoveredRawIds: [],
				status: makeServerStatus({ serverId: "g1", baseUrl: "http://x.test" }),
				models: [makeModelInfo({ id: "gpt-4", name: "gpt-4" })],
			},
		];

		test("resolves through the shared walk: entry beats global beats the floor, shadowed values kept", () => {
			const capabilities = resolveDashboardModelCapabilities(
				{
					snapshots,
					reader: makeReader({ "models.capabilities": { "gpt-4": { context_length: 111 } } }),
					resolveEntryCapabilities: () => ({ "gpt-4": { context_length: 222 } }),
					catalog: EMPTY_CATALOG_LOOKUP,
				},
				modelScopeKey("g1"),
				"gpt-4"
			);
			assert.ok(capabilities !== undefined);
			assert.strictEqual(capabilities.fields.context_length.value, 222);
			assert.strictEqual(capabilities.fields.context_length.level, "entry");
			assert.deepStrictEqual(
				capabilities.fields.context_length.shadowed.map((shadow) => [shadow.level, shadow.value]),
				[["global", 111]]
			);
			assert.strictEqual(capabilities.fields.supports_vision.level, "floor");
			assert.strictEqual(capabilities.outputLimitSource, "defaults");
		});

		test("a server baseline riding the model metadata resolves at the server level", () => {
			const withBaseline = [
				{
					discoveredRawIds: [],
					status: makeServerStatus({ serverId: "g1", baseUrl: "http://x.test" }),
					models: [
						makeModelInfo({
							id: "gpt-4",
							name: "gpt-4",
							litellm: {
								supportsPromptCaching: false,
								outputLimitSource: "provider",
								serverDeclared: {
									kind: "discovered",
									values: { context_length: 999, max_output_tokens: 500 },
									outputDeclared: true,
								},
							},
						}),
					],
				},
			];
			const capabilities = resolveDashboardModelCapabilities(
				{
					snapshots: withBaseline,
					reader: makeReader({}),
					resolveEntryCapabilities: () => undefined,
					catalog: EMPTY_CATALOG_LOOKUP,
				},
				modelScopeKey("g1"),
				"gpt-4"
			);
			assert.ok(capabilities !== undefined);
			assert.strictEqual(capabilities.fields.context_length.value, 999);
			assert.strictEqual(capabilities.fields.context_length.level, "server");
			assert.strictEqual(capabilities.outputLimitSource, "provider");
		});

		test("a claimed snapshot whose entry label differs from the group's still resolves its models", () => {
			// The population the entry-capabilities-inactive notice exists for:
			// entry "Prod", group label "x.test". The model rows render under the
			// entry label, and their scope keys must still answer - the key hashes
			// the server ID, so no label enters the resolution at all.
			const divergent = [
				{
					discoveredRawIds: [],
					status: makeServerStatus({
						serverId: "group:fp-other:http://x.test",
						label: "x.test",
						baseUrl: "http://x.test",
					}),
					models: [makeModelInfo({ id: "gpt-4", name: "gpt-4" })],
				},
			];
			const state = buildState(divergent, makeReader({}), [makeDeclared({ label: "Prod", baseUrl: "http://x.test" })]);
			assert.strictEqual(state.models[0]?.serverLabel, "Prod", "the row renders under the claimant label");
			const capabilities = resolveDashboardModelCapabilities(
				{
					snapshots: divergent,
					reader: makeReader({}),
					resolveEntryCapabilities: () => undefined,
					catalog: EMPTY_CATALOG_LOOKUP,
				},
				state.models[0]?.scopeKey ?? "",
				state.models[0]?.rawId ?? ""
			);
			assert.ok(capabilities !== undefined, "a divergent-label row must still resolve");
		});

		test("two groups on one host resolve their own capabilities despite the ordinal display labels", () => {
			const twoGroups = [
				{
					discoveredRawIds: [],
					status: makeServerStatus({ serverId: "g-a", label: "Prod", baseUrl: "http://x.test" }),
					models: [makeModelInfo({ id: "gpt-4", name: "gpt-4" })],
				},
				{
					discoveredRawIds: [],
					status: makeServerStatus({ serverId: "g-b", label: "Prod", baseUrl: "http://x.test" }),
					models: [makeModelInfo({ id: "gpt-4", name: "gpt-4" })],
				},
			];
			const state = buildState(twoGroups, makeReader({}));
			const keys = state.models.map((model) => model.scopeKey);
			assert.strictEqual(new Set(keys).size, 2, "each group's models carry their own key");
			for (const model of state.models) {
				const capabilities = resolveDashboardModelCapabilities(
					{
						snapshots: twoGroups,
						reader: makeReader({}),
						resolveEntryCapabilities: () => undefined,
						catalog: EMPTY_CATALOG_LOOKUP,
					},
					model.scopeKey,
					model.rawId
				);
				assert.ok(capabilities !== undefined, `the ${model.serverLabel} row must resolve`);
			}
		});

		test("a stale scope key, a malformed one, or an unknown raw ID answers undefined", () => {
			const query = {
				snapshots,
				reader: makeReader({}),
				resolveEntryCapabilities: () => undefined,
				catalog: EMPTY_CATALOG_LOOKUP,
			};
			assert.strictEqual(resolveDashboardModelCapabilities(query, "s0", "gpt-4"), undefined);
			assert.strictEqual(resolveDashboardModelCapabilities(query, "bogus", "gpt-4"), undefined);
			assert.strictEqual(resolveDashboardModelCapabilities(query, modelScopeKey("g1"), "no-such-model"), undefined);
			// A key minted for a server that left the window de-resolves; it can
			// never re-point at whatever server the snapshot list now holds.
			assert.strictEqual(resolveDashboardModelCapabilities(query, modelScopeKey("gone"), "gpt-4"), undefined);
		});
	});

	suite("readDashboardSettings", () => {
		test("passes configured finite numbers through, even out of range", () => {
			const settings = readSettings(makeReader({ "chat.timeout": 5, "usage.pollInterval": 60000 }));

			assert.strictEqual(settings.numbers["chat.timeout"], 5);
			assert.strictEqual(settings.numbers["usage.pollInterval"], 60000);
		});

		test("falls back to the package.json default for unusable values", () => {
			const settings = readSettings(
				makeReader(
					{ "chat.timeout": "soon", "discovery.timeout": Number.NaN },
					{ "chat.timeout": 300000, "discovery.timeout": 30000 }
				)
			);

			assert.strictEqual(settings.numbers["chat.timeout"], 300000);
			assert.strictEqual(settings.numbers["discovery.timeout"], 30000);
		});

		test("without a usable default, numbers fall back to the minimum", () => {
			const settings = readSettings(makeReader({ "chat.timeout": "soon" }));

			assert.strictEqual(settings.numbers["chat.timeout"], 1000);
		});

		test("booleans pass through and fall back to the default for junk", () => {
			const settings = readSettings(
				makeReader({ "chat.promptCaching": false, "ui.maskSecretInputs": "yes" }, { "ui.maskSecretInputs": true })
			);

			assert.strictEqual(settings.booleans["chat.promptCaching"], false);
			assert.strictEqual(settings.booleans["ui.maskSecretInputs"], true);
		});

		test("every catalog entry is present in the snapshot", () => {
			const settings = readSettings(makeReader({}));

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
			const settings = readSettings(
				makeReader(
					{ "chat.timeout": 60000, "ui.maskSecretInputs": true },
					{},
					{
						"discovery.timeout": { workspaceValue: 5000 },
						"discovery.cacheTtl": { globalValue: 1, workspaceValue: 2, workspaceFolderValue: 3 },
					}
				)
			);

			assert.strictEqual(settings.configuredScopes.numbers["chat.timeout"], "global");
			assert.strictEqual(settings.configuredScopes.numbers["discovery.timeout"], "workspace");
			assert.strictEqual(settings.configuredScopes.numbers["discovery.cacheTtl"], "workspaceFolder");
			assert.strictEqual(settings.configuredScopes.numbers["usage.pollInterval"], null);
			assert.strictEqual(settings.configuredScopes.booleans["ui.maskSecretInputs"], "global");
			assert.strictEqual(settings.configuredScopes.booleans["chat.promptCaching"], null);
		});

		test("a value pinned to exactly its default still counts as configured", () => {
			const settings = readSettings(makeReader({ "chat.timeout": 300000 }, { "chat.timeout": 300000 }));

			assert.strictEqual(settings.numbers["chat.timeout"], 300000);
			assert.strictEqual(settings.configuredScopes.numbers["chat.timeout"], "global");
		});

		test("records come from the edit scope's own value, never the merged one", () => {
			const settings = readSettings(
				makeReader(
					{ "models.parameters": { "gpt-4": { temperature: 0.1 }, "gpt-5": { temperature: 0.2 } } },
					{},
					{
						"models.parameters": {
							globalValue: { "gpt-4": { temperature: 0.1 } },
							workspaceValue: { "gpt-5": { temperature: 0.2 } },
						},
					}
				)
			);

			assert.strictEqual(settings.modelParameters.editScope, "workspace");
			assert.deepStrictEqual(
				settings.modelParameters.value,
				{ "gpt-5": { temperature: 0.2 } },
				"the user-scope value must not leak in"
			);
			assert.deepStrictEqual(settings.modelParameters.otherScopes, [
				{ scope: "global", value: { "gpt-4": { temperature: 0.1 } } },
			]);
		});

		test("records default to the user scope when only it holds a value", () => {
			const settings = readSettings(
				makeReader({}, {}, { "models.parameters": { globalValue: { "gpt-4": { temperature: 0.2 } } } })
			);

			assert.strictEqual(settings.modelParameters.editScope, "global");
			assert.deepStrictEqual(settings.modelParameters.value, { "gpt-4": { temperature: 0.2 } });
			assert.deepStrictEqual(settings.modelParameters.otherScopes, []);
		});

		test("a workspace-folder record shows up read-only and never becomes the edit scope", () => {
			const settings = readSettings(
				makeReader({}, {}, { "models.parameters": { workspaceFolderValue: { "gpt-4": { temperature: 0.2 } } } })
			);

			assert.strictEqual(settings.modelParameters.editScope, "global");
			assert.deepStrictEqual(settings.modelParameters.otherScopes, [
				{ scope: "workspaceFolder", value: { "gpt-4": { temperature: 0.2 } } },
			]);
		});

		test("modelParameters drops malformed and prototype-polluting entries but keeps the rest", () => {
			const settings = readSettings(
				makeReader(
					{},
					{},
					{
						"models.parameters": {
							globalValue: JSON.parse(
								'{"gpt-4": {"temperature": 0.2}, "broken": "not-an-object", "__proto__": {"polluted": true}}'
							) as unknown,
						},
					}
				)
			);

			assert.deepStrictEqual(settings.modelParameters.value, { "gpt-4": { temperature: 0.2 } });
		});

		test("a non-object modelParameters value reads as empty", () => {
			const settings = readSettings(makeReader({}, {}, { "models.parameters": { globalValue: [1, 2] } }));

			assert.deepStrictEqual(settings.modelParameters.value, {});
		});

		test("effective is the scope-merged read (reader.get), normalized like the request path", () => {
			// makeReader's get() answers from `values`, standing in for VS Code's
			// own cross-scope merge; the per-scope records come from inspect. The
			// inspector must see the merged record even when the edit scope holds
			// only part of it.
			const settings = readSettings(
				makeReader(
					{ "models.parameters": { "gpt-4": { temperature: 0.2 }, bad: 7 } },
					{},
					{ "models.parameters": { workspaceValue: { "gpt-4": { temperature: 0.2 } } } }
				)
			);
			assert.deepStrictEqual(settings.modelParameters.effective, { "gpt-4": { temperature: 0.2 } });
			assert.strictEqual(settings.modelParameters.editScope, "workspace");
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
				{ type: "setNumberSetting", setting: "chat.timeout", value: 60000 },
				{ type: "setBooleanSetting", setting: "chat.promptCaching", value: false },
				{ type: "resetSetting", setting: "chat.timeout" },
				{ type: "resetSetting", setting: "ui.maskSecretInputs" },
				{ type: "revealSetting", setting: "chat.timeout" },
				{ type: "revealSetting", setting: "chat.promptCaching" },
				{ type: "revealSetting", setting: "models.parameters" },
				{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2, stop: ["\n"] } } },
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
				{
					type: "testServerDraft",
					server: { label: "", baseUrl: "http://prod.test", oauthTokenUrl: "https://idp.test/token" },
					secrets: KEEP_ALL,
					requestId: "req-t",
				},
				{
					type: "testServerDraft",
					server: { label: "Prod", baseUrl: "http://prod.test" },
					secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "sk-1" } },
					replaceLabel: "Prod",
					requestId: "req-t2",
				},
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
				{ type: "setNumberSetting", setting: "chat.timeout", value: "1000" },
				{ type: "setNumberSetting", setting: "chat.timeout", value: Number.POSITIVE_INFINITY },
				{ type: "setBooleanSetting", setting: "chat.promptCaching", value: "true" },
				{ type: "resetSetting", setting: "notASetting" },
				{ type: "resetSetting", setting: "chat.timeout", value: 1 },
				// revealSetting: only classification-listed ids cross - never
				// arbitrary key text or fully-qualified ids.
				{ type: "revealSetting", setting: "serverSecrets" },
				{ type: "revealSetting", setting: "litellm-vscode-chat.chat.timeout" },
				{ type: "revealSetting" },
				{ type: "revealSetting", setting: "chat.timeout", extra: 1 },
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
				// testServerDraft: the save payload's strictness verbatim - no inline
				// secret fields on the server object, no unknown fields riding along.
				{ type: "testServerDraft", server: { label: "P", baseUrl: "http://x" }, requestId: "r" },
				{ type: "testServerDraft", server: { label: "P", baseUrl: "http://x" }, secrets: KEEP_ALL },
				{
					type: "testServerDraft",
					server: { label: "P", baseUrl: "http://x", apiKey: "inline-not-allowed-here" },
					secrets: KEEP_ALL,
					requestId: "r",
				},
				{
					type: "testServerDraft",
					server: { label: "P", baseUrl: "http://x" },
					secrets: KEEP_ALL,
					requestId: "r",
					extra: 1,
				},
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
			{
				label: "Inline",
				baseUrl: "http://a.test",
				auth: { apiKey: " sk-inline ", virtualKey: { header: "x-vk", value: "vk-inline" } },
			},
			{ label: "Secure", baseUrl: "http://b.test" },
			{
				label: "Mixed",
				baseUrl: "http://c.test",
				auth: {
					oauth: { tokenUrl: "https://idp.test/token", clientId: "c1", apiKey: "sk-mixed", clientSecret: "   " },
				},
			},
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
			assert.deepStrictEqual(
				readInlineSecretValues([{ label: "N", baseUrl: "http://x", auth: { apiKey: "" } }], "N"),
				{}
			);
		});

		test("labels match trimmed, like entry lookup everywhere else", () => {
			assert.deepStrictEqual(
				readInlineSecretValues([{ label: " Prod ", baseUrl: "http://x", auth: { apiKey: "sk-1" } }], "Prod"),
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
				{ label: "Prod", auth: { apiKey: "sk-shadow" } },
				{ label: "Prod", baseUrl: "http://real.test", auth: { apiKey: "sk-real" } },
			];
			assert.deepStrictEqual(readInlineSecretValues(shadowed, "Prod"), { apiKey: "sk-real" });
		});

		test("a label the parser rejects yields nothing, even when a raw entry carries inline fields under it", () => {
			// The dashboard never declares this entry (reserved label), so a
			// crafted request must not be able to read its inline fields.
			const rejected = [{ label: "__proto__", baseUrl: "http://x.test", auth: { apiKey: "sk-hidden" } }];
			assert.deepStrictEqual(readInlineSecretValues(rejected, "__proto__"), {});
		});

		test("duplicate accepted labels resolve to the first, matching the parser's first-entry-wins rule", () => {
			const duplicated = [
				{ label: "Prod", baseUrl: "http://a.test", auth: { apiKey: "sk-first" } },
				{ label: "Prod", baseUrl: "http://b.test", auth: { apiKey: "sk-second" } },
			];
			assert.deepStrictEqual(readInlineSecretValues(duplicated, "Prod"), { apiKey: "sk-first" });
		});
	});

	suite("intent value validation", () => {
		test("validateNumberSetting enforces the per-setting minimum", () => {
			assert.notStrictEqual(validateNumberSetting("chat.timeout", 999), undefined);
			assert.strictEqual(validateNumberSetting("chat.timeout", 1000), undefined);
			assert.strictEqual(validateNumberSetting("discovery.cacheTtl", 0), undefined);
		});

		test("null is refused: no current setting is nullable", () => {
			assert.notStrictEqual(validateNumberSetting("chat.timeout", null), undefined);
			assert.notStrictEqual(validateNumberSetting("usage.pollInterval", null), undefined);
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

	suite("executeDashboardIntent: testServerDraft", () => {
		// Every probe carries the draft's expectedFailures in discovery's
		// per-endpoint shape, so expected endpoints probe with a single
		// attempt like production; a draft without any declares both false.
		const NO_EXPECTED = { modelInfo: false, modelListing: false };
		const draftTest = (
			recorded: RecordedEnv,
			partial: Partial<Extract<DashboardIntent, { type: "testServerDraft" }>> = {}
		): Promise<string | undefined> =>
			executeDashboardIntent(
				{
					type: "testServerDraft",
					server: { label: "Prod", baseUrl: "http://prod.test" },
					secrets: KEEP_ALL,
					requestId: "req-t1",
					...partial,
				},
				recorded.env
			);

		test("validateTestServerDraft: connection rules apply, label rules do not", () => {
			// The probe cares about the connection only: an empty or reserved
			// label must not block it (the button gates on the base URL alone).
			assert.strictEqual(validateTestServerDraft({ label: "", baseUrl: "http://x" }, KEEP_ALL), undefined);
			assert.strictEqual(validateTestServerDraft({ label: "__proto__", baseUrl: "http://x" }, KEEP_ALL), undefined);
			assert.notStrictEqual(validateTestServerDraft({ label: "Prod", baseUrl: "" }, KEEP_ALL), undefined);
			assert.notStrictEqual(validateTestServerDraft({ label: "Prod", baseUrl: "not a url" }, KEEP_ALL), undefined);
			assert.notStrictEqual(
				validateTestServerDraft({ label: "Prod", baseUrl: "http://x", oauthTokenUrl: "idp.test/token" }, KEEP_ALL),
				undefined
			);
			assert.notStrictEqual(
				validateTestServerDraft({ label: "Prod", baseUrl: "http://x", virtualKeyHeader: "bad header" }, KEEP_ALL),
				undefined
			);
			assert.notStrictEqual(
				validateTestServerDraft(
					{ label: "Prod", baseUrl: "http://x" },
					{ ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "" } }
				),
				undefined,
				"an empty set-value must be a clear, not a set"
			);
			const problem = validateTestServerDraft(
				{ label: "Prod", baseUrl: "http://x" },
				{ ...KEEP_ALL, virtualKeyValue: { action: "set", location: "secure", value: "vk-secret\n" } }
			);
			assert.ok(problem !== undefined);
			assert.ok(!problem.includes("vk-secret"), problem);
		});

		test("a set directive probes the typed value; nothing is written, stored, or synced", async () => {
			const recorded = makeEnv([]);
			const notice = await draftTest(recorded, {
				secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "sk-draft" } },
			});

			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", apiKey: "sk-draft", expected: NO_EXPECTED },
			]);
			assert.strictEqual(notice, "Connected - 0 models");
			// The no-mutation contract: a probe leaves every store untouched.
			assert.deepStrictEqual(recorded.serverWrites, []);
			assert.deepStrictEqual(recorded.secretOps, []);
			assert.deepStrictEqual(recorded.updates, []);
			assert.strictEqual(recorded.syncRequests, 0);
		});

		test("the success notice is static classification plus count, singular and plural", async () => {
			const recorded = makeEnv([]);
			recorded.probeResult = ["m1"];
			assert.strictEqual(await draftTest(recorded), "Connected - 1 model");
			recorded.probeResult = Array.from({ length: 12 }, (_, index) => `m${index}`);
			assert.strictEqual(await draftTest(recorded), "Connected - 12 models");
		});

		test("the edited entry's declared models join the count when not discovered; discovered ones stay inert", async () => {
			// The probe reports what a save would produce, and a save preserves
			// the edited entry's discovery.declared list verbatim.
			const recorded = makeEnv([
				{
					label: "Prod",
					baseUrl: "http://prod.test",
					discovery: { declared: ["my-model", "gpt-4"] },
				},
			]);
			recorded.probeResult = ["gpt-4"];
			const notice = await draftTest(recorded, {
				server: { label: "Prod", baseUrl: "http://prod.test" },
				replaceLabel: "Prod",
			});
			// gpt-4 is discovered, so its declaration is inert; my-model adds one.
			assert.strictEqual(notice, "Connected - 2 models (1 declared)");
		});

		test("a lone declared model on an empty discovery keeps the singular reading", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test", discovery: { declared: ["my-model"] } }]);
			recorded.probeResult = [];
			const notice = await draftTest(recorded, {
				server: { label: "Prod", baseUrl: "http://prod.test" },
				replaceLabel: "Prod",
			});
			assert.strictEqual(notice, "Connected - 1 model (declared)");
		});

		test("the probe carries the edited entry's custom headers, exactly what a save preserves", async () => {
			// A gateway requiring a header must not report a false probe failure
			// for a configuration that works once saved (the saved entry keeps
			// its headers verbatim, and the request path sends them).
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test", headers: { "x-cf-access": "token-1" } }]);
			recorded.probeResult = ["m1"];
			await draftTest(recorded, {
				server: { label: "Prod", baseUrl: "http://prod.test" },
				replaceLabel: "Prod",
			});
			assert.deepStrictEqual(recorded.probes[0]?.headers, { "x-cf-access": "token-1" });
		});

		test("an expected modelListing failure reports the declared models instead of failing", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test", discovery: { declared: ["my-model"] } }]);
			recorded.probeError = new RequestError("404 page not found", "http", { status: 404 });
			const notice = await draftTest(recorded, {
				server: {
					label: "Prod",
					baseUrl: "http://prod.test",
					expectedFailures: ["modelListing"],
				},
				replaceLabel: "Prod",
			});
			assert.strictEqual(notice, "Discovery failed (expected) - serving 1 declared model");
			// The draft's expectedFailures reach the probe in discovery's
			// per-endpoint shape, so the expected endpoint probes with a single
			// attempt exactly like production discovery.
			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", apiKey: "", expected: { modelInfo: false, modelListing: true } },
			]);
		});

		test("an expected modelListing failure with nothing declared still reports the expected outcome", async () => {
			const recorded = makeEnv([]);
			recorded.probeError = new RequestError("404 page not found", "http", { status: 404 });
			const notice = await draftTest(recorded, {
				server: { label: "Prod", baseUrl: "http://prod.test", expectedFailures: ["modelListing"] },
			});
			assert.strictEqual(notice, "Discovery failed (expected) - serving 0 declared models");
		});

		test("a failure outside the expected categories still fails the intent", async () => {
			const recorded = makeEnv([]);
			recorded.probeError = new RequestError("404 page not found", "http", { status: 404 });
			await assert.rejects(
				() =>
					draftTest(recorded, {
						server: { label: "Prod", baseUrl: "http://prod.test", expectedFailures: ["modelInfo"] },
					}),
				(error: unknown) => error instanceof DashboardValidationError
			);
		});

		test("keep while editing resolves inline from the accepted entry and secure from the stored blob", async () => {
			// Inline wins over a secure copy for apiKey (the sync engine's rule);
			// the OAuth client secret has no inline value and comes from storage.
			const recorded = makeEnv([
				{ label: "Shadow", auth: { apiKey: "sk-shadow" } },
				{
					label: "Prod",
					baseUrl: "http://old.test",
					auth: { oauth: { tokenUrl: "http://idp.test/token", clientId: "client-1", apiKey: "sk-inline" } },
				},
			]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-stale-secure", oauthClientSecret: "oa-secret" });
			await draftTest(recorded, {
				server: {
					label: "Prod",
					baseUrl: "http://new.test",
					oauthTokenUrl: "http://idp.test/token",
					oauthClientId: "client-1",
					oauthScopes: "read write",
				},
				replaceLabel: "Prod",
			});

			assert.deepStrictEqual(recorded.probes, [
				{
					baseUrl: "http://new.test",
					apiKey: "sk-inline",
					oauth: {
						tokenUrl: "http://idp.test/token",
						clientId: "client-1",
						clientSecret: "oa-secret",
						scopes: "read write",
					},
					expected: NO_EXPECTED,
				},
			]);
		});

		test("a fresh label inherits an orphan secure blob for keep, exactly as a save would", async () => {
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-orphan" });
			await draftTest(recorded);

			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", apiKey: "sk-orphan", expected: NO_EXPECTED },
			]);
		});

		test("clear probes without the credential even when one is stored", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-inline" }]);
			await draftTest(recorded, {
				secrets: { ...KEEP_ALL, apiKey: { action: "clear" } },
				replaceLabel: "Prod",
			});

			assert.deepStrictEqual(recorded.probes, [{ baseUrl: "http://prod.test", apiKey: "", expected: NO_EXPECTED }]);
			assert.deepStrictEqual(recorded.secretOps, [], "clear on a test deletes nothing");
		});

		test("the virtual key pair rides the probe; partial pairs are refused before it", async () => {
			const recorded = makeEnv([]);
			await draftTest(recorded, {
				server: { label: "Prod", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" },
				secrets: { ...KEEP_ALL, virtualKeyValue: { action: "set", location: "secure", value: "vk-1" } },
			});
			assert.deepStrictEqual(recorded.probes, [
				{
					baseUrl: "http://prod.test",
					apiKey: "",
					virtualKey: { header: "x-vk", value: "vk-1" },
					expected: NO_EXPECTED,
				},
			]);

			await assert.rejects(
				draftTest(recorded, { server: { label: "Prod", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" } }),
				/virtualKeyValue/
			);
			await assert.rejects(
				draftTest(recorded, {
					secrets: { ...KEEP_ALL, virtualKeyValue: { action: "set", location: "secure", value: "vk-1" } },
				}),
				/virtualKeyHeader/
			);
			await assert.rejects(
				draftTest(recorded, { server: { label: "Prod", baseUrl: "http://prod.test", oauthClientId: "client-1" } }),
				/oauthTokenUrl/
			);
			await assert.rejects(
				draftTest(recorded, {
					server: { label: "Prod", baseUrl: "http://prod.test", oauthTokenUrl: "http://idp.test/token" },
				}),
				/oauthClientId/
			);
			assert.strictEqual(recorded.probes.length, 1, "refused pairings never reach the probe");
		});

		test("an unusable base URL is refused before the probe runs", async () => {
			const recorded = makeEnv([]);
			await assert.rejects(draftTest(recorded, { server: { label: "Prod", baseUrl: "not a url" } }), /baseUrl/);
			assert.deepStrictEqual(recorded.probes, []);
		});

		test("editing an entry that vanished is refused like the save path", async () => {
			const recorded = makeEnv([]);
			await assert.rejects(draftTest(recorded, { replaceLabel: "Gone" }), /no longer exists/);
			assert.deepStrictEqual(recorded.probes, []);
		});

		test("a transport RequestError surfaces its user-facing message as a validation failure, unlogged", async () => {
			const recorded = makeEnv([]);
			recorded.probeError = new RequestError("Network Error: Unable to reach the LiteLLM server", "network");
			await assert.rejects(draftTest(recorded), (error: unknown) => {
				assert.ok(error instanceof Error);
				assert.strictEqual(error.name, "DashboardValidationError");
				assert.strictEqual(error.message, "Network Error: Unable to reach the LiteLLM server");
				return true;
			});
			// Error ownership: the intent layer maps, the panel boundary logs.
			assert.deepStrictEqual(recorded.logs, []);
		});

		test("a probe RequestError's classification rides the validation error: kind, status, and setup hint", async () => {
			const recorded = makeEnv([]);
			recorded.probeError = new RequestError("the server answered 404", "http", {
				status: 404,
				setupHint: "check-base-url",
			});
			await assert.rejects(draftTest(recorded), (error: unknown) => {
				assert.ok(error instanceof DashboardValidationError);
				assert.deepStrictEqual(error.classification, { kind: "http", status: 404, setupHint: "check-base-url" });
				return true;
			});
		});

		test("a non-transport validation refusal carries no classification", async () => {
			const recorded = makeEnv([]);
			await assert.rejects(
				draftTest(recorded, { server: { label: "Prod", baseUrl: "not a url" } }),
				(error: unknown) => {
					assert.ok(error instanceof DashboardValidationError);
					assert.strictEqual(error.classification, undefined);
					return true;
				}
			);
		});

		test("an unexpected non-transport error is rethrown as-is for the boundary's generic handling", async () => {
			const recorded = makeEnv([]);
			recorded.probeError = new TypeError("boom");
			await assert.rejects(draftTest(recorded), (error: unknown) => error instanceof TypeError);
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
			discoveredRawIds: [],
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
			snapshots: DashboardStateInputs["snapshots"],
			declared: DeclaredServerView[],
			label: string
		): string => {
			const server = buildState(snapshots, makeReader({}), declared).servers.find((s) => s.label === label);
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
					discoveredRawIds: [],
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
					discoveredRawIds: [],
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
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", " 300000 "), { kind: "value", value: 300000 });
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", ""), {
				kind: "invalid",
				problem: "Enter a number",
			});
			// ms settings read drafts under the duration grammar, so their junk
			// verdict names the grammar.
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "soon"), {
				kind: "invalid",
				problem: "Not a duration - use ms, s, m, or h",
			});
			assert.strictEqual(parseNumberDraft("chat.timeout", "999").kind, "invalid", "below the 1000 minimum");
			assert.deepStrictEqual(parseNumberDraft("discovery.cacheTtl", "0"), { kind: "value", value: 0 });
		});

		test("parseNumberDraft: the duration grammar on ms settings - suffixes scale, bare numbers stay ms", () => {
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "1500ms"), { kind: "value", value: 1500 });
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "90s"), { kind: "value", value: 90000 });
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "5m"), { kind: "value", value: 300000 });
			assert.deepStrictEqual(parseNumberDraft("discovery.cacheTtl", "1h"), { kind: "value", value: 3600000 });
			// Case-insensitive, whitespace-tolerant, fractional prefixes allowed.
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", " 5 M "), { kind: "value", value: 300000 });
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "1.5h"), { kind: "value", value: 5400000 });
			// Suffixed values commit whole milliseconds: sub-ms precision in a
			// duration string is noise, and fractional timeouts are unusable.
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "1.0005s"), { kind: "value", value: 1001 });
			// A suffix needs a number, and a suffixed value still honors the bound.
			assert.strictEqual(parseNumberDraft("chat.timeout", "ms").kind, "invalid");
			assert.strictEqual(parseNumberDraft("chat.timeout", "h").kind, "invalid");
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "500ms"), {
				kind: "invalid",
				problem: "Must be at least 1000",
			});
			// Unit typos are grammar errors, never silent guesses.
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "5 min"), {
				kind: "invalid",
				problem: "Not a duration - use ms, s, m, or h",
			});
			assert.strictEqual(parseNumberDraft("chat.timeout", "5d").kind, "invalid");
			// A product that overflows to Infinity is as unwritable as junk.
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "9e307h"), {
				kind: "invalid",
				problem: "Not a duration - use ms, s, m, or h",
			});
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
				// Duration-grammar drafts feed the same one parse, so the hint
				// echoes the suffixed spelling back in clock units.
				["90s", "= 1 min 30 s"],
				["5m", "= 5 min"],
				["1.5h", "= 1 h 30 min"],
			];
			for (const [draft, expected] of cases) {
				assert.strictEqual(equivalenceOfDraft("chat.timeout", draft), expected, `draft ${draft}`);
			}
		});

		test("equivalence yields nothing for empty, unparsable, below-minimum, or sub-second drafts", () => {
			assert.strictEqual(equivalenceOfDraft("chat.timeout", ""), undefined);
			assert.strictEqual(equivalenceOfDraft("chat.timeout", "soon"), undefined);
			assert.strictEqual(equivalenceOfDraft("chat.timeout", "999"), undefined, "below the 1000 minimum");
			assert.strictEqual(
				equivalenceOfDraft("discovery.cacheTtl", "500"),
				undefined,
				"sub-second reads as milliseconds"
			);
		});

		test("equivalence reads the TTL's zero through zeroMeaning, and only where 0 is legal", () => {
			assert.strictEqual(equivalenceOfDraft("discovery.cacheTtl", "0"), "= every refresh");
			assert.strictEqual(equivalenceOfDraft("chat.timeout", "0"), undefined, "0 never parses below the minimum");
			assert.strictEqual(equivalence("chat.timeout", 0), undefined, "and the hint itself has no zero reading");
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
