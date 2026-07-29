/**
 * The declarative server sync: litellm-vscode-chat.servers is the settings
 * side's source of truth for servers, and this module keeps VS Code's
 * provider groups in step with it. Each entry is registered through the
 * host's add-only lm.addLanguageModelsProviderGroup command, with its secret
 * fields resolved as inline-in-settings value first, then the label's
 * SecretStorage blob, then absent. The command rejects an existing name and
 * the host has no update or removal command (hostGroupCommand.test.ts pins
 * this), so the engine treats a duplicate rejection for an unchanged entry
 * as the synced steady state and surfaces an actionable error when an entry
 * changed underneath its existing group.
 *
 * The engine takes its effects as an injected environment, so everything but
 * the last-mile vscode wiring (createServerSyncEnv, the palette command) is
 * unit-testable. Errors are logged, never thrown into activation, and no log
 * line ever carries a secret: labels, base URLs, and has-credential booleans
 * at most.
 */

import * as vscode from "vscode";
import { groupClientId, parseGroupConfiguration } from "../provider/groupModels";
import { CMD, INTERNAL_CMD, VENDOR_ID } from "../shared/commandIds";
import { fingerprint } from "../shared/fingerprint";
import { isRecord, isUnsafeRecordKey } from "../shared/json";
import type { Logger } from "../shared/logger";
import type {
	NonSecretOptionalFields,
	OptionalEntryFieldId,
	OptionalEntryFields,
	SecretFieldId,
	SecretLocation,
} from "../shared/serverEntry";
import { OPTIONAL_ENTRY_FIELDS, pickNonSecretOptionalFields, SECRET_FIELD_IDS } from "../shared/serverEntry";
import { CONFIG_SECTION } from "../shared/settingSpec";
import { SERVERS_SETTING_KEY } from "../shared/settings";
import { SERVER_SYNC_FINGERPRINTS_KEY, serverSecretsKey } from "../shared/storageKeys";

/** One parsed servers-setting entry: label and baseUrl usable, other fields present only with usable text. */
export type DeclaredServer = { readonly label: string; readonly baseUrl: string } & OptionalEntryFields;

/** The non-secret view of a declared server the dashboard renders; secret values stay out. */
export interface DeclaredServerView extends NonSecretOptionalFields {
	readonly label: string;
	readonly baseUrl: string;
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;
	/**
	 * The group client ID the entry's resolved configuration produces: the same
	 * identity the provider stamps on its status snapshots, so the dashboard can
	 * join a declared entry to exactly its live group even when several entries
	 * share a base URL. The embedded credential fingerprint is non-secret, but
	 * the ID stays extension-side; it is never pushed into DashboardState.
	 * Absent when the entry does not resolve to a usable group configuration.
	 */
	readonly expectedClientId?: string | undefined;
	/** The label's last upsert failure, cleared by the next success. */
	readonly syncError?: string | undefined;
}

function usableString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse the raw setting value. Entries without a usable label or baseUrl,
 * with a reserved label, or with a label an earlier entry already used are
 * skipped and reported; everything the sync engine acts on comes out of here.
 */
export function parseServersSetting(raw: unknown): { entries: DeclaredServer[]; problems: string[] } {
	if (raw === undefined || raw === null) {
		return { entries: [], problems: [] };
	}
	if (!Array.isArray(raw)) {
		return { entries: [], problems: ["the servers setting is not an array"] };
	}
	const problems: string[] = [];
	return { entries: acceptEntries(raw, problems).map(({ entry }) => entry), problems };
}

/**
 * The accepted entries with their raw-array indices: the single place the
 * acceptance rules live, so parseServersSetting and acceptedEntry cannot
 * disagree about which raw entry a label resolves to.
 */
