/**
 * The credential half of the provider's entry overlay (overlayEntryCredentials): the current credentials of the
 * declared entry behind a labeled group, so a rotation reaches the next serve and request without a host re-add.
 */

import type { GroupCredentialsResolution } from "../../../provider/catalog/groupModels";
import { parseGroupConfiguration, refusedCredentialFields } from "../../../provider/catalog/groupModels";
import { errorLabel } from "../../../shared/util/errorLabel";
import { resolveOwnedGroupArgs } from "./engine";
import type { StoredSecretsRecord } from "./secrets";
import { rejectedCarrierLabels, serverSettingReports } from "./setting";

/**
 * With no accepted entry at this label and base URL, a label the setting still carries in a rejected shape (a rejected
 * carrier, rejectedCarrierLabels) is misconfigured, not external, so the group baked from its last accepted shape stops
 * serving on the old key.
 */
export async function entryGroupCredentialsFor(
	readServersSetting: () => unknown,
	readSecrets: (label: string) => Promise<StoredSecretsRecord>,
	label: string,
	baseUrl: string,
	log?: (message: string, data?: unknown) => void
): Promise<GroupCredentialsResolution> {
	const owned = await resolveOwnedGroupArgs({ readServersSetting, readSecrets }, label, baseUrl);
	if (owned.kind === "undeclared") {
		return rejectedCarrierLabels(serverSettingReports(owned.setting)).includes(label)
			? { kind: "unavailable", reason: "misconfigured" }
			: { kind: "external" };
	}
	if (owned.kind === "secretsUnreadable") {
		log?.("Reading a server entry's stored secrets for the credential overlay failed", {
			label,
			error: errorLabel(owned.error),
		});
		return { kind: "unavailable", reason: "secretsUnreadable" };
	}
	if (owned.refused.length > 0) {
		return { kind: "unavailable", reason: "secretsMismatched" };
	}
	const parsed = parseGroupConfiguration(owned.args);
	if (parsed === undefined) {
		return { kind: "unavailable", reason: "unusable" };
	}
	const refused = refusedCredentialFields(parsed.rejections);
	if (refused !== undefined) {
		return { kind: "unavailable", reason: "credentialsRefused", fields: refused };
	}
	return {
		kind: "resolved",
		credentials: {
			apiKey: parsed.server.apiKey,
			...(parsed.server.oauth !== undefined ? { oauth: parsed.server.oauth } : {}),
			...(parsed.server.virtualKey !== undefined ? { virtualKey: parsed.server.virtualKey } : {}),
		},
	};
}
