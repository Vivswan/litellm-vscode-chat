import * as assert from "node:assert";
import { modelScopeKey } from "../../../extension/dashboard/adoptHandle";
import { buildDashboardState, resolveDashboardModelParameters } from "../../../extension/dashboard/state";
import type { DeclaredServerView } from "../../../extension/servers/serverSync/engine";
import { DEFAULT_REASONING_EFFORT_LEVELS, reasoningEffortSchema } from "../../../provider/catalog/modelConfiguration";
import { makeModelInfo } from "../../pureHelpers";
import { makeServerStatus } from "../../testUtils";
import { buildState, makeDeclared, makeReader } from "./stateHelpers";

/** The menu the built-in default level list produces; fixtures here carry no per-level server flags. */
const REASONING_EFFORT_SCHEMA = reasoningEffortSchema(DEFAULT_REASONING_EFFORT_LEVELS);

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
						status: makeServerStatus({ serverId: "a", label: "Alpha", state: "error" }),
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
			assert.deepStrictEqual(state.servers[0]?.cause, { kind: "unclassified" });
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
			// restoreServerStatus and syncFailureOverlay's synthetic statuses write "" for a server no discovery pass
			// has stamped; the push states absence.
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

		test("an external row carries the group's stamp as entryLabel and a virtual-key kind, both from the report", () => {
			// The stamp is usually the group's host-side name: the edit form advises before a save collides with it.
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "v", label: "Gateway", hasApiKey: true, hasVirtualKey: true }),
						models: [],
						entryLabel: "Gateway",
					},
					{ status: makeServerStatus({ serverId: "u", label: "prod.test", hasApiKey: false }), models: [] },
				],
				makeReader({})
			);

			const stamped = state.servers.find((server) => server.label === "Gateway");
			assert.ok(stamped?.origin === "external");
			assert.strictEqual(stamped.entryLabel, "Gateway");
			assert.strictEqual(stamped.credentials, "present");
			assert.strictEqual(stamped.hasVirtualKey, true);
			const unstamped = state.servers.find((server) => server.label === "prod.test");
			assert.ok(unstamped?.origin === "external");
			assert.strictEqual(unstamped.entryLabel, undefined, "an unstamped group's name is not knowable");
		});

		test("a failing row carries the status's cause as its key, on external and declared rows alike", () => {
			// The row carries no text: the webview renders the cause in its locale and the copyable diagnostics block
			// renders it in English, so one key serves both. The classification (the setup-hint id the webview maps to
			// a troubleshooting link) rides inside the cause.
			const classification = { kind: "connection", setupHint: "proxy-not-running" } as const;
			const cause = { kind: "transport", classification } as const;
			const external = buildState(
				[{ status: makeServerStatus({ state: "error", classification }), models: [] }],
				makeReader({})
			);
			assert.strictEqual(external.servers[0]?.origin, "external");
			assert.deepStrictEqual(external.servers[0]?.cause, cause);

			const declared = buildState(
				[{ status: makeServerStatus({ state: "error", classification }), models: [] }],
				makeReader({}),
				[makeDeclared()]
			);
			assert.strictEqual(declared.servers[0]?.origin, "declared");
			assert.deepStrictEqual(declared.servers[0]?.cause, cause);

			// A failure nothing classified is the unclassified key, never an absent field or invented text.
			const unclassified = buildState([{ status: makeServerStatus({ state: "error" }), models: [] }], makeReader({}));
			assert.deepStrictEqual(unclassified.servers[0]?.cause, { kind: "unclassified" });
		});

		test("a sync failure masks the live cause whole: the row's key is the sync class, never the transport's hint", () => {
			// The masked transport cause's setup hint would advise on a failure the row is not displaying.
			const classification = { kind: "connection", setupHint: "proxy-not-running" } as const;
			const synced = buildState(
				[{ status: makeServerStatus({ state: "error", classification }), models: [] }],
				makeReader({}),
				[makeDeclared({ syncFailure: { class: "upsertFailed" } })]
			);
			assert.deepStrictEqual(synced.servers[0]?.cause, { kind: "sync", failureClass: "upsertFailed" });
		});

		test("a down server's retained models list under its erroring row without a per-model stale marker", () => {
			// The provider retains a failed group's last known models, so the snapshot pairs an error status with a
			// non-empty model list. Listing them unmarked is deliberate: the server row they cite already renders the
			// error and lastChecked, and no picker decoration enters this path.
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "g1", label: "Prod", state: "error" }),
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
						credentials: { present: true, oauth: true, virtualKey: false },
					}),
				]
			);

			assert.strictEqual(state.servers.length, 1, "the declared entry and the live row merge into one");
			const server = state.servers[0];
			assert.strictEqual(server?.origin, "declared");
			assert.strictEqual(server?.state, "ok");
			assert.strictEqual(server?.servedModelCount, 4);
			assert.strictEqual(server?.credentials, "present", "the owner's reading counts a secure-side key");
			assert.strictEqual(server?.hasOAuth, true);
			assert.deepStrictEqual(server?.config?.secrets, {
				kind: "proven",
				locations: { apiKey: "secure", oauthClientSecret: "settings", virtualKeyValue: "none" },
			});
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
			// Both snapshots are host-labeled identically, so no label pass can tell them apart and the URL fallback
			// would pair them by position; the sync engine's client-ID fingerprint is exact. The declared order is
			// chosen so the positional fallback would swap them.
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

		test("a group no entry claims by ID, connection, or label and URL is external unless a declared label still names it", () => {
			// Never by URL alone: a user's own group beside a declared one is nobody's. What the setting still names
			// (a stamp, a stored key) is the label's leftover: a legacy row the provider keeps serving from, or hidden
			// as superseded when it is the stamped leftover of an entry that moved, the one class the provider hides.
			const group = (serverId: string, label: string, baseUrl: string, entryLabel?: string) => ({
				status: makeServerStatus({ serverId, label, baseUrl, servedModelCount: 1 }),
				models: [makeModelInfo({ id: `m-${serverId}`, name: `m-${serverId}` })],
				...(entryLabel !== undefined ? { entryLabel } : {}),
			});
			const prodAtX = makeDeclared({
				label: "Prod",
				baseUrl: "http://x.test/",
				expectedClientId: "group:fp-new:http://x.test",
			});
			const rejectedProd = (baseUrl: string) => [
				{ index: 0, label: "Prod", baseUrl, problems: ["auth.oauth lacks clientId"], accepted: false },
			];
			const cases: {
				name: string;
				inputs: Parameters<typeof buildDashboardState>[0];
				rows: [string, string, string][];
				hidden: unknown[];
				/** The server label each live model renders under; a hidden leftover's models leave the list. */
				models: string[];
			}[] = [
				{
					name: "rotated secret, pre-label group at the entry's URL, no stored key: the user's own group",
					inputs: {
						snapshots: [group("group:fp-old:http://x.test", "x.test", "http://x.test")],
						reader: makeReader({}),
						declared: { source: "engine", views: [prodAtX] },
					},
					rows: [
						["Prod", "declared", "unchecked"],
						["x.test", "external", "ok"],
					],
					hidden: [],
					models: ["x.test"],
				},
				{
					name: "pre-label group carrying the entry's stored key at its own URL: a legacy row",
					inputs: {
						snapshots: [group("group:fp-old:http://x.test", "x.test", "http://x.test")],
						reader: makeReader({}),
						declared: { source: "engine", views: [prodAtX] },
						secretHolders: new Map([["group:fp-old:http://x.test", ["Prod"]]]),
					},
					rows: [
						["Prod", "declared", "unchecked"],
						["x.test", "legacy", "ok"],
					],
					hidden: [],
					models: ["x.test"],
				},
				{
					name: "stamped group of an entry that moved: superseded, hidden like the provider hides it",
					inputs: {
						snapshots: [group("g-prod", "Prod", "http://old.test", "Prod")],
						reader: makeReader({}),
						declared: { source: "engine", views: [makeDeclared({ label: "Prod", baseUrl: "http://new.test" })] },
					},
					rows: [["Prod", "declared", "unchecked"]],
					hidden: [
						{ label: "Prod", baseUrl: "http://old.test", reason: "superseded", declaredBaseUrl: "http://new.test" },
					],
					models: [],
				},
				{
					name: "pre-label group carrying the moved entry's retained key: a legacy row, since the provider still serves it",
					inputs: {
						snapshots: [group("group:fp-old:http://old.test", "old.test", "http://old.test")],
						reader: makeReader({}),
						declared: { source: "engine", views: [makeDeclared({ label: "Prod", baseUrl: "http://new.test" })] },
						secretHolders: new Map([["group:fp-old:http://old.test", ["Prod"]]]),
					},
					rows: [
						["old.test", "legacy", "ok"],
						["Prod", "declared", "unchecked"],
					],
					hidden: [],
					models: ["old.test"],
				},
				{
					name: "stamped group of a label only a rejected carrier holds, at the carrier's URL: a legacy row",
					inputs: {
						snapshots: [group("g-prod", "Prod", "http://x.test", "Prod")],
						reader: makeReader({}),
						entryReports: rejectedProd("http://x.test"),
					},
					rows: [
						["Prod", "legacy", "ok"],
						["Prod", "misconfigured", "error"],
					],
					hidden: [],
					models: ["Prod"],
				},
				{
					name: "stamped group of a label only a rejected carrier holds, the carrier at another URL: still a legacy row",
					inputs: {
						snapshots: [group("g-prod", "Prod", "http://old.test", "Prod")],
						reader: makeReader({}),
						entryReports: rejectedProd("http://new.test"),
					},
					rows: [
						["Prod", "misconfigured", "error"],
						["Prod", "legacy", "ok"],
					],
					hidden: [],
					models: ["Prod"],
				},
				{
					name: "leftover at the accepted entry's own URL, a rejected duplicate elsewhere: legacy, the duplicate's URL says nothing",
					inputs: {
						snapshots: [group("group:fp-old:http://x.test", "x.test", "http://x.test")],
						reader: makeReader({}),
						declared: { source: "engine", views: [prodAtX] },
						entryReports: [
							{ index: 0, label: "Prod", baseUrl: "http://x.test", problems: [], accepted: true },
							...rejectedProd("http://dup.test").map((report) => ({ ...report, index: 1 })),
						],
						secretHolders: new Map([["group:fp-old:http://x.test", ["Prod"]]]),
					},
					rows: [
						["Prod", "declared", "unchecked"],
						["x.test", "legacy", "ok"],
					],
					hidden: [],
					models: ["x.test"],
				},
				{
					name: "tombstone of a carrier-only label's labeled group, its snapshot evicted: removed, an Unhide can lift it",
					inputs: {
						snapshots: [],
						reader: makeReader({}),
						entryReports: rejectedProd("http://new.test"),
						removedGroups: { tombstones: [{ by: "entry", label: "Prod", baseUrl: "http://old.test" }], origins: [] },
						wasGroupObserved: () => true,
						wasLabeledGroupObserved: () => true,
					},
					rows: [["Prod", "misconfigured", "error"]],
					hidden: [{ label: "Prod", baseUrl: "http://old.test", reason: "removed", syncedName: "Prod" }],
					models: [],
				},
				{
					name: "holder of a moved entry's key stamped with another, undeclared label: a legacy row, since the provider reads the stamp",
					inputs: {
						snapshots: [group("g-personal", "Personal", "http://old.test", "Personal")],
						reader: makeReader({}),
						declared: { source: "engine", views: [makeDeclared({ label: "Prod", baseUrl: "http://new.test" })] },
						secretHolders: new Map([["g-personal", ["Prod"]]]),
					},
					rows: [
						["Personal", "legacy", "ok"],
						["Prod", "declared", "unchecked"],
					],
					hidden: [],
					models: ["Personal"],
				},
				{
					name: "tombstoned legacy leftover: hidden as removed, like the provider hides every tombstone",
					inputs: {
						snapshots: [group("g-prod", "Prod", "http://old.test", "Prod")],
						reader: makeReader({}),
						entryReports: rejectedProd("http://new.test"),
						removedGroups: { tombstones: [{ by: "entry", label: "Prod", baseUrl: "http://old.test" }], origins: [] },
						wasGroupObserved: () => true,
						wasLabeledGroupObserved: () => true,
					},
					rows: [["Prod", "misconfigured", "error"]],
					hidden: [{ label: "Prod", baseUrl: "http://old.test", reason: "removed", syncedName: "Prod" }],
					models: [],
				},
				{
					name: "holder of a label the setting no longer carries (the last pass's stored key): the user's own group",
					inputs: {
						snapshots: [group("group:fp-old:http://x.test", "x.test", "http://x.test")],
						reader: makeReader({}),
						secretHolders: new Map([["group:fp-old:http://x.test", ["Old"]]]),
					},
					rows: [["x.test", "external", "ok"]],
					hidden: [],
					models: ["x.test"],
				},
			];
			for (const { name, inputs, rows, hidden, models } of cases) {
				const state = buildDashboardState(inputs);
				assert.deepStrictEqual(
					state.servers.map((server) => [server.label, server.origin, server.state]),
					rows,
					name
				);
				assert.deepStrictEqual(state.hiddenGroups, hidden, name);
				assert.deepStrictEqual(
					state.models.map((model) => model.serverLabel),
					models,
					name
				);
				assert.ok(
					state.servers.every(
						(server) => server.origin !== "legacy" || (server.adoptHandle === undefined && server.groupHandle !== "")
					),
					`${name}: a legacy row carries its group token and no adopt handle`
				);
			}
		});

		test("two declared entries mirroring one pre-label group share its snapshot instead of one reading unchecked", () => {
			// Groups created before labels flowed into their configurations report under ONE label-agnostic identity,
			// which both entries carry as expectedConnectionId: both rows must render the live status rather than leave
			// one stuck on "not checked" forever.
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
			// The host registers a group's models once PER GROUP, so a pre-label snapshot claimed by several declared
			// entries must attribute its models to every claimant, not render them once under the first label.
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
			// The second same-connection entry's group add FAILED outright, but the engine still emits its connection
			// identity, so it claims the snapshot - and the picker has ONE group, so duplicating the models
			// overcounts.
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
						syncFailure: { class: "upsertFailed" },
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
			assert.deepStrictEqual(staging?.cause, { kind: "sync", failureClass: "upsertFailed" });
			const prod = state.servers.find((server) => server.label === "Prod");
			assert.strictEqual(prod?.servedModelCount, 2, "the serving claimant keeps the live count");
			assert.strictEqual(state.servedModelCount, 2, "the hero counts the shared snapshot once");
		});

		test("a blocked claimant keeps its models copy: the duplicate refusal proves its group exists", () => {
			// A name-conflict refusal means a live group with that name IS registering models; dropping the copy would
			// under-report the picker.
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
						syncFailure: { class: "blocked" },
					}),
				]
			);

			assert.deepStrictEqual(
				state.models.map((m) => `${m.serverLabel}/${m.name}`),
				["Prod/m1", "Staging/m1"]
			);
		});

		test("a snapshot whose only claimant is upsertFailed still lists its models once, under that label", () => {
			// The reporting group exists and serves, so the models cannot vanish just because the entry's last add
			// failed: they render once, not zero times.
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
						syncFailure: { class: "upsertFailed" },
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
			// The post-identity shape of the same setup: distinct labeled snapshots carrying the same raw model IDs
			// stay two registrations, one row per server per model, matching the picker.
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
			// The connection-identity join means the live group carries no label, so the request path never applies
			// this entry's parameters: the row must warn instead of rendering healthy, via the classification alone.
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
			// The classification itself rides both rows: the notices exist only for configured field families, but
			// Staging's identity problem is the same, and the webview's declare offers key on the flag, not the
			// evidence.
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
			// The snapshot's display label is the URL host, so this pass can match an unlabeled group whose credentials
			// differ from the entry. Only the exact labeled-identity join proves the group carries the entry's label.
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

		test("the shared pass never crosses connections: a different-credential entry keeps its own outcome", () => {
			// One live group under key A.
			//
			//   The entry declaring key B shares only the URL, not the connection -> it must stay unchecked
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

		test("a declared entry no discovery pass has seen renders unchecked; a sync failure renders as its cause", () => {
			const state = buildState([], makeReader({}), [
				makeDeclared({ label: "New", baseUrl: "http://new.test" }),
				makeDeclared({
					label: "Broken",
					baseUrl: "http://broken.test",
					syncFailure: { class: "upsertFailed" },
				}),
			]);

			const byLabel = new Map(state.servers.map((server) => [server.label, server]));
			assert.strictEqual(byLabel.get("New")?.state, "unchecked");
			assert.strictEqual(byLabel.get("New")?.lastChecked, undefined);
			assert.strictEqual(byLabel.get("Broken")?.state, "error");
			assert.deepStrictEqual(byLabel.get("Broken")?.cause, { kind: "sync", failureClass: "upsertFailed" });
		});

		test("a sync error outranks a reachable group's ok state without erasing the live counts", () => {
			// The host cannot update the group, so the reachable group runs the entry's OLD configuration: the row is
			// an error carrying the sync cause (the same shape the status bar's overlay judges), while the served count
			// keeps the live truth.
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
						syncFailure: { class: "blocked" },
					}),
				]
			);

			assert.strictEqual(state.servers.length, 1);
			assert.strictEqual(state.servers[0]?.state, "error", "the sync failure outranks the live ok state");
			assert.deepStrictEqual(state.servers[0]?.cause, { kind: "sync", failureClass: "blocked" });
			assert.strictEqual(state.servers[0]?.servedModelCount, 4, "the served count stays the live truth");
		});

		suite("secret-location proof", () => {
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
				// The fallback cannot read secret blobs synchronously, so its "none" is only "no inline value". Pushing
				// it as fact froze a wrong identity into edit forms opened in that window, whose saves then refused as
				// "the entry changed"; the row must say unproven instead - and the unproven shape carries NO locations,
				// so nothing can read one.
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
				// Inline wins over any blob, so all-"settings" locations need no blob read: the setting alone proves
				// them, and the row stays editable.
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

			test("presence and kind are the owner's reading, never the row's own judgment of the locations", () => {
				// The group parser drops a header-illegal virtual-key value, so the owner answers absent while the
				// locations still say a value is stored; a row judging locations itself would badge a credential the
				// group does not hold.
				const build = (credentials: DeclaredServerView["credentials"]) =>
					buildDashboardState({
						snapshots: [],
						reader: makeReader({}),
						declared: {
							source: "engine",
							views: [
								makeDeclared({
									virtualKeyHeader: "x-vk",
									secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "secure" },
									credentials,
								}),
							],
						},
					});

				const row = declaredRow(build({ present: true, oauth: false, virtualKey: true }));
				assert.strictEqual(row.credentials, "present");
				assert.strictEqual(row.hasVirtualKey, true);
				assert.strictEqual(row.hasOAuth, false);
				assert.strictEqual(
					declaredRow(build({ present: false, oauth: false, virtualKey: false })).credentials,
					"absent"
				);
			});

			test("when the live report is the voice proving presence, the row takes the kind from it too", () => {
				// The owner could not read the stored virtual key (its reading says absent) while the group's report
				// proves the key and names it a virtual key; the badge must not say "API key" for that group.
				const state = buildDashboardState({
					snapshots: [
						{
							status: makeServerStatus({ serverId: "group:v", hasApiKey: true, hasVirtualKey: true }),
							models: [],
						},
					],
					reader: makeReader({}),
					declared: {
						source: "engine",
						views: [
							makeDeclared({
								virtualKeyHeader: "x-vk",
								secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "secure" },
								credentials: { present: false, oauth: false, virtualKey: false },
							}),
						],
					},
				});

				const row = declaredRow(state);
				assert.strictEqual(row.credentials, "present");
				assert.strictEqual(row.hasVirtualKey, true);
				assert.strictEqual(row.hasOAuth, false);
			});

			test("an inline key vouches for presence even while the row stays unproven", () => {
				// The fallback's owner reading covers the inline fields, so its "present" is fact; only the deny side
				// waits for a blob read.
				const state = buildDashboardState({
					snapshots: [],
					reader: makeReader({}),
					declared: {
						source: "settings-fallback",
						views: [
							makeDeclared({
								secrets: { apiKey: "settings", oauthClientSecret: "none", virtualKeyValue: "none" },
								credentials: { present: true, oauth: false, virtualKey: false },
							}),
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
				// The engine substitutes an empty blob when SecretStorage refuses the read (syncFailure class
				// "secretsUnreadable"), so its "none" is the same guess the fallback makes; the engine tag alone must
				// not prove it.
				const state = buildDashboardState({
					snapshots: [],
					reader: makeReader({}),
					declared: {
						source: "engine",
						views: [
							makeDeclared({
								secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
								syncFailure: { class: "secretsUnreadable" },
							}),
						],
					},
				});

				assert.deepStrictEqual(declaredRow(state).config.secrets, { kind: "unproven" });
			});

			test("a salt-durability skip read its blob, so its locations stay proven under its own class", () => {
				// Salt-durability skips carry their own "saltUnavailable" class and their secret read SUCCEEDED;
				// marking those unproven would lock the row out of editing all session.
				const state = buildDashboardState({
					snapshots: [],
					reader: makeReader({}),
					declared: {
						source: "engine",
						views: [
							makeDeclared({
								secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
								syncFailure: { class: "saltUnavailable" },
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
								syncFailure: { class: "secretsUnreadable" },
							}),
							// An upsert failure happens AFTER a successful blob read, so its locations stay proven
							// facts.
							makeDeclared({
								label: "Upsert",
								baseUrl: "http://upsert.test",
								secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
								syncFailure: { class: "upsertFailed" },
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
			// The webview holds a handle across background refreshes, so a rebuild must mint the same one; and the
			// handle must not leak what it derives from (the serverId embeds the group's credential fingerprint).
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
					defaultMaxTokens: 8000,
					serverDeclared: { kind: "discovered", values: {}, defaultMaxTokens: 8000 },
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
				defaultMaxTokens: 8000,
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
				{ tombstones: [{ by: "group", groupId: "g1", label: "Prod", baseUrl: "http://prod.test" }], origins: [] }
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
			assert.deepStrictEqual(state.hiddenGroups, [{ label: "Prod", baseUrl: "http://prod.test", reason: "removed" }]);
			assert.strictEqual(
				state.servedModelCount,
				3,
				"a snapshot with no rows or model rows must not count into the hero during the tombstone window"
			);
		});

		test("tombstones suppress by the group's client ID, never the display ordinal", () => {
			// Two external groups share a label, so the table would render "Dup (1)" and "Dup (2)"; the tombstone names
			// one group's client ID.
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
				{ tombstones: [{ by: "group", groupId: "g2", label: "Dup", baseUrl: "http://b.test" }], origins: [] }
			);

			assert.deepStrictEqual(
				state.servers.map((server) => server.baseUrl),
				["http://a.test"],
				"exactly the tombstoned identity hides"
			);
		});

		test("a declared row is never suppressed, even when a tombstone matches its identity", () => {
			// The engine auto-clears such a tombstone on its next pass; until then the declared entry the user just
			// wrote must keep rendering.
			const state = buildState(
				[
					{
						status: makeServerStatus({ label: "Prod", baseUrl: "http://prod.test" }),
						models: [],
					},
				],
				makeReader({}),
				[makeDeclared()],
				{ tombstones: [{ by: "group", groupId: "srv1", label: "Prod", baseUrl: "http://prod.test" }], origins: [] }
			);

			assert.strictEqual(state.servers.length, 1);
			assert.strictEqual(state.servers[0]?.origin, "declared");
		});

		test("a live group carrying an entry's label at another URL is a superseded leftover: hidden, out of the join, no Unhide", () => {
			// The entry "Prod" was re-pointed from old.test to new.test; the add-only host kept the stamped group at
			// old.test. A second entry declares old.test itself and claims nothing by URL alone, so the leftover is
			// Prod's and hidden as superseded, the suppression the provider applies by the same stamp. A tombstone
			// on the same identity yields to the superseded reading: an Unhide could not lift that suppression. An
			// UNLABELED group whose URL-host display label equals a declared label ("bare.test") is not a leftover
			// of anything: its configuration carries no entry label, so it stays an external row.
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "g-old",
							label: "Prod",
							baseUrl: "http://old.test",
							servedModelCount: 2,
						}),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
						entryLabel: "Prod",
					},
					{
						status: makeServerStatus({
							serverId: "g-bare",
							label: "bare.test",
							baseUrl: "http://bare.test",
							servedModelCount: 1,
						}),
						models: [makeModelInfo({ id: "m2", name: "m2" })],
					},
				],
				makeReader({}),
				[
					makeDeclared({ label: "Prod", baseUrl: "http://new.test/" }),
					makeDeclared({ label: "Twin", baseUrl: "http://old.test" }),
					makeDeclared({ label: "bare.test", baseUrl: "http://elsewhere.test" }),
				],
				{ tombstones: [{ by: "entry", label: "Prod", baseUrl: "http://old.test" }], origins: [] },
				// The controller saw the stamped group this session, which is what lets the line read it as superseded.
				{ wasGroupObserved: () => true, wasLabeledGroupObserved: () => true }
			);

			assert.deepStrictEqual(
				state.servers.map((server) => [server.label, server.origin, server.state]),
				[
					["bare.test", "external", "ok"],
					["bare.test", "declared", "unchecked"],
					["Prod", "declared", "unchecked"],
					["Twin", "declared", "unchecked"],
				],
				"the leftover is neither an external row nor Twin's group; the unlabeled group stays external"
			);
			assert.deepStrictEqual(state.hiddenGroups, [
				{ label: "Prod", baseUrl: "http://old.test", reason: "superseded", declaredBaseUrl: "http://new.test" },
			]);
			assert.deepStrictEqual(
				state.models.map((model) => model.serverLabel),
				["bare.test"],
				"the leftover's models leave the table with it"
			);
			assert.strictEqual(state.servedModelCount, 1);
		});

		test("hidden groups persist without a live snapshot, so unhide stays offered", () => {
			const state = buildState([], makeReader({}), [], {
				tombstones: [{ by: "entry", label: "Gone", baseUrl: "http://gone.test" }],
				origins: [],
			});

			assert.deepStrictEqual(state.servers, []);
			assert.deepStrictEqual(state.hiddenGroups, [{ label: "Gone", baseUrl: "http://gone.test", reason: "removed" }]);
		});

		test("a tombstone seen as a labeled group whose entry now declares another URL renders superseded even with no live snapshot", () => {
			// An idle status window evicts and re-reports live groups, so the snapshot can be absent while the group
			// exists; the tombstone's classification must not flip to "removed" (with an Unhide the suppression would
			// ignore) in that gap. An identity only ever seen as an UNLABELED group is not an entry's leftover and
			// stays removed with no synced name; a labeled one whose entry is gone stays removed and carries the name
			// the sync gave the group.
			const state = buildDashboardState({
				snapshots: [],
				reader: makeReader({}),
				declared: {
					source: "engine",
					views: [
						makeDeclared({ label: "Prod", baseUrl: "http://new.test" }),
						makeDeclared({ label: "bare.test", baseUrl: "http://elsewhere.test" }),
					],
				},
				removedGroups: {
					tombstones: [
						{ by: "entry", label: "Prod", baseUrl: "http://old.test" },
						{ by: "group", groupId: "g-bare", label: "bare.test", baseUrl: "http://bare.test" },
						{ by: "entry", label: "Gone", baseUrl: "http://gone.test" },
					],
					origins: [],
				},
				wasGroupObserved: () => true,
				wasLabeledGroupObserved: (tombstone) => tombstone.by === "entry",
			});

			assert.deepStrictEqual(state.hiddenGroups, [
				{ label: "bare.test", baseUrl: "http://bare.test", reason: "removed" },
				{ label: "Gone", baseUrl: "http://gone.test", reason: "removed", syncedName: "Gone" },
				{ label: "Prod", baseUrl: "http://old.test", reason: "superseded", declaredBaseUrl: "http://new.test" },
			]);
		});

		test("a tombstone whose group was never observed this session is a ghost and stays off the hidden line", () => {
			// A tombstoned group deleted from the models file is never called for after a restart, so offering Unhide
			// would reference nothing. The panel's session-sticky observation set gates that; an observed identity
			// keeps its row even with no live snapshot in this push.
			const state = buildDashboardState({
				snapshots: [],
				reader: makeReader({}),
				removedGroups: {
					tombstones: [
						{ by: "group", groupId: "g-ghost", label: "Ghost", baseUrl: "http://ghost.test" },
						{ by: "group", groupId: "g-seen", label: "Seen", baseUrl: "http://seen.test" },
					],
					origins: [],
				},
				wasGroupObserved: (tombstone) => tombstone.label === "Seen",
			});

			assert.deepStrictEqual(state.hiddenGroups, [{ label: "Seen", baseUrl: "http://seen.test", reason: "removed" }]);
		});

		test("every external snapshot is tombstone-suppressible: the registry serving path is gone", () => {
			// Every status-window snapshot is group-backed by construction now, so a tombstone matching an external
			// row's identity always hides it.
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "g-legacy", label: "Legacy", baseUrl: "http://legacy.test" }),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
				],
				makeReader({}),
				[],
				{
					tombstones: [{ by: "group", groupId: "g-legacy", label: "Legacy", baseUrl: "http://legacy.test" }],
					origins: [],
				}
			);

			assert.strictEqual(state.servers.length, 0, "the tombstoned row leaves the table");
			assert.strictEqual(state.models.length, 0, "its models leave with it");
			assert.deepStrictEqual(state.hiddenGroups, [
				{ label: "Legacy", baseUrl: "http://legacy.test", reason: "removed" },
			]);
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
									defaultMaxTokens: 4096,
									serverDeclared: { kind: "discovered", values: {}, defaultMaxTokens: 4096 },
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

		test("group models are already raw, and defaultMaxTokens mirrors the litellm stamp", () => {
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
									defaultMaxTokens: 8000,
									serverDeclared: { kind: "discovered", values: {}, defaultMaxTokens: 8000 },
								},
							}),
						],
					},
				],
				makeReader({})
			);
			assert.deepStrictEqual(
				state.models.map((model) => [model.rawId, model.defaultMaxTokens]),
				[
					["gpt-4", 4096],
					["claude", 8000],
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
			// Two same-label groups at one URL: the responder resolves by the scope key's server ID, so only the
			// snapshot whose server ID resolves gets the entry's parameters - a label-keyed lookup would hand them to
			// both.
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
				tombstones: [{ by: "group", groupId: "g1", label: "Hidden", baseUrl: "http://hidden.test" }],
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
});
