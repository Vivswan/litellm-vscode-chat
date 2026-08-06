import * as assert from "node:assert";
import type {
	CapabilityCatalogLookup,
	CapabilityConfigLayer,
	CapabilityDiagnostic,
	CapabilityDiagnosticKind,
	CapabilityFieldValues,
	CapabilityRecordDiagnostic,
	CatalogLookupResult,
	CatalogPricing,
	DeclaredModelSpec,
	DirectiveOutcome,
	EffectiveCapabilities,
	EffectiveCapabilityField,
	ExtractedDeclaredModels,
	ModelCapabilitiesRecord,
	ParsedCapabilityRecord,
	ResolvedCapabilityOverrides,
	ResolveModelCapabilitiesInput,
	ShadowedCapabilityValue,
} from "../../../shared/config/capabilityResolution";
import {
	CAPABILITY_FIELDS,
	CAPABILITY_FLOOR,
	DECLARE_DIRECTIVE,
	EMPTY_CATALOG_LOOKUP,
	extractDeclaredModels,
	OPENROUTER_MODEL_DIRECTIVE,
	parseCapabilityRecord,
	resolveCapabilityOverrides,
	resolveModelCapabilities,
} from "../../../shared/config/capabilityResolution";
import { resolveMaxTokens } from "../../../shared/config/parameterResolution";

/** A catalog over literal entries: exact IDs and unambiguous post-vendor suffixes answer found. */
function makeCatalog(entries: Record<string, Partial<CapabilityFieldValues>>): CapabilityCatalogLookup {
	const byExactId = (id: string): CatalogLookupResult => {
		const fields = entries[id];
		return fields !== undefined ? { kind: "found", id, fields } : { kind: "not-found" };
	};
	return {
		byExactId,
		byRawModelId: (rawId: string): CatalogLookupResult => {
			const exact = byExactId(rawId);
			if (exact.kind === "found") {
				return exact;
			}
			const suffixIds = Object.keys(entries).filter((id) => id.split("/").slice(1).join("/") === rawId);
			if (suffixIds.length === 1 && suffixIds[0] !== undefined) {
				return byExactId(suffixIds[0]);
			}
			return suffixIds.length > 1 ? { kind: "ambiguous" } : { kind: "not-found" };
		},
	};
}

const UNCONFIGURED_DEFAULTS = {
	contextLength: { value: CAPABILITY_FLOOR.context_length, explicitlyConfigured: false },
	maxOutputTokens: { value: CAPABILITY_FLOOR.max_output_tokens, explicitlyConfigured: false },
	maxInputTokens: undefined,
} as const;

function resolve(partial: Partial<ResolveModelCapabilitiesInput>): EffectiveCapabilities {
	return resolveModelCapabilities({
		rawModelId: "gpt-4",
		globalCapabilities: {},
		serverScopes: [],
		catalog: EMPTY_CATALOG_LOOKUP,
		serverDeclared: { kind: "discovered", values: {}, outputDeclared: false },
		tokenDefaults: UNCONFIGURED_DEFAULTS,
		...partial,
	});
}

