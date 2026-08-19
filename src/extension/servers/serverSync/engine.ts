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
import type {
	ExpectedFailureCategory,
	NonSecretOptionalFields,
	SecretFieldId,
	SecretLocation,
} from "../../../shared/serverEntry";
import { OPTIONAL_ENTRY_FIELDS, pickNonSecretOptionalFields } from "../../../shared/serverEntry";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { fingerprint } from "../../../shared/util/fingerprint";
import { isUnsafeRecordKey } from "../../../shared/util/json";
import type { StoredServerSecrets } from "./secrets";
import { inlineSecretValues, secretLocations } from "./secrets";
import type { DeclaredServer, EntryModelCapabilities, EntryModelParameters } from "./setting";
import { acceptedEntry, parseServersSetting, stillDeclaredIn } from "./setting";

/**
 * Which failure class produced a view's syncError. "upsertFailed": the add
 * failed outright (non-duplicate), so no live group was created for the entry's
 * configuration. "blocked": a group with the name exists and the host refused
 * the duplicate. "secretsUnreadable": the pass skipped the entry, because its
 * stored secrets could not be read or the fingerprint salt could not be
 * confirmed durable (SALT_UNAVAILABLE_MESSAGE tells the two apart in the view).
 * The dashboard reads the distinction: a shared snapshot's models are
 * duplicated per claiming entry EXCEPT upsertFailed claimants, whose group is
 * the one the host provably does not have.
 */
type SyncErrorClass = "upsertFailed" | "blocked" | "secretsUnreadable";

/** The non-secret view of a declared server the dashboard renders; secret values stay out. */
export interface DeclaredServerView extends NonSecretOptionalFields {
	readonly label: string;
	readonly baseUrl: string;
	/**
	 * The entry's apiVersion override; the edit form's prefill. "" is a real
	 * value (append nothing to the base URL), distinct from absent (auto-detect).
	 */
	readonly apiVersion?: string | undefined;
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;
	/** The entry's custom HTTP headers (non-secret user configuration); the edit form's prefill. */
	readonly headers?: Readonly<Record<string, string>> | undefined;
	/** The entry's per-entry models.parameters record (non-secret user configuration); the edit form's prefill. */
	readonly modelParameters?: EntryModelParameters | undefined;
	/** The entry's per-entry models.capabilities record (non-secret user configuration); the edit form's prefill. */
	readonly modelCapabilities?: EntryModelCapabilities | undefined;
	/** The discovery-failure categories the entry expects; non-secret, like the records above. */
	readonly expectedFailures?: readonly ExpectedFailureCategory[] | undefined;
	/** The entry's discovery.declared model IDs; non-secret, like the records above. */
	readonly declaredModels?: readonly string[] | undefined;
	/** The entry's manual usage budget in USD (non-secret user configuration); the usage surfaces read it. */
	readonly budget?: number | undefined;
	/**
	 * The group client ID the entry's resolved configuration produces: the same
	 * identity the provider stamps on its status snapshots, so the dashboard can
	 * join a declared entry to exactly its live group even when several entries
	 * share a base URL. The embedded credential fingerprint is non-secret, but
	 * the ID stays extension-side and is never pushed into DashboardState.
	 * Absent when the entry does not resolve to a usable group configuration.
	 */
	readonly expectedClientId?: string | undefined;
	/**
	 * The label-agnostic connection identity: the client ID the same
	 * configuration produces without the entry label. Groups created before
	 * labels flowed into the configuration report under this identity, and
	 * entries that mirror one server with one credential set share it, so the
	 * join's shared-status pass can hand them all the same live snapshot. Same
	 * non-secret handling rules as expectedClientId.
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
 * One entry the pass found gone from the setting, classified. "renamed": a new
 * label (one with no prior fingerprint record) now declares the removed label's
 * base URL, so the old group is a rename leftover, not an explicit removal.
 * "removed" is everything else; its baseUrl comes from the persisted identity
 * ledger and is undefined for labels the ledger predates - their group identity
 * cannot be resolved, so the env must not tombstone them.
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
	 * when false the pass must neither add groups (an add-only host could never
	 * confirm them again) nor record fingerprints beyond carrying
	 * last-known-good. Must not throw; an unknowable state reads as false.
	 */
	confirmFingerprintsDurable(): Promise<boolean>;
	/**
	 * The persisted fingerprint map: read to seed the engine's in-memory session
	 * map (see ServerSyncEngine.fingerprints), and re-read per entry
	 * presence-only - as positive confirmation on the duplicate-rejection path,
	 * and as the preservation fallback when a pass leaves an entry unsynced (see
	 * carryLastGood).
	 */
	getFingerprints(): Readonly<Record<string, string>>;
	setFingerprints(map: Readonly<Record<string, string>>): Promise<void>;
	/**
	 * The persisted identity ledger: label -> normalized base URL for the entries
	 * earlier passes saw declared. It resolves which host a just-removed label's
	 * group pointed at, so it is what a removal's tombstone stands on. Like the
	 * fingerprints it is subject to stale storage reads, so the engine seeds a
	 * session copy from the first read and treats later reads as presence-only
	 * gap fillers (see ServerSyncEngine.ledger). Unlike the fingerprints it
	 * carries no credential material and no salt dependence, so writes go out
	 * unguarded.
	 */
	getEntryBaseUrls(): Readonly<Record<string, string>>;
	setEntryBaseUrls(map: Readonly<Record<string, string>>): Promise<void>;
	/**
	 * Pass-end identity reconciliation, called once per pass: the identities the
	 * setting currently declares, and the removal/rename events this pass
	 * detected. The env clears removal tombstones matching a declared identity (a
	 * re-declared group must never stay suppressed), records tombstones and
	 * provenance for the events, and raises the user-facing notice; deleting the
	 * group itself means editing the models file. Awaited by the pass, so
	 * reconciliations stay serialized with the passes that produced them: a
	 * removal's tombstone can never land after a later pass's re-add already
	 * cleared it.
	 */
	reconcileEntryIdentities(
		declared: readonly DeclaredEntryIdentity[],
		events: readonly RemovedEntryEvent[]
	): Promise<void>;
	log(message: string, data?: unknown): void;
	logError(message: string, error: unknown): void;
}

