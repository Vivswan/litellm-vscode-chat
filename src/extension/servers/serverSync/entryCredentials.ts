/**
 * The credential half of the provider's entry overlay: resolve one declared
 * entry's CURRENT credentials in exactly the rendering a sync pass would bake
 * into its group (the same setting parse, secrets read, ownership check,
 * buildGroupArgs precedence, and parseGroupConfiguration narrowing), so the
 * overlaid connection can never diverge from what a freshly created group
 * would carry. Related but deliberately separate: engine.resolveGroupArgs
 * matches by label alone and silently drops refused fields, which only the
 * internal test command may tolerate.
 */

import type { GroupCredentials } from "../../../provider/catalog/groupModels";
import { parseGroupConfiguration } from "../../../provider/catalog/groupModels";
import { errorLabel } from "../../../shared/util/errorLabel";
import { buildGroupArgs } from "./engine";
import type { StoredSecretsRecord } from "./secrets";
import { resolveOwnedSecrets } from "./secrets";
import { matchedEntryFor } from "./setting";

/**
 * The declared entry's current credentials for a group at `baseUrl` labeled
 * `label`, or undefined when the baked credentials must stay in force: no
 * declared entry matches on label AND normalized base URL (matchedEntryFor's
 * rule, shared with headers, parameters, and capabilities - a leftover group
 * from a base URL edit must never receive the entry's credentials), a stored
 * secret's ownership stamp refuses the pairing (the same fail-closed rule the
 * sync pass applies), or the secrets read fails. The returned values are
 * resolved secrets: never log them, never push them into state.
 */
export async function entryGroupCredentialsFor(
	readServersSetting: () => unknown,
	readSecrets: (label: string) => Promise<StoredSecretsRecord>,
	label: string,
	baseUrl: string,
	log?: (message: string, data?: unknown) => void
): Promise<GroupCredentials | undefined> {
	const entry = matchedEntryFor(readServersSetting(), label, baseUrl);
	if (entry === undefined) {
		return undefined;
	}
	let record: StoredSecretsRecord;
	try {
		record = await readSecrets(label);
	} catch (error) {
		log?.("Reading a server entry's stored secrets for the credential overlay failed", {
			label,
			error: errorLabel(error),
		});
		return undefined;
	}
	const owned = resolveOwnedSecrets(entry, record);
	if (owned.refused.length > 0) {
		return undefined;
	}
	const groupServer = parseGroupConfiguration(buildGroupArgs(entry, owned.values));
	if (groupServer === undefined) {
		return undefined;
	}
	return {
		apiKey: groupServer.apiKey,
		...(groupServer.oauth !== undefined ? { oauth: groupServer.oauth } : {}),
		...(groupServer.virtualKey !== undefined ? { virtualKey: groupServer.virtualKey } : {}),
	};
}
