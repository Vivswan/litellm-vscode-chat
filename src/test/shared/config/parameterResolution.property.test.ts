/**
 * The effective-values inspector's safety argument: the projection the
 * dashboard renders and the request body the transport sends are two reads
 * of one shared resolution, and this property pins that they cannot drift.
 * For random global records (exact, glob, and catch-all matchers with
 * `_force`, `_inheritable`, and `_inherit_from` directives), entry records,
 * raw IDs, and model limits: every key the projection marks sent appears in
 * buildRequestBody's output with the right value under the full chain
 * (forced > runtime > picker > entry > global), every non-provider-owned
 * body key appears in the projection as sent, and the projected max_tokens
 * equals the body's. A configuration property pins the live-settings read
 * (getModelParametersConfig) to the shared resolver's normalized input.
 * The inheritance semantics themselves have their own naive-oracle fuzzer
 * (recordResolution.property.test.ts).
 */
import * as assert from "node:assert";
import * as fc from "fast-check";
import type { ModelConfigurationRequestParams } from "../../../provider/catalog/modelConfiguration";
import { buildRequestBody } from "../../../provider/transport/request";
import type { ModelParametersRecord } from "../../../shared/config/parameterResolution";
import {
	FORCE_DIRECTIVE,
	parameterSkipReason,
	projectEffectiveParameters,
	resolveMaxTokens,
	resolveModelParameters,
} from "../../../shared/config/parameterResolution";
import { getModelParametersConfig, normalizeModelParameters } from "../../../shared/config/settings";
import type { OpenAIChatMessage } from "../../../shared/conversion/wire";
import { resolveFuzzSeed } from "../../fuzzStream";
import { withConfig } from "../../testUtils";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

// "constructor" and "prototype" are reachable in this alphabet and
// normalizeModelParameters drops them, which would void the wrapper property.
const RESERVED_KEYS = new Set(["constructor", "prototype"]);

const idChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.-");
const rawIdArb = fc.string({ unit: idChar, minLength: 1, maxLength: 10 }).filter((key) => !RESERVED_KEYS.has(key));

// A small shared pool makes cross-layer key collisions (the shadowing branch)
// common; owned and underscore keys exercise the not-sent classifications,
// and max_tokens exercises the derivation hand-off. "_force" is excluded from
// the random underscore keys: the directive is generated deliberately below.
const paramKey = fc.oneof(
	{ arbitrary: fc.constantFrom("temperature", "top_p", "seed", "max_tokens"), weight: 3 },
	{ arbitrary: fc.constantFrom("model", "messages", "stream", "stream_options", "tools", "tool_choice"), weight: 1 },
	{ arbitrary: rawIdArb.map((key) => `_${key}`).filter((key) => key !== FORCE_DIRECTIVE), weight: 1 },
	{ arbitrary: rawIdArb, weight: 1 }
);
const paramRecord = fc.dictionary(paramKey, fc.jsonValue({ maxDepth: 2 }), { maxKeys: 5 });

/** A `_force` value: all-fields, a list cut from the record's own keys plus noise, or an invalid shape. */
const forceDirective = (record: Record<string, unknown>) =>
	fc.oneof(
		{ arbitrary: fc.boolean(), weight: 2 },
		{
			arbitrary: fc
				.tuple(
					fc.subarray(Object.keys(record)),
					fc.option(fc.constantFrom<unknown>("absent-key", 42), { nil: undefined })
				)
				.map(([names, noise]) => [...names, ...(noise !== undefined ? [noise] : [])]),
			weight: 2,
		},
		{ arbitrary: fc.constantFrom<unknown>("yes", 1, null), weight: 1 }
	);

