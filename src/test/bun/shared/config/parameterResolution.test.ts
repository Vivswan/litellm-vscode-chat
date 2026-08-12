/**
 * The parameters-resolution unit pins: the two canonical worked examples from
 * docs/models.md#which-record-applies (the barrier family and the
 * exclusive-list bypass), the entry-over-global merge, `_force` across both
 * layers, the max_tokens derivation, and the inspector projection. The
 * matcher grammar and the inheritance engine have their own suites
 * (modelMatcher.test.ts, recordResolution.test.ts); the seed-pinned
 * equivalence property pins the projection against buildRequestBody.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import type { ModelParametersRecord, ParameterConfigLayer } from "../../../../shared/config/parameterResolution";
import {
	DEFAULT_MAX_TOKENS_CAP,
	PROVIDER_OWNED_KEYS,
	parameterSkipReason,
	projectEffectiveParameters,
	resolveMaxTokens,
	resolveModelParameters,
} from "../../../../shared/config/parameterResolution";

/**
 * The docs' worked example, verbatim: the same family configured two ways.
 * Every row of the results table below is pinned against this record.
 */
const WORKED_EXAMPLE: ModelParametersRecord = {
	"*": { temperature: 0.7, top_p: 0.9, _inheritable: true },
	"gpt-5*": { temperature: 0.3, _inheritable: true, _inherit_from: false },
	"gpt-5.6": { max_tokens: 8192 },
	"claude*": { max_tokens: 4000 },
	"claude-4": { temperature: 1.0 },
};

function paramsFor(rawModelId: string, globalParameters: ModelParametersRecord): Record<string, unknown> {
	return resolveModelParameters({ rawModelId, globalParameters }).params;
}

describe("shared/config parameterResolution parameterSkipReason", () => {
	test("classifies underscore keys, provider-owned keys, and pass-through keys", () => {
		assert.strictEqual(parameterSkipReason("_replaceDefaults"), "underscore");
		assert.strictEqual(parameterSkipReason("_"), "underscore");
		for (const key of PROVIDER_OWNED_KEYS) {
			assert.strictEqual(parameterSkipReason(key), "provider-owned", key);
		}
		assert.strictEqual(parameterSkipReason("temperature"), undefined);
	});
});

describe("shared/config parameterResolution: the canonical worked example", () => {
	test("gpt-5.6 inherits what reaches it: the barrier's temperature, never the catch-all's top_p", () => {
		assert.deepStrictEqual(paramsFor("gpt-5.6", WORKED_EXAMPLE), { max_tokens: 8192, temperature: 0.3 });
	});

	test("gpt-5 and gpt-5.7 get the self-contained gpt-5* record; the catch-all stops there", () => {
		assert.deepStrictEqual(paramsFor("gpt-5", WORKED_EXAMPLE), { temperature: 0.3 });
		assert.deepStrictEqual(paramsFor("gpt-5.7", WORKED_EXAMPLE), { temperature: 0.3 });
	});

	test("claude-4: own temperature wins, top_p crosses the silent claude* record, its max_tokens does not", () => {
		assert.deepStrictEqual(paramsFor("claude-4", WORKED_EXAMPLE), { temperature: 1.0, top_p: 0.9 });
	});

	test("claude-4.1: claude* wholesale plus the catch-all's inheritable fields it leaves unset", () => {
		assert.deepStrictEqual(paramsFor("claude-4.1", WORKED_EXAMPLE), {
			max_tokens: 4000,
			temperature: 0.7,
			top_p: 0.9,
		});
	});

	test("anything else: the catch-all is the best match itself", () => {
		assert.deepStrictEqual(paramsFor("mistral-large", WORKED_EXAMPLE), { temperature: 0.7, top_p: 0.9 });
	});
});

describe("shared/config parameterResolution: the exclusive-list bypass example", () => {
	test('naming only ["gpt-5*"] takes exactly the named record, nothing else', () => {
		const records = {
			...WORKED_EXAMPLE,
			"gpt-5.6": { max_tokens: 8192, _inherit_from: ["gpt-5*"] },
		};
		assert.deepStrictEqual(paramsFor("gpt-5.6", records), { max_tokens: 8192, temperature: 0.3 });
	});

	test('naming ["gpt-5*", "*"] reaches around the barrier to the catch-all', () => {
		const records = {
			...WORKED_EXAMPLE,
			"gpt-5.6": { max_tokens: 8192, _inherit_from: ["gpt-5*", "*"] },
		};
		assert.deepStrictEqual(paramsFor("gpt-5.6", records), {
			max_tokens: 8192,
			temperature: 0.3,
			top_p: 0.9,
		});
	});
});

