import * as vscode from "vscode";
import type { Logger } from "../shared/logger";

/**
 * One-shot development seeding for `bun run dev:fake`: the launcher script
 * writes this file into the extension development folder, and a
 * development-mode activation consumes it exactly once, creating the
 * VS Code-managed provider group directly through the host's own command
 * (which upserts by group name, so changed ports or keys update the group
 * on the next run) and optionally opening the dashboard. Production
 * activations never look for the file.
 */
export const DEV_SEED_FILENAME = ".dev-fake-seed.json";

export interface DevSeed {
	readonly label: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly openDashboard: boolean;
}

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
	return {
		label: typeof record.label === "string" && record.label.trim().length > 0 ? record.label : "Fake LiteLLM",
		baseUrl: record.baseUrl.trim(),
		apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
		openDashboard: record.openDashboard === true,
	};
}

/** Creates the provider group for a seed; the default implementation calls the host's group command. */
export type AddProviderGroup = (seed: DevSeed) => Thenable<unknown>;

export const addProviderGroupViaHost: AddProviderGroup = (seed) =>
	vscode.commands.executeCommand("lm.addLanguageModelsProviderGroup", {
		name: seed.label,
		vendor: "litellm",
		baseUrl: seed.baseUrl,
		apiKey: seed.apiKey,
	});

/**
 * Consume the seed file if present. The delete is the one-shot guarantee, so
 * it happens before anything acts on the contents, and a failed delete
 * aborts the whole seed rather than risking a reseed on every activation.
 * Returns the parsed seed so the caller can act on openDashboard.
 */
export async function consumeDevSeed(
	extensionUri: vscode.Uri,
	addGroup: AddProviderGroup,
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
		await addGroup(seed);
		logger.log("Dev seed applied", { label: seed.label, baseUrl: seed.baseUrl });
	} catch (error) {
		logger.error("Dev seed could not create the provider group; configure the server by hand", error);
	}
	return seed;
}
