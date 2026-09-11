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
	EntryViewFields,
	NonSecretOptionalFields,
	SecretFieldId,
	SecretLocation,
} from "../../../shared/serverEntry";
import { OPTIONAL_ENTRY_FIELDS, pickEntryViewFields, pickNonSecretOptionalFields } from "../../../shared/serverEntry";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { errorLabel } from "../../../shared/util/errorLabel";
import { fingerprint } from "../../../shared/util/fingerprint";
import type { StoredSecretsRecord, StoredServerSecrets } from "./secrets";
import { inlineSecretValues, resolveOwnedSecrets, secretLocations } from "./secrets";
import type { DeclaredServer } from "./setting";
import { acceptedEntry, parseServersSetting, rawDeclaredLabels, stillDeclaredIn } from "./setting";

/**
 * Consumers key on the class alone, never on message text.
 * "upsertFailed" means the add failed outright, so the host provably has no group for this entry.
 * "blocked" means a group with the name exists and the host refused the duplicate.
 * "secretsUnreadable" means the blob read failed, so the view's secret locations are a guess.
 * "secretsMismatched" means the read succeeded but a value's ownership stamp refused the pairing.
 * "saltUnavailable" means the read succeeded and only the unconfirmed salt stopped the pass.
 * The dashboard duplicates a shared snapshot's models per claiming entry, EXCEPT for upsertFailed.
 * The dashboard marks a view's locations unproven only for "secretsUnreadable".
 */
type SyncErrorClass = "upsertFailed" | "blocked" | "secretsUnreadable" | "secretsMismatched" | "saltUnavailable";

/**
 * One entry's sync failure: the class and its classified user-facing message,
 * one value so a class without a message (or the reverse) is unrepresentable.
 * Constructed only by syncFailureOf, which derives the message from the class,
 * so a mispaired class/message cannot be built either.
 */
export interface SyncFailure {
	readonly class: SyncErrorClass;
	readonly message: string;
}

/** The non-secret view of a declared server the dashboard renders; secret values stay out. */
export interface DeclaredServerView extends NonSecretOptionalFields, EntryViewFields {
	readonly label: string;
	readonly baseUrl: string;
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;
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
	/** The label's last sync failure, cleared by the next success. */
	readonly syncFailure?: SyncFailure | undefined;
}

/** One identity the setting currently declares: the entry label and its normalized base URL. */
export interface DeclaredEntryIdentity {
	readonly label: string;
	readonly baseUrl: string;
}

/**
 * "renamed" means a label NEW this pass now declares the removed label's base URL.
 * The old group is then a rename leftover, not an explicit removal.
 * New means absent from the last valid pass's declaration.
 * Without a baseline on the first pass, new means no fingerprint and no session-ledger record.
 * "removed" is everything else.
 * Its baseUrl comes from the persisted identity ledger.
 * Failing that, it comes from the one base URL the host serves the label's group at.
 * It is undefined when neither resolves it, because the env must never tombstone a guess.
 */
export type RemovedEntryEvent =
	| { readonly kind: "removed"; readonly label: string; readonly baseUrl: string | undefined }
	| { readonly kind: "renamed"; readonly oldLabel: string; readonly newLabel: string; readonly baseUrl: string };