describe("shared/config parameterResolution resolveModelParameters", () => {
	test("the entry layer beats the global layer field by field, each chain resolved first", () => {
		const resolved = resolveModelParameters({
			rawModelId: "gpt-5.6",
			globalParameters: { "gpt-5*": { temperature: 0.8, top_p: 0.9 } },
			entryParameters: { "gpt-5.6": { temperature: 0.2 } },
		});
		assert.deepStrictEqual(resolved.params, { top_p: 0.9, temperature: 0.2 });
		assert.deepStrictEqual(resolved.sources.get("temperature")?.source, { layer: "entry", key: "gpt-5.6" });
		assert.deepStrictEqual(resolved.sources.get("temperature")?.shadowed, [
			{ layer: "global", key: "gpt-5*", value: 0.8 },
		]);
		assert.deepStrictEqual(resolved.sources.get("top_p")?.source, { layer: "global", key: "gpt-5*" });
	});

	test("an inherited field is attributed to its writer, with inheritedFrom as the signal", () => {
		const resolved = resolveModelParameters({
			rawModelId: "gpt-5.6",
			globalParameters: {
				"*": { top_p: 0.9, _inheritable: true },
				"gpt-5*": { temperature: 0.3 },
			},
		});
		const topP = resolved.sources.get("top_p");
		assert.deepStrictEqual(topP?.source, { layer: "global", key: "*" });
		assert.strictEqual(topP?.inheritedFrom, "*");
		assert.strictEqual(resolved.sources.get("temperature")?.inheritedFrom, undefined, "own fields are not inherited");
	});

	test("forced fields ride into forcedParams, and a global force beats a plain entry value", () => {
		const resolved = resolveModelParameters({
			rawModelId: "m1",
			globalParameters: { m1: { temperature: 1, seed: 5, _force: ["temperature"] } },
			entryParameters: { m1: { temperature: 0.2, seed: 9 } },
		});
		assert.deepStrictEqual(resolved.forcedParams, { temperature: 1 });
		assert.strictEqual(resolved.params.temperature, 1, "the forced global value wins the merge");
		assert.strictEqual(resolved.params.seed, 9, "unforced keys keep the entry-over-global rule");
		assert.strictEqual(resolved.sources.get("temperature")?.forced, true);
		assert.deepStrictEqual(resolved.sources.get("temperature")?.shadowed, [{ layer: "entry", key: "m1", value: 0.2 }]);
	});

	test("a forced entry field beats a forced global field", () => {
		const resolved = resolveModelParameters({
			rawModelId: "m1",
			globalParameters: { m1: { temperature: 1, _force: true } },
			entryParameters: { m1: { temperature: 0.2, _force: true } },
		});
		assert.deepStrictEqual(resolved.forcedParams, { temperature: 0.2 });
	});

	test("a forced field inherited along the chain stays forced at the receiving model", () => {
		const resolved = resolveModelParameters({
			rawModelId: "gpt-5.6",
			globalParameters: {
				"gpt*": { temperature: 1, _force: true, _inheritable: true },
				"gpt-5.6": { max_tokens: 100 },
			},
		});
		assert.deepStrictEqual(resolved.forcedParams, { temperature: 1 });
		assert.strictEqual(resolved.sources.get("temperature")?.forced, true);
		assert.strictEqual(resolved.sources.get("temperature")?.inheritedFrom, "gpt*");
	});

	test("forcing a provider-owned or underscore key is refused with the unforceable-key diagnostic", () => {
		const resolved = resolveModelParameters({
			rawModelId: "m1",
			globalParameters: {
				m1: { model: "x", _hidden: 1, temperature: 0.5, _force: ["model", "_hidden", "temperature"] },
			},
		});
		assert.deepStrictEqual(resolved.forcedParams, { temperature: 0.5 });
		assert.deepStrictEqual(resolved.diagnostics.map((d) => `${d.kind}:${d.key}`).sort(), [
			"unforceable-key:_hidden",
			"unforceable-key:model",
		]);
	});

	test("max_tokens is the one provider-owned key _force may mark: settable, so forceable", () => {
		const listed = resolveModelParameters({
			rawModelId: "m1",
			globalParameters: { m1: { max_tokens: 9000, _force: ["max_tokens"] } },
		});
		assert.deepStrictEqual(listed.forcedParams, { max_tokens: 9000 });
		assert.deepStrictEqual(listed.diagnostics, []);

		const viaTrue = resolveModelParameters({
			rawModelId: "m1",
			globalParameters: { m1: { max_tokens: 9000, model: "x", _force: true } },
		});
		assert.deepStrictEqual(viaTrue.forcedParams, { max_tokens: 9000 }, "the other provider-owned keys stay out");
	});

	test("_force: true forces only wire-eligible fields; provider-owned keys stay out silently", () => {
		const resolved = resolveModelParameters({
			rawModelId: "m1",
			globalParameters: { m1: { model: "x", temperature: 0.5, _force: true } },
		});
		assert.deepStrictEqual(resolved.forcedParams, { temperature: 0.5 });
		assert.deepStrictEqual(resolved.diagnostics, []);
	});

	test("diagnostics carry their layer; both layers' matching chains report", () => {
		const resolved = resolveModelParameters({
			rawModelId: "m1",
			globalParameters: { m1: { temperature: 1, _force: "yes" } },
			entryParameters: { m1: { _fallback: true, temperature: 2 } },
		});
		const describe = (layer: ParameterConfigLayer, kind: string, key: string) => `${layer}:${kind}:${key}`;
		assert.deepStrictEqual(resolved.diagnostics.map((d) => describe(d.layer, d.kind, d.key)).sort(), [
			"entry:wrong-record-type:_fallback",
			"global:invalid-directive:_force",
		]);
	});

	test('a hostile "__proto__" record key is an underscore key: silently ignored, never polluting', () => {
		const record = JSON.parse('{"m1": {"__proto__": {"polluted": true}, "temperature": 0.5}}');
		const resolved = resolveModelParameters({ rawModelId: "m1", globalParameters: record });
		assert.deepStrictEqual(resolved.params, { temperature: 0.5 });
		assert.ok(!Object.hasOwn(resolved.params, "__proto__"), "underscore keys never become fields");
		assert.strictEqual(({} as Record<string, unknown>).polluted, undefined, "no prototype pollution");
		assert.strictEqual(parameterSkipReason("__proto__"), "underscore", "and the wire would drop it anyway");
	});
});