suite("shared/config capabilityResolution parseCapabilityRecord", () => {
	test("accepts the whole vocabulary with valid values and no diagnostics", () => {
		const parsed: ParsedCapabilityRecord = parseCapabilityRecord(
			{
				context_length: 200000,
				max_input_tokens: 150000,
				max_output_tokens: 32000,
				supports_function_calling: true,
				supports_vision: true,
				supports_reasoning: false,
				supports_audio_input: false,
			},
			{ allowDeclare: true }
		);
		assert.deepStrictEqual(parsed.fields, {
			context_length: 200000,
			max_input_tokens: 150000,
			max_output_tokens: 32000,
			supports_function_calling: true,
			supports_vision: true,
			supports_reasoning: false,
			supports_audio_input: false,
		});
		assert.strictEqual(parsed.declare, false);
		assert.strictEqual(parsed.openrouterModel, undefined);
		assert.deepStrictEqual(parsed.diagnostics, []);
	});

	test("diagnoses unknown non-underscore keys and keeps the valid fields around them", () => {
		const parsed = parseCapabilityRecord(
			{ supports_pdf_input: true, constructor: 1, context_length: 100000 },
			{ allowDeclare: true }
		);
		assert.deepStrictEqual(parsed.fields, { context_length: 100000 });
		assert.deepStrictEqual(parsed.diagnostics, [
			{ kind: "unknown-key", key: "supports_pdf_input" },
			{ kind: "unknown-key", key: "constructor" },
		] satisfies CapabilityRecordDiagnostic[]);
	});

	test("number fields accept positive integers only", () => {
		for (const value of ["128k", "128000", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, true, null, {}]) {
			const parsed = parseCapabilityRecord({ context_length: value }, { allowDeclare: true });
			assert.deepStrictEqual(parsed.fields, {}, `value ${String(value)} must not parse`);
			assert.deepStrictEqual(parsed.diagnostics, [{ kind: "invalid-value", key: "context_length" }]);
		}
	});

	test("boolean fields accept booleans only", () => {
		for (const value of [1, 0, "true", null, {}]) {
			const parsed = parseCapabilityRecord({ supports_vision: value }, { allowDeclare: true });
			assert.deepStrictEqual(parsed.fields, {}, `value ${String(value)} must not parse`);
			assert.deepStrictEqual(parsed.diagnostics, [{ kind: "invalid-value", key: "supports_vision" }]);
		}
	});

	test("_declare parses booleans, diagnoses other values, and needs a declarable key", () => {
		assert.strictEqual(parseCapabilityRecord({ [DECLARE_DIRECTIVE]: true }, { allowDeclare: true }).declare, true);
		assert.strictEqual(parseCapabilityRecord({ [DECLARE_DIRECTIVE]: false }, { allowDeclare: true }).declare, false);

		const invalid = parseCapabilityRecord({ [DECLARE_DIRECTIVE]: "yes" }, { allowDeclare: true });
		assert.strictEqual(invalid.declare, false);
		assert.deepStrictEqual(invalid.diagnostics, [{ kind: "invalid-directive", key: DECLARE_DIRECTIVE }]);

		const unscoped = parseCapabilityRecord({ [DECLARE_DIRECTIVE]: true }, { allowDeclare: false });
		assert.strictEqual(unscoped.declare, false);
		assert.deepStrictEqual(unscoped.diagnostics, [{ kind: "unscoped-declare", key: DECLARE_DIRECTIVE }]);

		const unscopedFalse = parseCapabilityRecord({ [DECLARE_DIRECTIVE]: false }, { allowDeclare: false });
		assert.deepStrictEqual(unscopedFalse.diagnostics, [], "_declare: false is inert everywhere");
	});

	test("_openrouter_model needs a non-blank string", () => {
		const valid = parseCapabilityRecord({ [OPENROUTER_MODEL_DIRECTIVE]: "vendorx/alpha" }, { allowDeclare: true });
		assert.strictEqual(valid.openrouterModel, "vendorx/alpha");
		for (const value of ["", "   ", 42, true, null]) {
			const parsed = parseCapabilityRecord({ [OPENROUTER_MODEL_DIRECTIVE]: value }, { allowDeclare: true });
			assert.strictEqual(parsed.openrouterModel, undefined, `value ${String(value)} must not parse`);
			assert.deepStrictEqual(parsed.diagnostics, [{ kind: "invalid-directive", key: OPENROUTER_MODEL_DIRECTIVE }]);
		}
	});

	test("unknown underscore keys are reserved and ignored silently, own __proto__ included", () => {
		const record = JSON.parse('{"_future": 1, "__proto__": {"polluted": true}, "supports_vision": true}') as Record<
			string,
			unknown
		>;
		const parsed = parseCapabilityRecord(record, { allowDeclare: true });
		assert.deepStrictEqual(parsed.fields, { supports_vision: true });
		assert.deepStrictEqual(parsed.diagnostics, []);
		assert.ok(!("polluted" in parsed.fields), "nothing of the underscore value survives the boundary");
	});
});

