import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPO_ROOT } from "../util/repoRoot";
import { CHILD_PROCESS_TIMEOUT_MS } from "./childProcessTimeout";

/**
 * Nothing here spawns git: a scratch git under a leaked GIT_DIR once rewrote the real repository. The bootstrap files
 * under .husky/_ are tracked because husky generates them only on install.
 *
 *   fresh worktree, no bun install  -> the hook refuses and names the fix (7a757c06: it ran no hooks at all)
 *   a hook script's shim            -> exists and is executable (git skips a non-executable hook silently)
 */

/** A deleted hook script leaves nothing to derive a requirement from, so the relied-on hooks are listed here. */
const REQUIRED_HOOKS = ["pre-commit", "commit-msg"];
const HUSKY_DIR = path.join(REPO_ROOT, ".husky");
const shimOf = (hook: string): string => path.join(HUSKY_DIR, "_", hook);

/**
 * Every file in .husky/ needs a shim, a helper parked there included: intersecting with husky's hook-name list instead
 * would silently drop a real git hook husky generates no shim for.
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
			// The shim sources husky's runtime, which runs the hook script with sh -e from the cwd, a scratch directory
			// without node_modules. Scratch HOME keeps ~/.config/husky/init.sh out; unset HUSKY keeps its =0 escape out.
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

	test("every hook script has an executable shim, so git actually invokes it", () => {
		// git skips a shim it cannot execute, and husky's runtime runs the script behind it through `sh -e`, so only the
		// shim's mode matters. Mode bits are a POSIX fact the Windows leg cannot read.
		assert.ok(fs.existsSync(shimOf("h")), "the husky runtime the shims source is missing");
		for (const hook of hookScripts()) {
			assert.ok(fs.existsSync(shimOf(hook)), `.husky/_/${hook} is missing, so git never invokes .husky/${hook}`);
			if (process.platform !== "win32") {
				const mode = fs.statSync(shimOf(hook)).mode & 0o111;
				assert.notStrictEqual(mode, 0, `.husky/_/${hook} must be executable, or git skips .husky/${hook} silently`);
			}
		}
	});
});
