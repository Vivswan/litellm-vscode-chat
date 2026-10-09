/**
 * Shared fixtures for the serverSync suites: an in-memory SecretStore and a recording ServerSyncEnv whose group
 * operations and removal events the suites inspect.
 */
import type { DeclaredGroupClaim } from "../../../extension/servers/groupRemovals";
import type { RemovedEntryEvent, ServerSyncEnv } from "../../../extension/servers/serverSync/engine";
import type {
	SecretStore,
	StoredSecretOwners,
	StoredServerSecrets,
} from "../../../extension/servers/serverSync/secrets";
import type { ServerModelsSnapshot } from "../../../provider/catalog/statusWindow";

export function makeSecretStore(initial: Record<string, string> = {}): SecretStore & { values: Map<string, string> } {
	const values = new Map(Object.entries(initial));
	return {
		values,
		get: async (key) => values.get(key),
		store: async (key, value) => {
			values.set(key, value);
		},
		delete: async (key) => {
			values.delete(key);
		},
	};
}

export interface Recorded {
	upserts: Record<string, string>[];
	fingerprints: Record<string, string>;
	/** The persisted identity ledger (label -> normalized base URL). */
	entryBaseUrls: Record<string, string>;
	/** Every reconcileEntryIdentities call: the declared identities and the removal events. */
	reconciles: { declared: DeclaredGroupClaim[]; events: RemovedEntryEvent[] }[];
	logged: [string, unknown][];
	loggedErrors: [string, unknown][];
	env: ServerSyncEnv;
	setting: unknown;
	secrets: Record<string, StoredServerSecrets>;
	/** Ownership stamps the fake blob read reports beside the values, by label. */
	secretOwners: Record<string, StoredSecretOwners>;
	/** When set, addProviderGroup rejects for these labels. */
	failLabels: Set<string>;
	/** When set, addProviderGroup rejects these labels the way an add-only host refuses an existing name. */
	duplicateLabels: Set<string>;
	/** When set, the pass-end setFingerprints write rejects with this error. */
	failFingerprintWrites?: Error;
	/** What confirmFingerprintsDurable reports; false models a session-only salt. */
	saltDurable: boolean;
	/** What observedGroupBaseUrls reports per label: the base URLs the host served that label's group at. */
	observedGroups: Record<string, readonly string[]>;
	/** What observedSnapshots reports: the groups the host serves now. */
	liveSnapshots: ServerModelsSnapshot[];
}

export function makeSyncEnv(setting: unknown = [], secrets: Record<string, StoredServerSecrets> = {}): Recorded {
	const recorded: Recorded = {
		upserts: [],
		fingerprints: {},
		entryBaseUrls: {},
		reconciles: [],
		logged: [],
		loggedErrors: [],
		setting,
		secrets,
		secretOwners: {},
		failLabels: new Set(),
		duplicateLabels: new Set(),
		saltDurable: true,
		observedGroups: {},
		liveSnapshots: [],
		env: {
			readServersSetting: () => recorded.setting,
			readSecrets: async (label) => ({
				values: recorded.secrets[label] ?? {},
				owners: recorded.secretOwners[label] ?? {},
			}),
			confirmFingerprintsDurable: async () => recorded.saltDurable,
			addProviderGroup: async (args) => {
				// The name check comes first, as on the host: a taken name is refused before anything else about the
				// add is considered.
				if (recorded.duplicateLabels.has(args.name ?? "")) {
					throw new Error(`Language model group with name ${args.name} already exists for vendor litellm`);
				}
				if (recorded.failLabels.has(args.name ?? "")) {
					throw new Error("host refused the group");
				}
				recorded.upserts.push({ ...args });
			},
			getFingerprints: () => recorded.fingerprints,
			setFingerprints: async (map) => {
				if (recorded.failFingerprintWrites !== undefined) {
					throw recorded.failFingerprintWrites;
				}
				recorded.fingerprints = { ...map };
			},
			getEntryBaseUrls: () => recorded.entryBaseUrls,
			setEntryBaseUrls: async (map) => {
				recorded.entryBaseUrls = { ...map };
			},
			observedGroupBaseUrls: (label) => recorded.observedGroups[label] ?? [],
			observedSnapshots: () => recorded.liveSnapshots,
			reconcileEntryIdentities: async (declared, events) => {
				recorded.reconciles.push({ declared: [...declared], events: [...events] });
			},
			log: (message, data) => {
				recorded.logged.push([message, data]);
			},
			logError: (message, error) => {
				recorded.loggedErrors.push([message, error]);
			},
		},
	};
	return recorded;
}

/**
 * The removal/rename events the recorded env saw, flattened across passes (most passes record none), without the
 * removed entries' group IDs: those are fingerprint-derived, so a suite reads them straight from the reconcile it
 * compares against the captured view.
 */
export function recordedEvents(recorded: Recorded): RemovedEntryEvent[] {
	return recorded.reconciles.flatMap((reconcile) =>
		reconcile.events.map((event) => {
			if (event.kind !== "removed") {
				return event;
			}
			const { groupIds: _groupIds, sharedGroupIds: _sharedGroupIds, ...rest } = event;
			return rest as RemovedEntryEvent;
		})
	);
}
