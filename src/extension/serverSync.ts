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
import { fingerprint } from "../shared/fingerprint";
import { isUnsafeRecordKey } from "../shared/json";
import type { Logger } from "../shared/logger";
import type { SecretFieldId, SecretLocation } from "../shared/serverSecrets";
import { SECRET_FIELD_IDS } from "../shared/serverSecrets";
import { SERVER_SYNC_FINGERPRINTS_KEY, serverSecretsKey } from "../shared/storageKeys";

/** The configuration key, relative to the litellm-vscode-chat section. */
export const SERVERS_SETTING_KEY = "servers";

const CONFIG_SECTION = "litellm-vscode-chat";

/** The string fields a servers-setting entry may carry, secrets included (inline storage is legal). */
const ENTRY_FIELDS = [
	"label",
	"baseUrl",
	"apiKey",
	"oauthTokenUrl",
	"oauthClientId",
	"oauthClientSecret",
	"oauthScopes",
	"virtualKeyHeader",
	"virtualKeyValue",
] as const;

type EntryField = (typeof ENTRY_FIELDS)[number];

/** One parsed servers-setting entry: label and baseUrl usable, other fields present only with usable text. */
export type DeclaredServer = { readonly label: string; readonly baseUrl: string } & Partial<
	Readonly<Record<Exclude<EntryField, "label" | "baseUrl">, string>>
>;

/** The non-secret view of a declared server the dashboard renders; secret values stay out. */
export interface DeclaredServerView {
	readonly label: string;
	readonly baseUrl: string;
	readonly oauthTokenUrl?: string | undefined;
	readonly oauthClientId?: string | undefined;
	readonly oauthScopes?: string | undefined;
	readonly virtualKeyHeader?: string | undefined;
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
	const entries: DeclaredServer[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	raw.forEach((item: unknown, index) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			problems.push(`entry ${index + 1} is not an object`);
			return;
		}
		const record = item as Record<string, unknown>;
		const label = usableString(record.label);
		const baseUrl = usableString(record.baseUrl);
		if (label === undefined || baseUrl === undefined) {
			problems.push(`entry ${index + 1} is missing a label or baseUrl`);
			return;
		}
		if (isUnsafeRecordKey(label)) {
			problems.push(`entry ${index + 1} uses a reserved label`);
			return;
		}
		if (seen.has(label)) {
			problems.push(`entry ${index + 1} repeats an earlier entry's label; the first entry wins`);
			return;
		}
		seen.add(label);
		const entry: { label: string; baseUrl: string } & Partial<Record<EntryField, string>> = { label, baseUrl };
		for (const field of ENTRY_FIELDS) {
			if (field === "label" || field === "baseUrl") {
				continue;
			}
			const value = usableString(record[field]);
			if (value !== undefined) {
				entry[field] = value;
			}
		}
		entries.push(entry);
	});
	return { entries, problems };
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
 * The provider-group command arguments for one entry with its secrets
 * resolved. Field order is fixed so the JSON fingerprint is stable.
 */
export function buildGroupArgs(entry: DeclaredServer, stored: StoredServerSecrets): Record<string, string> {
	const args: Record<string, string> = { name: entry.label, vendor: "litellm", baseUrl: entry.baseUrl };
	const resolve = (field: SecretFieldId): string | undefined => entry[field] ?? stored[field];
	const optional: Record<string, string | undefined> = {
		apiKey: resolve("apiKey"),
		oauthTokenUrl: entry.oauthTokenUrl,
		oauthClientId: entry.oauthClientId,
		oauthClientSecret: resolve("oauthClientSecret"),
		oauthScopes: entry.oauthScopes,
		virtualKeyHeader: entry.virtualKeyHeader,
		virtualKeyValue: resolve("virtualKeyValue"),
	};
	for (const [field, value] of Object.entries(optional)) {
		if (value !== undefined) {
			args[field] = value;
		}
	}
	return args;
}

