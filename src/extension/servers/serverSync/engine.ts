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
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { fingerprint } from "../../../shared/util/fingerprint";
import { isUnsafeRecordKey } from "../../../shared/util/json";
import type { StoredServerSecrets } from "./secrets";
import { inlineSecretValues } from "./secrets";
import type { DeclaredServer, EntryModelParameters } from "./setting";
import { parseServersSetting, rawDeclaredLabels } from "./setting";

/**
 * Which failure class produced a view's syncError. "upsertFailed" means the
 * add failed outright (non-duplicate), so no live group was created for the
 * entry's configuration; "blocked" means a group with the name exists and the
 * host refused the duplicate; "secretsUnreadable" means the pass skipped the
 * entry - because its stored secrets could not be read, or because the
 * fingerprint salt could not be confirmed durable (SALT_UNAVAILABLE_MESSAGE
 * tells the two apart in the view). The dashboard reads the distinction: a
 * shared snapshot's models are duplicated per claiming entry EXCEPT
 * upsertFailed claimants, whose group is the one the host provably does not
 * have.
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

/** One identity the setting currently declares: the entry label and its normalized base URL. */
export interface DeclaredEntryIdentity {
	readonly label: string;
	readonly baseUrl: string;
}

/**
 * One entry the pass found gone from the setting, classified. "renamed" means
 * a new label (one with no prior fingerprint record) now declares the removed
 * label's base URL, so the disappearance is a rename and the old group is a
 * rename leftover, not an explicit removal. "removed" is everything else; its
 * baseUrl comes from the persisted identity ledger and is undefined for
 * labels the ledger predates (their group identity cannot be resolved, so
 * the env must not tombstone them).
 */
export type RemovedEntryEvent =
	| { readonly kind: "removed"; readonly label: string; readonly baseUrl: string | undefined }
	| { readonly kind: "renamed"; readonly oldLabel: string; readonly newLabel: string; readonly baseUrl: string };

/** Everything the engine touches, injected; createServerSyncEnv builds the real one. */
export interface ServerSyncEnv {
	/** The effective litellm-vscode-chat.servers value: what the settings side declares. */
	readServersSetting(): unknown;
	readSecrets(label: string): Promise<StoredServerSecrets>;
	/** The host's provider-group upsert; args are the group configuration with the name and vendor. */
	addProviderGroup(args: Readonly<Record<string, string>>): Thenable<unknown>;
	/**
	 * Whether fingerprints computed this pass will be recognizable by later
	 * sessions (the per-install salt is confirmed to be the stored one; see
	 * extension/fingerprintSalt.ts). Checked once per pass, at decision time:
	 * when false the pass must neither add groups (an add-only host could
	 * never confirm them again) nor record fingerprints beyond carrying
	 * last-known-good. Must not throw; an unknowable state reads as false.
	 */
	confirmFingerprintsDurable(): Promise<boolean>;
	/**
	 * The persisted fingerprint map: read to seed the engine's in-memory
	 * session map (see ServerSyncEngine.fingerprints), and re-read per entry
	 * presence-only: as positive confirmation on the duplicate-rejection
	 * path, and as the preservation fallback when a pass leaves an entry
	 * unsynced (see carryLastGood).
	 */
	getFingerprints(): Readonly<Record<string, string>>;
	setFingerprints(map: Readonly<Record<string, string>>): Promise<void>;
	/**
	 * The persisted identity ledger: label -> normalized base URL for the
	 * entries earlier passes saw declared. It resolves which host a
	 * just-removed label's group pointed at, so it is what a removal's
	 * tombstone stands on. Like the fingerprints it is subject to the storage
	 * layer handing back stale values, so the engine seeds a session copy from
	 * the first read and treats later reads as presence-only gap fillers (a
	 * stale read can only under-report, never invent a record; see
	 * ServerSyncEngine.ledger). Unlike the fingerprints it carries no
	 * credential material and no salt dependence, so writes go out unguarded.
	 */
	getEntryBaseUrls(): Readonly<Record<string, string>>;
	setEntryBaseUrls(map: Readonly<Record<string, string>>): Promise<void>;
	/**
	 * Pass-end identity reconciliation, called once per pass: the identities
	 * the setting currently declares, and the removal/rename events this pass
	 * detected (empty most passes). The env clears removal tombstones matching
	 * a declared identity (a re-declared group must never stay suppressed),
	 * records tombstones and provenance for the events, and raises the
	 * user-facing notice; deleting the group itself means editing the models
	 * file. Awaited by
	 * the pass, so reconciliations stay serialized with the passes that
	 * produced them: a removal's tombstone can never land after a later
	 * pass's re-add already cleared it.
	 */
	reconcileEntryIdentities(
		declared: readonly DeclaredEntryIdentity[],
		events: readonly RemovedEntryEvent[]
	): Promise<void>;
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
 * The fingerprint of one entry's group args as this version persists it:
 * salted, over the frozen JSON rendering buildGroupArgs documents. The
 * unsalted-fingerprint migration recomputes stored records through this same
 * function, so the two can never drift. The engine compares stored records
 * against this rendering ONLY: records persisted by pre-salt versions are the
 * unsaltedSyncFingerprints migration's to recognize and rewrite (it runs
 * pre-registration, before the first pass seeds from the store), so a pass
 * that still meets one is inside a failed-migration window and the entry
 * degrades to the visible name-conflict classification below - carried, never
 * overwritten - until the next successful migration run heals it.
 */