function acceptEntries(raw: readonly unknown[], problems?: string[]): { index: number; entry: DeclaredServer }[] {
	const accepted: { index: number; entry: DeclaredServer }[] = [];
	const seen = new Set<string>();
	raw.forEach((item: unknown, index) => {
		const reject = (why: string) => problems?.push(`entry ${index + 1} ${why}`);
		if (!isRecord(item)) {
			reject("is not an object");
			return;
		}
		const record = item;
		const label = usableString(record.label);
		const baseUrl = usableString(record.baseUrl);
		if (label === undefined || baseUrl === undefined) {
			reject("is missing a label or baseUrl");
			return;
		}
		if (isUnsafeRecordKey(label)) {
			reject("uses a reserved label");
			return;
		}
		if (seen.has(label)) {
			reject("repeats an earlier entry's label; the first entry wins");
			return;
		}
		seen.add(label);
		const entry: { label: string; baseUrl: string } & { -readonly [K in OptionalEntryFieldId]?: string } = {
			label,
			baseUrl,
		};
		for (const { id } of OPTIONAL_ENTRY_FIELDS) {
			const value = usableString(record[id]);
			if (value !== undefined) {
				entry[id] = value;
			}
		}
		accepted.push({ index, entry });
	});
	return accepted;
}

/**
 * The entry parseServersSetting accepts for `label`, with its raw-array
 * index, or undefined when it accepts none. The dashboard's per-entry reads
 * and writes (the edit form's inline-value prefill, the save target) resolve
 * through this so they act on exactly the entry the dashboard row describes:
 * a rejected same-label sibling earlier in the array (no usable baseUrl, say)
 * cannot shadow the accepted entry, and a label the parser rejects outright
 * (a reserved name, a never-declared junk entry) resolves to nothing. The
 * returned entry is the parsed view - usable fields only, trimmed - so
 * callers consume what the sync engine would read, not the raw record.
 */
export function acceptedEntry(raw: unknown, label: string): { index: number; entry: DeclaredServer } | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const wanted = label.trim();
	return acceptEntries(raw).find(({ entry }) => entry.label === wanted);
}

/** The secure-side secrets of one label, as the SecretStorage blob holds them. */
export type StoredServerSecrets = Partial<Readonly<Record<SecretFieldId, string>>>;

/** The slice of vscode.SecretStorage the sync path uses; injectable for tests. */
export interface SecretStore {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
	delete(key: string): Thenable<void>;
}

export async function readServerSecrets(secrets: SecretStore, label: string): Promise<StoredServerSecrets> {
	const raw = await secrets.get(serverSecretsKey(label));
	if (raw === undefined) {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null) {
		return {};
	}
	const blob: { -readonly [K in SecretFieldId]?: string } = {};
	for (const field of SECRET_FIELD_IDS) {
		const value = (parsed as Record<string, unknown>)[field];
		if (typeof value === "string" && value.length > 0) {
			blob[field] = value;
		}
	}
	return blob;
}

/** Write one secret field of a label's blob; undefined deletes the field, an empty blob deletes the key. */
export async function updateServerSecret(
	secrets: SecretStore,
	label: string,
	field: SecretFieldId,
	value: string | undefined
): Promise<void> {
	const blob = { ...(await readServerSecrets(secrets, label)) };
	if (value === undefined) {
		delete blob[field];
	} else {
		blob[field] = value;
	}
	if (Object.keys(blob).length === 0) {
		await secrets.delete(serverSecretsKey(label));
		return;
	}
	await secrets.store(serverSecretsKey(label), JSON.stringify(blob));
}

/**
 * Copy a label's whole blob to another label (the additive half of a rename);
 * a no-op when the source holds nothing. The caller deletes the source only
 * after the settings write that depends on the copy has landed.
 */
export async function copyServerSecrets(secrets: SecretStore, fromLabel: string, toLabel: string): Promise<void> {
	if (fromLabel === toLabel) {
		return;
	}
	const blob = await readServerSecrets(secrets, fromLabel);
	if (Object.keys(blob).length === 0) {
		return;
	}
	await secrets.store(serverSecretsKey(toLabel), JSON.stringify(blob));
}

