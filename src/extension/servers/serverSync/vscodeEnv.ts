/**
 * The last-mile vscode wiring: the real ServerSyncEnv over workspace
 * configuration, SecretStorage, globalState, and the host command, plus the
 * Set Server Secret palette command.
 */

import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { CMD, INTERNAL_CMD } from "../../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import { SERVERS_SETTING_KEY } from "../../../shared/config/settings";
import { SERVER_SYNC_FINGERPRINTS_KEY, SYNCED_ENTRY_BASE_URLS_KEY } from "../../../shared/config/storageKeys";
import type { Logger } from "../../../shared/logger";
import type { ExpectedFailureCategory, SecretFieldId } from "../../../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import type { FingerprintSaltSession } from "../../fingerprintSalt";
import { showActionableMessage } from "../../ui/notifier";
import type { GroupRemovalStore } from "../groupRemovals";
import type { RemovedEntryEvent, ServerSyncEngine, ServerSyncEnv } from "./engine";
import { inlineSecretValues, readServerSecrets, updateServerSecret } from "./secrets";
import type { EntryModelCapabilities, EntryModelParameters } from "./setting";
import {
	entryApiVersionFor,
	entryDeclaredModelsFor,
	entryExpectedFailuresFor,
	entryHeadersFor,
	entryModelCapabilitiesFor,
	entryModelParametersFor,
	parseServersSetting,
} from "./setting";

/** The one button every removal notice carries: it opens the models file, where group deletion actually lives. */
const openGroupsFileAction = () => ({
	label: l10n.t("Open Models File"),
	run: () => void vscode.commands.executeCommand(INTERNAL_CMD.openGroupsFile),
});

const quoted = (labels: readonly string[]) => labels.map((label) => `"${label}"`).join(", ");

/**
 * The removal notices, one per event class so each says only what is true.
 * Every variant names the exact group label(s) to delete, gives the
 * file-based steps, and carries the button that opens the models file -
 * where group deletion actually lives (VS Code offers extensions no removal
 * API, and the file is documented user-editable).
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
				? l10n.t(
						"Removed {0} from the servers setting; its models are hidden. VS Code still keeps a provider group named {0}. To delete it: 1) open the models file and remove the {0} object from the JSON array; 2) reload the window (Developer: Reload Window) or restart VS Code; 3) run Sync Models Now.",
						labels
					)
				: l10n.t(
						"Removed {0} from the servers setting; their models are hidden. VS Code still keeps a provider group for each. To delete them: 1) open the models file and remove the {0} objects from the JSON array; 2) reload the window (Developer: Reload Window) or restart VS Code; 3) run Sync Models Now.",
						labels
					);
		void showActionableMessage("info", message, [openGroupsFileAction()]);
	}
	for (const event of renamed) {
		void showActionableMessage(
			"info",
			l10n.t(
				'Renamed "{0}" to "{1}". VS Code keeps the old group "{0}" and its models. To delete it: 1) open the models file and remove the "{0}" object from the JSON array; 2) reload the window (Developer: Reload Window) or restart VS Code; 3) run Sync Models Now. A rename made directly in settings.json does not carry the old label\'s stored secrets; set them again for "{1}" (a dashboard rename copies them).',
				event.oldLabel,
				event.newLabel
			),
			[openGroupsFileAction()]
		);
	}
	if (untracked.length > 0) {
		const labels = quoted(untracked);
		const message =
			untracked.length === 1
				? l10n.t(
						"Removed {0} from the servers setting. VS Code keeps the provider group and its models. To delete it: 1) open the models file and remove the {0} object from the JSON array; 2) reload the window (Developer: Reload Window) or restart VS Code; 3) run Sync Models Now.",
						labels
					)
				: l10n.t(
						"Removed {0} from the servers setting. VS Code keeps their provider groups and models. To delete them: 1) open the models file and remove the {0} objects from the JSON array; 2) reload the window (Developer: Reload Window) or restart VS Code; 3) run Sync Models Now.",
						labels
					);
		void showActionableMessage("info", message, [openGroupsFileAction()]);
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
		readServersSetting: readRawServersSetting,
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
			// The notice claims "hidden" once the store accepted the tombstone
			// (its in-memory list now hides the group; persistence is the
			// store's own best-effort concern). A throw here is unexpected -
			// e.g. the change-event wiring - and degrades the event to the
			// untracked wording rather than promising a hiding that may not
			// have reached the provider.
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

/** The raw servers setting from the same live channel the sync engine reads. */
function readRawServersSetting(): unknown {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY);
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
	return entryModelParametersFor(readRawServersSetting(), label, baseUrl);
}

