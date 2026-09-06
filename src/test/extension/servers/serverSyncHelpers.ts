/**
 * Shared fixtures for the serverSync suites: an in-memory SecretStore and a
 * recording ServerSyncEnv whose group operations and removal events the suites
 * inspect.
 */
import type {
	DeclaredEntryIdentity,
	RemovedEntryEvent,
	SecretStore,
	ServerSyncEnv,
	StoredServerSecrets,
} from "../../../extension/servers/serverSync";

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
	reconciles: { declared: DeclaredEntryIdentity[]; events: RemovedEntryEvent[] }[];
	logged: [string, unknown][];
	loggedErrors: [string, unknown][];
	env: ServerSyncEnv;
	setting: unknown;
	secrets: Record<string, StoredServerSecrets>;
	/** Ownership stamps the fake blob read reports beside the values, by label. */
	secretOwners: Record<string, Partial<Record<"apiKey" | "oauthClientSecret" | "virtualKeyValue", string>>>;
	/** When set, addProviderGroup rejects for these labels. */
	failLabels: Set<string>;
	/** When set, addProviderGroup rejects these labels the way an add-only host refuses an existing name. */
	duplicateLabels: Set<string>;
	/** When set, the pass-end setFingerprints write rejects with this error. */
	failFingerprintWrites?: Error;
	/** What confirmFingerprintsDurable reports; false models a session-only salt. */
	saltDurable: boolean;
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
		env: {
			readServersSetting: () => recorded.setting,
			readSecrets: async (label) => ({
				values: recorded.secrets[label] ?? {},
				owners: recorded.secretOwners[label] ?? {},
			}),
			confirmFingerprintsDurable: async () => recorded.saltDurable,
			addProviderGroup: async (args) => {
				if (recorded.failLabels.has(args.name ?? "")) {
					throw new Error("host refused the group");
				}
				if (recorded.duplicateLabels.has(args.name ?? "")) {
					throw new Error(`Language model group with name ${args.name} already exists for vendor litellm`);
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

/** The removal/rename events the recorded env saw, flattened across passes (most passes record none). */
export function recordedEvents(recorded: Recorded): RemovedEntryEvent[] {
	return recorded.reconciles.flatMap((reconcile) => reconcile.events);
}
