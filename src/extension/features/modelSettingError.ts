import * as l10n from "@vscode/l10n";
import { CONFIG_SECTION, FEATURE_MODEL_SETTING_KEYS, type FeatureModelId } from "../../shared/config/settingSpec";
import { localizedError, type MirroredError } from "../../shared/mirroredError";

/** One feature's naming for the shared sentence: the localized and English phrases plus the log-surface tag. */
interface FeatureNaming {
	readonly name: string;
	readonly englishName: string;
	readonly logSurface: string;
}

function featureNaming(feature: FeatureModelId): FeatureNaming {
	switch (feature) {
		case "inlineCompletions":
			return {
				name: l10n.t("inline completions"),
				englishName: "inline completions",
				logSurface: "InlineCompletions",
			};
		case "commitGeneration":
			return { name: l10n.t("commit generation"), englishName: "commit generation", logSurface: "CommitGeneration" };
		case "prGeneration":
			return { name: l10n.t("PR generation"), englishName: "PR generation", logSurface: "PrGeneration" };
		case "consultTool":
			return { name: l10n.t("consult tool"), englishName: "consult tool", logSurface: "ConsultTool" };
		case "quickFix":
			return { name: l10n.t("quick fix"), englishName: "quick fix", logSurface: "QuickFix" };
		case "reviewComments":
			return { name: l10n.t("review comments"), englishName: "review comments", logSurface: "ReviewComments" };
	}
}

/**
 * The features' ONE "configured server label matches no entry" error, at the
 * features/ root (like errorLabel.ts) because features may not import each
 * other. Every one-shot feature's entryConnectionFor miss throws through this
 * sentence, with the setting ID derived from the same key registry the getters
 * read, so the advice always names the setting that actually misfired.
 */
export function noEntryForConfiguredServer(feature: FeatureModelId, serverLabel: string): MirroredError {
	const naming = featureNaming(feature);
	const settingId = `${CONFIG_SECTION}.${FEATURE_MODEL_SETTING_KEYS[feature]}`;
	return localizedError(
		l10n.t(
			'The {0} model setting names server "{1}", but no servers entry carries that label. Update the "{2}" setting.',
			naming.name,
			serverLabel,
			settingId
		),
		`The ${naming.englishName} model setting names server "${serverLabel}", but no servers entry carries that label. Update the "${settingId}" setting.`,
		`${naming.logSurface}(configured server label matches no entry)`
	);
}
