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
		// match: the record-level lint is exactly what still reports it. The
		// capabilities record's unrecognized key surfaces only because a server
		// reported an observed set that does not name it (see the advisory
		// suite for the evidence rules).
		const diagnostics = buildConfigDiagnostics(
			makeInput({
				reader: makeReader({
					"models.parameters": { "never-served*": { temperature: 1, _inherit_from: ["missing-base"] } },
					"models.capabilities": { "gpt-4": { supports_levitation: true } },
				}),
				observedKeysUnion: ["supports_function_calling"],
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
				diagnostic: { kind: "unrecognized-key", recordKey: "gpt-4", key: "supports_levitation" },
				severity: "advisory",
			},
		]);
	});

	suite("advisory unrecognized-key hints", () => {
		const capabilitiesWith = (field: string) => makeReader({ "models.capabilities": { "gpt-4": { [field]: true } } });

		test("with no observed set anywhere, every hint drops: no false hints on declared-only or fallback discovery", () => {
			// The load-bearing silence: declared-only entries, expectedFailures:
			// modelInfo, the /models fallback, and pre-discovery all leave no
			// observed set, and none of them may produce a typo hint.
			const diagnostics = buildConfigDiagnostics(makeInput({ reader: capabilitiesWith("supports_levitation") }));
			assert.deepStrictEqual(diagnostics, []);
		});

		test("a key the observed union names is real, never hinted", () => {
			const diagnostics = buildConfigDiagnostics(
				makeInput({
					reader: capabilitiesWith("supports_levitation"),
					observedKeysUnion: ["supports_levitation", "other"],
				})
			);
			assert.deepStrictEqual(diagnostics, []);
		});

		test("an unobserved key on a configuration WITH an observed set survives as an advisory, never a warning", () => {
			const diagnostics = buildConfigDiagnostics(
				makeInput({
					reader: capabilitiesWith("supports_levitation"),
					observedKeysUnion: ["supports_function_calling"],
				})
			);
			assert.deepStrictEqual(diagnostics, [
				{
					kind: "record",
					setting: "models.capabilities",
					diagnostic: { kind: "unrecognized-key", recordKey: "gpt-4", key: "supports_levitation" },
					severity: "advisory",
				},
			]);
		});

		test("an EMPTY observed set is no evidence: a zero-deployment listing must not flag every open field", () => {
			const diagnostics = buildConfigDiagnostics(
				makeInput({ reader: capabilitiesWith("supports_levitation"), observedKeysUnion: [] })
			);
			assert.deepStrictEqual(diagnostics, []);
		});

		test("mixed evidence: one server's union cannot silence a key only the evidence-less server knows (known residual)", () => {
			// One discovered server reported a set; a declared-only entry did not.
			// The global record's key hints against the union alone - the residual
			// the observedKeysUnion doc names, kept advisory for exactly this case.
			const diagnostics = buildConfigDiagnostics(
				makeInput({
					reader: capabilitiesWith("declared_backend_key"),
					observedKeysUnion: ["supports_function_calling"],
					observedKeysByEntry: new Map(),
				})
			);
			assert.strictEqual(diagnostics.length, 1);
			assert.strictEqual(diagnostics[0]?.kind === "record" ? diagnostics[0].severity : undefined, "advisory");
		});

		test("a consumed-vocabulary key is never hinted, whatever the observed set says", () => {
			// The parse never emits unrecognized-key for consumed fields; the
			// filter's own consumed check is the backstop against vocabulary
			// drift. Both must hold: a valid consumed value yields nothing.
			const diagnostics = buildConfigDiagnostics(
				makeInput({
					reader: makeReader({ "models.capabilities": { "gpt-4": { supports_prompt_caching: true } } }),
					observedKeysUnion: ["supports_function_calling"],
				})
			);
			assert.deepStrictEqual(diagnostics, []);
		});

		test("entry records filter against their OWN server's set; an entry without one stays silent", () => {
			const diagnostics = buildConfigDiagnostics(
				makeInput({
					declared: [
						{ label: "Prod", modelCapabilities: { "gpt-4": { mystery_flag: true } } },
						{ label: "Stage", modelCapabilities: { "gpt-4": { mystery_flag: true } } },
					],
					observedKeysByEntry: new Map([["Prod", ["supports_function_calling"]]]),
				})
			);
			assert.deepStrictEqual(diagnostics, [
				{
					kind: "record",
					setting: "models.capabilities",
					entryLabel: "Prod",
					diagnostic: { kind: "unrecognized-key", recordKey: "gpt-4", key: "mystery_flag" },
					severity: "advisory",
				},
			]);
		});

		test("prototype-named keys go through the Set, not raw object reads", () => {
			// "toString" is a legal open capability field and a legal observed
			// key; a raw object-key membership test would misread both.
			const hinted = buildConfigDiagnostics(
				makeInput({ reader: capabilitiesWith("toString"), observedKeysUnion: ["supports_function_calling"] })
			);
			assert.strictEqual(hinted.length, 1);
			assert.strictEqual(hinted[0]?.kind === "record" ? hinted[0].severity : undefined, "advisory");

			const observed = buildConfigDiagnostics(
				makeInput({ reader: capabilitiesWith("toString"), observedKeysUnion: ["toString"] })
			);
			assert.deepStrictEqual(observed, []);
		});

		test("other diagnostic kinds keep warning severity and ignore the observed sets entirely", () => {
			const diagnostics = buildConfigDiagnostics(
				makeInput({
					reader: makeReader({ "models.capabilities": { "gpt-4": { context_length: "big" } } }),
					observedKeysUnion: ["context_length"],
				})
			);
			assert.deepStrictEqual(diagnostics, [
				{
					kind: "record",
					setting: "models.capabilities",
					diagnostic: { kind: "invalid-value", recordKey: "gpt-4", key: "context_length" },
				},
			]);
		});
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
