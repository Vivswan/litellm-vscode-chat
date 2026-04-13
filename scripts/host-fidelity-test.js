#!/usr/bin/env node
// scripts/host-fidelity-test.js
// Wrapper for running the host-fidelity tests.
//
// Without arguments: runs against the built-in capture server (deterministic).
// With arguments: runs against a real LiteLLM server via the VS Code LM API.
//
// Usage:
//   bun run host-fidelity-test
//   bun run host-fidelity-test -- <base-url> <api-key-or-> <model-id> [timeout-ms]
//
// Or via environment variables:
//   LITELLM_REAL_BASE_URL=http://localhost:4000 LITELLM_REAL_API_KEY=sk-xxx LITELLM_REAL_MODEL=gpt-4o-mini:cheapest bun run host-fidelity-test

const { execSync } = require("child_process");

// Parse positional args (after --)
const args = process.argv.slice(2);
const baseUrl = args[0] || process.env.LITELLM_REAL_BASE_URL || "";
const apiKeyArg = args[1] || process.env.LITELLM_REAL_API_KEY || "";
const modelId = args[2] || process.env.LITELLM_REAL_MODEL || "";
const timeoutMs = args[3] || process.env.LITELLM_REAL_TIMEOUT || "";
const apiKey = apiKeyArg === "-" ? "" : apiKeyArg;

if (baseUrl) {
	console.log(`Running host-fidelity tests against ${baseUrl}${modelId ? ` with model ${modelId}` : ""}`);
	if (apiKey) {
		console.log("Using API key: [REDACTED]");
	} else {
		console.log("No API key provided");
	}
	process.env.LITELLM_REAL_BASE_URL = baseUrl;
	process.env.LITELLM_REAL_API_KEY = apiKey;
	if (modelId) {
		process.env.LITELLM_REAL_MODEL = modelId;
	}
	if (timeoutMs) {
		process.env.LITELLM_REAL_TIMEOUT = timeoutMs;
	}
} else {
	console.log("Running host-fidelity tests against built-in capture server");
}

try {
	execSync("bun run compile && vscode-test --config .vscode-test.mjs --label host-fidelity", {
		stdio: "inherit",
		env: process.env,
	});
} catch (e) {
	process.exit(e.status || 1);
}