describe("shared/config parameterResolution resolveMaxTokens", () => {
	test("the chain: runtime, configured, declared as-is, else min(cap, model max)", () => {
		assert.deepStrictEqual(
			resolveMaxTokens({
				runtimeMaxTokens: 111,
				configuredMaxTokens: 222,
				maxOutputTokens: 999,
				outputLimitDeclared: true,
			}),
			{ value: 111, source: "runtime" }
		);
		assert.deepStrictEqual(
			resolveMaxTokens({
				runtimeMaxTokens: undefined,
				configuredMaxTokens: 222,
				maxOutputTokens: 999,
				outputLimitDeclared: true,
			}),
			{ value: 222, source: "configured" }
		);
		assert.deepStrictEqual(
			resolveMaxTokens({
				runtimeMaxTokens: undefined,
				configuredMaxTokens: 22200,
				maxOutputTokens: 999,
				outputLimitDeclared: false,
			}),
			{ value: 22200, source: "configured" },
			"a user-set max_tokens goes out exactly as written, above the model max and the cap alike"
		);
		assert.deepStrictEqual(
			resolveMaxTokens({
				runtimeMaxTokens: undefined,
				configuredMaxTokens: undefined,
				maxOutputTokens: 32000,
				outputLimitDeclared: true,
			}),
			{ value: 32000, source: "declared" }
		);
		assert.deepStrictEqual(
			resolveMaxTokens({
				runtimeMaxTokens: undefined,
				configuredMaxTokens: undefined,
				maxOutputTokens: 32000,
				outputLimitDeclared: false,
			}),
			{ value: Math.min(DEFAULT_MAX_TOKENS_CAP, 32000), source: "capped-default" }
		);
		assert.deepStrictEqual(
			resolveMaxTokens({
				runtimeMaxTokens: undefined,
				configuredMaxTokens: undefined,
				maxOutputTokens: 2000,
				outputLimitDeclared: false,
			}),
			{ value: 2000, source: "capped-default" }
		);
		assert.strictEqual(DEFAULT_MAX_TOKENS_CAP, 4096, "the pinned cap literal");
	});

	test("a forced max_tokens tops the chain, beating even a runtime option", () => {
		assert.deepStrictEqual(
			resolveMaxTokens({
				forcedMaxTokens: 9000,
				runtimeMaxTokens: 1000,
				configuredMaxTokens: 2000,
				maxOutputTokens: 32000,
				outputLimitDeclared: true,
			}),
			{ value: 9000, source: "forced" }
		);
		assert.deepStrictEqual(
			resolveMaxTokens({
				forcedMaxTokens: 9000,
				runtimeMaxTokens: 1000,
				configuredMaxTokens: undefined,
				maxOutputTokens: 2000,
				outputLimitDeclared: false,
			}),
			{ value: 9000, source: "forced" },
			"a forced value counts as user-set: the min(4096, guess) cap never touches it"
		);
	});

	test("non-numeric runtime and configured values are ignored, never coerced", () => {
		assert.deepStrictEqual(
			resolveMaxTokens({
				runtimeMaxTokens: "1000",
				configuredMaxTokens: null,
				maxOutputTokens: 2000,
				outputLimitDeclared: false,
			}),
			{ value: 2000, source: "capped-default" }
		);
	});
});

