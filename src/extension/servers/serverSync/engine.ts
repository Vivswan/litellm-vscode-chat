/**
 * The sync engine: builds the provider-group arguments for each declared entry, drives the host's add-only group
 * command, and owns the fingerprint and retry bookkeeping that keeps duplicate rejections readable.
 *
 *   Effects -> arrive through the injected ServerSyncEnv
 */

import { isDeepStrictEqual } from "node:util";
import type * as vscode from "vscode";
import { groupClientId, parseGroupConfiguration } from "../../../provider/catalog/groupModels";
import type { ServerModelsSnapshot } from "../../../provider/catalog/statusWindow";
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
import { labeledSnapshots, resolveGroupOwnership } from "../../dashboard/declaredJoin";
import type { DeclaredGroupClaim, GroupKey } from "../groupRemovals";
import type { StoredSecretsRecord, StoredServerSecrets } from "./secrets";
import { inlineSecretValues, resolveOwnedSecrets, secretLocations } from "./secrets";
import type { DeclaredServer } from "./setting";
import {
	acceptedEntry,
	parseServersSetting,
	rawDeclaredLabels,
	rejectedCarrierInlineSecrets,
	rejectedCarrierLabels,
	serverSettingReports,
	stillDeclaredIn,
} from "./setting";

/**
 * Consumers key on the class alone, never on message text. extension/dashboard/state.ts denies only an
 * upsertFailed claimant a shared snapshot's models and marks only a secretsUnreadable view's locations unproven.
 *
 *   upsertFailed      -> this add attempt failed outright, so the entry may have no group at all
 *   blocked           -> a group with the name exists and the host refused the duplicate
 *   secretsUnreadable -> the blob read itself failed; the view's locations degraded to the inline-only guess
 *   secretsMismatched -> the read succeeded but a stored value's ownership stamp refused the pairing
 *   saltUnavailable   -> the read succeeded and only the unconfirmed fingerprint salt stopped the pass
 */
type SyncErrorClass = "upsertFailed" | "blocked" | "secretsUnreadable" | "secretsMismatched" | "saltUnavailable";

/**
 * One entry's sync failure: the class and its classified user-facing message, one value so a class without a message
 * (or the reverse) is unrepresentable. Constructed only by syncFailureOf, which derives the message from the class, so
 * a mispaired class/message cannot be built either.
 */
export interface SyncFailure {
	readonly class: SyncErrorClass;
	readonly message: string;
}

/**
 * What the declared join (extension/dashboard/declaredJoin.ts) keys an entry on. Both IDs embed a non-secret
 * credential fingerprint and stay extension-side, never in DashboardState; both are absent when the entry does
 * not resolve to a usable group configuration.
 *
 *   expectedClientId     -> the client ID the entry's resolved configuration produces, the identity the provider
 *                           stamps on its status snapshots
 *   expectedConnectionId -> the same without the entry label; groups created before labels flowed into the
 *                           configuration report under it
 */
export interface DeclaredGroupIdentity {
	readonly label: string;
	readonly baseUrl: string;
	readonly expectedClientId?: string | undefined;
	readonly expectedConnectionId?: string | undefined;
}

/**
 * One consistent reading of what the setting declares, as the group ownership (extension/dashboard/declaredJoin.ts)
 * consumes it, with the raw setting value it was read from (ServerSyncEngine.resolveDeclaredIdentities).
 */
export interface DeclaredIdentities {
	readonly setting: unknown;
	/** The accepted entries. */
	readonly identities: readonly DeclaredGroupIdentity[];
	/** The labels the setting carries outside an accepted entry (rejectedCarrierLabels). */
	readonly carriers: readonly string[];
	/** Every declared label's stored secrets, ownership stamps included; extension-side only, never pushed. */
	readonly storedSecrets: ReadonlyMap<string, StoredSecretsRecord>;
}

/** The non-secret view of a declared server the dashboard renders; secret values stay out. */
export interface DeclaredServerView extends DeclaredGroupIdentity, NonSecretOptionalFields, EntryViewFields {
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;
	/** The label's last sync failure, cleared by the next success. */
	readonly syncFailure?: SyncFailure | undefined;
}

/** One derivation for the join keys (dashboard/declaredJoin.ts), so a pass's views and the live resolution agree. */
function declaredGroupIdentity(entry: DeclaredServer, args: Readonly<Record<string, string>>): DeclaredGroupIdentity {
	const groupServer = parseGroupConfiguration(args);
	if (groupServer === undefined) {
		return { label: entry.label, baseUrl: entry.baseUrl };
	}
	const { label: _label, ...connection } = groupServer;
	return {
		label: entry.label,
		baseUrl: entry.baseUrl,
		expectedClientId: groupClientId(groupServer),
		expectedConnectionId: groupClientId(connection),
	};
}

/**
 * "renamed" means a label NEW this pass (see declaredLabelsLastPass) now declares the removed label's base URL,
 * so the old group is a rename leftover rather than an explicit removal. A "removed" baseUrl is undefined when
 * neither the ledger nor an unambiguous host observation names it, because the env must never tombstone a guess.
 */
export type RemovedEntryEvent =
	| {
			readonly kind: "removed";
			readonly label: string;
			readonly baseUrl: string | undefined;
			/**
			 * The one live group the removed entry joined by its last readable identity and no present entry shares
			 * (ServerSyncEngine.joinedGroupOf): what a pre-label leftover hides by. Empty unless `leftover` is
			 * "hidden".
			 */
			readonly groupIds: readonly string[];
			/**
			 * What the removal did to the entry's live group: hidden by `groupIds`; shared, when an entry still present
			 * joins the same group, so it keeps serving; unreported, when no live group answers to the identity.
			 */
			readonly leftover: "hidden" | "shared" | "unreported";
	  }
	| { readonly kind: "renamed"; readonly oldLabel: string; readonly newLabel: string; readonly baseUrl: string };

