/**
 * The last-mile vscode wiring: the real ServerSyncEnv over workspace
 * configuration, SecretStorage, globalState, and the host command, plus the
 * Set Server Secret palette command.
 */

import * as vscode from "vscode";
import { CMD, INTERNAL_CMD } from "../../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import { SERVERS_SETTING_KEY } from "../../../shared/config/settings";
import { SERVER_SYNC_FINGERPRINTS_KEY, SYNCED_ENTRY_BASE_URLS_KEY } from "../../../shared/config/storageKeys";
import type { Logger } from "../../../shared/logger";
import type { SecretFieldId } from "../../../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import type { FingerprintSaltSession } from "../../fingerprintSalt";
import { showActionableMessage } from "../../ui/notifier";
import type { GroupRemovalStore } from "../groupRemovals";
import type { RemovedEntryEvent, ServerSyncEngine, ServerSyncEnv } from "./engine";
import { inlineSecretValues, readServerSecrets, updateServerSecret } from "./secrets";
import type { EntryModelParameters } from "./setting";
import { entryModelParametersFor, parseServersSetting } from "./setting";

/** The one button every removal notice carries: it opens where group deletion actually lives. */
const OPEN_NATIVE_EDITOR_LABEL = "Open Manage Language Models";

const openNativeEditorAction = () => ({
	label: OPEN_NATIVE_EDITOR_LABEL,
	run: () => void vscode.commands.executeCommand(INTERNAL_CMD.manageServers),
});

const quoted = (labels: readonly string[]) => labels.map((label) => `"${label}"`).join(", ");

/**
 * The removal notices, one per event class so each says only what is true.
 * Every variant names the exact group label(s) to delete, gives the steps,
 * and carries the button that opens the native editor - the only place group
 * deletion exists.
 */
function notifyRemovalEvents(events: readonly RemovedEntryEvent[]): void {
	const hidden: string[] = [];
	const untracked: string[] = [];
	const renamed: Extract<RemovedEntryEvent, { kind: "renamed" }>[] = [];
	for (const event of events) {
		if (event.kind === "renamed") {
			renamed.push(event);
		} else if (event.baseUrl !== undefined) {
			hidden.push(event.label);
		} else {
			untracked.push(event.label);
		}
	}
	if (hidden.length > 0) {
		const labels = quoted(hidden);
		const message =
			hidden.length === 1
				? `Removed ${labels} from the servers setting; its models are hidden. VS Code still keeps a provider group named ${labels}. To delete it: open Manage Language Models, remove ${labels}, then run Sync Models Now.`
				: `Removed ${labels} from the servers setting; their models are hidden. VS Code still keeps a provider group for each. To delete them: open Manage Language Models, remove ${labels}, then run Sync Models Now.`;
		void showActionableMessage("info", message, [openNativeEditorAction()]);
	}
	for (const event of renamed) {
		void showActionableMessage(
			"info",
			`Renamed "${event.oldLabel}" to "${event.newLabel}". VS Code keeps the old group "${event.oldLabel}" and its models. To delete it: open Manage Language Models, remove "${event.oldLabel}", then run Sync Models Now. A rename made directly in settings.json does not carry the old label's stored secrets; set them again for "${event.newLabel}" (a dashboard rename copies them).`,
			[openNativeEditorAction()]
		);
	}
	if (untracked.length > 0) {
		const labels = quoted(untracked);
		const message =
			untracked.length === 1
				? `Removed ${labels} from the servers setting. VS Code keeps the provider group and its models. To delete it: open Manage Language Models, remove ${labels}, then run Sync Models Now.`
				: `Removed ${labels} from the servers setting. VS Code keeps their provider groups and models. To delete them: open Manage Language Models, remove ${labels}, then run Sync Models Now.`;
		void showActionableMessage("info", message, [openNativeEditorAction()]);
	}
}

/** The real environment: workspace configuration, SecretStorage, globalState, and the host command. */
export function createServerSyncEnv(
	context: vscode.ExtensionContext,
	logger: Logger,
	fingerprintSalt: FingerprintSaltSession,
	removals: GroupRemovalStore
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
		getEntryBaseUrls: () => {
			// Validated like the fingerprints: the key is engine-owned, but a
			// corrupt value must not ride behind a cast.
			const stored = context.globalState.get<unknown>(SYNCED_ENTRY_BASE_URLS_KEY);
			if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
				return {};
			}
			return Object.fromEntries(
				Object.entries(stored).filter((field): field is [string, string] => typeof field[1] === "string")
			);
		},
		setEntryBaseUrls: async (map) => {
			await context.globalState.update(SYNCED_ENTRY_BASE_URLS_KEY, map);
		},
		reconcileEntryIdentities: async (declared, events) => {
			// Awaited by the engine's pass, so this stays serialized with the
			// passes that produce it: a removal's tombstone cannot land after a
			// later pass's re-add already cleared it.
			// Clear first: a removal and a re-add of the same identity in one
			// pass must end unsuppressed.
			try {
				await removals.clearTombstonesFor(declared);
			} catch (error) {
				logger.error("Clearing removed-group tombstones failed", error);
			}
			// The notice must only claim "hidden" for groups whose tombstone
			// provably landed; an event whose bookkeeping failed degrades to the
			// untracked wording (group and models stay visible).
			const noticeEvents: RemovedEntryEvent[] = [];
			for (const event of events) {
				try {
					if (event.kind === "renamed") {
						// A rename orphans the old group but is not an explicit
						// removal: provenance only, no tombstone, models stay visible.
						await removals.recordOrigin({
							label: event.oldLabel,
							baseUrl: event.baseUrl,
							origin: { kind: "rename-leftover", oldLabel: event.oldLabel, newLabel: event.newLabel },
						});
						noticeEvents.push(event);
					} else if (event.baseUrl !== undefined) {
						await removals.recordOrigin({
							label: event.label,
							baseUrl: event.baseUrl,
							origin: { kind: "removed-entry-leftover", removedLabel: event.label },
						});
						await removals.addTombstone({ label: event.label, baseUrl: event.baseUrl });
						noticeEvents.push(event);
					} else {
						// The ledger predates this label, so no group identity can be
						// resolved: no tombstone, no provenance, only the notice -
						// never suppress on a guess.
						noticeEvents.push(event);
					}
				} catch (error) {
					logger.error("Recording removed-group bookkeeping failed", error);
					if (event.kind === "removed") {
						noticeEvents.push({ kind: "removed", label: event.label, baseUrl: undefined });
					} else {
						noticeEvents.push(event);
					}
				}
			}
			if (noticeEvents.length > 0) {
				notifyRemovalEvents(noticeEvents);
			}
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
