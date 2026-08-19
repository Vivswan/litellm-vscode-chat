import { afterEach, beforeEach, describe, test } from "bun:test";
import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPO_ROOT } from "../util/repoRoot";

/**
 * Pins the hook layer's fail-closed floor. core.hooksPath points at .husky/_,
 * which husky's prepare script generates only when bun install runs in that
 * checkout - so a fresh `git worktree add` used to run ZERO hooks, silently.
 * The fix tracks byte-identical copies of husky's generated bootstrap files,
 * so every checkout has a working hook chain whose first act is the
 * node_modules guard. The required set is derived from the tracked hook
 * scripts rather than listed here: a hook added without its shim is the same
 * silent fail-open this suite exists to close.
 */

/** husky's runtime, sourced by every shim. */
const HUSKY_RUNTIME = ".husky/_/h";

/**
 * The hooks this repository relies on. Derivation cannot supply these: a
 * deleted hook script leaves nothing behind to derive a requirement from, so
 * dropping one - and with it, say, the commit-msg credit check - would read as
 * green. Removing a hook is deliberate and edits this list.
 */
const REQUIRED_HOOKS = [".husky/pre-commit", ".husky/commit-msg"];

/**
 * process.env minus the hook environment (GIT_DIR, GIT_INDEX_FILE, ...) that
 * git exports while this suite itself runs inside a pre-commit hook - leaked,
 * those redirect every spawned git at whatever repository the hook ran in -
 * and minus HUSKY, whose =0 escape would turn the probes into no-ops.
 */
function hostEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_") && key !== "HUSKY") {
			env[key] = value;
		}
	}
	return env;
}

/** hostEnv further isolated from the user's git config and ~/.huskyrc. */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
	const env = hostEnv();
	env.HOME = home;
	env.USERPROFILE = home;
	env.XDG_CONFIG_HOME = path.join(home, "xdg");
	env.GIT_CONFIG_NOSYSTEM = "1";
	// A scratch git must never discover a real repository by walking up.
	env.GIT_CEILING_DIRECTORIES = home;
	return env;
}

/**
 * hostEnv plus the one inherited pointer this repository's own reads must
 * keep: `git commit -a` and `git commit <pathspec>` build the commit in a
 * temporary index (index.lock, next-index-*.lock) and point the hook at it,
 * so .git/index is the stale state under those invocations while GIT_INDEX_FILE
 * names the tree actually being committed. Only the REPO_ROOT reads take this;
 * every temp-repo spawn keeps hostEnv's strip, or it would read this
 * repository's index instead of its own.
 */
function repoIndexEnv(): NodeJS.ProcessEnv {
	const env = hostEnv();
	const inherited = process.env.GIT_INDEX_FILE;
	if (inherited) {
		// git hands it over relative to the worktree top level.
		env.GIT_INDEX_FILE = path.resolve(REPO_ROOT, inherited);
	}
	return env;
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
	const identity = ["-c", "user.name=hooks-test", "-c", "user.email=hooks-test@invalid", "-c", "commit.gpgsign=false"];
	return spawnSync("git", [...identity, ...args], { cwd, env, encoding: "utf8" });
}

function assertOk(result: ReturnType<typeof git>, what: string): void {
	assert.strictEqual(result.status, 0, `${what}: ${result.stdout}${result.stderr}`);
}

/**
 * Every path git tracks under .husky with its index mode, as a fresh checkout
 * would receive it. The index rather than the working tree is the subject
 * throughout this suite: a bad shim can sit staged while bun install restores
 * a good copy on disk, and it is the staged blob that every future worktree
 * checks out. `-z` also spares us git's C-quoting of exotic names.
 */
function trackedHuskyEntries(): ReadonlyMap<string, string> {
	const listed = spawnSync("git", ["-C", REPO_ROOT, "ls-files", "-sz", "--", ".husky"], {
		env: repoIndexEnv(),
		encoding: "utf8",
	});
	assert.strictEqual(listed.status, 0, listed.stderr);
	const entries = new Map<string, string>();
	for (const record of listed.stdout.split("\0").filter(Boolean)) {
		const [meta = "", file = ""] = record.split("\t");
		entries.set(file, meta.split(" ")[0] ?? "");
	}
	return entries;
}

