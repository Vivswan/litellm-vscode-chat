/**
 * The fail-closed sweep over the features' one no-such-server error: the six
 * hand-written arms of the naming table (classification tag, English phrase)
 * are pinned here per FeatureModelId, so a typo in any arm - including the
 * ones no feature suite happens to exercise - fails this registry test
 * instead of shipping. New FeatureModelId members fail the sweep until they
 * get a row.
 */
import { describe, expect, test } from "bun:test";
import { noEntryForConfiguredServer } from "../../../../extension/features/modelSettingError";
import {
	CONFIG_SECTION,
	FEATURE_MODEL_IDS,
	FEATURE_MODEL_SETTING_KEYS,
	type FeatureModelId,
} from "../../../../shared/config/settingSpec";
import { MirroredError } from "../../../../shared/mirroredError";

/** The per-feature naming both message halves must carry; a new FeatureModelId fails the sweep until it lands here. */
const EXPECTED: Record<FeatureModelId, { readonly englishName: string; readonly logSurface: string }> = {
	inlineCompletions: { englishName: "inline completions", logSurface: "InlineCompletions" },
	commitGeneration: { englishName: "commit generation", logSurface: "CommitGeneration" },
	prGeneration: { englishName: "PR generation", logSurface: "PrGeneration" },
	consultTool: { englishName: "consult tool", logSurface: "ConsultTool" },
	quickFix: { englishName: "quick fix", logSurface: "QuickFix" },
	reviewComments: { englishName: "review comments", logSurface: "ReviewComments" },
};

describe("features/modelSettingError", () => {
	for (const feature of FEATURE_MODEL_IDS) {
		test(`${feature} names its own surface, phrase, and setting`, () => {
			const error = noEntryForConfiguredServer(feature, "Team proxy");
			expect(error).toBeInstanceOf(MirroredError);
			// The classification the feature suites' throw-site tests pin, derived
			// here for every arm - the unexercised ones included.
			expect(error.logClassification).toBe(`${EXPECTED[feature].logSurface}(configured server label matches no entry)`);
			const settingId = `${CONFIG_SECTION}.${FEATURE_MODEL_SETTING_KEYS[feature]}`;
			expect(error.englishMessage ?? "").toBe(
				`The ${EXPECTED[feature].englishName} model setting names server "Team proxy", ` +
					`but no servers entry carries that label. Update the "${settingId}" setting.`
			);
			// No bundle is configured under bun, so the display message is the
			// filled English template: the two halves must agree exactly.
			expect(error.message).toBe(error.englishMessage ?? "");
		});
	}
});
