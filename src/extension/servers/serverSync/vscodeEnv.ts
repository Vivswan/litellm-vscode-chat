import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { GroupCredentialsResolution } from "../../../provider/catalog/groupModels";
import type { ServerModelsSnapshot } from "../../../provider/catalog/statusWindow";
import { CMD, HOST_CMD, INTERNAL_CMD } from "../../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import { getMaskSecretInputs, SERVERS_SETTING_KEY } from "../../../shared/config/settings";
import { SERVER_SYNC_FINGERPRINTS_KEY, SYNCED_ENTRY_BASE_URLS_KEY } from "../../../shared/config/storageKeys";
import type { Logger } from "../../../shared/logger";
import type { ExpectedFailureCategory, NonChatMode, SecretFieldId } from "../../../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import { canonicalStoredBaseUrl } from "../../../shared/util/baseUrl";
import { errorLabel } from "../../../shared/util/errorLabel";
import type { HeaderValue } from "../../../shared/util/headers";
import { validatedStringRecord } from "../../../shared/util/json";
import type { FingerprintSaltSession } from "../../fingerprintSalt";
import type { MessageAction } from "../../ui/notifier";
import { showActionableMessage } from "../../ui/notifier";
import type { GroupKey, GroupRemovalStore, TombstoneIdentity, TombstonePersistence } from "../groupRemovals";
import { tombstoneHides } from "../groupRemovals";
import { manageLanguageModelsAvailable, openManageLanguageModels } from "../manageLanguageModels";
import type { RemovedEntryEvent, ServerSyncEngine, ServerSyncEnv } from "./engine";
import { entryGroupCredentialsFor } from "./entryCredentials";
import { inlineSecretValues, readServerSecretsRecord, secretDestination, updateServerSecret } from "./secrets";
import type { DeclaredServer, EntryModelCapabilities, EntryModelParameters } from "./setting";
import {
	acceptedEntry,
	entryApiVersionFor,
	entryDeclaredModelsFor,
	entryExpectedFailuresFor,
	entryHeadersFor,
	entryIncludeModesFor,
	entryModelCapabilitiesFor,
	entryModelParametersFor,
	entrySupersedingBaseUrl,
	nonSecretIdentityMatches,
	parseServersSetting,
} from "./setting";

/** The models-file button every leftover notice keeps: the fallback where the editor cannot reach the group. */
const openGroupsFileAction = () => ({
	label: l10n.t("Open Models File"),
	run: () => void vscode.commands.executeCommand(INTERNAL_CMD.openGroupsFile),
});

/**
 * The Manage Language Models button, when the host registers the editor's command: opens the editor searched for
 * `search` (one group label, or nothing when a notice names several), where the group's menu holds the Delete action.
 * Undefined on a host without the command, so the notice keeps the models file alone.
 */
async function manageLanguageModelsAction(search: string | undefined): Promise<MessageAction | undefined> {
	if (!(await manageLanguageModelsAvailable())) {
		return undefined;
	}
	return {
		label: l10n.t("Manage Language Models"),
		run: () => void openManageLanguageModels(search),
	};
}

async function leftoverGroupActions(labels: readonly string[]): Promise<MessageAction[]> {
	const manage = await manageLanguageModelsAction(labels.length === 1 ? labels[0] : undefined);
	return manage !== undefined ? [manage, openGroupsFileAction()] : [openGroupsFileAction()];
}

const quoted = (labels: readonly string[]) => labels.map((label) => `"${label}"`).join(", ");

/**
 * The identity ledger as stored, read in the one spelling: older versions wrote base URLs as the user typed them, and
 * the engine compares ledger URLs with the canonical ones it derives from the setting (a rename made while VS Code was
 * closed is a removal otherwise). A value with no canonical spelling names no group and is dropped, so the removal it
 * would have resolved degrades to the honest untracked notice, never a wrong tombstone.
 */
export function canonicalEntryBaseUrls(stored: unknown): Record<string, string> {
	const ledger: Record<string, string> = {};
	for (const [label, url] of Object.entries(validatedStringRecord(stored))) {
		const canonical = canonicalStoredBaseUrl(url);
		if (canonical !== undefined) {
			ledger[label] = canonical;
		}
	}
	return ledger;
}

