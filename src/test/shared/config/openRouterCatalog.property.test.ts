/**
 * The catalog's leniency contract under fire: the mapping, snapshot parser,
 * slimming, and lookup accept ARBITRARY payloads (the live endpoint after a
 * schema change, a torn cache file, hand-edited JSON) and never throw -
 * unusable shapes degrade to absence, and an unrecognizable payload degrades
 * to the empty snapshot. The slimmed artifact is also pinned as faithful:
 * parsing what slimming wrote yields exactly the models parsing the raw
 * payload did, so the packaged file can never drift from the mapping that
 * produced it.
 */
import * as assert from "node:assert";
import * as fc from "fast-check";
import { CAPABILITY_FIELDS } from "../../../shared/config/capabilityResolution";
import type { CatalogModel } from "../../../shared/config/openRouterCatalog";
import {
	createCatalogLookup,
	mapOpenRouterEntry,
	parseCatalogSnapshot,
	slimCatalogPayload,
} from "../../../shared/config/openRouterCatalog";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

// A small id pool with shared post-vendor suffixes keeps exact hits, suffix
// hits, and ambiguous suffixes all common; raw jsonValue keeps the
// degenerate shapes alive.
const vendor = fc.constantFrom("openai", "anthropic", "meta-llama", "fireworks");
const suffix = fc.constantFrom("gpt-4o", "llama-3-8b", "claude-3.5", "o1", "a/b");
const idArb = fc.oneof(
	fc.tuple(vendor, suffix).map(([v, s]) => `${v}/${s}`),
	suffix,
	fc.string({ maxLength: 12 })
);

/** Entry shapes from plausible to hostile: valid records, partially malformed fields, raw JSON junk. */
const entryArb = fc.oneof(
	{
		arbitrary: fc.record(
			{
				id: idArb,
				name: fc.oneof(fc.string({ maxLength: 8 }), fc.integer()),
				context_length: fc.oneof(fc.integer({ min: -100, max: 2_000_000 }), fc.constant("128k"), fc.double()),
				architecture: fc.oneof(
					fc.record({ input_modalities: fc.array(fc.oneof(fc.constantFrom("text", "image", "audio"), fc.integer())) }),
					fc.constant("broken")
				),
				top_provider: fc.oneof(
					fc.record({ max_completion_tokens: fc.oneof(fc.integer({ min: -10, max: 200_000 }), fc.constant(null)) }),
					fc.constant(null)
				),
				pricing: fc.oneof(
					fc.record(
						{ prompt: fc.oneof(fc.constant("0.000001"), fc.constant("-1"), fc.double().map(String), fc.integer()) },
						{ requiredKeys: [] }
					),
					fc.constant([])
				),
				supported_parameters: fc.oneof(
					fc.array(fc.oneof(fc.constantFrom("tools", "reasoning", "temperature"), fc.integer())),
					fc.constant("tools")
				),
			},
			{ requiredKeys: [] }
		),
		weight: 3,
	},
	{ arbitrary: fc.jsonValue({ maxDepth: 3 }), weight: 1 }
);

const payloadArb = fc.oneof(
	{ arbitrary: fc.record({ data: fc.array(entryArb, { maxLength: 12 }) }), weight: 3 },
	{ arbitrary: fc.array(entryArb, { maxLength: 12 }), weight: 1 },
	{ arbitrary: fc.jsonValue({ maxDepth: 3 }), weight: 1 }
);

/** Every produced model must be well-formed: non-blank id, vocabulary-typed fields, sane pricing. */
function assertWellFormed(models: readonly CatalogModel[]): void {
	for (const model of models) {
		assert.ok(model.id.trim() !== "");
		for (const [name, value] of Object.entries(model.fields)) {
			assert.ok(Object.hasOwn(CAPABILITY_FIELDS, name), `unknown mapped field ${name}`);
			if (CAPABILITY_FIELDS[name as keyof typeof CAPABILITY_FIELDS] === "number") {
				assert.ok(typeof value === "number" && Number.isInteger(value) && value > 0);
			} else {
				assert.strictEqual(typeof value, "boolean");
			}
		}
		for (const cost of [model.pricing?.input_cost_per_token, model.pricing?.output_cost_per_token]) {
			if (cost !== undefined) {
				assert.ok(Number.isFinite(cost) && cost >= 0);
			}
		}
	}
}

