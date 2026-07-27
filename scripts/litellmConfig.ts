// scripts/litellmConfig.ts
//
// IO wrapper for the runtime LiteLLM proxy config: the pure emission lives
// in src/test/fakeStack/proxyConfig.ts (source of truth:
// src/test/fakeStack/models.ts); this module adds
// the .env-aware wildcard lookup and the atomic write to docker/.generated/
// (gitignored). Both stack-starting paths regenerate the file first -
// scripts/compose.ts on its `up` subcommand (docker:up, dev:fake) and
// scripts/docker-test.ts (which resolves the compose command itself) - so no
// start can see a stale or missing config. Other compose subcommands (down,
// logs) do not regenerate.
//
// Wildcard routes to real providers are key-conditional: openai/*,
// anthropic/*, or github/* is emitted only when the matching API key is
// non-empty at generation time (compose precedence: a set shell variable is
// authoritative even when empty, .env fills in only unset ones), and the
// bare "*" passthrough only with LITELLM_WILDCARD_ALL=1. The docker test
// orchestrator generates with realProviders: false, so test runs see the
// same fake-only model list everywhere regardless of local keys.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { composeSetting, parseEnvFile } from "../src/test/envFile";
import type { GenerateOptions } from "../src/test/fakeStack/proxyConfig";
import { generateConfig as emitConfig } from "../src/test/fakeStack/proxyConfig";

export type { GenerateOptions };
export { composeSetting };

/**
 * Read and parse the stack's .env file with the compose-conformant grammar
 * in src/test/envFile.ts (which also names what is deliberately not
 * supported: multi-line quoted values and interpolation). The one shared
 * .env reader for scripts/ - docker-test.ts and dev-fake.ts import it too.
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
 * Write the runtime config to docker/.generated/litellm-config.yaml,
 * creating the directory if needed (docker/ itself holds nothing that is
 * committed, so a fresh clone starts without it). The write is skipped when
 * the content is already on disk, and goes through a same-directory temp
 * file plus rename otherwise, so a concurrently starting container can never
 * read a half-written config.
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
