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
	 * Stored fields whose ownership stamp names a destination other than this
	 * entry's, and that the entry would otherwise have used (resolveOwnedSecrets'
	 * `refused`). A non-empty list means the label's blob was paired with a
	 * different server - the usual cause is a base URL edited after the secret
	 * was stored - so sending it would authenticate against a host nothing
	 * paired it with.
	 *
	 * The verdict rides ALONGSIDE the connection rather than gating it, because
	 * the callers disagree on purpose: the MCP publisher refuses the pairing (it
	 * hands credentials to the editor, which then talks to the server itself,
	 * so there is no request of ours to read a 401 from), while commit
	 * generation and inline completions send and let the server's own 401 tell
	 * the story, as they always have. Making them refuse is a behavior change
	 * for shipped features and belongs in its own commit.
	 */
	readonly refusedSecrets: readonly SecretFieldId[];
}

/**
 * The one label-to-connection resolution for extension-side features that
 * address a declared servers entry by its label (the entry identity the sync
 * engine and usage resolution use): commit message generation, inline
 * completions, and the MCP publisher all send through this. Secrets resolve
 * like the usage path - inline settings values outrank the label's
 * SecretStorage blob. Undefined when no servers entry carries the label; each
 * caller shapes its own advice for that, since the fix lives in a different
 * setting per feature.
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