suite("shared/config openRouterCatalog properties", () => {
	test("mapping and parsing never throw and only produce well-formed models", () => {
		fc.assert(
			fc.property(payloadArb, (payload) => {
				const snapshot = parseCatalogSnapshot(payload);
				assertWellFormed(snapshot.models);
				const ids = snapshot.models.map((model) => model.id);
				assert.strictEqual(new Set(ids).size, ids.length, "duplicate ids survived parsing");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("unrecognizable payloads degrade to the empty snapshot, entry by entry", () => {
		fc.assert(
			fc.property(fc.jsonValue({ maxDepth: 3 }), (value) => {
				// As a lone entry: either a well-formed model or nothing.
				const model = mapOpenRouterEntry(value);
				if (model !== undefined) {
					assertWellFormed([model]);
				}
				// As a whole payload: never an error, and non-catalog shapes are empty.
				const snapshot = parseCatalogSnapshot(value);
				if (!Array.isArray(value) && !(typeof value === "object" && value !== null)) {
					assert.deepStrictEqual(snapshot.models, []);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("the slimmed artifact is deterministic, idempotent, and mapping-equivalent to its source", () => {
		fc.assert(
			fc.property(payloadArb, (payload) => {
				const slim = slimCatalogPayload(payload);
				assert.strictEqual(
					JSON.stringify(slimCatalogPayload(slim)),
					JSON.stringify(slim),
					"slimming is not idempotent"
				);

				const raw = new Map(parseCatalogSnapshot(payload).models.map((model) => [model.id, model]));
				const slimmed = parseCatalogSnapshot(slim).models;
				assert.strictEqual(slimmed.length, raw.size, "slimming changed the model set");
				for (const model of slimmed) {
					assert.deepStrictEqual(model, raw.get(model.id), `slimming changed ${model.id}`);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("lookups never throw and honor the exact-then-unambiguous-suffix rule", () => {
		fc.assert(
			fc.property(payloadArb, idArb, fc.boolean(), (payload, rawId, implicitLookup) => {
				const snapshot = parseCatalogSnapshot(payload);
				const lookup = createCatalogLookup(snapshot, { implicitLookup });
				const byId = new Map(snapshot.models.map((model) => [model.id, model]));

				const exact = lookup.byExactId(rawId);
				assert.strictEqual(exact.kind, byId.has(rawId) ? "found" : "not-found");

				const implicit = lookup.byRawModelId(rawId);
				if (!implicitLookup) {
					assert.deepStrictEqual(implicit, { kind: "not-found" });
					return;
				}
				const suffixMatches = snapshot.models.filter((model) => {
					const slash = model.id.indexOf("/");
					// Mirror the lookup's guard: an empty post-vendor suffix is not a
					// name and is never indexed, so "" can match nothing implicitly.
					const suffix = model.id.slice(slash + 1);
					return slash > 0 && suffix !== "" && suffix === rawId;
				});
				if (byId.has(rawId)) {
					assert.ok(implicit.kind === "found" && implicit.id === rawId);
				} else if (suffixMatches.length === 1) {
					assert.ok(implicit.kind === "found" && implicit.id === suffixMatches[0]?.id);
				} else if (suffixMatches.length > 1) {
					assert.strictEqual(implicit.kind, "ambiguous");
				} else {
					assert.strictEqual(implicit.kind, "not-found");
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("an empty raw ID never implicit-matches an empty post-vendor suffix (nightly seed 606002)", () => {
		// Shrunk counterexample from nightly run 31275590164 leg unit-2: a
		// catalog id of "<vendor>/" has an empty suffix, which the lookup
		// deliberately never indexes - so the empty raw ID matches nothing.
		const snapshot = parseCatalogSnapshot({ data: [{ id: " /" }] });
		for (const implicitLookup of [true, false]) {
			const lookup = createCatalogLookup(snapshot, { implicitLookup });
			assert.deepStrictEqual(lookup.byRawModelId(""), { kind: "not-found" });
		}
		assert.strictEqual(createCatalogLookup(snapshot, { implicitLookup: true }).byExactId(" /").kind, "found");
	});
});
