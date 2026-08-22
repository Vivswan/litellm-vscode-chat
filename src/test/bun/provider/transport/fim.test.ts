import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fc from "fast-check";
import {
	buildFimPrompt,
	FIM_PREFIX_BUDGET,
	FIM_SUFFIX_BUDGET,
	parseCompletionText,
} from "../../../../provider/transport/fim";
import { FIM_TEMPLATE_DIRECTIVE } from "../../../../shared/config/recordResolution";
import { resolveFuzzSeed } from "../../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
// Pinned by default; FUZZ_SEED overrides so the nightly explores fresh seeds.
const SEED = resolveFuzzSeed();

describe("provider/transport/fim buildFimPrompt", () => {
	test("under budget, the native path passes both sides through unchanged", () => {
		const result = buildFimPrompt({ prefix: "function add(a, b) {", suffix: "}\n" });
		assert.deepStrictEqual(result, { prompt: "function add(a, b) {", suffix: "}\n" });
	});

	test("exactly at budget nothing is cut; one unit over cuts from the correct side", () => {
		const prefixAtBudget = `p${"x".repeat(FIM_PREFIX_BUDGET - 1)}`;
		const suffixAtBudget = `${"y".repeat(FIM_SUFFIX_BUDGET - 1)}s`;
		const atBudget = buildFimPrompt({ prefix: prefixAtBudget, suffix: suffixAtBudget });
		assert.strictEqual(atBudget.prompt, prefixAtBudget);
		assert.strictEqual(atBudget.suffix, suffixAtBudget);

		const over = buildFimPrompt({ prefix: `A${prefixAtBudget}`, suffix: `${suffixAtBudget}Z` });
		// The prefix truncates FROM THE LEFT (the tail nearest the cursor
		// survives); the suffix truncates from the right (the head survives).
		assert.strictEqual(over.prompt, prefixAtBudget);
		assert.strictEqual(over.prompt.length, FIM_PREFIX_BUDGET);
		assert.strictEqual(over.suffix, suffixAtBudget);
		assert.strictEqual(over.suffix?.length, FIM_SUFFIX_BUDGET);
	});

	test("empty context stays empty on the native path", () => {
		assert.deepStrictEqual(buildFimPrompt({ prefix: "", suffix: "" }), { prompt: "", suffix: "" });
	});

	test("a valid template substitutes every placeholder occurrence and omits the wire suffix", () => {
		const result = buildFimPrompt({
			prefix: "PRE",
			suffix: "SUF",
			fimTemplate: "<fim_prefix>{prefix}<fim_suffix>{suffix}<fim_middle>{prefix}",
		});
		assert.strictEqual(result.prompt, "<fim_prefix>PRE<fim_suffix>SUF<fim_middle>PRE");
		assert.strictEqual(result.suffix, undefined);
	});

	test("placeholder-looking document text is never re-expanded", () => {
		// The prefix itself spells {suffix}; a naive sequential replace would
		// substitute into it. The single-pass rule keeps document text literal.
		const result = buildFimPrompt({ prefix: "A{suffix}B", suffix: "S", fimTemplate: "<{prefix}>[{suffix}]" });
		assert.strictEqual(result.prompt, "<A{suffix}B>[S]");
		assert.strictEqual(result.suffix, undefined);
	});

	test("regex-special replacement text stays literal", () => {
		const result = buildFimPrompt({ prefix: "$&$'$`$1", suffix: "$<x>", fimTemplate: "{prefix}|{suffix}" });
		assert.strictEqual(result.prompt, "$&$'$`$1|$<x>");
	});

	test("the template substitutes the TRUNCATED context, not the raw one", () => {
		const result = buildFimPrompt({
			prefix: `${"a".repeat(FIM_PREFIX_BUDGET)}TAIL`,
			suffix: `HEAD${"b".repeat(FIM_SUFFIX_BUDGET)}`,
			fimTemplate: "{prefix}###{suffix}",
		});
		const [prefixPart, suffixPart] = result.prompt.split("###");
		assert.strictEqual(prefixPart?.length, FIM_PREFIX_BUDGET);
		assert.ok(prefixPart.endsWith("TAIL"), "the prefix keeps its tail");
		assert.strictEqual(suffixPart?.length, FIM_SUFFIX_BUDGET);
		assert.ok(suffixPart.startsWith("HEAD"), "the suffix keeps its head");
	});

	for (const [label, malformed] of [
		["a non-string value", 42],
		["null", null],
		["true", true],
		["an object", { template: "{prefix}{suffix}" }],
		["an array", ["{prefix}", "{suffix}"]],
		["the empty string", ""],
		["a template missing {suffix}", "complete after: {prefix}"],
		["a template missing {prefix}", "before: {suffix}"],
	] as const) {
		test(`${label} as _fim_template falls back to the native prompt+suffix path`, () => {
			const result = buildFimPrompt({ prefix: "PRE", suffix: "SUF", fimTemplate: malformed });
			assert.deepStrictEqual(result, { prompt: "PRE", suffix: "SUF" });
		});
	}

	test("the directive name is underscore-prefixed, so the pass-through contract keeps it off the wire", () => {
		assert.strictEqual(FIM_TEMPLATE_DIRECTIVE, "_fim_template");
		assert.ok(FIM_TEMPLATE_DIRECTIVE.startsWith("_"));
	});

	test("a cut landing inside a surrogate pair drops the severed half instead of sending it", () => {
		// 8001 units: the budget cut severs the first emoji, leaving its low
		// surrogate at the head; the lone unit is dropped.
		const prefix = `${"\u{1F600}".repeat(FIM_PREFIX_BUDGET / 2)}b`;
		const prefixResult = buildFimPrompt({ prefix, suffix: "" });
		assert.strictEqual(prefixResult.prompt.length, FIM_PREFIX_BUDGET - 1);
		assert.ok(prefixResult.prompt.isWellFormed());
		assert.ok(prefixResult.prompt.endsWith("b"));

		// Mirror on the suffix: the cut leaves a high surrogate at the tail.
		const suffix = `c${"\u{1F600}".repeat(FIM_SUFFIX_BUDGET / 2)}`;
		const suffixResult = buildFimPrompt({ prefix: "", suffix });
		assert.strictEqual(suffixResult.suffix?.length, FIM_SUFFIX_BUDGET - 1);
		assert.ok(suffixResult.suffix.isWellFormed());
		assert.ok(suffixResult.suffix.startsWith("c"));
	});

	test("an aligned cut through astral text keeps the full budget", () => {
		const prefix = `a${"\u{1F600}".repeat(FIM_PREFIX_BUDGET / 2)}`;
		const result = buildFimPrompt({ prefix, suffix: "" });
		assert.strictEqual(result.prompt.length, FIM_PREFIX_BUDGET);
		assert.ok(result.prompt.isWellFormed());
	});

	test("untruncated input passes through verbatim, a pre-existing lone surrogate included", () => {
		const loneSurrogate = "\ud800";
		const result = buildFimPrompt({ prefix: loneSurrogate, suffix: loneSurrogate });
		assert.strictEqual(result.prompt, loneSurrogate);
		assert.strictEqual(result.suffix, loneSurrogate);
	});
});

