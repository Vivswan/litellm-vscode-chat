import * as assert from "node:assert";
import type { ConfigDiagnosticsInput } from "../../../extension/dashboard/configDiagnostics";
import { buildConfigDiagnostics } from "../../../extension/dashboard/configDiagnostics";
import type { SettingsReader } from "../../../extension/dashboard/state";

function makeReader(values: Record<string, unknown>): SettingsReader {
	return {
		get: (key) => values[key],
		inspect: (key) => (Object.hasOwn(values, key) ? { globalValue: values[key] } : undefined),
	};
}

function makeInput(overrides: Partial<ConfigDiagnosticsInput> = {}): ConfigDiagnosticsInput {
	return {
		reader: makeReader({}),
		parkedGlobalHeadersValue: undefined,
		hasExternalGroups: false,
		entryReports: [],
		declared: [],
		hiddenGroups: [],
		...overrides,
	};
}

suite("extension/dashboard/configDiagnostics", () => {
	test("a clean configuration yields no diagnostics", () => {
		assert.deepStrictEqual(buildConfigDiagnostics(makeInput()), []);
	});

	test("global record lints attribute to their setting id with no entry label, records no model matches included", () => {
		// The unknown _inherit_from key sits on a record no live model needs to
		// match: the record-level lint is exactly what still reports it.
		const diagnostics = buildConfigDiagnostics(
			makeInput({
				reader: makeReader({
					"models.parameters": { "never-served*": { temperature: 1, _inherit_from: ["missing-base"] } },
					"models.capabilities": { "gpt-4": { supports_levitation: true } },
				}),
			})
		);

		assert.deepStrictEqual(diagnostics, [
			{
				kind: "record",
				setting: "models.parameters",
				diagnostic: { kind: "unknown-inherit-key", recordKey: "never-served*", key: "missing-base" },
			},
			{
				kind: "record",
				setting: "models.capabilities",
				diagnostic: { kind: "unknown-key", recordKey: "gpt-4", key: "supports_levitation" },
			},
		]);
	});

	test("entry-layer record lints carry the owning entry's label", () => {
		const diagnostics = buildConfigDiagnostics(
			makeInput({
				declared: [{ label: "Prod", modelParameters: { "a*b": { temperature: 1 } } }, { label: "Bare" }],
			})
		);

		assert.deepStrictEqual(diagnostics, [
			{
				kind: "record",
				setting: "models.parameters",
				entryLabel: "Prod",
				diagnostic: { kind: "invalid-matcher", recordKey: "a*b", key: "a*b" },
			},
		]);
	});

	test("entry reports surface only when they carry problems, misconfigured exactly when the entry was skipped whole", () => {
		const diagnostics = buildConfigDiagnostics(
			makeInput({
				entryReports: [
					{ index: 0, label: "Fine", baseUrl: "http://a.test", problems: [], accepted: true },
					{ index: 1, label: "Partial", baseUrl: "http://b.test", problems: ["ignored piece"], accepted: true },
					{ index: 2, baseUrl: "http://c.test", problems: ["no usable label"], accepted: false },
				],
			})
		);

		assert.deepStrictEqual(diagnostics, [
			{ kind: "entry", label: "Partial", position: 2, problems: ["ignored piece"], misconfigured: false },
			{ kind: "entry", position: 3, problems: ["no usable label"], misconfigured: true },
		]);
	});

	suite("legacy hints", () => {
		test("URL-scoped record keys and a leftover global headers value hint with their setting ids", () => {
			const diagnostics = buildConfigDiagnostics(
				makeInput({
					reader: makeReader({
						"models.parameters": { "http://old.test/gpt": { temperature: 1 } },
						headers: { "x-team": "a" },
					}),
				})
			);

			assert.deepStrictEqual(diagnostics, [
				{
					kind: "legacy",
					hint: "inert-url-scoped-key",
					oldKey: "http://old.test/gpt",
					detail: "models.parameters",
				},
				{ kind: "legacy", hint: "inert-global-headers", oldKey: "headers", detail: "headers" },
			]);
		});

		test("the parked-headers hint renders only while externally managed groups exist (R3 ruling)", () => {
			const parked = { headers: { "x-b": "2", "x-a": "1" }, migratedAt: 1 };

			const withoutGroups = buildConfigDiagnostics(
				makeInput({ parkedGlobalHeadersValue: parked, hasExternalGroups: false })
			);
			assert.deepStrictEqual(withoutGroups, [], "no external group means nobody misses the parked headers");

			const withGroups = buildConfigDiagnostics(
				makeInput({ parkedGlobalHeadersValue: parked, hasExternalGroups: true })
			);
			assert.deepStrictEqual(withGroups, [
				{ kind: "legacy", hint: "parked-global-headers", oldKey: "headers", detail: "x-a, x-b" },
			]);
		});
	});

	test("dropped usage.alertThresholds values count as one diagnostic; a fully valid list stays silent", () => {
		const dropped = buildConfigDiagnostics(
			makeInput({ reader: makeReader({ "usage.alertThresholds": [0.8, 0, 2, "0.9"] }) })
		);
		assert.deepStrictEqual(dropped, [{ kind: "thresholds", dropped: 3 }]);

		const clean = buildConfigDiagnostics(makeInput({ reader: makeReader({ "usage.alertThresholds": [0.8, 0.95] }) }));
		assert.deepStrictEqual(clean, []);

		const notAnArray = buildConfigDiagnostics(makeInput({ reader: makeReader({ "usage.alertThresholds": "0.8" }) }));
		assert.deepStrictEqual(notAnArray, [], "a non-array falls back to the default without a drop report");
	});

	test("hidden groups surface as one diagnostic carrying their labels; none stays silent", () => {
		// The Diagnostics tab must not be silent about groups an explicit removal
		// hid: a hidden-only setup otherwise reads as healthy with zero models
		// and no visible cause.
		const diagnostics = buildConfigDiagnostics(
			makeInput({
				hiddenGroups: [
					{ label: "Prod", baseUrl: "http://prod.test" },
					{ label: "Staging", baseUrl: "http://staging.test" },
				],
			})
		);
		assert.deepStrictEqual(diagnostics, [{ kind: "hidden-groups", labels: ["Prod", "Staging"] }]);

		assert.deepStrictEqual(buildConfigDiagnostics(makeInput({ hiddenGroups: [] })), []);
	});
});