/** Everything the engine touches, injected; createServerSyncEnv builds the real one. */
export interface ServerSyncEnv {
	/** The effective litellm-vscode-chat.servers value: what the settings side declares. */
	readServersSetting(): unknown;
	readSecrets(label: string): Promise<StoredSecretsRecord>;
	/** The host's provider-group upsert; args are the group configuration with the name and vendor. */
	addProviderGroup(args: Readonly<Record<string, string>>): Thenable<unknown>;
	/**
	 * Whether fingerprints computed this pass will be recognizable by later sessions (the per-install salt is confirmed
	 * to be the stored one; see extension/fingerprintSalt.ts). Must not throw; an unknowable state reads as false.
	 */
	confirmFingerprintsDurable(): Promise<boolean>;
	/**
	 * The persisted fingerprint map: read to seed the engine's in-memory session map (see
	 * ServerSyncEngine.fingerprints), and re-read per entry presence-only - as positive confirmation on the
	 * duplicate-rejection path, and as the preservation fallback when a pass leaves an entry unsynced (see
	 * carryLastGood). Implementations validate at the read boundary: a returned map never carries a reserved
	 * (prototype-mutating) key or a non-string value, so the engine can assign its labels into plain records unguarded.
	 */
	getFingerprints(): Readonly<Record<string, string>>;
	setFingerprints(map: Readonly<Record<string, string>>): Promise<void>;
	/**
	 * Label -> normalized base URL for the entries earlier passes saw declared; a removal's tombstone stands on
	 * it, and it suffers stale storage reads like getFingerprints, so the engine seeds a session copy once (see
	 * ServerSyncEngine.ledger). Unlike the fingerprints it carries no credential material and no salt
	 * dependence, so writes go out unguarded.
	 */
	getEntryBaseUrls(): Readonly<Record<string, string>>;
	setEntryBaseUrls(map: Readonly<Record<string, string>>): Promise<void>;
	/**
	 * An entry whose add never landed (blocked, or older than the ledger) may have no ledger record, yet the host
	 * still hands its group to the provider on every refresh, so an unambiguous observation is evidence rather
	 * than a guess and the ledger's second source. Live, not historical, so a natively deleted group leaves
	 * within a sweep; wiring/servers.ts re-runs a pass when a labeled group enters, so late evidence is not lost.
	 */
	observedGroupBaseUrls(label: string): readonly string[];
	/** The groups the host serves right now, as the provider's status window reports them; see joinedGroupOf. */
	observedSnapshots(): readonly ServerModelsSnapshot[];
	/**
	 * A re-declared group must never stay suppressed, so the env clears matching removal tombstones before
	 * recording the events; extensions cannot delete the group itself, only the user can.
	 *
	 *   The pass awaits it -> reconciliations stay serialized with their passes
	 */
	reconcileEntryIdentities(claims: readonly DeclaredGroupClaim[], events: readonly RemovedEntryEvent[]): Promise<void>;
	log(message: string, data?: unknown): void;
	logError(message: string, error: unknown): void;
}

/**
 * The field order is frozen because the persisted fingerprint hashes groupIdentityArgs' projection of this
 * object and migrations/fingerprintProjection.ts re-renders the legacy full-args JSON, so both renderings must
 * stay byte-stable (serverSyncEntryShape.test.ts pins them across the nested-settings restructure).
 *
 *   the host echoes only the configuration back, and it keeps same-URL same-credential entries distinct
 *     -> label repeats the group name
 *   credential fields -> a baked fallback only
 *   entryCredentials.ts overlays the entry's current values at serve and request time -> a baked fallback only
 *   everything else   -> extension-read
 *   extension-read    -> edits must not churn the group
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
 * Derived from buildGroupArgs's output, never from the entry, so the two renderings cannot drift. Exported for the
 * fuzz oracle (test/monkeyFuzz.ts), which compares identities through this exact projection but cannot call the salted
 * fingerprint.
 *
 *   baseUrl  -> verbatim
 *   verbatim -> a base URL text edit still reads as a different group
 *   the add-only host never sees a change and entryCredentials.ts overlays current ones at serve time
 *     -> a rotation is in-sync
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
 * The "i1:" prefix lets migrations/fingerprintProjection.ts and the fuzz oracle tell this rendering from the
 * legacy one (both otherwise opaque hex); older versions compare records only by equality, so it is
 * downgrade-safe. The engine compares against this rendering ONLY, so an unmatched record sends the entry back
 * to the host.
 */
export function groupArgsFingerprint(args: Record<string, string>): string {
	return `i1:${fingerprint(JSON.stringify(groupIdentityArgs(args)))}`;
}

/**
 * The classified upsert-failure text. The host's raw error message is never stored, displayed, or logged: the command
 * was called with fully resolved secrets, and the log buffer feeds public issue reports.
 */
export const GROUP_UPSERT_FAILED_MESSAGE = "The host rejected the provider group upsert";

/** How many times resolveDeclaredIdentities re-reads a setting+secrets pair that changed under it before giving up. */
const IDENTITY_READ_ATTEMPTS = 3;

const SETTING_UNSTABLE_MESSAGE =
	"The servers setting or its stored secrets changed on every read while identities were being resolved; retry";

/** A carrier's stored record with the values it still carries inline laid over, so a holder of either is its leftover. */
function withInlineSecrets(
	record: StoredSecretsRecord,
	inline: Readonly<Partial<Record<SecretFieldId, string>>> | undefined
): StoredSecretsRecord {
	return inline === undefined ? record : { values: { ...record.values, ...inline }, owners: record.owners };
}

