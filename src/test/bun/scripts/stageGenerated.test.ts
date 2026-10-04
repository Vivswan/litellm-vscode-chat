import { afterAll, beforeAll, describe, test } from "bun:test";
import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertStageable, loadedInputs, writeAndStage } from "../../../../scripts/dev/stageGenerated";
import { CHILD_PROCESS_TIMEOUT_MS } from "../childProcessTimeout";

/**
 * The --stage contract in a scratch git repository: a dirty output or input refuses before anything is written, and a
 * clean tree writes and stages exactly the outputs whose text changed.
 */
const tempDirs: string[] = [];

/**
 * A pre-commit hook exports GIT_DIR, GIT_INDEX_FILE, and the other hook variables to everything it runs, and the hook
 * runs this suite. Leaked into a spawned git, they redirect a `-C <scratch>` call at the repository being committed:
 * that happened once, when a scratch `git init`, `git config user.*`, and `git commit` rewrote the real repository's
 * shared config and replaced the branch head with a three-file "fixture" commit. Two defenses, one per spawner:
 *
 * - The fixture's own git runs with every GIT_* variable stripped, the user's and system's config files replaced by
 *   /dev/null, the walk up from the fixture ceilinged at its parent, and the identity passed per command with -c,
 *   never written anywhere.
 * - The helper under test strips GIT_* itself but keeps GIT_INDEX_FILE (in the hook, that is the index being
 *   committed): a relative path resolved against the scratch root names nothing, an absolute one still names the
 *   hook's repository. So the suite removes the hook variables from its own process for its duration and restores
 *   them for the suites that follow in the same runner (hooksFailClosed.test.ts reads GIT_INDEX_FILE).
 */
const hookEnvironment = new Map<string, string>();

beforeAll(() => {
	for (const [name, value] of Object.entries(process.env)) {
		if (name.startsWith("GIT_") && value !== undefined) {
			hookEnvironment.set(name, value);
			delete process.env[name];
		}
	}
});

afterAll(() => {
	for (const [name, value] of hookEnvironment) {
		process.env[name] = value;
	}
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function fixtureEnv(root: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith("GIT_")) {
			env[name] = value;
		}
	}
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	env.GIT_CONFIG_SYSTEM = "/dev/null";
	env.GIT_CEILING_DIRECTORIES = path.dirname(root);
	return env;
}

function git(root: string, ...args: readonly string[]): string {
	return execFileSync("git", ["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: fixtureEnv(root),
	});
}

/** A repository with one committed input and two committed outputs. */
function makeRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-generated-"));
	tempDirs.push(root);
	git(root, "init", "-q");
	fs.mkdirSync(path.join(root, "docs"));
	fs.writeFileSync(path.join(root, "spec.ts"), "export const x = 1;\n");
	fs.writeFileSync(path.join(root, "docs", "a.md"), "a\n");
	fs.writeFileSync(path.join(root, "docs", "b.md"), "b\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "fixture");
	return root;
}

const OUTPUTS = ["docs/a.md", "docs/b.md"];
const INPUTS = ["spec.ts"];

describe("stageGenerated", () => {
	test(
		"an unstaged edit to an output refuses by name; the same edit staged is accepted",
		() => {
			const root = makeRepo();
			fs.writeFileSync(path.join(root, "docs", "a.md"), "edited\n");
			assert.throws(() => assertStageable(root, OUTPUTS, INPUTS), /docs\/a\.md has unstaged changes/);
			git(root, "add", "docs/a.md");
			assertStageable(root, OUTPUTS, INPUTS);
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test(
		"an unstaged edit to an input refuses by name, and an untracked input counts as dirty",
		() => {
			const root = makeRepo();
			fs.writeFileSync(path.join(root, "spec.ts"), "export const x = 2;\n");
			assert.throws(() => assertStageable(root, OUTPUTS, INPUTS), /spec\.ts has unstaged changes/);
			git(root, "add", "spec.ts");
			assertStageable(root, OUTPUTS, INPUTS);
			fs.writeFileSync(path.join(root, "extra.ts"), "export const y = 1;\n");
			assert.throws(() => assertStageable(root, OUTPUTS, [...INPUTS, "extra.ts"]), /extra\.ts has unstaged changes/);
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test(
		"a clean tree writes and stages only the changed output, and a no-op run writes nothing",
		() => {
			const root = makeRepo();
			const files = [
				{ relativePath: "docs/a.md", next: "regenerated\n" },
				{ relativePath: "docs/b.md", next: "b\n" },
			];
			assert.deepStrictEqual(writeAndStage(root, "fixture", files), ["docs/a.md"]);
			assert.strictEqual(fs.readFileSync(path.join(root, "docs", "a.md"), "utf8"), "regenerated\n");
			assert.strictEqual(git(root, "status", "--porcelain"), "M  docs/a.md\n");
			// A second run with the same rendering writes neither file: the mtimes stand and nothing is reported.
			const mtimes = files.map((file) => fs.statSync(path.join(root, file.relativePath), { bigint: true }).mtimeNs);
			assert.deepStrictEqual(writeAndStage(root, "fixture", files), []);
			assert.deepStrictEqual(
				files.map((file) => fs.statSync(path.join(root, file.relativePath), { bigint: true }).mtimeNs),
				mtimes
			);
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test("the loaded inputs are this process's modules under the root, outside node_modules, repo-relative", () => {
		const repoRoot = path.resolve(import.meta.dir, "../../../..");
		const inputs = loadedInputs(repoRoot);
		assert.ok(inputs.includes("scripts/dev/stageGenerated.ts"), inputs.join("\n"));
		assert.ok(inputs.every((file) => !file.includes("node_modules/") && !path.isAbsolute(file)));
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "stage-empty-"));
		tempDirs.push(scratch);
		assert.deepStrictEqual(loadedInputs(scratch), []);
		// The same checkout reached through a symlink lists the same inputs: the module table holds real paths, and
		// a prefix test against the symlinked spelling once listed nothing.
		const link = path.join(scratch, "link");
		fs.symlinkSync(repoRoot, link);
		assert.deepStrictEqual(loadedInputs(link), inputs);
	});
});
