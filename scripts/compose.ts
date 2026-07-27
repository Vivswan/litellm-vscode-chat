#!/usr/bin/env bun
// scripts/compose.ts
//
// Thin CLI over the resolved compose runtime (Docker or Podman), so every
// package.json script works on either: `bun scripts/compose.ts up -d --wait`.
// The `up` path regenerates the runtime LiteLLM config first, so no start
// can see a stale or missing docker/.generated/litellm-config.yaml; other
// subcommands (down, logs) pass through untouched.

import { runCompose } from "./composeCommand";
import { ensureGeneratedConfig } from "./litellmConfig";

const args = process.argv.slice(2);
if (args[0] === "up") {
	const { changed } = ensureGeneratedConfig({ realProviders: true });
	// A running litellm container never re-reads its config, so a content
	// change (e.g. after KEEP_DOCKER_STACK=1 left a test-mode stack running)
	// must recreate the service or the old config silently stays in effect.
	if (changed && !args.includes("--force-recreate")) {
		args.push("--force-recreate");
	}
}
process.exit(runCompose(args));