/** A tracked file's staged bytes - what a commit records and a checkout gets. */
function indexBytes(file: string): Buffer {
	const shown = spawnSync("git", ["-C", REPO_ROOT, "show", `:${file}`], { env: repoIndexEnv() });
	assert.strictEqual(shown.status, 0, `git show :${file}: ${shown.stderr}`);
	return shown.stdout;
}

/**
 * The shims a fresh checkout must carry: one per tracked hook script, since
 * git invokes .husky/_/<name> and nothing else. Derived, so adding a hook
 * script without committing its shim fails here instead of silently skipping
 * that hook in every worktree. Deliberately over-strict - a shared helper
 * parked in .husky/ would be demanded a shim it has no use for - because the
 * alternative, intersecting with husky's hook-name list, would silently drop
 * real git hooks husky does not generate a shim for.
 */
function requiredShims(tracked: ReadonlyMap<string, string>): readonly string[] {
	for (const hook of REQUIRED_HOOKS) {
		assert.ok(tracked.has(hook), `${hook} is no longer staged; dropping a hook is deliberate and edits REQUIRED_HOOKS`);
	}
	const hooks = [...tracked.keys()].filter((file) => /^\.husky\/[^/]+$/.test(file));
	return hooks.map((hook) => `.husky/_/${path.basename(hook)}`);
}

/** The shims plus the runtime they source - everything that must be tracked. */
function requiredBootstrap(tracked: ReadonlyMap<string, string>): readonly string[] {
	return [...requiredShims(tracked), HUSKY_RUNTIME];
}