/** The live resolution's refusal of a setting the pass treats as declaring every old label; nothing can join on it. */
export class IndeterminateServersSettingError extends Error {
	constructor() {
		super("The servers setting is not an array; fix the setting, then retry");
		this.name = "IndeterminateServersSettingError";
	}
}

/**
 * That covers an entry whose configuration changed after its group was created AND a brand-new entry under a name the
 * host already uses, so the text must not assert that anything changed. VS Code's group commands are strictly additive
 * and no update or removal command exists (pinned by hostGroupCommand.test.ts).
 */
export const GROUP_UPDATE_UNAVAILABLE_MESSAGE =
	"A VS Code provider group already uses this name, and VS Code cannot update an existing group. " +
	"If the group does not match this entry, delete it in Manage Language Models (or remove its object from the models file, chatLanguageModels.json, and reload the window), " +
	"then run Sync Models Now.";

/**
 * The classified text for an entry whose stored secrets could not be read this pass. The entry is skipped, not failed
 * permanently: the next pass (or Sync Models Now) reads again.
 */
export const SECRETS_READ_FAILED_MESSAGE =
	"Reading this entry's stored secrets failed, so it was not synced. Run Sync Models Now to retry.";

/**
 * The classified text for an entry whose stored secret is stamped for a different destination (see
 * resolveOwnedSecrets).
 *
 *   the host is add-only     -> the entry is skipped, not synced without the credential
 *   Re-pairing is deliberate -> the user re-enters or removes the stored value
 */
export const SECRET_OWNERSHIP_MISMATCH_MESSAGE =
	"A stored secret for this entry was saved for a different server address, so the entry was not synced. Set the secret again (edit the server in the dashboard, or run LiteLLM: Set Server Secret), or remove the stored value.";

/**
 * The classified text for a pass skipped because the fingerprint salt could not be confirmed durable (see
 * ServerSyncEnv.confirmFingerprintsDurable). Entries are skipped, not failed: the live groups keep serving, and the
 * next session (with the stored salt back) syncs normally.
 */
export const SALT_UNAVAILABLE_MESSAGE =
	"VS Code secret storage could not be confirmed this session, so this entry was not synced. Syncing resumes on the next VS Code session.";

/**
 * The one SyncFailure constructor: the message derives from the class, so the pairing is right by construction at
 * every producer site. The total Record makes a new class a compile error until it names its message.
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
 * Whether the host refused the add because a group with that name already exists.
 *
 *   Fragile by necessity: the host raises a plain Error with no code -> this matches its English message
 */
function isDuplicateGroupError(error: unknown): boolean {
	return error instanceof Error && /already exists/i.test(error.message);
}

/**
 * Why a label's last add did not land, keyed to the fingerprint it concerned; the persisted map holds
 * last-known-good only, so this is the retry signal between passes.
 *
 *   blocked, unforced pass -> skip the host call and keep the error
 *   the host has no update API -> the same configuration cannot land
 *   blocked, but the host now serves the label at the declared URL -> back to the host once
 *   its duplicate answer -> confirms (servedAsDeclared)
 *   blocked, forced pass   -> retry anyway
 *   the user may have removed the stale group natively -> retry anyway
 *   upsertFailed, revert   -> in sync without a call
 */
interface RetryState {
	kind: "blocked" | "upsertFailed";
	fingerprint: string;
}

/**
 * Keeps provider groups in step with the servers setting. syncNow is serialized: a call during an in-flight pass queues
 * exactly one follow-up and resolves after that follow-up (the pass that includes the caller's request). requestSync
 * debounces bursts from settings.json keystrokes.
 */
export class ServerSyncEngine implements vscode.Disposable {
	private views: DeclaredServerView[] = [];
	/** Each declared label's stored secrets as the last pass read them; published with the views, never pushed. */
	private storedSecrets: ReadonlyMap<string, StoredSecretsRecord> = new Map();
	/**
	 * The monkey fuzzer showed why trusting more wedges entries, since an awaited globalState.update can revert
	 * moments later to a stale whole-key value.
	 *
	 *   Seeded from the store on the first pass -> session truth from then on
	 *   syncPass's duplicate confirmation and carryLastGood -> take a store re-read presence-only
	 *   an absence -> proves nothing
	 *   stale read -> pass re-adds its own group -> duplicate rejection read as a foreign name conflict
	 *              -> no last-known-good to carry -> error forever
	 */
	private fingerprints: Record<string, string> | undefined;
	/**
	 * Seed-once like `fingerprints` and for the same reason, with each pass merging one fresh store read
	 * presence-only underneath, so another window's records fill gaps but never shadow a record this session
	 * holds. #220 was this hazard on the ledger.
	 *
	 *   fresh read reverted to a pre-declare version -> removed label read as ledger-less -> untracked notice
	 *                                                -> its models never left the host list
	 */
	private ledger: Record<string, string> | undefined;
	/** Per-label retry state that must survive between passes; see RetryState. */
	private retry = new Map<string, RetryState>();
	/**
	 * Removed labels whose group identity no pass could resolve yet (typically a cold-start removal, before the
	 * host reported any group), each with the labels NEW at detection so a later add or re-point cannot flip the
	 * removal into a rename or the reverse. The label's fingerprint record is carried in the persisted map
	 * meanwhile, because it is the only durable evidence.
	 *
	 *   no carried fingerprint, session ends before the host reports the group (a dead server probes for the timeout)
	 *     -> no candidate -> probed forever
	 */
	private readonly unresolvedRemovals = new Map<string, ReadonlyMap<string, string>>();
	/**
	 * Every label the setting declared (accepted or not) at the end of the last pass with a valid container: the
	 * baseline the rename delta is taken against. Undefined until the first valid pass, where the delta falls back to
	 * record absence.
	 *
	 *   A label absent from it -> NEW this pass
	 *   a pre-existing entry that never synced or was never observed (blocked, unreadable secrets)
	 *     -> is not, however few records it has
	 */
	private declaredLabelsLastPass: ReadonlySet<string> | undefined;
	/**
	 * Each label's identity as its last readable accepted view published it, kept while the label stays in the
	 * setting (a rejected shape publishes no view, a failed or refused secret read a credential-less one). The removal
	 * event, the rename classification, and the tombstone clear all read it through joinedGroupOf.
	 */
	private readonly lastIdentities = new Map<string, DeclaredGroupIdentity>();