function secretLocation(entry: DeclaredServer, stored: StoredServerSecrets, field: SecretFieldId): SecretLocation {
	if (entry[field] !== undefined) {
		return "settings";
	}
	return stored[field] !== undefined ? "secure" : "none";
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
 * Keeps provider groups in step with the servers setting. syncNow is
 * serialized: a call during an in-flight pass queues exactly one follow-up
 * and resolves after that follow-up (the pass that includes the caller's
 * request). requestSync debounces bursts from settings.json keystrokes.
 * `force` ignores the stored fingerprints (still rewriting them), so
 * activation and explicit syncs reconcile groups edited or removed natively.
 */
export class ServerSyncEngine implements vscode.Disposable {
	private views: DeclaredServerView[] = [];
	private syncErrors = new Map<string, string>();
	/**
	 * Labels whose add the host refused as a duplicate while their entry had
	 * changed, keyed to the fingerprint that was refused: there is nothing a
	 * retry with the same configuration can do (no update API), so unforced
	 * passes skip the host call and keep the actionable error instead of
	 * hammering. A forced pass (activation, Sync Models Now) retries anyway,
	 * because the user may have removed the stale group natively by then.
	 */
	private blocked = new Map<string, string>();
	/**
	 * Labels whose last add attempt failed for a non-duplicate reason, keyed
	 * to the fingerprint that failed. The persisted fingerprint map records
	 * last-known-good only, so this is the separate retry signal: an unforced
	 * pass re-calls the host while the entry still holds the failed
	 * configuration, whereas a revert to last-known-good is in sync without a
	 * call (the failure concerned a configuration that no longer exists).
	 * Overloading the fingerprint map with both roles wedged entries: dropping
	 * the fingerprint to force a retry destroyed the only record that lets a
	 * healthy group's later duplicate response read as in-sync.
	 */
	private failedUpserts = new Map<string, string>();
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
				this.syncErrors.set(entry.label, SECRETS_READ_FAILED_MESSAGE);
				this.env.log("Reading a server entry's stored secrets failed", {
					label: entry.label,
					error: error instanceof Error ? error.name : typeof error,
				});
			}
			const args = buildGroupArgs(entry, stored);
			const printed = fingerprint(JSON.stringify(args));
			if (secretsUnreadable) {
				// Without the real secrets the fingerprint is not meaningful, so
				// no host call and no retry bookkeeping; last-known-good carries.
				const lastGood = previous[entry.label];
				if (lastGood !== undefined) {
					next[entry.label] = lastGood;
				}
			} else if (!force && previous[entry.label] === printed && this.failedUpserts.get(entry.label) !== printed) {
				next[entry.label] = printed;
				// An entry stuck on the duplicate error that now matches its
				// last-known-good fingerprint again was reverted: the live group
				// already holds this exact content, so the error clears silently.
				// A pending retry recorded for some OTHER configuration is moot
				// for the same reason; only a failure for this very fingerprint
				// (the guard above) sends the entry back to the host.
				this.syncErrors.delete(entry.label);
				this.blocked.delete(entry.label);
				this.failedUpserts.delete(entry.label);
			} else if (!force && this.blocked.get(entry.label) === printed) {
				// The host already refused this exact configuration as a duplicate
				// and offers no update path; retrying without a user gesture would
				// just hammer the command. The classification is re-asserted, not
				// assumed: an intervening pass may have overwritten it (a failed
				// secret read, say), and this branch must describe the state it
				// short-circuits on. The last-known-good fingerprint is carried so
				// a later revert of the entry can still match it.
				this.syncErrors.set(entry.label, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
				const lastGood = previous[entry.label];
				if (lastGood !== undefined) {
					next[entry.label] = lastGood;
				}
			} else {
				try {
					await this.env.addProviderGroup(args);
					next[entry.label] = printed;
					this.syncErrors.delete(entry.label);
					this.blocked.delete(entry.label);
					this.failedUpserts.delete(entry.label);
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
						this.failedUpserts.delete(entry.label);
						if (previous[entry.label] === printed) {
							// A forced pass re-adding an unchanged entry: under an add-only
							// host (no upsert), "the group already exists" IS the synced
							// steady state, so every activation lands here for every
							// healthy entry. Not logged for that reason.
							next[entry.label] = printed;
							this.syncErrors.delete(entry.label);
							this.blocked.delete(entry.label);
						} else {
							// The entry changed (or is new under a taken name) but the host
							// cannot update or replace an existing group. The last-known-
							// good fingerprint is carried forward: under an add-only host
							// it still describes the live group's content, so reverting
							// the entry lands back on the in-sync branch as a silent no-op
							// instead of wedging on this error forever. The refused
							// fingerprint goes into `blocked` (not the map) so unforced
							// passes keep the error without hammering and a forced pass
							// retries after the user removes the stale group natively.
							const lastGood = previous[entry.label];
							if (lastGood !== undefined) {
								next[entry.label] = lastGood;
							}
							this.blocked.set(entry.label, printed);
							this.syncErrors.set(entry.label, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
							this.env.log("Provider group exists and the host has no update path", { label: entry.label });
						}
					} else {
						// The persisted map keeps the last-known-good fingerprint (a
						// failed add changed nothing about the live group), and the
						// retry rides failedUpserts instead: dropping the fingerprint
						// here would destroy the only record that lets the healthy
						// group's next duplicate response read as in-sync, or a revert
						// land silently. Any duplicate-refusal knowledge is stale now
						// (the group may have been removed natively, which is often
						// why this call ran at all), so `blocked` clears too -
						// otherwise its shortcut would suppress the retry this
						// failure needs. The raw error stays out of the view and the
						// log: the command carried resolved secrets, and a host that
						// echoes its arguments would leak them into public issue
						// reports.
						const lastGood = previous[entry.label];
						if (lastGood !== undefined) {
							next[entry.label] = lastGood;
						}
						this.blocked.delete(entry.label);
						this.failedUpserts.set(entry.label, printed);
						this.syncErrors.set(entry.label, GROUP_UPSERT_FAILED_MESSAGE);
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
				oauthTokenUrl: entry.oauthTokenUrl,
				oauthClientId: entry.oauthClientId,
				oauthScopes: entry.oauthScopes,
				virtualKeyHeader: entry.virtualKeyHeader,
				secrets: {
					apiKey: secretLocation(entry, stored, "apiKey"),
					oauthClientSecret: secretLocation(entry, stored, "oauthClientSecret"),
					virtualKeyValue: secretLocation(entry, stored, "virtualKeyValue"),
				},
				expectedClientId: groupServer !== undefined ? groupClientId(groupServer) : undefined,
				syncError: this.syncErrors.get(entry.label),
			});
		}

		const currentLabels = new Set(entries.map((entry) => entry.label));
		const removed = Object.keys(previous).filter((label) => !currentLabels.has(label));
		// Per-label state is pruned with its entry; the maps are keyed by
		// user-controlled labels and would otherwise grow without bound.
		for (const map of [this.blocked, this.syncErrors, this.failedUpserts]) {
			for (const label of [...map.keys()]) {
				if (!currentLabels.has(label)) {
					map.delete(label);
				}
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
						void vscode.commands.executeCommand("litellm.manageServers");
					}
				});
		},
		log: (message, data) => logger.log(message, data),
		logError: (message, error) => logger.error(message, error),
	};
}

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
		vscode.commands.registerCommand("litellm.setServerSecret", async () => {
			const { entries } = parseServersSetting(
				vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY)
			);
			if (entries.length === 0) {
				void vscode.window.showInformationMessage(
					"No servers declared in the litellm-vscode-chat.servers setting yet. Add one there or in the dashboard first."
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
				[
					{ label: "API key", field: "apiKey" as const },
					{ label: "OAuth client secret", field: "oauthClientSecret" as const },
					{ label: "Virtual key value", field: "virtualKeyValue" as const },
				],
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
			if (value.length > 0 && entryPick.entry[fieldPick.field] !== undefined) {
				// Inline settings values outrank the stored blob, so the just-stored
				// secret stays dormant until the inline one is removed.
				void vscode.window.showWarningMessage(
					`"${entryPick.label}" also sets ${fieldPick.field} inline in the servers setting, and inline values take precedence. Remove the inline value for the stored secret to take effect.`
				);
			}
			engine.requestSync();
		})
	);
}
