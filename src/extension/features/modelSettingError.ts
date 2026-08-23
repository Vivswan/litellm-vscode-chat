import * as l10n from "@vscode/l10n";
import { featureDisplayName, featureEnglishName, featureLogSurface } from "../../dashboard/featureNames";
import type { FeatureModelId } from "../../shared/config/settingSpec";
import { localizedError, type MirroredError } from "../../shared/mirroredError";
import { featureModelSettingId } from "./featureGate";

/**
 * The features' ONE "configured server label matches no entry" error, at the
 * features/ root because features may not import each other. Every one-shot
 * feature's entryConnectionFor miss throws through this sentence, with the
 * feature's name read from the shared display-name registry and the setting ID
 * derived by the shared gate, so the advice always names the setting that
 * actually misfired.
 */
export function noEntryForConfiguredServer(feature: FeatureModelId, serverLabel: string): MirroredError {
	const settingId = featureModelSettingId(feature);
	return localizedError(
		l10n.t(
			'The {0} model setting names server "{1}", but no servers entry carries that label. Update the "{2}" setting.',
			featureDisplayName(feature, "sentence"),
			serverLabel,
			settingId
		),
		`The ${featureEnglishName(feature)} model setting names server "${serverLabel}", but no servers entry carries that label. Update the "${settingId}" setting.`,
		`${featureLogSurface(feature)}(configured server label matches no entry)`
	);
}
