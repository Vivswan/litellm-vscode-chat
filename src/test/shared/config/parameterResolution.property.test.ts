/**
 * The effective-values inspector's safety argument: the projection the
 * dashboard renders and the request body the transport sends are two reads
 * of one shared resolution, and this property pins that they cannot drift.
 * For random global records (scoped and unscoped keys, catch-all "*" keys,
 * `_force` directives), entry records, raw IDs, base-URL scopes, and model
 * limits: every key the projection marks sent appears in buildRequestBody's
 * output with the right value under the full chain (forced > runtime >
 * picker > configured), every non-provider-owned body key appears in the
 * projection as sent, and the projected max_tokens equals the body's. A
 * differential oracle pins the directive-free sub-language against the
 * pre-refactor algorithms, an alias property pins "*" == "", and a wrapper
 * property pins getModelParameters (the transport's live-configuration
 * wrapper) to the shared resolver's merge.
 */
import * as assert from "node:assert";
import * as fc from "fast-check";
import type { ModelConfigurationRequestParams } from "../../../provider/catalog/modelConfiguration";
import { buildRequestBody, getModelParameters } from "../../../provider/transport/request";
import type { ModelParametersRecord } from "../../../shared/config/parameterResolution";
import {
	FORCE_DIRECTIVE,
	parameterSkipReason,
	projectEffectiveParameters,
	resolveMaxTokens,
	resolveModelParameters,
} from "../../../shared/config/parameterResolution";
import { normalizeModelParameters } from "../../../shared/config/settings";
import type { OpenAIChatMessage } from "../../../shared/conversion/wire";
import { resolveFuzzSeed } from "../../fuzzStream";
import { withConfig } from "../../testUtils";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

// "constructor" and "prototype" are reachable in this alphabet and
// normalizeModelParameters drops them, which would void the wrapper property.
const RESERVED_KEYS = new Set(["constructor", "prototype"]);

// Slash-free so a scoped key "<scope>/<prefix>" can never collide with an
// unscoped key or match a scope other than its own.
const noSlashChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.-");
const noSlashKey = fc
	.string({ unit: noSlashChar, minLength: 1, maxLength: 10 })
	.filter((key) => !RESERVED_KEYS.has(key));

