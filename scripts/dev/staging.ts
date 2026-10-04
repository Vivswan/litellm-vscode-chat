/**
 * The staging contract the pre-commit hook's one run (scripts/dev/stageGenerated.ts) executes over every registered
 * generator: every preflight (unstaged outputs, unstaged inputs) and every render happen before any write, then the
 * changed outputs of all generators are written and staged together. One run rather than one per generator, because
 * a generator that writes before a later one refuses would leave its output rewritten and staged inside a commit the
 * hook then aborts. The git calls, the path handling, and the refusal messages live here so the hook stays one bun
 * invocation with no shell logic.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface GeneratedFile {
	/** Repo-relative, forward slashes. */
	readonly relativePath: string;
	readonly next: string;
}

/** One producer of committed generated files. Listing it in the entry's registration is the whole wiring. */
export interface Generator {
	/** The prefix of every line printed for this generator's files. */
	readonly label: string;
	/** Repo-relative output paths; the dirty-output refusal covers exactly these, so `render` returns no other path. */
	readonly outputs: readonly string[];
	/** Every output's regenerated text, read against the files under `root`. Throws rather than returning a partial. */
	render(root: string): readonly GeneratedFile[];
}

/**
 * The environment every git here runs with: process.env minus the hook variables (GIT_DIR, GIT_WORK_TREE, ...) git
 * exports to a pre-commit hook, which would otherwise redirect a `-C root` call at whatever repository the hook ran
 * in. The one pointer kept is GIT_INDEX_FILE: `git commit -a` and `git commit <pathspec>` build the commit in a
 * temporary index and hand the hook its path relative to the worktree top level, and that index is the one these
 * calls must read and stage into, or the regenerated file would miss the commit it was made for. A relative path is
 * resolved against `root`; an absolute one is kept as given.
 */
function gitEnv(root: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith("GIT_")) {
			env[name] = value;
		}
	}
	const inherited = process.env.GIT_INDEX_FILE;
	if (inherited !== undefined && inherited !== "") {
		env.GIT_INDEX_FILE = path.resolve(root, inherited);
	}
	return env;
}

function git(root: string, args: readonly string[]): string {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: gitEnv(root),
	});
}

/**
 * The paths among `relativePaths` with an unstaged modification or no tracking at all: a porcelain line whose worktree
 * column is not a space. A staged change alone is fine (it is going into the commit, and the worktree agrees with the
 * index for that file).
 */
function unstagedAmong(root: string, relativePaths: readonly string[]): string[] {
	if (relativePaths.length === 0) {
		return [];
	}
	const porcelain = git(root, ["status", "--porcelain", "--untracked-files=all", "--", ...relativePaths]);
	const dirty: string[] = [];
	for (const line of porcelain.split("\n")) {
		if (line.length < 4) {
			continue;
		}
		const worktreeColumn = line[1];
		if (worktreeColumn !== " ") {
			// A rename reads "R  old -> new"; the path we asked about is the new one.
			const rawPath = line.slice(3);
			const arrow = rawPath.indexOf(" -> ");
			dirty.push(arrow === -1 ? rawPath : rawPath.slice(arrow + 4));
		}
	}
	return dirty;
}

/**
 * The generators' inputs are this process's module closure: every loaded file under the repo root outside
 * node_modules, plus the entry script itself, which bun keeps out of the module table. Listing them from the process
 * means the hook never hand-maintains an input glob. The module table holds real paths, so the root is resolved through
 * its symlinks before the prefix test (a checkout reached through a symlinked directory would otherwise list no inputs
 * at all).
 */
export function loadedInputs(root: string): string[] {
	const realRoot = fs.realpathSync(path.resolve(root));
	const prefix = `${realRoot}${path.sep}`;
	const entry = process.argv[1];
	const loaded = new Set(Object.keys(require.cache));
	if (entry !== undefined) {
		loaded.add(fs.realpathSync(path.resolve(entry)));
	}
	return [...loaded]
		.filter((file) => file.startsWith(prefix) && !file.includes(`${path.sep}node_modules${path.sep}`))
		.map((file) => path.relative(realRoot, file).split(path.sep).join("/"))
		.sort();
}

/**
 * Refuse before any write. A dirty output would let `git add` sweep a half-done edit into the commit; a dirty input
 * means the staged source and the regenerated output would disagree, and CI's --check would reject that exact commit.
 */
function assertStageable(root: string, outputs: readonly string[], inputs: readonly string[]): void {
	const dirtyOutputs = unstagedAmong(root, outputs);
	if (dirtyOutputs.length > 0) {
		throw new Error(
			`${dirtyOutputs.join(", ")} ${dirtyOutputs.length === 1 ? "has" : "have"} unstaged changes; stage or stash them, the hook regenerates and stages ${dirtyOutputs.length === 1 ? "this file" : "these files"}`
		);
	}
	const dirtyInputs = unstagedAmong(root, inputs);
	if (dirtyInputs.length > 0) {
		throw new Error(
			`${dirtyInputs.join(", ")} ${dirtyInputs.length === 1 ? "has" : "have"} unstaged changes; the generated files would not match the staged sources, so stage or stash them first`
		);
	}
}

interface StagedFile extends GeneratedFile {
	readonly label: string;
}

/**
 * Write the files whose rendered text differs from disk, stage exactly those in one `git add`, and print one line per
 * file. A no-op run prints nothing, so a routine commit stays quiet. Returns the paths it wrote.
 */
function writeAndStage(root: string, files: readonly StagedFile[]): string[] {
	const changed = files.filter((file) => fs.readFileSync(path.join(root, file.relativePath), "utf8") !== file.next);
	for (const file of changed) {
		fs.writeFileSync(path.join(root, file.relativePath), file.next);
	}
	if (changed.length === 0) {
		return [];
	}
	git(root, ["add", "--", ...changed.map((file) => file.relativePath)]);
	for (const file of changed) {
		console.log(`${file.label}: regenerated and staged ${file.relativePath}`);
	}
	return changed.map((file) => file.relativePath);
}

/**
 * The staging run: all preflights, then all renders, then the writes and one `git add`. Any refusal, from the preflight
 * or from a generator's render, leaves every file as it was. Returns the paths written.
 */
export function stageAll(
	root: string,
	generators: readonly Generator[],
	inputs: readonly string[] = loadedInputs(root)
): string[] {
	assertStageable(
		root,
		generators.flatMap((generator) => generator.outputs),
		inputs
	);
	const rendered: StagedFile[] = [];
	for (const generator of generators) {
		for (const file of generator.render(root)) {
			if (!generator.outputs.includes(file.relativePath)) {
				throw new Error(`${generator.label} rendered ${file.relativePath}, which it does not declare as an output`);
			}
			rendered.push({ ...file, label: generator.label });
		}
	}
	return writeAndStage(root, rendered);
}