/** Shorthand for an expected attributed diagnostic; the parameter types double as the shape pin. */
function diagnostic(
	kind: CapabilityDiagnosticKind,
	key: string,
	layer: CapabilityConfigLayer,
	recordKey: string
): CapabilityDiagnostic {
	return { kind, key, layer, recordKey };
}

suite("shared/config capabilityResolution extractDeclaredModels", () => {
	test("entry keys declare verbatim; scoped global keys declare their post-scope remainder", () => {
		const extracted: ExtractedDeclaredModels = extractDeclaredModels({
			globalCapabilities: { "http://a.test/from-global": { _declare: true } },
			serverScopes: ["http://a.test"],
			entryCapabilities: { "from-entry": { _declare: true }, "no-declare": { context_length: 1000 } },
		});
		assert.deepStrictEqual(extracted.models, [
			{ rawId: "from-entry", layer: "entry", recordKey: "from-entry" },
			{ rawId: "from-global", layer: "global", recordKey: "http://a.test/from-global" },
		] satisfies DeclaredModelSpec[]);
		assert.deepStrictEqual(extracted.diagnostics, []);
	});

	test("an unscoped global _declare never creates a model and is diagnosed", () => {
		const extracted = extractDeclaredModels({
			globalCapabilities: { "gpt-4": { _declare: true } },
			serverScopes: ["http://a.test"],
		});
		assert.deepStrictEqual(extracted.models, []);
		assert.deepStrictEqual(extracted.diagnostics, [
			diagnostic("unscoped-declare", DECLARE_DIRECTIVE, "global", "gpt-4"),
		]);
	});

	test("keys scoped to another server are skipped without diagnostics", () => {
		const extracted = extractDeclaredModels({
			globalCapabilities: { "http://other.test/gpt-4": { _declare: true } },
			serverScopes: ["http://a.test"],
		});
		assert.deepStrictEqual(extracted.models, []);
		assert.deepStrictEqual(extracted.diagnostics, []);
	});

	test("a scoped key with an empty remainder cannot declare", () => {
		const extracted = extractDeclaredModels({
			globalCapabilities: { "http://a.test/": { _declare: true } },
			serverScopes: ["http://a.test"],
		});
		assert.deepStrictEqual(extracted.models, []);
		assert.deepStrictEqual(extracted.diagnostics, [
			diagnostic("unscoped-declare", DECLARE_DIRECTIVE, "global", "http://a.test/"),
		]);
	});

	test('the catch-all "*" cannot declare, in the entry and scoped-global layers alike', () => {
		const viaEntry = extractDeclaredModels({
			globalCapabilities: {},
			serverScopes: [],
			entryCapabilities: { "*": { _declare: true } },
		});
		assert.deepStrictEqual(viaEntry.models, []);
		assert.deepStrictEqual(viaEntry.diagnostics, [diagnostic("unscoped-declare", DECLARE_DIRECTIVE, "entry", "*")]);

		const viaScoped = extractDeclaredModels({
			globalCapabilities: { "http://a.test/*": { _declare: true } },
			serverScopes: ["http://a.test"],
		});
		assert.deepStrictEqual(viaScoped.models, []);
		assert.deepStrictEqual(viaScoped.diagnostics, [
			diagnostic("unscoped-declare", DECLARE_DIRECTIVE, "global", "http://a.test/*"),
		]);
	});

	test("the same ID declared in both layers dedupes entry-over-global; two scopes dedupe first-wins", () => {
		const extracted = extractDeclaredModels({
			globalCapabilities: {
				"http://a.test/shared-id": { _declare: true },
				"http://b.test/shared-id": { _declare: true },
			},
			serverScopes: ["http://a.test", "http://b.test"],
			entryCapabilities: { "shared-id": { _declare: true } },
		});
		assert.deepStrictEqual(extracted.models, [{ rawId: "shared-id", layer: "entry", recordKey: "shared-id" }]);
	});

	test("only _declare problems surface; field problems stay with resolution", () => {
		const extracted = extractDeclaredModels({
			globalCapabilities: {},
			serverScopes: [],
			entryCapabilities: { "gpt-4": { _declare: "yes", context_length: "128k", unknown_field: 1 } },
		});
		assert.deepStrictEqual(extracted.models, []);
		assert.deepStrictEqual(extracted.diagnostics, [
			diagnostic("invalid-directive", DECLARE_DIRECTIVE, "entry", "gpt-4"),
		]);
	});
});