/**
 * The removal notices, one per event class so each says only what is true. Every variant names the exact group label(s)
 * to delete and where: the group survives (VS Code offers extensions no removal), so the notice leads with the Manage
 * Language Models editor (its Delete action) and keeps the models file as the fallback.
 */
/** What one removal did to the groups the host serves, read from the tombstones it recorded over the live snapshots. */
export type RemovalOutcome = "hidden" | "hidden-session-only" | "shared" | "unreported";

/** A tombstone the reconciliation recorded, with the store's answer on whether it outlives the session. */
export interface RecordedTombstone {
	readonly identity: TombstoneIdentity;
	readonly persistence: TombstonePersistence;
}

/**
 * Derived from the hide result, never asserted: hidden when a group the host reports is hidden right now by one of
 * the tombstones this removal recorded (an Unhide between the record and this read un-hides it), for this session
 * only when every record hiding such a group is one the store could not persist, shared when the group the entry
 * joined is also another present entry's and so was kept, unreported otherwise.
 */
export function removalOutcome(
	event: Extract<RemovedEntryEvent, { kind: "removed" }>,
	recorded: readonly RecordedTombstone[],
	snapshots: readonly ServerModelsSnapshot[],
	isHidden: (group: GroupKey) => boolean
): RemovalOutcome {
	const keys = snapshots.map((snapshot) => ({
		groupId: snapshot.status.serverId,
		label: snapshot.status.label,
		entryLabel: snapshot.entryLabel,
		baseUrl: snapshot.status.baseUrl,
	}));
	const hiders = keys
		.filter((key) => isHidden(key))
		.map((key) => recorded.filter((record) => tombstoneHides(record.identity, key)))
		.filter((records) => records.length > 0);
	if (hiders.length > 0) {
		return hiders.every((records) => records.some((record) => record.persistence === "durable"))
			? "hidden"
			: "hidden-session-only";
	}
	return keys.some((key) => event.sharedGroupIds.includes(key.groupId)) ? "shared" : "unreported";
}

/** A removal event with what its reconciliation did, for the notice. */
type NoticeEvent =
	| Extract<RemovedEntryEvent, { kind: "renamed" }>
	| (Extract<RemovedEntryEvent, { kind: "removed" }> & { readonly outcome: RemovalOutcome | undefined });

