/**
 * The capability-resolution unit pins: the closed vocabulary boundary
 * (parseCapabilityRecord), `_declare` extraction under the exact-entry-key
 * rule, the override/fallback/directive layering, the full precedence walk
 * (entry > global > directive > server > fallbacks > catalog > floor), and
 * output-limit provenance - including the redesign's ruling that BOTH
 * catalog paths (the explicit `_openrouter_model` directive included) stay
 * clamped guesses. Matcher grammar and inheritance mechanics have their own
 * suites; here they appear only where they interact with capability
 * semantics (fallback markings riding, directives never inherited).
 */
import * as assert from "node:assert";
import type {
	CapabilityCatalogLookup,
	CapabilityFallbackCandidate,
	CapabilityFieldValues,
	CatalogLookupResult,
	DeclaredModelSpec,
	DirectiveOutcome,
	EffectiveCapabilities,
	ParsedCapabilityRecord,
	ResolvedCapabilityFallbackFields,
	ResolveModelCapabilitiesInput,
} from "../../../shared/config/capabilityResolution";
import {
	CAPABILITY_FLOOR,
	DECLARE_DIRECTIVE,
	EMPTY_CATALOG_LOOKUP,
	extractDeclaredModels,
	FALLBACK_DIRECTIVE,
	FLOOR_CONTEXT_LENGTH,
	FLOOR_MAX_OUTPUT_TOKENS,
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

function resolve(partial: Partial<ResolveModelCapabilitiesInput>): EffectiveCapabilities {
	return resolveModelCapabilities({
		rawModelId: "gpt-4",
		globalCapabilities: {},
		catalog: EMPTY_CATALOG_LOOKUP,
		serverDeclared: { kind: "discovered", values: {}, outputDeclared: false },
		...partial,
	});
}

suite("shared/config capabilityResolution parseCapabilityRecord", () => {
	test("accepts the whole vocabulary with valid values and no diagnostics", () => {
		const parsed: ParsedCapabilityRecord = parseCapabilityRecord(
			{
				context_length: 128000,
				max_input_tokens: 100000,
				max_output_tokens: 16000,
				supports_function_calling: true,
				supports_vision: false,
				supports_reasoning: true,
				supports_audio_input: false,
			},
			{ allowDeclare: true }
		);
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

	test("unknown fields are diagnosed; unknown underscore keys stay silent", () => {
		const parsed = parseCapabilityRecord({ bogus: 1, _future: true }, { allowDeclare: true });
		assert.deepStrictEqual(parsed.fields, {});
		assert.deepStrictEqual(
			parsed.diagnostics.map((d) => `${d.kind}:${d.key}`),
			["unknown-key:bogus"]
		);
	});

	test("number fields take positive integers only; boolean fields take booleans only", () => {
		for (const value of [0, -5, 1.5, "128k", null, true]) {
			const parsed = parseCapabilityRecord({ context_length: value }, { allowDeclare: true });
			assert.strictEqual(parsed.fields.context_length, undefined, String(value));
			assert.deepStrictEqual(parsed.diagnostics, [{ kind: "invalid-value", key: "context_length" }]);
		}
		for (const value of [1, "yes", null]) {
			const parsed = parseCapabilityRecord({ supports_vision: value }, { allowDeclare: true });
			assert.strictEqual(parsed.fields.supports_vision, undefined, String(value));
			assert.deepStrictEqual(parsed.diagnostics, [{ kind: "invalid-value", key: "supports_vision" }]);
		}
	});

	test("_declare must be boolean and is honored only where allowed", () => {
		assert.strictEqual(parseCapabilityRecord({ [DECLARE_DIRECTIVE]: true }, { allowDeclare: true }).declare, true);
		assert.strictEqual(parseCapabilityRecord({ [DECLARE_DIRECTIVE]: false }, { allowDeclare: true }).declare, false);
		const invalid = parseCapabilityRecord({ [DECLARE_DIRECTIVE]: "yes" }, { allowDeclare: true });
		assert.strictEqual(invalid.declare, false);
		assert.deepStrictEqual(invalid.diagnostics, [{ kind: "invalid-directive", key: DECLARE_DIRECTIVE }]);
		const unscoped = parseCapabilityRecord({ [DECLARE_DIRECTIVE]: true }, { allowDeclare: false });
		assert.strictEqual(unscoped.declare, false);
		assert.deepStrictEqual(unscoped.diagnostics, [{ kind: "unscoped-declare", key: DECLARE_DIRECTIVE }]);
		const unscopedFalse = parseCapabilityRecord({ [DECLARE_DIRECTIVE]: false }, { allowDeclare: false });
		assert.deepStrictEqual(unscopedFalse.diagnostics, [], "an explicit false is not an error anywhere");
	});

	test("_openrouter_model takes a non-blank string", () => {
		const valid = parseCapabilityRecord({ [OPENROUTER_MODEL_DIRECTIVE]: "vendorx/alpha" }, { allowDeclare: true });
		assert.strictEqual(valid.openrouterModel, "vendorx/alpha");
		for (const value of ["", "   ", 5, null, true]) {
			const parsed = parseCapabilityRecord({ [OPENROUTER_MODEL_DIRECTIVE]: value }, { allowDeclare: true });
			assert.strictEqual(parsed.openrouterModel, undefined, String(value));
			assert.deepStrictEqual(parsed.diagnostics, [{ kind: "invalid-directive", key: OPENROUTER_MODEL_DIRECTIVE }]);
		}
	});

	test("_fallback marks all valid fields, or the listed valid ones, diagnosing the rest", () => {
		const all = parseCapabilityRecord(
			{ [FALLBACK_DIRECTIVE]: true, context_length: 1000, supports_vision: true, bogus: 1 },
			{ allowDeclare: true }
		);
		assert.deepStrictEqual([...all.fallback].sort(), ["context_length", "supports_vision"]);

		const listed = parseCapabilityRecord(
			{
				[FALLBACK_DIRECTIVE]: ["context_length", "max_output_tokens", "absent_field", 5],
				context_length: 1000,
				max_output_tokens: "junk",
			},
			{ allowDeclare: true }
		);
		assert.deepStrictEqual([...listed.fallback], ["context_length"], "invalid-valued and absent names are skipped");
		assert.ok(listed.diagnostics.some((d) => d.kind === "invalid-directive" && d.key === FALLBACK_DIRECTIVE));

		const off = parseCapabilityRecord({ [FALLBACK_DIRECTIVE]: false, context_length: 1000 }, { allowDeclare: true });
		assert.deepStrictEqual([...off.fallback], []);
		assert.deepStrictEqual(off.diagnostics, []);
	});

	test("_force in a capability record is the wrong record type", () => {
		const parsed = parseCapabilityRecord({ _force: true, context_length: 1000 }, { allowDeclare: true });
		assert.deepStrictEqual(
			parsed.diagnostics.map((d) => `${d.kind}:${d.key}`),
			["wrong-record-type:_force"]
		);
		assert.strictEqual(parsed.fields.context_length, 1000, "the rest of the record still applies");
	});
});

suite("shared/config capabilityResolution extractDeclaredModels", () => {
	test("an exact entry key with _declare: true declares that exact ID", () => {
		const extracted = extractDeclaredModels({
			globalCapabilities: {},
			entryCapabilities: { "my-model": { [DECLARE_DIRECTIVE]: true, context_length: 1000 } },
		});
		const expected: readonly DeclaredModelSpec[] = [{ rawId: "my-model", layer: "entry", recordKey: "my-model" }];
		assert.deepStrictEqual(extracted.models, expected);
		assert.deepStrictEqual(extracted.diagnostics, []);
	});

	test("a global _declare is unscoped: diagnosed, never created", () => {
		const extracted = extractDeclaredModels({
			globalCapabilities: { "my-model": { [DECLARE_DIRECTIVE]: true } },
		});
		assert.deepStrictEqual(extracted.models, []);
		assert.deepStrictEqual(extracted.diagnostics, [
			{ kind: "unscoped-declare", key: DECLARE_DIRECTIVE, layer: "global", recordKey: "my-model" },
		]);
	});

	test("glob, regex, and catch-all entry keys cannot declare: matchers select, they do not name", () => {
		const extracted = extractDeclaredModels({
			globalCapabilities: {},
			entryCapabilities: {
				"my-*": { [DECLARE_DIRECTIVE]: true },
				"/my-.*/": { [DECLARE_DIRECTIVE]: true },
				"*": { [DECLARE_DIRECTIVE]: true },
			},
		});
		assert.deepStrictEqual(extracted.models, []);
		assert.strictEqual(extracted.diagnostics.length, 3);
		assert.ok(extracted.diagnostics.every((d) => d.kind === "unscoped-declare" && d.layer === "entry"));
	});

	test("an invalid _declare value is diagnosed; field problems stay with resolution", () => {
		const extracted = extractDeclaredModels({
			globalCapabilities: {},
			entryCapabilities: { m1: { [DECLARE_DIRECTIVE]: "yes", bogus: 1 } },
		});
		assert.deepStrictEqual(extracted.models, []);
		assert.deepStrictEqual(extracted.diagnostics, [
			{ kind: "invalid-directive", key: DECLARE_DIRECTIVE, layer: "entry", recordKey: "m1" },
		]);
	});
});

suite("shared/config capabilityResolution resolveCapabilityOverrides", () => {
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

	test("declare answers extraction's rule for the resolved model", () => {
		const input = {
			rawModelId: "my-model",
			globalCapabilities: {},
			entryCapabilities: { "my-model": { [DECLARE_DIRECTIVE]: true } },
			catalog: EMPTY_CATALOG_LOOKUP,
		};
		assert.strictEqual(resolveCapabilityOverrides(input).declare, true);
		assert.strictEqual(resolveCapabilityOverrides({ ...input, rawModelId: "other" }).declare, false);
	});
});

suite("shared/config capabilityResolution resolveModelCapabilities walk", () => {
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
		const effective = resolve({
			rawModelId: "my-model",
			globalCapabilities: { "*": { [FALLBACK_DIRECTIVE]: true, context_length: 64000 } },
			entryCapabilities: { "my-model": { [DECLARE_DIRECTIVE]: true, max_output_tokens: 8000 } },
			serverDeclared: { kind: "declared" },
		});
		assert.strictEqual(effective.declare, true);
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
		// "*" marks context_length _fallback and inheritable; the exact record
		// overrides the same field, so the layer's view carries the override and
		// the fallback candidate disappears with it - most specific wins per
		// field even across markings.
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

suite("shared/config capabilityResolution output-limit provenance", () => {
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

suite("shared/config capabilityResolution diagnostics", () => {
	test("field and directive problems attribute their layer and record key; _declare stays with extraction", () => {
		const effective = resolve({
			globalCapabilities: { "gpt-4": { bogus: 1, [DECLARE_DIRECTIVE]: true } },
			entryCapabilities: { "gpt-4": { context_length: "junk" } },
		});
		assert.deepStrictEqual(effective.diagnostics.map((d) => `${d.layer}:${d.kind}:${d.key}`).sort(), [
			"entry:invalid-value:context_length",
			"global:unknown-key:bogus",
		]);
	});

	test("an invalid matcher key in a capability record is diagnosed and inert", () => {
		const effective = resolve({
			globalCapabilities: { "gpt*4": { context_length: 999 }, "gpt-4": { context_length: 100 } },
		});
		assert.strictEqual(effective.fields.context_length.value, 100);
		assert.ok(effective.diagnostics.some((d) => d.kind === "invalid-matcher" && d.recordKey === "gpt*4"));
	});
});
