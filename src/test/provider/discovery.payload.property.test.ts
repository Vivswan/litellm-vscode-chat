import * as assert from "node:assert";
import * as fc from "fast-check";
import { HttpResponse, http } from "msw";
import { createServerClient } from "../../provider/clients";
import {
	fetchModels,
	isLiteLLMModelItem,
	mapModelInfoEntry,
	normalizeModelItem,
	parseModelInfoItem,
} from "../../provider/discovery";
import type { LiteLLMProvider, RawModelItem } from "../../provider/schemas";
import { normalizeCostPerToken } from "../../shared/numbers";
import type { TokenDefaults } from "../../shared/settings";
import { resolveFuzzSeed } from "../fuzzStream";
import { MODEL_INFO_URL, MODELS_URL, mswServer, TEST_BASE_URL, useMsw } from "../mocks/handlers";
import { expectDefined } from "../testUtils";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
// Pinned by default; FUZZ_SEED overrides so the nightly explores fresh seeds.
const SEED = resolveFuzzSeed();

const TEST_TOKEN_DEFAULTS: TokenDefaults = { maxOutputTokens: 4096, contextLength: 128000, maxInputTokens: undefined };

/**
 * Wire-payload properties for discovery's normalization layer: parsing is
 * total over arbitrary JSON, cost fields come out usable or absent, the
 * long-context tier selection cannot be confused by junk keys, internal
 * markers cannot be forged from the wire, and fetchModels never drops a model
 * with a usable id. The merge-level invariants live in
 * discovery.property.test.ts.
 */

const noLog = () => {};

// ── Shared arbitraries ────────────────────────────────────────────────────────

/** A cost-ish value: usable numbers, junk numbers, and non-numbers. */
const costValue = fc.oneof(
	fc.double({ noNaN: true, noDefaultInfinity: true, min: 0, max: 1 }),
	fc.constantFrom(-0, Number.NaN, Number.POSITIVE_INFINITY, -1, -0.5, null, undefined, "0.001", { usd: 1 }, true, [])
);

const LONG_CONTEXT_BASES = [
	"input_cost_per_token",
	"output_cost_per_token",
	"cache_read_input_token_cost",
	"cache_creation_input_token_cost",
] as const;

/** Keys that resemble tier keys but must never participate in tier selection. */
const LOOKALIKE_KEYS = [
	"input_cost_per_token_above_1hr",
	"input_cost_per_token_priority",
	"output_cost_per_character_above_128k_tokens",
	"input_cost_per_token_above_k_tokens",
	"cache_read_input_token_cost_above_200k_token",
] as const;

const tierEntry = fc.record({
	base: fc.constantFrom(...LONG_CONTEXT_BASES),
	threshold: fc.constantFrom(128, 200, 256, 272, 512),
	value: costValue,
});

/** A record of tiered cost keys plus lookalikes plus arbitrary noise fields. */
const tieredRecord = fc
	.tuple(
		fc.array(tierEntry, { maxLength: 8 }),
		fc.dictionary(fc.constantFrom(...LOOKALIKE_KEYS), costValue, { maxKeys: 3 }),
		fc.dictionary(fc.string({ maxLength: 20 }), fc.jsonValue({ maxDepth: 1 }), { maxKeys: 4 })
	)
	.map(([tiers, lookalikes, noise]) => {
		const record: Record<string, unknown> = { ...noise, ...lookalikes };
		for (const tier of tiers) {
			record[`${tier.base}_above_${tier.threshold}k_tokens`] = tier.value;
		}
		return { record, tiers };
	});

/** True when the value would survive normalizeCostPerToken: a finite number >= 0. */
function isUsableCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertCostFieldUsableOrAbsent(provider: LiteLLMProvider, field: keyof LiteLLMProvider): void {
	const value = provider[field];
	// These eight fields are discovery-authored as number | undefined; the
	// null in LiteLLMProvider's type exists for wire pass-through fields only.
	assert.ok(
		value === undefined || isUsableCost(value),
		`${String(field)} must be a usable cost or absent, got ${String(value)}`
	);
}