/** Optionally add `_force`, `_inheritable`, and `_inherit_from` directives to a generated record. */
const recordWithDirectives = (recordKeys: () => readonly string[]) =>
	paramRecord.chain((record) =>
		fc
			.record({
				force: fc.option(forceDirective(record), { nil: undefined }),
				inheritable: fc.option(fc.oneof(fc.boolean(), fc.subarray(Object.keys(record))), { nil: undefined }),
				inheritFrom: fc.option(
					fc.oneof(
						fc.boolean(),
						fc.array(fc.nat({ max: 6 }), { maxLength: 2 }).map((picks) => {
							const keys = recordKeys();
							return picks.map((i) => keys[i % Math.max(1, keys.length)] ?? "*");
						})
					),
					{ nil: undefined }
				),
			})
			.map(({ force, inheritable, inheritFrom }) => ({
				...record,
				...(force !== undefined ? { [FORCE_DIRECTIVE]: force } : {}),
				...(inheritable !== undefined ? { _inheritable: inheritable } : {}),
				...(inheritFrom !== undefined ? { _inherit_from: inheritFrom } : {}),
			}))
	);

interface Scenario {
	rawModelId: string;
	globalParameters: ModelParametersRecord;
	entryParameters: ModelParametersRecord | undefined;
	maxOutputTokens: number;
	outputLimitDeclared: boolean;
}

/**
 * A raw ID plus records whose keys often match it: glob keys are cuts of the
 * raw ID plus "*" (so matches are the common case), exact keys are the ID or
 * a cut of it, "*" keeps the catch-all alive, and a cut of an unrelated ID
 * keeps the no-match branch alive. Records may carry the full directive set.
 */
const scenarioArb: fc.Arbitrary<Scenario> = fc
	.record({
		rawModelId: rawIdArb,
		otherId: rawIdArb,
		globalSpecs: fc.array(
			fc.record({
				cut: fc.nat(),
				form: fc.constantFrom("glob", "exact", "star", "foreign"),
				params: fc.nat(),
			}),
			{ maxLength: 4 }
		),
		entrySpecs: fc.option(
			fc.array(
				fc.record({ cut: fc.nat(), form: fc.constantFrom("glob", "exact", "star", "foreign"), params: fc.nat() }),
				{
					maxLength: 3,
				}
			),
			{ nil: undefined }
		),
		maxOutputTokens: fc.integer({ min: 1, max: 100000 }),
		outputLimitDeclared: fc.boolean(),
	})
	.chain((spec) => {
		const keyOf = (form: string, cut: number) => {
			const base = form === "foreign" ? spec.otherId : spec.rawModelId;
			const cutStr = base.slice(0, cut % (base.length + 1));
			switch (form) {
				case "glob":
					return `${cutStr}*`;
				case "exact":
					return cutStr || base;
				case "star":
					return "*";
				default:
					return spec.otherId;
			}
		};
		const globalKeys = spec.globalSpecs.map((s) => keyOf(s.form, s.cut));
		const entryKeys = (spec.entrySpecs ?? []).map((s) => keyOf(s.form, s.cut));
		const recordArbFor = (keys: readonly string[]) => recordWithDirectives(() => keys);
		return fc
			.record({
				globalRecords: fc.array(recordArbFor(globalKeys), {
					minLength: globalKeys.length,
					maxLength: globalKeys.length,
				}),
				entryRecords:
					spec.entrySpecs === undefined
						? fc.constant(undefined)
						: fc.array(recordArbFor(entryKeys), { minLength: entryKeys.length, maxLength: entryKeys.length }),
			})
			.map(({ globalRecords, entryRecords }) => {
				const globalParameters: Record<string, Record<string, unknown>> = {};
				globalKeys.forEach((key, i) => {
					const record = globalRecords[i];
					if (record !== undefined) {
						globalParameters[key] = record;
					}
				});
				const entryParameters =
					entryRecords === undefined
						? undefined
						: Object.fromEntries(entryKeys.map((key, i) => [key, entryRecords[i] ?? {}]));
				return {
					rawModelId: spec.rawModelId,
					globalParameters,
					entryParameters,
					maxOutputTokens: spec.maxOutputTokens,
					outputLimitDeclared: spec.outputLimitDeclared,
				};
			});
	});

const MESSAGES: OpenAIChatMessage[] = [{ role: "user", content: "hi" }];
const BASE_KEYS: ReadonlySet<string> = new Set(["model", "messages", "stream", "stream_options", "max_tokens"]);