/** Delete a label's whole blob. */
export async function deleteServerSecrets(secrets: SecretStore, label: string): Promise<void> {
	await secrets.delete(serverSecretsKey(label));
}

/** Everything the engine touches, injected; createServerSyncEnv builds the real one. */
export interface ServerSyncEnv {
	/** The effective litellm-vscode-chat.servers value: what the settings side declares. */
	readServersSetting(): unknown;
	readSecrets(label: string): Promise<StoredServerSecrets>;
	/** The host's provider-group upsert; args are the group configuration with the name and vendor. */
	addProviderGroup(args: Readonly<Record<string, string>>): Thenable<unknown>;
	getFingerprints(): Readonly<Record<string, string>>;
	setFingerprints(map: Readonly<Record<string, string>>): Promise<void>;
	/** Entries removed from the setting; the group itself needs the native editor. */
	notifyRemoved(labels: readonly string[]): void;
	log(message: string, data?: unknown): void;
	logError(message: string, error: unknown): void;
}

/**
 * The inline (in-settings) secret values of a parsed entry: THE rule for
 * "this field is stored inline in the servers setting", and inline values
 * outrank the label's SecretStorage blob. One home, several consumers, so
 * they cannot drift: buildGroupArgs resolves each secret through it,
 * secretLocations reports "settings" exactly for its keys, the dashboard's
 * edit-form prefill (readInlineSecretValues) returns exactly it, and the
 * Set Server Secret palette warns about a dormant stored value exactly when
 * it holds the field. Values are secrets: never log or push them.
 */
export function inlineSecretValues(entry: DeclaredServer): Readonly<Partial<Record<SecretFieldId, string>>> {
	const values: { -readonly [K in SecretFieldId]?: string } = {};
	for (const field of SECRET_FIELD_IDS) {
		const value = entry[field];
		if (value !== undefined) {
			values[field] = value;
		}
	}
	return values;
}

/**
 * The provider-group command arguments for one entry with its secrets
 * resolved. Fields ride in OPTIONAL_ENTRY_FIELDS order after name, vendor,
 * and baseUrl, and that order is frozen: the persisted sync fingerprint
 * hashes JSON.stringify of this object.
 */
export function buildGroupArgs(entry: DeclaredServer, stored: StoredServerSecrets): Record<string, string> {
	const args: Record<string, string> = { name: entry.label, vendor: VENDOR_ID, baseUrl: entry.baseUrl };
	const inline = inlineSecretValues(entry);
	for (const field of OPTIONAL_ENTRY_FIELDS) {
		// Inline settings values outrank the label's SecretStorage blob.
		const value = field.secret ? (inline[field.id] ?? stored[field.id]) : entry[field.id];
		if (value !== undefined) {
			args[field.id] = value;
		}
	}
	return args;
}

function secretLocations(entry: DeclaredServer, stored: StoredServerSecrets): Record<SecretFieldId, SecretLocation> {
	const inline = inlineSecretValues(entry);
	const locations = {} as Record<SecretFieldId, SecretLocation>;
	for (const field of SECRET_FIELD_IDS) {
		locations[field] = inline[field] !== undefined ? "settings" : stored[field] !== undefined ? "secure" : "none";
	}
	return locations;
}

/**
 * The classified upsert-failure text. The host's raw error message is never
 * stored, displayed, or logged: the command was called with fully resolved
 * secrets, and the log buffer feeds public issue reports.
 */
export const GROUP_UPSERT_FAILED_MESSAGE = "The host rejected the provider group upsert";

/**
 * The actionable text for an entry the host refused to sync because a
 * provider group already holds its name. That covers an entry whose
 * configuration changed after its group was created AND a brand-new entry
 * (the adopt flow included) under a name the host already uses, so the text
 * must not assert that anything changed. VS Code's group command is strictly
 * additive (lm.addLanguageModelsProviderGroup rejects an existing name, and
 * no update or removal command exists; pinned by hostGroupCommand.test.ts).
 */
