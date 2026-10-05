import * as vscode from "vscode";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import { readServerSecretsRecord, resolveOwnedSecrets } from "./serverSync/secrets";
import type { DeclaredServer } from "./serverSync/setting";
import { acceptedEntry } from "./serverSync/setting";
import type { UsageConnection } from "./usage/spendClient";
import { usageConnectionFor } from "./usage/spendClient";

/**
 * Why a label resolved to no connection; a value rather than an error because each caller words its own sentence.
 * secretsMismatched is resolveOwnedSecrets' `refused`: a stored secret the entry would send is stamped for another
 * destination, usually a base URL edited after the secret was stored.
 */
export type EntryConnectionRefusal = "noEntry" | "secretsMismatched";

export type EntryConnectionResolution =
	| { readonly kind: "resolved"; readonly entry: DeclaredServer; readonly connection: UsageConnection }
	| { readonly kind: EntryConnectionRefusal };

/**
 * The one label-to-connection resolution for extension-side features that address a declared servers entry by its
 * label (the entry identity the sync engine and usage resolution use): the shared featureChatSend (the five chat
 * features), the inline-completions FIM send, and the MCP publisher all resolve through this.
 *
 *   Secrets resolve as the sync engine and the usage poller resolve them -> inline settings values outrank the blob
 */
export async function entryConnectionFor(
	secrets: vscode.SecretStorage,
	label: string
): Promise<EntryConnectionResolution> {
	const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY);
	const found = acceptedEntry(raw, label);
	if (found === undefined) {
		return { kind: "noEntry" };
	}
	const owned = resolveOwnedSecrets(found.entry, await readServerSecretsRecord(secrets, label));
	if (owned.refused.length > 0) {
		return { kind: "secretsMismatched" };
	}
	return { kind: "resolved", entry: found.entry, connection: usageConnectionFor(found.entry, owned.values) };
}
