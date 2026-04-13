#!/usr/bin/env node
// scripts/real-test.js
// Wrapper for running the live LiteLLM integration tests.
//
// Usage:
//   bun run real-test -- <base-url> <api-key-or-> <model-id> [timeout-ms]
//
// Or via environment variables:
//   LITELLM_REAL_BASE_URL=http://localhost:4000 LITELLM_REAL_API_KEY=sk-xxx LITELLM_REAL_MODEL=gpt-4o-mini:cheapest bun run real-test

const { execSync } = require("child_process");

// Parse positional args (after --)
const args = process.argv.slice(2);
const baseUrl = args[0] || process.env.LITELLM_REAL_BASE_URL;
const apiKeyArg = args[1] || process.env.LITELLM_REAL_API_KEY || "";
const modelId = args[2] || process.env.LITELLM_REAL_MODEL;
const timeoutMs = args[3] || process.env.LITELLM_REAL_TIMEOUT || "";
const apiKey = apiKeyArg === "-" ? "" : apiKeyArg;

if (!baseUrl || !modelId) {
	console.error(`
Usage: bun run real-test -- <base-url> <api-key-or-> <model-id> [timeout-ms]

  base-url    LiteLLM server URL (e.g. http://localhost:4000)
  api-key     API key, or "-" for no key
  model-id    Model ID to test (e.g. gpt-4o-mini:cheapest)
  timeout-ms  Per-test timeout in ms (default: mocha's default)

Environment variable fallbacks:
  LITELLM_REAL_BASE_URL, LITELLM_REAL_API_KEY, LITELLM_REAL_MODEL, LITELLM_REAL_TIMEOUT
`);
	process.exit(1);
}

console.log(`Running real LiteLLM tests against ${baseUrl} with model ${modelId}`);
if (apiKey) {
	console.log("Using API key: [REDACTED]");
} else {
	console.log("No API key provided");
}

// Set env vars for the test process
process.env.LITELLM_REAL_BASE_URL = baseUrl;
process.env.LITELLM_REAL_API_KEY = apiKey;
process.env.LITELLM_REAL_MODEL = modelId;
if (timeoutMs) {
	process.env.LITELLM_REAL_TIMEOUT = timeoutMs;
}

try {
	execSync("bun run compile && vscode-test --config .vscode-test.mjs --label real", {
		stdio: "inherit",
		env: process.env,
	});
} catch (e) {
	process.exit(e.status || 1);
}