export const GROUP_UPDATE_UNAVAILABLE_MESSAGE =
	"A VS Code provider group already uses this name, and VS Code cannot update an existing group. If the group does not match this entry, remove it in the native Manage Language Models editor and run Sync Models Now.";

/**
 * The classified text for an entry whose stored secrets could not be read
 * this pass. The entry is skipped, not failed permanently: the next pass (or
 * Sync Models Now) reads again.
 */
export const SECRETS_READ_FAILED_MESSAGE =
	"Reading this entry's stored secrets failed, so it was not synced. Run Sync Models Now to retry.";

/**
 * Whether the host refused the add because a group with that name already
 * exists. Fragile by necessity: the host raises a plain Error with no code,
 * so this matches its English message, and on a localized VS Code build it
 * would miss and the entry would degrade to the retry-every-pass
 * upsert-failed path below (noisy, but safe and self-correcting if the host
 * ever grows an update path).
 */
function isDuplicateGroupError(error: unknown): boolean {
	return error instanceof Error && /already exists/i.test(error.message);
}

/**
 * Why a label's last add attempt did not land, keyed to the exact fingerprint
 * it concerned; the two kinds are mutually exclusive per label, so one map
 * holds them.
 *
 * "blocked": the host refused the add as a duplicate while the entry had
 * changed. There is nothing a retry with the same configuration can do (no
 * update API), so unforced passes skip the host call and keep the actionable
 * error instead of hammering; a forced pass (activation, Sync Models Now)
 * retries anyway, because the user may have removed the stale group natively
 * by then.
 *
 * "upsertFailed": the add failed for a non-duplicate reason. The persisted
 * fingerprint map records last-known-good only, so this is the separate retry
 * signal: an unforced pass re-calls the host while the entry still holds the
 * failed configuration, whereas a revert to last-known-good is in sync
 * without a call (the failure concerned a configuration that no longer
 * exists). Overloading the fingerprint map with both roles wedged entries:
 * dropping the fingerprint to force a retry destroyed the only record that
 * lets a healthy group's later duplicate response read as in-sync.
 */
interface RetryState {
	kind: "blocked" | "upsertFailed";
	fingerprint: string;
}

/**
 * Keeps provider groups in step with the servers setting. syncNow is
 * serialized: a call during an in-flight pass queues exactly one follow-up
 * and resolves after that follow-up (the pass that includes the caller's
 * request). requestSync debounces bursts from settings.json keystrokes.
 * `force` ignores the stored fingerprints (still rewriting them), so
 * activation and explicit syncs reconcile groups edited or removed natively.
 */
export class ServerSyncEngine implements vscode.Disposable {
	private views: DeclaredServerView[] = [];
	/** Per-label retry state that must survive between passes; see RetryState. */
	private retry = new Map<string, RetryState>();
	private running: Promise<void> | undefined;
	private queued: { force: boolean; promise: Promise<void>; resolve: () => void } | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** Called after every completed sync pass; the dashboard refreshes on it. */
	onDidSync: (() => void) | undefined;

	constructor(
		private readonly env: ServerSyncEnv,
		private readonly debounceMs = 400
	) {}

	/** The declared servers as of the last sync pass, for the dashboard state. */
	getDeclared(): readonly DeclaredServerView[] {
		return this.views;
	}