describe("provider/transport/fim parseCompletionText", () => {
	test("reads the first choice's string text, empty string included", () => {
		assert.strictEqual(parseCompletionText({ choices: [{ text: "done" }] }), "done");
		assert.strictEqual(parseCompletionText({ choices: [{ index: 0, text: "", finish_reason: "stop" }] }), "");
	});

	test("junk choices ahead of a usable one drop instead of failing the response", () => {
		assert.strictEqual(parseCompletionText({ choices: [null, "junk", { text: 5 }, { text: "ok" }] }), "ok");
	});

	for (const [label, malformed] of [
		["a non-record payload", "text"],
		["a number", 42],
		["null", null],
		["undefined", undefined],
		["an array payload", [{ text: "x" }]],
		["a record without choices", { text: "x" }],
		["non-array choices", { choices: { text: "x" } }],
		["empty choices", { choices: [] }],
		["choices without string text", { choices: [{ text: 7 }, { message: { content: "x" } }] }],
	] as const) {
		test(`${label} reads as undefined`, () => {
			assert.strictEqual(parseCompletionText(malformed), undefined);
		});
	}
});

/** Independent single-pass expansion oracle: earliest placeholder first, expansions never re-scanned. */
function expandOracle(template: string, prefix: string, suffix: string): string {
	let out = "";
	let rest = template;
	for (;;) {
		const prefixAt = rest.indexOf("{prefix}");
		const suffixAt = rest.indexOf("{suffix}");
		if (prefixAt === -1 && suffixAt === -1) {
			return out + rest;
		}
		const prefixFirst = prefixAt !== -1 && (suffixAt === -1 || prefixAt < suffixAt);
		const at = prefixFirst ? prefixAt : suffixAt;
		out += rest.slice(0, at) + (prefixFirst ? prefix : suffix);
		rest = rest.slice(at + "{prefix}".length);
	}
}