const COST_FIELDS = [
	"input_cost_per_token",
	"output_cost_per_token",
	"cache_read_input_token_cost",
	"cache_creation_input_token_cost",
	"long_context_input_cost_per_token",
	"long_context_output_cost_per_token",
	"long_context_cache_read_input_token_cost",
	"long_context_cache_creation_input_token_cost",
] as const satisfies readonly (keyof LiteLLMProvider)[];

const LONG_CONTEXT_FIELD_BY_BASE: Record<(typeof LONG_CONTEXT_BASES)[number], keyof LiteLLMProvider> = {
	input_cost_per_token: "long_context_input_cost_per_token",
	output_cost_per_token: "long_context_output_cost_per_token",
	cache_read_input_token_cost: "long_context_cache_read_input_token_cost",
	cache_creation_input_token_cost: "long_context_cache_creation_input_token_cost",
};

/** The tier selection oracle: lowest threshold holding at least one usable cost; per-field values at it. */
function expectedLongContextCosts(
	tiers: readonly { base: (typeof LONG_CONTEXT_BASES)[number]; threshold: number; value: unknown }[]
): Partial<Record<keyof LiteLLMProvider, number>> {
	// Last write wins per key, matching object-literal assignment order above.
	const byKey = new Map<string, { base: (typeof LONG_CONTEXT_BASES)[number]; threshold: number; value: unknown }>();
	for (const tier of tiers) {
		byKey.set(`${tier.base}_above_${tier.threshold}k_tokens`, tier);
	}
	const usable = [...byKey.values()].filter((tier) => isUsableCost(tier.value));
	if (usable.length === 0) {
		return {};
	}
	const lowest = Math.min(...usable.map((tier) => tier.threshold));
	const expected: Partial<Record<keyof LiteLLMProvider, number>> = {};
	for (const tier of usable) {
		if (tier.threshold === lowest) {
			// Mirror the implementation's canonicalization (-0 comes out as 0);
			// isUsableCost already guaranteed the value normalizes to a number.
			expected[LONG_CONTEXT_FIELD_BY_BASE[tier.base]] = expectDefined(normalizeCostPerToken(tier.value));
		}
	}
	return expected;
}

