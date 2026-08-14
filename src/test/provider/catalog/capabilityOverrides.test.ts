/**
 * The attach-side override application and declared-model synthesis: coherent
 * rebuilds (token constraints, capability flags, the reasoning gate over the
 * flag and the supported-params list, the caching gate, pricing re-derived
 * from the effective cost fields, outputLimitSource promotion, stale-pricing
 * healing), the object-identity fast path when no consumed configuration
 * matches, inertness against the DISCOVERED raw-ID set, and collision
 * suppression against reserved exposed IDs. The seed-pinned equivalence twin
 * lives in capabilityOverrides.property.test.ts.
 */
import * as assert from "node:assert";
import type { CapabilityOverrideOptions } from "../../../provider/catalog/capabilityOverrides";
import { applyCapabilityOverrides, synthesizeDeclaredModels } from "../../../provider/catalog/capabilityOverrides";
import { DEFAULT_REASONING_EFFORT_LEVELS, reasoningEffortSchema } from "../../../provider/catalog/modelConfiguration";
import { buildModelInfos } from "../../../provider/catalog/registration";
import type { LiteLLMModelItem } from "../../../provider/catalog/schemas";
import { EMPTY_CATALOG_LOOKUP } from "../../../shared/config/capabilityResolution";
import { ModelResolutionTable } from "../../../shared/config/resolutionTable";
import { makeModelInfo } from "../../pureHelpers";

/** The menu the built-in default level list produces; fixtures here carry no per-level server flags. */
const REASONING_EFFORT_SCHEMA = reasoningEffortSchema(DEFAULT_REASONING_EFFORT_LEVELS);

const SERVER = { id: "srv1", label: "Default", baseUrl: "http://litellm.test", apiKey: "k" };
const SCOPE = "http://litellm.test";

