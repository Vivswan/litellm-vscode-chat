import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { findSecretLeak } from "../secretLeakScan";

/**
 * The monkey fuzzer's leak oracle trusts this scan's "no match" bare: a leak it misses passes the nightly silently.
 * Each case plants a secret the nested per-secret includes() scan it replaced caught at a position or shape where an
 * alternation can go wrong, so a regression here fails the control rather than the next real leak.
 */
describe("findSecretLeak", () => {
	const SECRETS = ["sk-monkey-7-1", "sk-monkey-7-1-companion", "monkey-vk-7-2", "k.y+(1)$"];
	const CLEAN = [
		"[info] Group status report served 3 models",
		"[info] bearer sk-mo*** masked\n    at refresh (engine.ts:1:1)",
		"[info] header x-monkey-companion present, value monkey-vk-8-2 absent: seed 8 is not 7",
	];

	const cases: readonly { readonly name: string; readonly line: string; readonly secret: string }[] = [
		{ name: "at the line start", line: "monkey-vk-7-2 was sent", secret: "monkey-vk-7-2" },
		{ name: "at the line end", line: "[info] bearer sk-monkey-7-1", secret: "sk-monkey-7-1" },
		{ name: "mid-line", line: "[info] header value=monkey-vk-7-2 forwarded", secret: "monkey-vk-7-2" },
		{
			name: "after an embedded newline",
			line: "[error] sync\n    at monkey-vk-7-2 (x.ts:1:1)",
			secret: "monkey-vk-7-2",
		},
		{
			name: "the longer of a prefix pair when both are present",
			line: "[info] sk-monkey-7-1-companion sent",
			secret: "sk-monkey-7-1-companion",
		},
		{
			name: "a secret of regex metacharacters, matched literally",
			line: "[info] key k.y+(1)$ echoed",
			secret: "k.y+(1)$",
		},
	];

	test("each planted secret is found on its line and named", () => {
		for (const { name, line, secret } of cases) {
			const batch = [...CLEAN, line, ...CLEAN];
			assert.deepStrictEqual(findSecretLeak(batch, SECRETS), { lineIndex: CLEAN.length, secret }, name);
		}
	});

	test("the metacharacter secret does not match as a pattern", () => {
		// Unescaped, "k.y+(1)$" would match "kxyyy1" at a line end; the literal must not.
		assert.strictEqual(findSecretLeak(["[info] kxyyy1"], SECRETS), undefined);
	});

	test("a clean batch and an empty secret list both report no leak", () => {
		assert.strictEqual(findSecretLeak(CLEAN, SECRETS), undefined);
		// An empty alternation would match every line.
		assert.strictEqual(findSecretLeak(CLEAN, []), undefined);
	});
});
