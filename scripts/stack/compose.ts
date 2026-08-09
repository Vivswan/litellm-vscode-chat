#!/usr/bin/env bun
// scripts/stack/compose.ts
//
// Thin CLI over the resolved compose runtime (Docker or Podman), so every
// package.json script works on either: `bun scripts/stack/compose.ts up -d --wait`.
// The `up` path regenerates the runtime LiteLLM config first - including the
// generation-time GitHub Copilot catalog fetch when a login is seeded - so
// no start can see a stale or missing docker/.generated/litellm-config.yaml;
// other subcommands (down, logs) pass through untouched.

import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runCompose } from "./composeCommand";
import { COPILOT_TOKEN_DIR, ensureGeneratedConfig, fetchCopilotModels } from "./litellmConfig";
import { seedStackUsageBudgetKey } from "./seedUsage";

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	if (args[0] === "up") {
		// Keep the token dir present and owner-only BEFORE compose runs: a
		// missing bind-mount source is otherwise created by the docker daemon,
		// on Linux as root, and a later `bun run copilot-login` hits EACCES.
		const tokenDir = path.join(process.cwd(), COPILOT_TOKEN_DIR);
		mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
		chmodSync(tokenDir, 0o700);
		const { changed } = ensureGeneratedConfig({ realProviders: true, copilotModels: await fetchCopilotModels() });
		// A running litellm container never re-reads its config, so a content
		// change (e.g. after KEEP_DOCKER_STACK=1 left a test-mode stack running)
		// must recreate the service or the old config silently stays in effect.
		if (changed && !args.includes("--force-recreate")) {
			args.push("--force-recreate");
		}
	}
	const code = runCompose(args);
	// A detached `up` (docker:up, the dev launcher) also seeds the stack's
	// usage/budget fixture key; a foreground `up` blocks above until
	// teardown, so there is no stack left to seed by the time it returns.
	// A seed failure warns instead of failing the start: the stack itself is
	// up and serves everything except the usage fixture (the test
	// orchestrator awaits the same seeding and DOES fail hard).
	if (args[0] === "up" && code === 0 && (args.includes("-d") || args.includes("--detach"))) {
		try {
			await seedStackUsageBudgetKey();
		} catch (error) {
			console.warn(
				`[compose] usage/budget fixture seeding failed: ${error instanceof Error ? error.message : error}. ` +
					"The stack is up without it; rerun: bun run docker:up"
			);
		}
	}
	return code;
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.error(error);
		process.exit(1);
	}
);
