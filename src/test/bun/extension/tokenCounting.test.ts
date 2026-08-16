import { afterEach, describe, test } from "bun:test";
import * as assert from "node:assert";
import type { LoadedTokenizer, TokenizerEncoding } from "../../../extension/tokenCounting";
import { createTokenCountingController } from "../../../extension/tokenCounting";
import { countTextTokens, plainTextTokenEstimate, setTextTokenCounting } from "../../../shared/conversion/textTokens";

/**
 * The controller's load policy against a fake encoding loader: which modes
 * load, when, how often, and what counting does while (and after) a load is
 * in flight. The counting semantics themselves are pinned in
 * shared/conversion/textTokens.test.ts.
 */

const CHINESE = "请把这个函数重构成纯函数, 并为它补上完整的单元测试。";

/**
 * A tokenizer with an unmistakable constant count, so installs are observable -
 * but only when the install forwarded allowedSpecial "all" (special-token text
 * is ordinary user text and must count, not throw).
 */
const FAKE_TOKENIZER: LoadedTokenizer = {
	countTokens: (_text, options) => (options?.allowedSpecial === "all" ? 4242 : -1),
};

interface Harness {
	readonly requested: TokenizerEncoding[];
	readonly errors: string[];
	resolveNext(): Promise<void>;
	rejectNext(): Promise<void>;
	apply(mode: "auto" | "heuristic" | "o200k_base" | "cl100k_base"): void;
}

function makeHarness(uiLanguage = "en"): Harness {
	const requested: TokenizerEncoding[] = [];
	const errors: string[] = [];
	const pending: { resolve: (t: LoadedTokenizer) => void; reject: (e: unknown) => void }[] = [];
	const controller = createTokenCountingController({
		log: () => {},
		logError: (message) => {
			errors.push(message);
		},
		uiLanguage,
		loadEncoding: (encoding) => {
			requested.push(encoding);
			return new Promise((resolve, reject) => {
				pending.push({ resolve, reject });
			});
		},
	});
	return {
		requested,
		errors,
		async resolveNext() {
			pending.shift()?.resolve(FAKE_TOKENIZER);
			// Two microtask hops: the then-handler runs after the promise settles.
			await Promise.resolve();
			await Promise.resolve();
		},
		async rejectNext() {
			pending.shift()?.reject(new Error("load failed"));
			await Promise.resolve();
			await Promise.resolve();
		},
		apply(mode) {
			controller.applyMode(mode);
		},
	};
}

afterEach(() => {
	setTextTokenCounting({ kind: "heuristic" });
});

describe("extension/tokenCounting: the heuristic mode", () => {
	test("never loads an encoding, even when CJK text is counted", () => {
		const harness = makeHarness();
		harness.apply("heuristic");
		assert.strictEqual(countTextTokens(CHINESE), plainTextTokenEstimate(CHINESE));
		assert.strictEqual(countTextTokens(CHINESE), plainTextTokenEstimate(CHINESE));
		assert.deepStrictEqual(harness.requested, []);
	});
});

describe("extension/tokenCounting: the explicit encodings", () => {
	test("load eagerly and count by the plain heuristic until the load lands", async () => {
		const harness = makeHarness();
		harness.apply("cl100k_base");
		assert.deepStrictEqual(harness.requested, ["cl100k_base"]);
		assert.strictEqual(countTextTokens(CHINESE), plainTextTokenEstimate(CHINESE));
		await harness.resolveNext();
		assert.strictEqual(countTextTokens(CHINESE), 4242);
	});

	test("a failed load logs once and leaves the heuristic standing", async () => {
		const harness = makeHarness();
		harness.apply("o200k_base");
		await harness.rejectNext();
		assert.strictEqual(harness.errors.length, 1);
		assert.strictEqual(countTextTokens(CHINESE), plainTextTokenEstimate(CHINESE));
	});
});

describe("extension/tokenCounting: the auto mode", () => {
	test("a non-English UI preloads o200k_base", () => {
		const harness = makeHarness("zh-cn");
		harness.apply("auto");
		assert.deepStrictEqual(harness.requested, ["o200k_base"]);
	});

	test("an English UI waits for CJK content, then loads o200k_base exactly once", async () => {
		const harness = makeHarness("en-US");
		harness.apply("auto");
		assert.deepStrictEqual(harness.requested, []);
		assert.strictEqual(countTextTokens("plain english text"), plainTextTokenEstimate("plain english text"));
		assert.deepStrictEqual(harness.requested, []);
		// The two-band interim prices the CJK fixture above the plain rule while
		// the detection kicks off the one load.
		assert.ok(countTextTokens(CHINESE) > plainTextTokenEstimate(CHINESE));
		countTextTokens(CHINESE);
		assert.deepStrictEqual(harness.requested, ["o200k_base"]);
		await harness.resolveNext();
		assert.strictEqual(countTextTokens(CHINESE), 4242);
	});

	test("a failed detection-triggered load logs once and keeps the two-band interim counting", async () => {
		const harness = makeHarness();
		harness.apply("auto");
		const interim = countTextTokens(CHINESE);
		await harness.rejectNext();
		assert.strictEqual(harness.errors.length, 1);
		assert.strictEqual(countTextTokens(CHINESE), interim);
		// Single attempt per applied mode: more CJK text does not retry.
		countTextTokens(CHINESE);
		assert.deepStrictEqual(harness.requested, ["o200k_base"]);
	});
});

describe("extension/tokenCounting: mode changes", () => {
	test("a load resolving after the mode changed installs nothing", async () => {
		const harness = makeHarness("zh-cn");
		harness.apply("auto");
		harness.apply("heuristic");
		await harness.resolveNext();
		assert.strictEqual(countTextTokens(CHINESE), plainTextTokenEstimate(CHINESE));
	});

	test("a successful load is cached: re-applying the mode installs without a second request", async () => {
		const harness = makeHarness();
		harness.apply("o200k_base");
		await harness.resolveNext();
		harness.apply("heuristic");
		assert.strictEqual(countTextTokens(CHINESE), plainTextTokenEstimate(CHINESE));
		harness.apply("o200k_base");
		assert.strictEqual(countTextTokens(CHINESE), 4242);
		assert.deepStrictEqual(harness.requested, ["o200k_base"]);
	});
});
