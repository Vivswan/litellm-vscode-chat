// scripts/litellmConfig.ts
//
// Builds the runtime LiteLLM proxy config for the local docker stack. The
// file lands in docker/.generated/ (gitignored); the committed source of
// truth is src/test/scenarios.ts. Both stack-starting paths regenerate it
// first - scripts/compose.ts on its `up` subcommand (docker:up, dev:fake)
// and scripts/docker-test.ts (which resolves the compose command itself) -
// so no start can see a stale or missing config. Other compose subcommands
// (down, logs) do not regenerate.
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
import type { ScenarioCapabilities, ScenarioDeployment } from "../src/test/scenarios";
import { SCENARIO_CAPABILITIES, SCENARIO_NAMES } from "../src/test/scenarios";

export { composeSetting };

const FAKE_API_BASE = "http://fake-openai:8080/v1";

/** The limits every single-deployment scenario model advertises. */
const DEFAULT_DEPLOYMENT: ScenarioDeployment = { maxInputTokens: 128000, maxOutputTokens: 16000 };

/** The fuzzer drives arbitrary shapes through fake/dynamic, so it advertises everything. */
const DYNAMIC_CAPABILITIES: ScenarioCapabilities = { tools: true, vision: true, pdfInput: true, reasoning: true };

const REAL_PROVIDERS: ReadonlyArray<{ prefix: string; envVar: string }> = [
	{ prefix: "openai", envVar: "OPENAI_API_KEY" },
	{ prefix: "anthropic", envVar: "ANTHROPIC_API_KEY" },
	{ prefix: "github", envVar: "GITHUB_API_KEY" },
];

export interface GenerateOptions {
	/**
	 * Emit wildcard routes for real providers whose API key is set, plus the
	 * opt-in bare "*" passthrough. The docker test orchestrator passes false
	 * so test config is byte-identical with and without local keys.
	 */
	realProviders: boolean;
}

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

function modelInfoLines(capabilities: ScenarioCapabilities, deployment: ScenarioDeployment): string[] {
	const lines = [
		`      max_input_tokens: ${deployment.maxInputTokens}`,
		`      max_output_tokens: ${deployment.maxOutputTokens}`,
		`      max_tokens: ${deployment.maxOutputTokens}`,
	];
	if (capabilities.tools) {
		lines.push("      supports_function_calling: true", "      supports_tool_choice: true");
	}
	if (capabilities.vision) {
		lines.push("      supports_vision: true");
	}
	if (capabilities.pdfInput) {
		lines.push("      supports_pdf_input: true");
	}
	if (capabilities.reasoning) {
		lines.push("      supports_reasoning: true");
	}
	if (capabilities.promptCaching) {
		lines.push("      supports_prompt_caching: true");
	}
	return lines;
}

function fakeDeploymentEntry(name: string, capabilities: ScenarioCapabilities, deployment: ScenarioDeployment): string {
	return [
		`  - model_name: fake/${name}`,
		"    litellm_params:",
		`      model: openai/${deployment.upstreamModel ?? name}`,
		`      api_base: ${FAKE_API_BASE}`,
		"      api_key: fake-key",
		"      # Forward params LiteLLM would otherwise reject for plain openai",
		"      # models; the extension's pass-through contract is under test.",
		'      allowed_openai_params: ["reasoning_effort", "verbosity"]',
		"    model_info:",
		...modelInfoLines(capabilities, deployment),
	].join("\n");
}

/** One entry per deployment; a multi-deployment scenario becomes a LiteLLM load-balancing group. */
function fakeModelEntry(name: string, capabilities: ScenarioCapabilities): string {
	const deployments = capabilities.deployments ?? [DEFAULT_DEPLOYMENT];
	return deployments.map((deployment) => fakeDeploymentEntry(name, capabilities, deployment)).join("\n\n");
}

function realProviderEntry(prefix: string, envVar: string): string {
	return [
		`  - model_name: ${prefix}/*`,
		"    litellm_params:",
		`      model: ${prefix}/*`,
		`      api_key: os.environ/${envVar}`,
	].join("\n");
}

function realProviderSection(): string[] {
	const envFile = readEnvFile();
	const entries = REAL_PROVIDERS.filter(({ envVar }) => composeSetting(envVar, "", envFile) !== "").map(
		({ prefix, envVar }) => realProviderEntry(prefix, envVar)
	);
	if (composeSetting("LITELLM_WILDCARD_ALL", "", envFile) === "1") {
		entries.push(['  - model_name: "*"', "    litellm_params:", '      model: "*"'].join("\n"));
	}
	if (entries.length === 0) {
		return [];
	}
	return [
		"",
		"  # Real providers whose API key was set at generation time; keys arrive",
		"  # via .env through docker-compose.",
		...entries,
	];
}

export function generateConfig(options: GenerateOptions): string {
	const fakeEntries = SCENARIO_NAMES.map((name) => {
		// Names land in YAML unquoted and become URL path segments on the
		// backend, so keep them to a safe alphabet.
		if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
			throw new Error(`Scenario name "${name}" must match [a-z0-9][a-z0-9-]*`);
		}
		const capabilities = SCENARIO_CAPABILITIES[name];
		if (!capabilities) {
			throw new Error(`Scenario "${name}" has no SCENARIO_CAPABILITIES entry`);
		}
		for (const deployment of capabilities.deployments ?? []) {
			if (deployment.upstreamModel !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(deployment.upstreamModel)) {
				throw new Error(`Upstream model "${deployment.upstreamModel}" must match [a-z0-9][a-z0-9-]*`);
			}
		}
		return fakeModelEntry(name, capabilities);
	});
	fakeEntries.push(fakeModelEntry("dynamic", DYNAMIC_CAPABILITIES));

	return [
		"# Generated at stack startup by scripts/litellmConfig.ts; do not edit.",
		"# The source of truth is src/test/scenarios.ts. Inspect the output with:",
		"#   bun run generate-config",
		"",
		"model_list:",
		"  # Fake scenario models served by the fake-openai container. LiteLLM",
		"  # strips the openai/ prefix, so the backend receives the bare scenario",
		"  # name as the model ID.",
		fakeEntries.join("\n\n"),
		...(options.realProviders ? realProviderSection() : []),
		"",
		"general_settings:",
		"  master_key: os.environ/LITELLM_MASTER_KEY",
		"",
	].join("\n");
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
