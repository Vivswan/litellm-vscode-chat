/**
 * The capability-resolution unit pins: the open vocabulary boundary
 * (parseCapabilityRecord: typed consumed fields, verbatim extras), the
 * override/fallback/directive layering, the full precedence walk
 * (entry > global > directive > server > fallbacks > catalog > floor), and
 * output-limit provenance - including that BOTH catalog paths stay clamped
 * guesses. Matcher grammar and inheritance have their own suites; here they
 * appear only where they interact with capability semantics.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import type {
	CapabilityCatalogLookup,
	CapabilityFallbackCandidate,
	CapabilityFieldValues,
	CatalogLookupResult,
	DirectiveOutcome,
	EffectiveCapabilities,
	ParsedCapabilityRecord,
	ResolvedCapabilityFallbackFields,
	ResolveModelCapabilitiesInput,
} from "../../../../shared/config/capabilityResolution";
import {
	CAPABILITY_FLOOR,
	capabilityField,
	EMPTY_CATALOG_LOOKUP,
	FALLBACK_DIRECTIVE,
	FLOOR_CONTEXT_LENGTH,
	FLOOR_MAX_OUTPUT_TOKENS,
	filterUnrecognizedKeyDiagnostics,
	OPENROUTER_MODEL_DIRECTIVE,
	parseCapabilityRecord,
	resolveCapabilityOverrides,
	resolveModelCapabilities,
} from "../../../../shared/config/capabilityResolution";
import { resolveMaxTokens } from "../../../../shared/config/parameterResolution";

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

function resolve(partial: Partial<ResolveModelCapabilitiesInput>): EffectiveCapabilities {
	return resolveModelCapabilities({
		rawModelId: "gpt-4",
		globalCapabilities: {},
		catalog: EMPTY_CATALOG_LOOKUP,
		serverDeclared: { kind: "discovered", values: {}, outputDeclared: false },
		...partial,
	});
}

describe("shared/config capabilityResolution parseCapabilityRecord", () => {
	test("accepts the whole vocabulary with valid values and no diagnostics", () => {
		const parsed: ParsedCapabilityRecord = parseCapabilityRecord({
			context_length: 128000,
			max_input_tokens: 100000,
			max_output_tokens: 16000,
			supports_function_calling: true,
			supports_vision: false,
			supports_reasoning: true,
			supports_audio_input: false,
		});
		assert.deepStrictEqual(parsed.fields, {
			context_length: 128000,
			max_input_tokens: 100000,
			max_output_tokens: 16000,
			supports_function_calling: true,
			supports_vision: false,
			supports_reasoning: true,
			supports_audio_input: false,
		});
		assert.deepStrictEqual(parsed.diagnostics, []);
	});

	test("unrecognized fields are KEPT with an informational diagnostic; unknown underscore keys stay silent", () => {
		const parsed = parseCapabilityRecord({ bogus: 1, _future: true });
		assert.deepStrictEqual(parsed.fields, { bogus: 1 });
		assert.deepStrictEqual(
			parsed.diagnostics.map((d) => `${d.kind}:${d.key}`),
			["unrecognized-key:bogus"]
		);
	});

	test("field keys are judged trimmed, the editor's own normalization: padded keys mean the same field", () => {
		// One trim rule on both sides of the seam: the editor judges and saves
		// keys trimmed, and this parse boundary reads stored records the same
		// way, so a hand-padded settings.json key is a typed consumed field (or
		// a padded directive is a directive) everywhere instead of a padded open
		// field until the next Apply rewrote it.
		const parsed = parseCapabilityRecord({
			" context_length ": 128000,
			"supports_vision\t": true,
			" _fallback": ["context_length"],
			" _inheritable ": true,
			" _openrouter_model": "openai/gpt-4o",
		});
		assert.deepStrictEqual(parsed.fields, { context_length: 128000, supports_vision: true });
		assert.deepStrictEqual([...parsed.fallback], ["context_length"]);
		assert.deepStrictEqual([...parsed.inheritable].sort(), ["context_length", "supports_vision"]);
		assert.strictEqual(parsed.openrouterModel, "openai/gpt-4o");
		assert.deepStrictEqual(parsed.diagnostics, []);
		// The field-naming directives' LIST ENTRIES trim at the same boundary, so
		// a padded entry still names its trimmed field instead of reading as an
		// invalid directive.
		const paddedEntries = parseCapabilityRecord({
			" context_length": 128000,
			_fallback: [" context_length "],
			_inheritable: ["context_length "],
		});
		assert.deepStrictEqual([...paddedEntries.fallback], ["context_length"]);
		assert.deepStrictEqual([...paddedEntries.inheritable], ["context_length"]);
		assert.deepStrictEqual(paddedEntries.diagnostics, []);
		// A trim collision resolves by the record's object key order, the later
		// spelling winning; and a padded hostile name is still just an own key.
		const collided = parseCapabilityRecord({ context_length: 1000, " context_length": 2000 });
		assert.strictEqual(collided.fields.context_length, 2000);
		const hostile = parseCapabilityRecord({ " __proto__ ": { polluted: true } });
		assert.deepStrictEqual(hostile.fields, {});
		assert.strictEqual(({} as { polluted?: boolean }).polluted, undefined);
	});

	test("unrecognized fields keep their JSON values verbatim: strings, arrays, and objects alike", () => {
		const parsed = parseCapabilityRecord({
			mode: "chat",
			litellm_provider: { name: "openai", tier: 2 },
			deprecation_date: null,
			tags: ["a", "b"],
		});
		assert.deepStrictEqual(parsed.fields, {
			mode: "chat",
			litellm_provider: { name: "openai", tier: 2 },
			deprecation_date: null,
			tags: ["a", "b"],
		});
		assert.deepStrictEqual(parsed.diagnostics.map((d) => `${d.kind}:${d.key}`).sort(), [
			"unrecognized-key:deprecation_date",
			"unrecognized-key:litellm_provider",
			"unrecognized-key:mode",
			"unrecognized-key:tags",
		]);
	});

	test("number fields take positive integers only; boolean fields take booleans only", () => {
		for (const value of [0, -5, 1.5, "128k", null, true]) {
			const parsed = parseCapabilityRecord({ context_length: value });
			assert.strictEqual(parsed.fields.context_length, undefined, String(value));
			assert.deepStrictEqual(parsed.diagnostics, [{ kind: "invalid-value", key: "context_length" }]);
		}
		for (const value of [1, "yes", null]) {
			const parsed = parseCapabilityRecord({ supports_vision: value });
			assert.strictEqual(parsed.fields.supports_vision, undefined, String(value));
			assert.deepStrictEqual(parsed.diagnostics, [{ kind: "invalid-value", key: "supports_vision" }]);
		}
	});

	test("consumed cost fields take finite non-negative numbers; zero means free", () => {
		const valid = parseCapabilityRecord({ input_cost_per_token: 0.000003, output_cost_per_token: 0 });
		assert.deepStrictEqual(valid.fields, { input_cost_per_token: 0.000003, output_cost_per_token: 0 });
		assert.deepStrictEqual(valid.diagnostics, []);
		const negativeZero = parseCapabilityRecord({ input_cost_per_token: -0 });
		assert.ok(Object.is(negativeZero.fields.input_cost_per_token, 0), "-0 normalizes to +0, never a signed zero");
		for (const value of [-0.000001, Number.POSITIVE_INFINITY, Number.NaN, "0.003", null, true]) {
			const parsed = parseCapabilityRecord({ cache_read_input_token_cost: value });
			assert.strictEqual(parsed.fields.cache_read_input_token_cost, undefined, String(value));
			assert.deepStrictEqual(parsed.diagnostics, [{ kind: "invalid-value", key: "cache_read_input_token_cost" }]);
		}
	});

	test("consumed boolean and string-array fields validate per kind", () => {
		const valid = parseCapabilityRecord({
			supports_prompt_caching: true,
			supports_pdf_input: false,
			supports_response_schema: true,
			supported_openai_params: ["temperature", "reasoning_effort"],
		});
		assert.deepStrictEqual(valid.fields, {
			supports_prompt_caching: true,
			supports_pdf_input: false,
			supports_response_schema: true,
			supported_openai_params: ["temperature", "reasoning_effort"],
		});
		assert.deepStrictEqual(valid.diagnostics, []);

		const empty = parseCapabilityRecord({ supported_openai_params: [] });
		assert.deepStrictEqual(empty.fields, { supported_openai_params: [] }, "the empty list is a valid value");
		assert.deepStrictEqual(empty.diagnostics, []);

		for (const value of [[""], ["temperature", 5], "temperature", 1, null]) {
			const parsed = parseCapabilityRecord({ supported_openai_params: value });
			assert.strictEqual(parsed.fields.supported_openai_params, undefined, JSON.stringify(value));
			assert.deepStrictEqual(parsed.diagnostics, [{ kind: "invalid-value", key: "supported_openai_params" }]);
		}
		for (const value of [1, "yes", null]) {
			const parsed = parseCapabilityRecord({ supports_pdf_input: value });
			assert.strictEqual(parsed.fields.supports_pdf_input, undefined, String(value));
			assert.deepStrictEqual(parsed.diagnostics, [{ kind: "invalid-value", key: "supports_pdf_input" }]);
		}
	});

	test("a leftover _declare key is an unknown underscore key: silently ignored", () => {
		// Declaration moved to the entry's discovery.declared list; the retired
		// directive parses like any reserved underscore key.
		const parsed = parseCapabilityRecord({ _declare: true, context_length: 1000 });
		assert.deepStrictEqual(parsed.diagnostics, []);
		assert.strictEqual(parsed.fields.context_length, 1000);
	});

	test("_openrouter_model takes a non-blank string", () => {
		const valid = parseCapabilityRecord({ [OPENROUTER_MODEL_DIRECTIVE]: "vendorx/alpha" });
		assert.strictEqual(valid.openrouterModel, "vendorx/alpha");
		for (const value of ["", "   ", 5, null, true]) {
			const parsed = parseCapabilityRecord({ [OPENROUTER_MODEL_DIRECTIVE]: value });
			assert.strictEqual(parsed.openrouterModel, undefined, String(value));
			assert.deepStrictEqual(parsed.diagnostics, [{ kind: "invalid-directive", key: OPENROUTER_MODEL_DIRECTIVE }]);
		}
	});

	test("_fallback marks all kept fields, or the listed kept ones, diagnosing the rest", () => {
		const all = parseCapabilityRecord({
			[FALLBACK_DIRECTIVE]: true,
			context_length: 1000,
			supports_vision: true,
			bogus: 1,
		});
		assert.deepStrictEqual([...all.fallback].sort(), ["bogus", "context_length", "supports_vision"]);

		const listed = parseCapabilityRecord({
			[FALLBACK_DIRECTIVE]: ["context_length", "max_output_tokens", "absent_field", 5],
			context_length: 1000,
			max_output_tokens: "junk",
		});
		assert.deepStrictEqual([...listed.fallback], ["context_length"], "invalid-valued and absent names are skipped");
		assert.ok(listed.diagnostics.some((d) => d.kind === "invalid-directive" && d.key === FALLBACK_DIRECTIVE));

		const off = parseCapabilityRecord({ [FALLBACK_DIRECTIVE]: false, context_length: 1000 });
		assert.deepStrictEqual([...off.fallback], []);
		assert.deepStrictEqual(off.diagnostics, []);
	});

	test("a _fallback list may name any kept field, unrecognized ones included", () => {
		const parsed = parseCapabilityRecord({
			[FALLBACK_DIRECTIVE]: ["custom_flag"],
			custom_flag: true,
			context_length: 1000,
		});
		assert.deepStrictEqual([...parsed.fallback], ["custom_flag"]);
		assert.deepStrictEqual(
			parsed.diagnostics.map((d) => `${d.kind}:${d.key}`),
			["unrecognized-key:custom_flag"],
			"the informational diagnostic still rides; the directive itself is valid"
		);
	});

	test("_force in a capability record is the wrong record type", () => {
		const parsed = parseCapabilityRecord({ _force: true, context_length: 1000 });
		assert.deepStrictEqual(
			parsed.diagnostics.map((d) => `${d.kind}:${d.key}`),
			["wrong-record-type:_force"]
		);
		assert.strictEqual(parsed.fields.context_length, 1000, "the rest of the record still applies");
	});
});

describe("shared/config capabilityResolution resolveCapabilityOverrides", () => {
	test("entry fields beat global fields per field; both attribute their winning keys", () => {
		const resolved = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: { "gpt-4": { context_length: 100000, supports_vision: true } },
			entryCapabilities: { "gpt-4": { context_length: 200000 } },
			catalog: EMPTY_CATALOG_LOOKUP,
		});
		assert.strictEqual(resolved.fields.context_length?.value, 200000);
		assert.strictEqual(resolved.fields.context_length?.level, "entry");
		assert.deepStrictEqual(resolved.fields.context_length?.shadowed, [
			{ level: "global", key: "gpt-4", value: 100000 },
		]);
		assert.strictEqual(resolved.fields.supports_vision?.level, "global");
	});

	test("an invalid value in a higher layer never shadows a valid lower one", () => {
		const resolved = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: { "gpt-4": { context_length: 100000 } },
			entryCapabilities: { "gpt-4": { context_length: "junk" } },
			catalog: EMPTY_CATALOG_LOOKUP,
		});
		assert.strictEqual(resolved.fields.context_length?.value, 100000);
		assert.strictEqual(resolved.fields.context_length?.level, "global");
		assert.ok(resolved.diagnostics.some((d) => d.kind === "invalid-value" && d.layer === "entry"));
	});

	test("_fallback demotes fields out of the override chain into fallback candidates", () => {
		const resolved = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: {
				"gpt-4": { [FALLBACK_DIRECTIVE]: ["context_length"], context_length: 111, supports_vision: true },
			},
			catalog: EMPTY_CATALOG_LOOKUP,
		});
		assert.strictEqual(resolved.fields.context_length, undefined);
		const fallbackFields: ResolvedCapabilityFallbackFields = resolved.fallbackFields;
		const expected: readonly CapabilityFallbackCandidate<number>[] = [
			{ level: "global-fallback", key: "gpt-4", value: 111 },
		];
		assert.deepStrictEqual(fallbackFields.context_length, expected);
		assert.strictEqual(resolved.fields.supports_vision?.value, true, "unlisted fields stay overrides");
	});

	test("an inherited field keeps its source's _fallback marking; the receiver cannot re-mark", () => {
		const resolved = resolveCapabilityOverrides({
			rawModelId: "gpt-4.1",
			globalCapabilities: {
				"gpt*": { [FALLBACK_DIRECTIVE]: true, context_length: 111, _inheritable: true },
				"gpt-4*": { supports_vision: true },
			},
			catalog: EMPTY_CATALOG_LOOKUP,
		});
		assert.deepStrictEqual(resolved.fallbackFields.context_length, [
			{ level: "global-fallback", key: "gpt*", inheritedFrom: "gpt*", value: 111 },
		]);
		assert.strictEqual(resolved.fields.supports_vision?.level, "global");
	});

	test("the directive belongs to the winning record only: a more specific match shadows it", () => {
		const catalog = makeCatalog({ "cat/alpha": { context_length: 55555 } });
		const shadowed = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: {
				"gpt*": { [OPENROUTER_MODEL_DIRECTIVE]: "cat/alpha" },
				"gpt-4": { supports_vision: true },
			},
			catalog,
		});
		assert.strictEqual(shadowed.directive, undefined, "directives never travel with inheritance");
		assert.strictEqual(shadowed.fields.context_length, undefined);

		const applied = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: { "gpt*": { [OPENROUTER_MODEL_DIRECTIVE]: "cat/alpha" } },
			catalog,
		});
		const outcome: DirectiveOutcome | undefined = applied.directive;
		assert.deepStrictEqual(outcome, { kind: "applied", id: "cat/alpha" });
		assert.strictEqual(applied.fields.context_length?.level, "directive");
		assert.strictEqual(applied.fields.context_length?.value, 55555);
	});

	test("the entry winner's directive beats the global winner's; explicit fields still beat the catalog's", () => {
		const catalog = makeCatalog({
			"cat/a": { context_length: 111, supports_vision: true },
			"cat/b": { context_length: 222 },
		});
		const resolved = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: { "gpt-4": { [OPENROUTER_MODEL_DIRECTIVE]: "cat/a" } },
			entryCapabilities: { "gpt-4": { [OPENROUTER_MODEL_DIRECTIVE]: "cat/b", context_length: 999 } },
			catalog,
		});
		assert.deepStrictEqual(resolved.directive, { kind: "applied", id: "cat/b" });
		assert.strictEqual(resolved.fields.context_length?.value, 999, "the record's own field beats its catalog");
		assert.strictEqual(resolved.fields.supports_vision, undefined, "the losing directive contributes nothing");
	});

	test("an unknown catalog ID reports not-found and contributes nothing", () => {
		const resolved = resolveCapabilityOverrides({
			rawModelId: "gpt-4",
			globalCapabilities: { "gpt-4": { [OPENROUTER_MODEL_DIRECTIVE]: "cat/ghost" } },
			catalog: EMPTY_CATALOG_LOOKUP,
		});
		assert.deepStrictEqual(resolved.directive, { kind: "not-found", id: "cat/ghost" });
		assert.strictEqual(resolved.fields.context_length, undefined);
	});
});

describe("shared/config capabilityResolution resolveModelCapabilities walk", () => {
	test("per field: entry > global > directive > server > fallback > catalog > floor", () => {
		const catalog = makeCatalog({
			"dir/entry": { max_output_tokens: 3000 },
			"imp/gpt-4": { supports_audio_input: true, context_length: 77777 },
		});
		const effective = resolve({
			globalCapabilities: {
				"gpt-4": {
					context_length: 200000,
					[OPENROUTER_MODEL_DIRECTIVE]: "dir/entry",
					[FALLBACK_DIRECTIVE]: ["supports_reasoning"],
					supports_reasoning: true,
				},
			},
			catalog,
			serverDeclared: {
				kind: "discovered",
				values: { max_input_tokens: 90000, supports_vision: true },
				outputDeclared: false,
			},
		});
		assert.strictEqual(effective.fields.context_length.level, "global");
		assert.strictEqual(effective.fields.max_output_tokens.level, "directive");
		assert.strictEqual(effective.fields.max_output_tokens.value, 3000);
		assert.strictEqual(effective.fields.max_input_tokens.level, "server");
		assert.strictEqual(effective.fields.supports_vision.level, "server");
		assert.strictEqual(effective.fields.supports_reasoning.level, "global-fallback");
		assert.strictEqual(effective.fields.supports_audio_input.level, "catalog");
		assert.strictEqual(effective.fields.supports_function_calling.level, "floor");
	});

	test("a _fallback value fills only below the server's report; the server wins where it speaks", () => {
		const effective = resolve({
			globalCapabilities: {
				"*": { [FALLBACK_DIRECTIVE]: true, context_length: 131072, max_output_tokens: 8192 },
			},
			serverDeclared: { kind: "discovered", values: { context_length: 100000 }, outputDeclared: false },
		});
		assert.strictEqual(effective.fields.context_length.value, 100000);
		assert.strictEqual(effective.fields.context_length.level, "server");
		assert.strictEqual(effective.fields.max_output_tokens.value, 8192);
		assert.strictEqual(effective.fields.max_output_tokens.level, "global-fallback");
	});

	test("the entry fallback beats the global fallback; a global override beats an entry fallback", () => {
		const effective = resolve({
			globalCapabilities: { "gpt-4": { [FALLBACK_DIRECTIVE]: true, max_output_tokens: 1000 } },
			entryCapabilities: { "gpt-4": { [FALLBACK_DIRECTIVE]: true, max_output_tokens: 2000 } },
		});
		assert.strictEqual(effective.fields.max_output_tokens.value, 2000);
		assert.strictEqual(effective.fields.max_output_tokens.level, "entry-fallback");

		const overridden = resolve({
			globalCapabilities: { "gpt-4": { max_output_tokens: 3000 } },
			entryCapabilities: { "gpt-4": { [FALLBACK_DIRECTIVE]: true, max_output_tokens: 2000 } },
		});
		assert.strictEqual(overridden.fields.max_output_tokens.value, 3000);
		assert.strictEqual(overridden.fields.max_output_tokens.level, "global");
	});

	test("a declared model has no server level and resolves from the remaining sources", () => {
		// The model exists because discovery.declared names it, so the walk sees no
		// server values at all.
		const effective = resolve({
			rawModelId: "my-model",
			globalCapabilities: { "*": { [FALLBACK_DIRECTIVE]: true, context_length: 64000 } },
			entryCapabilities: { "my-model": { max_output_tokens: 8000 } },
			serverDeclared: { kind: "declared" },
		});
		assert.strictEqual(effective.fields.max_output_tokens.value, 8000);
		assert.strictEqual(effective.fields.context_length.value, 64000);
		assert.strictEqual(effective.fields.max_input_tokens.value, 56000, "derived: context minus output");
		assert.strictEqual(effective.fields.max_input_tokens.level, "derived");
	});

	test("an ambiguous implicit catalog match skips the level", () => {
		const catalog = makeCatalog({ "one/gpt-4": { context_length: 111 }, "two/gpt-4": { context_length: 222 } });
		const effective = resolve({ catalog });
		assert.strictEqual(effective.fields.context_length.level, "floor", "an ambiguous suffix match contributes nothing");
	});

	test("the floor backstops everything, with the pinned literals", () => {
		const effective = resolve({});
		assert.strictEqual(effective.fields.context_length.value, FLOOR_CONTEXT_LENGTH);
		assert.strictEqual(FLOOR_CONTEXT_LENGTH, 128000);
		assert.strictEqual(effective.fields.max_output_tokens.value, FLOOR_MAX_OUTPUT_TOKENS);
		assert.strictEqual(FLOOR_MAX_OUTPUT_TOKENS, 16000);
		assert.strictEqual(effective.fields.max_input_tokens.value, 112000);
		assert.strictEqual(effective.fields.supports_function_calling.value, CAPABILITY_FLOOR.supports_function_calling);
	});

	test("shadowed values stack highest first across the whole walk", () => {
		const catalog = makeCatalog({ "imp/gpt-4": { context_length: 55555 } });
		const effective = resolve({
			globalCapabilities: { "gpt-4": { context_length: 200000 } },
			catalog,
			serverDeclared: { kind: "discovered", values: { context_length: 100000 }, outputDeclared: false },
		});
		assert.strictEqual(effective.fields.context_length.value, 200000);
		assert.deepStrictEqual(
			effective.fields.context_length.shadowed.map((s) => `${s.level}:${String(s.value)}`),
			["server:100000", "catalog:55555"]
		);
	});

	test("within one layer a field is an override or a fallback, never both: the chain's winner decides", () => {
		// The exact record overrides the field the inheritable "*" marks _fallback,
		// so the layer carries the override and the candidate disappears with it.
		const effective = resolve({
			globalCapabilities: {
				"gpt-4": { context_length: 200000 },
				"*": { [FALLBACK_DIRECTIVE]: true, context_length: 131072, _inheritable: true },
			},
			serverDeclared: { kind: "discovered", values: { context_length: 100000 }, outputDeclared: false },
		});
		assert.strictEqual(effective.fields.context_length.value, 200000);
		assert.strictEqual(effective.fields.context_length.level, "global");
		assert.deepStrictEqual(
			effective.fields.context_length.shadowed.map((s) => s.level),
			["server"],
			"the overridden fallback mark does not survive as a separate candidate"
		);
	});
});

describe("shared/config capabilityResolution open fields in the walk", () => {
	test("the seven core fields are always present, whatever else resolves", () => {
		for (const effective of [
			resolve({}),
			resolve({
				globalCapabilities: { "gpt-4": { custom_flag: true, input_cost_per_token: 0.000001 } },
				serverDeclared: { kind: "discovered", values: { supports_pdf_input: true }, outputDeclared: false },
			}),
		]) {
			for (const name of [
				"context_length",
				"max_input_tokens",
				"max_output_tokens",
				"supports_function_calling",
				"supports_vision",
				"supports_reasoning",
				"supports_audio_input",
			] as const) {
				assert.ok(effective.fields[name] !== undefined, `${name} must always resolve`);
				assert.ok(Object.hasOwn(effective.fields, name), `${name} must be an own key of the result`);
			}
		}
	});

	test("a server-supplied consumed field appears at server level with zero user configuration", () => {
		const effective = resolve({
			serverDeclared: {
				kind: "discovered",
				values: { supports_prompt_caching: true, input_cost_per_token: 0.000003, supported_openai_params: ["tools"] },
				outputDeclared: false,
			},
		});
		assert.deepStrictEqual(effective.fields.supports_prompt_caching, {
			value: true,
			level: "server",
			shadowed: [],
		});
		assert.strictEqual(effective.fields.input_cost_per_token?.value, 0.000003);
		assert.deepStrictEqual(effective.fields.supported_openai_params?.value, ["tools"]);
	});

	test("an open field with no candidate at any level is absent, never floored", () => {
		const effective = resolve({});
		assert.strictEqual(effective.fields.supports_prompt_caching, undefined);
		assert.strictEqual(effective.fields.custom_flag, undefined);
	});

	test("an invalid consumed value in a higher layer never shadows a valid lower one", () => {
		// The non-core consumed ring's copy of the core rule.
		const effective = resolve({
			globalCapabilities: { "gpt-4": { input_cost_per_token: 0.000003 } },
			entryCapabilities: { "gpt-4": { input_cost_per_token: -1 } },
		});
		assert.strictEqual(effective.fields.input_cost_per_token?.value, 0.000003);
		assert.strictEqual(effective.fields.input_cost_per_token?.level, "global");
		assert.ok(
			effective.diagnostics.some(
				(d) => d.kind === "invalid-value" && d.key === "input_cost_per_token" && d.layer === "entry"
			)
		);
	});

	test("extra fields layer like any other: entry beats global beats server", () => {
		const effective = resolve({
			globalCapabilities: { "gpt-4": { custom_flag: "global", other_extra: 1 } },
			entryCapabilities: { "gpt-4": { custom_flag: "entry" } },
			serverDeclared: { kind: "discovered", values: {}, outputDeclared: false },
		});
		assert.strictEqual(effective.fields.custom_flag?.value, "entry");
		assert.strictEqual(effective.fields.custom_flag?.level, "entry");
		assert.deepStrictEqual(effective.fields.custom_flag?.shadowed, [
			{ level: "global", key: "gpt-4", value: "global" },
		]);
		assert.strictEqual(effective.fields.other_extra?.level, "global");
	});

	test("a _fallback-marked extra sits below the server value and wins only where the server is silent", () => {
		const shadowedByServer = resolve({
			entryCapabilities: { "gpt-4": { [FALLBACK_DIRECTIVE]: true, supports_prompt_caching: false } },
			serverDeclared: { kind: "discovered", values: { supports_prompt_caching: true }, outputDeclared: false },
		});
		assert.strictEqual(shadowedByServer.fields.supports_prompt_caching?.value, true);
		assert.strictEqual(shadowedByServer.fields.supports_prompt_caching?.level, "server");
		assert.deepStrictEqual(
			shadowedByServer.fields.supports_prompt_caching?.shadowed.map((s) => `${s.level}:${String(s.value)}`),
			["entry-fallback:false"]
		);

		const serverSilent = resolve({
			entryCapabilities: { "gpt-4": { [FALLBACK_DIRECTIVE]: true, supports_prompt_caching: false } },
			serverDeclared: { kind: "discovered", values: {}, outputDeclared: false },
		});
		assert.strictEqual(serverSilent.fields.supports_prompt_caching?.value, false);
		assert.strictEqual(serverSilent.fields.supports_prompt_caching?.level, "entry-fallback");
	});

	test("object and array extras ride the walk verbatim and stay JSON-serializable", () => {
		const structured = { name: "openai", tiers: [1, 2] };
		const effective = resolve({
			globalCapabilities: { "gpt-4": { litellm_provider: structured, tags: ["a", "b"] } },
		});
		assert.deepStrictEqual(effective.fields.litellm_provider?.value, structured);
		assert.deepStrictEqual(effective.fields.tags?.value, ["a", "b"]);
		const roundTripped: unknown = JSON.parse(JSON.stringify(effective.fields));
		assert.deepStrictEqual(roundTripped, effective.fields, "the effective view survives JSON round-tripping");
		assert.deepStrictEqual(
			structuredClone(effective.fields),
			effective.fields,
			"the effective view survives the webview postMessage clone"
		);
	});

	test("prototype-named extras are ordinary fields: no inherited Object member ever leaks into the walk", () => {
		// A user-controlled name like "toString" must never read Object.prototype's
		// member, so open-name reads go through the capabilityField accessor.
		const openField = (effective: EffectiveCapabilities, name: string) => capabilityField(effective.fields, name);
		const resolved = resolve({
			globalCapabilities: {
				"gpt-4": { toString: 5, constructor: "c", hasOwnProperty: true },
			},
		});
		assert.strictEqual(openField(resolved, "toString")?.value, 5);
		assert.strictEqual(openField(resolved, "toString")?.level, "global");
		assert.strictEqual(openField(resolved, "constructor")?.value, "c");
		assert.strictEqual(openField(resolved, "hasOwnProperty")?.value, true);
		assert.strictEqual(openField(resolved, "valueOf"), undefined, "an unset prototype name reads as absent");

		const asFallback = resolve({
			entryCapabilities: { "gpt-4": { [FALLBACK_DIRECTIVE]: true, valueOf: 1 } },
			serverDeclared: { kind: "discovered", values: {}, outputDeclared: false },
		});
		assert.strictEqual(openField(asFallback, "valueOf")?.value, 1);
		assert.strictEqual(openField(asFallback, "valueOf")?.level, "entry-fallback");
	});
});

describe("shared/config capabilityResolution output-limit provenance", () => {
	test("a user-written value lifts the request cap: overrides and fallbacks alike", () => {
		for (const record of [{ max_output_tokens: 32000 }, { [FALLBACK_DIRECTIVE]: true, max_output_tokens: 32000 }]) {
			const effective = resolve({ globalCapabilities: { "gpt-4": record } });
			const lifted = effective.outputLimitSource !== "defaults";
			assert.strictEqual(effective.outputLimitSource, "user");
			assert.strictEqual(
				resolveMaxTokens({
					runtimeMaxTokens: undefined,
					configuredMaxTokens: undefined,
					maxOutputTokens: effective.fields.max_output_tokens.value,
					outputLimitDeclared: lifted,
				}).value,
				32000
			);
		}
	});

	test("the server level is provider only under the every-contributor declaredness rule", () => {
		const declared = resolve({
			serverDeclared: { kind: "discovered", values: { max_output_tokens: 32000 }, outputDeclared: true },
		});
		assert.strictEqual(declared.outputLimitSource, "provider");
		const undeclared = resolve({
			serverDeclared: { kind: "discovered", values: { max_output_tokens: 32000 }, outputDeclared: false },
		});
		assert.strictEqual(undeclared.outputLimitSource, "defaults");
	});

	test("BOTH catalog paths stay clamped guesses: the explicit directive included", () => {
		const catalog = makeCatalog({
			"dir/entry": { max_output_tokens: 32000 },
			"imp/gpt-4": { max_output_tokens: 24000 },
		});
		const viaDirective = resolve({
			globalCapabilities: { "gpt-4": { [OPENROUTER_MODEL_DIRECTIVE]: "dir/entry" } },
			catalog,
		});
		assert.strictEqual(viaDirective.fields.max_output_tokens.level, "directive");
		assert.strictEqual(viaDirective.outputLimitSource, "defaults", "an _openrouter_model limit is still a guess");
		assert.strictEqual(
			resolveMaxTokens({
				runtimeMaxTokens: undefined,
				configuredMaxTokens: undefined,
				maxOutputTokens: viaDirective.fields.max_output_tokens.value,
				outputLimitDeclared: viaDirective.outputLimitSource !== "defaults",
			}).value,
			4096,
			"the wire clamp holds for directive-derived limits"
		);

		const viaImplicit = resolve({ catalog });
		assert.strictEqual(viaImplicit.fields.max_output_tokens.level, "catalog");
		assert.strictEqual(viaImplicit.outputLimitSource, "defaults");
	});

	test("the floor is a defaults guess", () => {
		assert.strictEqual(resolve({}).outputLimitSource, "defaults");
	});
});

describe("shared/config capabilityResolution diagnostics", () => {
	test("field and directive problems attribute their layer and record key; a leftover _declare stays silent", () => {
		const effective = resolve({
			globalCapabilities: { "gpt-4": { bogus: 1, _declare: true } },
			entryCapabilities: { "gpt-4": { context_length: "junk" } },
		});
		assert.deepStrictEqual(effective.diagnostics.map((d) => `${d.layer}:${d.kind}:${d.key}`).sort(), [
			"entry:invalid-value:context_length",
			"global:unrecognized-key:bogus",
		]);
		assert.strictEqual(effective.fields.bogus?.value, 1, "the diagnosed field still applies");
		assert.strictEqual(effective.fields.bogus?.level, "global");
	});

	test("an invalid matcher key in a capability record is diagnosed and inert", () => {
		const effective = resolve({
			globalCapabilities: { "gpt*4": { context_length: 999 }, "gpt-4": { context_length: 100 } },
		});
		assert.strictEqual(effective.fields.context_length.value, 100);
		assert.ok(effective.diagnostics.some((d) => d.kind === "invalid-matcher" && d.recordKey === "gpt*4"));
	});
});

describe("shared/config capabilityResolution advisory filter", () => {
	test("filterUnrecognizedKeyDiagnostics drops consumed-vocabulary keys even when the set would keep them", () => {
		// The parse never emits unrecognized-key for a consumed field, but if the
		// vocabulary drifted the filter must not resurrect hints for keys the
		// extension reads.
		const kept = filterUnrecognizedKeyDiagnostics(
			[
				{ kind: "unrecognized-key", recordKey: "r", key: "supports_vision" },
				{ kind: "unrecognized-key", recordKey: "r", key: "mystery_flag" },
			],
			["some_real_key"]
		);
		assert.deepStrictEqual(kept, [{ kind: "unrecognized-key", recordKey: "r", key: "mystery_flag" }]);
	});

	test("filterUnrecognizedKeyDiagnostics treats an empty set as no evidence, exactly like no set", () => {
		// A listing with zero deployments proves nothing about the server's key
		// vocabulary; hinting against it would flag every open field.
		const hints = [{ kind: "unrecognized-key" as const, recordKey: "r", key: "mystery_flag" }];
		assert.deepStrictEqual(filterUnrecognizedKeyDiagnostics(hints, []), []);
		assert.deepStrictEqual(filterUnrecognizedKeyDiagnostics(hints, undefined), []);
	});
});
