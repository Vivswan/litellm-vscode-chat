import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPO_ROOT } from "../util/repoRoot";
import { CHILD_PROCESS_TIMEOUT_MS } from "./childProcessTimeout";

/**
 * The hook layer's fail-closed floor. core.hooksPath points at .husky/_, which husky's prepare script generates only
 * when bun install runs in that checkout, so a fresh `git worktree add` once ran ZERO hooks, silently (7a757c06). The
 * fix tracks husky's generated bootstrap files, so every checkout has a working hook chain whose first act is the
 * node_modules guard. Two facts hold that up and drift silently: the chain refuses a commit in a checkout that never
 * installed, and every shim is tracked and executable (git skips a non-executable hook without a word). The working
 * tree is the subject: nothing in this tree spawns git (noGitSpawn.test.ts says why), and husky rewrites .husky/_ on
 * every install, so the tracked bytes are judged by the developer's `git status`, not here.
 */

/**
 * The hooks this repository relies on. Derivation cannot supply these: a deleted hook script leaves nothing behind to
 * derive a requirement from, so dropping one - and with it, say, the commit-msg credit check - would read as green.
 * Removing a hook is deliberate and edits this list.
 */
const REQUIRED_HOOKS = ["pre-commit", "commit-msg"];
const HUSKY_DIR = path.join(REPO_ROOT, ".husky");
const shimOf = (hook: string): string => path.join(HUSKY_DIR, "_", hook);

/**
 * Every hook script in .husky/, so a hook added without its shim fails here instead of silently skipping in every
 * fresh worktree. Over-strict by design: a helper parked in .husky/ is demanded a shim too, since the alternative,
 * intersecting with husky's hook-name list, would silently drop a real git hook husky generates no shim for.
 */
function hookScripts(): readonly string[] {
	const hooks = fs
		.readdirSync(HUSKY_DIR, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name);
	for (const hook of REQUIRED_HOOKS) {
		assert.ok(hooks.includes(hook), `.husky/${hook} is gone; dropping a hook is deliberate and edits REQUIRED_HOOKS`);
	}
	return hooks;
}

describe("hook layer fails closed", () => {
	test(
		"a checkout that never ran bun install refuses the commit with an actionable message",
		() => {
			// The chain exactly as git runs it, minus git: the tracked shim sources husky's runtime, which runs the hook
			// script with sh -e from the current directory. That directory is a scratch one with no node_modules; HOME is
			// scratch too, so the user's ~/.config/husky/init.sh stays out, and HUSKY is unset, so its =0 escape cannot
			// turn the probe into a no-op.
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lvt-hooks-"));
			try {
				const { HUSKY: _husky, ...env } = process.env;
				const run = spawnSync("sh", [shimOf("pre-commit")], {
					cwd: tmp,
					env: { ...env, HOME: tmp, USERPROFILE: tmp, XDG_CONFIG_HOME: path.join(tmp, "xdg") },
					encoding: "utf8",
				});
				const output = run.stdout + run.stderr;
				assert.strictEqual(run.status, 1, `the hook must refuse without node_modules, got ${run.status}: ${output}`);
				assert.ok(output.includes("Dependencies are missing"), `expected the guard message, got: ${output}`);
				assert.ok(output.includes("bun install"), `the message must name the fix, got: ${output}`);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test("every hook script has a tracked, executable shim, so git actually invokes it", () => {
		// .gitignore excludes husky's generated directory and re-includes the tracked files one by one; a shim without
		// its re-inclusion is untracked, so a fresh worktree never receives it. git skips a shim it cannot execute; the
		// hook script behind it is run through `sh -e` by husky's runtime, so only the shim's mode matters, and mode
		// bits are a POSIX fact the Windows leg cannot read.
		const ignore = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8").split("\n");
		const tracked = (file: string): boolean => ignore.includes(`!.husky/_/${file}`);
		assert.ok(tracked("h"), "the husky runtime the shims source must be re-included in .gitignore");
		assert.ok(fs.existsSync(shimOf("h")), "the husky runtime the shims source is missing");
		for (const hook of hookScripts()) {
			assert.ok(tracked(hook), `.husky/_/${hook} is ignored, so a fresh worktree never receives the shim for ${hook}`);
			assert.ok(fs.existsSync(shimOf(hook)), `.husky/_/${hook} is missing, so git never invokes .husky/${hook}`);
			if (process.platform !== "win32") {
				const mode = fs.statSync(shimOf(hook)).mode & 0o111;
				assert.notStrictEqual(mode, 0, `.husky/_/${hook} must be executable, or git skips .husky/${hook} silently`);
			}
		}
	});
});
