import * as vscode from "vscode";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import { readServerSecrets } from "./serverSync/secrets";
import type { DeclaredServer } from "./serverSync/setting";
import { acceptedEntry } from "./serverSync/setting";
import type { UsageConnection } from "./usage/spendClient";
import { usageConnectionFor } from "./usage/spendClient";

/**
 * The one label-to-connection resolution for extension-side features that
 * address a declared servers entry by its label (the entry identity the sync
 * engine and usage resolution use): commit message generation and inline
 * completions both send through this. Secrets resolve like the usage path -
 * inline settings values outrank the label's SecretStorage blob. Undefined
 * when no servers entry carries the label; each caller shapes its own advice
 * for that, since the fix lives in a different setting per feature.
 */
export async function entryConnectionFor(
	secrets: vscode.SecretStorage,
	label: string
): Promise<{ readonly entry: DeclaredServer; readonly connection: UsageConnection } | undefined> {
	const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY);
	const found = acceptedEntry(raw, label);
	if (found === undefined) {
		return undefined;
	}
	const stored = await readServerSecrets(secrets, label);
	return { entry: found.entry, connection: usageConnectionFor(found.entry, stored) };
}