// A small shared pool makes cross-layer key collisions (the shadowing branch)
// common; owned and underscore keys exercise the not-sent classifications,
// and max_tokens exercises the derivation hand-off. "_force" is excluded from
// the random underscore keys: the directive is generated deliberately below,
// so the directive-free oracle scenarios really are directive-free.
const paramKey = fc.oneof(
	{ arbitrary: fc.constantFrom("temperature", "top_p", "seed", "max_tokens"), weight: 3 },
	{ arbitrary: fc.constantFrom("model", "messages", "stream", "stream_options", "tools", "tool_choice"), weight: 1 },
	{ arbitrary: noSlashKey.map((key) => `_${key}`).filter((key) => key !== FORCE_DIRECTIVE), weight: 1 },
	{ arbitrary: noSlashKey, weight: 1 }
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

/** Optionally add a `_force` directive to a generated record. */
const paramRecordWithForce = paramRecord.chain((record) =>
	fc.option(forceDirective(record), { nil: undefined }).map((force) => ({
		...record,
		...(force !== undefined ? { [FORCE_DIRECTIVE]: force } : {}),
	}))
);

const scopePool = ["http://a.test", "http://b.test:4000"] as const;

interface Scenario {
	rawModelId: string;
	globalParameters: ModelParametersRecord;
	serverScopes: readonly string[];
	entryParameters: ModelParametersRecord | undefined;
	maxOutputTokens: number;
	outputLimitDeclared: boolean;
}

/**
 * A raw ID plus records whose keys often prefix it: each generated prefix key
 * is a cut of the raw ID (so matches are the common case, not the lottery),
 * optionally scoped for the global record, and a cut of an unrelated ID keeps
 * the no-match branch alive. With `directives` on, records may carry `_force`
 * and keys may be the catch-all "*" (both settings' new sub-language); the
 * differential oracle runs on the directive-free sub-language, where the
 * legacy algorithms are still the spec.
 */
function scenarioArb(options: { directives: boolean }): fc.Arbitrary<Scenario> {
	const record = options.directives ? paramRecordWithForce : paramRecord;
	const spec = fc.record({
		cut: fc.nat(),
		foreign: fc.boolean(),
		star: options.directives ? fc.boolean() : fc.constant(false),
	});
	return fc
		.record({
			rawModelId: noSlashKey,
			otherId: noSlashKey,
			globalSpecs: fc.array(
				fc.record({
					spec,
					scope: fc.option(fc.constantFrom(...scopePool), { nil: undefined }),
					params: record,
				}),
				{ maxLength: 4 }
			),
			entrySpecs: fc.option(fc.array(fc.record({ spec, params: record }), { maxLength: 3 }), { nil: undefined }),
			scopes: fc.subarray([...scopePool]),
			maxOutputTokens: fc.integer({ min: 1, max: 100000 }),
			outputLimitDeclared: fc.boolean(),
		})
		.map(({ rawModelId, otherId, globalSpecs, entrySpecs, scopes, maxOutputTokens, outputLimitDeclared }) => {
			const prefixOf = ({ cut, foreign, star }: { cut: number; foreign: boolean; star: boolean }) => {
				if (star) {
					return "*";
				}
				// Zero-length cuts keep the "" catch-all key (and "<scope>/" scoped
				// form) in both the oracle's and the directives' sub-language.
				const base = foreign ? otherId : rawModelId;
				return base.slice(0, cut % (base.length + 1));
			};
			const globalParameters: Record<string, Record<string, unknown>> = {};
			for (const globalSpec of globalSpecs) {
				const prefix = prefixOf(globalSpec.spec);
				const key = globalSpec.scope === undefined ? prefix : `${globalSpec.scope}/${prefix}`;
				globalParameters[key] = globalSpec.params;
			}
			const entryParameters =
				entrySpecs === undefined
					? undefined
					: Object.fromEntries(entrySpecs.map((entry) => [prefixOf(entry.spec), entry.params]));
			return {
				rawModelId,
				globalParameters,
				serverScopes: scopes,
				entryParameters,
				maxOutputTokens,
				outputLimitDeclared,
			};
		});
}

const oracleScenario = scenarioArb({ directives: false });
const scenario = scenarioArb({ directives: true });

const MESSAGES: OpenAIChatMessage[] = [{ role: "user", content: "hi" }];
const BASE_KEYS: ReadonlySet<string> = new Set(["model", "messages", "stream", "stream_options", "max_tokens"]);

/**
 * The pre-refactor algorithms, frozen verbatim from request.ts and
 * chatClient.ts as they stood before parameterResolution.ts existed: the
 * differential oracle behind the zero-behavior-change claim for the
 * directive-free sub-language (no `_force`, no "*" keys - the two deliberate
 * behavior additions). Do not "improve" these - their whole value is being
 * the old code, character for character in behavior, so the property below
 * can prove the refactor changed nothing else.
 */
function legacyFindLongestPrefixMatch<T>(id: string, entries: Record<string, T>): T | undefined {
	let best: { key: string; value: T } | undefined;
	for (const [key, value] of Object.entries(entries)) {
		if (id === key || id.startsWith(key)) {
			if (!best || key.length > best.key.length) {
				best = { key, value };
			}
		}
	}
	return best?.value;
}

function legacyFindScopedMatch<T>(
	rawId: string,
	scopes: readonly string[],
	entries: Record<string, T>
): { specificity: number; value: T } | undefined {
	let best: { specificity: number; value: T } | undefined;
	for (const scope of scopes) {
		const scopePrefix = `${scope}/`;
		for (const [key, value] of Object.entries(entries)) {
			if (!key.startsWith(scopePrefix)) {
				continue;
			}
			const modelPrefix = key.slice(scopePrefix.length);
			if (rawId === modelPrefix || rawId.startsWith(modelPrefix)) {
				if (!best || modelPrefix.length > best.specificity) {
					best = { specificity: modelPrefix.length, value };
				}
			}
		}
	}
	return best;
}

function legacyGetModelParameters(
	rawId: string,
	globalParameters: ModelParametersRecord,
	serverScopes: readonly string[],
	entryParameters: ModelParametersRecord | undefined
): Record<string, unknown> {
	const scoped = legacyFindScopedMatch(rawId, serverScopes, globalParameters);
	const global = scoped?.value ?? legacyFindLongestPrefixMatch(rawId, globalParameters);
	const entry = legacyFindLongestPrefixMatch(rawId, entryParameters ?? {});
	return { ...global, ...entry };
}

/** chatClient.send's old inline max_tokens chain, 4096 literal included. */
function legacyMaxTokens(
	runtimeMaxTokens: unknown,
	modelParams: Record<string, unknown>,
	maxOutputTokens: number,
	outputLimitDeclared: boolean
): number {
	let maxTokens: number;
	if (typeof runtimeMaxTokens === "number") {
		maxTokens = runtimeMaxTokens;
	} else if (typeof modelParams.max_tokens === "number") {
		maxTokens = modelParams.max_tokens;
	} else if (outputLimitDeclared) {
		maxTokens = maxOutputTokens;
	} else {
		maxTokens = Math.min(4096, maxOutputTokens);
	}
	return maxTokens;
}

suite("shared/config parameterResolution equivalence properties", () => {
	test("on the directive-free sub-language the resolution is the legacy algorithm: merge, key order, max_tokens", () => {
		// The differential oracle for the zero-behavior-change claim. Key ORDER
		// is asserted too (Object.keys, not just deepStrictEqual) because the
		// serialized body is only byte-for-byte identical if enumeration order
		// survived the refactor.
		const runtimeArb = fc.option(fc.oneof(fc.integer({ min: 1, max: 100000 }), fc.constant("not-a-number")), {
			nil: undefined,
		});
		fc.assert(
			fc.property(oracleScenario, runtimeArb, (s, runtimeMaxTokens) => {
				const params = resolveModelParameters(s).params;
				const legacyParams = legacyGetModelParameters(
					s.rawModelId,
					s.globalParameters,
					s.serverScopes,
					s.entryParameters
				);
				assert.deepStrictEqual(params, legacyParams);
				assert.deepStrictEqual(Object.keys(params), Object.keys(legacyParams));

				const { value } = resolveMaxTokens({
					runtimeMaxTokens,
					configuredMaxTokens: params.max_tokens,
					maxOutputTokens: s.maxOutputTokens,
					outputLimitDeclared: s.outputLimitDeclared,
				});
				assert.strictEqual(
					value,
					legacyMaxTokens(runtimeMaxTokens, legacyParams, s.maxOutputTokens, s.outputLimitDeclared)
				);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test('the catch-all "*" resolves exactly like "" in every layer and scoping form, key attribution aside', () => {
		const layerArb = fc.constantFrom("global-unscoped", "global-scoped", "entry" as const);
		fc.assert(
			fc.property(oracleScenario, paramRecordWithForce, layerArb, (s, record, layer) => {
				const scope = s.serverScopes[0];
				if (layer === "global-scoped" && scope === undefined) {
					return;
				}
				const withKey = (key: string): Scenario =>
					layer === "entry"
						? { ...s, entryParameters: { ...s.entryParameters, [key]: record } }
						: { ...s, globalParameters: { ...s.globalParameters, [key]: record } };
				const starScenario = withKey(layer === "global-scoped" ? `${scope}/*` : "*");
				const emptyScenario = withKey(layer === "global-scoped" ? `${scope}/` : "");

				const star = resolveModelParameters(starScenario);
				const empty = resolveModelParameters(emptyScenario);
				assert.deepStrictEqual(star.params, empty.params);
				assert.deepStrictEqual(star.forcedParams, empty.forcedParams);
				assert.deepStrictEqual(
					projectEffectiveParameters(starScenario).maxTokens.value,
					projectEffectiveParameters(emptyScenario).maxTokens.value
				);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("the inspector projection and buildRequestBody agree under the full chain, runtime and picker included", () => {
		const pickerArb = fc.option(fc.constantFrom("none", "low", "medium", "high"), { nil: undefined });
		const runtimeArb = fc.option(paramRecord, { nil: undefined });
		fc.assert(
			fc.property(scenario, runtimeArb, pickerArb, (s, modelOptions, pickerEffort) => {
				// The transport side, exactly as chatClient.send composes it: the
				// shared merge, the shared max_tokens chain, then the pass-through
				// body build over config, picker, runtime, and forced sources.
				const resolved = resolveModelParameters(s);
				const { value: maxTokens } = resolveMaxTokens({
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
				// absent from the request.
				if (typeof modelOptions?.max_tokens !== "number") {
					assert.strictEqual(projection.maxTokens.value, body.max_tokens);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("getModelParameters over live configuration equals the shared resolver's merge", async () => {
		await fc.assert(
			fc.asyncProperty(scenario, async (s) => {
				const viaConfig = await withConfig({ modelParameters: s.globalParameters as Record<string, unknown> }, () =>
					getModelParameters(s.rawModelId, new Map(), s.serverScopes, s.entryParameters)
				);
				const viaResolver = resolveModelParameters({
					...s,
					// The wrapper reads through getModelParametersConfig, which
					// normalizes; both sides must see the same normalized record.
					globalParameters: normalizeModelParameters(s.globalParameters),
				});
				assert.deepStrictEqual(viaConfig.params, viaResolver.params);
				assert.deepStrictEqual(viaConfig.forcedParams, viaResolver.forcedParams);
			}),
			{ numRuns: Math.min(NUM_RUNS, 60), seed: SEED }
		);
	});
});
