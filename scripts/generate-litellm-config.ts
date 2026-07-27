#!/usr/bin/env bun
// scripts/generate-litellm-config.ts
//
// Debugging CLI around scripts/litellmConfig.ts: prints the generated
// LiteLLM config to stdout WITHOUT touching docker/.generated/. It never
// writes, so it can never desync the file on disk from the config a running
// container loaded; the stack-starting paths (scripts/compose.ts `up`,
// scripts/docker-test.ts) write the real file before every start.
//
// Usage:
//   bun run generate-config                       environment-honoring mode
//   bun run generate-config --no-real-providers   the deterministic test mode

import { generateConfig } from "./litellmConfig";

const realProviders = !process.argv.includes("--no-real-providers");
process.stdout.write(generateConfig({ realProviders }));