describe("provider/transport/fim properties", () => {
	// ASCII-only ON PURPOSE: without surrogates the raw slice IS the truncation
	// rule, so the oracle below stays exact and independent; the unicode
	// property owns the surrogate-boundary behavior. Some runs must exceed the
	// budget by construction - fast-check's default sizes never would, and a
	// property whose truncation branch never runs proves nothing.
	const contextArb = fc.oneof(
		fc.string({ maxLength: 40 }),
		fc.string({ minLength: FIM_PREFIX_BUDGET + 1, maxLength: FIM_PREFIX_BUDGET + 200 })
	);
	const templateArb = fc
		.array(fc.oneof(fc.string({ maxLength: 12 }), fc.constant("{prefix}"), fc.constant("{suffix}")), { maxLength: 8 })
		.map((parts) => parts.join(""));

	test("buildFimPrompt is total and its budgets and path choice hold for any input", () => {
		let truncatedRuns = 0;
		fc.assert(
			fc.property(
				contextArb,
				contextArb,
				fc.oneof(fc.anything({ maxDepth: 2 }), templateArb),
				(prefix, suffix, template) => {
					if (prefix.length > FIM_PREFIX_BUDGET) {
						truncatedRuns += 1;
					}
					const result = buildFimPrompt({ prefix, suffix, fimTemplate: template });
					const truncatedPrefix = prefix.slice(-FIM_PREFIX_BUDGET);
					const truncatedSuffix = suffix.slice(0, FIM_SUFFIX_BUDGET);
					const templateValid =
						typeof template === "string" && template.includes("{prefix}") && template.includes("{suffix}");
					if (templateValid) {
						assert.strictEqual(result.suffix, undefined, "a template owns the whole prompt");
						assert.strictEqual(result.prompt, expandOracle(template, truncatedPrefix, truncatedSuffix));
					} else {
						assert.strictEqual(result.prompt, truncatedPrefix);
						assert.strictEqual(result.suffix, truncatedSuffix);
					}
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
		assert.ok(truncatedRuns > 0, "the truncation branch must actually run, or the property is vacuous");
	});

	test("parseCompletionText never throws and answers string | undefined for any input", () => {
		fc.assert(
			fc.property(fc.oneof(fc.anything({ maxDepth: 3 }), fc.jsonValue()), (raw) => {
				const result = parseCompletionText(raw);
				assert.ok(result === undefined || typeof result === "string");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("truncation keeps well-formed unicode well-formed and stays a window of the input", () => {
		// unit: "binary" generates whole code points, so inputs are well-formed
		// by construction. minLength counts CODE POINTS: astral-heavy strings
		// land far past the UTF-16 budgets, so the cut branch runs on the
		// oversized samples (asserted below, not assumed).
		const overBudgetArb = fc.string({
			unit: "binary",
			minLength: FIM_PREFIX_BUDGET + 1,
			maxLength: FIM_PREFIX_BUDGET + 40,
		});
		const unicodeArb = fc.oneof(fc.string({ unit: "binary", maxLength: 40 }), overBudgetArb);
		let truncatedRuns = 0;
		fc.assert(
			fc.property(unicodeArb, unicodeArb, (prefix, suffix) => {
				if (prefix.length > FIM_PREFIX_BUDGET && suffix.length > FIM_SUFFIX_BUDGET) {
					truncatedRuns += 1;
				}
				const result = buildFimPrompt({ prefix, suffix });
				assert.ok(result.prompt.isWellFormed(), "the prompt must not carry a severed surrogate");
				assert.ok(result.suffix !== undefined);
				assert.ok(result.suffix.isWellFormed(), "the wire suffix must not carry a severed surrogate");
				assert.ok(prefix.endsWith(result.prompt), "the prompt is the prefix's tail");
				assert.ok(suffix.startsWith(result.suffix), "the wire suffix is the suffix's head");
				// The pair rule costs at most one unit of the budgeted window.
				assert.ok(result.prompt.length >= Math.min(prefix.length, FIM_PREFIX_BUDGET) - 1);
				assert.ok(result.suffix.length >= Math.min(suffix.length, FIM_SUFFIX_BUDGET) - 1);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
		assert.ok(truncatedRuns > 0, "both cut branches must actually run, or the property is vacuous");
	});
});
