import { afterAll, beforeAll, describe, test } from "bun:test";
import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Generator, loadedInputs, stageAll } from "../../../../scripts/dev/staging";
import { CHILD_PROCESS_TIMEOUT_MS } from "../childProcessTimeout";

/**
 * The staging run in a scratch git repository: a dirty output or input, or a refusing render, from any registered
 * generator writes nothing anywhere, and a clean tree writes and stages exactly the outputs whose text changed.
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

/** A repository with one committed input and the two generators' three committed outputs. */
function makeRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-generated-"));
	tempDirs.push(root);
	git(root, "init", "-q");
	fs.mkdirSync(path.join(root, "docs"));
	fs.writeFileSync(path.join(root, "spec.ts"), "export const x = 1;\n");
	fs.writeFileSync(path.join(root, "pkg.json"), "{}\n");
	fs.writeFileSync(path.join(root, "docs", "a.md"), "a\n");
	fs.writeFileSync(path.join(root, "docs", "b.md"), "b\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "fixture");
	return root;
}

function read(root: string, relativePath: string): string {
	return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const INPUTS = ["spec.ts"];

/** The manifest-shaped generator: one output whose rendering differs from the committed text. */
const MANIFEST: Generator = {
	label: "manifest",
	outputs: ["pkg.json"],
	render: () => [{ relativePath: "pkg.json", next: '{"generated":true}\n' }],
};

/** The docs-shaped generator: two outputs, one of which renders unchanged. */
const DOCS: Generator = {
	label: "docs",
	outputs: ["docs/a.md", "docs/b.md"],
	render: () => [
		{ relativePath: "docs/a.md", next: "regenerated\n" },
		{ relativePath: "docs/b.md", next: "b\n" },
	],
};

describe("stageGenerated", () => {
	test(
		"an unstaged edit to an output refuses by name; the same edit staged is accepted",
		() => {
			const root = makeRepo();
			fs.writeFileSync(path.join(root, "docs", "a.md"), "edited\n");
			assert.throws(() => stageAll(root, [DOCS], INPUTS), /docs\/a\.md has unstaged changes/);
			git(root, "add", "docs/a.md");
			assert.deepStrictEqual(stageAll(root, [DOCS], INPUTS), ["docs/a.md"]);
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test(
		"an unstaged edit to an input refuses by name, and an untracked input counts as dirty",
		() => {
			const root = makeRepo();
			fs.writeFileSync(path.join(root, "spec.ts"), "export const x = 2;\n");
			assert.throws(() => stageAll(root, [DOCS], INPUTS), /spec\.ts has unstaged changes/);
			git(root, "add", "spec.ts");
			stageAll(root, [DOCS], INPUTS);
			fs.writeFileSync(path.join(root, "extra.ts"), "export const y = 1;\n");
			assert.throws(() => stageAll(root, [DOCS], [...INPUTS, "extra.ts"]), /extra\.ts has unstaged changes/);
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test(
		"a clean tree writes and stages only the changed outputs of every generator, and a no-op run writes nothing",
		() => {
			const root = makeRepo();
			assert.deepStrictEqual(stageAll(root, [MANIFEST, DOCS], INPUTS), ["pkg.json", "docs/a.md"]);
			assert.strictEqual(read(root, "pkg.json"), '{"generated":true}\n');
			assert.strictEqual(read(root, "docs/a.md"), "regenerated\n");
			assert.strictEqual(git(root, "status", "--porcelain"), "M  docs/a.md\nM  pkg.json\n");
			// A second run with the same rendering writes no file: the mtimes stand and nothing is reported.
			const outputs = [...MANIFEST.outputs, ...DOCS.outputs];
			const mtimes = outputs.map((file) => fs.statSync(path.join(root, file), { bigint: true }).mtimeNs);
			assert.deepStrictEqual(stageAll(root, [MANIFEST, DOCS], INPUTS), []);
			assert.deepStrictEqual(
				outputs.map((file) => fs.statSync(path.join(root, file), { bigint: true }).mtimeNs),
				mtimes
			);
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test(
		"a refusal from a later generator writes and stages nothing from an earlier one",
		() => {
			// The hook once ran the generators as separate steps: with a staged spec edit and an unstaged docs edit, the
			// manifest step wrote and staged its output, then the docs step refused the dirty doc and the commit aborted
			// with package.json already rewritten and staged. Each row stages the spec edit, then makes the second
			// generator refuse one way; the first generator's output must be exactly as committed afterwards.
			const refusals: readonly (readonly [string, (root: string) => Generator, RegExp])[] = [
				[
					"an unstaged edit to its output",
					(root) => {
						fs.writeFileSync(path.join(root, "docs", "a.md"), "a\nstray unstaged line\n");
						return DOCS;
					},
					/docs\/a\.md has unstaged changes/,
				],
				[
					"a render that throws",
					() => ({
						...DOCS,
						render: () => {
							throw new Error("docs/zh-tw/settings.md has neither a marker region nor the table header to stamp");
						},
					}),
					/neither a marker region/,
				],
				[
					"a render naming an output it did not declare",
					() => ({ ...DOCS, render: () => [{ relativePath: "docs/c.md", next: "c\n" }] }),
					/docs rendered docs\/c\.md, which it does not declare as an output/,
				],
			];
			for (const [shape, arrange, message] of refusals) {
				const root = makeRepo();
				fs.writeFileSync(path.join(root, "spec.ts"), "export const x = 2;\n");
				git(root, "add", "spec.ts");
				const docs = arrange(root);
				const before = git(root, "status", "--porcelain");
				assert.throws(() => stageAll(root, [MANIFEST, docs], INPUTS), message, shape);
				assert.strictEqual(read(root, "pkg.json"), "{}\n", `${shape}: the manifest output stays as committed`);
				assert.strictEqual(git(root, "status", "--porcelain"), before, `${shape}: nothing new is staged`);
			}
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test("the loaded inputs are this process's modules under the root, outside node_modules, repo-relative", () => {
		const repoRoot = path.resolve(import.meta.dir, "../../../..");
		const inputs = loadedInputs(repoRoot);
		assert.ok(inputs.includes("scripts/dev/staging.ts"), inputs.join("\n"));
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
