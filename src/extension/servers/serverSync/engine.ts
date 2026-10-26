/**
 * The sync engine keeps VS Code's provider groups in step with the litellm-vscode-chat.servers setting, the settings
 * side's source of truth for servers. The host's group command rejects an existing name and has no update or removal
 * command (hostGroupCommand.test.ts pins this), so a duplicate rejection for an unchanged entry is the synced steady
 * state, and an entry changed underneath its group surfaces an actionable error.
 *
 *   Each entry        -> registers through the host's add-only lm.addLanguageModelsProviderGroup command
 *   its secret fields -> resolved as inline-in-settings value first, then the label's SecretStorage blob, then absent
 *   Effects           -> arrive through the injected ServerSyncEnv; errors are logged, never thrown into activation
 */

import { isDeepStrictEqual } from "node:util";
import type * as vscode from "vscode";
import type { CredentialRejection, GroupServer, ParsedGroupConfiguration } from "../../../provider/catalog/groupModels";
import {
	groupClientId,
	groupCredentialKind,
	groupHasCredentials,
	parseGroupConfiguration,
} from "../../../provider/catalog/groupModels";
import type { ServerModelsSnapshot } from "../../../provider/catalog/statusWindow";
import { VENDOR_ID } from "../../../shared/config/commandIds";
import type { SyncErrorClass } from "../../../shared/failureCause";
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
	matchedEntryFor,
	parseServersSetting,
	rawDeclaredLabels,
	rejectedCarrierInlineSecrets,
	rejectedCarrierLabels,
	serverSettingReports,
	stillDeclaredIn,
} from "./setting";

/**
 * One entry's sync failure: the class alone. The text renders from it where it is shown (shared/failureCause.ts), in
 * the reader's locale, so the view carries no sentence written under the locale of the pass that failed.
 */
export interface SyncFailure {
	readonly class: SyncErrorClass;
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
 * consumes it, with the raw setting value it was read from (ServerSyncEngine.resolveDeclaredIdentities). The secret
 * values cover accepted entries and rejected carriers alike: a live group holding any of them is that label's
 * leftover.
 */
export interface DeclaredIdentities {
	/** The raw setting value this reading was taken from. */
	readonly setting: unknown;

	/** The accepted entries. */
	readonly identities: readonly DeclaredGroupIdentity[];

	/** The labels the setting carries outside an accepted entry (rejectedCarrierLabels). */
	readonly carriers: readonly string[];

	/** Every secret value each declared label stores or carries inline; extension-side only, never pushed. */
	readonly secretValues: ReadonlyMap<string, readonly string[]>;
}

/**
 * The non-secret view of a declared server the dashboard renders; secret values stay out. `rejectedCredentials` is
 * the field-level detail behind a credentialsRefused failure (a key the platform's Headers would refuse), which the
 * dashboard's diagnostics point at beside the entry. `credentials` is groupHasCredentials over the parser's output,
 * the one answer the group report gives too; the dashboard row and the issue report read it instead of judging
 * locations or inline fields themselves.
 */
export interface DeclaredServerView extends DeclaredGroupIdentity, NonSecretOptionalFields, EntryViewFields {
	/** Where each secret field lives; locations only, never values. */
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;

	/** The label's last sync failure, cleared by the next success. */
	readonly syncFailure?: SyncFailure | undefined;

	/** The credential fields the group narrowing dropped; fields only, never values. */
	readonly rejectedCredentials?: readonly CredentialRejection["field"][] | undefined;