	/**
	 * The live group the ownership (dashboard/declaredJoin.ts) joins an identity to, over every group the host serves,
	 * tombstoned ones included: the one join function, so the engine never names a group by a key the dashboard would
	 * not, and a hidden group a re-declared entry owns is found so its tombstone can lift.
	 */
	private joinedGroupOf(
		identity: DeclaredGroupIdentity | undefined,
		snapshots: readonly ServerModelsSnapshot[]
	): GroupKey | undefined {
		if (identity === undefined) {
			return undefined;
		}
		const joined = resolveGroupOwnership({
			labeled: labeledSnapshots(snapshots),
			declared: [identity],
		}).matchedByDeclared.get(0)?.entry.snapshot;
		return joined === undefined
			? undefined
			: {
					groupId: joined.status.serverId,
					label: joined.status.label,
					entryLabel: joined.entryLabel,
					baseUrl: joined.status.baseUrl,
				};
	}

	/** The host's live groups; a throwing env reads as none served. */
	private liveSnapshots(): readonly ServerModelsSnapshot[] {
		try {
			return this.env.observedSnapshots();
		} catch {
			return [];
		}
	}
	private running: Promise<void> | undefined;
	private queued: { force: boolean; promise: Promise<void>; resolve: () => void } | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private holds = 0;
	private heldRequest: { force: boolean; waiters: (() => void)[] } | undefined;
	private disposed = false;
	/** Listeners on completed sync passes; see onDidSync. */
	private readonly syncListeners = new Set<() => void>();

	constructor(
		private readonly env: ServerSyncEnv,
		private readonly debounceMs = 400
	) {}

	/**
	 * Subscribe to the end of every sync pass, successful or failed. Listeners run isolated: one throwing is logged and
	 * cannot starve the others.
	 */
	onDidSync(listener: () => void): { dispose(): void } {
		this.syncListeners.add(listener);
		return { dispose: () => this.syncListeners.delete(listener) };
	}

	/** The declared servers as of the last sync pass, for the dashboard state. */
	getDeclared(): readonly DeclaredServerView[] {
		return this.views;
	}

	/** The stored secrets the last pass read, by declared label, for the group ownership (storedSecretHolders). */
	getStoredSecrets(): ReadonlyMap<string, StoredSecretsRecord> {
		return this.storedSecrets;
	}

	/**
	 * Exactly what a sync pass would submit, so litellm._test.refreshEntryModels can drive the otherwise
	 * host-invoked group serving path; like buildGroupArgs's output it carries resolved secrets verbatim and
	 * must never be logged or ride a state push. A refused stored field stays out, since this path must never
	 * send a credential the engine itself would refuse (the provider's real overlay, entryCredentials.ts, fails
	 * closed on any refusal too).
	 */
	async resolveGroupArgs(label: string): Promise<Record<string, string> | undefined> {
		const match = acceptedEntry(this.env.readServersSetting(), label);
		if (match === undefined) {
			return undefined;
		}
		const record = await this.env.readSecrets(match.entry.label);
		return buildGroupArgs(match.entry, resolveOwnedSecrets(match.entry, record).values);
	}

	/**
	 * What the setting declares at the moment of the call, resolved like a pass resolves it but with no host call and
	 * no bookkeeping. The adopt and hide intents decide which live groups are external against this, never against
	 * getDeclared(), whose views lag until the next pass ends.
	 *
	 *   settings write, pass pending         -> the new entry is already here
	 *   pass running, new group served       -> it joins by identity instead of reading as external
	 *   secrets read throws                  -> rejects; inline-only keys miss a legacy group whose connection ID
	 *                                           carries the secret
	 *   setting or a blob changes mid-read   -> read everything again; the pair returned was read twice unchanged,
	 *                                           or the call rejects
	 *   parser-rejected entry with a label   -> a carrier; a group stamped with it or holding its key is never external
	 *   non-array setting                    -> rejects; the pass still treats every old label as declared, and
	 *                                           nothing could join its group
	 *   a blob rotated after its second read -> not seen; SecretStorage has no compare-and-swap (secrets.ts), the
	 *                                           save path's residual too
	 */
	async resolveDeclaredIdentities(): Promise<DeclaredIdentities> {
		let previous = await this.readDeclaredPair();
		for (let attempt = 0; attempt < IDENTITY_READ_ATTEMPTS; attempt++) {
			const current = await this.readDeclaredPair();
			if (isDeepStrictEqual(current, previous)) {
				return {
					setting: current.setting,
					identities: current.entries.map(({ entry, stored }) =>
						declaredGroupIdentity(entry, buildGroupArgs(entry, stored))
					),
					carriers: current.carriers,
					storedSecrets: current.storedSecrets,
				};
			}
			previous = current;
		}
		throw new Error(SETTING_UNSTABLE_MESSAGE);
	}

