import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPO_ROOT } from "../util/repoRoot";
import { CHILD_PROCESS_TIMEOUT_MS } from "./childProcessTimeout";
import { BUN_TEST_LAUNCHER } from "./launcherEnv";

/** A victim repository with one linked worktree, a fixture directory, and the inner suite, all under one mkdtemp. */
function scenario() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lvt-hermetic-"));
	const victim = path.join(tmp, "victim");
	const fixture = path.join(tmp, "fixture");
	fs.mkdirSync(fixture);
	for (const args of [
		["init", "-q", "-b", "main", victim],
		["-C", victim, "commit", "-q", "--allow-empty", "-m", "seed"],
		["-C", victim, "worktree", "add", "-q", "--detach", path.join(tmp, "wt")],
	]) {
		const result = spawnSync("git", args, { env: process.env, encoding: "utf8" });
		assert.strictEqual(result.status, 0, `git ${args.join(" ")}: ${result.stdout}${result.stderr}`);
	}
	const victimConfig = path.join(victim, ".git", "config");
	const before = fs.readFileSync(victimConfig, "utf8");
	assert.match(before, /bare = false/);
	assert.doesNotMatch(before, /\[user\]/);

	// The exact leak shape: Bun's own spawn, no env argument, so the child gets the environment bun was born with.
	const suite = path.join(tmp, "leak.test.ts");
	fs.writeFileSync(
		suite,
		[
			'import { test } from "bun:test";',
			`const fixture = ${JSON.stringify(fixture)};`,
			'test("init and configure the fixture", () => {',
			'	for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "fixture@example.com"]]) {',
			'		const result = Bun.spawnSync(["git", "-C", fixture, ...args]);',
			"		if (result.exitCode !== 0) {",
			"			throw new Error(result.stderr.toString());",
			"		}",
			"	}",
			"});",
			"",
		].join("\n")
	);

	/** What a hook in the linked worktree exports. */
	const gitdir = path.join(victim, ".git", "worktrees", "wt");
	const hookEnv: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: gitdir, GIT_INDEX_FILE: path.join(gitdir, "index") };
	const victimUnchanged = () => assert.strictEqual(fs.readFileSync(victimConfig, "utf8"), before);
	return { tmp, fixture, suite, hookEnv, victimUnchanged };
}

/** A child bun from the repository root, so bunfig.toml's preload applies to the inner suite. */
function bun(args: readonly string[], env: NodeJS.ProcessEnv) {
	return spawnSync(process.execPath, args, { cwd: REPO_ROOT, env, encoding: "utf8" });
}

/**
 * The incident this rebuilds: the pre-commit hook ran the bun tree from a linked worktree, so GIT_DIR and
 * GIT_INDEX_FILE named `<repository>/.git/worktrees/<name>`; a suite's `git -C <fixture> init` and `config` through
 * Bun.spawnSync with a default env inherited them, and the real repository's shared config came out with
 * core.bare = true and the fixture's identity while the fixture never got a repository of its own. Two scratch
 * repositories stand in: a victim with a linked worktree and a fixture, both under the tmpdir, and the leak shape runs
 * as an inner suite in a child bun with the hook's exports in its environment.
 */
describe("the bun tree's git environment is hermetic", () => {
	test(
		"through the launcher, a fixture's default-env git init and config reach only the fixture",
		() => {
			const { tmp, fixture, suite, hookEnv, victimUnchanged } = scenario();
			try {
				const run = bun([path.join(REPO_ROOT, "scripts", "bun-test.ts"), suite], hookEnv);
				assert.strictEqual(run.status, 0, `inner suite: ${run.stdout}${run.stderr}`);
				victimUnchanged();
				const own = path.join(fixture, ".git", "config");
				assert.ok(fs.existsSync(own), "the fixture got no repository of its own, so git init reached another one");
				assert.match(fs.readFileSync(own, "utf8"), /fixture@example\.com/);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test(
		"a bare bun test is refused before any suite loads",
		() => {
			const { tmp, fixture, suite, hookEnv, victimUnchanged } = scenario();
			try {
				const { [BUN_TEST_LAUNCHER]: _marker, ...bare } = hookEnv;
				const run = bun(["test", suite], bare);
				assert.notStrictEqual(run.status, 0, "a bare bun test ran the suite");
				assert.match(run.stdout + run.stderr, /bun run test:bun/);
				victimUnchanged();
				assert.ok(!fs.existsSync(path.join(fixture, ".git")), "the refused suite still ran its git init");
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		CHILD_PROCESS_TIMEOUT_MS
	);
});
