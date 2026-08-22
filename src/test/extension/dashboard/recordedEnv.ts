/**
 * Shared fixtures for the executeDashboardIntent suites: a recording
 * IntentEnvironment fake plus the keep-everything secrets directive.
 */

import type { ReplacedEntryIdentity, SaveServerPayload } from "../../../dashboard/endpoints";
import type { AdoptableGroupCredentials } from "../../../extension/dashboard/adopt";
import type { IntentEnvironment } from "../../../extension/dashboard/intents";
import type { DraftConnection } from "../../../extension/dashboard/testDraftConnection";
import type { DeclaredServer } from "../../../extension/servers/serverSync";
import { acceptedEntry, inlineSecretValues, secretLocations } from "../../../extension/servers/serverSync";
import { resolveOwnedSecrets } from "../../../extension/servers/serverSync/secrets";
import type { FeatureModelRef } from "../../../shared/config/settingSpec";
import type { NonSecretOptionalFields } from "../../../shared/serverEntry";
import { pickNonSecretOptionalFields, SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import { recordFromKeys } from "../../../shared/util/json";

export const KEEP_ALL = {
	apiKey: { action: "keep" },
	oauthClientSecret: { action: "keep" },
	virtualKeyValue: { action: "keep" },
} as const;

/** A ReplacedEntryIdentity with every location "none", for hand-built mismatch and gone-entry cases. */
export function replaceIdentity(
	label: string,
	baseUrl: string,
	secrets: Partial<ReplacedEntryIdentity["secrets"]> = {}
): ReplacedEntryIdentity {
	return {
		label,
		baseUrl,
		secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none", ...secrets },
	};
}

/** The non-secret identity fields an edit form of `entry` would display, ready to spread. */
function displayedFields(entry: DeclaredServer): NonSecretOptionalFields & { readonly apiVersion?: string } {
	return {
		...(entry.apiVersion !== undefined ? { apiVersion: entry.apiVersion } : {}),
		...pickNonSecretOptionalFields(entry),
	};
}

/**
 * The identity an open edit form of the env's CURRENT entry under `label`
 * would display, by the production derivation, so intents whose subject is
 * something else can identify the entry they replace without hand-writing
 * locations. Tests about the identity check itself build mismatches by hand
 * (replaceIdentity).
 */
export async function displayedReplace(recorded: RecordedEnv, label: string): Promise<ReplacedEntryIdentity> {
	const match = acceptedEntry(recorded.env.readServersSetting(), label);
	if (match === undefined) {
		throw new Error(`displayedReplace: no accepted entry under "${label}"`);
	}
	return {
		label,
		baseUrl: match.entry.baseUrl,
		...displayedFields(match.entry),
		secrets: secretLocations(
			match.entry,
			resolveOwnedSecrets(match.entry, await recorded.env.readServerSecrets(label)).values
		),
	};
}

/**
 * The blob-free displayed identity for inline-prefill tests: inline fields
 * read "settings", everything else "none" (the prefill's own check never
 * consults the blob).
 */
export function inlineOnlyIdentity(raw: unknown, label: string): ReplacedEntryIdentity {
	const match = acceptedEntry(raw, label);
	if (match === undefined) {
		return replaceIdentity(label, "http://gone.test");
	}
	const inline = inlineSecretValues(match.entry);
	return {
		label,
		baseUrl: match.entry.baseUrl,
		...displayedFields(match.entry),
		secrets: recordFromKeys(SECRET_FIELD_IDS, (field) => (inline[field] !== undefined ? "settings" : "none")),
	};
}

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
	/** The visible litellm-vscode-chat.* values; reads reflect landed writes like the real configuration. */
	settingValues: Map<string, unknown>;
	commands: [string, ...unknown[]][];
	/** Every writeServersSetting call, whole arrays. */
	serverWrites: unknown[][];
	/** Every storeServerSecret call: label, field, value. */
	secretOps: [string, string, string | undefined][];
	/** Every storeServerSecret call's ownership stamp, aligned with secretOps by index. */
	secretOwners: (string | undefined)[];
	/** Every deleteServerSecrets call. */
	secretDeletes: string[];
	/** Every mutation in call order, for atomicity-ordering assertions. */
	ops: string[];
	/** The fake secure store's blobs by label; mutated by the secret operations like the real one. */
	storedSecrets: Map<string, Record<string, string>>;
	/** The fake store's ownership stamps by label, mutated alongside storedSecrets. */
	storedOwners: Map<string, Record<string, string>>;
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
	/** When set, runs after each readServerSecrets call: the seam for injecting a concurrent edit between the plan read and the guarded unit. */
	onSecretsRead?: ((label: string) => void) | undefined;
	/** When set, runs after each successful writeServersSetting with the now-visible array: the seam for injecting a concurrent edit between the write and the cleanup. */
	afterWrite?: (current: unknown[]) => void;
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
	/** Every inlineCompletions feature-probe call's model ref; fimProbeResult/probeError shape the outcome. */
	fimProbes: FeatureModelRef[];
	fimProbeResult: string | undefined;
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
	// The visible setting: reads reflect landed writes, like the real
	// machine-scoped configuration (post-write re-reads must see the write).
	let currentSetting = serversSetting;
	const recorded: RecordedEnv = {
		updates: [],
		removals: [],
		settingValues: new Map(),
		commands: [],
		serverWrites: [],
		secretOps: [],
		secretOwners: [],
		secretDeletes: [],
		ops: [],
		storedSecrets: new Map(),
		storedOwners: new Map(),
		logs: [],
		syncRequests: 0,
		adoptionLookups: [],
		externalLookups: [],
		probes: [],
		probeResult: [],
		fimProbes: [],
		fimProbeResult: undefined,
		hidden: [],
		unhidden: [],
		unhideResult: true,
		catalogRefreshes: 0,
		usageRefreshes: 0,
		env: {
			updateSetting: async (key, value) => {
				recorded.updates.push([key, value]);
				recorded.settingValues.set(key, value);
			},
			removeSetting: async (key) => {
				recorded.removals.push(key);
				recorded.settingValues.delete(key);
			},
			readSetting: (key) => recorded.settingValues.get(key),
			executeCommand: async (command, ...args) => {
				recorded.commands.push([command, ...args]);
			},
			readServersSetting: () => currentSetting,
			writeServersSetting: async (value) => {
				if (recorded.failWrites !== undefined) {
					throw recorded.failWrites;
				}
				recorded.serverWrites.push([...value]);
				recorded.ops.push("write");
				const visible = [...value];
				currentSetting = visible;
				recorded.afterWrite?.(visible);
			},
			storeServerSecret: async (label, field, value, owner) => {
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
				recorded.secretOwners.push(owner);
				recorded.ops.push(`${value === undefined ? "unstore" : "store"}:${label}.${field}`);
				const blob = { ...recorded.storedSecrets.get(label) };
				const owners = { ...recorded.storedOwners.get(label) };
				if (value === undefined) {
					delete blob[field];
					delete owners[field];
				} else {
					blob[field] = value;
					if (owner === undefined) {
						delete owners[field];
					} else {
						owners[field] = owner;
					}
				}
				recorded.storedSecrets.set(label, blob);
				recorded.storedOwners.set(label, owners);
			},
			readServerSecrets: async (label) => {
				const values = { ...recorded.storedSecrets.get(label) };
				const owners = { ...recorded.storedOwners.get(label) };
				recorded.onSecretsRead?.(label);
				return { values, owners };
			},
			deleteServerSecrets: async (label) => {
				if (recorded.failBlobDeletes !== undefined) {
					throw recorded.failBlobDeletes;
				}
				recorded.secretDeletes.push(label);
				recorded.ops.push(`deleteBlob:${label}`);
				recorded.storedSecrets.delete(label);
				recorded.storedOwners.delete(label);
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
			featureProbes: {
				inlineCompletions: async (model: FeatureModelRef) => {
					recorded.fimProbes.push(model);
					if (recorded.probeError !== undefined) {
						throw recorded.probeError;
					}
					return recorded.fimProbeResult;
				},
			},
			log: (message, data) => {
				recorded.logs.push([message, data]);
			},
		},
	};
	return recorded;
}
