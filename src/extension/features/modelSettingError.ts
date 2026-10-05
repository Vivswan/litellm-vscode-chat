import * as l10n from "@vscode/l10n";
import { featureDisplayName, featureEnglishName, featureLogSurface } from "../../dashboard/featureNames";
import type { FeatureModelId } from "../../shared/config/settingSpec";
import { rejectedCredentialKinds } from "../../shared/failureCause";
import { localizedError, type MirroredError } from "../../shared/mirroredError";
import type { EntryConnectionRefused } from "../servers/entryConnection";
import { featureModelSettingId } from "./featureGate";

/**
 * The features' ONE "configured server yields no connection" error, at the features/ root because features may not
 * import each other; every one-shot feature's entryConnectionFor refusal throws through here.
 *
 *   The switch has no default -> a new refusal does not compile until it has a case
 */
export function configuredServerUnavailable(
	feature: FeatureModelId,
	serverLabel: string,
	refusal: EntryConnectionRefused
): MirroredError {
	const settingId = featureModelSettingId(feature);
	switch (refusal.kind) {
		case "noEntry":
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
		case "secretsMismatched":
			return localizedError(
				l10n.t(
					'The {0} model setting names server "{1}", but a stored secret for that entry was saved for a different server address. Set the secret again (edit the server in the dashboard, or run LiteLLM: Set Server Secret), or remove the stored value.',
					featureDisplayName(feature, "sentence"),
					serverLabel
				),
				`The ${featureEnglishName(feature)} model setting names server "${serverLabel}", but a stored secret for that entry was saved for a different server address. ` +
					"Set the secret again (edit the server in the dashboard, or run LiteLLM: Set Server Secret), or remove the stored value.",
				`${featureLogSurface(feature)}(stored secrets stamped for another destination)`
			);
		case "secretsUnreadable":
			return localizedError(
				l10n.t(
					'The {0} model setting names server "{1}", but reading its stored secrets failed. Try again.',
					featureDisplayName(feature, "sentence"),
					serverLabel
				),
				`The ${featureEnglishName(feature)} model setting names server "${serverLabel}", but reading its stored secrets failed. Try again.`,
				`${featureLogSurface(feature)}(stored secrets unreadable)`
			);
		case "credentialsRefused": {
			const kinds = rejectedCredentialKinds(refusal.fields);
			return localizedError(
				l10n.t(
					'The {0} model setting names server "{1}", but its {2} cannot be sent as an HTTP header, so nothing was sent. Enter the value again from the server row on the dashboard.',
					featureDisplayName(feature, "sentence"),
					serverLabel,
					kinds.display
				),
				`The ${featureEnglishName(feature)} model setting names server "${serverLabel}", but its ${kinds.english} cannot be sent as an HTTP header, so nothing was sent. Enter the value again from the server row on the dashboard.`,
				`${featureLogSurface(feature)}(configured credential cannot be sent as a header)`
			);
		}
	}
}
