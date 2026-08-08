/**
 * The attach-side override application and `_declare` synthesis: coherent
 * rebuilds (token constraints, capability flags, the reasoning control,
 * outputLimitSource promotion, pricing precedence), the object-identity fast
 * path when no configuration matches, inertness against the DISCOVERED raw-ID
 * set, and collision suppression against reserved exposed IDs. The
 * seed-pinned equivalence twin lives in capabilityOverrides.property.test.ts.
 */
import * as assert from "node:assert";
import type { CapabilityOverrideOptions } from "../../../provider/catalog/capabilityOverrides";
import { applyCapabilityOverrides, synthesizeDeclaredModels } from "../../../provider/catalog/capabilityOverrides";
import { REASONING_EFFORT_SCHEMA } from "../../../provider/catalog/modelConfiguration";
import { buildModelInfos } from "../../../provider/catalog/registration";
import type { LiteLLMModelItem } from "../../../provider/catalog/schemas";
import type { CapabilityCatalogLookup, CatalogLookupResult } from "../../../shared/config/capabilityResolution";
import { EMPTY_CATALOG_LOOKUP } from "../../../shared/config/capabilityResolution";
import { makeModelInfo } from "../../testUtils";

const SERVER = { id: "srv1", label: "Default", baseUrl: "http://litellm.test", apiKey: "k" };
const SCOPE = "http://litellm.test";

function options(overrides: Partial<CapabilityOverrideOptions> = {}): CapabilityOverrideOptions {
	return {
		globalCapabilities: {},
		entryCapabilities: undefined,
		catalog: EMPTY_CATALOG_LOOKUP,
		log: () => {},
		...overrides,
	};
}

function catalogOf(entries: Record<string, CatalogLookupResult>): CapabilityCatalogLookup {
	const answer = (id: string): CatalogLookupResult => entries[id] ?? { kind: "not-found" };
	return { byExactId: answer, byRawModelId: answer };
}

/** A registered deployment entry for `id`, built through the production registration path. */
function registered(item: LiteLLMModelItem) {
	const { infos } = buildModelInfos([item], SERVER, 1, () => {});
	const info = infos[0];
	assert.ok(info !== undefined);
	return info;
}

const DEPLOYMENT_PROVIDER = {
	provider: "openai",
	status: "ok",
	supports_tools: true,
	context_length: 200000,
	max_output_tokens: 32000,
	max_input_tokens: 180000,
	input_cost_per_token: 0.000003,
	output_cost_per_token: 0.000015,
} as const;

const DEPLOYMENT: LiteLLMModelItem = {
	id: "gpt-test",
	shape: { kind: "deployment", provider: DEPLOYMENT_PROVIDER },
	architecture: { input_modalities: ["text", "image"] },
};

