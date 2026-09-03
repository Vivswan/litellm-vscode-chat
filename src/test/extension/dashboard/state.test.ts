import * as assert from "node:assert";
import type { RequestPayload } from "../../../dashboard/endpoints";
import { failuresAfterStatePush, isExtensionMessage } from "../../../dashboard/endpoints";
import {
	draftSyncKey,
	equivalence,
	formatHeaderValue,
	parseHeaderValue,
	parseJsonValue,
	parseNumberDraft,
} from "../../../dashboard/presenters";
import { BOOLEAN_SETTING_IDS, NUMBER_SETTING_IDS } from "../../../dashboard/viewModels";
import { resolveAdoptableCredentials, resolveExternalGroupIdentity } from "../../../extension/dashboard/adopt";
import { modelScopeKey } from "../../../extension/dashboard/adoptHandle";
import { parseDashboardRequest } from "../../../extension/dashboard/intentSchema";
import type { IntentAckNotice } from "../../../extension/dashboard/intents";
import {
	DashboardValidationError,
	executeDashboardIntent,
	readInlineSecretValues,
	validateModelParametersRecord,
	validateNumberSetting,
	validateSaveServerSetting,
	validateTestServerDraft,
} from "../../../extension/dashboard/intents";
import type { DashboardStateInputs, SettingsInspection, SettingsReader } from "../../../extension/dashboard/state";
import {
	buildDashboardState,
	EMPTY_CATALOG_STATUS,
	mostSpecificGlobalRecordKey,
	observedKeysByEntryLabel,
	observedModelInfoKeysUnion,
	readDashboardSettings,
	resolveDashboardModelCapabilities,
	resolveDashboardModelParameters,
} from "../../../extension/dashboard/state";
import type { DeclaredServerView } from "../../../extension/servers/serverSync";
import { SALT_UNAVAILABLE_MESSAGE, SECRETS_READ_FAILED_MESSAGE } from "../../../extension/servers/serverSync";
import { DEFAULT_REASONING_EFFORT_LEVELS, reasoningEffortSchema } from "../../../provider/catalog/modelConfiguration";
import { RequestError } from "../../../provider/transport/errorMapping";
import { EMPTY_CATALOG_LOOKUP } from "../../../shared/config/capabilityResolution";
import type { NumberSettingId } from "../../../shared/config/settingSpec";
import { FEATURE_MODEL_IDS } from "../../../shared/config/settingSpec";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { recordFromKeys } from "../../../shared/util/json";
import { makeModelInfo } from "../../pureHelpers";
import { makeServerStatus } from "../../testUtils";
import {
	displayedReplace,
	inlineOnlyIdentity,
	KEEP_ALL,
	makeEnv,
	type RecordedEnv,
	replaceIdentity,
	serverPayload,
} from "./recordedEnv";

/** The menu the built-in default level list produces; fixtures here carry no per-level server flags. */
const REASONING_EFFORT_SCHEMA = reasoningEffortSchema(DEFAULT_REASONING_EFFORT_LEVELS);

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
 * against; inputs it does not cover (entryReports, catalog, usage, diagnostics)
 * go through buildDashboardState's options object directly. Declared views are
 * wrapped as the ENGINE's (locations proven); the settings-fallback source has
 * its own explicit suite below.
 */
