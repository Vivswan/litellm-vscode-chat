import * as vscode from "vscode";
import { CONFIG_SECTION } from "../shared/config/settingSpec";
import {
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	normalizeModelCapabilities,
	normalizeModelParameters,
	SERVERS_SETTING_KEY,
} from "../shared/config/settings";
import { DEV_SEED_FILENAME, type DevSeed, type DevSeedEntry, type DevSeedModels } from "../shared/devSeed";
import type { Logger } from "../shared/logger";
import { isRecord } from "../shared/util/json";
import { updateServerSecret } from "./servers/serverSync";

/**
 * One-shot development seeding for `bun run dev`: the launcher script
 * writes the seed file (shared/devSeed.ts owns the filename and shape) into
 * the extension development folder, and a development-mode activation
 * consumes it exactly once. The seed lands the same way a user-configured
 * server does: `litellm-vscode-chat.servers` entries in the user scope (the
 * setting is machine-scoped) with each API key inline in its entry - the
 * main entry carries the local stack's master key, the demo entries carry
 * the dev usage keys, and the inline form is what the dashboard edit form's
 * prefill exercises - and the server sync engine's forced activation pass
 * turns the entries into provider groups. The seed's global demo records
 * land in the models.parameters / models.capabilities user settings, owning
 * exactly the matcher keys the seed names (sibling keys survive verbatim).
 * Production activations never look for the file.
 */

const DEFAULT_SEED_LABEL = "Fake LiteLLM";

/** The kinds of model-keyed record settings the seed can write. */
type DevSeedRecordKind = "parameters" | "capabilities";

/**
 * Narrow a raw `models`-shaped value (entry-level or the global `records`)
 * to the record-of-records shape, with the same per-entry leniency the
 * settings readers use; an empty result reads as absent.
 */
function parseSeedModels(raw: unknown): DevSeedModels | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const parameters = normalizeModelParameters(raw.parameters);
	const capabilities = normalizeModelCapabilities(raw.capabilities);
	const models = {
		...(Object.keys(parameters).length > 0 ? { parameters } : {}),
		...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
	};
	return Object.keys(models).length > 0 ? models : undefined;
}

/**
 * One extra seed entry, or undefined when the item is unusable. Lenient like
 * the rest of the dev-only path: a malformed item drops itself, never the
 * whole seed.
 */
function parseSeedEntry(raw: unknown): DevSeedEntry | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const label = typeof raw.label === "string" ? raw.label.trim() : "";
	const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
	if (label.length === 0 || baseUrl.length === 0) {
		return undefined;
	}
	const budget =
		typeof raw.budget === "number" && Number.isFinite(raw.budget) && raw.budget > 0 ? raw.budget : undefined;
	const models = parseSeedModels(raw.models);
	return {
		label,
		baseUrl,
		apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
		...(budget !== undefined ? { budget } : {}),
		...(models !== undefined ? { models } : {}),
	};
}

export function parseDevSeed(raw: string): DevSeed | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) {
		return undefined;
	}
	const record = value;
	if (typeof record.baseUrl !== "string" || record.baseUrl.trim().length === 0) {
		return undefined;
	}
	// Trimmed like parseServersSetting trims: the label keys the SecretStorage
	// blob and the entry match, so both sides must resolve the same name.
	const label = typeof record.label === "string" ? record.label.trim() : "";
	const models = parseSeedModels(record.models);
	const entries = Array.isArray(record.entries)
		? record.entries.map(parseSeedEntry).filter((entry): entry is DevSeedEntry => entry !== undefined)
		: [];
	const records = parseSeedModels(record.records);
	return {
		label: label.length > 0 ? label : DEFAULT_SEED_LABEL,
		baseUrl: record.baseUrl.trim(),
		apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
		openDashboard: record.openDashboard === true,
		...(models !== undefined ? { models } : {}),
		...(entries.length > 0 ? { entries } : {}),
		...(records !== undefined ? { records } : {}),
	};
}

