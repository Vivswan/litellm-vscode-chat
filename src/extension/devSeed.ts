import * as vscode from "vscode";
import type { Logger } from "../shared/logger";
import { SERVERS_SETTING_KEY, updateServerSecret } from "./serverSync";

/**
 * One-shot development seeding for `bun run dev:fake`: the launcher script
 * writes this file into the extension development folder, and a
 * development-mode activation consumes it exactly once. The seed lands the
 * same way a user-configured server does: a `litellm-vscode-chat.servers`
 * entry in the user scope (the setting is machine-scoped) plus the API key
 * in the label's SecretStorage blob, and the server sync engine's forced
 * activation pass turns the entry into the provider group. Production
 * activations never look for the file.
 */
export const DEV_SEED_FILENAME = ".dev-fake-seed.json";

export interface DevSeed {
	readonly label: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly openDashboard: boolean;
}

const DEFAULT_SEED_LABEL = "Fake LiteLLM";

export function parseDevSeed(raw: string): DevSeed | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.baseUrl !== "string" || record.baseUrl.trim().length === 0) {
		return undefined;
	}
	// Trimmed like parseServersSetting trims: the label keys the SecretStorage
	// blob and the entry match, so both sides must resolve the same name.
	const label = typeof record.label === "string" ? record.label.trim() : "";
	return {
		label: label.length > 0 ? label : DEFAULT_SEED_LABEL,
		baseUrl: record.baseUrl.trim(),
		apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
		openDashboard: record.openDashboard === true,
	};
}

/** The effects applying a seed needs, injectable for tests; createDevSeedEnv builds the real one. */
export interface DevSeedEnv {
	/** The user-scope servers setting value the seed entry is upserted into. */
	readServersSetting(): unknown;
	writeServersSetting(value: readonly unknown[]): Thenable<void>;
	/** Store the seeded API key in the label's SecretStorage blob; undefined clears a stale one. */
	storeApiKey(label: string, value: string | undefined): Promise<void>;
}

const CONFIG_SECTION = "litellm-vscode-chat";

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
		storeApiKey: (label, value) => updateServerSecret(secrets, label, "apiKey", value),
	};
}

/**
 * The setting array with the seed's entry in place. Entries other than the
 * seed's label survive verbatim (junk included); the seed's own entry is
 * replaced wholesale, so a changed port from a previous run does not linger
 * and the key never sits inline in the setting.
 */
function upsertSeedEntry(raw: unknown, seed: DevSeed): unknown[] {
	const entries: unknown[] = Array.isArray(raw) ? [...raw] : [];
	const entry = { label: seed.label, baseUrl: seed.baseUrl };
	const index = entries.findIndex(
		(candidate) =>
			typeof candidate === "object" &&
			candidate !== null &&
			!Array.isArray(candidate) &&
			typeof (candidate as Record<string, unknown>).label === "string" &&
			((candidate as Record<string, unknown>).label as string).trim() === seed.label
	);
	if (index >= 0) {
		entries[index] = entry;
	} else {
		entries.push(entry);
	}
	return entries;
}

/**
 * The key goes to the secure side before the settings write: the setting is
 * what the sync engine acts on, and by the time it does, the blob must hold
 * the current key. An empty seed key clears a previous run's stored one.
 */
async function applySeed(seed: DevSeed, env: DevSeedEnv): Promise<void> {
	await env.storeApiKey(seed.label, seed.apiKey.length > 0 ? seed.apiKey : undefined);
	await env.writeServersSetting(upsertSeedEntry(env.readServersSetting(), seed));
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
		logger.log("Dev seed applied", { label: seed.label, baseUrl: seed.baseUrl });
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