/** Everything the engine touches, injected; createServerSyncEnv builds the real one. */
export interface ServerSyncEnv {
	/** The effective litellm-vscode-chat.servers value: what the settings side declares. */
	readServersSetting(): unknown;
	readSecrets(label: string): Promise<StoredSecretsRecord>;
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
	 * carryLastGood). Implementations validate at the read boundary: a returned
	 * map never carries a reserved (prototype-mutating) key or a non-string
	 * value, so the engine can assign its labels into plain records unguarded.
	 */
	getFingerprints(): Readonly<Record<string, string>>;
	setFingerprints(map: Readonly<Record<string, string>>): Promise<void>;
	/**
	 * The ledger maps each label earlier passes saw declared to its normalized base URL.
	 * It says which host a just-removed label's group pointed at.
	 * A removal's tombstone stands on it.
	 * Stale storage reads affect it like the fingerprints, so the `ledger` field seeds once from it.
	 * Later reads are presence-only gap fillers.
	 * Reads carry the same boundary validation: no reserved keys, no non-string values.
	 * Unlike the fingerprints it carries no credential material and no salt dependence.
	 * Its writes therefore go out unguarded.
	 */
	getEntryBaseUrls(): Readonly<Record<string, string>>;
	setEntryBaseUrls(map: Readonly<Record<string, string>>): Promise<void>;
	/**
	 * This callback returns the normalized base URLs of LABELED groups the host serves under `label`.
	 * The source is the provider's status window, which holds the current and previous sweeps.
	 * The observation is the second source of a label's group identity, behind the ledger.
	 * An entry that never synced, because it was blocked or predates the ledger, may lack a record.
	 * The host still hands its group to the provider on every refresh, so the observation is evidence.
	 * A natively deleted group leaves the window within a sweep.
	 * The callback must not throw.
	 * The wiring re-runs a sync pass when a labeled group enters the window, so late evidence counts.
	 */
	observedGroupBaseUrls(label: string): readonly string[];
	/**
	 * The pass calls this identity reconciliation once, at its end.
	 * The env clears removal tombstones matching a declared identity.
	 * A re-declared group must never stay suppressed.
	 * The env records tombstones and provenance for the events and raises the notice.
	 * Deleting the group itself means editing the models file, since the host has no removal command.
	 * The pass awaits it so reconciliations stay serialized with the passes that produced them.
	 * A removal's tombstone can then never land after a later pass's re-add cleared it.
	 */
	reconcileEntryIdentities(
		declared: readonly DeclaredEntryIdentity[],
		events: readonly RemovedEntryEvent[]
	): Promise<void>;
	log(message: string, data?: unknown): void;
	logError(message: string, error: unknown): void;
}

/**
 * The fingerprint and fingerprintProjection migration both render it, so the field order is frozen.
 * The parser flattens the nested settings shape onto these fields, so old fingerprints stay stable.
 * serverSyncEntryShape.test.ts pins that stability across the entry restructure.
 * `label` repeats the group name because the host echoes only the configuration, never the name.
 * That repeat is what keeps entries sharing a URL and credentials distinct.
 * Headers, model records, expectedFailures, declaredModels, budget, and mcp stay out of the args.
 * The extension reads those itself, so editing them must not churn the group.
 * entryCredentials.ts overlays current credentials at serve and request time, so no edit churns.
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
 * This projection derives from buildGroupArgs's output, never from the entry, so it cannot drift.
 * baseUrl rides verbatim as the args carry it, so a base URL text edit still reads as a new group.
 * Credential fields stay out because the host is add-only and never sees a credential change.
 * The serve-time overlay in entryCredentials.ts applies the entry's current secrets instead.
 * A rotation must read as in-sync, not as a doomed re-add.
 * The fuzz oracle imports it to compare identities through this exact projection.
 * The oracle cannot call the salted fingerprint, because the real extension owns the process salt.
 */
export function groupIdentityArgs(args: Record<string, string>): Record<string, string> {
	const { name, vendor, baseUrl, label } = args;
	const identity: Record<string, string> = {};
	for (const [key, value] of Object.entries({ name, vendor, baseUrl, label })) {
		if (value !== undefined) {
			identity[key] = value;
		}
	}
	return identity;
}

/**
 * Without the "i1:" prefix this rendering and the legacy full-args one would both be opaque hex.
 * The fingerprintProjection migration and the fuzz oracle rely on that prefix to tell them apart.
 * Older extension versions compare records only by equality, so the prefix is downgrade-safe.
 * The engine compares stored records against this rendering ONLY.
 * The migration rewrites legacy records, and nothing here accepts them.
 * An entry whose record matches nothing degrades to the blocked classification.
 * It stays carried, never overwritten, until the user reverts, renames, or removes the entry.
 * The legacy rendering itself lives only in the migration.
 */
