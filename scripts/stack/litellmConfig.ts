// scripts/stack/litellmConfig.ts
//
// IO wrapper for the runtime LiteLLM proxy config: the pure emission lives
// in src/test/fakeStack/proxyConfig.ts (source of truth:
// src/test/fakeStack/models.ts); this module adds the .env-aware wildcard
// lookup and the atomic write to docker/.generated/ (gitignored). Both
// stack-starting paths regenerate the file first - scripts/stack/compose.ts
// on its `up` subcommand and scripts/docker-test.ts - so no start can see a
// stale or missing config. Other compose subcommands do not regenerate.
//
// Wildcard routes to real providers are key-conditional: openai/* or
// anthropic/* is emitted only when the matching API key is non-empty at
// generation time (compose precedence: a set shell variable is authoritative
// even when empty, .env fills in only unset ones), and the bare "*"
// passthrough only with LITELLM_WILDCARD_ALL=1. The docker test orchestrator
// generates with realProviders: false, so test runs see the same fake-only
// model list everywhere regardless of local keys.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { composeSetting, parseEnvFile, STACK_DEFAULTS } from "../../src/test/envFile";
import type { CopilotModel, GenerateOptions } from "../../src/test/fakeStack/proxyConfig";
import {
	COPILOT_TOKEN_DIR,
	generateConfig as emitConfig,
	parseCopilotCatalog,
} from "../../src/test/fakeStack/proxyConfig";

export type { GenerateOptions };
export { COPILOT_TOKEN_DIR, composeSetting, STACK_DEFAULTS };

/**
 * The well-known first-party Copilot editor client id (with the matching
 * Editor-Version/Copilot-Integration-Id headers below) that third-party
 * tools reuse to reach the Copilot API. GitHub's Copilot terms can treat
 * use outside a supported client as unauthorized; running copilot-login is
 * the account owner's deliberate acceptance of that risk.
 */
export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

const COPILOT_FETCH_TIMEOUT_MS = 15_000;

/**
 * The generation-time Copilot catalog fetch: cached device-flow token ->
 * short-lived Copilot key -> live model list. Returns [] when no login has
 * been seeded (the common case); every other failure is loud but non-fatal,
 * so the stack still starts and serves the fake catalog without
 * github_copilot routes.
 */
export async function fetchCopilotModels(): Promise<CopilotModel[]> {
	try {
		const tokenPath = path.join(process.cwd(), COPILOT_TOKEN_DIR, "access-token");
		if (!existsSync(tokenPath)) {
			return [];
		}
		const accessToken = readFileSync(tokenPath, "utf8").trim();
		const exchange = await fetch("https://api.github.com/copilot_internal/v2/token", {
			headers: { Authorization: `token ${accessToken}` },
			signal: AbortSignal.timeout(COPILOT_FETCH_TIMEOUT_MS),
		});
		if (!exchange.ok) {
			throw new Error(`token exchange returned HTTP ${exchange.status}; re-run: bun run copilot-login`);
		}
		const { token } = (await exchange.json()) as { token?: string };
		if (typeof token !== "string") {
			throw new Error("token exchange response carried no token; re-run: bun run copilot-login");
		}
		const catalog = await fetch("https://api.githubcopilot.com/models", {
			headers: {
				Authorization: `Bearer ${token}`,
				"Editor-Version": "vscode/1.99.0",
				"Copilot-Integration-Id": "vscode-chat",
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(COPILOT_FETCH_TIMEOUT_MS),
		});
		if (!catalog.ok) {
			throw new Error(`catalog fetch returned HTTP ${catalog.status}`);
		}
		const { models, rejected } = parseCopilotCatalog(await catalog.json());
		if (rejected.length > 0) {
			console.warn(`[litellm-config] ${rejected.length} copilot catalog entries skipped: ${rejected.join(", ")}`);
		}
		if (models.length === 0) {
			throw new Error("catalog returned no usable models");
		}
		return models;
	} catch (error) {
		console.warn(
			`[litellm-config] github_copilot routes skipped: ${error instanceof Error ? error.message : error}. ` +
				"The regenerated config carries no github_copilot entries until the next successful stack start."
		);
		return [];
	}
}

/**
 * Read and parse the stack's .env file with the compose-conformant grammar in
 * src/test/envFile.ts (which also names what is deliberately not supported).
 * The one shared .env reader for scripts/.
 */
export function readEnvFile(): Record<string, string> {
	const envPath = path.join(process.cwd(), ".env");
	if (!existsSync(envPath)) {
		return {};
	}
	return parseEnvFile(readFileSync(envPath, "utf8"));
}

/** The pure emission, bound to the real environment (process.env over .env, compose semantics). */
export function generateConfig(options: GenerateOptions): string {
	const envFile = readEnvFile();
	return emitConfig(options, (name) => composeSetting(name, "", envFile));
}

export interface GeneratedConfig {
	/** Absolute path of the generated file. */
	path: string;
	/**
	 * Whether this call changed the file's content (or created it). A running
	 * litellm container never re-reads its config, so a content change means
	 * the caller must recreate the service for the new config to apply.
	 */
	changed: boolean;
}

/**
 * Write the runtime config to docker/.generated/litellm-config.yaml, creating
 * the directory if needed (gitignored, so a fresh clone starts without it).
 * The write is skipped when the content is already on disk, and goes through
 * a same-directory temp file plus rename otherwise, so a concurrently
 * starting container can never read a half-written config.
 */
export function ensureGeneratedConfig(options: GenerateOptions): GeneratedConfig {
	const configPath = path.join(process.cwd(), "docker", ".generated", "litellm-config.yaml");
	const content = generateConfig(options);
	let previous: string | undefined;
	try {
		previous = readFileSync(configPath, "utf8");
	} catch {
		// Missing or unreadable counts as changed; the write below settles it.
	}
	if (previous === content) {
		return { path: configPath, changed: false };
	}
	mkdirSync(path.dirname(configPath), { recursive: true });
	const tempPath = `${configPath}.tmp-${process.pid}`;
	writeFileSync(tempPath, content);
	renameSync(tempPath, configPath);
	return { path: configPath, changed: true };
}