suite("shared/config capabilityResolution resolveCapabilityOverrides", () => {
	test("entry fields override the global winner key by key, with shadowed attribution", () => {
		const globalCapabilities: ModelCapabilitiesRecord = {
			"gpt-4": { context_length: 100000, supports_vision: false },
		};
		const resolved: ResolvedCapabilityOverrides = resolveCapabilityOverrides({
			rawModelId: "gpt-4-turbo",
			globalCapabilities,
			serverScopes: [],
			entryCapabilities: { "gpt-4": { context_length: 200000 } },
			catalog: EMPTY_CATALOG_LOOKUP,
		});
		assert.deepStrictEqual(resolved.fields.context_length, {
			value: 200000,
			level: "entry",
			key: "gpt-4",
			shadowed: [{ level: "global", key: "gpt-4", value: 100000 }],
		});
		assert.deepStrictEqual(resolved.fields.supports_vision, {
			value: false,
			level: "global",
			key: "gpt-4",
			shadowed: [],
		});
		assert.strictEqual(resolved.fields.max_output_tokens, undefined);
	});

	test("a scoped global match replaces the whole unscoped record, non-colliding fields included", () => {
		const resolved = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: {
				"gpt-4": { context_length: 100000, supports_vision: true },
				"http://litellm.test/gpt-4": { context_length: 50000 },
			},
			serverScopes: ["http://litellm.test"],
			catalog: EMPTY_CATALOG_LOOKUP,
		});
		assert.deepStrictEqual(resolved.fields.context_length, {
			value: 50000,
			level: "global",
			key: "http://litellm.test/gpt-4",
			shadowed: [],
		});
		assert.strictEqual(resolved.fields.supports_vision, undefined, "the replaced record's fields must not survive");
		assert.deepStrictEqual(
			resolved.replacedUnscoped,
			{ key: "gpt-4", record: { context_length: 100000, supports_vision: true } },
			"the inspector needs the whole replaced record, not just the colliding keys"
		);
	});

	test("an invalid entry value falls through to the valid global value, with a diagnostic", () => {
		const resolved = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: { "gpt-4": { context_length: 100000 } },
			serverScopes: [],
			entryCapabilities: { "gpt-4": { context_length: "128k" } },
			catalog: EMPTY_CATALOG_LOOKUP,
		});
		assert.deepStrictEqual(resolved.fields.context_length, {
			value: 100000,
			level: "global",
			key: "gpt-4",
			shadowed: [],
		});
		assert.deepStrictEqual(resolved.diagnostics, [diagnostic("invalid-value", "context_length", "entry", "gpt-4")]);
	});

	test("directive-derived fields fill only what no explicit field set, and explicit winners shadow them", () => {
		const catalog = makeCatalog({ "vendorx/alpha": { context_length: 200000, supports_vision: true } });
		const resolved = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: { "gpt-4": { _openrouter_model: "vendorx/alpha", context_length: 100000 } },
			serverScopes: [],
			catalog,
		});
		assert.deepStrictEqual(resolved.directive, { kind: "applied", id: "vendorx/alpha" } satisfies DirectiveOutcome);
		assert.deepStrictEqual(resolved.fields.supports_vision, {
			value: true,
			level: "directive",
			key: "vendorx/alpha",
			shadowed: [],
		});
		assert.deepStrictEqual(resolved.fields.context_length, {
			value: 100000,
			level: "global",
			key: "gpt-4",
			shadowed: [{ level: "directive", key: "vendorx/alpha", value: 200000 }],
		});
	});

	test("the entry directive beats the global directive; an unknown ID reports not-found and derives nothing", () => {
		const catalog = makeCatalog({ "vendorx/alpha": { supports_vision: true } });
		const resolved = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: { "gpt-4": { _openrouter_model: "vendorx/alpha" } },
			serverScopes: [],
			entryCapabilities: { "gpt-4": { _openrouter_model: "vendorx/missing" } },
			catalog,
		});
		assert.deepStrictEqual(resolved.directive, { kind: "not-found", id: "vendorx/missing" });
		assert.strictEqual(resolved.fields.supports_vision, undefined);
	});

	test("declare answers only for the exact literal key, in the entry and scoped-global layers", () => {
		const catalog = EMPTY_CATALOG_LOOKUP;
		const viaEntry = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: {},
			serverScopes: [],
			entryCapabilities: { "gpt-4": { _declare: true } },
			catalog,
		});
		assert.strictEqual(viaEntry.declare, true);

		const viaPrefix = resolveCapabilityOverrides({
			rawModelId: "gpt-4-turbo",
			globalCapabilities: {},
			serverScopes: [],
			entryCapabilities: { "gpt-4": { _declare: true } },
			catalog,
		});
		assert.strictEqual(viaPrefix.declare, false, "prefix matching never declares");
		assert.deepStrictEqual(viaPrefix.diagnostics, []);

		const viaScoped = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: { "http://a.test/gpt-4": { _declare: true } },
			serverScopes: ["http://a.test"],
			catalog,
		});
		assert.strictEqual(viaScoped.declare, true);

		const viaUnscoped = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: { "gpt-4": { _declare: true } },
			serverScopes: [],
			catalog,
		});
		assert.strictEqual(viaUnscoped.declare, false);
		assert.deepStrictEqual(viaUnscoped.diagnostics, [], "_declare problems belong to extraction, not resolution");
	});

	test("_declare problems never ride resolution's diagnostics; field problems in the same record do", () => {
		const resolved = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: { "gpt-4": { _declare: "yes", context_length: "128k" } },
			serverScopes: [],
			catalog: EMPTY_CATALOG_LOOKUP,
		});
		assert.deepStrictEqual(resolved.diagnostics, [diagnostic("invalid-value", "context_length", "global", "gpt-4")]);
	});

	test("the applied directive carries the catalog entry's pricing for the consumers' precedence rule", () => {
		const pricing: CatalogPricing = { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 };
		const catalog: CapabilityCatalogLookup = {
			byExactId: (id) => (id === "vendorx/alpha" ? { kind: "found", id, fields: {}, pricing } : { kind: "not-found" }),
			byRawModelId: () => ({ kind: "not-found" }),
		};
		const resolved = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: { "gpt-4": { _openrouter_model: "vendorx/alpha" } },
			serverScopes: [],
			catalog,
		});
		assert.deepStrictEqual(resolved.directive, { kind: "applied", id: "vendorx/alpha", pricing });
	});

	test("declare agrees with extraction even when the declaring record loses the capability merge", () => {
		// Two scopes tie at exact specificity; the earlier scope wins the merge
		// but the later one's _declare must still count - declaration is
		// extraction's rule, not the winner's.
		const input = {
			rawModelId: "gpt-4",
			globalCapabilities: {
				"http://a.test/gpt-4": { context_length: 100000 },
				"http://b.test/gpt-4": { _declare: true },
			},
			serverScopes: ["http://a.test", "http://b.test"],
			catalog: EMPTY_CATALOG_LOOKUP,
		};
		const resolved = resolveCapabilityOverrides(input);
		assert.strictEqual(resolved.fields.context_length?.key, "http://a.test/gpt-4");
		assert.strictEqual(resolved.declare, true);
	});

	test("the implicit catalog candidate rides along for the walk's catalog level", () => {
		const catalog = makeCatalog({ "vendorx/gpt-4": { context_length: 131072 } });
		const resolved = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: {},
			serverScopes: [],
			catalog,
		});
		assert.deepStrictEqual(resolved.implicitCatalog, {
			kind: "found",
			id: "vendorx/gpt-4",
			fields: { context_length: 131072 },
		});
	});
});