/**
 * The provider-group command arguments for one entry with its secrets resolved.
 * Fields ride in OPTIONAL_ENTRY_FIELDS order after name, vendor, baseUrl, and
 * label, and that order is frozen: the persisted sync fingerprint hashes
 * JSON.stringify of this object. `label` repeats the group name as a
 * configuration property because the host echoes only the configuration back to
 * the provider, never the name; it is what gives entries sharing a base URL and
 * credentials distinct group identities. The entry's headers, modelParameters,
 * modelCapabilities, expectedFailures, declaredModels, and budget deliberately
 * stay out: they are read extension-side, so editing them must not change the
 * fingerprint or churn the group. The parser flattens the nested settings shape
 * onto these fields, so stored fingerprints stay stable across the entry
 * restructure (serverSync.test.ts pins the stability).
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
 * salted, over the frozen JSON rendering buildGroupArgs documents. The engine
 * compares stored records against this rendering ONLY: an entry whose record
 * matches nothing degrades to the name-conflict classification below - carried,
 * never overwritten - until the entry is reverted, renamed, or removed.
 */
function groupArgsFingerprint(args: Record<string, string>): string {
	return fingerprint(JSON.stringify(args));
}

/**
 * The classified upsert-failure text. The host's raw error message is never
 * stored, displayed, or logged: the command was called with fully resolved
 * secrets, and the log buffer feeds public issue reports.
 */
export const GROUP_UPSERT_FAILED_MESSAGE = "The host rejected the provider group upsert";

