import * as vscode from "vscode";
import type { RejectedCredentialField } from "../../provider/catalog/groupModels";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import type { StoredSecretsRecord } from "./serverSync/secrets";
import { readServerSecretsRecord, resolveOwnedSecrets } from "./serverSync/secrets";
import type { DeclaredServer } from "./serverSync/setting";
import { acceptedEntry } from "./serverSync/setting";
import type { UsageConnection } from "./usage/spendClient";
import { usageConnectionFor } from "./usage/spendClient";

/**
 * Why a label resolved to no connection; a value rather than an error because each caller words its own sentence.
 * secretsMismatched is resolveOwnedSecrets' `refused`: a stored secret the entry would send is stamped for another
 * destination, usually a base URL edited after the secret was stored. secretsUnreadable carries nothing of the read
 * error: its message can hold storage text, and the feature boundaries log and notify with what they are thrown.
 * credentialsRefused is usageConnectionFor's: a configured key cannot ride its header, and the fields name which.
 */
type EntryConnectionRefusal = "noEntry" | "secretsMismatched" | "secretsUnreadable" | "credentialsRefused";

export type EntryConnectionRefused =
	| { readonly kind: Exclude<EntryConnectionRefusal, "credentialsRefused"> }
	| {
			readonly kind: "credentialsRefused";
			readonly fields: readonly [RejectedCredentialField, ...RejectedCredentialField[]];
	  };

export type EntryConnectionResolution =
	| { readonly kind: "resolved"; readonly entry: DeclaredServer; readonly connection: UsageConnection }
	| EntryConnectionRefused;

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
	let record: StoredSecretsRecord;
	try {
		record = await readServerSecretsRecord(secrets, label);
	} catch {
		return { kind: "secretsUnreadable" };
	}
	const owned = resolveOwnedSecrets(found.entry, record);
	if (owned.refused.length > 0) {
		return { kind: "secretsMismatched" };
	}
	const resolution = usageConnectionFor(found.entry, owned.values);
	if (resolution.kind === "credentialsRefused") {
		return resolution;
	}
	return { kind: "resolved", entry: found.entry, connection: resolution.connection };
}
