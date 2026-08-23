/**
 * The feature-name registry pin, direct and total: every FeatureId resolves
 * both grammatical forms, the sentence form's English mirror, and the
 * PascalCase log surface, the forms resolve through l10n at call time (a
 * configured bundle re-points them while the mirror stays English by policy),
 * and every form is a key the shipped bundles translate - each assertion
 * failing by feature, form, and locale name, so a drifted or missing string
 * is named, never counted. The expected table is an equality pin on the
 * registry's switch; `satisfies Record<FeatureId, ...>` keeps it total both
 * ways at compile time.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as l10n from "@vscode/l10n";
import { featureDisplayName, featureEnglishName, featureLogSurface } from "../../../dashboard/featureNames";
import { FEATURE_IDS, type FeatureId } from "../../../shared/config/settingSpec";
import { REPO_ROOT } from "../../util/repoRoot";

/** One feature's pinned names: the l10n keys of both forms plus the English-by-policy log tag. */
interface ExpectedNames {
	readonly title: string;
	readonly sentence: string;
	readonly logSurface: string;
}

const EXPECTED = {
	inlineCompletions: { title: "Inline completions", sentence: "inline completions", logSurface: "InlineCompletions" },
	commitGeneration: {
		title: "Commit message generation",
		sentence: "commit generation",
		logSurface: "CommitGeneration",
	},
	prGeneration: { title: "PR description generation", sentence: "PR generation", logSurface: "PrGeneration" },
	consultTool: { title: "Consult tool", sentence: "consult tool", logSurface: "ConsultTool" },
	quickFix: { title: "Quick fixes", sentence: "quick fix", logSurface: "QuickFix" },
	reviewComments: { title: "Review comments", sentence: "review comments", logSurface: "ReviewComments" },
	chatParticipant: {
		title: "Chat participant (@litellm)",
		sentence: "chat participant",
		logSurface: "ChatParticipant",
	},
} as const satisfies Record<FeatureId, ExpectedNames>;

const FORMS = ["title", "sentence"] as const;

/** The shipped locale bundles (bundle.l10n.<locale>.json; the English reference is not one of them). */
function localeBundles(): { file: string; messages: Record<string, unknown> }[] {
	return readdirSync(path.join(REPO_ROOT, "l10n"))
		.filter((name) => /^bundle\.l10n\..+\.json$/.test(name))
		.sort()
		.map((file) => ({
			file,
			messages: JSON.parse(readFileSync(path.join(REPO_ROOT, "l10n", file), "utf8")) as Record<string, unknown>,
		}));
}

describe("dashboard featureNames registry", () => {
	beforeAll(() => {
		// l10n configuration is module-global and sticky; pin the empty bundle so
		// t() returns its keys here regardless of which suites ran before.
		l10n.config({ contents: {} });
	});

	for (const feature of FEATURE_IDS) {
		test(`${feature} resolves both forms, the English mirror, and the log surface`, () => {
			expect(featureDisplayName(feature, "title"), `${feature} title form`).toBe(EXPECTED[feature].title);
			expect(featureDisplayName(feature, "sentence"), `${feature} sentence form`).toBe(EXPECTED[feature].sentence);
			expect(featureEnglishName(feature), `${feature} English mirror equals its sentence form's l10n key`).toBe(
				EXPECTED[feature].sentence
			);
			expect(featureLogSurface(feature), `${feature} log surface`).toBe(EXPECTED[feature].logSurface);
			expect(featureLogSurface(feature), `${feature} log surface is a terse PascalCase tag`).toMatch(
				/^[A-Z][A-Za-z0-9]*$/
			);
		});
	}

	test("the extracted English reference carries every feature-name key", () => {
		const reference = JSON.parse(readFileSync(path.join(REPO_ROOT, "l10n", "bundle.l10n.json"), "utf8")) as Record<
			string,
			unknown
		>;
		for (const feature of FEATURE_IDS) {
			for (const form of FORMS) {
				const key = EXPECTED[feature][form];
				expect(
					Object.hasOwn(reference, key),
					`bundle.l10n.json extracts ${feature} ${form} (${JSON.stringify(key)})`
				).toBe(true);
			}
		}
	});

	test("every form of every feature name has a non-empty translation in every shipped locale bundle", () => {
		const bundles = localeBundles();
		expect(bundles.length).toBeGreaterThan(0);
		for (const { file, messages } of bundles) {
			for (const feature of FEATURE_IDS) {
				for (const form of FORMS) {
					const key = EXPECTED[feature][form];
					const translation = messages[key];
					expect(
						typeof translation === "string" && translation.length > 0,
						`${file}: ${feature} ${form} (${JSON.stringify(key)}) has a non-empty translation`
					).toBe(true);
				}
			}
		}
	});

	test("the forms resolve through l10n at call time and the English mirror stays English by policy", () => {
		const zhCn = JSON.parse(readFileSync(path.join(REPO_ROOT, "l10n", "bundle.l10n.zh-cn.json"), "utf8")) as Record<
			string,
			string
		>;
		l10n.config({ contents: zhCn });
		try {
			for (const feature of FEATURE_IDS) {
				for (const form of FORMS) {
					expect(featureDisplayName(feature, form), `${feature} ${form} localizes under a configured bundle`).toBe(
						zhCn[EXPECTED[feature][form]] ?? ""
					);
				}
				expect(featureEnglishName(feature), `${feature} English mirror ignores the configured bundle`).toBe(
					EXPECTED[feature].sentence
				);
				expect(featureLogSurface(feature), `${feature} log surface ignores the configured bundle`).toBe(
					EXPECTED[feature].logSurface
				);
			}
		} finally {
			l10n.config({ contents: {} });
		}
	});
});