async function notifyRemovalEvents(events: readonly NoticeEvent[]): Promise<void> {
	const hidden: string[] = [];
	const hiddenThisSession: string[] = [];
	const shared: string[] = [];
	const unreported: string[] = [];
	const untracked: string[] = [];
	const renamed: Extract<RemovedEntryEvent, { kind: "renamed" }>[] = [];
	for (const event of events) {
		if (event.kind === "renamed") {
			renamed.push(event);
		} else if (event.baseUrl === undefined || event.outcome === undefined) {
			untracked.push(event.label);
		} else if (event.outcome === "hidden") {
			hidden.push(event.label);
		} else if (event.outcome === "hidden-session-only") {
			hiddenThisSession.push(event.label);
		} else if (event.outcome === "shared") {
			shared.push(event.label);
		} else {
			unreported.push(event.label);
		}
	}
	if (shared.length > 0) {
		void showActionableMessage(
			"info",
			l10n.t(
				"Removed {0} from the servers setting. Another entry still declares the same provider group, so it keeps serving; there is nothing to delete.",
				quoted(shared)
			),
			[]
		);
	}
	if (unreported.length > 0) {
		const labels = quoted(unreported);
		const message =
			unreported.length === 1
				? l10n.t(
						"Removed {0} from the servers setting. VS Code has not reported its provider group this session, so its models may still appear; delete it in Manage Language Models, or remove its object from the models file and reload the window.",
						labels
					)
				: l10n.t(
						"Removed {0} from the servers setting. VS Code has not reported their provider groups this session, so their models may still appear; delete them in Manage Language Models, or remove their objects from the models file and reload the window.",
						labels
					);
		void showActionableMessage("info", message, await leftoverGroupActions(unreported));
	}
	if (hidden.length > 0) {
		const labels = quoted(hidden);
		const message =
			hidden.length === 1
				? l10n.t(
						"Removed {0} from the servers setting; its models are hidden. VS Code still keeps a provider group named {0}: delete it in Manage Language Models, or remove its object from the models file and reload the window.",
						labels
					)
				: l10n.t(
						"Removed {0} from the servers setting; their models are hidden. VS Code still keeps a provider group for each: delete them in Manage Language Models, or remove their objects from the models file and reload the window.",
						labels
					);
		void showActionableMessage("info", message, await leftoverGroupActions(hidden));
	}
	if (hiddenThisSession.length > 0) {
		const labels = quoted(hiddenThisSession);
		const message =
			hiddenThisSession.length === 1
				? l10n.t(
						"Removed {0} from the servers setting; its models are hidden for this session only, because the hide cannot be kept across restarts. VS Code still keeps a provider group named {0}: delete it in Manage Language Models, or remove its object from the models file and reload the window.",
						labels
					)
				: l10n.t(
						"Removed {0} from the servers setting; their models are hidden for this session only, because the hides cannot be kept across restarts. VS Code still keeps a provider group for each: delete them in Manage Language Models, or remove their objects from the models file and reload the window.",
						labels
					);
		void showActionableMessage("info", message, await leftoverGroupActions(hiddenThisSession));
	}
	for (const event of renamed) {
		void showActionableMessage(
			"info",
			l10n.t(
				'Renamed "{0}" to "{1}". VS Code keeps the old group "{0}" and its models: delete it in Manage Language Models, or remove its object from the models file and reload the window. A rename made directly in settings.json does not carry the old label\'s stored secrets; set them again for "{1}" (a dashboard rename copies them).',
				event.oldLabel,
				event.newLabel
			),
			await leftoverGroupActions([event.oldLabel])
		);
	}
	if (untracked.length > 0) {
		const labels = quoted(untracked);
		const message =
			untracked.length === 1
				? l10n.t(
						"Removed {0} from the servers setting. VS Code keeps the provider group and its models: delete it in Manage Language Models, or remove its object from the models file and reload the window.",
						labels
					)
				: l10n.t(
						"Removed {0} from the servers setting. VS Code keeps their provider groups and models: delete them in Manage Language Models, or remove their objects from the models file and reload the window.",
						labels
					);
		void showActionableMessage("info", message, await leftoverGroupActions(untracked));
	}
}

