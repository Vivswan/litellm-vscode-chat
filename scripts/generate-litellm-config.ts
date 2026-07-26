#!/usr/bin/env bun
// scripts/generate-litellm-config.ts
//
// Generates docker/litellm-config.yaml from the shared scenario definitions,
// so the proxy's fake model list can never drift from src/test/scenarios.ts.
//
// Usage:
//   bun run generate-config            regenerate the file
//   bun run generate-config --check    fail (exit 1) when the file is stale

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ScenarioCapabilities } from "../src/test/scenarios";
import { SCENARIO_CAPABILITIES, SCENARIO_NAMES } from "../src/test/scenarios";

const CONFIG_PATH = path.join(process.cwd(), "docker", "litellm-config.yaml");
const FAKE_API_BASE = "http://fake-openai:8080/v1";

/** The fuzzer drives arbitrary shapes through fake/dynamic, so it advertises everything. */
const DYNAMIC_CAPABILITIES: ScenarioCapabilities = { tools: true, vision: true, pdfInput: true, reasoning: true };

function modelInfoLines(capabilities: ScenarioCapabilities): string[] {
	const lines = ["      max_input_tokens: 128000", "      max_output_tokens: 16000", "      max_tokens: 16000"];
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

function fakeModelEntry(name: string, capabilities: ScenarioCapabilities): string {
	return [
		`  - model_name: fake/${name}`,
		"    litellm_params:",
		`      model: openai/${name}`,
		`      api_base: ${FAKE_API_BASE}`,
		"      api_key: fake-key",
		"      # Forward params LiteLLM would otherwise reject for plain openai",
		"      # models; the extension's pass-through contract is under test.",
		'      allowed_openai_params: ["reasoning_effort", "verbosity"]',
		"    model_info:",
		...modelInfoLines(capabilities),
	].join("\n");
}

function realProviderEntry(prefix: string, envVar: string): string {
	return [
		`  - model_name: ${prefix}/*`,
		"    litellm_params:",
		`      model: ${prefix}/*`,
		`      api_key: os.environ/${envVar}`,
	].join("\n");
}

function generateConfig(): string {
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
		return fakeModelEntry(name, capabilities);
	});
	fakeEntries.push(fakeModelEntry("dynamic", DYNAMIC_CAPABILITIES));

	return [
		"# Output of scripts/generate-litellm-config.ts; do not edit the fake",
		"# model entries by hand. After changing src/test/scenarios.ts, run:",
		"#   bun run generate-config",
		"",
		"model_list:",
		"  # Fake scenario models served by the fake-openai container. LiteLLM",
		"  # strips the openai/ prefix, so the backend receives the bare scenario",
		"  # name as the model ID.",
		fakeEntries.join("\n\n"),
		"",
		"  # Optional real providers; keys arrive via .env through docker-compose.",
		"  # Without a key the entry stays registered and fails only when called.",
		realProviderEntry("openai", "OPENAI_API_KEY"),
		realProviderEntry("anthropic", "ANTHROPIC_API_KEY"),
		realProviderEntry("github", "GITHUB_API_KEY"),
		"  # Passthrough for any other provider/model LiteLLM can infer.",
		'  - model_name: "*"',
		"    litellm_params:",
		'      model: "*"',
		"",
		"general_settings:",
		"  master_key: os.environ/LITELLM_MASTER_KEY",
		"",
	].join("\n");
}

function main(): void {
	const expected = generateConfig();
	if (process.argv.includes("--check")) {
		let actual = "";
		try {
			actual = readFileSync(CONFIG_PATH, "utf8");
		} catch {
			console.error(`Missing ${CONFIG_PATH}; run: bun run generate-config`);
			process.exit(1);
		}
		if (actual !== expected) {
			console.error(`Stale ${CONFIG_PATH}; run: bun run generate-config`);
			process.exit(1);
		}
		console.log("docker/litellm-config.yaml is up to date");
		return;
	}
	writeFileSync(CONFIG_PATH, expected);
	console.log(`Wrote ${CONFIG_PATH}`);
}

main();
