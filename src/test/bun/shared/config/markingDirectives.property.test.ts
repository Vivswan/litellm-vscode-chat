/**
 * The marking-directive grammar (`true` = every own field, `false` = none, a
 * validated name list, anything else diagnosed) is parsed once in
 * recordResolution.ts and consumed by `_inheritable`, `_force`, and
 * `_fallback`. Their rulings are user-visible in the Diagnostics tab, so this
 * suite holds the three consumers to identical answers: the seed-pinned
 * property feeds one directive value to all three parsers and demands the same
 * marks and the same grammar diagnoses; the tables pin each arm, plus
 * `_force`'s one sanctioned divergence (the forceability predicate).
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fc from "fast-check";
import { parseCapabilityRecord } from "../../../../shared/config/capabilityResolution";
import { parseParameterRecord } from "../../../../shared/config/parameterResolution";
import type { RecordDiagnostic } from "../../../../shared/config/recordResolution";
import { parseSharedDirectives } from "../../../../shared/config/recordResolution";
import { resolveFuzzSeed } from "../../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 300;
const SEED = resolveFuzzSeed();

/**
 * Field names legal and equivalent under all three parsers: not consumed
 * capability fields (a wrong-kind value would be diagnosed away there), not
 * provider-owned (all forceable), trim-stable (capability keys trim).
 */
const NAME_POOL = ["temperature", "top_p", "seed", "stop", "penalty"] as const;

/** One parser's answer, reduced to what the grammar owns. */
interface DirectiveRuling {
	readonly marked: readonly string[];
	/** The grammar's diagnoses in list order, directive name erased so the three compare. */
	readonly diagnosed: readonly string[];
}

function ruling(
	directiveName: string,
	marked: ReadonlySet<string>,
	diagnostics: readonly Omit<RecordDiagnostic, "recordKey">[]
): DirectiveRuling {
	const diagnosed: string[] = [];
	for (const diagnostic of diagnostics) {
		if (diagnostic.kind === "invalid-directive" && diagnostic.key === directiveName) {
			diagnosed.push("invalid-directive");
		} else if (diagnostic.kind === "unforceable-key") {
			diagnosed.push(`unforceable-key:${diagnostic.key}`);
		}
	}
	return { marked: [...marked].sort(), diagnosed };
}

function inheritableRuling(fields: Record<string, unknown>, value: unknown): DirectiveRuling {
	const parsed = parseSharedDirectives({ ...fields, _inheritable: value }, fields);
	return ruling("_inheritable", parsed.inheritable, parsed.diagnostics);
}

function forceRuling(fields: Record<string, unknown>, value: unknown): DirectiveRuling {
	const parsed = parseParameterRecord({ ...fields, _force: value });
	return ruling("_force", parsed.forced, parsed.diagnostics);
}

function fallbackRuling(fields: Record<string, unknown>, value: unknown): DirectiveRuling {
	const parsed = parseCapabilityRecord({ ...fields, _fallback: value });
	return ruling("_fallback", parsed.fallback, parsed.diagnostics);
}

const fieldsArb = fc
	.uniqueArray(fc.constantFrom(...NAME_POOL), { maxLength: 4 })
	.map((names) => Object.fromEntries(names.map((name, i) => [name, `v${i}`])));

const listEntryArb = fc.oneof(
	fc.constantFrom<unknown>(...NAME_POOL),
	fc.constantFrom<unknown>("absent-field", "ghost"),
	fc.constantFrom<unknown>(7, null, true, ["nested"])
);

const directiveValueArb = fc.oneof(
	fc.constantFrom<unknown>(true, false),
	fc.constantFrom<unknown>("yes", 1, null, {}, undefined),
	fc.array(listEntryArb, { maxLength: 5 })
);

describe("shared/config marking-directive equivalence", () => {
	test("_inheritable, _force, and _fallback rule identically: same marks, same diagnoses, same order", () => {
		fc.assert(
			fc.property(fieldsArb, directiveValueArb, (fields, value) => {
				const reference = inheritableRuling(fields, value);
				assert.deepStrictEqual(forceRuling(fields, value), reference);
				assert.deepStrictEqual(fallbackRuling(fields, value), reference);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

describe("shared/config marking-directive arms", () => {
	const fields = { temperature: "0.3", top_p: "0.9" };
	const parsers = [
		{ name: "_inheritable", parse: inheritableRuling },
		{ name: "_force", parse: forceRuling },
		{ name: "_fallback", parse: fallbackRuling },
	] as const;

	for (const { name, parse } of parsers) {
		test(`${name}: true marks every own field, false none, neither diagnosed`, () => {
			assert.deepStrictEqual(parse(fields, true), { marked: ["temperature", "top_p"], diagnosed: [] });
			assert.deepStrictEqual(parse(fields, false), { marked: [], diagnosed: [] });
		});

		test(`${name}: a list marks the named own fields once; duplicates add nothing`, () => {
			assert.deepStrictEqual(parse(fields, ["temperature", "temperature"]), {
				marked: ["temperature"],
				diagnosed: [],
			});
		});

		test(`${name}: absent names and non-string entries are each diagnosed and skipped, multiplicity kept`, () => {
			assert.deepStrictEqual(parse(fields, ["temperature", "ghost", 5, "ghost"]), {
				marked: ["temperature"],
				diagnosed: ["invalid-directive", "invalid-directive", "invalid-directive"],
			});
		});

		test(`${name}: any non-boolean non-list value is one invalid-directive`, () => {
			for (const garbage of ["yes", 1, null, {}, undefined]) {
				assert.deepStrictEqual(parse(fields, garbage), { marked: [], diagnosed: ["invalid-directive"] });
			}
		});
	}

	test("_force alone refuses unmarkable keys: a listed one by its own name, an own field silently under true", () => {
		// "stream" is unforceable AND unset, so it pins the branch ORDER: the
		// forceability refusal is reached before the own-field check.
		const listed = forceRuling({ model: "x", max_tokens: 9000, temperature: "0.5" }, [
			"model",
			"stream",
			"max_tokens",
			"temperature",
		]);
		assert.deepStrictEqual(listed, {
			marked: ["max_tokens", "temperature"],
			diagnosed: ["unforceable-key:model", "unforceable-key:stream"],
		});
		const all = forceRuling({ model: "x", max_tokens: 9000, temperature: "0.5" }, true);
		assert.deepStrictEqual(all, { marked: ["max_tokens", "temperature"], diagnosed: [] });
	});
});
