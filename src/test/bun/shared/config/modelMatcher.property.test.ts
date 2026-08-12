/**
 * The matcher fuzzer: random key sets (exact, trailing-glob, regex with and
 * without /i, invalid regex, misplaced stars, "*", "") against random model
 * IDs. The oracle is the GENERATOR's construction intent, independent of the
 * implementation: every key is built with its intended kind and an expected
 * match predicate derived from how it was cut, and the pairwise specificity
 * rules are restated from the spec over those intents. Invariants: invalid
 * keys are inert and diagnosed, chain membership equals the intent
 * predicates, the chain is totally ordered by the pairwise rules, and the
 * winner is beaten by no other matching key.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fc from "fast-check";
import { matchChain } from "../../../../shared/config/modelMatcher";
import { resolveFuzzSeed } from "../../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 300;
const SEED = resolveFuzzSeed();

// No "*" or "/" so a generated literal can never accidentally spell another
// key form; the parse-level slash edge cases are pinned in the unit suite.
const idChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789._-");
const modelIdArb = fc.string({ unit: idChar, minLength: 1, maxLength: 12 });

type KeyIntent =
	| { readonly kind: "exact"; readonly literal: string }
	| { readonly kind: "glob"; readonly prefix: string }
	| { readonly kind: "regex"; readonly prefix: string; readonly insensitive: boolean }
	| { readonly kind: "catch-all" }
	| { readonly kind: "invalid" };

interface KeySpec {
	readonly key: string;
	readonly intent: KeyIntent;
}

/** The spec's answer to "does this key match this ID", derived from the construction, not the parser. */
function intentMatches(intent: KeyIntent, id: string): boolean {
	switch (intent.kind) {
		case "exact":
			return id === intent.literal;
		case "glob":
			return id.startsWith(intent.prefix);
		case "regex":
			// The generated regex body is "<escaped literal>.*", so whole-ID
			// anchoring reduces to a (case-folded, under /i) prefix test.
			return intent.insensitive
				? id.toLowerCase().startsWith(intent.prefix.toLowerCase())
				: id.startsWith(intent.prefix);
		case "catch-all":
			return true;
		case "invalid":
			return false;
	}
}

const SPEC_TIER = { "catch-all": 0, regex: 1, glob: 2, exact: 3 } as const;

/** The documented pairwise rule over intents: does `a` beat `b` for this record order? */
function beats(a: KeySpec, b: KeySpec, keyOrder: readonly string[]): boolean {
	if (a.intent.kind === "invalid" || b.intent.kind === "invalid") {
		return false;
	}
	const tierA = SPEC_TIER[a.intent.kind];
	const tierB = SPEC_TIER[b.intent.kind];
	if (tierA !== tierB) {
		return tierA > tierB;
	}
	if (a.intent.kind === "glob" && b.intent.kind === "glob") {
		return a.intent.prefix.length > b.intent.prefix.length;
	}
	if (a.intent.kind === "regex" && b.intent.kind === "regex") {
		return keyOrder.indexOf(a.key) > keyOrder.indexOf(b.key);
	}
	return false; // two exacts or two catch-alls matching one ID are the same key
}

