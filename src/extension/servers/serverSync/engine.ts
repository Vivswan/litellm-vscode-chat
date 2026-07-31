/**
 * The sync engine: builds the provider-group arguments for each declared
 * entry, drives the host's add-only group command, and owns the fingerprint
 * and retry bookkeeping that keeps duplicate rejections readable. Effects
 * arrive through the injected ServerSyncEnv, so everything here is
 * unit-testable without vscode.
 */

import type * as vscode from "vscode";
import { groupClientId, parseGroupConfiguration } from "../../../provider/catalog/groupModels";
import { VENDOR_ID } from "../../../shared/config/commandIds";
import type { NonSecretOptionalFields, SecretFieldId, SecretLocation } from "../../../shared/serverEntry";
import { OPTIONAL_ENTRY_FIELDS, pickNonSecretOptionalFields, SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import { fingerprint } from "../../../shared/util/fingerprint";
import type { StoredServerSecrets } from "./secrets";
import { inlineSecretValues } from "./secrets";
import type { DeclaredServer, EntryModelParameters } from "./setting";
import { parseServersSetting } from "./setting";

/**
 * Which failure class produced a view's syncError. "upsertFailed" means the
 * add failed outright (non-duplicate), so no live group was created for the
 * entry's configuration; "blocked" means a group with the name exists and the
 * host refused the duplicate; "secretsUnreadable" means the pass skipped the
 * entry. The dashboard reads the distinction: a shared snapshot's models are
 * duplicated per claiming entry EXCEPT upsertFailed claimants, whose group is
 * the one the host provably does not have.
 */
type SyncErrorClass = "upsertFailed" | "blocked" | "secretsUnreadable";

/** The non-secret view of a declared server the dashboard renders; secret values stay out. */
export interface DeclaredServerView extends NonSecretOptionalFields {
	readonly label: string;
	readonly baseUrl: string;
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;
	/** The entry's per-entry modelParameters (non-secret user configuration); the edit form's prefill. */
	readonly modelParameters?: EntryModelParameters | undefined;
	/**
	 * The group client ID the entry's resolved configuration produces: the same
	 * identity the provider stamps on its status snapshots, so the dashboard can
	 * join a declared entry to exactly its live group even when several entries
	 * share a base URL. The embedded credential fingerprint is non-secret, but
	 * the ID stays extension-side; it is never pushed into DashboardState.
	 * Absent when the entry does not resolve to a usable group configuration.
	 */
	readonly expectedClientId?: string | undefined;
	/**
	 * The label-agnostic connection identity: the client ID the same
	 * configuration produces without the entry label. Groups created before
	 * labels flowed into the configuration report under this identity, and
	 * entries that mirror one server with one credential set share it, so the
	 * join's shared-status pass can hand them all the same live snapshot.
	 * Same non-secret handling rules as expectedClientId.
	 */
	readonly expectedConnectionId?: string | undefined;
	/** The label's last upsert failure, cleared by the next success. */
	readonly syncError?: string | undefined;
	/** The failure class behind syncError; always set together with it. */
	readonly syncErrorClass?: SyncErrorClass | undefined;
}

/** Everything the engine touches, injected; createServerSyncEnv builds the real one. */
export interface ServerSyncEnv {
	/** The effective litellm-vscode-chat.servers value: what the settings side declares. */
	readServersSetting(): unknown;
	readSecrets(label: string): Promise<StoredServerSecrets>;
	/** The host's provider-group upsert; args are the group configuration with the name and vendor. */
	addProviderGroup(args: Readonly<Record<string, string>>): Thenable<unknown>;
	/**
	 * The persisted fingerprint map: read to seed the engine's in-memory
	 * session map (see ServerSyncEngine.fingerprints), and re-read on the
	 * duplicate-rejection path as positive confirmation only.
	 */
	getFingerprints(): Readonly<Record<string, string>>;
	setFingerprints(map: Readonly<Record<string, string>>): Promise<void>;
	/** Entries removed from the setting; the group itself needs the native editor. */
	notifyRemoved(labels: readonly string[]): void;
	log(message: string, data?: unknown): void;
	logError(message: string, error: unknown): void;
}

/**
 * The provider-group command arguments for one entry with its secrets
 * resolved. Fields ride in OPTIONAL_ENTRY_FIELDS order after name, vendor,
 * baseUrl, and label, and that order is frozen: the persisted sync
 * fingerprint hashes JSON.stringify of this object. `label` repeats the
 * group name as a configuration property because the host echoes only the
 * configuration back to the provider, never the name; it is what gives
 * entries sharing a base URL and credentials distinct group identities.
 * The entry's modelParameters deliberately stay out: they are read
 * extension-side at request time, so editing them must not change the
 * fingerprint or churn the group.
 */
export function buildGroupArgs(entry: DeclaredServer, stored: StoredServerSecrets): Record<string, string> {
	const args: Record<string, string> = {
		name: entry.label,
		vendor: VENDOR_ID,
		baseUrl: entry.baseUrl,
		label: entry.label,
	};
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

/**
 * The fingerprint of the same args as pre-label extension versions built
 * them. Adding `label` to buildGroupArgs changed every entry's fingerprint
 * at once, and the host cannot update an existing group, so without this
 * rendering every healthy pre-label entry would wedge: its forced re-add
 * comes back as a duplicate, the stored (pre-label) fingerprint would not
 * confirm it, and the entry would surface the name-conflict error forever.
 * A stored fingerprint matching this rendering is the same proof of "the
 * live group holds this entry's content" - minus the label, which an
 * add-only host can never receive retroactively - and the matching paths
 * upgrade the record to the current shape, so the shim runs once per entry.
 */
function legacyGroupArgsFingerprint(args: Record<string, string>): string {
	const { label: _label, ...legacyArgs } = args;
	return fingerprint(JSON.stringify(legacyArgs));
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
	/**
	 * The session's authoritative fingerprint map: seeded from the persisted
	 * store on the first pass, maintained in memory from then on, and written
	 * through for the next session only - decisions never trust store
	 * re-reads, with ONE exception: the duplicate-rejection path may take a
	 * fresh read as positive confirmation that another window already synced
	 * the same configuration (see syncPass; matches are safe, absences prove
	 * nothing). The monkey fuzzer caught why blind re-reads wedge entries: an
	 * awaited globalState.update can be reverted moments later by a stale
	 * value from the storage layer (the whole key came back as its previous
	 * version), and a pass that trusts that read re-adds its own group, takes
	 * the duplicate rejection as a foreign name conflict, and - with no
	 * last-known-good left to carry - keeps the error forever.
	 */
	private fingerprints: Record<string, string> | undefined;
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

		// Seed once, then the in-memory map is the truth for every comparison
		// below; `previous` keeps pass-start snapshot semantics because the
		// write-through replaces this.fingerprints instead of mutating it.
		this.fingerprints ??= { ...this.env.getFingerprints() };
		const previous: Readonly<Record<string, string>> = this.fingerprints;
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
			let syncErrorClass: SyncErrorClass | undefined;
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
				syncErrorClass = "secretsUnreadable";
				this.env.log("Reading a server entry's stored secrets failed", {
					label: entry.label,
					error: error instanceof Error ? error.name : typeof error,
				});
			}
			const args = buildGroupArgs(entry, stored);
			const printed = fingerprint(JSON.stringify(args));
			// The rendering pre-label sessions persisted for this same content;
			// accepted wherever a stored fingerprint proves the live group's
			// content, and upgraded to `printed` on the spot.
			const legacyPrinted = legacyGroupArgsFingerprint(args);
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
				(previous[entry.label] === printed || previous[entry.label] === legacyPrinted) &&
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
				syncErrorClass = "blocked";
				const lastGood = previous[entry.label];
				if (lastGood !== undefined) {
					next[entry.label] = lastGood;
				}
			} else {
				try {
					await this.env.addProviderGroup(args);
					next[entry.label] = printed;
					this.retry.delete(entry.label);
					// Write-through: a completed add records its fingerprint at once
					// (in-memory first - that record is what keeps the group's next
					// duplicate response reading as in-sync, and it must survive any
					// storage misbehavior), then persists for the next session. A
					// failed persist is log-only for the same reason.
					this.fingerprints = { ...this.fingerprints, [entry.label]: printed };
					try {
						await this.env.setFingerprints(this.fingerprints);
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
						// The session map first; failing that, ONE fresh store read as
						// POSITIVE confirmation only. The servers setting is machine-
						// scoped and globalState is shared, so another window's engine
						// may have added this exact configuration and persisted its
						// fingerprint - a record this window's seed-once map predates.
						// The asymmetry is load-bearing: the stale-read failure mode
						// the in-memory map guards against can only UNDER-report (an
						// older map), never invent a matching fingerprint, so a match
						// proves the live group holds exactly these args while an
						// absence proves nothing. The legacy rendering confirms too:
						// a pre-label session's record describes the same content.
						const storeRecord = this.env.getFingerprints()[entry.label];
						const confirmed =
							previous[entry.label] === printed ||
							storeRecord === printed ||
							previous[entry.label] === legacyPrinted ||
							storeRecord === legacyPrinted;
						if (confirmed) {
							// Under an add-only host (no upsert), "the group already
							// exists" for a confirmed configuration IS the synced steady
							// state: every activation's forced pass lands here for every
							// healthy entry. Not logged for that reason.
							next[entry.label] = printed;
							// Into the session map at once, like a successful add: a
							// LATER entry's write-through persists a spread of this map,
							// and without the confirmed label it would re-clobber the
							// other window's record mid-pass - the exact loss the
							// confirmation exists to prevent.
							this.fingerprints = { ...this.fingerprints, [entry.label]: printed };
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
							syncErrorClass = "blocked";
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
						syncErrorClass = "upsertFailed";
						this.env.log("Provider group upsert failed", {
							label: entry.label,
							error: error instanceof Error ? error.name : typeof error,
						});
					}
				}
			}
			const groupServer = parseGroupConfiguration(args);
			let expectedClientId: string | undefined;
			let expectedConnectionId: string | undefined;
			if (groupServer !== undefined) {
				expectedClientId = groupClientId(groupServer);
				const { label: _label, ...connection } = groupServer;
				expectedConnectionId = groupClientId(connection);
			}
			views.push({
				label: entry.label,
				baseUrl: entry.baseUrl,
				...pickNonSecretOptionalFields(entry),
				...(entry.modelParameters !== undefined ? { modelParameters: entry.modelParameters } : {}),
				secrets: secretLocations(entry, stored),
				expectedClientId,
				expectedConnectionId,
				syncError,
				syncErrorClass,
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
		// In-memory before the persist: session truth must survive a failing
		// (or later-reverted) storage write.
		this.fingerprints = next;
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
