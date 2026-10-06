import * as vscode from "vscode";
import type { KeyedSettingId } from "../shared/config/settingSpec";
import {
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	normalizeModelCapabilities,
	normalizeModelParameters,
} from "../shared/config/settings";
import { DEV_SEED_FILENAME, type DevSeed, type DevSeedEntry, type DevSeedModels } from "../shared/devSeed";
import type { Logger } from "../shared/logger";
import { errorLabel } from "../shared/util/errorLabel";
import { trimHttpWhitespace } from "../shared/util/headers";
import { isRecord } from "../shared/util/json";
import { updateServerSecret } from "./servers/serverSync";
import { createSettingsAccess } from "./settingsAccess";
import type { ServersSettingStore } from "./settingsWriteTurn";
import { writeServersSettingFrom } from "./settingsWriteTurn";

/**
 * The `bun run dev` launcher writes the seed file (shared/devSeed.ts owns its name and shape) into the extension
 * folder, and extension.ts reads it only outside Production mode. Seed API keys land inline in their entries on
 * purpose, since that is the case the dashboard edit form's prefill exercises.
 */

const DEFAULT_SEED_LABEL = "Fake LiteLLM";

type DevSeedRecordKind = "parameters" | "capabilities";

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

function parseSeedEntry(raw: unknown): DevSeedEntry | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const label = typeof raw.label === "string" ? trimHttpWhitespace(raw.label) : "";
	const baseUrl = typeof raw.baseUrl === "string" ? trimHttpWhitespace(raw.baseUrl) : "";
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
	if (typeof record.baseUrl !== "string" || trimHttpWhitespace(record.baseUrl).length === 0) {
		return undefined;
	}
	// Trimmed like parseServersSetting trims: the label keys the SecretStorage blob and the entry match, so both sides
	// must resolve the same name.
	const label = typeof record.label === "string" ? trimHttpWhitespace(record.label) : "";
	const models = parseSeedModels(record.models);
	const entries = Array.isArray(record.entries)
		? record.entries.map(parseSeedEntry).filter((entry): entry is DevSeedEntry => entry !== undefined)
		: [];
	const records = parseSeedModels(record.records);
	return {
		label: label.length > 0 ? label : DEFAULT_SEED_LABEL,
		baseUrl: trimHttpWhitespace(record.baseUrl),
		apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
		openDashboard: record.openDashboard === true,
		...(models !== undefined ? { models } : {}),
		...(entries.length > 0 ? { entries } : {}),
		...(records !== undefined ? { records } : {}),
	};
}

export interface DevSeedEnv extends ServersSettingStore {
	/**
	 * Deliberately not a write capability: every seed key sits inline in its entry, so the dev path can only remove a
	 * previous run's leftover, never plant a secure-side secret.
	 */
	clearApiKey(label: string): Promise<void>;
	readModelRecords(kind: DevSeedRecordKind): unknown;
	writeModelRecords(kind: DevSeedRecordKind, value: Readonly<Record<string, unknown>>): Thenable<void>;
}

const RECORD_SETTING_KEYS: Record<DevSeedRecordKind, KeyedSettingId> = {
	parameters: MODEL_PARAMETERS_SETTING_KEY,
	capabilities: MODEL_CAPABILITIES_SETTING_KEY,
};

export function createDevSeedEnv(secrets: vscode.SecretStorage): DevSeedEnv {
	const settings = createSettingsAccess();
	return {
		readServersSetting: () => settings.readServersSetting(),
		writeServersSetting: (write) => settings.writeServersSetting(write),
		clearApiKey: (label) => updateServerSecret(secrets, label, "apiKey", undefined, undefined),
		// The GLOBAL value, not the effective one: the record settings are window-scoped and the seed merges what it
		// reads back into the global scope, so an effective read could copy a workspace value into user settings.
		readModelRecords: (kind) => settings.readGlobal(RECORD_SETTING_KEYS[kind]),
		writeModelRecords: (kind, value) => settings.writeGlobal(RECORD_SETTING_KEYS[kind], value),
	};
}

function seedEntryValue(entry: DevSeedEntry): unknown {
	return {
		label: entry.label,
		baseUrl: entry.baseUrl,
		...(entry.apiKey.length > 0 ? { auth: { apiKey: entry.apiKey } } : {}),
		...(entry.budget !== undefined ? { budget: entry.budget } : {}),
		...(entry.models !== undefined ? { models: entry.models } : {}),
	};
}

function mainEntryOf(seed: DevSeed): DevSeedEntry {
	return {
		label: seed.label,
		baseUrl: seed.baseUrl,
		apiKey: seed.apiKey,
		...(seed.models !== undefined ? { models: seed.models } : {}),
	};
}

/**
 * Entries under other labels survive verbatim (junk included); the seed's own entry is replaced wholesale, so a changed
 * port, key, or budget from a previous run does not linger.
 */
function upsertSeedEntry(raw: unknown, entry: DevSeedEntry): unknown[] {
	const entries: unknown[] = Array.isArray(raw) ? [...raw] : [];
	const value = seedEntryValue(entry);
	const index = entries.findIndex(
		(candidate) =>
			isRecord(candidate) && typeof candidate.label === "string" && trimHttpWhitespace(candidate.label) === entry.label
	);
	if (index >= 0) {
		entries[index] = value;
	} else {
		entries.push(value);
	}
	return entries;
}

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
 *   the inline keys outrank the blobs -> Settings writes land first, previous runs' secure-side keys are cleared last
 *   cleanup -> never gates content
 */
async function applySeed(seed: DevSeed, env: DevSeedEnv): Promise<void> {
	const entries = [mainEntryOf(seed), ...(seed.entries ?? [])];
	await writeServersSettingFrom(env, (fresh) => {
		let setting: unknown[] = [...fresh];
		for (const entry of entries) {
			setting = upsertSeedEntry(setting, entry);
		}
		return setting;
	});
	await applySeedRecords(seed.records, env);
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
 * The delete is the one-shot guarantee, so it happens before anything acts on the contents, and a failed delete aborts
 * the seed rather than risking a reseed on every activation.
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
		// Error severity, classification-only payload: this catch spans the SecretStorage write, and the log buffer
		// feeds public issue reports.
		logger.error("Dev seed could not write the server configuration; configure the server by hand", errorLabel(error));
	}
	return seed;
}
