import * as vscode from "vscode";
import { DEV_SEED_FILENAME, type DevSeed } from "../shared/devSeed";
import { isRecord } from "../shared/json";
import type { Logger } from "../shared/logger";
import { CONFIG_SECTION } from "../shared/settingSpec";
import { SERVERS_SETTING_KEY } from "../shared/settings";
import { updateServerSecret } from "./serverSync";

/**
 * One-shot development seeding for `bun run dev`: the launcher script
 * writes the seed file (shared/devSeed.ts owns the filename and shape) into
 * the extension development folder, and a development-mode activation
 * consumes it exactly once. The seed lands the same way a user-configured
 * server does: a `litellm-vscode-chat.servers` entry in the user scope (the
 * setting is machine-scoped) with the API key inline in the entry - it is
 * the local stack's master key, and the inline form is what the dashboard
 * edit form's prefill exercises - and the server sync engine's forced
 * activation pass turns the entry into the provider group. Production
 * activations never look for the file.
 */

const DEFAULT_SEED_LABEL = "Fake LiteLLM";

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
	/**
	 * Clear the label's secure-side key. Deliberately not a write capability:
	 * the seed's key sits inline in the entry, so the dev path can only remove
	 * a previous run's leftover, never plant a secure-side secret.
	 */
	clearApiKey(label: string): Promise<void>;
}

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
	};
}

/**
 * The setting array with the seed's entry in place. Entries other than the
 * seed's label survive verbatim (junk included); the seed's own entry is
 * replaced wholesale, so a changed port or key from a previous run does not
 * linger. The key sits inline in the entry, visible in settings.json like the
 * rest of the seed: it is the local stack's master key, and inline storage is
 * the case the dashboard edit form's prefill exercises.
 */
function upsertSeedEntry(raw: unknown, seed: DevSeed): unknown[] {
	const entries: unknown[] = Array.isArray(raw) ? [...raw] : [];
	const entry = {
		label: seed.label,
		baseUrl: seed.baseUrl,
		...(seed.apiKey.length > 0 ? { apiKey: seed.apiKey } : {}),
	};
	const index = entries.findIndex(
		(candidate) => isRecord(candidate) && typeof candidate.label === "string" && candidate.label.trim() === seed.label
	);
	if (index >= 0) {
		entries[index] = entry;
	} else {
		entries.push(entry);
	}
	return entries;
}

/**
 * The settings write lands first, then a previous run's secure-side key is
 * cleared: the inline key outranks the blob, so a failed clear leaves only a
 * dormant stale leftover behind a working entry.
 */
async function applySeed(seed: DevSeed, env: DevSeedEnv): Promise<void> {
	await env.writeServersSetting(upsertSeedEntry(env.readServersSetting(), seed));
	await env.clearApiKey(seed.label);
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