function options(overrides: Partial<CapabilityOverrideOptions> = {}): CapabilityOverrideOptions {
	return {
		globalCapabilities: {},
		entryCapabilities: undefined,
		catalog: EMPTY_CATALOG_LOOKUP,
		resolution: new ModelResolutionTable(),
		log: () => {},
		logAdvisory: () => {},
		...overrides,
	};
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

		test("an extras-only configuration keeps the identity fast path: the rebuild reads core fields only", () => {
			const infos = [registered(DEPLOYMENT)];
			const out = applyCapabilityOverrides(
				infos,
				SERVER,
				options({ globalCapabilities: { "gpt-test": { mode: "chat", litellm_provider: { name: "openai" } } } })
			);
			assert.strictEqual(out, infos, "open extras feed no registered artifact, so nothing rebuilds");
			assert.strictEqual(out[0], infos[0]);
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
						"gpt-*": {
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

		test("a URL-scoped global key is inert; the plain matcher record applies", () => {
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
			assert.strictEqual(out[0]?.maxOutputTokens, 1111, "server scoping is gone from the global records");
			assert.strictEqual(out[0]?.capabilities?.imageInput, false);
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

		test("a reasoning_effort_levels record replaces the menu, unknown levels included", () => {
			const reasoningItem: LiteLLMModelItem = {
				...DEPLOYMENT,
				shape: { kind: "deployment", provider: { ...DEPLOYMENT_PROVIDER, supports_reasoning: true } },
			};
			const out = applyCapabilityOverrides(
				[registered(reasoningItem)],
				SERVER,
				options({ globalCapabilities: { "gpt-test": { reasoning_effort_levels: ["low", "high", "ultra"] } } })
			);
			assert.deepStrictEqual(
				out[0]?.configurationSchema,
				reasoningEffortSchema(["low", "high", "ultra"]),
				"the user's list is the menu, verbatim - the vocabulary is open"
			);
		});

		test("the entry's level list beats the global one, and a levels-only record on a gated-off model is inert", () => {
			const reasoningItem: LiteLLMModelItem = {
				...DEPLOYMENT,
				shape: { kind: "deployment", provider: { ...DEPLOYMENT_PROVIDER, supports_reasoning: true } },
			};
			const out = applyCapabilityOverrides(
				[registered(reasoningItem)],
				SERVER,
				options({
					globalCapabilities: { "gpt-test": { reasoning_effort_levels: ["low"] } },
					entryCapabilities: { "gpt-test": { reasoning_effort_levels: ["high", "max"] } },
				})
			);
			assert.deepStrictEqual(out[0]?.configurationSchema, reasoningEffortSchema(["high", "max"]));

			const gatedOff = applyCapabilityOverrides(
				[registered(DEPLOYMENT)],
				SERVER,
				options({ globalCapabilities: { "gpt-test": { reasoning_effort_levels: ["high", "max"] } } })
			);
			assert.strictEqual(
				gatedOff[0]?.configurationSchema,
				undefined,
				"the level list decides the menu's contents, never the control's existence"
			);
		});

		test("server-declared per-level flags register their menu directly and take the identity fast path", () => {
			const flagged: LiteLLMModelItem = {
				...DEPLOYMENT,
				shape: {
					kind: "deployment",
					provider: {
						...DEPLOYMENT_PROVIDER,
						supports_reasoning: true,
						reasoning_effort_levels: ["low", "high", "max"],
					},
				},
			};
			const infos = [registered(flagged)];
			assert.deepStrictEqual(
				infos[0]?.configurationSchema,
				reasoningEffortSchema(["low", "high", "max"]),
				"registration's schema is the server's flag-derived list"
			);
			const out = applyCapabilityOverrides(infos, SERVER, options());
			assert.strictEqual(out, infos, "the walk's server level re-derives the same menu, so nothing rebuilds");
		});

		test("a stale served menu heals once its level record is removed", () => {
			const flagged: LiteLLMModelItem = {
				...DEPLOYMENT,
				shape: {
					kind: "deployment",
					provider: {
						...DEPLOYMENT_PROVIDER,
						supports_reasoning: true,
						reasoning_effort_levels: ["low", "high"],
					},
				},
			};
			const overridden = applyCapabilityOverrides(
				[registered(flagged)],
				SERVER,
				options({ globalCapabilities: { "gpt-test": { reasoning_effort_levels: ["max"] } } })
			);
			assert.deepStrictEqual(overridden[0]?.configurationSchema, reasoningEffortSchema(["max"]));
			const healed = applyCapabilityOverrides(overridden, SERVER, options());
			assert.deepStrictEqual(
				healed[0]?.configurationSchema,
				reasoningEffortSchema(["low", "high"]),
				"the advertises check compares the menu itself, so the server's list returns"
			);
		});

		test("a stored copy carrying pricing the walk does not derive is healed by the verified rebuild", () => {
			// A stale-served window copy rebuilt under an earlier configuration
			// can carry price fields the current walk no longer justifies. No
			// marker is needed: advertisesEffective's pricing clause catches the
			// mismatch, the rebuild strips and re-derives, and the healed copy
			// settles on the fast path.
			const bare: LiteLLMModelItem = { id: "gpt-test", shape: { kind: "bare" } };
			const info = registered(bare);
			const stale = {
				...info,
				inputCost: 10,
				outputCost: 20,
				pricing: "$10 in / $20 out per 1M tokens",
			};
			const stripped = applyCapabilityOverrides([stale], SERVER, options());
			assert.strictEqual(stripped[0]?.inputCost, undefined, "unjustified pricing must not survive");
			assert.strictEqual(stripped[0]?.outputCost, undefined);
			assert.strictEqual(stripped[0]?.pricing, undefined);
			const healed = applyCapabilityOverrides(stripped, SERVER, options());
			assert.strictEqual(healed, stripped, "the healed copy is unpriced and takes the identity fast path");

			const server = applyCapabilityOverrides([registered(DEPLOYMENT)], SERVER, options());
			assert.strictEqual(server[0]?.inputCost, 3, "server-reported pricing rides untouched");
			assert.strictEqual(server[0]?.outputCost, 15);
		});

		test("a user cost record prices a discovered model, beating the server's cost", () => {
			const out = applyCapabilityOverrides(
				[registered(DEPLOYMENT)],
				SERVER,
				options({
					globalCapabilities: { "gpt-test": { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 } },
				})
			);
			const priced = out[0];
			assert.ok(priced !== undefined);
			assert.strictEqual(priced.inputCost, 1, "the user's per-token cost beats the server's 0.000003");
			assert.strictEqual(priced.outputCost, 2);
			assert.strictEqual(priced.pricing, "$1 in / $2 out per 1M tokens");
			assert.strictEqual(priced.priceCategory, "medium", "blended (3*1+2)/4 = 1.25 lands in the medium band");
		});

		test("a user 0/0 cost pair prices as genuinely free: $0 label and the cheapest badge", () => {
			const out = applyCapabilityOverrides(
				[registered(DEPLOYMENT)],
				SERVER,
				options({ globalCapabilities: { "gpt-test": { input_cost_per_token: 0, output_cost_per_token: 0 } } })
			);
			const free = out[0];
			assert.ok(free !== undefined);
			assert.strictEqual(free.inputCost, 0);
			assert.strictEqual(free.outputCost, 0);
			assert.strictEqual(free.pricing, "$0 in / $0 out per 1M tokens");
			assert.strictEqual(free.priceCategory, "low", "a genuinely free model earns the cheapest badge");
		});

		test("the server's 0/0 stamp stays undeclared: a rebuild adds no pricing fields", () => {
			const stamped: LiteLLMModelItem = {
				id: "gpt-test",
				shape: {
					kind: "deployment",
					provider: {
						...DEPLOYMENT_PROVIDER,
						input_cost_per_token: 0,
						output_cost_per_token: 0,
						cache_read_input_token_cost: 0.0000003,
					},
				},
			};
			const infos = [registered(stamped)];
			// An unrelated override forces the rebuild path; the stamp (and the
			// stray cache cost beside it) must not resurface as pricing.
			const out = applyCapabilityOverrides(
				infos,
				SERVER,
				options({ globalCapabilities: { "gpt-test": { supports_vision: false } } })
			);
			const rebuilt = out[0];
			assert.ok(rebuilt !== undefined);
			assert.notStrictEqual(rebuilt, infos[0], "the vision override forces the rebuild path");
			for (const key of ["inputCost", "outputCost", "cacheCost", "priceCategory", "pricing"] as const) {
				assert.ok(!(key in rebuilt), `the 0/0 stamp must rebuild with no ${key}`);
			}
		});

		test("server pricing re-derives byte-identical on a rebuild forced by an unrelated override", () => {
			const priced: LiteLLMModelItem = {
				id: "gpt-test",
				shape: {
					kind: "deployment",
					provider: {
						...DEPLOYMENT_PROVIDER,
						cache_read_input_token_cost: 0.0000003,
						cache_creation_input_token_cost: 0.00000375,
						long_context_input_cost_per_token: 0.000006,
						long_context_output_cost_per_token: 0.0000225,
						long_context_cache_read_input_token_cost: 0.0000003,
						long_context_cache_creation_input_token_cost: 0.0000075,
					},
				},
			};
			const infos = [registered(priced)];
			const out = applyCapabilityOverrides(
				infos,
				SERVER,
				options({ globalCapabilities: { "gpt-test": { supports_audio_input: true } } })
			);
			const rebuilt = out[0];
			const original = infos[0];
			assert.ok(rebuilt !== undefined && original !== undefined);
			assert.notStrictEqual(rebuilt, original, "the audio override forces the rebuild path");
			for (const key of [
				"inputCost",
				"outputCost",
				"cacheCost",
				"cacheWriteCost",
				"longContextInputCost",
				"longContextOutputCost",
				"longContextCacheCost",
				"longContextCacheWriteCost",
				"priceCategory",
				"pricing",
			] as const) {
				assert.strictEqual(rebuilt[key], original[key], `${key} must re-derive exactly as registration priced it`);
			}
			assert.strictEqual(rebuilt.longContextInputCost, 6, "the tier price differs from base, so it rides");
			assert.strictEqual(rebuilt.longContextOutputCost, 22.5);
			assert.strictEqual(rebuilt.longContextCacheWriteCost, 7.5);
			assert.ok(
				!("longContextCacheCost" in rebuilt),
				"a tier cost identical to its base is omitted, as at registration"
			);
		});

		test("a user override on one side of the pair leaves the server's other side priced", () => {
			const out = applyCapabilityOverrides(
				[registered(DEPLOYMENT)],
				SERVER,
				options({ globalCapabilities: { "gpt-test": { input_cost_per_token: 0.00001 } } })
			);
			const mixed = out[0];
			assert.ok(mixed !== undefined);
			assert.strictEqual(mixed.inputCost, 10, "the user's input cost wins");
			assert.strictEqual(mixed.outputCost, 15, "the server's output cost stays");
			assert.strictEqual(mixed.pricing, "$10 in / $15 out per 1M tokens");
		});

		test("a stored copy priced under a removed user cost record heals back to the server price", () => {
			// The pricing clause of advertisesEffective exists for exactly this:
			// a stale window copy rebuilt under an earlier configuration must
			// re-price from the server once the record is gone, then settle on
			// the identity fast path.
			const priced = applyCapabilityOverrides(
				[registered(DEPLOYMENT)],
				SERVER,
				options({
					globalCapabilities: { "gpt-test": { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 } },
				})
			);
			assert.strictEqual(priced[0]?.inputCost, 1);
			const healed = applyCapabilityOverrides(priced, SERVER, options());
			assert.strictEqual(healed[0]?.inputCost, 3, "the server price returns once the record is gone");
			assert.strictEqual(healed[0]?.outputCost, 15);
			assert.strictEqual(healed[0]?.pricing, "$3 in / $15 out per 1M tokens");
			const settled = applyCapabilityOverrides(healed, SERVER, options());
			assert.strictEqual(settled, healed, "the healed copy takes the identity fast path");
		});

		test("sub-unit dust re-derives byte-identical: no $0 label sneaks in through the rebuild", () => {
			// Both costs are real but round to 0 per million; registration
			// deliberately withholds the label and badge, and the effective-field
			// rebuild must reproduce that exactly (the relaxed zero-pair rule is
			// for RAW user-written 0/0 only), or the fast path could never hold.
			const dust: LiteLLMModelItem = {
				id: "gpt-test",
				shape: {
					kind: "deployment",
					provider: { ...DEPLOYMENT_PROVIDER, input_cost_per_token: 1e-13, output_cost_per_token: 2e-13 },
				},
			};
			const infos = [registered(dust)];
			assert.strictEqual(infos[0]?.inputCost, 0, "dust rounds to a 0 numeric field at registration");
			assert.strictEqual(infos[0]?.pricing, undefined, "but earns no label");
			const out = applyCapabilityOverrides(
				infos,
				SERVER,
				options({ globalCapabilities: { "gpt-test": { supports_audio_input: true } } })
			);
			assert.strictEqual(out[0]?.inputCost, 0);
			assert.strictEqual(out[0]?.outputCost, 0);
			assert.strictEqual(out[0]?.pricing, undefined, "the rebuild must not present dust as free");
			assert.strictEqual(out[0]?.priceCategory, undefined);
		});

		test("user-written dust gets no label either: only a RAW 0/0 pair reads as free", () => {
			const out = applyCapabilityOverrides(
				[registered(DEPLOYMENT)],
				SERVER,
				options({
					globalCapabilities: { "gpt-test": { input_cost_per_token: 1e-13, output_cost_per_token: 1e-13 } },
				})
			);
			const dusty = out[0];
			assert.ok(dusty !== undefined);
			assert.strictEqual(dusty.inputCost, 0, "the numeric fields round to 0");
			assert.strictEqual(dusty.outputCost, 0);
			assert.strictEqual(dusty.pricing, undefined, "a pair that merely rounds to 0/0 earns no label");
			assert.strictEqual(dusty.priceCategory, undefined);
		});

		test("a supports_prompt_caching override flips the caching gate both ways", () => {
			const promoted = applyCapabilityOverrides(
				[registered(DEPLOYMENT)],
				SERVER,
				options({ globalCapabilities: { "gpt-test": { supports_prompt_caching: true } } })
			);
			assert.strictEqual(promoted[0]?.litellm.supportsPromptCaching, true, "the override promotes the gate");

			const caching: LiteLLMModelItem = {
				id: "gpt-test",
				shape: { kind: "deployment", provider: { ...DEPLOYMENT_PROVIDER, supports_prompt_caching: true } },
			};
			const withCaching = registered(caching);
			assert.strictEqual(withCaching.litellm.supportsPromptCaching, true);
			const demoted = applyCapabilityOverrides(
				[withCaching],
				SERVER,
				options({ globalCapabilities: { "gpt-test": { supports_prompt_caching: false } } })
			);
			assert.strictEqual(demoted[0]?.litellm.supportsPromptCaching, false, "the override demotes the server's flag");
		});

		suite("reasoningGate", () => {
			test("the flag beats the params list at the same level", () => {
				// One record carries both signals: the explicit flag wins the tie,
				// matching the registration-side flag-beats-list rule.
				const out = applyCapabilityOverrides(
					[registered(DEPLOYMENT)],
					SERVER,
					options({
						globalCapabilities: {
							"gpt-test": { supports_reasoning: false, supported_openai_params: ["reasoning_effort"] },
						},
					})
				);
				assert.strictEqual(out[0]?.configurationSchema, undefined, "the flag's false beats the list's promotion");
			});

			test("a user params list outranks the floor's no-signal false", () => {
				// DEPLOYMENT reports no reasoning data, so the flag resolves at the
				// floor - a backstop, not a demotion - and the params list decides.
				const out = applyCapabilityOverrides(
					[registered(DEPLOYMENT)],
					SERVER,
					options({ globalCapabilities: { "gpt-test": { supported_openai_params: ["reasoning_effort"] } } })
				);
				assert.deepStrictEqual(out[0]?.configurationSchema, REASONING_EFFORT_SCHEMA);
			});

			test("a winning params list without reasoning_effort demotes the control", () => {
				const reasoningItem: LiteLLMModelItem = {
					...DEPLOYMENT,
					shape: { kind: "deployment", provider: { ...DEPLOYMENT_PROVIDER, supports_reasoning: true } },
				};
				const withSchema = registered(reasoningItem);
				assert.notStrictEqual(withSchema.configurationSchema, undefined);
				const out = applyCapabilityOverrides(
					[withSchema],
					SERVER,
					options({ globalCapabilities: { "gpt-test": { supported_openai_params: ["temperature"] } } })
				);
				assert.strictEqual(
					out[0]?.configurationSchema,
					undefined,
					"a user-declared params list at a higher level than the server flag decides"
				);
			});

			test("an empty params list is a real demotion signal when it wins", () => {
				const reasoningItem: LiteLLMModelItem = {
					...DEPLOYMENT,
					shape: { kind: "deployment", provider: { ...DEPLOYMENT_PROVIDER, supports_reasoning: true } },
				};
				const out = applyCapabilityOverrides(
					[registered(reasoningItem)],
					SERVER,
					options({ globalCapabilities: { "gpt-test": { supported_openai_params: [] } } })
				);
				assert.strictEqual(out[0]?.configurationSchema, undefined, "an empty list carries no reasoning_effort");
			});

			test("a params list in the entry record outranks a flag in the global record", () => {
				const out = applyCapabilityOverrides(
					[registered(DEPLOYMENT)],
					SERVER,
					options({
						globalCapabilities: { "gpt-test": { supports_reasoning: false } },
						entryCapabilities: { "gpt-test": { supported_openai_params: ["reasoning_effort"] } },
					})
				);
				assert.deepStrictEqual(
					out[0]?.configurationSchema,
					REASONING_EFFORT_SCHEMA,
					"entry beats global, whichever of the two fields each layer carries"
				);
			});

			test("a fallback-demoted params list loses to the server's flag", () => {
				const reasoningItem: LiteLLMModelItem = {
					...DEPLOYMENT,
					shape: { kind: "deployment", provider: { ...DEPLOYMENT_PROVIDER, supports_reasoning: true } },
				};
				const out = applyCapabilityOverrides(
					[registered(reasoningItem)],
					SERVER,
					options({
						globalCapabilities: { "gpt-test": { _fallback: true, supported_openai_params: ["temperature"] } },
					})
				);
				assert.deepStrictEqual(
					out[0]?.configurationSchema,
					REASONING_EFFORT_SCHEMA,
					"a _fallback list sits below the server level, so the server's flag keeps the control"
				);
			});
		});

		test("a pdf/schema-only configuration keeps the identity fast path", () => {
			// supports_pdf_input and supports_response_schema resolve and display
			// but feed no registered artifact yet, so they must not rebuild.
			const infos = [registered(DEPLOYMENT)];
			const out = applyCapabilityOverrides(
				infos,
				SERVER,
				options({
					globalCapabilities: { "gpt-test": { supports_pdf_input: true, supports_response_schema: true } },
				})
			);
			assert.strictEqual(out, infos, "pdf/schema overrides gate nothing at registration");
			assert.strictEqual(out[0], infos[0]);
		});

		test("record problems log one classification per distinct problem, routed by severity", () => {
			const logged: string[] = [];
			const advisory: string[] = [];
			applyCapabilityOverrides(
				[makeModelInfo({ id: "a-model" }), makeModelInfo({ id: "a-second" })],
				SERVER,
				options({
					globalCapabilities: { "a-*": { bogus_key: 1, max_output_tokens: -5, supports_vision: true } },
					log: (message) => logged.push(message),
					logAdvisory: (message) => advisory.push(message),
				})
			);
			// The unrecognized key is applied as-is (informational) and rides the
			// advisory sink, which bypasses the issue reporter's ring-buffer
			// budget; the invalid value is a real problem and keeps the budget.
			// One line each, not one per model, and never a value.
			assert.deepStrictEqual(advisory, ["Applying an unrecognized capability field as-is"]);
			assert.deepStrictEqual(logged, ["Ignoring a modelCapabilities record problem"]);
		});
	});

	suite("synthesizeDeclaredModels", () => {
		test("a declared ID becomes a model with the badge and its baseline", () => {
			const { infos } = synthesizeDeclaredModels(
				new Set(),
				new Set(),
				SERVER,
				1,
				options({
					entryCapabilities: {
						"my-model": { context_length: 64000, max_output_tokens: 8000 },
					},
					entryDeclaredModels: ["my-model"],
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
		});

		test("a declared ID discovery listed stays inert, even when only synthetic variants registered", () => {
			const { infos } = synthesizeDeclaredModels(
				new Set(["foo"]),
				new Set(["foo:cheapest", "foo:fastest"]),
				SERVER,
				1,
				options({ entryDeclaredModels: ["foo"] })
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
					entryDeclaredModels: ["foo:cheapest"],
					log: (message, data) => logged.push({ message, data }),
				})
			);
			assert.deepStrictEqual(infos, []);
			assert.strictEqual(logged.length, 1);
			assert.ok(logged[0]?.message.includes("Suppressing a declared model"));
		});

		test("the floor backstops a bare declared ID, with the conservative outputLimitSource", () => {
			const { infos } = synthesizeDeclaredModels(
				new Set(),
				new Set(),
				SERVER,
				1,
				options({ entryDeclaredModels: ["bare-model"] })
			);
			const declared = infos[0];
			assert.ok(declared !== undefined);
			assert.strictEqual(declared.maxOutputTokens, 16000);
			assert.strictEqual(declared.maxInputTokens, 112000);
			assert.strictEqual(declared.litellm.outputLimitSource, "defaults", "a floor limit keeps the request cap");
		});

		test("multi-server synthesis namespaces the exposed ID like registration", () => {
			const { infos } = synthesizeDeclaredModels(
				new Set(),
				new Set(),
				SERVER,
				2,
				options({ entryDeclaredModels: ["my-model"] })
			);
			assert.strictEqual(infos[0]?.id, "srv1/my-model");
			assert.strictEqual(infos[0]?.name, "[Default] my-model");
		});

		test("a leftover global _declare directive creates nothing and stays silent", () => {
			const logged: string[] = [];
			const advisory: string[] = [];
			const { infos } = synthesizeDeclaredModels(
				new Set(),
				new Set(),
				SERVER,
				1,
				options({
					globalCapabilities: { "my-model": { _declare: true } },
					log: (message) => logged.push(message),
					logAdvisory: (message) => advisory.push(message),
				})
			);
			assert.deepStrictEqual(infos, []);
			assert.deepStrictEqual(logged, [], "the retired directive is an unknown underscore key, not a diagnostic");
			assert.deepStrictEqual(advisory, [], "underscore keys are not open fields either; no advisory note");
		});

		test("a duplicated declared ID synthesizes once", () => {
			const { infos } = synthesizeDeclaredModels(
				new Set(),
				new Set(),
				SERVER,
				1,
				options({ entryDeclaredModels: ["twin", "twin"] })
			);
			assert.deepStrictEqual(
				infos.map((info) => info.id),
				["twin"]
			);
		});

		test("a declared model with an entry cost record registers priced", () => {
			// No server level exists at all for a declared model; the user's cost
			// record is the only price source and must reach the picker.
			const { infos } = synthesizeDeclaredModels(
				new Set(),
				new Set(),
				SERVER,
				1,
				options({
					entryCapabilities: { "my-model": { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 } },
					entryDeclaredModels: ["my-model"],
				})
			);
			const declared = infos[0];
			assert.ok(declared !== undefined);
			assert.strictEqual(declared.inputCost, 3);
			assert.strictEqual(declared.outputCost, 15);
			assert.strictEqual(declared.pricing, "$3 in / $15 out per 1M tokens");
			assert.strictEqual(declared.priceCategory, "medium");
		});

		test("a declared model honors caching and reasoning-params records like a discovered one", () => {
			const { infos } = synthesizeDeclaredModels(
				new Set(),
				new Set(),
				SERVER,
				1,
				options({
					entryCapabilities: {
						"my-model": { supports_prompt_caching: true, supported_openai_params: ["reasoning_effort"] },
					},
					entryDeclaredModels: ["my-model"],
				})
			);
			const declared = infos[0];
			assert.ok(declared !== undefined);
			assert.strictEqual(declared.litellm.supportsPromptCaching, true, "declared models no longer hardcode false");
			assert.deepStrictEqual(
				declared.configurationSchema,
				REASONING_EFFORT_SCHEMA,
				"a params list with reasoning_effort promotes the control over the floor"
			);
		});
	});
});
