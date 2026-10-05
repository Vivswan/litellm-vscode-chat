import * as vscode from "vscode";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import type { SecretFieldId } from "../../shared/serverEntry";
import { readServerSecretsRecord, resolveOwnedSecrets } from "./serverSync/secrets";
import type { DeclaredServer } from "./serverSync/setting";
import { acceptedEntry } from "./serverSync/setting";
import type { UsageConnection } from "./usage/spendClient";
import { usageConnectionFor } from "./usage/spendClient";

export interface EntryConnection {
	readonly entry: DeclaredServer;
	readonly connection: UsageConnection;
	/**
	 * resolveOwnedSecrets' `refused` for this entry; non-empty means the label's blob was paired with another
	 * server, usually a base URL edited after the secret was stored. The verdict rides beside the connection
	 * instead of gating it because the callers disagree on purpose.
	 *
	 *   the editor talks to the server itself -> MCP publisher (features/mcp/provider.ts) refuses
	 *   one-shot feature sends                -> send anyway and let the server's own 401 tell the story
	 */
	readonly refusedSecrets: readonly SecretFieldId[];
}

/**
 * The one label-to-connection resolution for extension-side features that address a declared servers entry by its
 * label (the entry identity the sync engine and usage resolution use): the shared featureChatSend (the five chat
 * features), the inline-completions FIM send, and the MCP publisher all resolve through this. Undefined when no
 * servers entry carries the label; each caller shapes its own advice for that, since the fix lives in a different
 * setting per feature.
 *
 *   Secrets resolve like the usage path -> inline settings values outrank the label's SecretStorage blob
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
