import * as vscode from "vscode";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import type { SecretFieldId } from "../../shared/serverEntry";
import { readServerSecretsRecord, resolveOwnedSecrets } from "./serverSync/secrets";
import type { DeclaredServer } from "./serverSync/setting";
import { acceptedEntry } from "./serverSync/setting";
import type { UsageConnection } from "./usage/spendClient";
import { usageConnectionFor } from "./usage/spendClient";

/** What one label resolves to: the parsed entry, its connection, and the ownership verdict on its stored secrets. */
export interface EntryConnection {
	readonly entry: DeclaredServer;
	readonly connection: UsageConnection;
	/**
	 * This lists the stored fields stamped for another destination that this entry would send.
	 * Non-empty means the blob belongs to a different server.
	 * The usual cause is a base URL changed after the secret was stored.
	 * Sending such a value would hit a host it was never paired with.
	 * The verdict rides alongside the connection instead of gating it because the callers differ.
	 * The MCP publisher refuses the pairing.
	 * The editor talks to the server itself there, so there is no request of ours to read a 401 from.
	 * The one-shot features send anyway and let the server's own 401 report it, as they always have.
	 */
	readonly refusedSecrets: readonly SecretFieldId[];
}

/**
 * The one label-to-connection resolution for extension-side features that
 * address a declared servers entry by its label (the entry identity the sync
 * engine and usage resolution use): the shared featureChatSend (the five chat
 * features), the inline-completions FIM send, and the MCP publisher all
 * resolve through this. Secrets resolve like the usage path - inline settings
 * values outrank the label's SecretStorage blob. Undefined when no servers
 * entry carries the label; each caller shapes its own advice for that, since
 * the fix lives in a different setting per feature.
 */
export async function entryConnectionFor(
	secrets: vscode.SecretStorage,
	label: string
): Promise<EntryConnection | undefined> {
	const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY);
	const found = acceptedEntry(raw, label);
	if (found === undefined) {
		return undefined;
	}
	const record = await readServerSecretsRecord(secrets, label);
	return {
		entry: found.entry,
		connection: usageConnectionFor(found.entry, record.values),
		refusedSecrets: resolveOwnedSecrets(found.entry, record).refused,
	};
}