export function createServerSyncEnv(
	context: vscode.ExtensionContext,
	logger: Logger,
	fingerprintSalt: FingerprintSaltSession,
	removals: GroupRemovalStore,
	observedGroupBaseUrls: (label: string) => readonly string[],
	observedSnapshots: () => readonly ServerModelsSnapshot[]
): ServerSyncEnv {
	if (fingerprintSalt.state() !== "durable") {
		logger.log(
			"Server sync will not persist fingerprints this session: the fingerprint salt is session-only, so no later session could recognize them"
		);
	}
	return {
		readServersSetting: readRawServersSetting,
		readSecrets: (label) => readServerSecretsRecord(context.secrets, label),
		addProviderGroup: (args) => vscode.commands.executeCommand(HOST_CMD.addProviderGroup, args),
		confirmFingerprintsDurable: async () => (await fingerprintSalt.confirmDurable()) === "durable",
		getFingerprints: () => {
			// Validated at the trust boundary: the key is engine-owned and only ever written with string values under
			// parser-accepted labels, so a non-string value or a reserved (prototype-mutating) key is corruption and
			// must not ride into the session map behind an unchecked cast - the engine assigns these keys into plain
			// records unguarded.
			return validatedStringRecord(context.globalState.get<unknown>(SERVER_SYNC_FINGERPRINTS_KEY));
		},
		setFingerprints: async (map) => {
			// Re-confirmed at write time, per batch, not once per pass: a store mutation detected mid-pass must stop
			// this write too. A map built under an unconfirmed salt holds renderings no later session can recognize,
			// and persisting it would overwrite the durable records that let a healthy group read as in-sync once the
			// real salt is back.
			if ((await fingerprintSalt.confirmDurable()) !== "durable") {
				return;
			}
			// Format dominance: a current-format ("i1:") store record is never overwritten by a carried legacy-format
			// one. Only pre-projection records lack the prefix, and the engine carries them purely as last-known-good,
			// so a store record another window already projected is strictly newer knowledge; keeping it costs nothing
			// here (the engine's next duplicate response confirms against the store and adopts it into the session
			// map).
			const stored = validatedStringRecord(context.globalState.get<unknown>(SERVER_SYNC_FINGERPRINTS_KEY));
			const next: Record<string, string> = { ...map };
			for (const [label, record] of Object.entries(map)) {
				const storedRecord = stored[label];
				if (!record.startsWith("i1:") && storedRecord !== undefined && storedRecord.startsWith("i1:")) {
					next[label] = storedRecord;
				}
			}
			await context.globalState.update(SERVER_SYNC_FINGERPRINTS_KEY, next);
		},
		getEntryBaseUrls: () => canonicalEntryBaseUrls(context.globalState.get<unknown>(SYNCED_ENTRY_BASE_URLS_KEY)),
		setEntryBaseUrls: async (map) => {
			await context.globalState.update(SYNCED_ENTRY_BASE_URLS_KEY, map);
		},
		observedGroupBaseUrls,
		observedSnapshots,
		reconcileEntryIdentities: async (claims, events) => {
			try {
				await removals.clearTombstonesFor(claims);
			} catch (error) {
				logger.error("Clearing removed-group tombstones failed", error);
			}
			// A throw here degrades the event to the untracked wording rather than promising a hiding that may not have
			// reached the provider.
			const noticeEvents: NoticeEvent[] = [];
			for (const event of events) {
				try {
					if (event.kind === "renamed") {
						// A rename orphans the old group but is not an explicit removal: provenance only, no tombstone,
						// models stay visible.
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
						// A pre-label group carries no stamp: it hides by the identity the removed entry joined it by.
						const { label, baseUrl } = event;
						const identities: TombstoneIdentity[] = [
							{ by: "entry", label, baseUrl },
							...event.groupIds.map((groupId): TombstoneIdentity => ({ by: "group", groupId, label, baseUrl })),
						];
						const recorded: RecordedTombstone[] = [];
						for (const identity of identities) {
							recorded.push({ identity, persistence: (await removals.addTombstone(identity)).persistence });
						}
						noticeEvents.push({
							...event,
							outcome: removalOutcome(event, recorded, observedSnapshots(), (group) => removals.isTombstoned(group)),
						});
					} else {
						// The ledger predates this label, so no group identity can be resolved: no tombstone, no
						// provenance, only the notice - never suppress on a guess.
						noticeEvents.push({ ...event, outcome: undefined });
					}
				} catch (error) {
					logger.error("Recording removed-group bookkeeping failed", error);
					if (event.kind === "removed") {
						noticeEvents.push({
							kind: "removed",
							label: event.label,
							baseUrl: undefined,
							groupIds: [],
							sharedGroupIds: [],
							outcome: undefined,
						});
					} else {
						noticeEvents.push(event);
					}
				}
			}
			if (noticeEvents.length > 0) {
				void notifyRemovalEvents(noticeEvents).catch((error: unknown) => {
					logger.error("Removal notice failed", error);
				});
			}
		},
		log: (message, data) => logger.log(message, data),
		logError: (message, error) => logger.error(message, error),
	};
}

function readRawServersSetting(): unknown {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY);
}

/**
 * The accepted entries of the servers setting as it reads right now: the truth for "is anything declared" before the
 * first sync pass has run and while the provider's group statuses are transiently empty.
 */
export function currentDeclaredServers(): DeclaredServer[] {
	return parseServersSetting(readRawServersSetting()).entries;
}

/**
 * The provider's credential-overlay resolver over the real setting and
 * SecretStorage channels (see entryCredentials.ts for the resolution rules).
 * Never rejects: any escape is the unavailable answer with one log line here.
 */
export async function readEntryCredentials(
	secrets: vscode.SecretStorage,
	logger: Logger,
	label: string,
	baseUrl: string
): Promise<GroupCredentialsResolution> {
	try {
		return await entryGroupCredentialsFor(
			readRawServersSetting,
			(entryLabel) => readServerSecretsRecord(secrets, entryLabel),
			label,
			baseUrl,
			(message, data) => logger.log(message, data)
		);
	} catch (error) {
		logger.log("Resolving entry credentials for the overlay failed", { label, error: errorLabel(error) });
		return { kind: "unavailable", reason: "secretsUnreadable" };
	}
}

