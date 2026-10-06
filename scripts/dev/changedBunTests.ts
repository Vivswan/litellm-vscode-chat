/**
 * The bun test files a staged change can affect, for .husky/pre-commit: a suite runs when it is staged itself, its
 * runtime imports reach a staged file, or it reads the repository as data (declared by importing
 * src/test/util/repoRoot.ts, which no import graph could otherwise see). The whole tree, the host suite, the docker
 * stacks, and fuzz are CI's on every push; here only the suites that can see the change run, so unrelated suites'
 * budgets cannot refuse a commit.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { RuntimeImportGraph, testFilesUnder } from "../../src/test/runtimeImportGraph";

export interface BunTestSelection {
	/** Repo-relative posix paths with a ./ prefix: `bun test` reads a bare positional as a substring filter, ./ as a path. */
	readonly files: readonly string[];
	/** One line for the developer: how many suites run and why. */
	readonly summary: string;
}

interface BunTestConfig {
	readonly root: string;
	readonly preloads: readonly string[];
}

function readBunTestConfig(repoRoot: string): BunTestConfig {
	const text = fs.readFileSync(path.join(repoRoot, "bunfig.toml"), "utf8");
	const root = /^root = "([^"]+)"/m.exec(text)?.[1];
	if (root === undefined) {
		throw new Error("bunfig.toml declares no [test] root, so the selection cannot know where bun test looks");
	}
	const preloadList = /^preload = \[([^\]]*)\]/m.exec(text)?.[1] ?? "";
	return { root, preloads: [...preloadList.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string) };
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** `staged` holds repo-relative paths as `git diff --cached --name-only` prints them, deleted files included. */
export function selectBunTests(repoRoot: string, staged: readonly string[]): BunTestSelection {
	const config = readBunTestConfig(repoRoot);
	const stagedFiles = new Set(staged.map((file) => path.resolve(repoRoot, file)));
	const graph = new RuntimeImportGraph();
	const closureHolds = (entry: string, counts: (file: string) => boolean): boolean => {
		let holds = false;
		for (const file of graph.closureOf(entry)) {
			if (graph.edgesOf(file).opaque) {
				throw new Error(
					`${file} loads a module by a computed specifier, so the selection cannot know what it reaches; make the specifier a literal`
				);
			}
			holds ||= counts(file);
		}
		return holds;
	};
	const isStaged = (file: string): boolean => stagedFiles.has(file);
	// The marker selects a SUITE on any change; in the preload, which every suite loads, it would select every suite on
	// every commit, so the preload walk counts staged files only.
	const repositoryReader = path.join(repoRoot, "src", "test", "util", "repoRoot.ts");
	const affected = (file: string): boolean => isStaged(file) || file === repositoryReader;
	const tests = testFilesUnder(path.join(repoRoot, config.root)).sort();
	// Both the staged input and any suite the walk can print share the one-path-per-line protocol with the hook.
	for (const file of [...staged, ...tests]) {
		if (file.includes("\n")) {
			throw new Error(
				`a path holds a newline, which the one-path-per-line output cannot carry: ${JSON.stringify(file)}`
			);
		}
	}
	const asOutput = (files: readonly string[]): string[] =>
		files.map((file) => `./${path.relative(repoRoot, file).split(path.sep).join("/")}`);
	const every = (reason: string): BunTestSelection => ({
		files: asOutput(tests),
		summary: `all ${plural(tests.length, "bun test file")} run: ${reason}`,
	});

	if (staged.length === 0) {
		return { files: [], summary: "nothing is staged, so no bun test runs" };
	}
	// Every closure is walked before any shortcut answers, so an unresolvable or computed import refuses the commit on
	// every branch, not only the one that filters.
	const reaching = tests.filter((test) => closureHolds(test, affected));
	const preloadReaches =
		config.preloads.filter((preload) => closureHolds(path.resolve(repoRoot, preload), isStaged)).length > 0;
	if (stagedFiles.has(path.join(repoRoot, "bunfig.toml"))) {
		return every("bunfig.toml is staged");
	}
	if (preloadReaches) {
		return every("the preload every suite loads reaches a staged file");
	}
	if (reaching.length === 0) {
		return {
			files: [],
			summary: `no bun test file is staged, reaches the ${plural(staged.length, "staged file")}, or reads the repository; CI runs the full tree on push`,
		};
	}
	return {
		files: asOutput(reaching),
		summary: `${reaching.length} of ${tests.length} bun test files are staged, reach the ${plural(staged.length, "staged file")}, or read the repository`,
	};
}
