#!/usr/bin/env bun
// Starts `bun test` for the bun tree (src/test/bun) inside a hermetic git environment. Every argument is forwarded, so
// `bun run test:bun <file> -t <name> --coverage ...` reads like the bare command.
//
// Why a launcher and not the preload: Bun.spawn and Bun.spawnSync with a default env hand the child the environment
// the bun process was born with, not process.env as later mutated, so a scrub inside the test process reaches
// node:child_process callers and misses Bun's own spawns. The pre-commit hook runs this tree with git's hook exports
// still set (GIT_INDEX_FILE always, GIT_DIR when the commit happens in a linked worktree), and a suite's
// `git -C <fixture> init` under that leaked GIT_DIR once rewrote the real repository's shared config to
// core.bare = true, which refused every work-tree operation until repaired by hand. Built before bun starts, the
// environment below is what every spawn of either kind inherits; preload.ts refuses a run without the marker, so a
// bare `bun test` cannot bypass it.

import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { BUN_TEST_LAUNCHER, HOOK_GIT_INDEX_FILE } from "../src/test/bun/launcherEnv";

const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Every GIT_* variable goes (the hook's exports among them), the global and system config read as empty, upward
 * repository discovery stops below the tmpdir (every fixture lives there) and below this repository, and the commit
 * identity is fixed. The one export a suite still needs, GIT_INDEX_FILE (hooksFailClosed reads the tree being
 * committed, not .git/index), survives under the stash name.
 */
function hermeticEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) {
			env[key] = value;
		}
	}
	if (process.env.GIT_INDEX_FILE !== undefined) {
		env[HOOK_GIT_INDEX_FILE] = process.env.GIT_INDEX_FILE;
	}
	return Object.assign(env, {
		[BUN_TEST_LAUNCHER]: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CEILING_DIRECTORIES: [os.tmpdir(), path.dirname(REPO_ROOT)].join(path.delimiter),
		GIT_AUTHOR_NAME: "fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.com",
		GIT_COMMITTER_NAME: "fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.com",
	});
}

const result = spawnSync(process.execPath, ["test", ...process.argv.slice(2)], {
	cwd: REPO_ROOT,
	env: hermeticEnv(),
	stdio: "inherit",
});
process.exit(result.status ?? 1);
