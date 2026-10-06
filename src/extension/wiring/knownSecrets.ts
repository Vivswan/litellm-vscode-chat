import * as vscode from "vscode";
import { CONFIG_SECTION, LOG_REDACTION_SETTING_KEY } from "../../shared/config/settingSpec";
import { SERVERS_SETTING_KEY } from "../../shared/config/settings";
import { isServerSecretsKey } from "../../shared/config/storageKeys";
import type { Logger } from "../../shared/logger";
import { collectKnownSecretValues } from "../../shared/util/knownSecrets";
import { onServerSecretWritten, readServerSecretsRecord } from "../servers/serverSync/secrets";
import { collectableEntries, declaredEntryLabel } from "../servers/serverSync/setting";

/**
 * Publish every credential value the configuration holds to the output door, which keeps their union for the session:
 * the raw servers setting's values (accepted or not, so a rejected entry's credentials count), each declared label's
 * SecretStorage blob, and every value this window writes into a blob, so a key just typed into the setting is known
 * to the first line that quotes it.
 *   activation                -> awaited until the setting's values and the blobs read at activation have published
 *   a servers-setting edit    -> the setting's values publish before the listener returns; the blobs follow
 *   a server-secret change    -> the same two publishes
 *   a value this window writes -> published from the write itself; the change event behind it carries no value
 *   one blob read failing     -> a logged error, the other blobs' values publish
 */
export async function wireKnownSecrets(
	context: vscode.ExtensionContext,
	logger: Logger,
	publish: (values: readonly string[]) => void
): Promise<void> {
	const readBlob = async (label: string): Promise<readonly string[]> => {
		try {
			const record = await readServerSecretsRecord(context.secrets, label);
			return record === undefined ? [] : Object.values(record.values);
		} catch (error) {
			logger.error("Known-secret blob read failed", error);
			return [];
		}
	};
	const refresh = async (): Promise<void> => {
		const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY);
		publish(collectKnownSecretValues(collectableEntries(raw), []));
		const rawRecords: readonly unknown[] = Array.isArray(raw) ? raw : [];
		const declared = rawRecords.map(declaredEntryLabel).filter((label): label is string => label !== undefined);
		const stored = await Promise.all([...new Set(declared)].map(readBlob));
		publish(collectKnownSecretValues([], stored.flat()));
	};
	context.subscriptions.push(
		onServerSecretWritten((values) => publish(collectKnownSecretValues([], values))),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(`${CONFIG_SECTION}.${SERVERS_SETTING_KEY}`)) {
				void refresh();
			}
		}),
		context.secrets.onDidChange((event) => {
			if (isServerSecretsKey(event.key)) {
				void refresh();
			}
		})
	);
	await refresh();
}

/** A logs.redactSecrets flip re-renders the channel from the buffer under the mode now in force. */
export function onLogRedactionToggled(context: vscode.ExtensionContext, replay: () => void): void {
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(`${CONFIG_SECTION}.${LOG_REDACTION_SETTING_KEY}`)) {
				replay();
			}
		})
	);
}