	requestSync(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.syncNow();
		}, this.debounceMs);
	}

	async syncNow(force = false): Promise<void> {
		if (this.running !== undefined) {
			if (this.queued === undefined) {
				let resolve!: () => void;
				const promise = new Promise<void>((resolvePromise) => {
					resolve = resolvePromise;
				});
				this.queued = { force, promise, resolve };
			}
			this.queued.force ||= force;
			return this.queued.promise;
		}
		this.running = this.runOnce(force);
		try {
			await this.running;
		} finally {
			this.running = undefined;
			const queued = this.queued;
			this.queued = undefined;
			if (queued !== undefined) {
				// runOnce never rethrows, but the queued waiters must settle even if
				// that ever changes, so rejection also resolves them.
				void this.syncNow(queued.force).then(queued.resolve, queued.resolve);
			}
		}
	}

	dispose(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private async runOnce(force: boolean): Promise<void> {
		try {
			await this.syncPass(force);
		} catch (error) {
			// Individual upserts handle their own failures; this catches the
			// stores themselves misbehaving. Never rethrown: sync runs on
			// activation and on configuration events.
			this.env.logError("Server sync failed", error);
		}
		try {
			this.onDidSync?.();
		} catch (error) {
			this.env.logError("Server sync listener failed", error);
		}
	}

	private async syncPass(force: boolean): Promise<void> {
		const { entries, problems } = parseServersSetting(this.env.readServersSetting());
		for (const problem of problems) {
			this.env.log(`Servers setting: ${problem}`);
		}

		const previous = this.env.getFingerprints();
		const next: Record<string, string> = {};
		const views: DeclaredServerView[] = [];
		for (const entry of entries) {
			let stored: StoredServerSecrets = {};
			let secretsUnreadable = false;
			// The entry's user-facing message for THIS pass: exactly one branch
			// below decides it, and only this iteration's view reads it. What must
			// survive between passes is the retry state, which the message is
			// recomputed from - so a pass that cannot read the stored secrets
			// overwrites the message while the blocked fingerprint stays put, and
			// the next healthy pass re-asserts the name-conflict text.
			let syncError: string | undefined;
			try {
				stored = await this.env.readSecrets(entry.label);
			} catch (error) {
				// A failed secret read must not abort the pass: later entries still
				// need their sync, and an earlier successful add must still reach
				// the fingerprint persist below (losing it would misread that
				// group's next duplicate response as a name conflict). This entry
				// is skipped for the pass; its view renders the classified error
				// and degrades the secret locations to the inline-only reading.
				secretsUnreadable = true;
				syncError = SECRETS_READ_FAILED_MESSAGE;
				this.env.log("Reading a server entry's stored secrets failed", {
					label: entry.label,
					error: error instanceof Error ? error.name : typeof error,
				});
			}
			const args = buildGroupArgs(entry, stored);
			const printed = fingerprint(JSON.stringify(args));
			const retryState = this.retry.get(entry.label);
			if (secretsUnreadable) {
				// Without the real secrets the fingerprint is not meaningful, so no
				// host call and no retry bookkeeping (the stored retry state stays
				// put on purpose); last-known-good carries.
				const lastGood = previous[entry.label];
				if (lastGood !== undefined) {
					next[entry.label] = lastGood;
				}
			} else if (
				!force &&
				previous[entry.label] === printed &&
				!(retryState?.kind === "upsertFailed" && retryState.fingerprint === printed)
			) {
				next[entry.label] = printed;
				// An entry stuck on the duplicate error that now matches its
				// last-known-good fingerprint again was reverted: the live group
				// already holds this exact content, so the error clears silently.
				// A pending retry recorded for some OTHER configuration is moot
				// for the same reason; only a failure for this very fingerprint
				// (the guard above) sends the entry back to the host.
				this.retry.delete(entry.label);
			} else if (!force && retryState?.kind === "blocked" && retryState.fingerprint === printed) {
				// The host already refused this exact configuration as a duplicate
				// and offers no update path; retrying without a user gesture would
				// just hammer the command. The last-known-good fingerprint is
				// carried so a later revert of the entry can still match it.
				syncError = GROUP_UPDATE_UNAVAILABLE_MESSAGE;
				const lastGood = previous[entry.label];
				if (lastGood !== undefined) {
					next[entry.label] = lastGood;
				}
			} else {
				try {
					await this.env.addProviderGroup(args);
					next[entry.label] = printed;
					this.retry.delete(entry.label);
					// Write-through: a completed add persists its fingerprint at
					// once, merged over the stored map. If anything later in the
					// pass (or the final wholesale write) fails, the group now
					// exists host-side, and without this record its next duplicate
					// response would misread as a name conflict.
					try {
						await this.env.setFingerprints({ ...this.env.getFingerprints(), [entry.label]: printed });
					} catch (error) {
						this.env.logError("Persisting a synced fingerprint failed", error);
					}
					this.env.log("Synced server entry to its provider group", {
						label: entry.label,
						baseUrl: entry.baseUrl,
						hasApiKey: args.apiKey !== undefined,
						hasOAuth: args.oauthTokenUrl !== undefined,
					});
				} catch (error) {
					if (isDuplicateGroupError(error)) {
						if (previous[entry.label] === printed) {
							// A forced pass re-adding an unchanged entry: under an add-only
							// host (no upsert), "the group already exists" IS the synced
							// steady state, so every activation lands here for every
							// healthy entry. Not logged for that reason.
							next[entry.label] = printed;
							this.retry.delete(entry.label);
						} else {
							// The entry changed (or is new under a taken name) but the host
							// cannot update or replace an existing group. The last-known-
							// good fingerprint is carried forward: under an add-only host
							// it still describes the live group's content, so reverting
							// the entry lands back on the in-sync branch as a silent no-op
							// instead of wedging on this error forever. The refused
							// fingerprint goes into the retry state as "blocked" (not the
							// map) so unforced passes keep the error without hammering and
							// a forced pass retries after the user removes the stale group
							// natively.
							const lastGood = previous[entry.label];
							if (lastGood !== undefined) {
								next[entry.label] = lastGood;
							}
							this.retry.set(entry.label, { kind: "blocked", fingerprint: printed });
							syncError = GROUP_UPDATE_UNAVAILABLE_MESSAGE;
							this.env.log("Provider group exists and the host has no update path", { label: entry.label });
						}
					} else {
						// The persisted map keeps the last-known-good fingerprint (a
						// failed add changed nothing about the live group), and the
						// retry rides the "upsertFailed" state instead: dropping the
						// fingerprint here would destroy the only record that lets the
						// healthy group's next duplicate response read as in-sync, or a
						// revert land silently. Any duplicate-refusal knowledge is stale
						// now (the group may have been removed natively, which is often
						// why this call ran at all), so setting the state also clears a
						// stale "blocked" - otherwise its shortcut would suppress the
						// retry this failure needs. The raw error stays out of the view
						// and the log: the command carried resolved secrets, and a host
						// that echoes its arguments would leak them into public issue
						// reports.
						const lastGood = previous[entry.label];
						if (lastGood !== undefined) {
							next[entry.label] = lastGood;
						}
						this.retry.set(entry.label, { kind: "upsertFailed", fingerprint: printed });
						syncError = GROUP_UPSERT_FAILED_MESSAGE;
						this.env.log("Provider group upsert failed", {
							label: entry.label,
							error: error instanceof Error ? error.name : typeof error,
						});
					}
				}
			}
			const groupServer = parseGroupConfiguration(args);
			views.push({
				label: entry.label,
				baseUrl: entry.baseUrl,
				...pickNonSecretOptionalFields(entry),
				secrets: secretLocations(entry, stored),
				expectedClientId: groupServer !== undefined ? groupClientId(groupServer) : undefined,
				syncError,
			});
		}

		const currentLabels = new Set(entries.map((entry) => entry.label));
		const removed = Object.keys(previous).filter((label) => !currentLabels.has(label));
		// Per-label retry state is pruned with its entry; the map is keyed by
		// user-controlled labels and would otherwise grow without bound.
		for (const label of [...this.retry.keys()]) {
			if (!currentLabels.has(label)) {
				this.retry.delete(label);
			}
		}
		this.views = views;
		await this.env.setFingerprints(next);
		if (removed.length > 0) {
			// The setting entry is gone but the provider group survives: there is
			// no programmatic group removal. The label's SecretStorage blob is
			// kept on purpose; re-adding the label picks it up again.
			this.env.log("Servers setting entries removed; their provider groups remain", { labels: removed });
			this.env.notifyRemoved(removed);
		}
	}
}

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