function buildState(
	snapshots: DashboardStateInputs["snapshots"],
	reader: SettingsReader,
	declared?: readonly DeclaredServerView[],
	removedGroups?: DashboardStateInputs["removedGroups"]
) {
	return buildDashboardState({
		snapshots,
		reader,
		...(declared !== undefined ? { declared: { source: "engine", views: declared } } : {}),
		...(removedGroups !== undefined ? { removedGroups } : {}),
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
						status: makeServerStatus({ serverId: "b", label: "Zeta", hasApiKey: true }),
						models: [],
					},
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
			assert.strictEqual(state.servers[0]?.credentials, "absent", "an absent status hasApiKey reads as absent");
			assert.strictEqual(state.servers[0]?.origin, "external", "live rows without a settings entry are external");
			assert.strictEqual(state.servers[0]?.config, undefined);
			assert.strictEqual(state.servers[1]?.credentials, "present");
			assert.strictEqual(state.servers[1]?.baseUrl, "http://prod.test");
			assert.strictEqual(
				state.servers[1]?.lastChecked,
				new Date("2026-07-26T00:00:00.000Z").getTime(),
				"the push carries epoch ms, converted from the status's ISO string"
			);
		});

		test('the "" never-checked sentinel maps to a deliberate absent lastChecked, never NaN', () => {
			// restoreServerStatus and syncFailureOverlay's synthetic statuses write
			// "" for a server no discovery pass has stamped; the push states absence.
			const state = buildState(
				[{ status: makeServerStatus({ serverId: "g1", label: "Prod", lastChecked: "" }), models: [] }],
				makeReader({})
			);
			assert.strictEqual(state.servers[0]?.lastChecked, undefined);
		});

		test("an external row's credential kind follows the group's report, so OAuth never wears the API key badge", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "o", label: "OAuthed", hasApiKey: true, hasOAuth: true }),
						models: [],
					},
					{ status: makeServerStatus({ serverId: "k", label: "Keyed", hasApiKey: true, hasOAuth: false }), models: [] },
				],
				makeReader({})
			);

			assert.strictEqual(state.servers[0]?.label, "Keyed");
			assert.strictEqual(state.servers[0]?.hasOAuth, false);
			assert.strictEqual(state.servers[1]?.label, "OAuthed");
			assert.strictEqual(state.servers[1]?.credentials, "present");
			assert.strictEqual(state.servers[1]?.hasOAuth, true, "the report knows the kind; the row must not overwrite it");
		});

		test("errorEnglish carries the status's log-safe rendering exactly when the display error is the transport error", () => {
			// The copyable diagnostics block stays English by policy: the webview
			// substitutes errorEnglish there while the row renders the possibly
			// localized error. A sync error has no mirror, so a row showing one
			// carries none.
			const external = buildState(
				[
					{
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
						status: makeServerStatus({ state: "error", error: "LOCALIZED", logSafeError: "ENGLISH" }),
						models: [],
					},
				],
				makeReader({}),
				[makeDeclared({ syncFailure: { class: "upsertFailed", message: "sync failed" } })]
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
				[{ status: makeServerStatus({ state: "error", error: "boom" }), models: [] }],
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
						status: makeServerStatus({ state: "error", error: "boom", classification }),
						models: [],
					},
				],
				makeReader({}),
				[makeDeclared({ syncFailure: { class: "upsertFailed", message: "sync failed" } })]
			);
			assert.strictEqual(synced.servers[0]?.error, "sync failed");
			const syncedRow = synced.servers[0];
			assert.ok(syncedRow !== undefined && !("classification" in syncedRow));
		});

		test("a down server's retained models list under its erroring row without a per-model stale marker", () => {
			// The provider retains a failed group's last known models, so the
			// snapshot pairs an error status with a non-empty model list. Listing
			// them unmarked is deliberate: the server row they cite already renders
			// the error and lastChecked, and no picker decoration enters this path.
			const state = buildState(
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
			const state = buildState(
				[
					{
						status: makeServerStatus({ label: "Prod", baseUrl: "http://prod.test", servedModelCount: 4 }),
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
			assert.strictEqual(server?.servedModelCount, 4);
			assert.strictEqual(server?.credentials, "present", "a secure-side key counts");
			assert.strictEqual(server?.hasOAuth, true);
			assert.deepStrictEqual(server?.config?.secrets, {
				kind: "proven",
				locations: { apiKey: "secure", oauthClientSecret: "settings", virtualKeyValue: "none" },
			});
		});

		test("a declared entry joins its live group even when the snapshot label is the URL host", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "g1",
							label: "x.example",
							baseUrl: "https://x.example",
							servedModelCount: 3,
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
			assert.strictEqual(server?.servedModelCount, 3);
			assert.strictEqual(state.models[0]?.serverLabel, "Production", "models adopt the declared label");
		});

		test("entries sharing a base URL pair by label first, so matching labels stay correctly paired", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "s1",
							label: "Staging",
							baseUrl: "http://x.test",
							servedModelCount: 1,
						}),
						models: [],
					},
					{
						status: makeServerStatus({ serverId: "s2", label: "Prod", baseUrl: "http://x.test", servedModelCount: 9 }),
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
			assert.strictEqual(byLabel.get("Prod")?.servedModelCount, 9);
			assert.strictEqual(byLabel.get("Staging")?.servedModelCount, 1);
		});

		test("entries sharing a base URL with different credentials join by group client ID, never swapped", () => {
			// Both snapshots are host-labeled identically, so no label pass can tell
			// them apart and the URL fallback would pair them by position; the sync
			// engine's client-ID fingerprint is exact. The declared order is chosen
			// so the positional fallback would swap them.
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-staging:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							servedModelCount: 1,
						}),
						models: [],
					},
					{
						status: makeServerStatus({
							serverId: "group:fp-prod:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							servedModelCount: 9,
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
			assert.strictEqual(byLabel.get("Prod")?.servedModelCount, 9);
			assert.strictEqual(byLabel.get("Staging")?.servedModelCount, 1);
			assert.ok(!JSON.stringify(state).includes("fp-prod"), "the join key never reaches the webview state");
		});

		test("an entry whose client ID matches no snapshot still joins by URL", () => {
			// A stale fingerprint (a secret rotated but not yet re-synced) must
			// degrade to the URL join, like an entry with no fingerprint at all.
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-old:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							servedModelCount: 2,
						}),
						models: [],
					},
				],
				makeReader({}),
				[makeDeclared({ label: "Prod", baseUrl: "http://x.test/", expectedClientId: "group:fp-new:http://x.test" })]
			);

			assert.strictEqual(state.servers.length, 1, "no duplicate external row");
			assert.strictEqual(state.servers[0]?.servedModelCount, 2);
		});

		test("two declared entries mirroring one pre-label group share its snapshot instead of one reading unchecked", () => {
			// Groups created before labels flowed into their configurations report
			// under ONE label-agnostic identity, which both entries carry as
			// expectedConnectionId: both rows must render the live status rather
			// than leave one stuck on "not checked" forever.
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-shared:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							servedModelCount: 3,
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
			assert.strictEqual(byLabel.get("Prod")?.servedModelCount, 3);
			assert.strictEqual(byLabel.get("Staging")?.state, "ok", "the second entry shares the live status");
			assert.strictEqual(byLabel.get("Staging")?.servedModelCount, 3);
			assert.ok(!JSON.stringify(state).includes("fp-shared"), "the join key never reaches the webview state");
		});

		test("a snapshot shared by two declared entries lists its models under both labels", () => {
			// The host registers a group's models once PER GROUP, so a pre-label
			// snapshot claimed by several declared entries must attribute its
			// models to every claimant, not render them once under the first label.
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-shared:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							servedModelCount: 2,
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
			// The second same-connection entry's group add FAILED outright, but the
			// engine still emits its connection identity, so it claims the snapshot
			// - and the picker has ONE group, so duplicating the models overcounts.
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-shared:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							servedModelCount: 2,
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
						syncFailure: { class: "upsertFailed", message: "The host rejected the provider group upsert" },
					}),
				]
			);

			assert.deepStrictEqual(
				state.models.map((m) => `${m.serverLabel}/${m.name}`),
				["Prod/m1", "Prod/m2"]
			);
			const staging = state.servers.find((server) => server.label === "Staging");
			assert.strictEqual(staging?.state, "error", "the sync failure outranks the shared live status");
			assert.strictEqual(
				staging?.servedModelCount,
				0,
				"no model row carries the excluded claimant's label, so its row must not claim the shared count"
			);
			assert.strictEqual(staging?.error, "The host rejected the provider group upsert");
			const prod = state.servers.find((server) => server.label === "Prod");
			assert.strictEqual(prod?.servedModelCount, 2, "the serving claimant keeps the live count");
			assert.strictEqual(state.servedModelCount, 2, "the hero counts the shared snapshot once");
		});

		test("a blocked claimant keeps its models copy: the duplicate refusal proves its group exists", () => {
			// A name-conflict refusal means a live group with that name IS
			// registering models; dropping the copy would under-report the picker.
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-shared:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							servedModelCount: 1,
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
						syncFailure: { class: "blocked", message: "A provider group with this name already exists" },
					}),
				]
			);

			assert.deepStrictEqual(
				state.models.map((m) => `${m.serverLabel}/${m.name}`),
				["Prod/m1", "Staging/m1"]
			);
		});

		test("a snapshot whose only claimant is upsertFailed still lists its models once, under that label", () => {
			// The reporting group exists and serves, so the models cannot vanish
			// just because the entry's last add failed: they render once, not zero times.
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-shared:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							servedModelCount: 1,
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
						syncFailure: { class: "upsertFailed", message: "The host rejected the provider group upsert" },
					}),
				]
			);

			assert.deepStrictEqual(
				state.models.map((m) => `${m.serverLabel}/${m.name}`),
				["Prod/m1"]
			);
			assert.strictEqual(
				state.servers[0]?.servedModelCount,
				1,
				"the fallback claimant's row keeps the live count its rendered models carry"
			);
		});

		test("two labeled groups on one connection each list their own copy of the models", () => {
			// The post-identity shape of the same setup: distinct labeled
			// snapshots carrying the same raw model IDs stay two registrations,
			// one row per server per model, matching the picker.
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:labeled:fp-a:http://x.test",
							label: "Prod",
							baseUrl: "http://x.test",
							servedModelCount: 1,
						}),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
					{
						status: makeServerStatus({
							serverId: "group:labeled:fp-b:http://x.test",
							label: "Staging",
							baseUrl: "http://x.test",
							servedModelCount: 1,
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
			// The connection-identity join means the live group carries no label, so
			// the request path never applies this entry's parameters: the row must
			// warn instead of rendering healthy, via the classification alone.
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-shared:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							servedModelCount: 3,
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
			// The classification itself rides both rows: the notices exist only for
			// configured field families, but Staging's identity problem is the same,
			// and the webview's declare offers key on the flag, not the evidence.
			assert.strictEqual(byLabel.get("Prod")?.entryFieldsInactive, true);
			assert.strictEqual(byLabel.get("Staging")?.entryFieldsInactive, true);
		});

		test("an entry with modelParameters joined by its exact labeled identity carries no notice", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-prod-labeled:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							servedModelCount: 3,
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
			assert.strictEqual(state.servers[0]?.entryFieldsInactive, undefined, "an identity join carries no flag");
		});

		test("an entry with modelParameters joined by the label-and-URL fallback still flags them", () => {
			// The snapshot's display label is the URL host, so this pass can match an
			// unlabeled group whose credentials differ from the entry. Only the exact
			// labeled-identity join proves the group carries the entry's label.
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-other:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							servedModelCount: 3,
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
						status: makeServerStatus({
							serverId: "group:fp-other:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							servedModelCount: 3,
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
			// One live group under key A. The entry declaring key B shares only the
			// URL, not the connection, so handing it key A's status would call a
			// server it cannot reach healthy; it must stay unchecked.
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-a:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
							servedModelCount: 3,
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
				makeDeclared({
					label: "Broken",
					baseUrl: "http://broken.test",
					syncFailure: { class: "upsertFailed", message: "upsert refused" },
				}),
			]);

			const byLabel = new Map(state.servers.map((server) => [server.label, server]));
			assert.strictEqual(byLabel.get("New")?.state, "unchecked");
			assert.strictEqual(byLabel.get("New")?.lastChecked, undefined);
			assert.strictEqual(byLabel.get("Broken")?.state, "error");
			assert.strictEqual(byLabel.get("Broken")?.error, "upsert refused");
		});

		test("a sync error outranks a reachable group's ok state without erasing the live counts", () => {
			// The host cannot update the group, so the reachable group runs the
			// entry's OLD configuration: the row is an error carrying the sync text
			// (the same shape the status bar's overlay judges), while the served
			// count keeps the live truth.
			const state = buildState(
				[
					{
						status: makeServerStatus({ label: "Prod", baseUrl: "http://prod.test", state: "ok", servedModelCount: 4 }),
						models: [],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://prod.test",
						syncFailure: { class: "blocked", message: "group update unavailable" },
					}),
				]
			);

			assert.strictEqual(state.servers.length, 1);
			assert.strictEqual(state.servers[0]?.state, "error", "the sync failure outranks the live ok state");
			assert.strictEqual(state.servers[0]?.error, "group update unavailable");
			assert.strictEqual(state.servers[0]?.servedModelCount, 4, "the served count stays the live truth");
		});

		suite("secret-location proof", () => {
			/** The one declared row of a state, narrowed for its config. */
			function declaredRow(state: ReturnType<typeof buildState>) {
				const server = state.servers[0];
				assert.ok(server?.origin === "declared", "expected one declared row");
				return server;
			}

			test("engine views push proven locations", () => {
				const state = buildDashboardState({
					snapshots: [],
					reader: makeReader({}),
					declared: {
						source: "engine",
						views: [
							makeDeclared({ secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" } }),
						],
					},
				});

				assert.deepStrictEqual(declaredRow(state).config.secrets, {
					kind: "proven",
					locations: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
				});
			});

			test("the settings fallback pushes unproven, never proven-none, and its credential verdict is unknown", () => {
				// The fallback cannot read secret blobs synchronously, so its "none"
				// is only "no inline value". Pushing it as fact froze a wrong identity
				// into edit forms opened in that window, whose saves then refused as
				// "the entry changed"; the row must say unproven instead - and the
				// unproven shape carries NO locations, so nothing can read one. The
				// same guess must not become a credential denial either: a secure-side
				// key exists exactly when this window matters.
				const state = buildDashboardState({
					snapshots: [],
					reader: makeReader({}),
					declared: {
						source: "settings-fallback",
						views: [makeDeclared({ secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } })],
					},
				});

				const row = declaredRow(state);
				assert.deepStrictEqual(row.config.secrets, { kind: "unproven" }, "an unread none is a guess, never proven");
				assert.strictEqual(row.credentials, "unknown", "an unproven none must not read as a false negative");
			});

			test("a fallback view with every secret inline is proven by the setting itself", () => {
				// Inline wins over any blob, so all-"settings" locations need no blob
				// read: the setting alone proves them, and the row stays editable.
				const state = buildDashboardState({
					snapshots: [],
					reader: makeReader({}),
					declared: {
						source: "settings-fallback",
						views: [
							makeDeclared({
								secrets: { apiKey: "settings", oauthClientSecret: "settings", virtualKeyValue: "settings" },
							}),
						],
					},
				});

				assert.deepStrictEqual(declaredRow(state).config.secrets, {
					kind: "proven",
					locations: { apiKey: "settings", oauthClientSecret: "settings", virtualKeyValue: "settings" },
				});
			});

			test("one inline field does not prove the others: the row stays unproven", () => {
				const state = buildDashboardState({
					snapshots: [],
					reader: makeReader({}),
					declared: {
						source: "settings-fallback",
						views: [
							makeDeclared({ secrets: { apiKey: "settings", oauthClientSecret: "none", virtualKeyValue: "none" } }),
						],
					},
				});

				assert.deepStrictEqual(declaredRow(state).config.secrets, { kind: "unproven" });
			});

			test("a proven none is a real absent, not unknown", () => {
				const state = buildDashboardState({
					snapshots: [],
					reader: makeReader({}),
					declared: {
						source: "engine",
						views: [makeDeclared({ secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } })],
					},
				});

				assert.strictEqual(declaredRow(state).credentials, "absent");
			});

			test("an inline key vouches for presence even while the row stays unproven", () => {
				// Inline wins over any blob, so a fallback "settings" location is
				// already fact; only the deny side waits for proof.
				const state = buildDashboardState({
					snapshots: [],
					reader: makeReader({}),
					declared: {
						source: "settings-fallback",
						views: [
							makeDeclared({ secrets: { apiKey: "settings", oauthClientSecret: "none", virtualKeyValue: "none" } }),
						],
					},
				});

				const row = declaredRow(state);
				assert.deepStrictEqual(row.config.secrets, { kind: "unproven" });
				assert.strictEqual(row.credentials, "present");
			});

			test("a live group's own report vouches for an unproven row", () => {
				const state = buildDashboardState({
					snapshots: [{ status: makeServerStatus({ hasApiKey: true }), models: [] }],
					reader: makeReader({}),
					declared: {
						source: "settings-fallback",
						views: [makeDeclared({ secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } })],
					},
				});

				const row = declaredRow(state);
				assert.deepStrictEqual(row.config.secrets, { kind: "unproven" });
				assert.strictEqual(row.credentials, "present");
			});

			test("an engine view whose own blob read failed is as blind as the fallback: unproven", () => {
				// The engine substitutes an empty blob when SecretStorage refuses the
				// read (syncFailure class "secretsUnreadable"), so its "none" is the same
				// guess the fallback makes; the engine tag alone must not prove it.
				const state = buildDashboardState({
					snapshots: [],
					reader: makeReader({}),
					declared: {
						source: "engine",
						views: [
							makeDeclared({
								secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
								syncFailure: { class: "secretsUnreadable", message: SECRETS_READ_FAILED_MESSAGE },
							}),
						],
					},
				});

				assert.deepStrictEqual(declaredRow(state).config.secrets, { kind: "unproven" });
			});

			test("a salt-durability skip read its blob, so its locations stay proven under its own class", () => {
				// Salt-durability skips carry their own "saltUnavailable" class and
				// their secret read SUCCEEDED; marking those unproven would lock
				// the row out of editing all session.
				const state = buildDashboardState({
					snapshots: [],
					reader: makeReader({}),
					declared: {
						source: "engine",
						views: [
							makeDeclared({
								secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
								syncFailure: { class: "saltUnavailable", message: SALT_UNAVAILABLE_MESSAGE },
							}),
						],
					},
				});

				assert.deepStrictEqual(declaredRow(state).config.secrets, {
					kind: "proven",
					locations: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
				});
			});

			test("an unreadable blob with every secret inline still proves, and a non-read sync failure proves as usual", () => {
				const state = buildDashboardState({
					snapshots: [],
					reader: makeReader({}),
					declared: {
						source: "engine",
						views: [
							makeDeclared({
								secrets: { apiKey: "settings", oauthClientSecret: "settings", virtualKeyValue: "settings" },
								syncFailure: { class: "secretsUnreadable", message: SECRETS_READ_FAILED_MESSAGE },
							}),
							// An upsert failure happens AFTER a successful blob read, so
							// its locations stay proven facts.
							makeDeclared({
								label: "Upsert",
								baseUrl: "http://upsert.test",
								secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
								syncFailure: { class: "upsertFailed", message: "upsert refused" },
							}),
						],
					},
				});

				const byLabel = new Map(state.servers.map((server) => [server.label, server]));
				const inline = byLabel.get("Prod");
				assert.ok(inline?.origin === "declared");
				assert.deepStrictEqual(inline.config.secrets, {
					kind: "proven",
					locations: { apiKey: "settings", oauthClientSecret: "settings", virtualKeyValue: "settings" },
				});
				const upsert = byLabel.get("Upsert");
				assert.ok(upsert?.origin === "declared");
				assert.deepStrictEqual(upsert.config.secrets, {
					kind: "proven",
					locations: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
				});
			});
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
			const state = buildState([{ status: makeServerStatus({ hasApiKey: true }), models: [] }], makeReader({}), [
				makeDeclared({ secrets: { apiKey: "settings", oauthClientSecret: "secure", virtualKeyValue: "none" } }),
			]);

			const serialized = JSON.stringify(state);
			assert.ok(!serialized.includes("sk-"), serialized);
			assert.ok(serialized.includes('"apiKey":"settings"'), "locations are reported");
		});

		test("colliding server labels get positional suffixes, on the servers and their models", () => {
			const state = buildState(
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
			const state = buildState(
				[
					{
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
					rawModelId: "claude",
					supportsPromptCaching: true,
					outputLimitSource: "provider",
					serverDeclared: { kind: "discovered", values: {}, outputDeclared: true },
				},
			});
			const state = buildState([{ status: makeServerStatus(), models: [info] }], makeReader({}));

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
			const state = buildState([{ status: makeServerStatus(), models: [makeModelInfo()] }], makeReader({}));

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
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "g1", label: "Prod", baseUrl: "http://prod.test" }),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
					{
						status: makeServerStatus({
							serverId: "g2",
							label: "Live",
							baseUrl: "http://live.test",
							servedModelCount: 3,
						}),
						models: [makeModelInfo({ id: "m2", name: "m2" })],
					},
				],
				makeReader({}),
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
			assert.strictEqual(
				state.servedModelCount,
				3,
				"a snapshot with no rows or model rows must not count into the hero during the tombstone window"
			);
		});

		test("tombstones suppress by the raw status label, not the display ordinal", () => {
			// Two external groups share a label, so the table would render "Dup
			// (1)" and "Dup (2)"; the tombstone still stores the raw identity.
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "g1", label: "Dup", baseUrl: "http://a.test" }),
						models: [],
					},
					{
						status: makeServerStatus({ serverId: "g2", label: "Dup", baseUrl: "http://b.test" }),
						models: [],
					},
				],
				makeReader({}),
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
						status: makeServerStatus({ label: "Prod", baseUrl: "http://prod.test" }),
						models: [],
					},
				],
				makeReader({}),
				[makeDeclared()],
				{ tombstones: [{ label: "Prod", baseUrl: "http://prod.test" }], origins: [] }
			);

			assert.strictEqual(state.servers.length, 1);
			assert.strictEqual(state.servers[0]?.origin, "declared");
		});

		test("hidden groups persist without a live snapshot, so unhide stays offered", () => {
			const state = buildState([], makeReader({}), [], {
				tombstones: [{ label: "Gone", baseUrl: "http://gone.test" }],
				origins: [],
			});

			assert.deepStrictEqual(state.servers, []);
			assert.deepStrictEqual(state.hiddenGroups, [{ label: "Gone", baseUrl: "http://gone.test" }]);
		});

		test("a tombstone whose group was never observed this session is a ghost and stays off the hidden line", () => {
			// A tombstoned group deleted from the models file is never called for
			// after a restart, so offering Unhide would reference nothing. The
			// panel's session-sticky observation set gates that; an observed
			// identity keeps its row even with no live snapshot in this push.
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

		test("every external snapshot is tombstone-suppressible: the registry serving path is gone", () => {
			// Every status-window snapshot is group-backed by construction now, so
			// a tombstone matching an external row's identity always hides it.
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "g-legacy", label: "Legacy", baseUrl: "http://legacy.test" }),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
				],
				makeReader({}),
				[],
				{ tombstones: [{ label: "Legacy", baseUrl: "http://legacy.test" }], origins: [] }
			);

			assert.strictEqual(state.servers.length, 0, "the tombstoned row leaves the table");
			assert.strictEqual(state.models.length, 0, "its models leave with it");
			assert.deepStrictEqual(state.hiddenGroups, [{ label: "Legacy", baseUrl: "http://legacy.test" }]);
		});

		test("external rows carry their recorded provenance; unrecorded rows carry none", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "g1", label: "Old", baseUrl: "http://host.test" }),
						models: [],
					},
					{
						status: makeServerStatus({ serverId: "g2", label: "Other", baseUrl: "http://other.test" }),
						models: [],
					},
				],
				makeReader({}),
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
		test("models carry the mint-stamped raw ID beside the exposed row identity", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "srv1" }),
						models: [
							makeModelInfo({
								id: "gpt-4:cheapest",
								name: "gpt-4 (cheapest)",
								litellm: {
									rawModelId: "gpt-4:cheapest",
									supportsPromptCaching: false,
									outputLimitSource: "defaults",
									serverDeclared: { kind: "discovered", values: {}, outputDeclared: false },
								},
							}),
						],
					},
				],
				makeReader({})
			);
			assert.strictEqual(state.models[0]?.id, "gpt-4:cheapest", "the exposed ID stays the row identity");
			assert.strictEqual(
				state.models[0]?.rawId,
				"gpt-4:cheapest",
				"the raw ID is the stamped litellm.rawModelId, what requests and prefixes match"
			);
		});

		test("group models are already raw, and outputLimitDeclared mirrors the litellm provenance", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "g1" }),
						models: [
							makeModelInfo({ id: "gpt-4", name: "a" }),
							makeModelInfo({
								id: "claude",
								name: "b",
								litellm: {
									rawModelId: "claude",
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
			assert.ok(
				answer.rows.every((row) => row.source.layer === "global"),
				"no declared entry matched, so no entry-layer refs ride the answer"
			);
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
					status: makeServerStatus({ serverId: "g1", label: "Team", baseUrl: "http://prod.test" }),
					models: [makeModelInfo({ id: "m1", name: "m1" })],
				},
				{
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
			const row = resolving?.rows.find((candidate) => candidate.name === "temperature");
			assert.strictEqual(row?.value, 0.2);
			assert.deepStrictEqual(row?.source, { layer: "entry", key: "*", entryLabel: "Team" });
			const other = answerFor("m2");
			assert.ok(other !== undefined);
			assert.deepStrictEqual(other.rows, [], "no entry parameters reach the sibling's models");
			assert.notStrictEqual(modelByRaw("m1")?.scopeKey, modelByRaw("m2")?.scopeKey);
		});

		test("a tombstoned snapshot contributes no models and the remaining scope keys stay resolvable", () => {
			const snapshots = [
				{
					status: makeServerStatus({ serverId: "g1", label: "Hidden", baseUrl: "http://hidden.test" }),
					models: [makeModelInfo({ id: "m1", name: "m1" })],
				},
				{
					status: makeServerStatus({ serverId: "g2", label: "Live", baseUrl: "http://live.test" }),
					models: [makeModelInfo({ id: "m2", name: "m2" })],
				},
			];
			const state = buildState(snapshots, makeReader({}), [], {
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

		test("the config prefill carries the entry's apiVersion, the empty-string override included", () => {
			const state = buildState([], makeReader({}), [makeDeclared({ apiVersion: "" })]);
			const server = state.servers[0];
			assert.ok(server?.origin === "declared");
			assert.strictEqual(server.config.apiVersion, "");
			assert.ok("apiVersion" in server.config, '"" is a real override and must survive into the prefill');

			const absent = buildState([], makeReader({}), [makeDeclared()]);
			const plain = absent.servers[0];
			assert.ok(plain?.origin === "declared");
			assert.ok(!("apiVersion" in plain.config), "an entry without the field prefills the auto default");
		});

		test("an expected failure rides the row with its declared count as the model count", () => {
			const state = buildState(
				[
					{
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
			assert.strictEqual(server.servedModelCount, 2, "declared models join the row's count");
			assert.strictEqual(server.notices, undefined, "declared models mean nothing to flag");
		});

		test("an ok status's model-info-unsupported marker rides onto the declared row", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-prod-labeled:http://x.test",
							label: "Prod",
							baseUrl: "http://x.test",
							state: "ok",
							servedModelCount: 1,
							modelInfoUnsupported: "timeout",
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
					}),
				]
			);
			const server = state.servers[0];
			assert.ok(server?.state === "ok");
			assert.strictEqual(server.modelInfoUnsupported, "timeout");
		});

		test("an expected failure with nothing declared raises the needs-declare notice", () => {
			const state = buildState(
				[
					{
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
			assert.strictEqual(server.servedModelCount, 0);
			assert.deepStrictEqual(server.notices, ["expected-failures-nothing-declared"]);
		});

		test("an expected failure serving only the stale window raises no needs-declare notice", () => {
			// The notice gates on servedModelCount, like every other serving
			// verdict: a row quietly serving its last known list must not carry a
			// paste line contradicting itself ("still served" beside "add IDs").
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-prod-labeled:http://x.test",
							label: "Prod",
							baseUrl: "http://x.test",
							state: "error",
							error: "404 on /models",
							expected: true,
							servedModelCount: 3,
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
			assert.strictEqual(server.servedModelCount, 3);
			assert.strictEqual(server.notices, undefined, "the stale window serves, so there is nothing to declare");
		});

		test("a declared model's badge marker rides the dashboard model; discovered models carry none", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "g1" }),
						models: [
							makeModelInfo({ id: "gpt-4", name: "a" }),
							makeModelInfo({
								id: "my-model",
								name: "b",
								litellm: {
									rawModelId: "my-model",
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

	suite("observed model_info keys", () => {
		test("ride the matched declared row and the external row; absent when the snapshot carries no set", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "g1", label: "Prod", baseUrl: "http://prod.test" }),
						models: [],
						observedModelInfoKeys: ["max_input_tokens", "mystery_flag"],
					},
					{
						status: makeServerStatus({ serverId: "g2", label: "External", baseUrl: "http://ext.test" }),
						models: [],
						observedModelInfoKeys: ["supports_vision"],
					},
					{
						status: makeServerStatus({ serverId: "g3", label: "Bare", baseUrl: "http://bare.test" }),
						models: [],
					},
				],
				makeReader({}),
				[makeDeclared({ label: "Prod", baseUrl: "http://prod.test" })]
			);
			const byLabel = new Map(state.servers.map((server) => [server.label, server.observedModelInfoKeys]));
			assert.deepStrictEqual(byLabel.get("Prod"), ["max_input_tokens", "mystery_flag"]);
			assert.deepStrictEqual(byLabel.get("External"), ["supports_vision"]);
			assert.strictEqual(byLabel.get("Bare"), undefined);
			assert.deepStrictEqual(
				state.observedModelInfoKeys,
				["max_input_tokens", "mystery_flag", "supports_vision"],
				"the state-level union spans exactly the servers that reported a set, sorted"
			);
		});

		test("the state union is absent when no server reported a set, and an unchecked declared row carries none", () => {
			const state = buildState([], makeReader({}), [makeDeclared()]);
			assert.ok(!("observedModelInfoKeys" in state), "no set anywhere means no union, not an empty one");
			assert.strictEqual(state.servers[0]?.observedModelInfoKeys, undefined);
		});

		test('a server-reported "__proto__" key is carried as data, never applied as an object key', () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "g1" }),
						models: [],
						observedModelInfoKeys: ["__proto__", "constructor"],
					},
				],
				makeReader({})
			);
			assert.deepStrictEqual(state.observedModelInfoKeys, ["__proto__", "constructor"]);
			// The union is Set-built; had a raw object keyed the accumulation, the
			// "__proto__" write would have re-pointed the accumulator's prototype
			// instead of recording the key. Fresh objects must stay pristine.
			assert.strictEqual(Object.getPrototypeOf({}), Object.prototype);
		});

		test("observedModelInfoKeysUnion distinguishes no sets (undefined) from empty sets (the empty array)", () => {
			assert.strictEqual(observedModelInfoKeysUnion([{}]), undefined);
			assert.deepStrictEqual(observedModelInfoKeysUnion([{ observedModelInfoKeys: [] }]), []);
			assert.deepStrictEqual(
				observedModelInfoKeysUnion([{ observedModelInfoKeys: ["b", "a"] }, {}, { observedModelInfoKeys: ["a", "c"] }]),
				["a", "b", "c"]
			);
		});

		test("observedKeysByEntryLabel joins each entry to its serving snapshot's set; setless and unmatched entries stay absent", () => {
			const byLabel = observedKeysByEntryLabel(
				[
					{
						status: makeServerStatus({ serverId: "g1", label: "Prod", baseUrl: "http://prod.test" }),
						models: [],
						observedModelInfoKeys: ["max_input_tokens"],
					},
					{
						status: makeServerStatus({ serverId: "g2", label: "Bare", baseUrl: "http://bare.test" }),
						models: [],
					},
				],
				[
					makeDeclared({ label: "Prod", baseUrl: "http://prod.test" }),
					makeDeclared({ label: "Bare", baseUrl: "http://bare.test" }),
					makeDeclared({ label: "Unseen", baseUrl: "http://unseen.test" }),
				]
			);
			assert.deepStrictEqual([...byLabel.entries()], [["Prod", ["max_input_tokens"]]]);
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
					status: makeServerStatus({ serverId: "g1", baseUrl: "http://x.test" }),
					models: [
						makeModelInfo({
							id: "gpt-4",
							name: "gpt-4",
							litellm: {
								rawModelId: "gpt-4",
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
			// The population the entry-capabilities-inactive notice exists for: entry
			// "Prod", group label "x.test". The rows render under the entry label and
			// their scope keys must still answer - the key hashes the server ID, so
			// no label enters the resolution.
			const divergent = [
				{
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
					status: makeServerStatus({ serverId: "g-a", label: "Prod", baseUrl: "http://x.test" }),
					models: [makeModelInfo({ id: "gpt-4", name: "gpt-4" })],
				},
				{
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

		suite("advisory filtering of unrecognized-key diagnostics", () => {
			const snapshotWithKeys = (observedModelInfoKeys: readonly string[] | undefined) => [
				{
					status: makeServerStatus({ serverId: "g1", baseUrl: "http://x.test" }),
					models: [makeModelInfo({ id: "gpt-4", name: "gpt-4" })],
					...(observedModelInfoKeys !== undefined ? { observedModelInfoKeys } : {}),
				},
			];
			const resolve = (observed: readonly string[] | undefined) =>
				resolveDashboardModelCapabilities(
					{
						snapshots: snapshotWithKeys(observed),
						reader: makeReader({ "models.capabilities": { "gpt-4": { mystery_flag: true } } }),
						resolveEntryCapabilities: () => undefined,
						catalog: EMPTY_CATALOG_LOOKUP,
					},
					modelScopeKey("g1"),
					"gpt-4"
				);

			test("with no observed set the hint drops; the field still applies", () => {
				const capabilities = resolve(undefined);
				assert.ok(capabilities !== undefined);
				assert.deepStrictEqual(capabilities.diagnostics, []);
				assert.strictEqual(capabilities.fields.mystery_flag?.value, true, "filtering touches diagnostics only");
			});

			test("an unobserved key on a server WITH a set survives; an observed one drops", () => {
				const unobserved = resolve(["supports_vision"]);
				assert.deepStrictEqual(unobserved?.diagnostics, [
					{ kind: "unrecognized-key", recordKey: "gpt-4", key: "mystery_flag", layer: "global" },
				]);
				const observed = resolve(["mystery_flag"]);
				assert.deepStrictEqual(observed?.diagnostics, []);
			});

			test("other diagnostic kinds pass through whatever the observed set says", () => {
				const capabilities = resolveDashboardModelCapabilities(
					{
						snapshots: snapshotWithKeys(undefined),
						reader: makeReader({ "models.capabilities": { "gpt-4": { context_length: "big" } } }),
						resolveEntryCapabilities: () => undefined,
						catalog: EMPTY_CATALOG_LOOKUP,
					},
					modelScopeKey("g1"),
					"gpt-4"
				);
				assert.deepStrictEqual(capabilities?.diagnostics, [
					{ kind: "invalid-value", recordKey: "gpt-4", key: "context_length", layer: "global" },
				]);
			});

			test("entry-layer hints filter against the same server set", () => {
				const capabilities = resolveDashboardModelCapabilities(
					{
						snapshots: snapshotWithKeys(["entry_key"]),
						reader: makeReader({}),
						resolveEntryCapabilities: () => ({ "gpt-4": { entry_key: 1, entry_mystery: 2 } }),
						catalog: EMPTY_CATALOG_LOOKUP,
					},
					modelScopeKey("g1"),
					"gpt-4"
				);
				assert.deepStrictEqual(capabilities?.diagnostics, [
					{ kind: "unrecognized-key", recordKey: "gpt-4", key: "entry_mystery", layer: "entry" },
				]);
			});

			suite("layered evidence: global hints use the cross-server union, entry hints the server's own set", () => {
				// Server A serves nothing relevant but observed the key; server B
				// serves the inspected model and did not. Each layer must be judged
				// the way Configuration diagnostics and the settings editor judge it,
				// or a click-through from a hint lands on a record that reads clean.
				const twoServers = (servingSet: readonly string[] | undefined, otherSet: readonly string[] | undefined) => [
					{
						status: makeServerStatus({ serverId: "gB", label: "B", baseUrl: "http://b.test" }),
						models: [makeModelInfo({ id: "gpt-4", name: "gpt-4" })],
						...(servingSet !== undefined ? { observedModelInfoKeys: servingSet } : {}),
					},
					{
						status: makeServerStatus({ serverId: "gA", label: "A", baseUrl: "http://a.test" }),
						models: [],
						...(otherSet !== undefined ? { observedModelInfoKeys: otherSet } : {}),
					},
				];
				const resolveOnB = (
					servingSet: readonly string[] | undefined,
					otherSet: readonly string[] | undefined,
					entryRecord?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
				) =>
					resolveDashboardModelCapabilities(
						{
							snapshots: twoServers(servingSet, otherSet),
							reader: makeReader({ "models.capabilities": { "gpt-4": { supports_web_search: true } } }),
							resolveEntryCapabilities: () => entryRecord,
							catalog: EMPTY_CATALOG_LOOKUP,
						},
						modelScopeKey("gB"),
						"gpt-4"
					);

				test("a global hint drops when ANY server observed the key, even one not serving this model", () => {
					// The regression shape: the SERVING server carries a real, non-empty
					// set that lacks the key, and only the other server observed it. A
					// serving-set-only filter fails here; the union must win.
					const discriminating = resolveOnB(["known_key"], ["supports_web_search"]);
					assert.deepStrictEqual(discriminating?.diagnostics, []);
					// And the softer shape: the serving server has no set at all.
					const noServingSet = resolveOnB(undefined, ["supports_web_search"]);
					assert.deepStrictEqual(noServingSet?.diagnostics, []);
				});

				test("a global hint survives against the union when no server observed the key", () => {
					const capabilities = resolveOnB(undefined, ["something_else"]);
					assert.deepStrictEqual(capabilities?.diagnostics, [
						{ kind: "unrecognized-key", recordKey: "gpt-4", key: "supports_web_search", layer: "global" },
					]);
				});

				test("an entry hint keeps its own server's evidence: another server's observation cannot silence it", () => {
					const capabilities = resolveOnB(["known_key"], ["entry_mystery"], {
						"gpt-4": { entry_mystery: 1 },
					});
					assert.deepStrictEqual(
						capabilities?.diagnostics.filter((diagnostic) => diagnostic.layer === "entry"),
						[{ kind: "unrecognized-key", recordKey: "gpt-4", key: "entry_mystery", layer: "entry" }]
					);
				});

				test("an entry hint drops when its own server has no evidence, whatever the union holds", () => {
					const capabilities = resolveOnB(undefined, ["anything"], { "gpt-4": { entry_mystery: 1 } });
					assert.deepStrictEqual(
						capabilities?.diagnostics.filter((diagnostic) => diagnostic.layer === "entry"),
						[]
					);
				});

				test("no evidence anywhere stays silent on both layers", () => {
					const capabilities = resolveOnB(undefined, undefined, { "gpt-4": { entry_mystery: 1 } });
					assert.deepStrictEqual(capabilities?.diagnostics, []);
				});
			});
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

		test("the currency symbol pushes verbatim - empty included - with junk reading as the default", () => {
			const spaced = readSettings(makeReader({ "usage.currencySymbol": "EUR " }));
			assert.strictEqual(spaced.usage.currencySymbol, "EUR ");
			assert.strictEqual(spaced.usage.currencySymbolScope, "global");

			const empty = readSettings(makeReader({ "usage.currencySymbol": "" }));
			assert.strictEqual(empty.usage.currencySymbol, "");

			const junk = readSettings(makeReader({ "usage.currencySymbol": 7 }));
			assert.strictEqual(junk.usage.currencySymbol, "$");

			const unset = readSettings(makeReader({}));
			assert.strictEqual(unset.usage.currencySymbol, "$");
			assert.strictEqual(unset.usage.currencySymbolScope, null);
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
			// makeReader's get() stands in for VS Code's cross-scope merge while the
			// per-scope records come from inspect: the inspector must see the merged
			// record even when the edit scope holds only part of it.
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

		test("feature model refs snapshot per feature: normalized with scopes, malformed and unset as null", () => {
			const settings = readSettings(
				makeReader({
					"inlineCompletions.model": { server: " Prod ", model: " codestral " },
					"commitGeneration.model": { server: "Prod" },
				})
			);
			// One record entry per FEATURE_MODEL_IDS member, the unconfigured
			// features included: recordFromKeys totals the snapshot by construction.
			const unsetRefs = recordFromKeys(FEATURE_MODEL_IDS, () => null);
			assert.deepStrictEqual(settings.featureModels, {
				...unsetRefs,
				inlineCompletions: { server: "Prod", model: "codestral" },
			});
			assert.deepStrictEqual(settings.featureModelScopes, {
				...unsetRefs,
				inlineCompletions: "global",
				commitGeneration: "global",
			});

			const unset = readSettings(makeReader({}));
			assert.deepStrictEqual(unset.featureModels, unsetRefs);
			assert.deepStrictEqual(unset.featureModelScopes, unsetRefs);
		});

		test("the commit prompt snapshots verbatim; a junk value reads as the built-in marker", () => {
			const set = readSettings(makeReader({ "commitGeneration.prompt": "Subject only. " }));
			assert.strictEqual(set.commitPrompt, "Subject only. ");
			assert.strictEqual(set.commitPromptScope, "global");
			const junk = readSettings(makeReader({ "commitGeneration.prompt": 7 }));
			assert.strictEqual(junk.commitPrompt, "");
			assert.strictEqual(readSettings(makeReader({})).commitPromptScope, null);
		});

		test("the commit prompt CR-normalizes at the state boundary alone: the webview drafts in LF", () => {
			// A CRLF (or bare-CR) settings.json prompt would never compare equal to
			// the textarea's own LF round trip, reading as a permanently modified
			// draft on every push; the first dashboard edit rewrites the stored
			// value to LF. The REQUEST path stays verbatim (model-facing text) -
			// getCommitGenerationPrompt is pinned separately in settings.test.ts.
			const crlf = readSettings(makeReader({ "commitGeneration.prompt": "Subject.\r\nBody line.\rTail." }));
			assert.strictEqual(crlf.commitPrompt, "Subject.\nBody line.\nTail.");
		});

		test("the language filter snapshots normalized, and the lossy flag marks exactly the raw values an edit would rewrite", () => {
			// The flag is what stands between a hand-written settings.json filter
			// and a dashboard edit silently canonicalizing it: any drop, trim,
			// dedupe, unrecognized mode, or extra key marks the filter lossy and
			// its rows fall back to read-only.
			const clean = readSettings(
				makeReader({ "inlineCompletions.languageFilter": { mode: "allow", languages: ["typescript", "python"] } })
			);
			assert.deepStrictEqual(clean.languageFilter, {
				mode: "allow",
				languages: { values: ["typescript", "python"], lossy: false, scope: "global" },
			});
			assert.deepStrictEqual(readSettings(makeReader({})).languageFilter, {
				mode: "block",
				languages: { values: [], lossy: false, scope: null },
			});
			// A missing languages list reads as the clean empty list: writing
			// { mode, languages: [] } back is equivalent configuration.
			const bare = readSettings(makeReader({ "inlineCompletions.languageFilter": { mode: "allow" } }));
			assert.deepStrictEqual(bare.languageFilter, {
				mode: "allow",
				languages: { values: [], lossy: false, scope: "global" },
			});

			const lossyCases: readonly [string, unknown, string, readonly string[]][] = [
				["edge whitespace rewrites", { mode: "block", languages: [" typescript "] }, "block", ["typescript"]],
				["duplicates collapse", { mode: "block", languages: ["ts", "ts"] }, "block", ["ts"]],
				["non-strings drop", { mode: "allow", languages: ["ts", 3] }, "allow", ["ts"]],
				["a non-array list reads as empty", { mode: "block", languages: "markdown" }, "block", []],
				["an unrecognized mode reads as the default", { mode: "deny", languages: ["ts"] }, "block", []],
				["a non-object reads as the default", "markdown", "block", []],
				["extra keys a rewrite would drop", { mode: "block", languages: [], legacy: true }, "block", []],
			];
			for (const [name, raw, mode, values] of lossyCases) {
				const settings = readSettings(makeReader({ "inlineCompletions.languageFilter": raw }));
				assert.deepStrictEqual(
					settings.languageFilter,
					{ mode, languages: { values, lossy: true, scope: "global" } },
					name
				);
			}
		});

		test("the keywords lossy flag rides the same rule (the shared normalizedListLossy)", () => {
			const clean = readSettings(makeReader({ "chat.additionalToolSchemaKeywords": ["propertyNames"] }));
			assert.strictEqual(clean.chat.additionalToolSchemaKeywords.lossy, false);
			const lossy = readSettings(makeReader({ "chat.additionalToolSchemaKeywords": ["propertyNames", ""] }));
			assert.strictEqual(lossy.chat.additionalToolSchemaKeywords.lossy, true);
			assert.deepStrictEqual(lossy.chat.additionalToolSchemaKeywords.values, ["propertyNames"]);
		});
	});

	suite("parseDashboardRequest", () => {
		/** One well-formed request envelope; the payload is the case under test. */
		const req = (method: string, payload: unknown, id = "req-1"): unknown => ({ kind: "request", id, method, payload });

		test("accepts every request shape", () => {
			const requests: unknown[] = [
				req("ready", null),
				req("setNumberSetting", { setting: "chat.timeout", value: 60000 }),
				req("setBooleanSetting", { setting: "chat.promptCaching", value: false }),
				req("resetSetting", { setting: "chat.timeout" }),
				req("resetSetting", { setting: "ui.maskSecretInputs" }),
				req("revealSetting", { setting: "chat.timeout" }),
				req("revealSetting", { setting: "chat.promptCaching" }),
				req("revealSetting", { setting: "models.parameters" }),
				req("setModelParameters", { value: { "gpt-4": { temperature: 0.2, stop: ["\n"] } } }),
				req("saveServerSetting", {
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
					secrets: KEEP_ALL,
				}),
				req("saveServerSetting", {
					server: serverPayload({
						label: "Prod",
						baseUrl: "http://prod.test",
						oauthTokenUrl: "https://idp.test/token",
						oauthClientId: "client",
						oauthScopes: "read",
						virtualKeyHeader: "x-litellm-api-key",
					}),
					secrets: {
						apiKey: { action: "set", location: "secure", value: "sk-1" },
						oauthClientSecret: { action: "clear" },
						virtualKeyValue: { action: "set", location: "settings", value: "vk-1" },
					},
					replace: {
						label: "Old Prod",
						baseUrl: "http://old.test",
						secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
					},
				}),
				req("removeServerSetting", { label: "Prod" }),
				req("testServerDraft", {
					server: serverPayload({ label: "", baseUrl: "http://prod.test", oauthTokenUrl: "https://idp.test/token" }),
					secrets: KEEP_ALL,
				}),
				req("testServerDraft", {
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
					secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "sk-1" } },
					replace: {
						label: "Prod",
						baseUrl: "http://prod.test",
						secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
					},
				}),
				req("readInlineSecrets", {
					replace: {
						label: "Prod",
						baseUrl: "http://prod.test",
						secrets: { apiKey: "settings", oauthClientSecret: "none", virtualKeyValue: "none" },
					},
				}),
				req("adoptServer", {
					label: "Adopted",
					baseUrl: "http://ext.test",
					sourceHandle: "handle-ext",
					secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "settings" },
				}),
				req("executeCommand", { command: "openOutput" }),
			];
			for (const request of requests) {
				assert.ok(parseDashboardRequest(request).success, `rejected ${JSON.stringify(request)}`);
			}
		});

		test("rejects junk envelopes, unknown methods, unknown settings, unknown commands, and extra fields", () => {
			const rejected: unknown[] = [
				null,
				"ready",
				// The envelope frame itself: only kind "request", a bounded id, and
				// a table method pass; the old flat message shape is malformed now.
				{ type: "ready" },
				{ kind: "ready", id: "r", method: "ready", payload: null },
				{ kind: "request", method: "ready", payload: null },
				{ kind: "request", id: "", method: "ready", payload: null },
				{ kind: "request", id: "x".repeat(129), method: "ready", payload: null },
				{ kind: "request", id: "r", method: "detonate", payload: null },
				{ kind: "request", id: "r", method: "ready", payload: null, extra: 1 },
				{ kind: "request", id: "r", method: "ready" },
				req("ready", {}),
				req("detonate", {}),
				req("setNumberSetting", { setting: "notASetting", value: 1 }),
				req("setNumberSetting", { setting: "chat.timeout", value: "1000" }),
				req("setNumberSetting", { setting: "chat.timeout", value: Number.POSITIVE_INFINITY }),
				req("setBooleanSetting", { setting: "chat.promptCaching", value: "true" }),
				req("resetSetting", { setting: "notASetting" }),
				req("resetSetting", { setting: "chat.timeout", value: 1 }),
				// revealSetting: only classification-listed ids cross - never
				// arbitrary key text or fully-qualified ids.
				req("revealSetting", { setting: "serverSecrets" }),
				req("revealSetting", { setting: "litellm-vscode-chat.chat.timeout" }),
				req("revealSetting", {}),
				req("revealSetting", { setting: "chat.timeout", extra: 1 }),
				req("setHeaders", { value: { "x-bad": { nested: true } } }),
				req("executeCommand", { command: "workbench.action.terminal.sendSequence" }),
				// Syncing left the postable command set when the acked syncModels
				// wire method took over; the old id must not quietly come back.
				req("executeCommand", { command: "syncModels" }),
				req("ready", { extra: 1 }),
				// saveServerSetting: strict everywhere, so no field rides along into the setting.
				req("saveServerSetting", { server: { label: "P", baseUrl: "http://x" } }),
				req("saveServerSetting", { server: { label: "P" }, secrets: KEEP_ALL }),
				req("saveServerSetting", { server: { baseUrl: "http://x" }, secrets: KEEP_ALL }),
				req("saveServerSetting", {
					server: { label: "P", baseUrl: "http://x", apiKey: "inline-not-allowed-here" },
					secrets: KEEP_ALL,
				}),
				req("saveServerSetting", {
					server: { label: "P", baseUrl: "http://x" },
					secrets: { ...KEEP_ALL, apiKey: { action: "set", value: "missing-location" } },
				}),
				req("saveServerSetting", {
					server: { label: "P", baseUrl: "http://x" },
					secrets: { ...KEEP_ALL, apiKey: { action: "keep", value: "extra" } },
				}),
				req("saveServerSetting", {
					server: { label: "P", baseUrl: "http://x" },
					secrets: { apiKey: { action: "keep" } },
				}),
				// The always-sent fields are required: a save rebuilds the whole entry,
				// so an omission-tolerant schema would let a stale sender silently
				// delete hand-written configuration.
				...(["modelCapabilities", "expectedFailures", "headers", "declaredModels", "budget"] as const).map(
					(omitted) => {
						const server: Record<string, unknown> = { ...serverPayload({ label: "P", baseUrl: "http://x" }) };
						delete server[omitted];
						return req("saveServerSetting", { server, secrets: KEEP_ALL });
					}
				),
				req("removeServerSetting", {}),
				req("removeServerSetting", { label: 4 }),
				// The size bounds: no honest value meets them, so anything over is a
				// hostile page ballooning a settings write.
				req("removeServerSetting", { label: "x".repeat(1025) }),
				req("saveServerSetting", {
					server: serverPayload({ label: "P", baseUrl: `http://x/${"y".repeat(4096)}` }),
					secrets: KEEP_ALL,
				}),
				req("saveServerSetting", {
					server: serverPayload({ label: "P", baseUrl: "http://x" }),
					secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "s".repeat(8193) } },
				}),
				req("setModelParameters", {
					value: Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`m${index}`, {}])),
				}),
				req("setModelParameters", { value: { [`m${"x".repeat(512)}`]: {} } }),
				req("setModelParameters", { value: { "gpt-4": { note: "x".repeat(1024 * 1024) } } }),
				req("saveServerSetting", {
					// The closed enum caps the list length: a ballooned duplicate list
					// must not ride into the setting.
					server: serverPayload({
						label: "P",
						baseUrl: "http://x",
						expectedFailures: Array.from({ length: 3 }, () => "modelInfo" as const),
					}),
					secrets: KEEP_ALL,
				}),
				// testServerDraft: the save payload's strictness verbatim - no inline
				// secret fields on the server object, no unknown fields riding along.
				req("testServerDraft", { server: { label: "P", baseUrl: "http://x" } }),
				req("testServerDraft", {
					server: { label: "P", baseUrl: "http://x", apiKey: "inline-not-allowed-here" },
					secrets: KEEP_ALL,
				}),
				req("testServerDraft", {
					server: { label: "P", baseUrl: "http://x" },
					secrets: KEEP_ALL,
					extra: 1,
				}),
				// readInlineSecrets: the displayed identity only, nothing rides along.
				req("readInlineSecrets", {}),
				req("readInlineSecrets", { label: "P" }),
				req("readInlineSecrets", {
					replace: {
						label: "P",
						baseUrl: "http://x",
						secrets: { apiKey: "keychain", oauthClientSecret: "none", virtualKeyValue: "none" },
					},
				}),
				// adoptServer: never a credential value, only storage locations.
				req("adoptServer", {
					label: "A",
					baseUrl: "http://x",
					sourceHandle: "x",
					secrets: { apiKey: "keychain", oauthClientSecret: "secure", virtualKeyValue: "secure" },
				}),
				req("adoptServer", {
					label: "A",
					baseUrl: "http://x",
					sourceHandle: "x",
					secrets: { apiKey: "secure", oauthClientSecret: "secure" },
				}),
				req("adoptServer", {
					label: "A",
					baseUrl: "http://x",
					sourceHandle: "x",
					secrets: {
						apiKey: "secure",
						oauthClientSecret: "secure",
						virtualKeyValue: "secure",
						apiKeyValue: "sk-smuggled",
					},
				}),
				req("adoptServer", {
					label: "A",
					baseUrl: "http://x",
					secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
				}),
				req("adoptServer", {
					label: "A",
					baseUrl: "http://x",
					sourceHandle: "",
					secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
				}),
			];
			for (const message of rejected) {
				// The label is truncated: some fixtures are megabytes by design, and
				// a failure message must stay readable.
				assert.strictEqual(
					parseDashboardRequest(message).success,
					false,
					`accepted ${JSON.stringify(message)?.slice(0, 300)}`
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
			assert.deepStrictEqual(readInlineSecretValues(setting, inlineOnlyIdentity(setting, "Inline")), {
				apiKey: "sk-inline",
				virtualKeyValue: "vk-inline",
			});
		});

		test("secure-side and absent fields get no key at all: absence, not an empty string", () => {
			// "Secure" holds nothing inline; whatever its SecretStorage blob holds
			// is not consulted here and must never come back.
			assert.deepStrictEqual(readInlineSecretValues(setting, inlineOnlyIdentity(setting, "Secure")), {});
			const mixed = readInlineSecretValues(setting, inlineOnlyIdentity(setting, "Mixed"));
			assert.deepStrictEqual(mixed, { apiKey: "sk-mixed" });
			assert.ok(!("oauthClientSecret" in mixed), "a whitespace-only inline value counts as absent");
			assert.ok(!("virtualKeyValue" in mixed));
		});

		test("an unknown label, a junk setting, and a non-string field value all yield an empty record", () => {
			assert.deepStrictEqual(readInlineSecretValues(setting, replaceIdentity("Nope", "http://x")), {});
			assert.deepStrictEqual(readInlineSecretValues("not an array", replaceIdentity("Inline", "http://a.test")), {});
			assert.deepStrictEqual(readInlineSecretValues(undefined, replaceIdentity("Inline", "http://a.test")), {});
			const emptyValued = [{ label: "N", baseUrl: "http://x", auth: { apiKey: "" } }];
			assert.deepStrictEqual(readInlineSecretValues(emptyValued, inlineOnlyIdentity(emptyValued, "N")), {});
		});

		test("labels match trimmed, like entry lookup everywhere else", () => {
			const padded = [{ label: " Prod ", baseUrl: "http://x", auth: { apiKey: "sk-1" } }];
			assert.deepStrictEqual(readInlineSecretValues(padded, inlineOnlyIdentity(padded, "Prod")), {
				apiKey: "sk-1",
			});
		});

		test("resolution agrees with parseServersSetting: a rejected same-label sibling cannot shadow the accepted entry", () => {
			// The first raw entry carries the label but has no usable baseUrl, so
			// the parser rejects it and the dashboard row describes the SECOND
			// entry; the prefill must read that same entry.
			const shadowed = [
				{ label: "Prod", auth: { apiKey: "sk-shadow" } },
				{ label: "Prod", baseUrl: "http://real.test", auth: { apiKey: "sk-real" } },
			];
			assert.deepStrictEqual(readInlineSecretValues(shadowed, inlineOnlyIdentity(shadowed, "Prod")), {
				apiKey: "sk-real",
			});
		});

		test("a label the parser rejects yields nothing, even when a raw entry carries inline fields under it", () => {
			// The dashboard never declares this entry (reserved label), so a
			// crafted request must not be able to read its inline fields.
			const rejected = [{ label: "__proto__", baseUrl: "http://x.test", auth: { apiKey: "sk-hidden" } }];
			assert.deepStrictEqual(
				readInlineSecretValues(rejected, replaceIdentity("__proto__", "http://x.test", { apiKey: "settings" })),
				{}
			);
		});

		test("duplicate accepted labels resolve to the first, matching the parser's first-entry-wins rule", () => {
			const duplicated = [
				{ label: "Prod", baseUrl: "http://a.test", auth: { apiKey: "sk-first" } },
				{ label: "Prod", baseUrl: "http://b.test", auth: { apiKey: "sk-second" } },
			];
			assert.deepStrictEqual(readInlineSecretValues(duplicated, inlineOnlyIdentity(duplicated, "Prod")), {
				apiKey: "sk-first",
			});
		});

		test("an entry that no longer matches the displayed identity prefills nothing", () => {
			// The same-label swap racing the prefill: the form displayed the entry
			// at a.test; the label now carries one at b.test with its own inline
			// key. The stale form must not receive the replacement's value.
			const swapped = [{ label: "Inline", baseUrl: "http://b.test", auth: { apiKey: "sk-swapped" } }];
			assert.deepStrictEqual(
				readInlineSecretValues(swapped, replaceIdentity("Inline", "http://a.test", { apiKey: "settings" })),
				{}
			);
		});

		test("moved secret locations prefill nothing either", () => {
			// Same host, but the entry now inlines a key the form displayed as
			// "none": a different credential shape is a different entry.
			const moved = [{ label: "Inline", baseUrl: "http://a.test", auth: { apiKey: "sk-moved-inline" } }];
			assert.deepStrictEqual(readInlineSecretValues(moved, replaceIdentity("Inline", "http://a.test")), {});
		});

		test("a changed OAuth destination prefills nothing: the stored values belong to the new token URL", () => {
			const repointed = [
				{
					label: "OAuth",
					baseUrl: "http://a.test",
					auth: { oauth: { tokenUrl: "https://idp-b.test/token", clientId: "c1", clientSecret: "cs-inline" } },
				},
			];
			const displayed = {
				...inlineOnlyIdentity(repointed, "OAuth"),
				oauthTokenUrl: "https://idp-a.test/token",
			};
			assert.deepStrictEqual(readInlineSecretValues(repointed, displayed), {});
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

		test("validateNumberSetting refuses fractions for integer-only settings", () => {
			// The message schema admits any finite number, so this host-side gate is
			// what keeps a crafted payload from writing a fraction into a field whose
			// contribution declares "integer", driven by the spec's integer flag.
			const refused = validateNumberSetting("chat.maxToolsPerRequest", 2.5);
			assert.ok(refused !== undefined, "a fractional tool cap is refused");
			assert.ok(refused.split("\n")[1]?.includes("chat.maxToolsPerRequest"), refused);
			assert.strictEqual(validateNumberSetting("chat.maxToolsPerRequest", 129), undefined);
			assert.strictEqual(
				validateNumberSetting("chat.timeout", 1000.5),
				undefined,
				"non-integer settings still accept fractions"
			);
		});

		test("number-setting refusals are two-part: a headline, then a detail line naming the setting id", () => {
			// The banner is page-global and names no field, so the detail line must
			// carry the setting id while the headline carries the unit-aware minimum.
			const below = validateNumberSetting("chat.timeout", 999);
			assert.ok(below !== undefined, "a below-minimum value is refused");
			const [belowHeadline, belowDetail] = below.split("\n");
			assert.ok(belowHeadline?.includes("1000 ms"), below);
			assert.ok(!belowHeadline?.includes("chat.timeout"), "the headline stays jargon-free");
			assert.ok(belowDetail?.includes("chat.timeout"), below);

			const nulled = validateNumberSetting("chat.timeout", null);
			assert.ok(nulled !== undefined, "null is refused for a non-nullable setting");
			assert.ok(nulled.split("\n")[1]?.includes("chat.timeout"), nulled);
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

			ok(serverPayload({ label: "Prod", baseUrl: "http://localhost:4000" }));
			ok(serverPayload({ label: "Prod", baseUrl: "https://litellm.example.com/" }));
			bad(serverPayload({ label: "", baseUrl: "http://x" }), "empty label");
			bad(serverPayload({ label: "   ", baseUrl: "http://x" }), "whitespace label");
			bad(serverPayload({ label: "__proto__", baseUrl: "http://x" }), "prototype-polluting label");
			bad(serverPayload({ label: "constructor", baseUrl: "http://x" }), "prototype-polluting label");
			bad(serverPayload({ label: "Prod", baseUrl: "" }), "missing baseUrl");
			bad(serverPayload({ label: "Prod", baseUrl: "localhost:4000" }), "URL without a scheme");
			bad(serverPayload({ label: "Prod", baseUrl: "ftp://host" }), "non-http scheme");
			bad(serverPayload({ label: "Prod", baseUrl: "not a url" }), "junk baseUrl");
			bad(serverPayload({ label: "Prod", baseUrl: "http://x", oauthTokenUrl: "idp.test/token" }), "bad OAuth URL");
			bad(
				serverPayload({ label: "Prod", baseUrl: "http://x", virtualKeyHeader: "bad header" }),
				"header name with a space"
			);
		});

		test("validateSaveServerSetting: secret directives must carry sendable values", () => {
			const server = serverPayload({ label: "Prod", baseUrl: "http://x" });
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
			const problem = validateSaveServerSetting(serverPayload({ label: "Prod", baseUrl: "http://x" }), {
				...KEEP_ALL,
				virtualKeyValue: { action: "set", location: "secure", value: "vk-secret\n" },
			});
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
			partial: Partial<RequestPayload<"testServerDraft">> = {}
		): Promise<IntentAckNotice | undefined> =>
			executeDashboardIntent(
				{
					method: "testServerDraft",
					payload: {
						server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
						secrets: KEEP_ALL,
						...partial,
					},
				},
				recorded.env
			);

		test("validateTestServerDraft: connection rules apply, label rules do not", () => {
			// The probe cares about the connection only: an empty or reserved
			// label must not block it (the button gates on the base URL alone).
			assert.strictEqual(
				validateTestServerDraft(serverPayload({ label: "", baseUrl: "http://x" }), KEEP_ALL),
				undefined
			);
			assert.strictEqual(
				validateTestServerDraft(serverPayload({ label: "__proto__", baseUrl: "http://x" }), KEEP_ALL),
				undefined
			);
			assert.notStrictEqual(
				validateTestServerDraft(serverPayload({ label: "Prod", baseUrl: "" }), KEEP_ALL),
				undefined
			);
			assert.notStrictEqual(
				validateTestServerDraft(serverPayload({ label: "Prod", baseUrl: "not a url" }), KEEP_ALL),
				undefined
			);
			assert.notStrictEqual(
				validateTestServerDraft(
					serverPayload({ label: "Prod", baseUrl: "http://x", oauthTokenUrl: "idp.test/token" }),
					KEEP_ALL
				),
				undefined
			);
			assert.notStrictEqual(
				validateTestServerDraft(
					serverPayload({ label: "Prod", baseUrl: "http://x", virtualKeyHeader: "bad header" }),
					KEEP_ALL
				),
				undefined
			);
			assert.notStrictEqual(
				validateTestServerDraft(serverPayload({ label: "Prod", baseUrl: "http://x" }), {
					...KEEP_ALL,
					apiKey: { action: "set", location: "secure", value: "" },
				}),
				undefined,
				"an empty set-value must be a clear, not a set"
			);
			const problem = validateTestServerDraft(serverPayload({ label: "Prod", baseUrl: "http://x" }), {
				...KEEP_ALL,
				virtualKeyValue: { action: "set", location: "secure", value: "vk-secret\n" },
			});
			assert.ok(problem !== undefined);
			assert.ok(!problem.includes("vk-secret"), problem);
		});

		test("a set directive probes the typed value; nothing is written, stored, or synced", async () => {
			const recorded = makeEnv([]);
			const notice = await draftTest(recorded, {
				secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "sk-draft" } },
			});

			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", label: "Prod", apiKey: "sk-draft", expected: NO_EXPECTED },
			]);
			// Zero models is the shared zero-model warning, never a green success.
			assert.deepStrictEqual(notice, {
				message: "Connected - 0 models. The server answered but listed no models.",
				tone: "warning",
			});
			// The no-mutation contract: a probe leaves every store untouched.
			assert.deepStrictEqual(recorded.serverWrites, []);
			assert.deepStrictEqual(recorded.secretOps, []);
			assert.deepStrictEqual(recorded.updates, []);
			assert.strictEqual(recorded.syncRequests, 0);
		});

		test("the draft's apiVersion override rides the probe connection trimmed; auto stays absent", async () => {
			const custom = makeEnv([]);
			await draftTest(custom, {
				server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", apiVersion: " v2 " }),
			});
			assert.deepStrictEqual(custom.probes, [
				{ baseUrl: "http://prod.test", label: "Prod", apiVersion: "v2", apiKey: "", expected: NO_EXPECTED },
			]);

			// "" is a real override (append nothing) and must reach the probe.
			const none = makeEnv([]);
			await draftTest(none, {
				server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", apiVersion: "" }),
			});
			assert.strictEqual(none.probes[0]?.apiVersion, "");
			assert.ok(none.probes[0] !== undefined && "apiVersion" in none.probes[0]);

			const auto = makeEnv([]);
			await draftTest(auto);
			assert.ok(auto.probes[0] !== undefined && !("apiVersion" in auto.probes[0]), "auto probes the auto rule");
		});

		test("the success notice is static classification plus count, singular and plural", async () => {
			const recorded = makeEnv([]);
			recorded.probeResult = ["m1"];
			assert.strictEqual(await draftTest(recorded), "Connected - 1 model");
			recorded.probeResult = Array.from({ length: 12 }, (_, index) => `m${index}`);
			assert.strictEqual(await draftTest(recorded), "Connected - 12 models");
		});

		test("the draft's declared models join the count when not discovered; discovered ones stay inert", async () => {
			// The probe reports what a save would produce: the payload's declared
			// list. The stored entry's conflicting list pins payload-wins - it must
			// not leak into the count.
			const recorded = makeEnv([
				{ label: "Prod", baseUrl: "http://prod.test", discovery: { declared: ["stored-only"] } },
			]);
			recorded.probeResult = ["gpt-4"];
			const notice = await draftTest(recorded, {
				server: serverPayload({
					label: "Prod",
					baseUrl: "http://prod.test",
					declaredModels: ["my-model", "gpt-4"],
				}),
				replace: await displayedReplace(recorded, "Prod"),
			});
			// gpt-4 is discovered, so its declaration is inert; my-model adds one.
			assert.strictEqual(notice, "Connected - 2 models (1 declared)");
		});

		test("a lone declared model on an empty discovery keeps the singular reading", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.probeResult = [];
			const notice = await draftTest(recorded, {
				server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", declaredModels: ["my-model"] }),
				replace: await displayedReplace(recorded, "Prod"),
			});
			assert.strictEqual(notice, "Connected - 1 model (declared)");
		});

		test("the probe carries the draft's custom headers, exactly what a save would write", async () => {
			// A gateway requiring a header must not report a false probe failure for
			// a configuration that works once saved. The stored entry's conflicting
			// record pins payload-wins: the probe sends the draft's value.
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test", headers: { "x-cf-access": "stale" } }]);
			recorded.probeResult = ["m1"];
			await draftTest(recorded, {
				server: serverPayload({
					label: "Prod",
					baseUrl: "http://prod.test",
					headers: { "x-cf-access": "token-1" },
				}),
				replace: await displayedReplace(recorded, "Prod"),
			});
			assert.deepStrictEqual(recorded.probes[0]?.headers, { "x-cf-access": "token-1" });
		});

		test("an expected modelListing failure reports the declared models instead of failing", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.probeError = new RequestError("404 page not found", "http", {
				status: 404,
				englishMessage: "404 page not found",
			});
			const notice = await draftTest(recorded, {
				server: serverPayload({
					label: "Prod",
					baseUrl: "http://prod.test",
					declaredModels: ["my-model"],
					expectedFailures: ["modelListing"],
				}),
				replace: await displayedReplace(recorded, "Prod"),
			});
			assert.strictEqual(notice, "Discovery failed (expected) - serving 1 declared model");
			// The draft's expectedFailures reach the probe in discovery's
			// per-endpoint shape, so an expected endpoint gets a single attempt.
			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", label: "Prod", apiKey: "", expected: { modelInfo: false, modelListing: true } },
			]);
		});

		test("an expected modelListing failure with nothing declared warns: the needs-declare state, not a pass", async () => {
			const recorded = makeEnv([]);
			recorded.probeError = new RequestError("404 page not found", "http", {
				status: 404,
				englishMessage: "404 page not found",
			});
			const notice = await draftTest(recorded, {
				server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", expectedFailures: ["modelListing"] }),
			});
			assert.deepStrictEqual(notice, {
				message: "Discovery failed (expected) and no models are declared. Add model IDs to Declared models.",
				tone: "warning",
			});
		});

		test("a failure outside the expected categories still fails the intent", async () => {
			const recorded = makeEnv([]);
			recorded.probeError = new RequestError("404 page not found", "http", {
				status: 404,
				englishMessage: "404 page not found",
			});
			await assert.rejects(
				() =>
					draftTest(recorded, {
						server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", expectedFailures: ["modelInfo"] }),
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
				server: serverPayload({
					label: "Prod",
					baseUrl: "http://new.test",
					oauthTokenUrl: "http://idp.test/token",
					oauthClientId: "client-1",
					oauthScopes: "read write",
				}),
				replace: await displayedReplace(recorded, "Prod"),
			});

			assert.deepStrictEqual(recorded.probes, [
				{
					baseUrl: "http://new.test",
					label: "Prod",
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

		test("a fresh label ignores an orphan secure blob: keep on a create resolves nothing, exactly as a save would", async () => {
			// The form showed no stored credential (a create's fields all read
			// "none"), so the probe must not authenticate with a removed label's
			// leftover blob.
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-orphan" });
			await draftTest(recorded);

			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", label: "Prod", apiKey: "", expected: NO_EXPECTED },
			]);
		});

		test("an orphan OAuth or virtual-key blob does not block a create's test-connection", async () => {
			// An orphan resolving into the pairing check would refuse the probe on
			// fields the create form does not render.
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Prod", { oauthClientSecret: "cs-orphan", virtualKeyValue: "vk-orphan" });
			await draftTest(recorded);

			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", label: "Prod", apiKey: "", expected: NO_EXPECTED },
			]);
		});

		test("the add form over a taken label probes credential-less: no replace identity, nothing resolves", async () => {
			// The add form never names an entry to replace, so neither the entry's
			// inline key nor the label's stored blob may be probed against the newly
			// typed base URL - the save writes the same credential-less entry.
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://old.test", auth: { apiKey: "sk-inline-old" } }]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-stored-old" });
			await draftTest(recorded, { server: serverPayload({ label: "Prod", baseUrl: "http://new.test" }) });

			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://new.test", label: "Prod", apiKey: "", expected: NO_EXPECTED },
			]);
		});

		test("a rename draft's keep resolves the source entry alone, never the new label's orphan blob", async () => {
			// The edit form showed "Old", which holds nothing, so the retired
			// label's leftover under the typed new label must not ride the probe -
			// the same rule the save applies when it wipes that blob.
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("New", { apiKey: "sk-orphan" });
			await draftTest(recorded, {
				server: serverPayload({ label: "New", baseUrl: "http://prod.test" }),
				replace: await displayedReplace(recorded, "Old"),
			});

			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", label: "New", apiKey: "", expected: NO_EXPECTED },
			]);
		});

		test("clear probes without the credential even when one is stored", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-inline" }]);
			await draftTest(recorded, {
				secrets: { ...KEEP_ALL, apiKey: { action: "clear" } },
				replace: await displayedReplace(recorded, "Prod"),
			});

			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", label: "Prod", apiKey: "", expected: NO_EXPECTED },
			]);
			assert.deepStrictEqual(recorded.secretOps, [], "clear on a test deletes nothing");
		});

		test("the virtual key pair rides the probe; partial pairs are refused before it", async () => {
			const recorded = makeEnv([]);
			await draftTest(recorded, {
				server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" }),
				secrets: { ...KEEP_ALL, virtualKeyValue: { action: "set", location: "secure", value: "vk-1" } },
			});
			assert.deepStrictEqual(recorded.probes, [
				{
					baseUrl: "http://prod.test",
					label: "Prod",
					apiKey: "",
					virtualKey: { header: "x-vk", value: "vk-1" },
					expected: NO_EXPECTED,
				},
			]);

			await assert.rejects(
				draftTest(recorded, {
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" }),
				}),
				/virtualKeyValue/
			);
			await assert.rejects(
				draftTest(recorded, {
					secrets: { ...KEEP_ALL, virtualKeyValue: { action: "set", location: "secure", value: "vk-1" } },
				}),
				/virtualKeyHeader/
			);
			await assert.rejects(
				draftTest(recorded, {
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", oauthClientId: "client-1" }),
				}),
				/oauthTokenUrl/
			);
			await assert.rejects(
				draftTest(recorded, {
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", oauthTokenUrl: "http://idp.test/token" }),
				}),
				/oauthClientId/
			);
			assert.strictEqual(recorded.probes.length, 1, "refused pairings never reach the probe");
		});

		test("an unusable base URL is refused before the probe runs", async () => {
			const recorded = makeEnv([]);
			await assert.rejects(
				draftTest(recorded, { server: serverPayload({ label: "Prod", baseUrl: "not a url" }) }),
				/baseUrl/
			);
			assert.deepStrictEqual(recorded.probes, []);
		});

		test("editing an entry that vanished is refused like the save path", async () => {
			const recorded = makeEnv([]);
			await assert.rejects(
				draftTest(recorded, { replace: replaceIdentity("Gone", "http://gone.test") }),
				/no longer exists/
			);
			assert.deepStrictEqual(recorded.probes, []);
		});

		test("a probe for an entry swapped underneath the form is refused before any network call", async () => {
			// The form displayed Prod at old.test with no credentials; another
			// window replaced the entry with one at old.test carrying an inline
			// key. A label-only lookup would resolve THAT key for "keep" and send
			// it wherever the draft's base URL points; the identity refuses first.
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://old.test", auth: { apiKey: "sk-swapped-in" } }]);
			await assert.rejects(
				draftTest(recorded, {
					server: serverPayload({ label: "Prod", baseUrl: "http://old.test" }),
					replace: replaceIdentity("Prod", "http://old.test"),
				}),
				/changed in the servers setting/
			);
			assert.deepStrictEqual(recorded.probes, [], "the swapped entry's credential never rides a probe");
		});

		test("a probe whose entry's OAuth destination changed is refused before the token exchange", async () => {
			// Same label, base URL, and locations, but the stored client secret
			// now belongs to another token URL; probing would exchange it at the
			// endpoint the stale form displays.
			const recorded = makeEnv([
				{
					label: "Prod",
					baseUrl: "http://prod.test",
					auth: { oauth: { tokenUrl: "https://idp-b.test/token", clientId: "c1" } },
				},
			]);
			recorded.storedSecrets.set("Prod", { oauthClientSecret: "cs-for-idp-b" });
			const displayed = {
				...(await displayedReplace(recorded, "Prod")),
				oauthTokenUrl: "https://idp-a.test/token",
			};
			await assert.rejects(
				draftTest(recorded, {
					server: serverPayload({
						label: "Prod",
						baseUrl: "http://prod.test",
						oauthTokenUrl: "https://idp-a.test/token",
						oauthClientId: "c1",
					}),
					replace: displayed,
				}),
				/changed in the servers setting/
			);
			assert.deepStrictEqual(recorded.probes, [], "the rotated secret never rides toward the stale endpoint");
		});

		test("a probe for a re-pointed label is refused: the displayed host is not the entry's host anymore", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://moved.test" }]);
			await assert.rejects(
				draftTest(recorded, {
					server: serverPayload({ label: "Prod", baseUrl: "http://old.test" }),
					replace: replaceIdentity("Prod", "http://old.test"),
				}),
				/changed in the servers setting/
			);
			assert.deepStrictEqual(recorded.probes, []);
		});

		test("a transport RequestError surfaces its user-facing message as a validation failure, unlogged", async () => {
			const recorded = makeEnv([]);
			recorded.probeError = new RequestError("Network Error: Unable to reach the LiteLLM server", "network", {
				englishMessage: "Network Error: Unable to reach the LiteLLM server",
			});
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
				englishMessage: "the server answered 404",
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
				draftTest(recorded, { server: serverPayload({ label: "Prod", baseUrl: "not a url" }) }),
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
			// Two groups on one host: the status window's Map re-inserts entries on
			// refresh, so the rows arrive in either order. The handle rides the
			// serverId, where the old rendered-ordinal match could hand back the
			// OTHER group's key.
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
			// Both ordinal rows resolve to the same raw status identity: the
			// tombstone is keyed by the snapshot's own label, never the display
			// ordinal.
			const handle = handleOf(snapshots, [], "ext.test (1)");
			assert.deepStrictEqual(resolveExternalGroupIdentity(snapshots, [], "http://ext.test", handle), {
				label: "ext.test",
				baseUrl: "http://ext.test",
			});
			assert.strictEqual(
				resolveExternalGroupIdentity(snapshots, [], "http://attacker.test", handle),
				undefined,
				"bound to the intent's base URL like the adopt path"
			);
			const declared = [
				makeDeclared({ label: "Prod", baseUrl: "http://ext.test", expectedClientId: "group:aaa:http://ext.test" }),
			];
			assert.strictEqual(
				resolveExternalGroupIdentity(snapshots, declared, "http://ext.test", handle),
				undefined,
				"a declared group's identity must not resolve for a hide intent"
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

		test("isExtensionMessage accepts exactly the extension-to-webview envelope kinds", () => {
			for (const kind of ["push", "focusSection", "response", "ack", "fail"]) {
				assert.ok(isExtensionMessage({ kind }), kind);
			}
			assert.ok(!isExtensionMessage({ kind: "request" }), "webview-to-extension requests are not accepted");
			assert.ok(!isExtensionMessage({ kind: "__proto__" }), "inherited names never pass the own-key test");
			assert.ok(!isExtensionMessage({ type: "state" }), "the retired flat discriminant does not pass");
			assert.ok(!isExtensionMessage(undefined));
			assert.ok(!isExtensionMessage(42));
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
			// The sequence this pins: a setting pinned to exactly its default holds
			// a rejected draft, Reset changes the configured scope but not the
			// value, and the field's draft-resync effect keys on draftSyncKey - so
			// the key must change or the invalid draft survives the reset.
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