/**
 * The registration path's read of one declared entry's per-entry
 * modelCapabilities; the same live read and label-plus-URL match as
 * readEntryModelParameters, injected the same way.
 */
export function readEntryModelCapabilities(label: string, baseUrl: string): EntryModelCapabilities | undefined {
	return entryModelCapabilitiesFor(readRawServersSetting(), label, baseUrl);
}

/**
 * The discovery path's read of one declared entry's expectedFailures; the
 * same live read and label-plus-URL match as readEntryModelParameters,
 * injected the same way.
 */
export function readEntryExpectedFailures(
	label: string,
	baseUrl: string
): readonly ExpectedFailureCategory[] | undefined {
	return entryExpectedFailuresFor(readRawServersSetting(), label, baseUrl);
}

/**
 * The request and discovery paths' read of one declared entry's custom
 * headers; the same live read and label-plus-URL match as
 * readEntryModelParameters, injected the same way.
 */
export function readEntryHeaders(label: string, baseUrl: string): Readonly<Record<string, string>> | undefined {
	return entryHeadersFor(readRawServersSetting(), label, baseUrl);
}

/**
 * The request and discovery paths' read of one declared entry's apiVersion
 * override; the same live read and label-plus-URL match as
 * readEntryModelParameters, injected the same way. "" is a real value
 * (append nothing), returned as-is; undefined means the entry sets none.
 */
export function readEntryApiVersion(label: string, baseUrl: string): string | undefined {
	return entryApiVersionFor(readRawServersSetting(), label, baseUrl);
}

/**
 * The registration path's read of one declared entry's discovery.declared
 * model IDs; the same live read and label-plus-URL match as
 * readEntryModelParameters, injected the same way.
 */
export function readEntryDeclaredModels(label: string, baseUrl: string): readonly string[] | undefined {
	return entryDeclaredModelsFor(readRawServersSetting(), label, baseUrl);
}

/**
 * Palette display copy per secret field; UI strings stay out of the shared
 * descriptor. Resolved per call so the labels localize after l10n.config; the
 * Record keeps a missing label a compile error.
 */
function secretPaletteLabel(field: SecretFieldId): string {
	const labels: Readonly<Record<SecretFieldId, string>> = {
		apiKey: l10n.t("API key"),
		oauthClientSecret: l10n.t("OAuth client secret"),
		virtualKeyValue: l10n.t("Virtual key value"),
	};
	return labels[field];
}

/**
 * The palette path for keeping secrets out of settings.json without the
 * dashboard: pick a declared server, pick the secret field, enter the value
 * masked. An empty value removes the stored secret.
 */
export function registerSetServerSecretCommand(
	context: vscode.ExtensionContext,
	engine: ServerSyncEngine,
	logger: Logger,
	/**
	 * Notified after a stored secret changed; the usage poller re-probes
	 * availability on it (a fixed key can lift a 401/403 classification).
	 * With polling off the re-probe waits for the next explicit refresh -
	 * the poller's documented no-background-requests promise.
	 */
	onSecretsChanged?: () => void
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.setServerSecret, async () => {
			const { entries } = parseServersSetting(readRawServersSetting());
			if (entries.length === 0) {
				void vscode.window.showInformationMessage(
					l10n.t(
						"No servers declared in the {0} setting yet. Add one there or in the dashboard first.",
						`${CONFIG_SECTION}.${SERVERS_SETTING_KEY}`
					)
				);
				return;
			}
			const entryPick = await vscode.window.showQuickPick(
				entries.map((entry) => ({ label: entry.label, description: entry.baseUrl, entry })),
				{ title: l10n.t("LiteLLM: Set Server Secret"), placeHolder: l10n.t("Which server?") }
			);
			if (entryPick === undefined) {
				return;
			}
			const fieldPick = await vscode.window.showQuickPick(
				// Ids come from the descriptor so a new secret field cannot be
				// silently unreachable here; the Record makes a missing label a
				// compile error.
				SECRET_FIELD_IDS.map((field) => ({ label: secretPaletteLabel(field), field })),
				{ title: l10n.t("LiteLLM: Set Server Secret"), placeHolder: l10n.t("Which secret?") }
			);
			if (fieldPick === undefined) {
				return;
			}
			const value = await vscode.window.showInputBox({
				title: l10n.t("{0} for {1}", fieldPick.label, entryPick.label),
				prompt: l10n.t(
					"Stored in VS Code secret storage, never in settings files. Leave empty to remove the stored value."
				),
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
					l10n.t(
						'"{0}" also sets {1} inline in the servers setting, and inline values take precedence. Remove the inline value for the stored secret to take effect.',
						entryPick.label,
						fieldPick.field
					)
				);
			}
			engine.requestSync();
			onSecretsChanged?.();
		})
	);
}