suite("shared/config capabilityResolution resolveModelCapabilities", () => {
	test("every level of the context_length walk lines up, top wins, the rest shadow in order", () => {
		const catalog = makeCatalog({
			"vendorx/alpha": { context_length: 30000 },
			"vendorx/gpt-4": { context_length: 40000 },
		});
		const effective = resolve({
			globalCapabilities: { "gpt-4": { context_length: 20000, _openrouter_model: "vendorx/alpha" } },
			entryCapabilities: { "gpt-4": { context_length: 10000 } },
			catalog,
			serverDeclared: { kind: "discovered", values: { context_length: 50000 }, outputDeclared: false },
			tokenDefaults: { ...UNCONFIGURED_DEFAULTS, contextLength: { value: 60000, explicitlyConfigured: true } },
		});
		assert.deepStrictEqual(effective.fields.context_length, {
			value: 10000,
			level: "entry",
			key: "gpt-4",
			shadowed: [
				{ level: "global", key: "gpt-4", value: 20000 },
				{ level: "directive", key: "vendorx/alpha", value: 30000 },
				{ level: "server", value: 50000 },
				{ level: "default-setting", value: 60000 },
				{ level: "catalog", key: "vendorx/gpt-4", value: 40000 },
			] satisfies ShadowedCapabilityValue[],
		} satisfies EffectiveCapabilityField<number>);
	});

	test("peeling the top levels away hands the walk down: server, then default-setting, then catalog, then floor", () => {
		const catalog = makeCatalog({ "vendorx/gpt-4": { context_length: 40000 } });
		const withServer = resolve({
			catalog,
			serverDeclared: { kind: "discovered", values: { context_length: 50000 }, outputDeclared: false },
			tokenDefaults: { ...UNCONFIGURED_DEFAULTS, contextLength: { value: 60000, explicitlyConfigured: true } },
		});
		assert.strictEqual(withServer.fields.context_length.value, 50000);
		assert.strictEqual(withServer.fields.context_length.level, "server");

		const withDefault = resolve({
			catalog,
			tokenDefaults: { ...UNCONFIGURED_DEFAULTS, contextLength: { value: 60000, explicitlyConfigured: true } },
		});
		assert.strictEqual(withDefault.fields.context_length.value, 60000);
		assert.strictEqual(withDefault.fields.context_length.level, "default-setting");

		const withCatalog = resolve({ catalog });
		assert.strictEqual(withCatalog.fields.context_length.value, 40000);
		assert.strictEqual(withCatalog.fields.context_length.level, "catalog");

		const floor = resolve({});
		assert.strictEqual(floor.fields.context_length.value, CAPABILITY_FLOOR.context_length);
		assert.strictEqual(floor.fields.context_length.level, "floor");
	});

	test("an untouched default* setting never joins the walk; only explicit configuration does", () => {
		const catalog = makeCatalog({ "vendorx/gpt-4": { context_length: 40000 } });
		const effective = resolve({ catalog });
		assert.strictEqual(effective.fields.context_length.level, "catalog", "the built-in default must not beat a match");
	});

	test("defaultMaxInputTokens keeps its quirk: above the server value, below the overrides", () => {
		const overServer = resolve({
			serverDeclared: { kind: "discovered", values: { max_input_tokens: 90000 }, outputDeclared: false },
			tokenDefaults: { ...UNCONFIGURED_DEFAULTS, maxInputTokens: 70000 },
		});
		assert.deepStrictEqual(overServer.fields.max_input_tokens, {
			value: 70000,
			level: "default-setting",
			shadowed: [{ level: "server", value: 90000 }],
		});

		const underEntry = resolve({
			entryCapabilities: { "gpt-4": { max_input_tokens: 80000 } },
			serverDeclared: { kind: "discovered", values: { max_input_tokens: 90000 }, outputDeclared: false },
			tokenDefaults: { ...UNCONFIGURED_DEFAULTS, maxInputTokens: 70000 },
		});
		assert.strictEqual(underEntry.fields.max_input_tokens.value, 80000);
		assert.strictEqual(underEntry.fields.max_input_tokens.level, "entry");
	});

	test("the empty input resolves totally: floors everywhere and a derived max input", () => {
		const effective = resolve({});
		for (const name of Object.keys(CAPABILITY_FIELDS) as (keyof typeof CAPABILITY_FIELDS)[]) {
			assert.notStrictEqual(effective.fields[name], undefined, `${name} must resolve`);
		}
		assert.strictEqual(effective.fields.supports_function_calling.value, true);
		assert.strictEqual(effective.fields.supports_vision.value, false);
		assert.strictEqual(effective.fields.supports_reasoning.value, false);
		assert.strictEqual(effective.fields.supports_audio_input.value, false);
		assert.deepStrictEqual(effective.fields.max_input_tokens, {
			value: CAPABILITY_FLOOR.context_length - CAPABILITY_FLOOR.max_output_tokens,
			level: "derived",
			shadowed: [],
		});
		assert.strictEqual(effective.outputLimitSource, "defaults");
		assert.strictEqual(effective.declare, false);
		assert.deepStrictEqual(effective.diagnostics, []);
	});

	test("the derivation reads the effective context and output, and never goes below 1", () => {
		const effective = resolve({ entryCapabilities: { "gpt-4": { context_length: 10000 } } });
		assert.deepStrictEqual(effective.fields.max_input_tokens, { value: 1, level: "derived", shadowed: [] });
	});

	test("output limit provenance: overrides are user, declared servers are provider, guesses stay defaults", () => {
		const user = resolve({ entryCapabilities: { "gpt-4": { max_output_tokens: 32000 } } });
		assert.strictEqual(user.outputLimitSource, "user");

		const viaGlobal = resolve({ globalCapabilities: { "gpt-4": { max_output_tokens: 32000 } } });
		assert.strictEqual(viaGlobal.outputLimitSource, "user", "a global override is user-set too");

		const viaDirective = resolve({
			globalCapabilities: { "gpt-4": { _openrouter_model: "vendorx/alpha" } },
			catalog: makeCatalog({ "vendorx/alpha": { max_output_tokens: 32000 } }),
		});
		assert.strictEqual(viaDirective.fields.max_output_tokens.level, "directive");
		assert.strictEqual(viaDirective.outputLimitSource, "user", "the directive is explicit user intent");

		const provider = resolve({
			serverDeclared: { kind: "discovered", values: { max_output_tokens: 32000 }, outputDeclared: true },
		});
		assert.strictEqual(provider.outputLimitSource, "provider");

		const undeclared = resolve({
			serverDeclared: { kind: "discovered", values: { max_output_tokens: 32000 }, outputDeclared: false },
		});
		assert.strictEqual(undeclared.fields.max_output_tokens.value, 32000, "the conservative server value still wins");
		assert.strictEqual(undeclared.outputLimitSource, "defaults");

		const catalog = resolve({ catalog: makeCatalog({ "vendorx/gpt-4": { max_output_tokens: 32000 } }) });
		assert.strictEqual(catalog.outputLimitSource, "defaults", "a catalog guess must keep the clamp");
	});

	test("a user-set output limit lifts the defaults clamp on the request path", () => {
		const effective = resolve({ entryCapabilities: { "gpt-4": { max_output_tokens: 32000 } } });
		const { value } = resolveMaxTokens({
			runtimeMaxTokens: undefined,
			configuredMaxTokens: undefined,
			maxOutputTokens: effective.fields.max_output_tokens.value,
			outputLimitDeclared: effective.outputLimitSource !== "defaults",
		});
		assert.strictEqual(value, 32000);
	});

	test("a declared model has no server level at all", () => {
		const effective = resolve({
			serverDeclared: { kind: "declared" },
			entryCapabilities: { "gpt-4": { _declare: true, context_length: 42000 } },
		});
		assert.strictEqual(effective.declare, true);
		assert.strictEqual(effective.fields.context_length.value, 42000);
		assert.strictEqual(effective.fields.max_output_tokens.level, "floor");
	});

	test("an ambiguous implicit catalog match skips the level", () => {
		const catalog = makeCatalog({
			"vendorx/gpt-4": { context_length: 40000 },
			"vendory/gpt-4": { context_length: 41000 },
		});
		const effective = resolve({ catalog });
		assert.strictEqual(effective.fields.context_length.level, "floor");
		assert.deepStrictEqual(effective.fields.context_length.shadowed, []);
	});
});