describe("hook layer fails closed", () => {
	// Every write this suite performs must land in a scratch repo under the
	// tmpdir: linked worktrees share one config file, so a stray git config or
	// a git init that inherited GIT_DIR rewrites the state every sibling
	// checkout reads (a leaked GIT_DIR once flipped core.bare there). hostEnv's
	// strip and these scratch repos are the mechanism; this is the proof.
	const sharedConfig = (() => {
		const found = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--git-common-dir"], {
			env: hostEnv(),
			encoding: "utf8",
		});
		assert.strictEqual(found.status, 0, found.stderr);
		return path.join(path.resolve(REPO_ROOT, found.stdout.trim()), "config");
	})();
	let configBefore: string;

	// git rewrites config through a lock file and a rename, so identical bytes
	// do not mean nobody wrote: the inode and timestamps are what catch it. The
	// content is digested rather than embedded because a failing strictEqual
	// prints both operands, and a CI checkout's .git/config carries the job
	// token as an auth extraheader.
	const configFingerprint = (): string => {
		const stat = fs.statSync(sharedConfig);
		const identity = [stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
		return `${identity}:${createHash("sha256").update(fs.readFileSync(sharedConfig)).digest("hex")}`;
	};

	beforeEach(() => {
		configBefore = configFingerprint();
	});

	afterEach(() => {
		assert.strictEqual(
			configFingerprint(),
			configBefore,
			`${sharedConfig} was written; this suite must mutate only the scratch repos it creates under the tmpdir`
		);
	});

	test("a fresh worktree that never ran bun install rejects the commit with an actionable message", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lvt-hooks-"));
		try {
			const env = isolatedEnv(tmp);

			// Reproduce what `git worktree add` checks out: the tracked .husky
			// files, taken from this repository's index at their index modes.
			const tracked = trackedHuskyEntries();
			for (const file of requiredBootstrap(tracked)) {
				assert.ok(
					tracked.has(file),
					`${file} must be tracked, or a fresh worktree silently skips the hook it belongs to`
				);
			}

			const origin = path.join(tmp, "origin");
			fs.mkdirSync(origin);
			for (const [file, mode] of tracked) {
				const dest = path.join(origin, file);
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.writeFileSync(dest, indexBytes(file), { mode: mode === "100755" ? 0o755 : 0o644 });
			}
			assertOk(git(origin, env, "init", "-q", "-b", "main"), "git init");
			assertOk(git(origin, env, "add", "-A"), "git add");
			assertOk(git(origin, env, "commit", "-q", "-m", "seed"), "seed commit");
			// What husky's prepare set in the checkout the worktree was created from.
			assertOk(git(origin, env, "config", "core.hooksPath", ".husky/_"), "git config");

			const worktree = path.join(tmp, "wt");
			assertOk(git(origin, env, "worktree", "add", "-q", "--detach", worktree), "git worktree add");

			const commit = git(worktree, env, "commit", "--allow-empty", "-m", "no-install probe");
			const output = commit.stdout + commit.stderr;
			assert.notStrictEqual(commit.status, 0, `the commit must fail without bun install, got: ${output}`);
			assert.ok(output.includes("Dependencies are missing"), `expected the guard message, got: ${output}`);
			assert.ok(output.includes("bun install"), `the message must name the fix, got: ${output}`);

			// The documented escape hatch still works, which also proves the
			// failure above came from husky's runtime, not from a broken chain.
			const skipped = spawnSync(
				"git",
				["-c", "user.name=hooks-test", "-c", "user.email=hooks-test@invalid", "commit", "--allow-empty", "-m", "skip"],
				{ cwd: worktree, env: { ...env, HUSKY: "0" }, encoding: "utf8" }
			);
			assert.strictEqual(skipped.status, 0, `HUSKY=0 must still bypass: ${skipped.stdout}${skipped.stderr}`);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("the staged bootstrap files are byte-identical to what the installed husky generates", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lvt-hooks-gen-"));
		try {
			const env = isolatedEnv(tmp);
			assertOk(git(tmp, env, "init", "-q"), "git init");
			const bin = path.join(REPO_ROOT, "node_modules", "husky", "bin.js");
			const install = spawnSync(process.execPath, [bin], { cwd: tmp, env, encoding: "utf8" });
			assert.strictEqual(install.status, 0, install.stderr);
			// husky reports failures as stdout text with exit 0; success is empty.
			assert.strictEqual(install.stdout, "", `husky install failed: ${install.stdout}`);

			for (const file of requiredBootstrap(trackedHuskyEntries())) {
				const generatedPath = path.join(tmp, file);
				const drift = `${file} drifted from husky's generated bytes; after a husky upgrade, re-run bun install and commit the rewritten bootstrap files`;
				assert.ok(fs.existsSync(generatedPath), `${drift} (this husky version generates no ${file})`);
				assert.ok(fs.readFileSync(generatedPath).equals(indexBytes(file)), drift);
			}
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("every hook script's shim is staged executable, so git actually invokes them", () => {
		// git silently skips a non-executable hook file; the index mode is what
		// every future checkout receives.
		const tracked = trackedHuskyEntries();
		for (const shim of requiredShims(tracked)) {
			assert.strictEqual(
				tracked.get(shim),
				"100755",
				`${shim} must be staged executable, or the hook it fronts never runs in a fresh checkout`
			);
		}
		assert.ok(tracked.has(HUSKY_RUNTIME), "the husky runtime the shims source must be tracked");

		// Tracked-yet-ignored files are a trap: the initial add needs -f and a
		// future bootstrap file would silently skip adds. Pin the repository's
		// own .gitignore as scoped around the tracked files - checked in a temp
		// repo because the installed checkout also carries husky's generated
		// .husky/_/.gitignore (*), which rightly covers the generated content.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lvt-hooks-ign-"));
		try {
			const env = isolatedEnv(tmp);
			assertOk(git(tmp, env, "init", "-q"), "git init");
			fs.writeFileSync(path.join(tmp, ".gitignore"), indexBytes(".gitignore"));
			const bootstrap = git(tmp, env, "check-ignore", "--no-index", ...requiredBootstrap(tracked));
			assert.strictEqual(
				bootstrap.status,
				1,
				`ignore rules cover: ${bootstrap.stdout}- keep .gitignore's .husky/_ patterns scoped around the tracked files`
			);
			const generated = git(tmp, env, "check-ignore", "--no-index", ".husky/_/husky.sh");
			assert.strictEqual(generated.status, 0, "husky's generated, untracked runtime files must stay ignored");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
