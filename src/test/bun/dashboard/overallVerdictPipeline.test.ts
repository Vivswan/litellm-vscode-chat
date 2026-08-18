import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT } from "../../util/repoRoot";

/**
 * The one-verdict-pipeline source guard: classifyOverall is the only place
 * implementing the overall branch rules, and unexpectedServerFailures /
 * unexpectedFailureCount the only place reading a failure's expectedness for
 * verdicts and counts. Every headline surface consumes them instead of
 * re-deriving the rules - the surfaces once drifted (one expected + one real
 * failure showed "1 unreachable" in the tooltip and "2" in both toasts).
 * Greppable-shape checks in the statusItemRegistry idiom: comments may name an
 * API, so matches require the call or comparison form.
 */

const SRC_DIR = path.join(REPO_ROOT, "src");
const TEST_DIR = path.join(SRC_DIR, "test");

function sourceFilesUnder(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...sourceFilesUnder(full));
		} else if (/\.(ts|tsx)$/.test(entry.name)) {
			files.push(full);
		}
	}
	return files;
}

/** Shipped sources (src/ without src/test), as repo-relative posix paths plus text. */
function shippedSources(): { file: string; text: string }[] {
	return sourceFilesUnder(SRC_DIR)
		.filter((file) => !file.startsWith(TEST_DIR + path.sep))
		.map((file) => ({
			file: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
			text: fs.readFileSync(file, "utf8"),
		}));
}

function filesContaining(sources: { file: string; text: string }[], needle: string): string[] {
	return sources
		.filter((source) => source.text.includes(needle))
		.map((source) => source.file)
		.sort();
}

describe("dashboard/presenters overall-verdict pipeline", () => {
	const sources = shippedSources();

	test("classifyOverall is defined exactly once, in the shared presenters", () => {
		assert.deepStrictEqual(filesContaining(sources, "function classifyOverall"), ["src/dashboard/presenters.ts"]);
	});

	test("the status bar, the notifier, and the dashboard headline all call the one classifier", () => {
		const consumers = filesContaining(sources, "classifyOverall(");
		for (const surface of [
			"src/dashboard/presenters.ts",
			"src/extension/ui/notifier.ts",
			"src/extension/ui/status.ts",
			"src/webview/dashboard/app.tsx",
		]) {
			assert.ok(consumers.includes(surface), `${surface} must consume classifyOverall; consumers: ${consumers}`);
		}
	});

	test("the expectedness filter lives only in the shared helper and the classifier", () => {
		// Any new `expected !== true` is a surface re-implementing the branch
		// rules or the count; it must consume the shared readings instead.
		const filterSites = filesContaining(sources, "expected !== true");
		assert.deepStrictEqual(filterSites, ["src/dashboard/presenters.ts", "src/shared/servers.ts"]);
		for (const { file, text } of sources) {
			if (filterSites.includes(file)) {
				assert.strictEqual(text.split("expected !== true").length - 1, 1, `${file} filters expectedness once`);
			}
		}
	});

	test("no surface counts raw error statuses; the unreachable counts read the shared helper", () => {
		// The exact shape that diverged: counting every failure, expected or not.
		assert.deepStrictEqual(filesContaining(sources, "filter(isErrorServerStatus).length"), []);
		for (const surface of ["src/extension/ui/commands.ts", "src/extension/ui/status.ts"]) {
			assert.ok(
				filesContaining(sources, "unexpectedFailureCount(").includes(surface),
				`${surface} must read the shared unreachable count`
			);
		}
		const commands = sources.find((source) => source.file === "src/extension/ui/commands.ts");
		assert.ok(commands !== undefined);
		assert.strictEqual(
			commands.text.split("unexpectedFailureCount(").length - 1,
			2,
			"both command toasts (connection test and model sync) read the shared count"
		);
	});
});
