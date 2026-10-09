import type * as vscode from "vscode";
import type { RejectedCredentialField } from "../../shared/serverEntry";
import { resolveOwnedGroupArgs } from "./serverSync/engine";
import { readServerSecretsRecord } from "./serverSync/secrets";
import type { DeclaredServer } from "./serverSync/setting";
import { readRawServersSetting } from "./serverSync/vscodeEnv";
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
 *   The group arguments are the sync engine's own (resolveOwnedGroupArgs) -> a feature sends what a pass would bake
 */
export async function entryConnectionFor(
	secrets: vscode.SecretStorage,
	label: string
): Promise<EntryConnectionResolution> {
	const owned = await resolveOwnedGroupArgs(
		{
			readServersSetting: readRawServersSetting,
			readSecrets: (entryLabel) => readServerSecretsRecord(secrets, entryLabel),
		},
		label
	);
	switch (owned.kind) {
		case "undeclared":
			return { kind: "noEntry" };
		case "secretsUnreadable":
			return { kind: "secretsUnreadable" };
		case "owned": {
			if (owned.refused.length > 0) {
				return { kind: "secretsMismatched" };
			}
			const resolution = usageConnectionFor(owned.entry, owned.args);
			if (resolution.kind === "credentialsRefused") {
				return resolution;
			}
			return { kind: "resolved", entry: owned.entry, connection: resolution.connection };
		}
	}
}