describe("shared/config parameterResolution projectEffectiveParameters", () => {
	test("rows carry provenance, inheritance, and the sent/skip classification, sorted by name", () => {
		const projection = projectEffectiveParameters({
			rawModelId: "gpt-5.6",
			globalParameters: {
				"*": { top_p: 0.9, _inheritable: true },
				"gpt-5*": { temperature: 0.3, _reserved: 1, stream: false },
			},
			maxOutputTokens: 32000,
			outputLimitDeclared: true,
		});
		assert.deepStrictEqual(
			projection.rows.map((row) => `${row.name}:${row.sent ? "sent" : (row.skipReason ?? "?")}`),
			["stream:provider-owned", "temperature:sent", "top_p:sent"],
			"unknown underscore keys are reserved and never surface as rows"
		);
		const topP = projection.rows.find((row) => row.name === "top_p");
		assert.strictEqual(topP?.inheritedFrom, "*");
		assert.deepStrictEqual(projection.maxTokens, { value: 32000, source: "declared" });
	});

	test("a numeric configured max_tokens becomes the derivation, not a row; a non-numeric one stays a row", () => {
		const numeric = projectEffectiveParameters({
			rawModelId: "m1",
			globalParameters: { m1: { max_tokens: 1234 } },
			maxOutputTokens: 32000,
			outputLimitDeclared: false,
		});
		assert.deepStrictEqual(numeric.rows, []);
		assert.deepStrictEqual(numeric.maxTokens, {
			value: 1234,
			source: "configured",
			configuredSource: { layer: "global", key: "m1" },
		});

		const junk = projectEffectiveParameters({
			rawModelId: "m1",
			globalParameters: { m1: { max_tokens: "lots" } },
			maxOutputTokens: 32000,
			outputLimitDeclared: false,
		});
		assert.strictEqual(junk.rows[0]?.name, "max_tokens");
		assert.strictEqual(junk.rows[0]?.sent, false);
		assert.deepStrictEqual(junk.maxTokens, { value: 4096, source: "capped-default" });
	});

	test("a forced max_tokens projects as the forced derivation with its attribution", () => {
		const projection = projectEffectiveParameters({
			rawModelId: "m1",
			globalParameters: { m1: { max_tokens: 9000, _force: true } },
			maxOutputTokens: 32000,
			outputLimitDeclared: true,
		});
		assert.deepStrictEqual(projection.rows, []);
		assert.deepStrictEqual(projection.maxTokens, {
			value: 9000,
			source: "forced",
			configuredSource: { layer: "global", key: "m1" },
		});
	});
});
