/**
 * The last-mile vscode wiring: the real ServerSyncEnv over workspace
 * configuration, SecretStorage, globalState, and the host command, plus the
 * Set Server Secret palette command.
 */

import * as vscode from "vscode";
import { CMD, INTERNAL_CMD } from "../../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import { SERVERS_SETTING_KEY } from "../../../shared/config/settings";
import { SERVER_SYNC_FINGERPRINTS_KEY } from "../../../shared/config/storageKeys";
import type { Logger } from "../../../shared/logger";
import type { SecretFieldId } from "../../../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import type { ServerSyncEngine, ServerSyncEnv } from "./engine";
import { inlineSecretValues, readServerSecrets, updateServerSecret } from "./secrets";
import type { EntryModelParameters } from "./setting";
import { acceptedEntry, parseServersSetting } from "./setting";

/** The real environment: workspace configuration, SecretStorage, globalState, and the host command. */
export function createServerSyncEnv(context: vscode.ExtensionContext, logger: Logger): ServerSyncEnv {
	return {
		readServersSetting: () => vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY),
		readSecrets: (label) => readServerSecrets(context.secrets, label),
		addProviderGroup: (args) => vscode.commands.executeCommand("lm.addLanguageModelsProviderGroup", args),
		getFingerprints: () => context.globalState.get<Record<string, string>>(SERVER_SYNC_FINGERPRINTS_KEY) ?? {},
		setFingerprints: async (map) => {
			await context.globalState.update(SERVER_SYNC_FINGERPRINTS_KEY, map);
		},
		notifyRemoved: (labels) => {
			const list = labels.join(", ");
			void vscode.window
				.showInformationMessage(
					`Removed from the servers setting: ${list}. VS Code keeps the provider group; remove it in the native Manage Language Models editor.`,
					"Open native editor"
				)
				.then((choice) => {
					if (choice === "Open native editor") {
						void vscode.commands.executeCommand(INTERNAL_CMD.manageServers);
					}
				});
		},
		log: (message, data) => logger.log(message, data),
		logError: (message, error) => logger.error(message, error),
	};
}

/**
 * The request path's read of one declared entry's per-entry modelParameters:
 * the same live settings channel the sync engine reads, resolved through
 * acceptedEntry so it lands on exactly the entry the label describes.
 * Injected into the provider at activation (the provider layer cannot import
 * this module); a label no declared entry carries yields undefined.
 */
export function readEntryModelParameters(label: string): EntryModelParameters | undefined {
	const raw: unknown = vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY);
	return acceptedEntry(raw, label)?.entry.modelParameters;
}

/** Palette display copy per secret field; UI strings stay out of the shared descriptor. */
const SECRET_PALETTE_LABELS: Readonly<Record<SecretFieldId, string>> = {
	apiKey: "API key",
	oauthClientSecret: "OAuth client secret",
	virtualKeyValue: "Virtual key value",
};

/**
 * The palette path for keeping secrets out of settings.json without the
 * dashboard: pick a declared server, pick the secret field, enter the value
 * masked. An empty value removes the stored secret.
 */
export function registerSetServerSecretCommand(
	context: vscode.ExtensionContext,
	engine: ServerSyncEngine,
	logger: Logger
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.setServerSecret, async () => {
			const { entries } = parseServersSetting(
				vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY)
			);
			if (entries.length === 0) {
				void vscode.window.showInformationMessage(
					`No servers declared in the ${CONFIG_SECTION}.${SERVERS_SETTING_KEY} setting yet. Add one there or in the dashboard first.`
				);
				return;
			}
			const entryPick = await vscode.window.showQuickPick(
				entries.map((entry) => ({ label: entry.label, description: entry.baseUrl, entry })),
				{ title: "LiteLLM: Set Server Secret", placeHolder: "Which server?" }
			);
			if (entryPick === undefined) {
				return;
			}
			const fieldPick = await vscode.window.showQuickPick(
				// Ids come from the descriptor so a new secret field cannot be
				// silently unreachable here; the Record makes a missing label a
				// compile error.
				SECRET_FIELD_IDS.map((field) => ({ label: SECRET_PALETTE_LABELS[field], field })),
				{ title: "LiteLLM: Set Server Secret", placeHolder: "Which secret?" }
			);
			if (fieldPick === undefined) {
				return;
			}
			const value = await vscode.window.showInputBox({
				title: `${fieldPick.label} for ${entryPick.label}`,
				prompt: "Stored in VS Code secret storage, never in settings files. Leave empty to remove the stored value.",
				password: true,
			});
			if (value === undefined) {
				return;
			}
			await updateServerSecret(context.secrets, entryPick.label, fieldPick.field, value.length > 0 ? value : undefined);
			logger.log("Server secret updated from the palette", {
				label: entryPick.label,
				field: fieldPick.field,
				cleared: value.length === 0,
			});
			if (value.length > 0 && inlineSecretValues(entryPick.entry)[fieldPick.field] !== undefined) {
				// Inline settings values outrank the stored blob (the same
				// inlineSecretValues rule buildGroupArgs resolves through), so the
				// just-stored secret stays dormant until the inline one is removed.
				void vscode.window.showWarningMessage(
					`"${entryPick.label}" also sets ${fieldPick.field} inline in the servers setting, and inline values take precedence. Remove the inline value for the stored secret to take effect.`
				);
			}
			engine.requestSync();
		})
	);
}