	/** One reading of the setting and every declared label's blob, a rejected carrier's included. */
	private async readDeclaredPair(): Promise<{
		setting: unknown;
		entries: { entry: DeclaredServer; stored: StoredServerSecrets }[];
		carriers: string[];
		storedSecrets: Map<string, StoredSecretsRecord>;
	}> {
		const setting: unknown = structuredClone(this.env.readServersSetting());
		if (!Array.isArray(setting)) {
			throw new IndeterminateServersSettingError();
		}
		const storedSecrets = new Map<string, StoredSecretsRecord>();
		const entries: { entry: DeclaredServer; stored: StoredServerSecrets }[] = [];
		for (const entry of parseServersSetting(setting).entries) {
			const record = await this.env.readSecrets(entry.label);
			storedSecrets.set(entry.label, record);
			entries.push({ entry, stored: resolveOwnedSecrets(entry, record).values });
		}
		const reports = serverSettingReports(setting);
		const carriers = rejectedCarrierLabels(reports);
		const inline = rejectedCarrierInlineSecrets(setting, reports);
		for (const label of carriers) {
			const record = storedSecrets.get(label) ?? (await this.env.readSecrets(label));
			storedSecrets.set(label, withInlineSecrets(record, inline.get(label)));
		}
		return { setting, entries, carriers, storedSecrets };
	}