	/** What the group parser kept of the entry's credentials; undefined when no usable group configuration results. */
	readonly credentials?: DeclaredCredentials | undefined;
}

/** The kinds beside the presence, so the rows name a virtual-key header or OAuth client as such. */
export interface DeclaredCredentials {
	readonly present: boolean;
	readonly oauth: boolean;
	readonly virtualKey: boolean;
}

function credentialsOf(groupServer: GroupServer): DeclaredCredentials {
	const kind = groupCredentialKind(groupServer);
	return { present: groupHasCredentials(groupServer), oauth: kind === "oauth", virtualKey: kind === "virtualKey" };
}

/** The owner's reading of an entry's credentials from the args a pass bakes; see DeclaredServerView.credentials. */
export function declaredCredentials(args: Readonly<Record<string, string>>): DeclaredCredentials | undefined {
	const parsed = parseGroupConfiguration(args);
	return parsed === undefined ? undefined : credentialsOf(parsed.server);
}

/** One derivation for the join keys (dashboard/declaredJoin.ts), so a pass's views and the live resolution agree. */
function declaredGroupIdentity(
	entry: DeclaredServer,
	parsed: ParsedGroupConfiguration | undefined
): DeclaredGroupIdentity & { readonly credentials: DeclaredCredentials | undefined } {
	if (parsed === undefined) {
		return { label: entry.label, baseUrl: entry.baseUrl, credentials: undefined };
	}
	const { label: _label, ...connection } = parsed.server;
	return {
		label: entry.label,
		baseUrl: entry.baseUrl,
		expectedClientId: groupClientId(parsed.server),
		expectedConnectionId: groupClientId(connection),
		credentials: credentialsOf(parsed.server),
	};
}

/**
 * "renamed" means a label NEW this pass (see declaredLabelsLastPass) now declares the removed label's base URL,
 * so the old group is a rename leftover rather than an explicit removal. A "removed" baseUrl is undefined when
 * neither the ledger nor an unambiguous host observation names it, because the env must never tombstone a guess.
 *
 * `groupIds` is what a leftover of the removed entry hides by: the client and connection IDs its last readable pass
 * carried and the live group it joined (ServerSyncEngine.joinedGroupOf), minus any an entry still present carries;
 * those are `sharedGroupIds`, kept and not tombstoned. A pre-label group the host reports only after the removal
 * matches by these on its first observation.
 */
export type RemovedEntryEvent =
	| {
			readonly kind: "removed";
			readonly label: string;
			readonly baseUrl: string | undefined;
			readonly groupIds: readonly string[];
			readonly sharedGroupIds: readonly string[];
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
	 * Label -> base URL in its one spelling (canonicalBaseUrl; the implementation canonicalizes what older versions
	 * stored as typed) for the entries earlier passes saw declared; a removal's tombstone stands on it, and it suffers
	 * stale storage reads like getFingerprints, so the engine seeds a session copy once (see ServerSyncEngine.ledger).
	 * Unlike the fingerprints it carries no credential material and no salt dependence, so writes go out unguarded.
	 */
	getEntryBaseUrls(): Readonly<Record<string, string>>;

	setEntryBaseUrls(map: Readonly<Record<string, string>>): Promise<void>;

	/**
	 * An entry whose add never landed (blocked, or older than the ledger) may have no ledger record, yet the host
	 * still hands its group to the provider on every refresh, so an unambiguous observation is evidence rather
	 * than a guess and the ledger's second source. Live, not historical, so a natively deleted group leaves
	 * within a sweep; wiring/servers.ts re-runs a pass when a group enters, so late evidence is not lost.
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

export function buildGroupArgs(entry: DeclaredServer, stored: StoredServerSecrets): Record<string, string> {
	const args: Record<string, string> = {
		name: entry.label,
		vendor: VENDOR_ID,
		baseUrl: entry.baseUrl,
		// The host echoes a group's configuration back without its name, and the label inside it keeps two entries at
		// one URL with one credential apart.
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
 * One label's group arguments, resolved the way a sync pass resolves them, so resolveGroupArgs, entryStillCurrent,
 * entryCredentials.ts, and servers/entryConnection.ts cannot render an entry differently: what each makes of a refusal
 * is its own. `undeclared` carries the setting it read, so a caller's carrier check judges the same read.
 */
type OwnedGroupArgs =
	| { readonly kind: "undeclared"; readonly setting: unknown }
	| { readonly kind: "secretsUnreadable"; readonly error: unknown }
	| {
			readonly kind: "owned";
			readonly entry: DeclaredServer;
			readonly args: Record<string, string>;
			readonly refused: readonly SecretFieldId[];
	  };

export async function resolveOwnedGroupArgs(
	env: Pick<ServerSyncEnv, "readServersSetting" | "readSecrets">,
	label: string,
	baseUrl?: string
): Promise<OwnedGroupArgs> {
	const setting = env.readServersSetting();
	const entry = baseUrl === undefined ? acceptedEntry(setting, label)?.entry : matchedEntryFor(setting, label, baseUrl);
	if (entry === undefined) {
		return { kind: "undeclared", setting };
	}
	let record: StoredSecretsRecord;
	try {
		record = await env.readSecrets(entry.label);
	} catch (error) {
		return { kind: "secretsUnreadable", error };
	}
	const owned = resolveOwnedSecrets(entry, record);
	return { kind: "owned", entry, args: buildGroupArgs(entry, owned.values), refused: owned.refused };
}

/**
 * Derived from buildGroupArgs's output, never from the entry, so the two renderings cannot drift. Exported for the
 * fuzz oracle (test/monkeyFuzz.ts), which compares identities through this exact projection but cannot call the salted
 * fingerprint.
 *
 *   baseUrl  -> the entry's one spelling (setting.ts), so a re-spelling is the same group and a re-pointing a new one
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

/** How many times resolveDeclaredIdentities re-reads a setting+secrets pair that changed under it before giving up. */
const IDENTITY_READ_ATTEMPTS = 3;

/** The refusal thrown after the last attempt; a classification, never the setting's text. */
const SETTING_UNSTABLE_MESSAGE =
	"The servers setting or its stored secrets changed on every read while identities were being resolved; retry";

/** Every non-empty value a label's stored record and its inline fields carry, each once. */
function secretValuesOf(record: StoredSecretsRecord | undefined, inline: readonly string[]): string[] {
	return [
		...new Set(
			[...Object.values(record?.values ?? {}), ...inline].filter(
				(value): value is string => typeof value === "string" && value.length > 0
			)
		),
	];
}

/** The live resolution's refusal of a setting the pass treats as declaring every old label; nothing can join on it. */
export class IndeterminateServersSettingError extends Error {
	constructor() {
		super("The servers setting is not an array; fix the setting, then retry");
		this.name = "IndeterminateServersSettingError";
	}
}

function syncFailureOf(failureClass: SyncErrorClass): SyncFailure {
	return { class: failureClass };
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
 *   blocked on this print, unforced, not seen as declared  -> no host call; the error stands (no host update API)
 *   blocked, seen serving the label as declared            -> the matching record confirms, else one more duplicate
 *   blocked, forced pass                                   -> retry anyway; the user may have fixed the group natively
 *   upsertFailed, the entry reverted                       -> in sync without a call
 */
interface RetryState {
	kind: "blocked" | "upsertFailed";
	fingerprint: string;
}

/**
 * One pass's working state, shared by the steps syncPass runs: the pass-start fingerprint snapshot and the map the
 * pass builds, the labels proved at their declared URL, and the records and secret values read on the way.
 */
interface PassState {
	readonly force: boolean;
	readonly saltDurable: boolean;
	readonly previous: Readonly<Record<string, string>>;
	readonly next: Record<string, string>;
	readonly synced: Set<string>;
	readonly records: Map<string, StoredSecretsRecord>;
	readonly secretValues: Map<string, readonly string[]>;
}

/** One entry's stored secrets as the pass read them: the usable values with the fields ownership refused, or no read. */
type EntrySecrets =
	| { readonly kind: "read"; readonly stored: StoredServerSecrets; readonly refusedFields: readonly SecretFieldId[] }
	| { readonly kind: "unreadable" };

/**
 * How the live observation and the retry state stand for one entry's print; `recordConfirms` judges a record by
 * them.
 */
interface EntryStanding {
	readonly servedAsDeclared: boolean;
	readonly blockedAsPrinted: boolean;
	readonly recordConfirms: (record: string | undefined) => boolean;
}

/**
 * What the pass-end reconciliation reads: the pass-start and pass-end fingerprint maps, the store's records, the
 * session and merged ledgers, the raw setting's presence predicate and declared labels, the accepted labels, and the
 * host's live snapshots.
 */
interface FinishState {
	readonly previous: Readonly<Record<string, string>>;
	readonly next: Record<string, string>;
	readonly labelStillPresent: (label: string) => boolean;
	readonly storeRecords: Readonly<Record<string, string>>;
	readonly sessionLedger: Readonly<Record<string, string>>;
	readonly ledger: Readonly<Record<string, string>>;
	readonly acceptedLabels: ReadonlySet<string>;
	readonly declaredLabels: ReadonlySet<string>;
	readonly snapshots: readonly ServerModelsSnapshot[];
}

/** Whether two identities name one group: a shared client ID, or a shared connection ID. */
function sameDeclaredIdentity(a: DeclaredGroupIdentity | undefined, b: DeclaredGroupIdentity | undefined): boolean {
	if (a === undefined || b === undefined) {
		return false;
	}
	if (a.expectedClientId !== undefined && a.expectedClientId === b.expectedClientId) {
		return true;
	}
	return a.expectedConnectionId !== undefined && a.expectedConnectionId === b.expectedConnectionId;
}

/**
 * Keeps provider groups in step with the servers setting. syncNow is serialized: a call during an in-flight pass queues
 * exactly one follow-up and resolves after that follow-up (the pass that includes the caller's request). requestSync
 * debounces bursts from settings.json keystrokes.
 *
 * `fingerprints` and `ledger` are seeded from the store on the first pass and are session truth from then on, each
 * pass merging one fresh store read presence-only underneath, so another window's records fill gaps but never shadow
 * a record this session holds. The monkey fuzzer showed why trusting more wedges entries: an awaited
 * globalState.update can revert moments later to a stale whole-key value, and #220 was this hazard on the ledger.
 *
 *   syncPass's duplicate confirmation and carryLastGood -> take a store re-read presence-only; absence proves nothing
 *   stale fingerprint read -> pass re-adds its own group -> duplicate rejection read as a foreign name conflict
 *                          -> no last-known-good to carry -> error forever
 *   ledger read reverted to a pre-declare version -> removed label read as ledger-less -> untracked notice
 *                                                 -> its models never left the host list
 *
 * `unresolvedRemovals` holds removed labels whose group identity no pass could resolve yet (typically a cold-start
 * removal, before the host reported any group), each with the labels NEW at detection so a later add or re-point
 * cannot flip the removal into a rename or the reverse; the label's fingerprint record is carried in the persisted map
 * meanwhile, because it is the only durable evidence. With no carried fingerprint and a session that ends before the
 * host reports the group (a dead server probes for the timeout), there is no candidate and the label is probed
 * forever.
 *
 * `declaredLabelsLastPass` is the baseline the rename delta is taken against: every label the setting declared
 * (accepted or not) at the end of the last pass with a valid container. A label absent from it is NEW this pass; a
 * pre-existing entry that never synced or was never observed (blocked, unreadable secrets) is not, however few
 * records it has. Undefined until the first valid pass, where the delta falls back to record absence.
 *
 * `lastIdentities` keeps each label's identity as its last readable accepted view published it, while the label stays
 * in the setting (a rejected shape publishes no view, a failed or refused secret read a credential-less one); the
 * removal event, the rename classification, and the tombstone clear all read it through joinedGroupOf.
 */
export class ServerSyncEngine implements vscode.Disposable {
	/** The declared views as the last pass published them; what the dashboard renders. */
	private views: DeclaredServerView[] = [];

	/** Each declared label's secret values as the last pass read them; published with the views, never pushed. */
	private secretValues: ReadonlyMap<string, readonly string[]> = new Map();

	/** Seeded once, then session truth; a store re-read fills gaps presence-only (see the class doc). */
	private fingerprints: Record<string, string> | undefined;

	/** Seed-once like `fingerprints` and for the same reason; a fresh read never shadows this session's record. */
	private ledger: Record<string, string> | undefined;

	/** Per-label retry state that must survive between passes; see RetryState. */
	private retry = new Map<string, RetryState>();

	/** Removed labels no pass could resolve yet, each with the labels NEW at detection; see the class doc. */
	private readonly unresolvedRemovals = new Map<string, ReadonlyMap<string, string>>();

	/** The rename delta's baseline: every label declared at the end of the last valid pass; undefined before one. */
	private declaredLabelsLastPass: ReadonlySet<string> | undefined;

	/** Each label's identity as its last readable accepted view published it, read through joinedGroupOf. */
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

	/**
	 * The keys a leftover of `identity`'s entry can be hidden by: the client and connection IDs, and the live group
	 * the identity joins (which may be neither, after a label-URL join). Order fixed, duplicates dropped.
	 */
	private identityKeys(
		identity: DeclaredGroupIdentity | undefined,
		snapshots: readonly ServerModelsSnapshot[]
	): string[] {
		const keys = [
			identity?.expectedClientId,
			identity?.expectedConnectionId,
			this.joinedGroupOf(identity, snapshots)?.groupId,
		];
		return [...new Set(keys.filter((key): key is string => key !== undefined))];
	}

	private liveSnapshots(): readonly ServerModelsSnapshot[] {
		try {
			return this.env.observedSnapshots();
		} catch {
			return [];
		}
	}

	/** The pass in flight; a syncNow during it queues exactly one follow-up instead of starting another. */
	private running: Promise<void> | undefined;

	/** The one follow-up every syncNow during a pass joins; `force` is OR-ed across the joiners. */
	private queued: { force: boolean; promise: Promise<void>; resolve: () => void } | undefined;

	/** requestSync's debounce timer; a hold cancels it and parks the request in heldRequest. */
	private timer: ReturnType<typeof setTimeout> | undefined;

	/** Active hold() callers; while above zero every request parks in heldRequest and no pass starts. */
	private holds = 0;

	/** The request parked while held, with its waiters; released as one pass when the last hold ends. */
	private heldRequest: { force: boolean; waiters: (() => void)[] } | undefined;

	/** Set by dispose, which also settles the queued and held waiters. */
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

	/** The secret values the last pass read, by declared label, for the group ownership (secretValueHolders). */
	getSecretValues(): ReadonlyMap<string, readonly string[]> {
		return this.secretValues;
	}

	/**
	 * Exactly what a sync pass would submit, so litellm._test.refreshEntryModels can drive the otherwise
	 * host-invoked group serving path; like buildGroupArgs's output it carries resolved secrets verbatim and
	 * must never be logged or ride a state push. A refusal is tolerated, since only the test command calls this.
	 */
	async resolveGroupArgs(label: string): Promise<Record<string, string> | undefined> {
		const owned = await resolveOwnedGroupArgs(this.env, label);
		switch (owned.kind) {
			case "undeclared":
				return undefined;
			case "secretsUnreadable":
				throw owned.error;
			case "owned":
				return owned.args;
		}
	}

	/**
	 * What the setting declares at the moment of the call: the adopt and hide intents judge which live groups are
	 * external against this, never against getDeclared(), whose views lag until the next pass ends.
	 *
	 *   the setting and the blobs are separate stores with no atomic read (secrets.ts)
	 *     -> a pair counts only once two consecutive reads agree; a rotation after a blob's final read is not seen
	 *   a secrets read throws -> rejects; resolved over inline values alone, a legacy group whose connection ID embeds
	 *                            the stored credential's fingerprint would read as external
	 */
	async resolveDeclaredIdentities(): Promise<DeclaredIdentities> {
		let previous = await this.readDeclaredPair();
		for (let attempt = 0; attempt < IDENTITY_READ_ATTEMPTS; attempt++) {
			const current = await this.readDeclaredPair();
			if (isDeepStrictEqual(current, previous)) {
				return {
					setting: current.setting,
					identities: current.entries.map(({ entry, stored }) =>
						declaredGroupIdentity(entry, parseGroupConfiguration(buildGroupArgs(entry, stored)))
					),
					carriers: current.carriers,
					secretValues: current.secretValues,
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
		secretValues: Map<string, readonly string[]>;
	}> {
		const setting: unknown = structuredClone(this.env.readServersSetting());
		if (!Array.isArray(setting)) {
			throw new IndeterminateServersSettingError();
		}
		const records = new Map<string, StoredSecretsRecord>();
		const secretValues = new Map<string, readonly string[]>();
		const entries: { entry: DeclaredServer; stored: StoredServerSecrets }[] = [];
		for (const entry of parseServersSetting(setting).entries) {
			const record = await this.env.readSecrets(entry.label);
			records.set(entry.label, record);
			secretValues.set(entry.label, secretValuesOf(record, Object.values(inlineSecretValues(entry))));
			entries.push({ entry, stored: resolveOwnedSecrets(entry, record).values });
		}
		const reports = serverSettingReports(setting);
		const carriers = rejectedCarrierLabels(reports);
		const inline = rejectedCarrierInlineSecrets(setting, reports);
		for (const label of carriers) {
			const record = records.get(label) ?? (await this.env.readSecrets(label));
			secretValues.set(label, [
				...new Set([...(secretValues.get(label) ?? []), ...secretValuesOf(record, inline.get(label) ?? [])]),
			]);
		}
		return { setting, entries, carriers, secretValues };
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
	 * The fingerprint covers no credential, so a mid-pass credential EDIT does not block the add (the overlay serves
	 * the current values); a refusal does, since the pairing must not reach the host at all. The pass that follows
	 * whatever changed reads truth.
	 */
	private async entryStillCurrent(label: string, printed: string): Promise<boolean> {
		try {
			const owned = await resolveOwnedGroupArgs(this.env, label);
			return owned.kind === "owned" && owned.refused.length === 0 && groupArgsFingerprint(owned.args) === printed;
		} catch {
			return false;
		}
	}

	/**
	 * The distinct base URLs the host is serving `label`'s labeled groups at (ServerSyncEnv.observedGroupBaseUrls); a
	 * throwing env reads as nothing observed.
	 *
	 *   []           -> no evidence; the records decide
	 *   [url]        -> the live group's identity
	 *   two or more  -> ambiguous; proves nothing and lifts nothing
	 */
	private observedBaseUrls(label: string): readonly string[] {
		try {
			return [...new Set(this.env.observedGroupBaseUrls(label).map(normalizeBaseUrl))];
		} catch {
			return [];
		}
	}

	/**
	 * Where a label's group is known to live while the pass has not proved the declared URL: a sole live observation
	 * outranks the remembered URL, since a group re-pointed natively keeps its name while the ledger still names where
	 * it was.
	 */
	private knownBaseUrl(label: string, ledger: Readonly<Record<string, string>>): string | undefined {
		const observed = this.observedBaseUrls(label);
		return observed.length === 1 ? observed[0] : ledger[label];
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

	/** Keeps the last pass's secret values for a label whose blob could not be read this pass. */
	private carrySecretValues(label: string, pass: PassState): void {
		const last = this.secretValues.get(label);
		if (last !== undefined) {
			pass.secretValues.set(label, last);
		}
	}

	/**
	 * Carries the label's last-known-good fingerprint, the store's record standing in when the pass-start map has
	 * none.
	 */
	private carryStoreRecord(label: string, pass: PassState): void {
		this.carryLastGood(label, pass.previous, pass.next, this.env.getFingerprints()[label]);
	}

	/**
	 * Reads one entry's stored secrets. The ownership check runs at the read boundary, before any branch (a forced
	 * pass included): a stored value stamped for a different destination must never enter the args this pass could
	 * submit. A failed read must not abort the pass: later entries still need their sync, and an earlier successful add
	 * must still reach the fingerprint persist (losing it would misread that group's next duplicate response as a name
	 * conflict), so the read reports unreadable, the view renders the classified error, and the secret locations
	 * degrade to the inline-only reading. A failed read keeps the last pass's secret values, so a leftover holding the
	 * label's key does not turn into an adoptable external row for the length of the outage.
	 */
	private async readEntrySecrets(entry: DeclaredServer, pass: PassState): Promise<EntrySecrets> {
		try {
			const record = await this.env.readSecrets(entry.label);
			pass.records.set(entry.label, record);
			pass.secretValues.set(entry.label, secretValuesOf(record, Object.values(inlineSecretValues(entry))));
			const owned = resolveOwnedSecrets(entry, record);
			return { kind: "read", stored: owned.values, refusedFields: owned.refused };
		} catch (error) {
			this.carrySecretValues(entry.label, pass);
			this.env.log("Reading a server entry's stored secrets failed", {
				label: entry.label,
				error: errorLabel(error),
			});
			return { kind: "unreadable" };
		}
	}

	/**
	 * How the live observation and the retry state stand for one entry. The live observation outranks the records: the
	 * label's one group at the entry's URL IS this entry's identity (groupIdentityArgs covers nothing else; credentials
	 * overlay at serve time), while a record only pins the add this window made under the name, which a group
	 * re-pointed natively in chatLanguageModels.json keeps.
	 *
	 *   no record, one group seen as declared (#398)  -> the duplicate refusal is the add-only steady state
	 *   record matches, one group seen elsewhere       -> blocked, not in sync
	 *   blocked on this print, not seen as declared     -> stays blocked; no group or two groups seen settles nothing
	 */
	private entryStanding(entry: DeclaredServer, printed: string, retryState: RetryState | undefined): EntryStanding {
		const observed = this.observedBaseUrls(entry.label);
		const servedAsDeclared = observed.length === 1 && observed[0] === normalizeBaseUrl(entry.baseUrl);
		const servedElsewhere = observed.length === 1 && !servedAsDeclared;
		const blockedAsPrinted = retryState?.kind === "blocked" && retryState.fingerprint === printed;
		const recordConfirms = (record: string | undefined): boolean =>
			record === printed && !servedElsewhere && (!blockedAsPrinted || servedAsDeclared);
		return { servedAsDeclared, blockedAsPrinted, recordConfirms };
	}

	/**
	 * Records a landed add. Write-through: in-memory first, because that record is what keeps the group's next
	 * duplicate response reading as in-sync and it must survive any storage misbehavior; the persist for the next
	 * session is log-only for the same reason.
	 */
	private async recordAdd(
		entry: DeclaredServer,
		pass: PassState,
		args: Record<string, string>,
		printed: string
	): Promise<void> {
		pass.next[entry.label] = printed;
		pass.synced.add(entry.label);
		this.retry.delete(entry.label);
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
	}

	/**
	 * Records a failed add and returns the entry's failure, or undefined for a duplicate the records or the live
	 * observation confirm. The servers setting is machine-scoped and globalState is shared, so another window's engine
	 * may have added this exact configuration and persisted its fingerprint, a record this window's seed-once map
	 * predates; the same read serves both, so the two can never disagree, and a stale read can only UNDER-report, never
	 * invent a matching fingerprint (the asymmetry is load-bearing). An unconfirmed duplicate means the host holds the
	 * name for a group this entry does not provably own (the entry changed, the name was taken, or the group was
	 * re-pointed natively) and cannot update or replace it: the refused fingerprint goes into the retry state as
	 * "blocked" (not the map) so unforced passes keep the error without hammering and a forced pass retries after the
	 * user fixes the group.
	 */
	private recordAddFailure(
		entry: DeclaredServer,
		pass: PassState,
		printed: string,
		standing: EntryStanding,
		error: unknown
	): SyncFailure | undefined {
		if (!isDuplicateGroupError(error)) {
			// The set also replaces a stale "blocked", whose unforced-pass shortcut would otherwise skip the retry this
			// failure needs.
			this.carryStoreRecord(entry.label, pass);
			this.retry.set(entry.label, { kind: "upsertFailed", fingerprint: printed });
			this.env.log("Provider group upsert failed", {
				label: entry.label,
				error: errorLabel(error),
			});
			return syncFailureOf("upsertFailed");
		}
		const storeRecord = this.env.getFingerprints()[entry.label];
		const confirmed =
			standing.recordConfirms(pass.previous[entry.label]) ||
			standing.recordConfirms(storeRecord) ||
			standing.servedAsDeclared;
		if (confirmed) {
			// Not logged: every activation's forced pass lands here for every healthy entry. Into the session map at
			// once, like a successful add: a LATER entry's write-through persists a spread of this map, and without the
			// confirmed label it would re-clobber the other window's record mid-pass.
			pass.next[entry.label] = printed;
			pass.synced.add(entry.label);
			this.fingerprints = { ...this.fingerprints, [entry.label]: printed };
			this.retry.delete(entry.label);
			return undefined;
		}
		this.carryLastGood(entry.label, pass.previous, pass.next, storeRecord);
		this.retry.set(entry.label, { kind: "blocked", fingerprint: printed });
		this.env.log("Provider group exists and the host has no update path", { label: entry.label });
		return syncFailureOf("blocked");
	}

	/**
	 * Adds the entry's group through the host: the failure, or undefined when the group landed or a duplicate
	 * confirmed it.
	 */
	private async addEntryGroup(
		entry: DeclaredServer,
		pass: PassState,
		args: Record<string, string>,
		printed: string,
		standing: EntryStanding
	): Promise<SyncFailure | undefined> {
		try {
			await this.env.addProviderGroup(args);
			await this.recordAdd(entry, pass, args, printed);
			return undefined;
		} catch (error) {
			return this.recordAddFailure(entry, pass, printed, standing, error);
		}
	}

	/**
	 * One entry's failure for this pass, or undefined when its group is in sync, landed, or was confirmed. `secrets` is
	 * the blob read for `entry`, `args` the group arguments built from it and `printed` their identity print. Exactly
	 * one branch settles the entry, and only this entry's view reads the failure; what survives between passes is the
	 * retry state, which the failure is recomputed from. Every branch that stops short of the host carries the
	 * last-known-good fingerprint.
	 */
	private async judgeEntry(
		entry: DeclaredServer,
		pass: PassState,
		secrets: EntrySecrets,
		args: Record<string, string>,
		printed: string
	): Promise<SyncFailure | undefined> {
		const retryState = this.retry.get(entry.label);
		const standing = this.entryStanding(entry, printed, retryState);
		if (secrets.kind === "unreadable") {
			// No host call and no retry bookkeeping: the stored retry state stays put on purpose.
			this.carryStoreRecord(entry.label, pass);
			return syncFailureOf("secretsUnreadable");
		}
		if (secrets.refusedFields.length > 0) {
			// The pairing must not reach the host, forced passes included: an activation force-sync is exactly where a
			// delete-failure residual would pair a surviving blob with a re-declared label at another host.
			this.carryStoreRecord(entry.label, pass);
			this.env.log("A stored secret is stamped for a different destination; entry not synced", {
				label: entry.label,
				fields: secrets.refusedFields,
			});
			return syncFailureOf("secretsMismatched");
		}
		if (!pass.saltDurable) {
			// The same skip for a different unusable secret; the next session, keyed by the stored salt, syncs normally.
			this.carryStoreRecord(entry.label, pass);
			return syncFailureOf("saltUnavailable");
		}
		const retryingThisPrint = retryState?.kind === "upsertFailed" && retryState.fingerprint === printed;
		if (!pass.force && standing.recordConfirms(pass.previous[entry.label]) && !retryingThisPrint) {
			// In sync without a call. Credential rotations land here by design: the identity print does not cover them
			// and the overlay serves the current values. An entry stuck on the duplicate error whose last-known-good
			// print matches again was reverted, and a pending retry for some OTHER configuration is moot for the same
			// reason.
			pass.next[entry.label] = printed;
			pass.synced.add(entry.label);
			this.retry.delete(entry.label);
			return undefined;
		}
		if (!pass.force && standing.blockedAsPrinted && !standing.servedAsDeclared) {
			// The error stands: retrying without a user gesture would just hammer the command. The carried print lets
			// a later revert of the entry still match.
			this.carryStoreRecord(entry.label, pass);
			return syncFailureOf("blocked");
		}
		if (!(await this.confirmSaltDurable())) {
			// A store mutation mid-pass must stop further adds.
			this.carryStoreRecord(entry.label, pass);
			return syncFailureOf("saltUnavailable");
		}
		if (!(await this.entryStillCurrent(entry.label, printed))) {
			// The setting was read once at pass start and the secrets just above, so an edit landing in either window
			// would pair a stale entry with fresh secrets (or the reverse).
			this.carryStoreRecord(entry.label, pass);
			this.env.log("Server entry changed mid-pass; group add skipped", { label: entry.label });
			return undefined;
		}
		return this.addEntryGroup(entry, pass, args, printed, standing);
	}

	/**
	 * The entry's view for the dashboard. The same narrowing the provider applies, collected rather than logged: the
	 * dashboard names the dropped credential beside the entry (configDiagnostics.ts), where the user can re-enter it. A
	 * failure the pass already decided outranks the refusal; the field detail rides beside either.
	 */
	private entryView(
		entry: DeclaredServer,
		args: Record<string, string>,
		stored: StoredServerSecrets,
		syncFailure: SyncFailure | undefined
	): DeclaredServerView {
		const parsed = parseGroupConfiguration(args);
		const rejections = parsed?.rejections ?? [];
		const failure = rejections.length > 0 ? (syncFailure ?? syncFailureOf("credentialsRefused")) : syncFailure;
		const identity = declaredGroupIdentity(entry, parsed);
		return {
			...identity,
			...pickNonSecretOptionalFields(entry),
			...pickEntryViewFields(entry),
			secrets: secretLocations(entry, stored),
			rejectedCredentials: rejections.map((rejection) => rejection.field),
			syncFailure: failure,
		};
	}

	/**
	 * Adds the rejected carriers' secret values to the pass's map, so a leftover holding a rejected label's key is that
	 * label's and never an adoptable external row; a failed read keeps the last pass's values.
	 */
	private async collectCarrierSecrets(rawSetting: unknown, pass: PassState): Promise<void> {
		const rawReports = serverSettingReports(rawSetting);
		const carrierInline = rejectedCarrierInlineSecrets(rawSetting, rawReports);
		for (const label of rejectedCarrierLabels(rawReports)) {
			try {
				const record = pass.records.get(label) ?? (await this.env.readSecrets(label));
				pass.secretValues.set(label, [
					...new Set([
						...(pass.secretValues.get(label) ?? []),
						...secretValuesOf(record, carrierInline.get(label) ?? []),
					]),
				]);
			} catch (error) {
				this.carrySecretValues(label, pass);
				this.env.log("Reading a rejected entry's stored secrets failed", { label, error: errorLabel(error) });
			}
		}
	}

	/**
	 * Remembers each view's identity for the removal and rename classification. A pass whose stored secrets did not
	 * all resolve (the read failed, or a stamp refused a value) built its identities over incomplete secrets, not the
	 * live group's, so those views are skipped.
	 */
	private rememberIdentities(views: readonly DeclaredServerView[]): void {
		for (const view of views) {
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
		// `synced` holds the labels whose live group this pass proved at the declared URL (added, confirmed, or in sync
		// without a call); the pass-end ledger records the declared URL for these and the observed or remembered one
		// for the rest. `secretValues` holds secret values by declared label, carriers included, for the dashboard's
		// group ownership, and is published with the views.
		const pass: PassState = {
			force,
			saltDurable,
			previous: this.fingerprints,
			next: {},
			synced: new Set(),
			records: new Map(),
			secretValues: new Map(),
		};
		const views: DeclaredServerView[] = [];
		for (const entry of entries) {
			const secrets = await this.readEntrySecrets(entry, pass);
			const stored = secrets.kind === "read" ? secrets.stored : {};
			const args = buildGroupArgs(entry, stored);
			const printed = groupArgsFingerprint(args);
			const syncFailure = await this.judgeEntry(entry, pass, secrets, args, printed);
			views.push(this.entryView(entry, args, stored, syncFailure));
		}

		await this.collectCarrierSecrets(rawSetting, pass);
		this.rememberIdentities(views);
		try {
			await this.finishPass(rawSetting, entries, views, pass.previous, pass.next, pass.synced);
		} finally {
			// In a finally because a throwing finish must not discard the pass's computed views.
			//
			//   Views -> publish last, after the pass-end reconciliation
			this.views = views;
			// A non-array setting declares every old label and parses no entry, so the pass read no blob; the last
			// pass's records stay until an array reads them again.
			this.secretValues = Array.isArray(rawSetting) ? pass.secretValues : this.secretValues;
		}
	}

	/**
	 * The removal candidates. A label is one on either kind of evidence that a group exists for it: a fingerprint
	 * record (a landed add) or a SESSION ledger record (a proven or observed group identity; an entry whose add the host
	 * refused still has its live group observed). The session ledger, never the merged one: a stale store read can
	 * re-surface a label this session already dropped, and keying on it would fire the removal again. An entry that
	 * never synced AND was never seen served raises no event. Removals still unresolved from earlier passes join this
	 * pass's candidates once more; the setting declaring the label again ends the carry.
	 */
	private removalCandidates(finish: FinishState): string[] {
		const removed = [...new Set([...Object.keys(finish.previous), ...Object.keys(finish.sessionLedger)])].filter(
			(label) => !finish.labelStillPresent(label)
		);
		for (const label of [...this.unresolvedRemovals.keys()]) {
			if (finish.labelStillPresent(label)) {
				this.unresolvedRemovals.delete(label);
			} else if (!removed.includes(label)) {
				removed.push(label);
			}
		}
		return removed;
	}

	/**
	 * Carries the records of present-but-rejected labels into the pass-end maps, and returns the ledger records carried.
	 * The pass-end writes rebuild both maps from the accepted entries, and without this carry a mid-edit malformed entry
	 * would shed its fingerprint (wedging the repaired entry on an unrecognizable duplicate) and its ledger record
	 * (blinding a later real removal). Reserved (prototype-mutating) keys cannot reach these loops: the env filters them
	 * at its read boundary, and the parser rejects them as labels.
	 */
	private carryRejectedRecords(finish: FinishState): Record<string, string> {
		const { previous, next, storeRecords, ledger, acceptedLabels, labelStillPresent } = finish;
		for (const label of new Set([...Object.keys(previous), ...Object.keys(storeRecords)])) {
			if (acceptedLabels.has(label) || !labelStillPresent(label)) {
				continue;
			}
			const carried = previous[label] ?? storeRecords[label];
			if (carried !== undefined && next[label] === undefined) {
				next[label] = carried;
			}
		}
		const carriedLedger: Record<string, string> = {};
		for (const [label, url] of Object.entries(ledger)) {
			if (!acceptedLabels.has(label) && labelStillPresent(label)) {
				carriedLedger[label] = url;
			}
		}
		return carriedLedger;
	}

	/**
	 * Prunes per-label retry state with its entry; the map is keyed by user-controlled labels and would otherwise grow
	 * without bound. Pruned by PRESENCE, never by this pass's acceptance: a mid-edit entry or an unreadable container
	 * must not erase an upsertFailed marker, whose loss would read the restored entry's carried fingerprint as in-sync
	 * and silently skip the retry that failure still needs.
	 */
	private pruneRetries(labelStillPresent: (label: string) => boolean): void {
		for (const label of [...this.retry.keys()]) {
			if (!labelStillPresent(label)) {
				this.retry.delete(label);
			}
		}
	}

	/**
	 * The labels NEW this pass, with the URL each declares: a removed label's host re-declared under one of them reads
	 * as a rename's other half. New means absent from the last valid pass's declaration; a pre-existing entry with no
	 * records (blocked, unreadable secrets) is not new, and before the first valid pass the delta falls back to record
	 * absence.
	 */
	private newLabelsThisPass(entries: readonly DeclaredServer[], finish: FinishState): ReadonlyMap<string, string> {
		const baseline = this.declaredLabelsLastPass;
		return new Map(
			entries
				.filter((entry) =>
					baseline === undefined
						? finish.previous[entry.label] === undefined && finish.sessionLedger[entry.label] === undefined
						: !baseline.has(entry.label)
				)
				.map((entry) => [entry.label, normalizeBaseUrl(entry.baseUrl)])
		);
	}

	/**
	 * The event for one removal candidate, or undefined for a candidate whose group identity is still unresolved and
	 * already carried. A candidate with no known base URL is remembered with this pass's new labels, since a rename's
	 * other half is remembered only within the session. A resolved candidate is a rename when one of the new labels
	 * (of its own detecting pass) declares its URL and shares its identity; otherwise its keys are judged against the
	 * entries present at THIS removal, since a key shared with an entry removed later is tombstoned then.
	 */
	private removalEvent(
		label: string,
		finish: FinishState,
		newLabels: ReadonlyMap<string, string>
	): RemovedEntryEvent | undefined {
		const baseUrl = this.knownBaseUrl(label, finish.ledger);
		const carried = this.unresolvedRemovals.get(label);
		if (baseUrl === undefined) {
			if (carried !== undefined) {
				return undefined;
			}
			this.unresolvedRemovals.set(label, newLabels);
			return { kind: "removed", label, baseUrl, groupIds: [], sharedGroupIds: [] };
		}
		if (finish.ledger[label] === undefined) {
			this.env.log("Removed entry's group identity resolved from the live provider group", { label });
		}
		this.unresolvedRemovals.delete(label);
		const own = this.lastIdentities.get(label);
		this.lastIdentities.delete(label);
		const renamedTo = [...(carried ?? newLabels)].find(
			([newLabel, url]) => url === baseUrl && sameDeclaredIdentity(own, this.lastIdentities.get(newLabel))
		)?.[0];
		if (renamedTo !== undefined) {
			return { kind: "renamed", oldLabel: label, newLabel: renamedTo, baseUrl };
		}
		const presentKeys = new Set(
			[...this.lastIdentities].flatMap(([other, ids]) =>
				finish.declaredLabels.has(other) ? this.identityKeys(ids, finish.snapshots) : []
			)
		);
		const ownKeys = this.identityKeys(own, finish.snapshots);
		return {
			kind: "removed",
			label,
			baseUrl,
			groupIds: ownKeys.filter((key) => !presentKeys.has(key)),
			sharedGroupIds: ownKeys.filter((key) => presentKeys.has(key)),
		};
	}

	/**
	 * Keeps every unresolved removal's fingerprint record (see unresolvedRemovals): the label is not declared, so
	 * nothing else would carry it, and pruning it would leave the next session no candidate.
	 */
	private carryUnresolvedRecords(finish: FinishState): void {
		for (const label of this.unresolvedRemovals.keys()) {
			const carried = finish.previous[label] ?? finish.storeRecords[label];
			if (carried !== undefined && finish.next[label] === undefined) {
				finish.next[label] = carried;
			}
		}
	}

	/**
	 * Persists the pass-end fingerprint map, in memory before the store: session truth must survive a failing (or
	 * later-reverted) storage write. The persist itself is log-only, because a throw here must not abort the
	 * reconciliation that follows; the removal's tombstone and notice would be lost with no later pass able to
	 * rediscover them.
	 */
	private async persistFingerprints(next: Record<string, string>): Promise<void> {
		this.fingerprints = next;
		try {
			await this.env.setFingerprints(next);
		} catch (error) {
			this.env.logError("Persisting the pass-end fingerprint map failed", error);
		}
	}

	/**
	 * Persists the entry identity ledger: the declared URL for the labels this pass proved there, the known URL for the
	 * rest, and the carried records. Never the unproven declared URL: it would make a later removal tombstone a group
	 * that does not exist while the real one keeps serving, and no evidence at all degrades that removal to the honest
	 * untracked notice instead. Session truth before the persist, like the fingerprint map, and log-only like it: the
	 * session ledger already holds the records, so only a NEXT session's removal degrades to the untracked notice.
	 */
	private async persistLedger(
		entries: readonly DeclaredServer[],
		synced: ReadonlySet<string>,
		ledger: Readonly<Record<string, string>>,
		carriedLedger: Readonly<Record<string, string>>
	): Promise<void> {
		try {
			const ledgerEntries = entries.flatMap((entry): [string, string][] => {
				if (synced.has(entry.label)) {
					return [[entry.label, normalizeBaseUrl(entry.baseUrl)]];
				}
				const knownUrl = this.knownBaseUrl(entry.label, ledger);
				return knownUrl === undefined ? [] : [[entry.label, knownUrl]];
			});
			const nextLedger = Object.fromEntries([...ledgerEntries, ...Object.entries(carriedLedger)]);
			this.ledger = nextLedger;
			await this.env.setEntryBaseUrls(nextLedger);
		} catch (error) {
			this.env.logError("Persisting the entry identity ledger failed", error);
		}
	}

	/**
	 * Logs the removals and reconciles the identities with the env. Logged per EMITTED event, not per candidate: a
	 * carried unresolved removal is a candidate on every pass and would otherwise repeat this line into the
	 * issue-report buffer until its observation arrives. There is no programmatic group removal, so the provider groups
	 * survive, and the labels' SecretStorage blobs are kept on purpose. A deferred removal (unresolvedRemovals) keeps
	 * its identity until its observation arrives and classifies it.
	 */
	private async reconcileRemovals(
		views: readonly DeclaredServerView[],
		events: readonly RemovedEntryEvent[],
		finish: FinishState
	): Promise<void> {
		const reported = events.map((event) => (event.kind === "renamed" ? event.oldLabel : event.label));
		if (reported.length > 0) {
			this.env.log("Servers setting entries removed; their provider groups remain", { labels: reported });
		}
		for (const label of [...this.lastIdentities.keys()]) {
			if (!finish.declaredLabels.has(label) && !this.unresolvedRemovals.has(label)) {
				this.lastIdentities.delete(label);
			}
		}
		await this.env.reconcileEntryIdentities(
			views.map(({ label, baseUrl }) => ({
				label,
				baseUrl: normalizeBaseUrl(baseUrl),
				group: this.joinedGroupOf(this.lastIdentities.get(label), finish.snapshots),
			})),
			events
		);
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
		synced: ReadonlySet<string>
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
		// The session ledger is the truth for this pass (see the field's doc); the fresh store read merges underneath
		// it, presence-only. Removal detection uses the shared still-declared predicate: presence, not this pass's
		// acceptance (see stillDeclaredIn), since a tombstone written for a present entry would suppress a group the
		// user did not remove.
		const storedLedger = this.env.getEntryBaseUrls();
		this.ledger ??= { ...storedLedger };
		const finish: FinishState = {
			previous,
			next,
			labelStillPresent: stillDeclaredIn(rawSetting),
			storeRecords: this.env.getFingerprints(),
			sessionLedger: this.ledger,
			ledger: { ...storedLedger, ...this.ledger },
			acceptedLabels: new Set(entries.map((entry) => entry.label)),
			declaredLabels: rawDeclaredLabels(rawSetting),
			snapshots: this.liveSnapshots(),
		};
		const removed = this.removalCandidates(finish);
		const carriedLedger = this.carryRejectedRecords(finish);
		this.pruneRetries(finish.labelStillPresent);
		const newLabels = this.newLabelsThisPass(entries, finish);
		this.declaredLabelsLastPass = rawDeclaredLabels(rawSetting);

		const events: RemovedEntryEvent[] = [];
		for (const label of removed) {
			const event = this.removalEvent(label, finish, newLabels);
			if (event !== undefined) {
				events.push(event);
			}
		}
		this.carryUnresolvedRecords(finish);

		await this.persistFingerprints(next);
		await this.persistLedger(entries, synced, finish.ledger, carriedLedger);
		await this.reconcileRemovals(views, events, finish);
	}
}