/**
 * The request path's read of one declared entry's per-entry modelParameters: the same live settings channel the sync
 * engine reads, resolved through entryModelParametersFor so it lands only on an entry whose label AND base URL both
 * match the server the request is routed to. Injected into the provider at activation (the provider layer cannot import
 * this module).
 */
export function readEntryModelParameters(label: string, baseUrl: string): EntryModelParameters | undefined {
	return entryModelParametersFor(readRawServersSetting(), label, baseUrl);
}

export function readEntryModelCapabilities(label: string, baseUrl: string): EntryModelCapabilities | undefined {
	return entryModelCapabilitiesFor(readRawServersSetting(), label, baseUrl);
}

export function readEntryExpectedFailures(
	label: string,
	baseUrl: string
): readonly ExpectedFailureCategory[] | undefined {
	return entryExpectedFailuresFor(readRawServersSetting(), label, baseUrl);
}

export function readEntryIncludeModes(label: string, baseUrl: string): readonly NonChatMode[] | undefined {
	return entryIncludeModesFor(readRawServersSetting(), label, baseUrl);
}

export function readEntryHeaders(label: string, baseUrl: string): Readonly<Record<string, HeaderValue>> | undefined {
	return entryHeadersFor(readRawServersSetting(), label, baseUrl);
}

export function readEntryApiVersion(label: string, baseUrl: string): string | undefined {
	return entryApiVersionFor(readRawServersSetting(), label, baseUrl);
}

export function readEntrySupersedingBaseUrl(label: string, baseUrl: string): string | undefined {
	return entrySupersedingBaseUrl(readRawServersSetting(), label, baseUrl);
}

export function readEntryDeclaredModels(label: string, baseUrl: string): readonly string[] | undefined {
	return entryDeclaredModelsFor(readRawServersSetting(), label, baseUrl);
}

/** Palette display copy per secret field; UI strings stay out of the shared descriptor. */
function secretPaletteLabel(field: SecretFieldId): string {
	const labels: Readonly<Record<SecretFieldId, string>> = {
		apiKey: l10n.t("API key"),
		oauthClientSecret: l10n.t("OAuth client secret"),
		virtualKeyValue: l10n.t("Virtual key value"),
	};
	return labels[field];
}

export function registerSetServerSecretCommand(
	context: vscode.ExtensionContext,
	engine: ServerSyncEngine,
	logger: Logger
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.setServerSecret, async () => {
			const entries = currentDeclaredServers();
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
				// Ids come from the descriptor so a new secret field cannot be silently unreachable here.
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
				password: getMaskSecretInputs(),
			});
			if (value === undefined) {
				return;
			}
			// The label is re-resolved AFTER the prompts and must still name the entry the quick pick displayed: the
			// prompts stay open indefinitely, and an entry swapped in under the label meanwhile (another window, a hand
			// edit of settings.json) would receive a secret the user entered for a different host. The same identity
			// comparison the dashboard's save path refuses through; nothing durable happened, so re-running the command
			// shows fresh truth.
			const fresh = acceptedEntry(readRawServersSetting(), entryPick.label);
			if (fresh === undefined || !nonSecretIdentityMatches(fresh.entry, entryPick.entry)) {
				logger.log("Set Server Secret refused: the entry changed while the prompts were open", {
					label: entryPick.label,
				});
				void vscode.window.showWarningMessage(
					l10n.t(
						'The server entry "{0}" changed while the prompts were open, so nothing was stored. Run the command again.',
						entryPick.label
					)
				);
				return;
			}
			await updateServerSecret(
				context.secrets,
				entryPick.label,
				fieldPick.field,
				value.length > 0 ? value : undefined,
				// The stamp records the deliberate pairing: this value belongs to the destination the just-verified
				// entry names.
				secretDestination(fresh.entry, fieldPick.field)
			);
			logger.log("Server secret updated from the palette", {
				label: entryPick.label,
				field: fieldPick.field,
				cleared: value.length === 0,
			});
			if (value.length > 0 && inlineSecretValues(fresh.entry)[fieldPick.field] !== undefined) {
				void vscode.window.showWarningMessage(
					l10n.t(
						'"{0}" also sets {1} inline in the servers setting, and inline values take precedence. Remove the inline value for the stored secret to take effect.',
						entryPick.label,
						fieldPick.field
					)
				);
			}
			engine.requestSync();
		})
	);
}
