import * as assert from "node:assert";
import * as fc from "fast-check";
import { HttpResponse, http } from "msw";
import {
	fetchModels,
	isLiteLLMModelItem,
	mapModelInfoEntry,
	normalizeModelItem,
	parseModelInfoItem,
} from "../../../provider/catalog/discovery";
import type { LiteLLMProvider, LongContextCostField, RawModelItem } from "../../../provider/catalog/schemas";
import {
	LONG_CONTEXT_COST_FIELDS,
	LONG_CONTEXT_COST_PREFIX,
	WIRE_COST_FIELDS,
} from "../../../provider/catalog/schemas";
import { createServerClient } from "../../../provider/transport/clients";
import { nodeHttpFetch } from "../../../provider/transport/nodeHttpFetch";
import type { CostCapabilityField } from "../../../shared/config/capabilityResolution";
import { consumedFieldsOfKind } from "../../../shared/config/capabilityResolution";
import { fixedHeaderValue } from "../../../shared/util/headers";
import { normalizeCostPerToken } from "../../../shared/util/numbers";
import { resolveFuzzSeed } from "../../fuzzStream";
import { MODEL_INFO_URL, MODELS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../mocks/handlers";
import { expectDefined } from "../../pureHelpers";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

const noLog = () => {};

// --- Shared arbitraries

const costValue = fc.oneof(
	fc.double({ noNaN: true, noDefaultInfinity: true, min: 0, max: 1 }),
	fc.constantFrom(-0, Number.NaN, Number.POSITIVE_INFINITY, -1, -0.5, null, undefined, "0.001", { usd: 1 }, true, [])
);

const COST_FIELDS = consumedFieldsOfKind("cost");

/** The long-context field LiteLLM reports as `<base>_above_<N>k_tokens`, keyed by that base. */
const LONG_CONTEXT_FIELD_BY_BASE: ReadonlyMap<string, LongContextCostField> = new Map(
	LONG_CONTEXT_COST_FIELDS.map((field) => [field.slice(LONG_CONTEXT_COST_PREFIX.length), field])
);
const LONG_CONTEXT_BASES = [...LONG_CONTEXT_FIELD_BY_BASE.keys()];

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

function assertCostFieldUsableOrAbsent(provider: LiteLLMProvider, field: CostCapabilityField): void {
	const value = provider[field];
	// A mapped entry's costs are discovery-authored as number | undefined; the null in LiteLLMProvider's type is
	// mergeModelDeployments' "deployments disagree", which this path never produces.
	assert.ok(
		value === undefined || isUsableCost(value),
		`${String(field)} must be a usable cost or absent, got ${String(value)}`
	);
}

function expectedLongContextCosts(
	tiers: readonly { base: string; threshold: number; value: unknown }[]
): Partial<Record<LongContextCostField, number>> {
	// Last write wins per key, matching object-literal assignment order above.
	const byKey = new Map<string, { base: string; threshold: number; value: unknown }>();
	for (const tier of tiers) {
		byKey.set(`${tier.base}_above_${tier.threshold}k_tokens`, tier);
	}
	const usable = [...byKey.values()].filter((tier) => isUsableCost(tier.value));
	if (usable.length === 0) {
		return {};
	}
	const lowest = Math.min(...usable.map((tier) => tier.threshold));
	const expected: Partial<Record<LongContextCostField, number>> = {};
	for (const tier of usable) {
		if (tier.threshold === lowest) {
			// Mirror the implementation's canonicalization (-0 comes out as 0); isUsableCost already guaranteed the
			// value normalizes to a number.
			expected[expectDefined(LONG_CONTEXT_FIELD_BY_BASE.get(tier.base))] = expectDefined(
				normalizeCostPerToken(tier.value)
			);
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
			fc.property(tieredRecord, fc.dictionary(fc.constantFrom(...WIRE_COST_FIELDS), costValue), (tiered, base) => {
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
				for (const field of LONG_CONTEXT_FIELD_BY_BASE.values()) {
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
	const wireProviderArb = fc
		.tuple(
			fc.dictionary(fc.string({ maxLength: 16 }), fc.jsonValue({ maxDepth: 1 }), { maxKeys: 5 }),
			fc.dictionary(fc.constantFrom(...WIRE_COST_FIELDS), costValue, { maxKeys: 4 }),
			fc.constantFrom<string | number>("some-provider", 42)
		)
		.map(([noise, costs, provider]) => ({
			...noise,
			...costs,
			provider,
			status: "active",
		}));

	const rawModelArb: fc.Arbitrary<RawModelItem> = fc
		.tuple(fc.string({ minLength: 1, maxLength: 24 }), fc.array(wireProviderArb, { maxLength: 4 }))
		.map(([id, providers]) => ({ id, providers }));

	test("cost fields re-narrow to usable or absent under arbitrary pass-through noise", () => {
		fc.assert(
			fc.property(rawModelArb, (raw) => {
				const model = normalizeModelItem(raw, noLog);
				assert.strictEqual(model.id, raw.id);
				if (model.shape.kind !== "group") {
					return;
				}
				for (const provider of model.shape.providers) {
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
		const client = createServerClient(
			{
				serverId: "srv1",
				baseUrl: TEST_BASE_URL,
				apiKey: fixedHeaderValue("test-key"),
				userAgent: fixedHeaderValue("test-agent"),
				customHeaders: {},
			},
			nodeHttpFetch
		);
		return { client, baseUrl: TEST_BASE_URL, apiVersion: undefined, discoveryTimeout: 5000, log: noLog };
	}

	test("no usable unblocked model is ever dropped, and blocked-only payloads yield an empty list", async function () {
		this.timeout(120000);
		// One stable handler pair reading mutable state: use() inside the property would stack a handler pair per run
		// and grow unboundedly at high FUZZ_RUNS.
		let servedEntries: unknown[] = [];
		mswServer.use(
			http.get(MODEL_INFO_URL, () => HttpResponse.json({ data: servedEntries })),
			http.get(MODELS_URL, () => HttpResponse.json({ data: [] }))
		);
		await fc.assert(
			fc.asyncProperty(payloadArb, async (entries) => {
				servedEntries = entries;
				const { models } = await fetchModels(makeRequest());

				// The oracle mirrors narrowModelInfoData's slot order: model-info entries dedupe into their first-seen
				// deployment slot, blocked ones drop, models-listing entries pass through in place, junk is skipped.
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