/** A key derived from the model ID (matches common) or free-standing, across every key form. */
function keySpecArb(id: string): fc.Arbitrary<KeySpec> {
	const cutOf = (base: string, cut: number) => base.slice(0, cut % (base.length + 1));
	const escapeRegex = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	return fc.oneof(
		{
			arbitrary: fc.nat().map((cut): KeySpec => {
				const literal = cutOf(id, cut + 1) || id;
				return { key: literal, intent: { kind: "exact", literal } };
			}),
			weight: 2,
		},
		{
			arbitrary: fc.nat().map((cut): KeySpec => {
				const prefix = cutOf(id, cut);
				return prefix === ""
					? { key: "*", intent: { kind: "catch-all" } }
					: { key: `${prefix}*`, intent: { kind: "glob", prefix } };
			}),
			weight: 2,
		},
		{
			arbitrary: fc.tuple(fc.nat(), fc.boolean()).map(([cut, insensitive]): KeySpec => {
				const prefix = cutOf(id, cut);
				return {
					key: `/${escapeRegex(prefix)}.*/${insensitive ? "i" : ""}`,
					intent: { kind: "regex", prefix, insensitive },
				};
			}),
			weight: 2,
		},
		{ arbitrary: fc.constant<KeySpec>({ key: "*", intent: { kind: "catch-all" } }), weight: 1 },
		{ arbitrary: fc.constant<KeySpec>({ key: "", intent: { kind: "invalid" } }), weight: 1 },
		{
			arbitrary: fc
				.string({ unit: idChar, minLength: 1, maxLength: 4 })
				.map((s): KeySpec => ({ key: `${s}*${s}`, intent: { kind: "invalid" } })),
			weight: 1,
		},
		{ arbitrary: fc.constant<KeySpec>({ key: "/[/", intent: { kind: "invalid" } }), weight: 1 },
		{ arbitrary: fc.constant<KeySpec>({ key: "/x.*/g", intent: { kind: "invalid" } }), weight: 1 },
		{
			arbitrary: fc
				.string({ unit: idChar, minLength: 1, maxLength: 12 })
				.map((literal): KeySpec => ({ key: literal, intent: { kind: "exact", literal } })),
			weight: 1,
		}
	);
}

const scenarioArb = modelIdArb.chain((id) =>
	fc.record({
		id: fc.constant(id),
		specs: fc.array(keySpecArb(id), { maxLength: 8 }).map((specs) => {
			const seen = new Set<string>();
			return specs.filter((spec) => {
				if (seen.has(spec.key)) {
					return false;
				}
				seen.add(spec.key);
				return true;
			});
		}),
	})
);

describe("shared/config modelMatcher fuzzer", () => {
	test("the chain is exactly the intent-matching keys, totally ordered by the pairwise specificity rules", () => {
		fc.assert(
			fc.property(scenarioArb, ({ id, specs }) => {
				const records = Object.fromEntries(specs.map((spec) => [spec.key, { key: spec.key }]));
				const keyOrder = Object.keys(records);
				const byKey = new Map(specs.map((spec) => [spec.key, spec]));
				const { chain, diagnostics } = matchChain(id, records);

				// Invalid keys are inert: never in the chain, always diagnosed.
				const invalid = specs.filter((spec) => spec.intent.kind === "invalid").map((spec) => spec.key);
				assert.deepStrictEqual(
					diagnostics.map((d) => d.key),
					invalid
				);
				for (const match of chain) {
					assert.notStrictEqual(byKey.get(match.key)?.intent.kind, "invalid", "an invalid key must never match");
				}

				// Membership: exactly the keys whose construction intent matches.
				const expectedMembers = specs
					.filter((spec) => intentMatches(spec.intent, id))
					.map((spec) => spec.key)
					.sort();
				assert.deepStrictEqual([...chain.map((m) => m.key)].sort(), expectedMembers);

				// Order: strictly ascending under the documented pairwise rules -
				// every later chain element beats every earlier one, and the winner
				// (the chain tail) is beaten by nothing.
				for (let i = 0; i < chain.length; i += 1) {
					for (let j = i + 1; j < chain.length; j += 1) {
						const earlier = byKey.get((chain[i] as { key: string }).key) as KeySpec;
						const later = byKey.get((chain[j] as { key: string }).key) as KeySpec;
						assert.ok(
							beats(later, earlier, keyOrder),
							`"${later.key}" must be more specific than "${earlier.key}" for ID "${id}"`
						);
						assert.ok(!beats(earlier, later, keyOrder), "the pairwise order must be antisymmetric");
					}
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("glob always outranks regex and everything valid outranks the catch-all, whatever matches", () => {
		fc.assert(
			fc.property(scenarioArb, ({ id, specs }) => {
				const records = Object.fromEntries(specs.map((spec) => [spec.key, {}]));
				const byKey = new Map(specs.map((spec) => [spec.key, spec]));
				const { chain } = matchChain(id, records);
				const tiers = chain.map((match) => {
					const intent = (byKey.get(match.key) as KeySpec).intent;
					assert.notStrictEqual(intent.kind, "invalid");
					return SPEC_TIER[intent.kind as keyof typeof SPEC_TIER];
				});
				const sorted = [...tiers].sort((a, b) => a - b);
				assert.deepStrictEqual(tiers, sorted, "tiers must be non-decreasing along the chain");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
