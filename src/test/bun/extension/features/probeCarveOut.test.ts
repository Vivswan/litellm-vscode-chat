/**
 * The probe carve-out pin: a dashboard "Test model" probe sends one request on
 * the user's click even while its feature is disabled, so any enable-setting
 * copy claiming "nothing is sent until enabled" must carve out that button for
 * every feature that carries a probe. This bit the commitGeneration probe once
 * (the probe landed, the copy kept the absolute claim), so the rule is pinned
 * fail-closed: the probe list is read from the render fixture (itself pinned
 * equal to the production probe registry by features.test.ts), and every
 * withholding claim in the nls descriptions and the settings-reference prose
 * must mention the button, in every locale.
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

/** A claim that the feature sends nothing until enabled, in any shipped locale. */
const WITHHOLDING_CLAIM =
	/no requests? (?:is|are) sent|nothing is sent|no review is sent|不发送任何请求|不會傳送任何請求|不送出任何要求|不會發送任何請求/;

/** The carve-out naming the dashboard's explicit button, in any shipped locale. */
const CARVE_OUT = /Test model|测试模型|測試模型/;

describe("dashboard probe carve-out copy", () => {
	test("every probe-carrying feature's enable description carves out the Test model button", () => {
		const features = probeFeatures();
		expect(features.length).toBeGreaterThan(0);
		for (const nlsFile of ["package.nls.json", "package.nls.zh-cn.json", "package.nls.zh-tw.json"]) {
			const nls = JSON.parse(readFileSync(path.join(REPO_ROOT, nlsFile), "utf8")) as Record<string, string>;
			for (const feature of features) {
				const description = nls[`litellm.config.${feature}.enabled.description`];
				expect(description, `${nlsFile} describes ${feature}.enabled`).toBeDefined();
				if (description !== undefined && WITHHOLDING_CLAIM.test(description)) {
					expect(
						CARVE_OUT.test(description),
						`${nlsFile}: ${feature}.enabled claims nothing is sent until enabled but does not carve out the Test model button`
					).toBe(true);
				}
			}
		}
	});

	test("the settings-reference prose carries the same carve-out per probe-carrying feature, per locale", () => {
		const prose = readFileSync(path.join(REPO_ROOT, "scripts", "docs", "settingsReferenceProse.ts"), "utf8");
		for (const feature of probeFeatures()) {
			const block = new RegExp(`"${feature}\\.enabled":\\s*\\{[\\s\\S]*?\\n\\t\\}`).exec(prose)?.[0];
			expect(block, `settingsReferenceProse declares ${feature}.enabled`).toBeDefined();
			if (block === undefined) {
				continue;
			}
			// Per locale, not per block: an English carve-out must not satisfy the
			// rule for a Chinese claim that lost its own.
			for (const locale of ["en", "zhCn", "zhTw"]) {
				const text = new RegExp(`${locale}: (["'])((?:\\\\.|(?!\\1).)*)\\1`).exec(block)?.[2];
				expect(text, `settingsReferenceProse: ${feature}.enabled has a ${locale} entry`).toBeDefined();
				if (text !== undefined && WITHHOLDING_CLAIM.test(text)) {
					expect(
						CARVE_OUT.test(text),
						`settingsReferenceProse (${locale}): ${feature}.enabled claims nothing is sent until enabled but does not carve out the Test model button`
					).toBe(true);
				}
			}
		}
	});
});
