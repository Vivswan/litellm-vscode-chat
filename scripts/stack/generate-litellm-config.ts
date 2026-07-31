#!/usr/bin/env bun
// scripts/stack/generate-litellm-config.ts
//
// Debugging CLI around scripts/stack/litellmConfig.ts: prints the generated
// LiteLLM config to stdout WITHOUT touching docker/.generated/. It never
// writes, so it can never desync the file on disk from the config a running
// container loaded; the stack-starting paths (scripts/stack/compose.ts `up`,
// scripts/docker-test.ts) write the real file before every start. In the
// environment-honoring mode a seeded Copilot login makes it fetch the live
// catalog from GitHub, so it can take seconds and needs the network.
//
// Usage:
//   bun run generate-config                       environment-honoring mode
//   bun run generate-config --no-real-providers   the deterministic test mode

import { fetchCopilotModels, generateConfig } from "./litellmConfig";

async function main(): Promise<void> {
	const options = process.argv.includes("--no-real-providers")
		? ({ realProviders: false } as const)
		: ({ realProviders: true, copilotModels: await fetchCopilotModels() } as const);
	process.stdout.write(generateConfig(options));
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