/**
 * The actionable text for an entry the host refused to sync because a provider
 * group already holds its name. That covers an entry whose configuration
 * changed after its group was created AND a brand-new entry under a name the
 * host already uses, so the text must not assert that anything changed. VS
 * Code's group commands are strictly additive and no update or removal command
 * exists (pinned by hostGroupCommand.test.ts).
 */
export const GROUP_UPDATE_UNAVAILABLE_MESSAGE =
	"A VS Code provider group already uses this name, and VS Code cannot update an existing group. If the group does not match this entry, delete its object from the models file (chatLanguageModels.json), reload the window, and run Sync Models Now.";

/**
 * The classified text for an entry whose stored secrets could not be read this
 * pass. The entry is skipped, not failed permanently: the next pass (or Sync
 * Models Now) reads again.
 */
export const SECRETS_READ_FAILED_MESSAGE =
	"Reading this entry's stored secrets failed, so it was not synced. Run Sync Models Now to retry.";

/**
 * The classified text for a pass skipped because the fingerprint salt could not
 * be confirmed durable (see ServerSyncEnv.confirmFingerprintsDurable). Entries
 * are skipped, not failed: the live groups keep serving, and the next session
 * (with the stored salt back) syncs normally.
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
 * it concerned; the two kinds are mutually exclusive per label.
 *
 * "blocked": the host refused the add as a duplicate while the entry had
 * changed. There is nothing a retry with the same configuration can do (no
 * update API), so unforced passes skip the host call and keep the actionable
 * error instead of hammering; a forced pass (activation, Sync Models Now)
 * retries anyway, because the user may have removed the stale group natively.
 *
 * "upsertFailed": the add failed for a non-duplicate reason. The persisted
 * fingerprint map records last-known-good only, so this is the separate retry
 * signal: an unforced pass re-calls the host while the entry still holds the
 * failed configuration, whereas a revert to last-known-good is in sync without
 * a call.
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
	private disposed = false;
	/** Listeners on completed sync passes; see onDidSync. */
	private readonly syncListeners = new Set<() => void>();

	constructor(
		private readonly env: ServerSyncEnv,
		private readonly debounceMs = 400
	) {}

	/**
	 * Subscribe to the end of every sync pass, successful or failed. Listeners
	 * run isolated: one throwing is logged and cannot starve the others.
	 */
	onDidSync(listener: () => void): { dispose(): void } {
		this.syncListeners.add(listener);
		return { dispose: () => this.syncListeners.delete(listener) };
	}

	/** The declared servers as of the last sync pass, for the dashboard state. */
	getDeclared(): readonly DeclaredServerView[] {
		return this.views;
	}

	/**
	 * One declared entry's provider-group configuration, resolved exactly as a
	 * sync pass would submit it: the same setting parse, the same secrets read,
	 * the same buildGroupArgs rendering. The returned record carries the entry's
	 * resolved secrets verbatim - like buildGroupArgs's output, it must never be
	 * logged and never ride a state push. The group serving path is otherwise
	 * host-invoked only, so the litellm._test.refreshEntryModels command resolves
	 * through this to drive the provider's group path for a declared entry
	 * directly. Undefined when no accepted entry carries the label.
	 */
	async resolveGroupArgs(label: string): Promise<Record<string, string> | undefined> {
		const match = acceptedEntry(this.env.readServersSetting(), label);
		if (match === undefined) {
			return undefined;
		}
		return buildGroupArgs(match.entry, await this.env.readSecrets(match.entry.label));
	}

	requestSync(): void {
		if (this.disposed) {
			return;
		}
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.syncNow();
		}, this.debounceMs);
	}

	async syncNow(force = false): Promise<void> {
		// Checked here, not only at scheduling: the queued follow-up relaunch
		// below routes through syncNow, and this guard is what stops it from
		// starting a pass after disposal.
		if (this.disposed) {
			return;
		}
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
		this.disposed = true;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		// A queued follow-up will never run; its waiters must still settle
		// (the poller's dispose contract, mirrored). The in-flight pass is left
		// to finish: its host call cannot be recalled anyway, and its finally
		// finds the queue already empty.
		this.queued?.resolve();
		this.queued = undefined;
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
		for (const listener of this.syncListeners) {
			try {
				listener();
			} catch (error) {
				this.env.logError("Server sync listener failed", error);
			}
		}
	}

	/**
	 * The engine-side wrap of ServerSyncEnv.confirmFingerprintsDurable: a throw
	 * must read as "not confirmed", never abort the pass.
	 */
	private async confirmSaltDurable(): Promise<boolean> {
		try {
			return await this.env.confirmFingerprintsDurable();
		} catch {
			return false;
		}
	}

	/**
	 * Whether the entry still resolves to exactly the group args this pass is
	 * about to add: one fresh setting read and one fresh secrets read, compared
	 * by fingerprint. Anything else - the entry gone or edited, the secrets
	 * rotated, a read failing - reads as "not current" and the add is skipped,
	 * fail closed (the pass that follows the change reads truth).
	 */
	private async entryStillCurrent(label: string, printed: string): Promise<boolean> {
		try {
			const fresh = acceptedEntry(this.env.readServersSetting(), label);
			if (fresh === undefined) {
				return false;
			}
			const stored = await this.env.readSecrets(fresh.entry.label);
			return groupArgsFingerprint(buildGroupArgs(fresh.entry, stored)) === printed;
		} catch {
			return false;
		}
	}

	/**
	 * Carry the record for an entry this pass leaves unsynced: this window's
	 * last-known-good, or, when the session map has never seen the label, the
	 * store's record - presence-only, since a stale read can only under-report,
	 * never invent. Without the carry the pass-end whole-key write would destroy
	 * the only copy. The caller supplies its own single store read, so no branch
	 * takes two reads that could disagree. The preserved record goes into the
	 * session map at once (a later entry's write-through would otherwise
	 * re-clobber it mid-pass) and into `next`, so the pass-end write keeps it.
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

		// Checked once per pass, at decision time rather than activation time: a
		// first-activation salt race in another window can invalidate the
		// session's salt after this engine was built.
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
			// below decides it, and only this iteration's view reads it. What
			// survives between passes is the retry state, which the message is
			// recomputed from.
			let syncError: string | undefined;
			let syncErrorClass: SyncErrorClass | undefined;
			try {
				stored = await this.env.readSecrets(entry.label);
			} catch (error) {
				// A failed secret read must not abort the pass: later entries still
				// need their sync, and an earlier successful add must still reach
				// the fingerprint persist below (losing it would misread that
				// group's next duplicate response as a name conflict). The view
				// renders the classified error and degrades the secret locations to
				// the inline-only reading.
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
				// later session, so no group may be added on their account and no
				// record may change; last-known-good carries and the next session,
				// keyed by the stored salt, syncs normally.
				syncError = SALT_UNAVAILABLE_MESSAGE;
				syncErrorClass = "secretsUnreadable";
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
			} else if (
				!force &&
				previous[entry.label] === printed &&
				!(retryState?.kind === "upsertFailed" && retryState.fingerprint === printed)
			) {
				next[entry.label] = printed;
				// An entry stuck on the duplicate error that matches its
				// last-known-good fingerprint again was reverted: the live group
				// already holds this exact content, so the error clears silently. A
				// pending retry recorded for some OTHER configuration is moot for the
				// same reason; only a failure for this very fingerprint (the guard
				// above) sends the entry back to the host.
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
				// adds, because a group created now could only be proven by a
				// fingerprint no later session can recompute.
				syncError = SALT_UNAVAILABLE_MESSAGE;
				syncErrorClass = "secretsUnreadable";
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
			} else if (!(await this.entryStillCurrent(entry.label, printed))) {
				// Re-read immediately before the irreversible add, for the same
				// reason: the setting was read once at pass start and the secrets
				// just above, so an edit landing in either window would pair a
				// stale entry with fresh secrets (or the reverse) - and an add-only
				// host makes that pairing permanent. Skipped silently: whatever
				// changed the setting or the secrets triggers its own follow-up
				// pass, which reads truth.
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
				this.env.log("Server entry changed mid-pass; group add skipped", { label: entry.label });
			} else {
				try {
					await this.env.addProviderGroup(args);
					next[entry.label] = printed;
					this.retry.delete(entry.label);
					// Write-through: in-memory first, because that record is what keeps
					// the group's next duplicate response reading as in-sync and it
					// must survive any storage misbehavior; the persist for the next
					// session is log-only for the same reason.
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
						// The session map first; failing that, ONE fresh store read, used
						// presence-only twice: as POSITIVE confirmation here, and as the
						// carry's preservation fallback below (the same read serves both,
						// so the two can never disagree). The servers setting is
						// machine-scoped and globalState is shared, so another window's
						// engine may have added this exact configuration and persisted its
						// fingerprint - a record this window's seed-once map predates. The
						// asymmetry is load-bearing: a stale read can only UNDER-report,
						// never invent a matching fingerprint, so a match proves the live
						// group holds exactly these args while an absence proves nothing.
						const storeRecord = this.env.getFingerprints()[entry.label];
						const confirmed = previous[entry.label] === printed || storeRecord === printed;
						if (confirmed) {
							// Under an add-only host, "the group already exists" for a
							// confirmed configuration IS the synced steady state: every
							// activation's forced pass lands here for every healthy entry.
							// Not logged for that reason.
							next[entry.label] = printed;
							// Into the session map at once, like a successful add: a LATER
							// entry's write-through persists a spread of this map, and
							// without the confirmed label it would re-clobber the other
							// window's record mid-pass.
							this.fingerprints = { ...this.fingerprints, [entry.label]: printed };
							this.retry.delete(entry.label);
						} else {
							// The entry changed (or is new under a taken name) but the host
							// cannot update or replace an existing group. The
							// last-known-good fingerprint is carried forward: under an
							// add-only host it still describes the live group's content, so
							// reverting the entry lands back on the in-sync branch as a
							// silent no-op instead of wedging on this error forever. The
							// refused fingerprint goes into the retry state as "blocked"
							// (not the map) so unforced passes keep the error without
							// hammering and a forced pass retries after the user removes the
							// stale group natively.
							this.carryLastGood(entry.label, previous, next, storeRecord);
							this.retry.set(entry.label, { kind: "blocked", fingerprint: printed });
							syncError = GROUP_UPDATE_UNAVAILABLE_MESSAGE;
							syncErrorClass = "blocked";
							this.env.log("Provider group exists and the host has no update path", { label: entry.label });
						}
					} else {
						// The persisted map keeps the last-known-good fingerprint (a failed
						// add changed nothing about the live group) and the retry rides
						// the "upsertFailed" state instead: dropping the fingerprint here
						// would destroy the only record that lets the healthy group's next
						// duplicate response read as in-sync. Any duplicate-refusal
						// knowledge is stale now, so setting the state also clears a stale
						// "blocked" - otherwise its shortcut would suppress the retry this
						// failure needs. The raw error stays out of the view and the log:
						// the command carried resolved secrets, and a host that echoes its
						// arguments would leak them into public issue reports.
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
				...(entry.apiVersion !== undefined ? { apiVersion: entry.apiVersion } : {}),
				...(entry.headers !== undefined ? { headers: entry.headers } : {}),
				...(entry.modelParameters !== undefined ? { modelParameters: entry.modelParameters } : {}),
				...(entry.modelCapabilities !== undefined ? { modelCapabilities: entry.modelCapabilities } : {}),
				...(entry.expectedFailures !== undefined ? { expectedFailures: entry.expectedFailures } : {}),
				...(entry.declaredModels !== undefined ? { declaredModels: entry.declaredModels } : {}),
				...(entry.budget !== undefined ? { budget: entry.budget } : {}),
				secrets: secretLocations(entry, stored),
				expectedClientId,
				expectedConnectionId,
				syncError,
				syncErrorClass,
			});
		}

		try {
			await this.finishPass(rawSetting, entries, previous, next, printedByLabel);
		} finally {
			// Views publish last, after the pass-end reconciliation: a caller that
			// observed an entry's view disappear can rely on the removal's tombstone
			// already suppressing the group, not merely being scheduled. In a
			// finally because a throwing finish must not discard the pass's computed
			// views.
			this.views = views;
		}
	}

	/**
	 * Everything a pass settles after the per-entry loop: removal detection,
	 * record carries, retry pruning, the fingerprint and ledger persists, and
	 * the identity reconciliation. syncPass publishes the views in a finally
	 * around this call.
	 */
	private async finishPass(
		rawSetting: unknown,
		entries: readonly DeclaredServer[],
		previous: Readonly<Record<string, string>>,
		next: Record<string, string>,
		printedByLabel: ReadonlyMap<string, string>
	): Promise<void> {
		const currentLabels = new Set(entries.map((entry) => entry.label));
		// Removal detection uses the shared still-declared predicate: presence,
		// not this pass's acceptance (see stillDeclaredIn) - a tombstone written
		// for a present entry would suppress a group the user did not remove.
		// Detection still keys on the fingerprint map: a record is the evidence a
		// group was (probably) created for the label, so an entry that never
		// synced leaves no shell and raises no event.
		const labelStillPresent = stillDeclaredIn(rawSetting);
		const removed = Object.keys(previous).filter((label) => !labelStillPresent(label));
		// A present-but-rejected label also KEEPS its records: the pass-end writes
		// below rebuild both maps from the accepted entries, and without this
		// carry a mid-edit malformed entry would shed its fingerprint (wedging the
		// repaired entry on an unrecognizable duplicate) and its ledger record
		// (blinding a later real removal). Fingerprints carry with carryLastGood's
		// asymmetry. Reserved keys are skipped: a corrupt store could hand one
		// back, and assigning it would ride into the prototype.
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
		// user-controlled labels and would otherwise grow without bound. Pruned by
		// PRESENCE, never by this pass's acceptance: a mid-edit entry or an
		// unreadable container must not erase an upsertFailed marker - its loss
		// would read the restored entry's carried fingerprint as in-sync and
		// silently skip the retry that failure still needs.
		for (const label of [...this.retry.keys()]) {
			if (!labelStillPresent(label)) {
				this.retry.delete(label);
			}
		}
		// In-memory before the persist: session truth must survive a failing (or
		// later-reverted) storage write. The persist itself is log-only, because a
		// throw here must not abort the reconciliation below - the removal's
		// tombstone and notice would be lost with no later pass able to rediscover
		// them.
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
			// An entry is recorded under its declared URL only when this pass proved
			// the live group holds exactly that configuration (its fingerprint
			// landed in `next`). A blocked or skipped entry keeps its previous
			// record - under an add-only host the live group still has the OLD
			// connection - and with no previous record it gets NONE: an unproven URL
			// would make a later removal tombstone a group that does not exist while
			// the real one keeps serving. No record degrades that removal to the
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
			// Log-only like the fingerprint persist: the session ledger already holds
			// the records, so only a NEXT session's removal degrades to the
			// untracked (no-tombstone) notice.
			this.env.logError("Persisting the entry identity ledger failed", error);
		}
		if (removed.length > 0) {
			// The setting entries are gone but the provider groups survive: there is
			// no programmatic group removal. Labels' SecretStorage blobs are kept on
			// purpose; re-adding a label picks its secrets up again.
			this.env.log("Servers setting entries removed; their provider groups remain", { labels: removed });
		}
		await this.env.reconcileEntryIdentities(
			entries.map((entry) => ({ label: entry.label, baseUrl: normalizeBaseUrl(entry.baseUrl) })),
			events
		);
	}
}
