/**
 * The effective-values inspector's safety argument: the projection the
 * dashboard renders and the request body the transport sends are two reads
 * of one shared resolution, and this property pins that they cannot drift.
 * For random global records (scoped and unscoped keys), entry records, raw
 * IDs, base-URL scopes, and model limits: every key the projection marks
 * sent appears in buildRequestBody's output with the same value, every
 * non-provider-owned body key appears in the projection as sent, and the
 * projected max_tokens equals the body's. A second property pins that
 * getModelParameters (the transport's live-configuration wrapper) resolves
 * to exactly the shared resolver's merge.
 */
import * as assert from "node:assert";
import * as fc from "fast-check";
import { buildRequestBody, getModelParameters } from "../../../provider/transport/request";
import type { ModelParametersRecord } from "../../../shared/config/parameterResolution";
import {
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
// and max_tokens exercises the derivation hand-off.
const paramKey = fc.oneof(
	{ arbitrary: fc.constantFrom("temperature", "top_p", "seed", "max_tokens"), weight: 3 },
	{ arbitrary: fc.constantFrom("model", "messages", "stream", "stream_options", "tools", "tool_choice"), weight: 1 },
	{ arbitrary: noSlashKey.map((key) => `_${key}`), weight: 1 },
	{ arbitrary: noSlashKey, weight: 1 }
);
const paramRecord = fc.dictionary(paramKey, fc.jsonValue({ maxDepth: 2 }), { maxKeys: 5 });

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
 * the no-match branch alive.
 */
const scenario: fc.Arbitrary<Scenario> = fc
	.record({
		rawModelId: noSlashKey,
		otherId: noSlashKey,
		globalSpecs: fc.array(
			fc.record({
				cut: fc.nat(),
				foreign: fc.boolean(),
				scope: fc.option(fc.constantFrom(...scopePool), { nil: undefined }),
				params: paramRecord,
			}),
			{ maxLength: 4 }
		),
		entrySpecs: fc.option(
			fc.array(fc.record({ cut: fc.nat(), foreign: fc.boolean(), params: paramRecord }), { maxLength: 3 }),
			{ nil: undefined }
		),
		scopes: fc.subarray([...scopePool]),
		maxOutputTokens: fc.integer({ min: 1, max: 100000 }),
		outputLimitDeclared: fc.boolean(),
	})
	.map(({ rawModelId, otherId, globalSpecs, entrySpecs, scopes, maxOutputTokens, outputLimitDeclared }) => {
		const prefixOf = (cut: number, foreign: boolean) => {
			const base = foreign ? otherId : rawModelId;
			return base.slice(0, 1 + (cut % base.length));
		};
		const globalParameters: Record<string, Record<string, unknown>> = {};
		for (const spec of globalSpecs) {
			const prefix = prefixOf(spec.cut, spec.foreign);
			const key = spec.scope === undefined ? prefix : `${spec.scope}/${prefix}`;
			globalParameters[key] = spec.params;
		}
		const entryParameters =
			entrySpecs === undefined
				? undefined
				: Object.fromEntries(entrySpecs.map((spec) => [prefixOf(spec.cut, spec.foreign), spec.params]));
		return {
			rawModelId,
			globalParameters,
			serverScopes: scopes,
			entryParameters,
			maxOutputTokens,
			outputLimitDeclared,
		};
	});

const MESSAGES: OpenAIChatMessage[] = [{ role: "user", content: "hi" }];
const BASE_KEYS: ReadonlySet<string> = new Set(["model", "messages", "stream", "stream_options", "max_tokens"]);

/**
 * The pre-refactor algorithms, frozen verbatim from request.ts and
 * chatClient.ts as they stood before parameterResolution.ts existed: the
 * differential oracle behind the zero-behavior-change claim. Do not "improve"
 * these - their whole value is being the old code, character for character in
 * behavior, so the property below can prove the refactor changed nothing.
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
	test("the refactored resolution is the legacy algorithm: same merge, same key order, same max_tokens", () => {
		// The differential oracle for the zero-behavior-change claim. Key ORDER
		// is asserted too (Object.keys, not just deepStrictEqual) because the
		// serialized body is only byte-for-byte identical if enumeration order
		// survived the refactor.
		const runtimeArb = fc.option(fc.oneof(fc.integer({ min: 1, max: 100000 }), fc.constant("not-a-number")), {
			nil: undefined,
		});
		fc.assert(
			fc.property(scenario, runtimeArb, (s, runtimeMaxTokens) => {
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

	test("the inspector projection and buildRequestBody agree on every sent key, value, and max_tokens", () => {
		fc.assert(
			fc.property(scenario, (s) => {
				// The transport side, exactly as chatClient.send composes it: the
				// shared merge, the shared max_tokens chain (no runtime option), then
				// the pass-through body build.
				const resolved = resolveModelParameters(s);
				const { value: maxTokens } = resolveMaxTokens({
					runtimeMaxTokens: undefined,
					configuredMaxTokens: resolved.params.max_tokens,
					maxOutputTokens: s.maxOutputTokens,
					outputLimitDeclared: s.outputLimitDeclared,
				});
				const body = buildRequestBody({
					rawModelId: s.rawModelId,
					openaiMessages: MESSAGES,
					maxTokens,
					modelParams: resolved.params,
					toolConfig: undefined,
				});

				const projection = projectEffectiveParameters(s);

				// Every row the inspector marks sent is in the body, same value.
				for (const row of projection.rows) {
					if (!row.sent) {
						continue;
					}
					assert.ok(Object.hasOwn(body, row.name), `sent row ${row.name} missing from the body`);
					assert.deepStrictEqual(body[row.name], row.value, `body.${row.name} differs from the projected value`);
				}

				// Every non-provider-owned body key is a sent row, same value.
				const sentByName = new Map(projection.rows.filter((row) => row.sent).map((row) => [row.name, row.value]));
				for (const [key, value] of Object.entries(body)) {
					if (BASE_KEYS.has(key)) {
						continue;
					}
					assert.ok(sentByName.has(key), `body key ${key} not projected as sent`);
					assert.deepStrictEqual(sentByName.get(key), value);
				}

				// The derivation line states the body's exact max_tokens.
				assert.strictEqual(projection.maxTokens.value, body.max_tokens);
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
				}).params;
				assert.deepStrictEqual(viaConfig, viaResolver);
			}),
			{ numRuns: Math.min(NUM_RUNS, 60), seed: SEED }
		);
	});
});