/** The effects applying a seed needs, injectable for tests; createDevSeedEnv builds the real one. */
export interface DevSeedEnv {
	/** The user-scope servers setting value the seed entries are upserted into. */
	readServersSetting(): unknown;
	writeServersSetting(value: readonly unknown[]): Thenable<void>;
	/**
	 * Clear the label's secure-side key. Deliberately not a write capability:
	 * every seed key sits inline in its entry, so the dev path can only remove
	 * a previous run's leftover, never plant a secure-side secret.
	 */
	clearApiKey(label: string): Promise<void>;
	/** The user-scope models.parameters / models.capabilities setting value. */
	readModelRecords(kind: DevSeedRecordKind): unknown;
	writeModelRecords(kind: DevSeedRecordKind, value: Readonly<Record<string, unknown>>): Thenable<void>;
}

const RECORD_SETTING_KEYS: Record<DevSeedRecordKind, string> = {
	parameters: MODEL_PARAMETERS_SETTING_KEY,
	capabilities: MODEL_CAPABILITIES_SETTING_KEY,
};

export function createDevSeedEnv(secrets: vscode.SecretStorage): DevSeedEnv {
	return {
		// The effective value, matching what the sync engine reads. The setting is
		// machine-scoped, so no workspace value can enter the merge; what .get()
		// adds over a global-scope inspect is the declared default ([]) and
		// correct machine-scope resolution in remote windows. upsertSeedEntry
		// replaces by label, so writing the merged array back to the global scope
		// is safe.
		readServersSetting: () => vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY),
		writeServersSetting: (value) =>
			vscode.workspace
				.getConfiguration(CONFIG_SECTION)
				.update(SERVERS_SETTING_KEY, value, vscode.ConfigurationTarget.Global),
		clearApiKey: (label) => updateServerSecret(secrets, label, "apiKey", undefined),
		// The GLOBAL value, not the effective one: unlike servers, the record
		// settings are window-scoped, and the seed merges what it reads back
		// into the global scope - an effective read could copy a workspace
		// value into user settings.
		readModelRecords: (kind) =>
			vscode.workspace.getConfiguration(CONFIG_SECTION).inspect(RECORD_SETTING_KEYS[kind])?.globalValue,
		writeModelRecords: (kind, value) =>
			vscode.workspace
				.getConfiguration(CONFIG_SECTION)
				.update(RECORD_SETTING_KEYS[kind], value, vscode.ConfigurationTarget.Global),
	};
}

/** The settings-shaped object one seed entry lands as (key inline, optional budget and models). */
function seedEntryValue(entry: DevSeedEntry): unknown {
	return {
		label: entry.label,
		baseUrl: entry.baseUrl,
		...(entry.apiKey.length > 0 ? { auth: { apiKey: entry.apiKey } } : {}),
		...(entry.budget !== undefined ? { budget: entry.budget } : {}),
		...(entry.models !== undefined ? { models: entry.models } : {}),
	};
}

/** The seed's main entry viewed as a DevSeedEntry, so one upsert path serves it and the extras. */
function mainEntryOf(seed: DevSeed): DevSeedEntry {
	return {
		label: seed.label,
		baseUrl: seed.baseUrl,
		apiKey: seed.apiKey,
		...(seed.models !== undefined ? { models: seed.models } : {}),
	};
}

/**
 * The setting array with one seed entry in place. Entries other than the
 * seed entry's label survive verbatim (junk included); the seed's own entry
 * is replaced wholesale, so a changed port, key, or budget from a previous
 * run does not linger. Keys sit inline in the entries, visible in
 * settings.json like the rest of the seed: the main entry's is the local
 * stack's master key, the demo entries' are the dev usage keys, and inline
 * storage is the case the dashboard edit form's prefill exercises.
 */
