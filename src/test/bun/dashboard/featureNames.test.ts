/**
 * The keys themselves are read off the registry under the empty bundle, where t() returns its key, so this suite
 * restates no table.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as l10n from "@vscode/l10n";
import { featureDisplayName, featureEnglishName, featureLogSurface } from "../../../dashboard/featureNames";
import { FEATURE_IDS } from "../../../shared/config/settingSpec";
import { REPO_ROOT } from "../../util/repoRoot";

const FORMS = ["title", "sentence"] as const;

describe("dashboard featureNames registry", () => {
	beforeAll(() => {
		// l10n configuration is module-global and sticky; pin the empty bundle so t() returns its keys here regardless
		// of which suites ran before.
		l10n.config({ contents: {} });
	});

	test("the forms resolve through l10n at call time and the English mirror stays English by policy", () => {
		const keys = new Map(
			FEATURE_IDS.map((feature) => [
				feature,
				{
					title: featureDisplayName(feature, "title"),
					sentence: featureDisplayName(feature, "sentence"),
					logSurface: featureLogSurface(feature),
				},
			])
		);
		for (const [feature, key] of keys) {
			expect(featureEnglishName(feature), `${feature} English mirror equals its sentence form's l10n key`).toBe(
				key.sentence
			);
		}
		const zhCn = JSON.parse(readFileSync(path.join(REPO_ROOT, "l10n", "bundle.l10n.zh-cn.json"), "utf8")) as Record<
			string,
			string
		>;
		l10n.config({ contents: zhCn });
		try {
			for (const [feature, key] of keys) {
				for (const form of FORMS) {
					expect(featureDisplayName(feature, form), `${feature} ${form} localizes under a configured bundle`).toBe(
						zhCn[key[form]] as string
					);
				}
				expect(featureEnglishName(feature), `${feature} English mirror ignores the configured bundle`).toBe(
					key.sentence
				);
				expect(featureLogSurface(feature), `${feature} log surface ignores the configured bundle`).toBe(key.logSurface);
			}
		} finally {
			l10n.config({ contents: {} });
		}
	});
});
