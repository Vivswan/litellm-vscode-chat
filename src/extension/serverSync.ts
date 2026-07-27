/**
 * The declarative server sync: litellm-vscode-chat.servers is the settings
 * side's source of truth for servers, and this module keeps VS Code's
 * provider groups in step with it. Each entry upserts through the host's
 * lm.addLanguageModelsProviderGroup command (the same call devSeed.ts makes),
 * with its secret fields resolved as inline-in-settings value first, then the
 * label's SecretStorage blob, then absent.
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
			const stored = await this.env.readSecrets(entry.label);
			const args = buildGroupArgs(entry, stored);
			const printed = fingerprint(JSON.stringify(args));
			if (!force && previous[entry.label] === printed) {
				next[entry.label] = printed;
			} else {
				try {
					await this.env.addProviderGroup(args);
					next[entry.label] = printed;
					this.syncErrors.delete(entry.label);
					this.env.log("Synced server entry to its provider group", {
						label: entry.label,
						baseUrl: entry.baseUrl,
						hasApiKey: args.apiKey !== undefined,
						hasOAuth: args.oauthTokenUrl !== undefined,
					});
				} catch (error) {
					// Keep the old fingerprint out of the map so the next pass
					// retries. The raw error stays out of the view and the log: the
					// command carried resolved secrets, and a host that echoes its
					// arguments would leak them into public issue reports.
					this.syncErrors.set(entry.label, GROUP_UPSERT_FAILED_MESSAGE);
					this.env.log("Provider group upsert failed", {
						label: entry.label,
						error: error instanceof Error ? error.name : typeof error,
					});
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