function upsertSeedEntry(raw: unknown, entry: DevSeedEntry): unknown[] {
	const entries: unknown[] = Array.isArray(raw) ? [...raw] : [];
	const value = seedEntryValue(entry);
	const index = entries.findIndex(
		(candidate) => isRecord(candidate) && typeof candidate.label === "string" && candidate.label.trim() === entry.label
	);
	if (index >= 0) {
		entries[index] = value;
	} else {
		entries.push(value);
	}
	return entries;
}

/**
 * The global demo records, merged over the current setting: the seed owns
 * exactly the matcher keys it names (re-pinned wholesale, like the entry's
 * label), and every key it does not name is a user record that survives
 * verbatim. No-op when the merge changes nothing, so an unchanged rerun
 * writes no settings.
 */
async function applySeedRecords(records: DevSeedModels | undefined, env: DevSeedEnv): Promise<void> {
	for (const kind of ["parameters", "capabilities"] as const) {
		const seeded = records?.[kind];
		if (seeded === undefined || Object.keys(seeded).length === 0) {
			continue;
		}
		const raw = env.readModelRecords(kind);
		const current: Record<string, unknown> = isRecord(raw) ? raw : {};
		const next = { ...current, ...seeded };
		if (JSON.stringify(next) !== JSON.stringify(current)) {
			await env.writeModelRecords(kind, next);
		}
	}
}

/**
 * The settings writes land first - entries, then the global demo records -
 * and previous runs' secure-side keys are cleared last: the inline keys
 * outrank the blobs, so a failed clear leaves only dormant stale leftovers
 * behind working entries, and cleanup never gates content.
 */
async function applySeed(seed: DevSeed, env: DevSeedEnv): Promise<void> {
	const entries = [mainEntryOf(seed), ...(seed.entries ?? [])];
	let setting = env.readServersSetting();
	for (const entry of entries) {
		setting = upsertSeedEntry(setting, entry);
	}
	await env.writeServersSetting(setting as readonly unknown[]);
	await applySeedRecords(seed.records, env);
	// Every label gets its clear attempted even when an earlier one throws;
	// the first failure still surfaces to the caller's single log site.
	let clearFailure: unknown;
	for (const entry of entries) {
		try {
			await env.clearApiKey(entry.label);
		} catch (error) {
			clearFailure ??= error;
		}
	}
	if (clearFailure !== undefined) {
		throw clearFailure;
	}
}

/**
 * Consume the seed file if present. The delete is the one-shot guarantee, so
 * it happens before anything acts on the contents, and a failed delete
 * aborts the whole seed rather than risking a reseed on every activation.
 * Returns the parsed seed so the caller can act on openDashboard.
 */
export async function consumeDevSeed(
	extensionUri: vscode.Uri,
	env: DevSeedEnv,
	logger: Logger
): Promise<DevSeed | undefined> {
	const seedUri = vscode.Uri.joinPath(extensionUri, DEV_SEED_FILENAME);
	let raw: string;
	try {
		raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(seedUri));
	} catch {
		return undefined;
	}
	try {
		await vscode.workspace.fs.delete(seedUri);
	} catch (error) {
		logger.error("Dev seed aborted: the seed file could not be deleted; remove it by hand", error);
		return undefined;
	}
	const seed = parseDevSeed(raw);
	if (!seed) {
		logger.log("Ignoring malformed dev seed file");
		return undefined;
	}
	try {
		await applySeed(seed, env);
		logger.log("Dev seed applied", {
			label: seed.label,
			baseUrl: seed.baseUrl,
			extraEntries: seed.entries?.length ?? 0,
		});
	} catch (error) {
		// Error severity, classification-only payload: this catch spans the
		// SecretStorage write, and the log buffer feeds public issue reports.
		logger.error(
			"Dev seed could not write the server configuration; configure the server by hand",
			error instanceof Error ? error.name : typeof error
		);
	}
	return seed;
}
