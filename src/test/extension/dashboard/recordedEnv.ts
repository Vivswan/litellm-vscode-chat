/**
 * Shared fixtures for the executeDashboardIntent suites: a recording
 * IntentEnvironment fake plus the keep-everything secrets directive.
 */

import type { SaveServerPayload } from "../../../dashboard/endpoints";
import type { AdoptableGroupCredentials } from "../../../extension/dashboard/adopt";
import type { IntentEnvironment } from "../../../extension/dashboard/intents";
import type { DraftConnection } from "../../../extension/dashboard/testDraftConnection";

export const KEEP_ALL = {
	apiKey: { action: "keep" },
	oauthClientSecret: { action: "keep" },
	virtualKeyValue: { action: "keep" },
} as const;

/**
 * A full SaveServerPayload with the always-sent record and list fields empty.
 * The schema requires those fields, so every minted payload must carry them.
 */
export function serverPayload(
	fields: Partial<SaveServerPayload> & Pick<SaveServerPayload, "label" | "baseUrl">
): SaveServerPayload {
	return {
		modelCapabilities: {},
		expectedFailures: [],
		headers: {},
		declaredModels: [],
		budget: null,
		...fields,
	};
}
export interface RecordedEnv {
	updates: [string, unknown][];
	/** Every removeSetting call (the resetSetting intent's removals). */
	removals: string[];
	commands: [string, ...unknown[]][];
	/** Every writeServersSetting call, whole arrays. */
	serverWrites: unknown[][];
	/** Every storeServerSecret call. */
	secretOps: [string, string, string | undefined][];
	/** Every copyServerSecrets call. */
	secretCopies: [string, string][];
	/** Every deleteServerSecrets call. */
	secretDeletes: string[];
	/** Every mutation in call order, for atomicity-ordering assertions. */
	ops: string[];
	/** The fake secure store's blobs by label; mutated by the secret operations like the real one. */
	storedSecrets: Map<string, Record<string, string>>;
	/** Every env.log call; classifications only. */
	logs: [string, unknown][];
	syncRequests: number;
	/** When set, writeServersSetting rejects with this error. */
	failWrites?: Error;
	/** When set, storeServerSecret rejects with this error on deletes (value === undefined). */
	failUnstore?: Error;
	/** When set, this many delete-side storeServerSecret calls reject before recovering. */
	failUnstoreTimes?: number;
	/** When set, storeServerSecret rejects when storing a value for this field. */
	failStoreField?: string;
	/** When set, deleteServerSecrets rejects with this error. */
	failBlobDeletes?: Error;
	/** What resolveAdoptionCredentials returns; every call is recorded in adoptionLookups. */
	adoptionCredentials?: AdoptableGroupCredentials;
	adoptionLookups: [string, string][];
	/** What resolveExternalGroup returns; every call is recorded in externalLookups. */
	externalGroup?: { label: string; baseUrl: string };
	externalLookups: [string, string][];
	/** Every probeDraftConnection call's resolved connection; probeResult/probeError shape the outcome. */
	probes: DraftConnection[];
	probeResult: readonly string[];
	probeError?: Error;
	/** Every hideGroup call. */
	hidden: { label: string; baseUrl: string }[];
	/** Every unhideGroup call; unhideResult is what the fake reports back. */
	unhidden: { label: string; baseUrl: string }[];
	unhideResult: boolean;
	/** How many refreshCatalogNow kicks arrived (the refreshCatalog intent). */
	catalogRefreshes: number;
	/** How many refreshUsageNow kicks arrived (the refreshUsage intent). */
	usageRefreshes: number;
	env: IntentEnvironment;
}

export function makeEnv(serversSetting: unknown = []): RecordedEnv {
	const recorded: RecordedEnv = {
		updates: [],
		removals: [],
		commands: [],
		serverWrites: [],
		secretOps: [],
		secretCopies: [],
		secretDeletes: [],
		ops: [],
		storedSecrets: new Map(),
		logs: [],
		syncRequests: 0,
		adoptionLookups: [],
		externalLookups: [],
		probes: [],
		probeResult: [],
		hidden: [],
		unhidden: [],
		unhideResult: true,
		catalogRefreshes: 0,
		usageRefreshes: 0,
		env: {
			updateSetting: async (key, value) => {
				recorded.updates.push([key, value]);
			},
			removeSetting: async (key) => {
				recorded.removals.push(key);
			},
			executeCommand: async (command, ...args) => {
				recorded.commands.push([command, ...args]);
			},
			readServersSetting: () => serversSetting,
			writeServersSetting: async (value) => {
				if (recorded.failWrites !== undefined) {
					throw recorded.failWrites;
				}
				recorded.serverWrites.push([...value]);
				recorded.ops.push("write");
			},
			storeServerSecret: async (label, field, value) => {
				if (value === undefined && recorded.failUnstore !== undefined) {
					throw recorded.failUnstore;
				}
				if (value === undefined && (recorded.failUnstoreTimes ?? 0) > 0) {
					recorded.failUnstoreTimes = (recorded.failUnstoreTimes ?? 0) - 1;
					throw new Error("keychain locked");
				}
				if (value !== undefined && recorded.failStoreField === field) {
					throw new Error("keychain locked");
				}
				recorded.secretOps.push([label, field, value]);
				recorded.ops.push(`${value === undefined ? "unstore" : "store"}:${label}.${field}`);
				const blob = { ...recorded.storedSecrets.get(label) };
				if (value === undefined) {
					delete blob[field];
				} else {
					blob[field] = value;
				}
				recorded.storedSecrets.set(label, blob);
			},
			readServerSecrets: async (label) => {
				return { ...recorded.storedSecrets.get(label) };
			},
			copyServerSecrets: async (fromLabel, toLabel) => {
				recorded.secretCopies.push([fromLabel, toLabel]);
				recorded.ops.push(`copy:${fromLabel}->${toLabel}`);
				const source = recorded.storedSecrets.get(fromLabel);
				if (source !== undefined && Object.keys(source).length > 0) {
					recorded.storedSecrets.set(toLabel, { ...source });
				}
			},
			deleteServerSecrets: async (label) => {
				if (recorded.failBlobDeletes !== undefined) {
					throw recorded.failBlobDeletes;
				}
				recorded.secretDeletes.push(label);
				recorded.ops.push(`deleteBlob:${label}`);
				recorded.storedSecrets.delete(label);
			},
			requestServerSync: () => {
				recorded.syncRequests += 1;
			},
			refreshCatalogNow: () => {
				recorded.catalogRefreshes += 1;
			},
			refreshUsageNow: () => {
				recorded.usageRefreshes += 1;
			},
			resolveAdoptionCredentials: (baseUrl, sourceHandle) => {
				recorded.adoptionLookups.push([baseUrl, sourceHandle]);
				return recorded.adoptionCredentials;
			},
			resolveExternalGroup: (baseUrl, sourceHandle) => {
				recorded.externalLookups.push([baseUrl, sourceHandle]);
				return recorded.externalGroup;
			},
			hideGroup: async (identity) => {
				recorded.hidden.push({ ...identity });
			},
			unhideGroup: async (identity) => {
				recorded.unhidden.push({ ...identity });
				return recorded.unhideResult;
			},
			probeDraftConnection: async (connection) => {
				recorded.probes.push(connection);
				if (recorded.probeError !== undefined) {
					throw recorded.probeError;
				}
				return recorded.probeResult;
			},
			log: (message, data) => {
				recorded.logs.push([message, data]);
			},
		},
	};
	return recorded;
}
