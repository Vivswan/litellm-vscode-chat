import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { GroupCredentialsResolution } from "../../../provider/catalog/groupModels";
import type { ServerModelsSnapshot } from "../../../provider/catalog/statusWindow";
import { CMD, HOST_CMD, INTERNAL_CMD } from "../../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import { getMaskSecretInputs, SERVERS_SETTING_KEY } from "../../../shared/config/settings";
import { SERVER_SYNC_FINGERPRINTS_KEY, SYNCED_ENTRY_BASE_URLS_KEY } from "../../../shared/config/storageKeys";
import { Logger } from "../../../shared/logger";
import type { ExpectedFailureCategory, NonChatMode, SecretFieldId } from "../../../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import { canonicalStoredBaseUrl } from "../../../shared/util/baseUrl";
import { errorLabel } from "../../../shared/util/errorLabel";
import type { HeaderValue } from "../../../shared/util/headers";
import { validatedStringRecord } from "../../../shared/util/json";
import type { FingerprintSaltSession } from "../../fingerprintSalt";
import type { MessageAction } from "../../ui/notifier";
import { showActionableMessage, showMessage } from "../../ui/notifier";
import type {
	DeclaredGroupClaim,
	GroupKey,
	GroupRemovalStore,
	TombstoneIdentity,
	TombstonePersistence,
} from "../groupRemovals";
import { tombstoneHides } from "../groupRemovals";
import { manageLanguageModelsAvailable, openManageLanguageModels } from "../manageLanguageModels";
import type { RemovedEntryEvent, ServerSyncEngine, ServerSyncEnv } from "./engine";
import { entryGroupCredentialsFor } from "./entryCredentials";
import { inlineSecretValues, readServerSecretsRecord, secretDestination, updateServerSecret } from "./secrets";
import type { DeclaredServer, EntryModelCapabilities, EntryModelParameters } from "./setting";
import {
	acceptedEntry,
	declaresServerRows,
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
	return manage === undefined ? [openGroupsFileAction()] : [manage, openGroupsFileAction()];
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

/** A removed-entry event whose ledger URL resolved, so its group identities can be tombstoned. */
type RemovedEntry = Extract<RemovedEntryEvent, { kind: "removed" }> & { readonly baseUrl: string };

/** The removed event degraded to the untracked notice: no identity is promised hidden. */
function untrackedRemoval(event: Extract<RemovedEntryEvent, { kind: "removed" }>): NoticeEvent {
	return {
		kind: "removed",
		label: event.label,
		baseUrl: undefined,
		groupIds: [],
		sharedGroupIds: [],
		outcome: undefined,
	};
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

/**
 * The toast door the removal notices leave through. A toast waits for the user's click, so the reconciliation never
 * awaits its notice; the door is a dependency so a caller can hear the notice its own events produced instead of
 * listening on the window every other caller's notices also reach.
 */
export type RemovalNoticeDoor = typeof showActionableMessage;

/** The removal events sorted by what their notice must say; a renamed event keeps both labels. */
interface RemovalBuckets {
	readonly hidden: string[];
	readonly hiddenThisSession: string[];
	readonly shared: string[];
	readonly unreported: string[];
	readonly untracked: string[];
	readonly renamed: Extract<RemovedEntryEvent, { kind: "renamed" }>[];
}

/** Sorts the events into their notice buckets; a removal with no base URL or no outcome is untracked. */
function bucketRemovalEvents(events: readonly NoticeEvent[]): RemovalBuckets {
	const buckets: RemovalBuckets = {
		hidden: [],
		hiddenThisSession: [],
		shared: [],
		unreported: [],
		untracked: [],
		renamed: [],
	};
	for (const event of events) {
		if (event.kind === "renamed") {
			buckets.renamed.push(event);
		} else if (event.baseUrl === undefined || event.outcome === undefined) {
			buckets.untracked.push(event.label);
		} else if (event.outcome === "hidden") {
			buckets.hidden.push(event.label);
		} else if (event.outcome === "hidden-session-only") {
			buckets.hiddenThisSession.push(event.label);
		} else if (event.outcome === "shared") {
			buckets.shared.push(event.label);
		} else {
			buckets.unreported.push(event.label);
		}
	}
	return buckets;
}

/** The notice for removed entries whose groups the host has not reported this session. */
function unreportedNotice(labels: readonly string[]): string {
	if (labels.length === 1) {
		return l10n.t(
			"Removed {0} from the servers setting. VS Code has not reported its provider group this session, so its models may still appear; delete it in Manage Language Models, or remove its object from the models file and reload the window.",
			quoted(labels)
		);
	}
	return l10n.t(
		"Removed {0} from the servers setting. VS Code has not reported their provider groups this session, so their models may still appear; delete them in Manage Language Models, or remove their objects from the models file and reload the window.",
		quoted(labels)
	);
}

/** The notice for removed entries whose models a durable tombstone hides. */
function hiddenNotice(labels: readonly string[]): string {
	if (labels.length === 1) {
		return l10n.t(
			"Removed {0} from the servers setting; its models are hidden. VS Code still keeps a provider group named {0}: delete it in Manage Language Models, or remove its object from the models file and reload the window.",
			quoted(labels)
		);
	}
	return l10n.t(
		"Removed {0} from the servers setting; their models are hidden. VS Code still keeps a provider group for each: delete them in Manage Language Models, or remove their objects from the models file and reload the window.",
		quoted(labels)
	);
}

/** The notice for removed entries whose models are hidden for this session only. */
function hiddenThisSessionNotice(labels: readonly string[]): string {
	if (labels.length === 1) {
		return l10n.t(
			"Removed {0} from the servers setting; its models are hidden for this session only, because the hide cannot be kept across restarts. VS Code still keeps a provider group named {0}: delete it in Manage Language Models, or remove its object from the models file and reload the window.",
			quoted(labels)
		);
	}
	return l10n.t(
		"Removed {0} from the servers setting; their models are hidden for this session only, because the hides cannot be kept across restarts. VS Code still keeps a provider group for each: delete them in Manage Language Models, or remove their objects from the models file and reload the window.",
		quoted(labels)
	);
}

/** The notice for removed entries whose group identity nothing tracked, so nothing is hidden. */
function untrackedNotice(labels: readonly string[]): string {
	if (labels.length === 1) {
		return l10n.t(
			"Removed {0} from the servers setting. VS Code keeps the provider group and its models: delete it in Manage Language Models, or remove its object from the models file and reload the window.",
			quoted(labels)
		);
	}
	return l10n.t(
		"Removed {0} from the servers setting. VS Code keeps their provider groups and models: delete them in Manage Language Models, or remove their objects from the models file and reload the window.",
		quoted(labels)
	);
}

async function notifyRemovalEvents(events: readonly NoticeEvent[], show: RemovalNoticeDoor): Promise<void> {
	const { hidden, hiddenThisSession, shared, unreported, untracked, renamed } = bucketRemovalEvents(events);
	if (shared.length > 0) {
		void show(
			"info",
			l10n.t(
				"Removed {0} from the servers setting. Another entry still declares the same provider group, so it keeps serving; there is nothing to delete.",
				quoted(shared)
			),
			[]
		);
	}
	if (unreported.length > 0) {
		void show("info", unreportedNotice(unreported), await leftoverGroupActions(unreported));
	}
	if (hidden.length > 0) {
		void show("info", hiddenNotice(hidden), await leftoverGroupActions(hidden));
	}
	if (hiddenThisSession.length > 0) {
		void show("info", hiddenThisSessionNotice(hiddenThisSession), await leftoverGroupActions(hiddenThisSession));
	}
	for (const event of renamed) {
		void show(
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
		void show("info", untrackedNotice(untracked), await leftoverGroupActions(untracked));
	}
}

/** What recording a removal needs: the store, the logger, and the live snapshots the outcome is judged against. */
interface RemovalRecording {
	readonly removals: GroupRemovalStore;
	readonly logger: Logger;
	readonly observedSnapshots: () => readonly ServerModelsSnapshot[];
}

/**
 * Records every removed entry's identities in one store mutation, so a reconcile fires one change event however many
 * entries it removed (each event is a host re-resolve of every group). A throw degrades the events to the untracked
 * wording rather than promising a hiding that may not have reached the provider. A pre-label group carries no stamp:
 * it hides by the identity the removed entry joined it by.
 */
async function recordRemovalTombstones(
	removed: readonly RemovedEntry[],
	recording: RemovalRecording
): Promise<NoticeEvent[]> {
	const plans = removed.map((event) => {
		const { label, baseUrl } = event;
		const identities: readonly [TombstoneIdentity, ...TombstoneIdentity[]] = [
			{ by: "entry", label, baseUrl },
			...event.groupIds.map((groupId): TombstoneIdentity => ({ by: "group", groupId, label, baseUrl })),
		];
		return { event, identities };
	});
	const [first, ...rest] = plans;
	if (first === undefined) {
		return [];
	}
	const [head, ...tail] = first.identities;
	let recorded: readonly RecordedTombstone[];
	try {
		recorded = await recording.removals.addTombstones([head, ...tail, ...rest.flatMap((plan) => plan.identities)]);
	} catch (error) {
		recording.logger.error("Recording removed-group tombstones failed", error);
		return removed.map(untrackedRemoval);
	}
	return plans.map(({ event, identities }) => ({
		...event,
		outcome: removalOutcome(
			event,
			recorded.filter((record) => identities.includes(record.identity)),
			recording.observedSnapshots(),
			(group) => recording.removals.isTombstoned(group)
		),
	}));
}

/**
 * One removal event's provenance recorded, sorted by what follows. A rename orphans the old group but is not an
 * explicit removal: provenance only, no tombstone, models stay visible. A removal the ledger predates has no group
 * identity to resolve: no tombstone, no provenance, only the notice, never a suppression on a guess. Any other removal
 * records its origin and goes on to the tombstone batch. A failed record degrades the event to the untracked wording.
 */
async function recordRemovalOrigin(
	event: RemovedEntryEvent,
	recording: RemovalRecording
): Promise<{ notice: NoticeEvent } | { removed: RemovedEntry }> {
	try {
		if (event.kind === "renamed") {
			await recording.removals.recordOrigin({
				label: event.oldLabel,
				baseUrl: event.baseUrl,
				origin: { kind: "rename-leftover", oldLabel: event.oldLabel, newLabel: event.newLabel },
			});
			return { notice: event };
		}
		if (event.baseUrl === undefined) {
			return { notice: { ...event, outcome: undefined } };
		}
		await recording.removals.recordOrigin({
			label: event.label,
			baseUrl: event.baseUrl,
			origin: { kind: "removed-entry-leftover", removedLabel: event.label },
		});
		return { removed: { ...event, baseUrl: event.baseUrl } };
	} catch (error) {
		recording.logger.error("Recording removed-group provenance failed", error);
		return { notice: event.kind === "removed" ? untrackedRemoval(event) : event };
	}
}

/** Clears the tombstones of the re-declared claims, records the removals, and sends their notices. */
async function reconcileIdentities(
	claims: readonly DeclaredGroupClaim[],
	events: readonly RemovedEntryEvent[],
	recording: RemovalRecording,
	show: RemovalNoticeDoor
): Promise<void> {
	try {
		await recording.removals.clearTombstonesFor(claims);
	} catch (error) {
		recording.logger.error("Clearing removed-group tombstones failed", error);
	}
	const noticeEvents: NoticeEvent[] = [];
	const removed: RemovedEntry[] = [];
	for (const event of events) {
		const recorded = await recordRemovalOrigin(event, recording);
		if ("notice" in recorded) {
			noticeEvents.push(recorded.notice);
		} else {
			removed.push(recorded.removed);
		}
	}
	noticeEvents.push(...(await recordRemovalTombstones(removed, recording)));
	if (noticeEvents.length > 0) {
		void notifyRemovalEvents(noticeEvents, show).catch((error: unknown) => {
			recording.logger.error("Removal notice failed", error);
		});
	}
}

/**
 * Persists the engine's fingerprint map. Re-confirmed at write time, per batch, not once per pass: a store mutation
 * detected mid-pass must stop this write too, since a map built under an unconfirmed salt holds renderings no later
 * session can recognize, and persisting it would overwrite the durable records that let a healthy group read as
 * in-sync once the real salt is back. Format dominance: a current-format ("i1:") store record is never overwritten by
 * a carried legacy-format one. Only pre-projection records lack the prefix, and the engine carries them purely as
 * last-known-good, so a store record another window already projected is strictly newer knowledge; keeping it costs
 * nothing here (the engine's next duplicate response confirms against the store and adopts it into the session map).
 */
async function persistFingerprints(
	globalState: vscode.Memento,
	fingerprintSalt: FingerprintSaltSession,
	map: Readonly<Record<string, string>>
): Promise<void> {
	if ((await fingerprintSalt.confirmDurable()) !== "durable") {
		return;
	}
	const stored = validatedStringRecord(globalState.get<unknown>(SERVER_SYNC_FINGERPRINTS_KEY));
	const next: Record<string, string> = { ...map };
	for (const [label, record] of Object.entries(map)) {
		const storedRecord = stored[label];
		if (!record.startsWith("i1:") && storedRecord !== undefined && storedRecord.startsWith("i1:")) {
			next[label] = storedRecord;
		}
	}
	await globalState.update(SERVER_SYNC_FINGERPRINTS_KEY, next);
}

interface ServerSyncEnvDeps {
	context: vscode.ExtensionContext;
	logger: Logger;
	fingerprintSalt: FingerprintSaltSession;
	removals: GroupRemovalStore;
	observedGroupBaseUrls: (label: string) => readonly string[];
	observedSnapshots: () => readonly ServerModelsSnapshot[];
	showRemovalNotice?: RemovalNoticeDoor;
}

export function createServerSyncEnv(deps: ServerSyncEnvDeps): ServerSyncEnv {
	const {
		context,
		logger,
		fingerprintSalt,
		removals,
		observedGroupBaseUrls,
		observedSnapshots,
		showRemovalNotice = showActionableMessage,
	} = deps;
	if (fingerprintSalt.state() !== "durable") {
		logger.log(
			"Server sync will not persist fingerprints this session: the fingerprint salt is session-only, so no later session could recognize them"
		);
	}
	const recording: RemovalRecording = { removals, logger, observedSnapshots };
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
		setFingerprints: (map) => persistFingerprints(context.globalState, fingerprintSalt, map),
		getEntryBaseUrls: () => canonicalEntryBaseUrls(context.globalState.get<unknown>(SYNCED_ENTRY_BASE_URLS_KEY)),
		setEntryBaseUrls: async (map) => {
			await context.globalState.update(SYNCED_ENTRY_BASE_URLS_KEY, map);
		},
		observedGroupBaseUrls,
		observedSnapshots,
		reconcileEntryIdentities: (claims, events) => reconcileIdentities(claims, events, recording, showRemovalNotice),
		log: (message, data) => logger.log(message, data),
		logError: (message, error) => logger.error(message, error),
	};
}

/**
 * The live servers setting as VS Code resolves it, workspace over user over default: the one reader every live caller
 * shares (features, migrations, wiring, the palette and test commands), so no second spelling of the key or scope can
 * drift.
 */
export function readRawServersSetting(): unknown {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY);
}

/**
 * The accepted entries of the servers setting as it reads right now: the truth for "is anything declared" before the
 * first sync pass has run and while the provider's group statuses are transiently empty.
 */
export function currentDeclaredServers(): DeclaredServer[] {
	return parseServersSetting(readRawServersSetting()).entries;
}

export function currentSettingDeclaresRows(): boolean {
	return declaresServerRows(readRawServersSetting());
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

/** The palette's three answers: the entry as the quick pick showed it, the secret field, and the typed value. */
interface SecretChoice {
	readonly entry: DeclaredServer;
	readonly field: SecretFieldId;
	readonly value: string;
}

/** The entry, field, and value the user picked, or undefined once any of the three prompts is dismissed. */
async function promptSecretChoice(entries: readonly DeclaredServer[]): Promise<SecretChoice | undefined> {
	const entryPick = await vscode.window.showQuickPick(
		// The configured URL leaves the extension here; the host alone still names the server.
		entries.map((entry) => ({ label: entry.label, description: Logger.redact(entry.baseUrl), entry })),
		{ title: l10n.t("LiteLLM: Set Server Secret"), placeHolder: l10n.t("Which server?") }
	);
	if (entryPick === undefined) {
		return undefined;
	}
	const fieldPick = await vscode.window.showQuickPick(
		// Ids come from the descriptor so a new secret field cannot be silently unreachable here.
		SECRET_FIELD_IDS.map((field) => ({ label: secretPaletteLabel(field), field })),
		{ title: l10n.t("LiteLLM: Set Server Secret"), placeHolder: l10n.t("Which secret?") }
	);
	if (fieldPick === undefined) {
		return undefined;
	}
	const value = await vscode.window.showInputBox({
		title: l10n.t("{0} for {1}", fieldPick.label, entryPick.label),
		prompt: l10n.t(
			"Stored in VS Code secret storage, never in settings files. Leave empty to remove the stored value."
		),
		password: getMaskSecretInputs(),
	});
	if (value === undefined) {
		return undefined;
	}
	return { entry: entryPick.entry, field: fieldPick.field, value };
}

/**
 * Stores (or, for an empty value, clears) the chosen secret and returns whether it did. The label is re-resolved
 * AFTER the prompts and must still name the entry the quick pick displayed: the prompts stay open indefinitely, and an
 * entry swapped in under the label meanwhile (another window, a hand edit of settings.json) would receive a secret the
 * user entered for a different host. The same identity comparison the dashboard's save path refuses through; nothing
 * durable happened, so re-running the command shows fresh truth.
 */
async function storeChosenSecret(
	secrets: vscode.SecretStorage,
	choice: SecretChoice,
	logger: Logger
): Promise<boolean> {
	const { field, value } = choice;
	const label = choice.entry.label;
	const fresh = acceptedEntry(readRawServersSetting(), label);
	if (fresh === undefined || !nonSecretIdentityMatches(fresh.entry, choice.entry)) {
		logger.log("Set Server Secret refused: the entry changed while the prompts were open", { label });
		void showMessage(
			"warning",
			l10n.t(
				'The server entry "{0}" changed while the prompts were open, so nothing was stored. Run the command again.',
				label
			),
			[]
		);
		return false;
	}
	await updateServerSecret(
		secrets,
		label,
		field,
		value.length > 0 ? value : undefined,
		// The stamp records the deliberate pairing: this value belongs to the destination the just-verified entry names.
		secretDestination(fresh.entry, field)
	);
	logger.log("Server secret updated from the palette", { label, field, cleared: value.length === 0 });
	if (value.length > 0 && inlineSecretValues(fresh.entry)[field] !== undefined) {
		void showMessage(
			"warning",
			l10n.t(
				'"{0}" also sets {1} inline in the servers setting, and inline values take precedence. Remove the inline value for the stored secret to take effect.',
				label,
				field
			),
			[]
		);
	}
	return true;
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
				void showMessage(
					"info",
					l10n.t(
						"No servers declared in the {0} setting yet. Add one there or in the dashboard first.",
						`${CONFIG_SECTION}.${SERVERS_SETTING_KEY}`
					),
					[]
				);
				return;
			}
			const choice = await promptSecretChoice(entries);
			if (choice === undefined) {
				return;
			}
			if (await storeChosenSecret(context.secrets, choice, logger)) {
				engine.requestSync();
			}
		})
	);
}
