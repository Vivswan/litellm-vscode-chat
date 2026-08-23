/**
 * The probe carve-out pin: a dashboard "Test model" probe sends one request on
 * the user's click even while its feature is disabled, so any enable-setting
 * copy claiming "nothing is sent until enabled" must carve out that button for
 * every feature that carries a probe. This bit the commitGeneration probe once
 * (the probe landed, the copy kept the absolute claim), so the rule is pinned
 * fail-closed twice over: the probe list is read from the render fixture
 * (itself pinned equal to the production probe registry by features.test.ts),
 * every withholding claim in the nls descriptions and the settings-reference
 * prose must mention the button in every locale, and - because a claim regex
 * that misses a translator's rephrasing turns the cell vacuous, which happened
 * to three zh sentences - every claim-bearing feature must still MAKE the
 * claim in every locale, so a dropped or reworded claim fails by name instead
 * of passing silently.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../../util/repoRoot";

/** The shipped probe set, from the fixture features.test.ts pins to production. */
function probeFeatures(): string[] {
	const fixture = readFileSync(path.join(REPO_ROOT, "scripts", "dev", "renderFixtures", "shared.ts"), "utf8");
	const declared = /featureProbes:\s*\[([^\]]*)\]/.exec(fixture);
	expect(declared, "the render fixture declares a featureProbes list").not.toBeNull();
	return [...(declared?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

/** One shipped locale's recognizers: the withholding claim and the button carve-out, per locale. */
interface LocaleShapes {
	/** The nls file carrying this locale's setting descriptions. */
	readonly nlsFile: string;
	/** This locale's key in the settings-reference prose entries. */
	readonly proseKey: "en" | "zhCn" | "zhTw";
	/** A claim that the feature sends nothing until enabled, in this locale's shipped phrasings. */
	readonly claim: RegExp;
	/** The carve-out naming the dashboard's explicit button, in this locale. */
	readonly carveOut: RegExp;
}

const LOCALES: readonly LocaleShapes[] = [
	{
		nlsFile: "package.nls.json",
		proseKey: "en",
		claim: /no requests? (?:is|are) sent|nothing is sent|no review is sent/,
		carveOut: /Test model/,
	},
	{
		nlsFile: "package.nls.zh-cn.json",
		proseKey: "zhCn",
		claim: /不会?(?:发送|发出)任何(?:评审)?请求/,
		carveOut: /测试模型/,
	},
	{
		nlsFile: "package.nls.zh-tw.json",
		proseKey: "zhTw",
		claim: /不會?(?:送出|傳送|發送)任何(?:審查)?(?:請求|要求)/,
		carveOut: /測試模型/,
	},
];

/**
 * The one probe-carrying feature whose enable copy makes no withholding claim:
 * the quick-fix chat path costs nothing until invoked, so its description
 * never says "nothing is sent until enabled". Every other probe feature must
 * claim, in every locale and on both surfaces.
 */
const CLAIMLESS_FEATURES: ReadonlySet<string> = new Set(["quickFix"]);

/**
 * The per-cell rule, fail-closed on vacuity in both directions: a
 * claim-bearing feature must still make the withholding claim in this locale
 * (a translation that drops the claim, or rewords it past the recognizer,
 * fails here by name), a claimless-registered feature must still be claimless
 * (copy that gains the claim invalidates its exception entry instead of
 * silently ungating it), and any text that does claim must carve out the
 * Test model button.
 */
function assertCell(cell: string, feature: string, locale: LocaleShapes, text: string): void {
	const claims = locale.claim.test(text);
	if (CLAIMLESS_FEATURES.has(feature)) {
		expect(claims, `${cell} is registered claimless but now claims; update CLAIMLESS_FEATURES`).toBe(false);
	} else {
		expect(claims, `${cell} must carry the withholding claim (nothing is sent until enabled) in this locale`).toBe(
			true
		);
	}
	if (claims) {
		expect(
			locale.carveOut.test(text),
			`${cell} claims nothing is sent until enabled but does not carve out the Test model button`
		).toBe(true);
	}
}

describe("dashboard probe carve-out copy", () => {
	test("the claimless exception names only shipped probe features", () => {
		const features = probeFeatures();
		expect(features.length).toBeGreaterThan(0);
		for (const feature of CLAIMLESS_FEATURES) {
			expect(features, `claimless exception "${feature}" is a shipped probe feature`).toContain(feature);
		}
	});

	test("every probe-carrying feature's enable description keeps the claim and its carve-out, per locale", () => {
		const features = probeFeatures();
		expect(features.length).toBeGreaterThan(0);
		for (const locale of LOCALES) {
			const nls = JSON.parse(readFileSync(path.join(REPO_ROOT, locale.nlsFile), "utf8")) as Record<string, string>;
			for (const feature of features) {
				const description = nls[`litellm.config.${feature}.enabled.description`];
				expect(description, `${locale.nlsFile} describes ${feature}.enabled`).toBeDefined();
				if (description !== undefined) {
					assertCell(`${locale.nlsFile}: ${feature}.enabled`, feature, locale, description);
				}
			}
		}
	});

	test("the settings-reference prose carries the same claim and carve-out per probe-carrying feature, per locale", () => {
		const prose = readFileSync(path.join(REPO_ROOT, "scripts", "docs", "settingsReferenceProse.ts"), "utf8");
		for (const feature of probeFeatures()) {
			const block = new RegExp(`"${feature}\\.enabled":\\s*\\{[\\s\\S]*?\\n\\t\\}`).exec(prose)?.[0];
			expect(block, `settingsReferenceProse declares ${feature}.enabled`).toBeDefined();
			if (block === undefined) {
				continue;
			}
			// Per locale, not per block: an English carve-out must not satisfy the
			// rule for a Chinese claim that lost its own.
			for (const locale of LOCALES) {
				const text = new RegExp(`${locale.proseKey}: (["'])((?:\\\\.|(?!\\1).)*)\\1`).exec(block)?.[2];
				expect(text, `settingsReferenceProse: ${feature}.enabled has a ${locale.proseKey} entry`).toBeDefined();
				if (text !== undefined) {
					assertCell(`settingsReferenceProse (${locale.proseKey}): ${feature}.enabled`, feature, locale, text);
				}
			}
		}
	});
});