suite("shared/config parameterResolution equivalence properties", () => {
	test("the inspector projection and buildRequestBody agree under the full chain, runtime and picker included", () => {
		const pickerArb = fc.option(fc.constantFrom("none", "low", "medium", "high"), { nil: undefined });
		const runtimeArb = fc.option(paramRecord, { nil: undefined });
		fc.assert(
			fc.property(scenarioArb, runtimeArb, pickerArb, (s, modelOptions, pickerEffort) => {
				// The transport side, exactly as chatClient.send composes it: the
				// shared merge, the shared max_tokens chain, then the pass-through
				// body build over config, picker, runtime, and forced sources.
				const resolved = resolveModelParameters(s);
				const { value: maxTokens } = resolveMaxTokens({
					forcedMaxTokens: resolved.forcedParams.max_tokens,
					runtimeMaxTokens: modelOptions?.max_tokens,
					configuredMaxTokens: resolved.params.max_tokens,
					maxOutputTokens: s.maxOutputTokens,
					outputLimitDeclared: s.outputLimitDeclared,
				});
				const modelConfiguration: ModelConfigurationRequestParams | undefined =
					pickerEffort === undefined ? undefined : { reasoning_effort: pickerEffort };
				const body = buildRequestBody({
					rawModelId: s.rawModelId,
					openaiMessages: MESSAGES,
					maxTokens,
					modelParams: resolved.params,
					forcedParams: resolved.forcedParams,
					toolConfig: undefined,
					modelConfiguration,
					modelOptions,
				});

				const projection = projectEffectiveParameters(s);

				// The chain, restated independently: configured sent rows, then the
				// picker, then runtime options, then the forced rows on top.
				const expected = new Map<string, unknown>();
				for (const row of projection.rows) {
					if (row.sent && row.forced === undefined) {
						expected.set(row.name, row.value);
					}
				}
				if (modelConfiguration !== undefined) {
					expected.set("reasoning_effort", modelConfiguration.reasoning_effort);
				}
				for (const [key, value] of Object.entries(modelOptions ?? {})) {
					if (parameterSkipReason(key) === undefined) {
						expected.set(key, value);
					}
				}
				for (const row of projection.rows) {
					if (row.forced === true) {
						// max_tokens is the one forceable provider-owned key: its value
						// rides the derivation (numeric) or nothing (junk), never the
						// pass-through body, so it is also the one forced row that can
						// render as not sent.
						if (row.name === "max_tokens") {
							assert.ok(!row.sent, "a max_tokens row exists only when non-numeric, and never passes through");
							continue;
						}
						assert.ok(row.sent, "a forced row is always sent");
						expected.set(row.name, row.value);
					}
				}

				for (const [key, value] of expected) {
					assert.ok(Object.hasOwn(body, key), `expected key ${key} missing from the body`);
					assert.deepStrictEqual(body[key], value, `body.${key} differs from the chain's value`);
				}
				for (const key of Object.keys(body)) {
					if (!BASE_KEYS.has(key)) {
						assert.ok(expected.has(key), `body key ${key} not accounted for by the chain`);
					}
				}

				// The derivation line states the body's exact max_tokens whenever the
				// one thing the projection cannot know (a runtime numeric option) is
				// absent from the request - and always when a forced value tops the
				// chain, because forced beats runtime.
				if (typeof resolved.forcedParams.max_tokens === "number" || typeof modelOptions?.max_tokens !== "number") {
					assert.strictEqual(projection.maxTokens.value, body.max_tokens);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("the live-configuration read feeds the resolver exactly its normalized record", async () => {
		await fc.assert(
			fc.asyncProperty(scenarioArb, async (s) => {
				const viaConfig = await withConfig({ "models.parameters": s.globalParameters as Record<string, unknown> }, () =>
					resolveModelParameters({
						rawModelId: s.rawModelId,
						globalParameters: getModelParametersConfig(),
						entryParameters: s.entryParameters,
					})
				);
				const viaResolver = resolveModelParameters({
					...s,
					// getModelParametersConfig normalizes what the settings file holds;
					// both sides must see the same normalized record.
					globalParameters: normalizeModelParameters(s.globalParameters),
				});
				assert.deepStrictEqual(viaConfig.params, viaResolver.params);
				assert.deepStrictEqual(viaConfig.forcedParams, viaResolver.forcedParams);
			}),
			{ numRuns: Math.min(NUM_RUNS, 60), seed: SEED }
		);
	});
});