export function groupArgsFingerprint(args: Record<string, string>): string {
	return fingerprint(JSON.stringify(args));
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
 * must not assert that anything changed. VS Code's group commands are
 * strictly additive: lm.addLanguageModelsProviderGroup rejects an existing
 * name, and the only other registered group command,
 * lm.migrateLanguageModelsProviderGroup, is add-shaped (it warms the provider
 * and calls the same add) - no update or removal command exists (pinned by
 * hostGroupCommand.test.ts).
 */
export const GROUP_UPDATE_UNAVAILABLE_MESSAGE =
	"A VS Code provider group already uses this name, and VS Code cannot update an existing group. If the group does not match this entry, delete its object from the models file (chatLanguageModels.json), reload the window, and run Sync Models Now.";

/**
 * The classified text for an entry whose stored secrets could not be read
 * this pass. The entry is skipped, not failed permanently: the next pass (or
 * Sync Models Now) reads again.
 */
export const SECRETS_READ_FAILED_MESSAGE =
	"Reading this entry's stored secrets failed, so it was not synced. Run Sync Models Now to retry.";

/**
 * The classified text for a pass skipped because the fingerprint salt could
 * not be confirmed durable (see ServerSyncEnv.confirmFingerprintsDurable).
 * Entries are skipped, not failed: the live groups keep serving, and the
 * next session (with the stored salt back) syncs normally.
 */
export const SALT_UNAVAILABLE_MESSAGE =
	"VS Code secret storage could not be confirmed this session, so this entry was not synced. Syncing resumes on the next VS Code session.";

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
	 * re-reads, with two presence-only exceptions: the duplicate-rejection
	 * path may take a fresh read as positive confirmation that another window
	 * already synced the same configuration (see syncPass), and a pass that
	 * leaves an entry unsynced preserves a store record the session map has
	 * never seen instead of dropping it at the pass-end write (see
	 * carryLastGood). In both, presence and matches are safe, absences prove
	 * nothing. The monkey fuzzer caught why anything more wedges entries: an
	 * awaited globalState.update can be reverted moments later by a stale
	 * value from the storage layer (the whole key came back as its previous
	 * version), and a pass that trusts that read re-adds its own group, takes
	 * the duplicate rejection as a foreign name conflict, and - with no
	 * last-known-good left to carry - keeps the error forever.
	 */
	private fingerprints: Record<string, string> | undefined;
	/**
	 * The session's identity ledger, the same seed-once design as
	 * `fingerprints` and for the same reason: the nightly monkey fuzzer caught
	 * removals losing their tombstones because the pass resolved the removed
	 * label's base URL from a fresh globalState read that had reverted to a
	 * pre-declare version - the label read as ledger-less, the event degraded
	 * to the untracked (no-tombstone) notice, and the removed group's models
	 * never left the host list (#220). Seeded from the store on the first
	 * pass, session truth from then on; each pass still takes one fresh store
	 * read, merged presence-only underneath, so store-only records (another
	 * window's writes) fill gaps but can never shadow a record this session
	 * holds. A stale store CAN re-surface a label this session already
	 * dropped, harmlessly: removal events key on the fingerprint session map,
	 * so a dropped label is never looked up again, and the pass-end rewrite
	 * prunes it from the next ledger.
	 */
	private ledger: Record<string, string> | undefined;
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

	/** The engine-side wrap of ServerSyncEnv.confirmFingerprintsDurable; the contract says it never throws, but a throw must read as "not confirmed", never abort the pass. */
	private async confirmSaltDurable(): Promise<boolean> {
		try {
			return await this.env.confirmFingerprintsDurable();
		} catch {
			return false;
		}
	}

	/**
	 * Carry the record for an entry this pass leaves unsynced: this window's
	 * last-known-good, or, when the session map has never seen the label, the
	 * store's record - presence-only, the same asymmetry the duplicate path's
	 * confirmation leans on (a stale read can only under-report, never invent,
	 * so a present record is some window's proof of the live group's content,
	 * while an absence proves nothing). Without the carry the pass-end
	 * whole-key write would destroy the only copy; for a legacy-form record
	 * that copy is the only proof the unsaltedSyncFingerprints migration can
	 * still rewrite. The caller supplies its own single store read, so no
	 * branch ever takes two reads that could disagree. The preserved record
	 * goes into the session map at once so a later entry's write-through
	 * cannot re-clobber it mid-pass, and into `next` so the pass-end write
	 * keeps it.
	 */
	private carryLastGood(
		label: string,
		previous: Readonly<Record<string, string>>,
		next: Record<string, string>,
		storeRecord: string | undefined
	): void {
		const lastGood = previous[label] ?? storeRecord;
		if (lastGood === undefined) {
			return;
		}
		next[label] = lastGood;
		this.fingerprints = { ...this.fingerprints, [label]: lastGood };
	}

	private async syncPass(force: boolean): Promise<void> {
		const rawSetting = this.env.readServersSetting();
		const { entries, problems } = parseServersSetting(rawSetting);
		for (const problem of problems) {
			this.env.log(`Servers setting: ${problem}`);
		}

		// Checked once per pass, at decision time rather than activation time:
		// a first-activation salt race in another window can invalidate the
		// session's salt after this engine was built, and everything below
		// that adds a group or records a fingerprint depends on the answer.
		const saltDurable = await this.confirmSaltDurable();

		// Seed once, then the in-memory map is the truth for every comparison
		// below; `previous` keeps pass-start snapshot semantics because the
		// write-through replaces this.fingerprints instead of mutating it.
		this.fingerprints ??= { ...this.env.getFingerprints() };
		const previous: Readonly<Record<string, string>> = this.fingerprints;
		const next: Record<string, string> = {};
		const views: DeclaredServerView[] = [];
		// Each entry's fingerprint as computed THIS pass; the pass-end ledger
		// compares it against `next` to tell in-sync entries (whose declared URL
		// provably describes the live group) from blocked or skipped ones.
		const printedByLabel = new Map<string, string>();
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
			const printed = groupArgsFingerprint(args);
			printedByLabel.set(entry.label, printed);
			const retryState = this.retry.get(entry.label);
			if (secretsUnreadable) {
				// Without the real secrets the fingerprint is not meaningful, so no
				// host call and no retry bookkeeping (the stored retry state stays
				// put on purpose); last-known-good carries.
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
			} else if (!saltDurable) {
				// The same skip for a different unreadable secret: fingerprints
				// computed under an unconfirmed salt cannot be recognized by any
				// later session, so no group may be added on their account (an
				// add-only host could never confirm it again) and no record may
				// change; last-known-good carries and the next session, keyed by
				// the stored salt, syncs normally.
				syncError = SALT_UNAVAILABLE_MESSAGE;
				syncErrorClass = "secretsUnreadable";
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
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
				syncErrorClass = "blocked";
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
			} else if (!(await this.confirmSaltDurable())) {
				// Re-confirmed immediately before the irreversible host call, not
				// just at pass start: a store mutation mid-pass must stop further
				// adds, because a group created now could only ever be proven by
				// a fingerprint no later session can recompute. Same skip as the
				// pass-level pause above.
				syncError = SALT_UNAVAILABLE_MESSAGE;
				syncErrorClass = "secretsUnreadable";
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
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
						// The session map first; failing that, ONE fresh store read,
						// used presence-only twice: as POSITIVE confirmation here, and
						// as the carry's preservation fallback on the not-confirmed
						// path below (the same read serves both, so the two can never
						// disagree). The servers setting is machine-scoped and
						// globalState is shared, so another window's engine may have
						// added this exact configuration and persisted its fingerprint
						// - a record this window's seed-once map predates. The
						// asymmetry is load-bearing: the stale-read failure mode the
						// in-memory map guards against can only UNDER-report (an older
						// map), never invent a matching fingerprint, so a match proves
						// the live group holds exactly these args while an absence
						// proves nothing.
						const storeRecord = this.env.getFingerprints()[entry.label];
						const confirmed = previous[entry.label] === printed || storeRecord === printed;
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
							this.carryLastGood(entry.label, previous, next, storeRecord);
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
						this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
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
		// Removal detection wants "the user removed the entry", not "this pass
		// could not accept it": a label any raw entry still carries (malformed
		// mid-edit, or a duplicate) is present, not removed, so no event may
		// fire for it - a tombstone written for a present entry would suppress
		// a group the user did not remove. Removal proof also needs the
		// CONTAINER to be currently valid, and only an array is: the setting
		// declares an array schema with a [] default, and the production read
		// falls back to that default, so a real "remove everything" arrives as
		// an empty array. An undefined, null, or otherwise non-array value is
		// a malformed or partial state (a mid-edit settings.json, a stale
		// read) that proves nothing about any label, so presence is unknowable
		// and everything reads as present: no removals, all records carried.
		// Detection still keys on the fingerprint map: a record is the
		// evidence a group was (probably) created for the label, so an entry
		// that never synced leaves no shell and raises no event.
		const settingParseable = Array.isArray(rawSetting);
		const rawLabels = settingParseable ? rawDeclaredLabels(rawSetting) : undefined;
		const labelStillPresent = (label: string) =>
			currentLabels.has(label) || rawLabels === undefined || rawLabels.has(label);
		const removed = Object.keys(previous).filter((label) => !labelStillPresent(label));
		// A present-but-rejected label also KEEPS its records: the pass-end
		// writes below rebuild both maps from the accepted entries, and without
		// this carry a mid-edit malformed entry would shed its fingerprint
		// (wedging the repaired entry on an unrecognizable duplicate) and its
		// ledger record (blinding a later real removal). Fingerprints carry with
		// carryLastGood's asymmetry - this window's session record first, else
		// ONE fresh store read presence-only, so another window's persisted
		// proof cannot be erased by this pass-end write. Reserved keys are
		// skipped: a corrupt store could hand one back, and assigning it would
		// ride into the prototype.
		const storeRecords = this.env.getFingerprints();
		// The session ledger is the truth for this pass (see the field's doc);
		// the fresh store read merges underneath it, presence-only.
		const storedLedger = this.env.getEntryBaseUrls();
		this.ledger ??= { ...storedLedger };
		const ledger: Readonly<Record<string, string>> = { ...storedLedger, ...this.ledger };
		const carriedLedger: Record<string, string> = {};
		for (const label of new Set([...Object.keys(previous), ...Object.keys(storeRecords)])) {
			if (currentLabels.has(label) || !labelStillPresent(label) || isUnsafeRecordKey(label)) {
				continue;
			}
			const carried = previous[label] ?? storeRecords[label];
			if (carried !== undefined && next[label] === undefined) {
				next[label] = carried;
			}
		}
		for (const [label, url] of Object.entries(ledger)) {
			if (!currentLabels.has(label) && labelStillPresent(label) && !isUnsafeRecordKey(label)) {
				carriedLedger[label] = url;
			}
		}
		// Per-label retry state is pruned with its entry; the map is keyed by
		// user-controlled labels and would otherwise grow without bound. Pruned
		// by PRESENCE (the same rule the record carries above use), never by
		// this pass's acceptance: a mid-edit entry or an unreadable container
		// must not erase an upsertFailed marker - its loss would read the
		// restored entry's carried fingerprint as in-sync and silently skip
		// the retry that failure still needs.
		for (const label of [...this.retry.keys()]) {
			if (!labelStillPresent(label)) {
				this.retry.delete(label);
			}
		}
		this.views = views;
		// In-memory before the persist: session truth must survive a failing
		// (or later-reverted) storage write. The persist itself is log-only:
		// the session map has already dropped a removed label, so a throw here
		// must not abort the reconciliation below - the removal's tombstone and
		// notice would be lost with no later pass able to rediscover them.
		this.fingerprints = next;
		try {
			await this.env.setFingerprints(next);
		} catch (error) {
			this.env.logError("Persisting the pass-end fingerprint map failed", error);
		}
		// The identity ledger is read before it is rewritten (above): the old
		// record is the only thing that still knows a removed label's base URL.
		const events: RemovedEntryEvent[] = removed.map((label) => {
			const baseUrl = ledger[label];
			if (baseUrl !== undefined) {
				// A label with no prior fingerprint record now declaring the removed
				// label's host reads as the rename's other half.
				const renamedTo = entries.find(
					(entry) => previous[entry.label] === undefined && normalizeBaseUrl(entry.baseUrl) === baseUrl
				);
				if (renamedTo !== undefined) {
					return { kind: "renamed", oldLabel: label, newLabel: renamedTo.label, baseUrl };
				}
			}
			return { kind: "removed", label, baseUrl };
		});
		try {
			// An entry is recorded under its declared URL only when this pass
			// proved the live group holds exactly that configuration (its
			// fingerprint landed in `next`). A blocked or skipped entry keeps its
			// previous record - under an add-only host the live group still has
			// the OLD connection - and with no previous record it gets NONE: an
			// unproven URL in the ledger would make a later removal tombstone a
			// group that does not exist while the real one keeps serving, with a
			// notice claiming otherwise. No record degrades that removal to the
			// honest untracked notice instead.
			const ledgerEntries = entries.flatMap((entry): [string, string][] => {
				const inSync =
					printedByLabel.get(entry.label) !== undefined && next[entry.label] === printedByLabel.get(entry.label);
				if (inSync) {
					return [[entry.label, normalizeBaseUrl(entry.baseUrl)]];
				}
				const previousUrl = ledger[entry.label];
				return previousUrl !== undefined ? [[entry.label, previousUrl]] : [];
			});
			const nextLedger = Object.fromEntries([...ledgerEntries, ...Object.entries(carriedLedger)]);
			// Session truth before the persist, like the fingerprint map: a
			// failing (or later-reverted) storage write must not cost a later
			// removal its tombstone.
			this.ledger = nextLedger;
			await this.env.setEntryBaseUrls(nextLedger);
		} catch (error) {
			// Log-only like the fingerprint persist: the session ledger already
			// holds the records, so only a NEXT session's removal degrades to the
			// untracked (no-tombstone) notice.
			this.env.logError("Persisting the entry identity ledger failed", error);
		}
		if (removed.length > 0) {
			// The setting entries are gone but the provider groups survive: there
			// is no programmatic group removal. Labels' SecretStorage blobs are
			// kept on purpose; re-adding a label picks its secrets up again.
			this.env.log("Servers setting entries removed; their provider groups remain", { labels: removed });
		}
		await this.env.reconcileEntryIdentities(
			entries.map((entry) => ({ label: entry.label, baseUrl: normalizeBaseUrl(entry.baseUrl) })),
			events
		);
	}
}
