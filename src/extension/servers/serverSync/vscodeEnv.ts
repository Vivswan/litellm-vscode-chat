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
import type { FingerprintSaltSession } from "../../fingerprintSalt";
import type { ServerSyncEngine, ServerSyncEnv } from "./engine";
import { inlineSecretValues, readServerSecrets, updateServerSecret } from "./secrets";
import type { EntryModelParameters } from "./setting";
import { entryModelParametersFor, parseServersSetting } from "./setting";

/** The real environment: workspace configuration, SecretStorage, globalState, and the host command. */
export function createServerSyncEnv(
	context: vscode.ExtensionContext,
	logger: Logger,
	fingerprintSalt: FingerprintSaltSession
): ServerSyncEnv {
	if (fingerprintSalt.state() !== "durable") {
		logger.log(
			"Server sync will not persist fingerprints this session: the fingerprint salt is session-only, so no later session could recognize them"
		);
	}
	return {
		readServersSetting: () => vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY),
		readSecrets: (label) => readServerSecrets(context.secrets, label),
		addProviderGroup: (args) => vscode.commands.executeCommand("lm.addLanguageModelsProviderGroup", args),
		confirmFingerprintsDurable: async () => (await fingerprintSalt.confirmDurable()) === "durable",
		getFingerprints: () => {
			// Validated at the trust boundary: the key is engine-owned and only
			// ever written with strings, so a non-string value is corruption and
			// must not ride into the session map (and back out through the
			// pass-end write) behind an unchecked cast.
			const stored = context.globalState.get<unknown>(SERVER_SYNC_FINGERPRINTS_KEY);
			if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
				return {};
			}
			return Object.fromEntries(
				Object.entries(stored).filter((field): field is [string, string] => typeof field[1] === "string")
			);
		},
		setFingerprints: async (map) => {
			// Re-confirmed at write time, per batch, not once per pass: a store
			// mutation detected mid-pass must stop this write too. A map built
			// under an unconfirmed salt holds renderings no later session can
			// recognize, and persisting it would overwrite the durable records
			// that let a healthy group read as in-sync once the real salt is
			// back. confirmDurable never throws.
			if ((await fingerprintSalt.confirmDurable()) !== "durable") {
				return;
			}
			await context.globalState.update(SERVER_SYNC_FINGERPRINTS_KEY, map);
		},
		notifyRemoved: (labels) => {
			const list = labels.join(", ");
			void vscode.window
				.showInformationMessage(
					`Removed from the servers setting: ${list}. VS Code keeps the provider group and it stays active with global settings only; remove it in the native Manage Language Models editor. If this was a rename made directly in the settings file, the new label starts without the old label's stored secrets - set them again for the new entry (a dashboard rename copies them).`,
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
 * entryModelParametersFor so it lands only on an entry whose label AND base
 * URL both match the server the request is routed to. Injected into the
 * provider at activation (the provider layer cannot import this module); a
 * (label, baseUrl) pair no declared entry carries yields undefined.
 */
export function readEntryModelParameters(label: string, baseUrl: string): EntryModelParameters | undefined {
	const raw: unknown = vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY);
	return entryModelParametersFor(raw, label, baseUrl);
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
