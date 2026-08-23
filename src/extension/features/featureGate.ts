import * as l10n from "@vscode/l10n";
import { featureDisplayName, featureEnglishName } from "../../dashboard/featureNames";
import type { FeatureId, FeatureModelId } from "../../shared/config/settingSpec";
import {
	CONFIG_SECTION,
	FEATURE_ENABLE_SETTING_KEYS,
	FEATURE_MODEL_SETTING_KEYS,
} from "../../shared/config/settingSpec";

/**
 * The features' one refusal vocabulary, at the features/ root because features
 * may not import each other: the two setting-ID derivations and the two gate
 * sentences every feature's enable and model checks speak. The feature name
 * comes from the shared display-name registry and each setting ID from the
 * same key registry the getters read, so a rename fails this compile instead
 * of leaving advice pointing at a dead setting - and no feature can drift into
 * a private variant of the sentence (the old consult-tool copy had already
 * lost the dashboard mention). Richer refusals (quickFix's dual-reason advice)
 * stay callers of the ID derivations while owning their own sentences.
 */

/** The full enable-setting ID a disabled-feature hint names and its open-settings action targets. */
export function featureEnableSettingId(feature: FeatureId): string {
	return `${CONFIG_SECTION}.${FEATURE_ENABLE_SETTING_KEYS[feature]}`;
}

/** The full model-setting ID a no-model hint names and its open-settings action targets. */
export function featureModelSettingId(feature: FeatureModelId): string {
	return `${CONFIG_SECTION}.${FEATURE_MODEL_SETTING_KEYS[feature]}`;
}

/** The one disabled-feature sentence, localized; the English mirror is featureDisabledMessageEnglish. */
export function featureDisabledMessage(feature: FeatureId): string {
	return l10n.t(
		'The {0} feature is off. Enable "{1}" in settings to use it.',
		featureDisplayName(feature, "sentence"),
		featureEnableSettingId(feature)
	);
}

/** The disabled sentence's English mirror, for MirroredError surfaces. */
export function featureDisabledMessageEnglish(feature: FeatureId): string {
	return `The ${featureEnglishName(feature)} feature is off. Enable "${featureEnableSettingId(feature)}" in settings to use it.`;
}

/** The one no-model sentence, localized; the English mirror is featureNoModelMessageEnglish. */
export function featureNoModelMessage(feature: FeatureModelId): string {
	return l10n.t(
		'No model is configured for the {0} feature. Pick one via the "{1}" setting or the LiteLLM dashboard.',
		featureDisplayName(feature, "sentence"),
		featureModelSettingId(feature)
	);
}

/** The no-model sentence's English mirror, for MirroredError surfaces. */
export function featureNoModelMessageEnglish(feature: FeatureModelId): string {
	return `No model is configured for the ${featureEnglishName(feature)} feature. Pick one via the "${featureModelSettingId(feature)}" setting or the LiteLLM dashboard.`;
}
