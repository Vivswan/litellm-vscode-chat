import * as assert from "node:assert";
import type { DeclaredServerNotice } from "../../../dashboard/viewModels";
import type { SettingsReader } from "../../../extension/dashboard/state";
import { buildDashboardState } from "../../../extension/dashboard/state";
import type { DeclaredServerView, ServerEntryReport } from "../../../extension/servers/serverSync";
import { makeServerStatus } from "../../testUtils";

const MISCONFIGURED_TEXT = "misconfigured entry; not used until its configuration is fixed";

const READER: SettingsReader = { get: () => undefined, inspect: () => undefined };

function makeDeclared(overrides: Partial<DeclaredServerView> = {}): DeclaredServerView {
	return {
		label: "Prod",
		baseUrl: "http://prod.test",
		secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
		...overrides,
	};
}

function rejectedReport(overrides: Partial<ServerEntryReport> = {}): ServerEntryReport {
	return {
		index: 0,
		label: "Broken",
		baseUrl: "http://broken.test",
		problems: ["auth must pick one form"],
		accepted: false,
		...overrides,
	};
}

suite("extension/dashboard/state misconfigured rows", () => {
	test("a rejected entry with a usable, non-duplicate identity renders as a misconfigured error row", () => {
		const state = buildDashboardState({ snapshots: [], reader: READER, entryReports: [rejectedReport()] });

		assert.strictEqual(state.servers.length, 1);
		const row = state.servers[0];
		assert.ok(row?.origin === "misconfigured");
		assert.strictEqual(row.label, "Broken");
		assert.strictEqual(row.baseUrl, "http://broken.test");
		assert.strictEqual(row.state, "error");
		assert.strictEqual(row.servedModelCount, 0);
		assert.deepStrictEqual(row.problems, ["auth must pick one form"]);
		// English by the issue-report policy, on both the display and the mirror.
		assert.strictEqual(row.error, MISCONFIGURED_TEXT);
		assert.strictEqual(row.errorEnglish, MISCONFIGURED_TEXT);
		assert.strictEqual(row.config, undefined, "the broken shape cannot round-trip through the edit form");
	});

	test("rejects without a usable identity draw no row: no label, no URL, or a label a declared entry owns", () => {
		const state = buildDashboardState({
			snapshots: [],
			reader: READER,
			declared: { source: "engine", views: [makeDeclared({ label: "Taken" })] },
			entryReports: [
				rejectedReport({ index: 0, label: undefined }),
				rejectedReport({ index: 1, baseUrl: undefined }),
				// A reject whose label an ACCEPTED entry already renders under: a
				// second "Taken" row would read as two entries where one serves.
				rejectedReport({ index: 2, label: "Taken" }),
			],
		});

		assert.deepStrictEqual(
			state.servers.map((server) => [server.label, server.origin]),
			[["Taken", "declared"]]
		);
	});

	test("accepted entries never render misconfigured rows, problems or not", () => {
		const state = buildDashboardState({
			snapshots: [],
			reader: READER,
			declared: { source: "engine", views: [makeDeclared({ label: "Partial", baseUrl: "http://partial.test" })] },
			entryReports: [
				{
					index: 0,
					label: "Partial",
					baseUrl: "http://partial.test",
					problems: ["ignored piece"],
					accepted: true,
				},
			],
		});

		assert.deepStrictEqual(
			state.servers.map((server) => server.origin),
			["declared"]
		);
	});

	test("misconfigured rows sort into the table with everything else", () => {
		const state = buildDashboardState({
			snapshots: [],
			reader: READER,
			declared: { source: "engine", views: [makeDeclared({ label: "Zeta", baseUrl: "http://z.test" })] },
			entryReports: [rejectedReport({ label: "Alpha", baseUrl: "http://a.test" })],
		});

		assert.deepStrictEqual(
			state.servers.map((server) => server.label),
			["Alpha", "Zeta"]
		);
	});

	test("a non-identity join raises one inactive notice per configured entry-only field family", () => {
		// The serving group joined by URL only, so the request path's
		// label-and-URL resolution applies none of this entry's entry-only
		// fields; the row must name exactly which families went inactive.
		// state.ts derives the notices from parallel same-shape branches, one
		// per family, so one table drives them all.
		const cases: readonly {
			override: Partial<DeclaredServerView>;
			notices: readonly DeclaredServerNotice[];
			reason: string;
		}[] = [
			{
				override: { headers: { "x-team": "a" } },
				notices: ["entry-headers-inactive"],
				reason: "custom headers are resolved by label and URL",
			},
			{
				override: { apiVersion: "v2" },
				notices: ["entry-api-version-inactive"],
				reason: "the api version silently falls back to the auto rule",
			},
			{
				override: { apiVersion: "" },
				notices: ["entry-api-version-inactive"],
				reason: '"" is a real override (append nothing), not an absent field',
			},
			{
				override: { modelParameters: { "gpt-4": { temperature: 0.2 } } },
				notices: ["entry-params-inactive"],
				reason: "entry parameters are resolved by label and URL",
			},
			{
				override: { modelCapabilities: { "gpt-4": { supports_vision: true } } },
				notices: ["entry-capabilities-inactive"],
				reason: "entry capability records ride the capabilities family",
			},
			{
				override: { expectedFailures: ["modelInfo"] },
				notices: ["entry-capabilities-inactive"],
				reason: "expected failures ride the capabilities family",
			},
			{
				override: { declaredModels: ["gpt-4"] },
				notices: ["entry-capabilities-inactive"],
				reason: "declared models ride the capabilities family",
			},
			{
				override: {
					modelParameters: { "gpt-4": { temperature: 0.2 } },
					modelCapabilities: { "gpt-4": { supports_vision: true } },
				},
				notices: ["entry-params-inactive", "entry-capabilities-inactive"],
				reason: "parameters and capabilities get separate classifications, in declaration order",
			},
		];
		for (const { override, notices, reason } of cases) {
			const state = buildDashboardState({
				snapshots: [
					{
						status: makeServerStatus({
							serverId: "group:fp-other:http://x.test",
							label: "x.test",
							baseUrl: "http://x.test",
						}),
						models: [],
					},
				],
				reader: READER,
				declared: {
					source: "engine",
					views: [
						makeDeclared({
							label: "Prod",
							baseUrl: "http://x.test",
							expectedClientId: "group:fp-labeled:http://x.test",
							...override,
						}),
					],
				},
			});

			assert.deepStrictEqual(state.servers[0]?.notices, notices, `${JSON.stringify(override)}: ${reason}`);
		}
	});

	test("an identity join keeps every entry-only field active: no notices", () => {
		const state = buildDashboardState({
			snapshots: [
				{
					status: makeServerStatus({
						serverId: "group:fp-labeled:http://x.test",
						label: "Prod",
						baseUrl: "http://x.test",
					}),
					models: [],
				},
			],
			reader: READER,
			declared: {
				source: "engine",
				views: [
					makeDeclared({
						label: "Prod",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-labeled:http://x.test",
						headers: { "x-team": "a" },
						modelParameters: { "gpt-4": { temperature: 0.2 } },
					}),
				],
			},
		});

		assert.strictEqual(state.servers[0]?.notices, undefined);
	});
});