	requestSync(): void {
		if (this.disposed) {
			return;
		}
		if (this.holds > 0) {
			this.heldRequest ??= { force: false, waiters: [] };
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

	/**
	 * A multi-write flow (settings import, its undo) is one unit to the engine: no pass starts while `run` is in
	 * flight, and its end runs exactly one if anything asked. An in-flight pass finishes before `run` starts.
	 *
	 *   requestSync (both listeners, a pending debounce) -> noted; the one pass after `run`
	 *   a finished pass's queued follow-up               -> lands here too
	 *   the relaunch routes through syncNow              -> lands here too
	 *   explicit syncNow(force)                          -> waits; resolves after that pass, forced if asked
	 */
	async withHold<T>(run: () => Promise<T>): Promise<T> {
		this.holds += 1;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
			this.heldRequest ??= { force: false, waiters: [] };
		}
		try {
			// The finally of a finishing pass relaunches its queued follow-up before this continuation resumes; the
			// loop sees that relaunch land in the held branch (no new `running`) or awaits it.
			while (this.running !== undefined) {
				await this.running;
			}
			return await run();
		} finally {
			this.holds -= 1;
			const request = this.heldRequest;
			if (this.holds === 0 && request !== undefined) {
				this.heldRequest = undefined;
				const settle = () => {
					for (const waiter of request.waiters) {
						waiter();
					}
				};
				void this.syncNow(request.force).then(settle, settle);
			}
		}
	}

	async syncNow(force = false): Promise<void> {
		// Checked here, not only at scheduling: the queued follow-up relaunch below routes through syncNow, and this
		// guard is what stops it from starting a pass after disposal.
		if (this.disposed) {
			return;
		}
		if (this.holds > 0) {
			this.heldRequest ??= { force: false, waiters: [] };
			this.heldRequest.force ||= force;
			const request = this.heldRequest;
			return new Promise<void>((resolve) => {
				request.waiters.push(resolve);
			});
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
				// runOnce never rethrows, but the queued waiters must settle even if that ever changes, so rejection
				// also resolves them.
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
		// Waiters settle even though their pass never runs (the poller's dispose contract, mirrored); the in-flight
		// pass finishes on its own, its host call being unrecallable.
		//
		//   queued follow-up        -> resolved, and the queue is empty before that pass's finally looks
		//   callers held for a pass -> resolved the same way
		this.queued?.resolve();
		this.queued = undefined;
		for (const waiter of this.heldRequest?.waiters ?? []) {
			waiter();
		}
		this.heldRequest = undefined;
	}

	private async runOnce(force: boolean): Promise<void> {
		try {
			await this.syncPass(force);
		} catch (error) {
			// Individual upserts handle their own failures; this catches the stores themselves misbehaving. Never
			// rethrown: sync runs on activation and on configuration events.
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
	 * The engine-side wrap of ServerSyncEnv.confirmFingerprintsDurable: a throw must read as "not confirmed", never
	 * abort the pass.
	 */
	private async confirmSaltDurable(): Promise<boolean> {
		try {
			return await this.env.confirmFingerprintsDurable();
		} catch {
			return false;
		}
	}

	/**
	 * A failed read counts as "not current" too, so the add is skipped and the pass that follows whatever changed
	 * reads truth. A mid-pass credential EDIT does not block the add, since the identity fingerprint does not
	 * cover credentials and the baked values are a serve-time-overridden fallback, so pairing pass-start secrets
	 * with a freshly edited entry is harmless.
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
	 * The one base URL the host is serving `label`'s group at, when the observation is unambiguous; see
	 * ServerSyncEnv.observedGroupBaseUrls. A throwing env reads as no observation.
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
	 * Without the carry the pass-end whole-key write would destroy the only copy.
	 *
	 *   Carry the record for an entry this pass leaves unsynced -> this window's last-known-good
	 *   The caller supplies its own single store read -> no branch takes two reads that could disagree
	 *   a later entry's write-through would otherwise re-clobber it mid-pass -> into the session map at once
	 *   into `next` -> the pass-end write keeps it
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

		//   a first-activation salt race in another window
		//     -> can invalidate the session's salt after this engine was built
		const saltDurable = await this.confirmSaltDurable();

		//   the write-through replaces this.fingerprints instead of mutating it
		//     -> `previous` keeps pass-start snapshot semantics
		this.fingerprints ??= { ...this.env.getFingerprints() };
		const previous: Readonly<Record<string, string>> = this.fingerprints;
		const next: Record<string, string> = {};
		const views: DeclaredServerView[] = [];
		const printedByLabel = new Map<string, string>();
		// Stored secrets by declared label, carriers included, for the dashboard's group ownership; published with
		// the views. A failed read keeps the last pass's record, so a leftover holding the label's key does not turn
		// into an adoptable external row for the length of the outage.
		const storedSecrets = new Map<string, StoredSecretsRecord>();
		const carryStoredSecrets = (label: string) => {
			const last = this.storedSecrets.get(label);
			if (last !== undefined) {
				storedSecrets.set(label, last);
			}
		};
		for (const entry of entries) {
			let stored: StoredServerSecrets = {};
			let refusedFields: readonly SecretFieldId[] = [];
			let secretsUnreadable = false;
			// The entry's user-facing failure for THIS pass: exactly one branch below decides it, and only this
			// iteration's view reads it. What survives between passes is the retry state, which the failure is
			// recomputed from.
			let syncFailure: SyncFailure | undefined;
			try {
				// The ownership check runs at the read boundary, before any branch (a forced pass included): a stored
				// value stamped for a different destination must never enter the args this pass could submit.
				const record = await this.env.readSecrets(entry.label);
				storedSecrets.set(entry.label, record);
				const owned = resolveOwnedSecrets(entry, record);
				stored = owned.values;
				refusedFields = owned.refused;
			} catch (error) {
				// A failed secret read must not abort the pass: later entries still need their sync, and an earlier
				// successful add must still reach the fingerprint persist below (losing it would misread that group's
				// next duplicate response as a name conflict). The view renders the classified error and degrades the
				// secret locations to the inline-only reading.
				secretsUnreadable = true;
				syncFailure = syncFailureOf("secretsUnreadable");
				carryStoredSecrets(entry.label);
				this.env.log("Reading a server entry's stored secrets failed", {
					label: entry.label,
					error: errorLabel(error),
				});
			}
			const args = buildGroupArgs(entry, stored);
			const printed = groupArgsFingerprint(args);
			printedByLabel.set(entry.label, printed);
			const retryState = this.retry.get(entry.label);
			// The host serving the label's one group at the entry's own URL proves that group IS this entry's identity
			// (groupIdentityArgs covers nothing else; credentials overlay at serve time), so a duplicate refusal with
			// no matching record is the add-only steady state, not a conflict (#398).
			//
			//   entry removed, then re-added  -> the removal pruned its records while the hidden group kept serving
			//   records lost (new profile)    -> same evidence, same verdict
			const servedAsDeclared = this.soleObservedBaseUrl(entry.label) === normalizeBaseUrl(entry.baseUrl);
			if (secretsUnreadable) {
				//   no host call and no retry bookkeeping (the stored retry state stays put on purpose)
				//     -> last-known-good carries
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
			} else if (refusedFields.length > 0) {
				// The ownership check refused a stored value this entry would have used: the pairing must not reach the
				// host at all. Checked on forced passes too - an activation force-sync is exactly where a
				// delete-failure residual would otherwise pair a surviving blob with a re-declared label at another
				// host.
				syncFailure = syncFailureOf("secretsMismatched");
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
				this.env.log("A stored secret is stamped for a different destination; entry not synced", {
					label: entry.label,
					fields: refusedFields,
				});
			} else if (!saltDurable) {
				//   The same skip -> for a different unusable secret
				//   last-known-good carries -> the next session, keyed by the stored salt, syncs normally
				syncFailure = syncFailureOf("saltUnavailable");
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
			} else if (
				!force &&
				previous[entry.label] === printed &&
				!(retryState?.kind === "upsertFailed" && retryState.fingerprint === printed)
			) {
				next[entry.label] = printed;
				// Credential rotations land here by design - the identity print does not cover them, the overlay serves
				// the current values, and no host call is owed.
				//
				//   An entry stuck on the duplicate error that matches its last-known-good fingerprint again
				//     -> was reverted
				//   A pending retry recorded for some OTHER configuration -> moot for the same reason
				this.retry.delete(entry.label);
			} else if (!force && retryState?.kind === "blocked" && retryState.fingerprint === printed && !servedAsDeclared) {
				// The last-known-good fingerprint is carried so a later revert of the entry can still match it.
				//
				//   retrying without a user gesture -> would just hammer the command
				syncFailure = syncFailureOf("blocked");
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
			} else if (!(await this.confirmSaltDurable())) {
				//   a store mutation mid-pass -> must stop further adds
				syncFailure = syncFailureOf("saltUnavailable");
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
			} else if (!(await this.entryStillCurrent(entry.label, printed))) {
				//   the setting was read once at pass start and the secrets just above
				//     -> an edit landing in either window would pair a stale entry with fresh secrets (or the reverse)
				this.carryLastGood(entry.label, previous, next, this.env.getFingerprints()[entry.label]);
				this.env.log("Server entry changed mid-pass; group add skipped", { label: entry.label });
			} else {
				try {
					await this.env.addProviderGroup(args);
					next[entry.label] = printed;
					this.retry.delete(entry.label);
					// Write-through: in-memory first, because that record is what keeps the group's next duplicate
					// response reading as in-sync and it must survive any storage misbehavior; the persist for the next
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
						// The servers setting is machine-scoped and globalState is shared, so another window's engine
						// may have added this exact configuration and persisted its fingerprint - a record this
						// window's seed-once map predates.
						//
						//   the same read serves both -> the two can never disagree
						//   a stale read can only UNDER-report, never invent a matching fingerprint
						//     -> the asymmetry is load-bearing
						const storeRecord = this.env.getFingerprints()[entry.label];
						const confirmed = previous[entry.label] === printed || storeRecord === printed || servedAsDeclared;
						if (confirmed) {
							// Not logged for that reason.
							//
							//   every activation's forced pass -> lands here for every healthy entry
							next[entry.label] = printed;
							// Into the session map at once, like a successful add: a LATER entry's write-through
							// persists a spread of this map, and without the confirmed label it would re-clobber the
							// other window's record mid-pass.
							this.fingerprints = { ...this.fingerprints, [entry.label]: printed };
							this.retry.delete(entry.label);
						} else {
							// The entry changed (or is new under a taken name) but the host cannot update or replace an
							// existing group. The refused fingerprint goes into the retry state as "blocked" (not the
							// map) so unforced passes keep the error without hammering and a forced pass retries after
							// the user removes the stale group natively.
							this.carryLastGood(entry.label, previous, next, storeRecord);
							this.retry.set(entry.label, { kind: "blocked", fingerprint: printed });
							syncFailure = syncFailureOf("blocked");
							this.env.log("Provider group exists and the host has no update path", { label: entry.label });
						}
					} else {
						// The persisted map keeps the last-known-good fingerprint (a failed add changed nothing about
						// the live group) and the retry rides the "upsertFailed" state instead: dropping the
						// fingerprint here would destroy the only record that lets the healthy group's next duplicate
						// response read as in-sync. Any duplicate-refusal knowledge is stale now, so setting the state
						// also clears a stale "blocked" - otherwise its shortcut would suppress the retry this failure
						// needs.
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
			views.push({
				...declaredGroupIdentity(entry, args),
				...pickNonSecretOptionalFields(entry),
				...pickEntryViewFields(entry),
				secrets: secretLocations(entry, stored),
				syncFailure,
			});
		}

		const rawReports = serverSettingReports(rawSetting);
		const carrierInline = rejectedCarrierInlineSecrets(rawSetting, rawReports);
		for (const label of rejectedCarrierLabels(rawReports)) {
			try {
				const record = storedSecrets.get(label) ?? (await this.env.readSecrets(label));
				storedSecrets.set(label, withInlineSecrets(record, carrierInline.get(label)));
			} catch (error) {
				carryStoredSecrets(label);
				this.env.log("Reading a rejected entry's stored secrets failed", { label, error: errorLabel(error) });
			}
		}

		for (const view of views) {
			// A pass whose stored secrets did not all resolve (the read failed, or a stamp refused a value) built its
			// identities over incomplete secrets: not the live group's.
			if (view.syncFailure?.class === "secretsUnreadable" || view.syncFailure?.class === "secretsMismatched") {
				continue;
			}
			this.lastIdentities.set(view.label, {
				label: view.label,
				baseUrl: view.baseUrl,
				expectedClientId: view.expectedClientId,
				expectedConnectionId: view.expectedConnectionId,
			});
		}
		try {
			await this.finishPass(rawSetting, entries, views, previous, next, printedByLabel);
		} finally {
			// In a finally because a throwing finish must not discard the pass's computed views.
			//
			//   Views -> publish last, after the pass-end reconciliation
			this.views = views;
			// A non-array setting declares every old label and parses no entry, so the pass read no blob; the last
			// pass's records stay until an array reads them again.
			this.storedSecrets = Array.isArray(rawSetting) ? storedSecrets : this.storedSecrets;
		}
	}

	/**
	 * Everything a pass settles after the per-entry loop: removal detection, record carries, retry pruning, the
	 * fingerprint and ledger persists, and the identity reconciliation. syncPass publishes the views in a finally
	 * around this call.
	 */
	private async finishPass(
		rawSetting: unknown,
		entries: readonly DeclaredServer[],
		views: readonly DeclaredServerView[],
		previous: Readonly<Record<string, string>>,
		next: Record<string, string>,
		printedByLabel: ReadonlyMap<string, string>
	): Promise<void> {
		if (!Array.isArray(rawSetting)) {
			// A malformed container (a mid-edit settings.json, an undefined or null read) proves nothing about any
			// label, so nothing may change: no removal can be detected, no record may be pruned or carried (a whole-key
			// write would destroy another window's records, and a stale store read could re-enter the session maps and
			// replay a settled removal on the next valid pass), and no carried removal may resolve against an empty
			// entry list. The session maps stand as they are.
			this.fingerprints = previous;
			this.env.log("Servers setting container is not an array; the pass changes no records");
			return;
		}
		const currentLabels = new Set(entries.map((entry) => entry.label));
		// Removal detection uses the shared still-declared predicate: presence, not this pass's acceptance (see
		// stillDeclaredIn) - a tombstone written for a present entry would suppress a group the user did not remove.
		const labelStillPresent = stillDeclaredIn(rawSetting);
		const storeRecords = this.env.getFingerprints();
		// The session ledger is the truth for this pass (see the field's doc);
		// the fresh store read merges underneath it, presence-only.
		const storedLedger = this.env.getEntryBaseUrls();
		this.ledger ??= { ...storedLedger };
		const sessionLedger: Readonly<Record<string, string>> = this.ledger;
		const ledger: Readonly<Record<string, string>> = { ...storedLedger, ...sessionLedger };
		// A label is a removal candidate on either kind of evidence that a group exists for it: a fingerprint record (a
		// landed add) or a SESSION ledger record (a proven or observed group identity - an entry whose add the host
		// refused still has its live group observed). The session ledger, never the merged one: a stale store read can
		// re-surface a label this session already dropped, and keying on it would fire the removal again.
		//
		//   An entry that never synced AND was never seen served -> raises no event
		const removed = [...new Set([...Object.keys(previous), ...Object.keys(sessionLedger)])].filter(
			(label) => !labelStillPresent(label)
		);
		// A present-but-rejected label also KEEPS its records: the pass-end writes below rebuild both maps from the
		// accepted entries, and without this carry a mid-edit malformed entry would shed its fingerprint (wedging the
		// repaired entry on an unrecognizable duplicate) and its ledger record (blinding a later real removal).
		// Reserved (prototype-mutating) keys cannot reach these loops: the env filters them at its read boundary, and
		// the parser rejects them as labels.
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
		// Per-label retry state is pruned with its entry; the map is keyed by user-controlled labels and would
		// otherwise grow without bound. Pruned by PRESENCE, never by this pass's acceptance: a mid-edit entry or an
		// unreadable container must not erase an upsertFailed marker - its loss would read the restored entry's carried
		// fingerprint as in-sync and silently skip the retry that failure still needs.
		for (const label of [...this.retry.keys()]) {
			if (!labelStillPresent(label)) {
				this.retry.delete(label);
			}
		}
		// The labels NEW this pass, with the URL each declares: a removed label's host re-declared under one of them
		// reads as a rename's other half. New means absent from the last valid pass's declaration - a pre-existing
		// entry with no records (blocked, unreadable secrets) is not new.
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
		// Removals still unresolved from earlier passes join this pass's candidates once more, classified against their
		// own detecting pass's new labels; the setting declaring the label again ends the carry.
		for (const label of [...this.unresolvedRemovals.keys()]) {
			if (labelStillPresent(label)) {
				this.unresolvedRemovals.delete(label);
			} else if (!removed.includes(label)) {
				removed.push(label);
			}
		}
		const present = rawDeclaredLabels(rawSetting);
		const snapshots = this.liveSnapshots();
		const sameIdentity = (a: DeclaredGroupIdentity | undefined, b: DeclaredGroupIdentity | undefined) =>
			a !== undefined &&
			b !== undefined &&
			((a.expectedClientId !== undefined && a.expectedClientId === b.expectedClientId) ||
				(a.expectedConnectionId !== undefined && a.expectedConnectionId === b.expectedConnectionId));
		const events: RemovedEntryEvent[] = [];
		for (const label of removed) {
			const baseUrl = ledger[label] ?? this.soleObservedBaseUrl(label);
			const carried = this.unresolvedRemovals.get(label);
			if (baseUrl === undefined) {
				//   A rename's other half -> is remembered only within the session
				if (carried === undefined) {
					this.unresolvedRemovals.set(label, newLabels);
					events.push({ kind: "removed", label, baseUrl, groupIds: [], leftover: "unreported" });
				}
				continue;
			}
			if (ledger[label] === undefined) {
				this.env.log("Removed entry's group identity resolved from the live provider group", { label });
			}
			this.unresolvedRemovals.delete(label);
			const own = this.lastIdentities.get(label);
			this.lastIdentities.delete(label);
			const renamedTo = [...(carried ?? newLabels)].find(
				([newLabel, url]) => url === baseUrl && sameIdentity(own, this.lastIdentities.get(newLabel))
			)?.[0];
			const shared = new Set(
				[...this.lastIdentities].flatMap(([other, ids]) =>
					present.has(other) ? [this.joinedGroupOf(ids, snapshots)?.groupId] : []
				)
			);
			const ownGroup = this.joinedGroupOf(own, snapshots);
			const leftover = ownGroup === undefined ? "unreported" : shared.has(ownGroup.groupId) ? "shared" : "hidden";
			events.push(
				renamedTo !== undefined
					? { kind: "renamed", oldLabel: label, newLabel: renamedTo, baseUrl }
					: {
							kind: "removed",
							label,
							baseUrl,
							groupIds: leftover === "hidden" && ownGroup !== undefined ? [ownGroup.groupId] : [],
							leftover,
						}
			);
		}
		// An unresolved removal - detected this pass or carried from an earlier one - keeps its fingerprint record (see
		// unresolvedRemovals): the label is not declared, so nothing else would carry it, and pruning it would leave
		// the next session no candidate.
		for (const label of this.unresolvedRemovals.keys()) {
			const carried = previous[label] ?? storeRecords[label];
			if (carried !== undefined && next[label] === undefined) {
				next[label] = carried;
			}
		}
		// In-memory before the persist: session truth must survive a failing (or later-reverted) storage write. The
		// persist itself is log-only, because a throw here must not abort the reconciliation below - the removal's
		// tombstone and notice would be lost with no later pass able to rediscover them.
		this.fingerprints = next;
		try {
			await this.env.setFingerprints(next);
		} catch (error) {
			this.env.logError("Persisting the pass-end fingerprint map failed", error);
		}
		try {
			// Never the unproven declared URL: it would make a later removal tombstone a group that does not exist
			// while the real one keeps serving.
			//
			//   No evidence at all -> degrades that removal to the honest untracked notice instead
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
			// Session truth before the persist, like the fingerprint map: a failing (or later-reverted) storage write
			// must not cost a later removal its tombstone.
			this.ledger = nextLedger;
			await this.env.setEntryBaseUrls(nextLedger);
		} catch (error) {
			// Log-only like the fingerprint persist: the session ledger already holds the records, so only a NEXT
			// session's removal degrades to the untracked (no-tombstone) notice.
			this.env.logError("Persisting the entry identity ledger failed", error);
		}
		// Logged per EMITTED event, not per candidate: a carried unresolved removal is a candidate on every pass and
		// would otherwise repeat this line into the issue-report buffer until its observation arrives.
		//
		//   there is no programmatic group removal -> the provider groups survive
		//   Labels' SecretStorage blobs             -> are kept on purpose
		const reported = events.map((event) => (event.kind === "renamed" ? event.oldLabel : event.label));
		if (reported.length > 0) {
			this.env.log("Servers setting entries removed; their provider groups remain", { labels: reported });
		}
		// A deferred removal (unresolvedRemovals) keeps its identity until its observation arrives and classifies it.
		for (const label of [...this.lastIdentities.keys()]) {
			if (!present.has(label) && !this.unresolvedRemovals.has(label)) {
				this.lastIdentities.delete(label);
			}
		}
		await this.env.reconcileEntryIdentities(
			views.map(({ label, baseUrl }) => ({
				label,
				baseUrl: normalizeBaseUrl(baseUrl),
				group: this.joinedGroupOf(this.lastIdentities.get(label), snapshots),
			})),
			events
		);
	}
}
