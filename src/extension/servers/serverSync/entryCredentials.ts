/**
 * The credential half of the provider's entry overlay: resolve one declared entry's CURRENT credentials in exactly the
 * rendering a sync pass would bake into its group (the same setting parse, secrets read, ownership check,
 * buildGroupArgs precedence, and parseGroupConfiguration narrowing), so the overlaid connection can never diverge from
 * what a freshly created group would carry. Related but deliberately separate: engine.resolveGroupArgs matches by
 * label alone and silently drops refused fields, which only the internal test command may tolerate.
 */

import type { GroupCredentialsResolution } from "../../../provider/catalog/groupModels";
import { parseGroupConfiguration } from "../../../provider/catalog/groupModels";
import { errorLabel } from "../../../shared/util/errorLabel";
import { buildGroupArgs } from "./engine";
import type { StoredSecretsRecord } from "./secrets";
import { resolveOwnedSecrets } from "./secrets";
import { matchedEntryFor } from "./setting";

/**
 * The match is matchedEntryFor's label AND normalized base URL rule, shared with headers, parameters, and
 * capabilities, so a leftover group from a base URL edit never receives the entry's credentials; the ownership check
 * is the sync pass's own fail-closed rule (resolveOwnedSecrets). The resolved values are secrets: never log them,
 * never push them into state.
 */
export async function entryGroupCredentialsFor(
	readServersSetting: () => unknown,
	readSecrets: (label: string) => Promise<StoredSecretsRecord>,
	label: string,
	baseUrl: string,
	log?: (message: string, data?: unknown) => void
): Promise<GroupCredentialsResolution> {
	const entry = matchedEntryFor(readServersSetting(), label, baseUrl);
	if (entry === undefined) {
		return { kind: "external" };
	}
	let record: StoredSecretsRecord;
	try {
		record = await readSecrets(label);
	} catch (error) {
		log?.("Reading a server entry's stored secrets for the credential overlay failed", {
			label,
			error: errorLabel(error),
		});
		return { kind: "unavailable", reason: "secretsUnreadable" };
	}
	const owned = resolveOwnedSecrets(entry, record);
	if (owned.refused.length > 0) {
		return { kind: "unavailable", reason: "secretsMismatched" };
	}
	const groupServer = parseGroupConfiguration(buildGroupArgs(entry, owned.values));
	if (groupServer === undefined) {
		return { kind: "unavailable", reason: "unusable" };
	}
	return {
		kind: "resolved",
		credentials: {
			apiKey: groupServer.apiKey,
			...(groupServer.oauth !== undefined ? { oauth: groupServer.oauth } : {}),
			...(groupServer.virtualKey !== undefined ? { virtualKey: groupServer.virtualKey } : {}),
		},
	};
}