suite("provider/discovery payload parsing properties", () => {
	test("parseModelInfoItem and isLiteLLMModelItem are total over arbitrary JSON", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (payload) => {
				parseModelInfoItem(payload);
				isLiteLLMModelItem(payload);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("every cost field on a mapped model_info entry is a usable cost or absent", () => {
		fc.assert(
			fc.property(tieredRecord, fc.dictionary(fc.constantFrom(...LONG_CONTEXT_BASES), costValue), (tiered, base) => {
				const parsed = parseModelInfoItem({ model_name: "m", model_info: { ...tiered.record, ...base } });
				const mapped = mapModelInfoEntry(expectDefined(parsed));
				for (const field of COST_FIELDS) {
					assertCostFieldUsableOrAbsent(mapped.provider, field);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("long-context costs come from the lowest usable threshold; lookalike keys never participate", () => {
		fc.assert(
			fc.property(tieredRecord, (tiered) => {
				const parsed = parseModelInfoItem({ model_name: "m", model_info: tiered.record });
				const mapped = mapModelInfoEntry(expectDefined(parsed));
				const expected = expectedLongContextCosts(tiered.tiers);
				for (const field of Object.values(LONG_CONTEXT_FIELD_BY_BASE)) {
					assert.strictEqual(
						mapped.provider[field],
						expected[field],
						`${String(field)} must reflect the lowest usable tier only`
					);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

suite("provider/discovery /v1/models normalization properties", () => {
	/** A wire provider entry: usually a valid core plus pass-through noise, sometimes malformed (non-string provider). */
	const wireProviderArb = fc
		.tuple(
			fc.dictionary(fc.string({ maxLength: 16 }), fc.jsonValue({ maxDepth: 1 }), { maxKeys: 5 }),
			fc.dictionary(fc.constantFrom(...LONG_CONTEXT_BASES), costValue, { maxKeys: 4 }),
			fc.constantFrom(undefined, "provider", "defaults", "forged", 42),
			fc.constantFrom<string | number>("some-provider", 42)
		)
		.map(([noise, costs, forgedSource, provider]) => ({
			...noise,
			...costs,
			provider,
			status: "active",
			...(forgedSource !== undefined ? { output_limit_source: forgedSource } : {}),
		}));

	const rawModelArb: fc.Arbitrary<RawModelItem> = fc
		.tuple(fc.string({ minLength: 1, maxLength: 24 }), fc.array(wireProviderArb, { maxLength: 4 }))
		.map(([id, providers]) => ({ id, providers }));

	test("output_limit_source is unforgeable from the wire and cost fields re-narrow", () => {
		fc.assert(
			fc.property(rawModelArb, (raw) => {
				const model = normalizeModelItem(raw, noLog);
				assert.strictEqual(model.id, raw.id);
				if (model.shape.kind !== "group") {
					return;
				}
				for (const provider of model.shape.providers) {
					assert.strictEqual(provider.output_limit_source, undefined, "a wire entry must never forge the marker");
					for (const field of COST_FIELDS) {
						assertCostFieldUsableOrAbsent(provider, field);
					}
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

suite("provider/discovery fetchModels payload properties", () => {
	useMsw();

	/** An entry with a usable /v1/model/info identity, possibly blocked. */
	const infoEntryArb = fc
		.tuple(
			fc.string({ minLength: 1, maxLength: 12 }),
			fc.boolean(),
			fc.dictionary(fc.string({ maxLength: 10 }), fc.jsonValue({ maxDepth: 1 }), { maxKeys: 3 })
		)
		.map(([name, blocked, extra]) => ({
			model_name: name,
			model_info: { ...extra, ...(blocked ? { blocked: true } : {}) },
		}));

	/** Junk entries that must be skipped, never aborting the fetch. */
	const junkEntryArb = fc.oneof(
		fc.jsonValue({ maxDepth: 1 }),
		fc.constant({ model_name: 42 }),
		fc.constant(null),
		fc.constant([])
	);

	const payloadArb = fc.array(
		fc.oneof({ arbitrary: infoEntryArb, weight: 3 }, { arbitrary: junkEntryArb, weight: 1 }),
		{
			maxLength: 8,
		}
	);

	function makeRequest() {
		const client = createServerClient({
			serverId: "srv1",
			baseUrl: TEST_BASE_URL,
			apiKey: "test-key",
			userAgent: "test-agent",
			customHeaders: {},
		});
		return { client, baseUrl: TEST_BASE_URL, discoveryTimeout: 5000, tokenDefaults: TEST_TOKEN_DEFAULTS, log: noLog };
	}

	test("no usable unblocked model is ever dropped, and blocked-only payloads yield an empty list", async function () {
		this.timeout(120000);
		// One stable handler pair reading mutable state: use() inside the
		// property would stack a handler pair per run and never honor a high
		// FUZZ_RUNS without unbounded handler growth.
		let servedEntries: unknown[] = [];
		mswServer.use(
			http.get(MODEL_INFO_URL, () => HttpResponse.json({ data: servedEntries })),
			http.get(MODELS_URL, () => HttpResponse.json({ data: [] }))
		);
		await fc.assert(
			fc.asyncProperty(payloadArb, async (entries) => {
				servedEntries = entries;
				const { models } = await fetchModels(makeRequest());

				// The oracle mirrors narrowModelInfoData's slot order: model-info
				// entries dedupe into their first-seen deployment slot, blocked ones
				// drop, models-listing entries pass through in place, junk is skipped.
				const expectedIds: string[] = [];
				const seenDeployments = new Set<string>();
				for (const entry of entries) {
					const parsed = parseModelInfoItem(entry);
					if (parsed !== undefined) {
						if (parsed.model_info?.blocked === true) {
							continue;
						}
						if (!seenDeployments.has(parsed.modelId)) {
							seenDeployments.add(parsed.modelId);
							expectedIds.push(parsed.modelId);
						}
						continue;
					}
					if (isLiteLLMModelItem(entry)) {
						expectedIds.push(entry.id);
					}
				}
				assert.deepStrictEqual(
					models.map((model) => model.id),
					expectedIds,
					"exactly the usable unblocked ids survive, in slot order"
				);
			}),
			{ numRuns: Math.min(NUM_RUNS, 1000), seed: SEED }
		);
	});
});