export function groupArgsFingerprint(args: Record<string, string>): string {
	return `i1:${fingerprint(JSON.stringify(groupIdentityArgs(args)))}`;
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
	"A VS Code provider group already uses this name, and VS Code cannot update an existing group. " +
	"If the group does not match this entry, delete it in Manage Language Models (or remove its object from the models file, chatLanguageModels.json, and reload the window), " +
	"then run Sync Models Now.";

/**
 * The classified text for an entry whose stored secrets could not be read this
 * pass. The entry is skipped, not failed permanently: the next pass (or Sync
 * Models Now) reads again.
 */
export const SECRETS_READ_FAILED_MESSAGE =
	"Reading this entry's stored secrets failed, so it was not synced. Run Sync Models Now to retry.";

/**
 * The classified text for an entry whose stored secret is stamped for a
 * different destination (see resolveOwnedSecrets). The entry is skipped, not
 * synced without the credential: the host is add-only, so a credential-less
 * group created now would be permanent. Re-pairing is deliberate: the user
 * re-enters or removes the stored value.
 */
export const SECRET_OWNERSHIP_MISMATCH_MESSAGE =
	"A stored secret for this entry was saved for a different server address, so the entry was not synced. Set the secret again (edit the server in the dashboard, or run LiteLLM: Set Server Secret), or remove the stored value.";

/**
 * The classified text for a pass skipped because the fingerprint salt could not
 * be confirmed durable (see ServerSyncEnv.confirmFingerprintsDurable). Entries
 * are skipped, not failed: the live groups keep serving, and the next session
 * (with the stored salt back) syncs normally.
 */
export const SALT_UNAVAILABLE_MESSAGE =
	"VS Code secret storage could not be confirmed this session, so this entry was not synced. Syncing resumes on the next VS Code session.";

/**
 * The one SyncFailure constructor: the message derives from the class, so the
 * pairing is right by construction at every producer site. The total Record
 * makes a new class a compile error until it names its message.
 */
function syncFailureOf(failureClass: SyncErrorClass): SyncFailure {
	const messages: Readonly<Record<SyncErrorClass, string>> = {
		upsertFailed: GROUP_UPSERT_FAILED_MESSAGE,
		blocked: GROUP_UPDATE_UNAVAILABLE_MESSAGE,
		secretsUnreadable: SECRETS_READ_FAILED_MESSAGE,
		secretsMismatched: SECRET_OWNERSHIP_MISMATCH_MESSAGE,
		saltUnavailable: SALT_UNAVAILABLE_MESSAGE,
	};
	return { class: failureClass, message: messages[failureClass] };
}

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
 * This records why a label's last add did not land, keyed to the fingerprint it concerned.
 * "blocked" means the host refused the add as a duplicate while the entry had changed.
 * The host has no update API, so no retry with the same configuration can help.
 * Unforced passes therefore skip the host call and keep the actionable error instead of hammering.
 * A forced pass retries anyway, since the user may have removed the stale group natively.
 * "upsertFailed" means the add failed for a non-duplicate reason.
 * The persisted fingerprint map holds last-known-good only, so this is the separate retry signal.
 * An unforced pass re-calls the host while the entry still holds the failed configuration.
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
	 * The first pass seeds this map from the store, and it is session truth from then on.
	 * Decisions never trust store re-reads, with two presence-only exceptions.
	 * syncPass takes a fresh read as proof that another window synced the same configuration.
	 * carryLastGood keeps a store record this map has never seen for an unsynced entry.
	 * Presence and matches are safe, but absences prove nothing.
	 * The monkey fuzzer caught a stale value reverting an awaited globalState.update moments later.
	 * A pass trusting that read re-adds its own group.
	 * It then misreads the duplicate rejection as a foreign name conflict and keeps the error forever.
	 */
	private fingerprints: Record<string, string> | undefined;
	/**
	 * This ledger seeds once like `fingerprints`, for the same reason.
	 * The nightly monkey fuzzer caught removals losing their tombstones (#220).
	 * A fresh read had reverted to a pre-declare version, so the removed label read as ledger-less.
	 * Each pass still takes one fresh store read, merged presence-only underneath the session copy.
	 * Another window's records therefore fill gaps but never shadow a record this session holds.
	 * A stale store CAN re-surface a label this session already dropped, harmlessly.
	 * Removal candidates key on the fingerprint map and THIS ledger, never the merged read.
	 * The pass-end rewrite prunes the label, and only unresolvedRemovals revisits a dropped label.
	 */
	private ledger: Record<string, string> | undefined;
	/** Per-label retry state that must survive between passes; see RetryState. */
	private retry = new Map<string, RetryState>();
	/**
	 * This map holds removed labels no pass could resolve yet, with the labels NEW at detection.
	 * The usual case is a cold-start removal detected before the host reported any group.
	 * The event fired once, untracked, so the engine carries the label for a later pass to resolve.
	 * Classification uses the detecting pass's declaration delta, never a later one.
	 * An entry added or re-pointed later thus cannot turn the removal into a rename or the reverse.
	 * The pass-end write carries the label's fingerprint record too, as the only durable evidence.
	 * A dead server's probe takes the full discovery timeout, so a session can end before the report.
	 * Without the carried record the next session would have no candidate and probe the group forever.
	 */
	private readonly unresolvedRemovals = new Map<string, ReadonlyMap<string, string>>();
	/**
	 * Every label the setting declared (accepted or not) at the end of the last
	 * pass with a valid container: the baseline the rename delta is taken
	 * against. A label absent from it is NEW this pass; a pre-existing entry
	 * that never synced or was never observed (blocked, unreadable secrets) is
	 * not, however few records it has. Undefined until the first valid pass,
	 * where the delta falls back to record absence.
	 */
	private declaredLabelsLastPass: ReadonlySet<string> | undefined;
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
	 * The returned record carries resolved secrets verbatim.
	 * Like buildGroupArgs's output, it must never reach a log or a state push.
	 * The group serving path is otherwise host-invoked only.
	 * The litellm._test.refreshEntryModels command resolves through this to drive that path.
	 * A refused stored field stays out because this path serves only the internal test command.
	 * That command must never send a credential the engine itself would refuse.
	 * The provider's credential overlay resolves through entryCredentials.ts instead.
	 * That overlay also matches the base URL and fails closed on any refusal.
	 */
	async resolveGroupArgs(label: string): Promise<Record<string, string> | undefined> {
		const match = acceptedEntry(this.env.readServersSetting(), label);
		if (match === undefined) {
			return undefined;
		}
		const record = await this.env.readSecrets(match.entry.label);
		return buildGroupArgs(match.entry, resolveOwnedSecrets(match.entry, record).values);
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
	 * This check fails closed before the irreversible add.
	 * An entry gone or renamed, a re-pointed base URL, or a refused pairing reads as "not current".
	 * A failed read does too, and the pass then skips the add.
	 * The pass that follows the change reads truth.
	 * A mid-pass credential EDIT no longer blocks the add.
	 * The identity fingerprint does not cover credentials.
	 * The baked values are only a serve-time-overridden fallback.
	 * Pairing pass-start secrets with a freshly edited entry is harmless where it was once permanent.
	 */
	private async entryStillCurrent(label: string, printed: string): Promise<boolean> {
		try {
			const fresh = acceptedEntry(this.env.readServersSetting(), label);
			if (fresh === undefined) {
				return false;
			}
			const owned = resolveOwnedSecrets(fresh.entry, await this.env.readSecrets(fresh.entry.label));
			if (owned.refused.length > 0) {
				return false;
			}
			return groupArgsFingerprint(buildGroupArgs(fresh.entry, owned.values)) === printed;
		} catch {
			return false;
		}
	}

	/**
	 * The one base URL the host is serving `label`'s group at, when the
	 * observation is unambiguous; see ServerSyncEnv.observedGroupBaseUrls. A
	 * throwing env reads as no observation.
	 */
	private soleObservedBaseUrl(label: string): string | undefined {
		try {
			const urls = new Set(this.env.observedGroupBaseUrls(label).map(normalizeBaseUrl));
			return urls.size === 1 ? [...urls][0] : undefined;
		} catch {
			return undefined;
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
			let refusedFields: readonly SecretFieldId[] = [];
			let secretsUnreadable = false;
			// The entry's user-facing failure for THIS pass: exactly one branch
			// below decides it, and only this iteration's view reads it. What
			// survives between passes is the retry state, which the failure is
			// recomputed from.
			let syncFailure: SyncFailure | undefined;
			try {
				// The ownership check runs at the read boundary, before any branch
				// (a forced pass included): a stored value stamped for a different
				// destination must never enter the args this pass could submit.
				const owned = resolveOwnedSecrets(entry, await this.env.readSecrets(entry.label));
				stored = owned.values;
				refusedFields = owned.refused;
			} catch (error) {
				// A failed secret read must not abort the pass: later entries still
				// need their sync, and an earlier successful add must still reach
				// the fingerprint persist below (losing it would misread that
				// group's next duplicate response as a name conflict). The view
				// renders the classified error and degrades the secret locations to
				// the inline-only reading.
				secretsUnreadable = true;
				syncFailure = syncFailureOf("secretsUnreadable");
				this.env.log("Reading a server entry's stored secrets failed", {
					label: entry.label,
					error: errorLabel(error),
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
			} else if (refusedFields.length > 0) {
				// The ownership check refused a stored value this entry would have
				// used: the pairing must not reach the host at all. Proceeding
				// without the credential would create a permanent credential-less
				// group (the host is add-only), so the entry skips like an
				// unreadable blob, with the actionable message instead. Checked on
				// forced passes too - an activation force-sync is exactly where a
				// delete-failure residual would otherwise pair a surviving blob
				// with a re-declared label at another host.
				syncFailure = syncFailureOf("secretsMismatched");
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
				this.env.log("A stored secret is stamped for a different destination; entry not synced", {
					label: entry.label,
					fields: refusedFields,
				});
			} else if (!saltDurable) {
				// The same skip for a different unusable secret: fingerprints
				// computed under an unconfirmed salt cannot be recognized by any
				// later session, so no group may be added on their account and no
				// record may change; last-known-good carries and the next session,
				// keyed by the stored salt, syncs normally.
				syncFailure = syncFailureOf("saltUnavailable");
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
			} else if (
				!force &&
				previous[entry.label] === printed &&
				!(retryState?.kind === "upsertFailed" && retryState.fingerprint === printed)
			) {
				next[entry.label] = printed;
				// An entry stuck on the duplicate error that matches its
				// last-known-good fingerprint again was reverted: the live group
				// already holds this exact identity, so the error clears silently.
				// Credential rotations land here by design - the identity print does
				// not cover them, the overlay serves the current values, and no host
				// call is owed. A pending retry recorded for some OTHER configuration
				// is moot for the same reason; only a failure for this very
				// fingerprint (the guard above) sends the entry back to the host.
				this.retry.delete(entry.label);
			} else if (!force && retryState?.kind === "blocked" && retryState.fingerprint === printed) {
				// The host already refused this exact configuration as a duplicate
				// and offers no update path; retrying without a user gesture would
				// just hammer the command. The last-known-good fingerprint is
				// carried so a later revert of the entry can still match it.
				syncFailure = syncFailureOf("blocked");
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
			} else if (!(await this.confirmSaltDurable())) {
				// Re-confirmed immediately before the irreversible host call, not
				// just at pass start: a store mutation mid-pass must stop further
				// adds, because a group created now could only be proven by a
				// fingerprint no later session can recompute.
				syncFailure = syncFailureOf("saltUnavailable");
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
							syncFailure = syncFailureOf("blocked");
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
						syncFailure = syncFailureOf("upsertFailed");
						this.env.log("Provider group upsert failed", {
							label: entry.label,
							error: errorLabel(error),
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
				...pickEntryViewFields(entry),
				secrets: secretLocations(entry, stored),
				expectedClientId,
				expectedConnectionId,
				syncFailure,
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
		if (!Array.isArray(rawSetting)) {
			// A malformed container (a mid-edit settings.json, an undefined or null
			// read) proves nothing about any label, so nothing may change: no
			// removal can be detected, no record may be pruned or carried (a
			// whole-key write would destroy another window's records, and a stale
			// store read could re-enter the session maps and replay a settled
			// removal on the next valid pass), and no carried removal may resolve
			// against an empty entry list. The session maps stand as they are.
			this.fingerprints = previous;
			this.env.log("Servers setting container is not an array; the pass changes no records");
			return;
		}
		const currentLabels = new Set(entries.map((entry) => entry.label));
		// Removal detection uses the shared still-declared predicate: presence,
		// not this pass's acceptance (see stillDeclaredIn) - a tombstone written
		// for a present entry would suppress a group the user did not remove.
		const labelStillPresent = stillDeclaredIn(rawSetting);
		const storeRecords = this.env.getFingerprints();
		// The session ledger is the truth for this pass (see the field's doc);
		// the fresh store read merges underneath it, presence-only.
		const storedLedger = this.env.getEntryBaseUrls();
		this.ledger ??= { ...storedLedger };
		const sessionLedger: Readonly<Record<string, string>> = this.ledger;
		const ledger: Readonly<Record<string, string>> = { ...storedLedger, ...sessionLedger };
		// A label is a removal candidate on either kind of evidence that a group
		// exists for it: a fingerprint record (a landed add) or a SESSION ledger
		// record (a proven or observed group identity - an entry whose add the
		// host refused still has its live group observed). The session ledger,
		// never the merged one: a stale store read can re-surface a label this
		// session already dropped, and keying on it would fire the removal again.
		// An entry that never synced AND was never seen served raises no event.
		const removed = [...new Set([...Object.keys(previous), ...Object.keys(sessionLedger)])].filter(
			(label) => !labelStillPresent(label)
		);
		// A present-but-rejected label also KEEPS its records: the pass-end writes
		// below rebuild both maps from the accepted entries, and without this
		// carry a mid-edit malformed entry would shed its fingerprint (wedging the
		// repaired entry on an unrecognizable duplicate) and its ledger record
		// (blinding a later real removal). Fingerprints carry with carryLastGood's
		// asymmetry. Reserved (prototype-mutating) keys cannot reach these loops:
		// the env filters them at its read boundary, and the parser rejects them
		// as labels.
		const carriedLedger: Record<string, string> = {};
		for (const label of new Set([...Object.keys(previous), ...Object.keys(storeRecords)])) {
			if (currentLabels.has(label) || !labelStillPresent(label)) {
				continue;
			}
			const carried = previous[label] ?? storeRecords[label];
			if (carried !== undefined && next[label] === undefined) {
				next[label] = carried;
			}
		}
		for (const [label, url] of Object.entries(ledger)) {
			if (!currentLabels.has(label) && labelStillPresent(label)) {
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
		// The identity ledger is read before it is rewritten (above): the old
		// record is the only thing that still knows a removed label's base URL.
		// The labels NEW this pass, with the URL each declares: a removed label's
		// host re-declared under one of them reads as a rename's other half. New
		// means absent from the last valid pass's declaration - a pre-existing
		// entry with no records (blocked, unreadable secrets) is not new. Only
		// the first pass of a session, with no baseline yet, falls back to
		// record absence (fingerprint and session ledger).
		const baseline = this.declaredLabelsLastPass;
		const newLabels: ReadonlyMap<string, string> = new Map(
			entries
				.filter((entry) =>
					baseline !== undefined
						? !baseline.has(entry.label)
						: previous[entry.label] === undefined && sessionLedger[entry.label] === undefined
				)
				.map((entry) => [entry.label, normalizeBaseUrl(entry.baseUrl)])
		);
		this.declaredLabelsLastPass = rawDeclaredLabels(rawSetting);
		// Removals still unresolved from earlier passes join this pass's
		// candidates once more, classified against their own detecting pass's
		// new labels; the setting declaring the label again ends the carry.
		for (const label of [...this.unresolvedRemovals.keys()]) {
			if (labelStillPresent(label)) {
				this.unresolvedRemovals.delete(label);
			} else if (!removed.includes(label)) {
				removed.push(label);
			}
		}
		const events: RemovedEntryEvent[] = [];
		for (const label of removed) {
			const baseUrl = ledger[label] ?? this.soleObservedBaseUrl(label);
			const carried = this.unresolvedRemovals.get(label);
			if (baseUrl === undefined) {
				// Reported untracked once per session (the record survives the
				// pass-end write, so a later session detects it again) and carried
				// until an observation can name the group. A rename's other half is
				// remembered only within the session: after a restart the resolved
				// leftover reads as removed and is hidden - a reversible Unhide,
				// accepted over persisting the delta.
				if (carried === undefined) {
					this.unresolvedRemovals.set(label, newLabels);
					events.push({ kind: "removed", label, baseUrl });
				}
				continue;
			}
			if (ledger[label] === undefined) {
				this.env.log("Removed entry's group identity resolved from the live provider group", { label });
			}
			this.unresolvedRemovals.delete(label);
			const renamedTo = [...(carried ?? newLabels)].find(([, url]) => url === baseUrl)?.[0];
			events.push(
				renamedTo !== undefined
					? { kind: "renamed", oldLabel: label, newLabel: renamedTo, baseUrl }
					: { kind: "removed", label, baseUrl }
			);
		}
		// An unresolved removal - detected this pass or carried from an earlier
		// one - keeps its fingerprint record (see unresolvedRemovals): the label
		// is not declared, so nothing else would carry it, and pruning it would
		// leave the next session no candidate.
		for (const label of this.unresolvedRemovals.keys()) {
			const carried = previous[label] ?? storeRecords[label];
			if (carried !== undefined && next[label] === undefined) {
				next[label] = carried;
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
		try {
			// An entry is recorded under its declared URL only when this pass proved
			// the live group holds exactly that configuration (its fingerprint
			// landed in `next`). A blocked or skipped entry keeps its previous
			// record - under an add-only host the live group still has the OLD
			// connection - and with none, the one URL the host is serving the
			// label's group at, which is the live group's identity by observation.
			// Never the unproven declared URL: it would make a later removal
			// tombstone a group that does not exist while the real one keeps
			// serving. No evidence at all degrades that removal to the honest
			// untracked notice instead.
			const ledgerEntries = entries.flatMap((entry): [string, string][] => {
				const inSync =
					printedByLabel.get(entry.label) !== undefined && next[entry.label] === printedByLabel.get(entry.label);
				if (inSync) {
					return [[entry.label, normalizeBaseUrl(entry.baseUrl)]];
				}
				const knownUrl = ledger[entry.label] ?? this.soleObservedBaseUrl(entry.label);
				return knownUrl !== undefined ? [[entry.label, knownUrl]] : [];
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
		// Logged per EMITTED event, not per candidate: a carried unresolved
		// removal is a candidate on every pass and would otherwise repeat this
		// line into the issue-report buffer until its observation arrives. The
		// setting entries are gone but the provider groups survive: there is no
		// programmatic group removal. Labels' SecretStorage blobs are kept on
		// purpose; re-adding a label picks its secrets up again.
		const reported = events.map((event) => (event.kind === "renamed" ? event.oldLabel : event.label));
		if (reported.length > 0) {
			this.env.log("Servers setting entries removed; their provider groups remain", { labels: reported });
		}
		await this.env.reconcileEntryIdentities(
			entries.map((entry) => ({ label: entry.label, baseUrl: normalizeBaseUrl(entry.baseUrl) })),
			events
		);
	}
}