suite("provider/catalog/capabilityOverrides", () => {
	suite("applyCapabilityOverrides", () => {
		test("no matching configuration returns the input array and elements by identity", () => {
			const infos = [registered(DEPLOYMENT)];
			const out = applyCapabilityOverrides(infos, SERVER, options());
			assert.strictEqual(out, infos, "an untouched pass must not copy the array");
			assert.strictEqual(out[0], infos[0], "an untouched model must keep its identity");
		});

		test("a stored copy overridden under an earlier configuration heals once the override is removed", () => {
			// The status window's stale-served models were rebuilt under the OLD
			// configuration; the fast path must verify the advertisement instead
			// of freezing the removed override in place.
			const overridden = applyCapabilityOverrides(
				[registered(DEPLOYMENT)],
				SERVER,
				options({ globalCapabilities: { "gpt-test": { max_output_tokens: 4000, supports_reasoning: true } } })
			);
			assert.strictEqual(overridden[0]?.maxOutputTokens, 4000);
			const healed = applyCapabilityOverrides(overridden, SERVER, options());
			assert.strictEqual(healed[0]?.maxOutputTokens, 32000, "the server-declared limit returns");
			assert.strictEqual(healed[0]?.litellm.outputLimitSource, "provider");
			assert.strictEqual(healed[0]?.configurationSchema, undefined, "the promoted control is demoted again");
		});

		test("a fallback-provided field triggers the rebuild path, never the identity fast path", () => {
			// The fast path's level classification is total over CapabilityLevel
			// (LEVEL_TRIGGERS_REBUILD); this pins the fallback levels in it. The
			// server declares no output limit, so registration advertised the
			// floor fill, and the _fallback value must rebuild the model.
			const undeclaredOutput: LiteLLMModelItem = {
				id: "gpt-test",
				shape: {
					kind: "deployment",
					provider: { provider: "openai", status: "ok", supports_tools: true, max_input_tokens: 180000 },
				},
			};
			const infos = [registered(undeclaredOutput)];
			const out = applyCapabilityOverrides(
				infos,
				SERVER,
				options({ globalCapabilities: { "gpt-test": { _fallback: true, max_output_tokens: 23456 } } })
			);
			assert.notStrictEqual(out[0], infos[0], "a fallback-resolved field must not take the identity fast path");
			assert.strictEqual(out[0]?.maxOutputTokens, 23456);
			assert.strictEqual(out[0]?.litellm.outputLimitSource, "user", "a fallback value counts as user-set");
		});

		test("a foreign prefix and a foreign scope both leave the model untouched", () => {
			const infos = [registered(DEPLOYMENT)];
			const out = applyCapabilityOverrides(
				infos,
				SERVER,
				options({
					globalCapabilities: {
						other: { max_output_tokens: 1 },
						"http://elsewhere.test/gpt": { max_output_tokens: 2 },
					},
				})
			);
			assert.strictEqual(out, infos);
		});

		test("an override rebuilds token constraints, flags, and provenance coherently", () => {
			const infos = [registered(DEPLOYMENT)];
			const out = applyCapabilityOverrides(
				infos,
				SERVER,
				options({
					globalCapabilities: {
						"gpt-": {
							max_output_tokens: 4000,
							max_input_tokens: 100000,
							supports_vision: false,
							supports_function_calling: false,
							supports_audio_input: true,
						},
					},
				})
			);
			const patched = out[0];
			assert.ok(patched !== undefined);
			assert.strictEqual(patched.maxOutputTokens, 4000);
			assert.strictEqual(patched.maxInputTokens, 100000);
			assert.strictEqual(patched.capabilities?.toolCalling, false);
			assert.strictEqual(patched.capabilities?.imageInput, false);
			assert.strictEqual(patched.litellm.supportsAudioInput, true);
			assert.strictEqual(patched.litellm.outputLimitSource, "user", "an overridden output limit is user-set");
			assert.deepStrictEqual(patched.litellm.serverDeclared, infos[0]?.litellm.serverDeclared, "the baseline rides");
			assert.strictEqual(patched.name, infos[0]?.name, "display identity is untouched");
		});

		test("an override on another field keeps the server-declared output provenance", () => {
			const out = applyCapabilityOverrides(
				[registered(DEPLOYMENT)],
				SERVER,
				options({ globalCapabilities: { "gpt-test": { supports_vision: false } } })
			);
			assert.strictEqual(out[0]?.litellm.outputLimitSource, "provider");
			assert.strictEqual(out[0]?.maxOutputTokens, 32000, "the server-declared limit stays");
		});

		test("the scoped global record replaces the unscoped one whole", () => {
			const out = applyCapabilityOverrides(
				[registered(DEPLOYMENT)],
				SERVER,
				options({
					globalCapabilities: {
						"gpt-test": { max_output_tokens: 1111, supports_vision: false },
						[`${SCOPE}/gpt-test`]: { max_output_tokens: 2222 },
					},
				})
			);
			assert.strictEqual(out[0]?.maxOutputTokens, 2222);
			assert.strictEqual(out[0]?.capabilities?.imageInput, true, "the replaced record's other fields do not apply");
		});

		test("the entry record wins key by key over the global one", () => {
			const out = applyCapabilityOverrides(
				[registered(DEPLOYMENT)],
				SERVER,
				options({
					globalCapabilities: { "gpt-test": { max_output_tokens: 1111, supports_vision: false } },
					entryCapabilities: { "gpt-test": { max_output_tokens: 3333 } },
				})
			);
			assert.strictEqual(out[0]?.maxOutputTokens, 3333);
			assert.strictEqual(out[0]?.capabilities?.imageInput, false, "the global record's other keys still apply");
		});

		test("reasoning promotion adds the effort schema and demotion removes it", () => {
			const reasoningItem: LiteLLMModelItem = {
				...DEPLOYMENT,
				shape: { kind: "deployment", provider: { ...DEPLOYMENT_PROVIDER, supports_reasoning: true } },
			};
			const withSchema = registered(reasoningItem);
			assert.deepStrictEqual(withSchema.configurationSchema, REASONING_EFFORT_SCHEMA);
			const demoted = applyCapabilityOverrides(
				[withSchema],
				SERVER,
				options({ globalCapabilities: { "gpt-test": { supports_reasoning: false } } })
			);
			assert.strictEqual(demoted[0]?.configurationSchema, undefined, "demotion removes the control");

			const withoutSchema = registered(DEPLOYMENT);
			assert.strictEqual(withoutSchema.configurationSchema, undefined);
			const promoted = applyCapabilityOverrides(
				[withoutSchema],
				SERVER,
				options({ globalCapabilities: { "gpt-test": { supports_reasoning: true } } })
			);
			assert.deepStrictEqual(promoted[0]?.configurationSchema, REASONING_EFFORT_SCHEMA, "promotion adds the control");
		});

		test("server pricing beats catalog pricing; catalog pricing fills models without any", () => {
			const priced = registered(DEPLOYMENT);
			assert.strictEqual(priced.inputCost, 3);
			const catalog = catalogOf({
				"gpt-test": {
					kind: "found",
					id: "gpt-test",
					fields: {},
					pricing: { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
				},
			});
			const kept = applyCapabilityOverrides(
				[priced],
				SERVER,
				options({ catalog, globalCapabilities: { "gpt-test": { supports_vision: false } } })
			);
			assert.strictEqual(kept[0]?.inputCost, 3, "server pricing is never displaced");
			assert.strictEqual(kept[0]?.outputCost, 15);

			const bare: LiteLLMModelItem = { id: "gpt-test", shape: { kind: "bare" } };
			const filled = applyCapabilityOverrides([registered(bare)], SERVER, options({ catalog }));
			assert.strictEqual(filled[0]?.inputCost, 1, "an implicit catalog match prices an unpriced model");
			assert.strictEqual(filled[0]?.outputCost, 2);
		});

		test("directive pricing beats the implicit match's pricing", () => {
			const catalog = catalogOf({
				"cat/entry": {
					kind: "found",
					id: "cat/entry",
					fields: {},
					pricing: { input_cost_per_token: 0.00001, output_cost_per_token: 0.00002 },
				},
				"gpt-test": {
					kind: "found",
					id: "gpt-test",
					fields: {},
					pricing: { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
				},
			});
			const bare: LiteLLMModelItem = { id: "gpt-test", shape: { kind: "bare" } };
			const out = applyCapabilityOverrides(
				[registered(bare)],
				SERVER,
				options({ catalog, globalCapabilities: { "gpt-test": { _openrouter_model: "cat/entry" } } })
			);
			assert.strictEqual(out[0]?.inputCost, 10);
			assert.strictEqual(out[0]?.outputCost, 20);
		});

		test("catalog-applied pricing never latches: a removed directive strips it on the next pass", () => {
			// Stale-served window copies re-decorate through this pass; without
			// the catalogPricing marker the old catalog price would read as
			// server pricing and survive its directive's removal.
			const catalog = catalogOf({
				"cat/entry": {
					kind: "found",
					id: "cat/entry",
					fields: {},
					pricing: { input_cost_per_token: 0.00001, output_cost_per_token: 0.00002 },
				},
			});
			const bare: LiteLLMModelItem = { id: "gpt-test", shape: { kind: "bare" } };
			const priced = applyCapabilityOverrides(
				[registered(bare)],
				SERVER,
				options({ catalog, globalCapabilities: { "gpt-test": { _openrouter_model: "cat/entry" } } })
			);
			assert.strictEqual(priced[0]?.inputCost, 10);
			assert.strictEqual(priced[0]?.litellm.catalogPricing, true);

			const stripped = applyCapabilityOverrides(priced, SERVER, options({ catalog }));
			assert.strictEqual(stripped[0]?.inputCost, undefined, "the directive is gone, so its price must go too");
			assert.strictEqual(stripped[0]?.priceCategory, undefined);
			assert.strictEqual(stripped[0]?.litellm.catalogPricing, undefined);
		});

		test("record problems log one classification per distinct problem, not one per model", () => {
			const logged: string[] = [];
			applyCapabilityOverrides(
				[makeModelInfo({ id: "a-model" }), makeModelInfo({ id: "a-second" })],
				SERVER,
				options({
					globalCapabilities: { "a-": { bogus_key: 1, supports_vision: true } },
					log: (message) => logged.push(message),
				})
			);
			assert.deepStrictEqual(logged, ["Ignoring a modelCapabilities record problem"]);
		});
	});

	suite("synthesizeDeclaredModels", () => {
		test("a declared ID becomes a model with the badge, its baseline, and a route", () => {
			const { infos, routes } = synthesizeDeclaredModels(
				new Set(),
				new Set(),
				SERVER,
				1,
				options({
					globalCapabilities: {
						[`${SCOPE}/my-model`]: { _declare: true, context_length: 64000, max_output_tokens: 8000 },
					},
				})
			);
			const declared = infos[0];
			assert.ok(declared !== undefined);
			assert.strictEqual(infos.length, 1);
			assert.strictEqual(declared.id, "my-model");
			assert.strictEqual(declared.litellm.declared, true);
			assert.deepStrictEqual(declared.litellm.serverDeclared, { kind: "declared" });
			assert.strictEqual(declared.maxOutputTokens, 8000);
			assert.strictEqual(declared.maxInputTokens, 56000, "derived from the effective context minus output");
			assert.strictEqual(declared.litellm.outputLimitSource, "user", "declared limits are user-set");
			assert.strictEqual(declared.capabilities?.toolCalling, true, "the floor keeps tools on");
			assert.strictEqual(declared.capabilities?.imageInput, false);
			assert.deepStrictEqual(routes.get("my-model"), {
				serverId: SERVER.id,
				rawModelId: "my-model",
				serverLabel: SERVER.label,
			});
		});

		test("a declared ID discovery listed stays inert, even when only synthetic variants registered", () => {
			const { infos } = synthesizeDeclaredModels(
				new Set(["foo"]),
				new Set(["foo:cheapest", "foo:fastest"]),
				SERVER,
				1,
				options({ entryCapabilities: { foo: { _declare: true } } })
			);
			assert.deepStrictEqual(infos, [], "the DISCOVERED raw-ID set decides inertness, not the registered set");
		});

		test("a declared ID colliding with a reserved exposed ID is suppressed with a warning", () => {
			const logged: { message: string; data: unknown }[] = [];
			const { infos } = synthesizeDeclaredModels(
				new Set(["foo"]),
				new Set(["foo:cheapest", "foo:fastest"]),
				SERVER,
				1,
				options({
					entryCapabilities: { "foo:cheapest": { _declare: true } },
					log: (message, data) => logged.push({ message, data }),
				})
			);
			assert.deepStrictEqual(infos, []);
			assert.strictEqual(logged.length, 1);
			assert.ok(logged[0]?.message.includes("Suppressing a _declare directive"));
		});

		test("the floor backstops a bare _declare, with the conservative outputLimitSource", () => {
			const { infos } = synthesizeDeclaredModels(
				new Set(),
				new Set(),
				SERVER,
				1,
				options({ entryCapabilities: { "bare-model": { _declare: true } } })
			);
			const declared = infos[0];
			assert.ok(declared !== undefined);
			assert.strictEqual(declared.maxOutputTokens, 16000);
			assert.strictEqual(declared.maxInputTokens, 112000);
			assert.strictEqual(declared.litellm.outputLimitSource, "defaults", "a floor limit keeps the request cap");
		});

		test("multi-server synthesis namespaces the exposed ID like registration", () => {
			const { infos, routes } = synthesizeDeclaredModels(
				new Set(),
				new Set(),
				SERVER,
				2,
				options({ entryCapabilities: { "my-model": { _declare: true } } })
			);
			assert.strictEqual(infos[0]?.id, "srv1/my-model");
			assert.strictEqual(infos[0]?.name, "[Default] my-model");
			assert.strictEqual(routes.get("srv1/my-model")?.rawModelId, "my-model");
		});

		test("an unscoped global _declare creates nothing and logs the diagnostic", () => {
			const logged: string[] = [];
			const { infos } = synthesizeDeclaredModels(
				new Set(),
				new Set(),
				SERVER,
				1,
				options({
					globalCapabilities: { "my-model": { _declare: true } },
					log: (message) => logged.push(message),
				})
			);
			assert.deepStrictEqual(infos, []);
			assert.deepStrictEqual(logged, ["Ignoring a modelCapabilities record problem"]);
		});
	});
});
