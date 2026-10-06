import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanUserTextReaders } from "../../../../../scripts/ci/user-text-readers";
import { REPO_ROOT } from "../../../util/repoRoot";
import { CHILD_PROCESS_TIMEOUT_MS } from "../../childProcessTimeout";

const FIXTURE = "src/test/bun/scripts/ci/userTextReadersFixture.ts";
const CLEAN_FIXTURE = "src/test/bun/scripts/ci/userTextReadersCleanFixture.ts";
const BLIND_FIXTURE = "src/test/bun/scripts/ci/userTextReadersBlindFixture.ts";
const RUNNER = "scripts/ci/check-user-text-readers.ts";
const TSCONFIG = join(REPO_ROOT, "tsconfig.prod.json");

interface Tags {
	/** `line:column shape`, in file order. */
	readonly refused: string[];
	readonly seen: number;
}

function tagsOf(file: string): Tags {
	const refused: string[] = [];
	let seen = 0;
	readFileSync(join(REPO_ROOT, file), "utf8")
		.split("\n")
		.forEach((text, index) => {
			// A tag follows a statement; the legend in the header comment has none.
			const tag = text.match(/;\s+\/\/ (refused|seen)(?: (.+?))?(?: at (\d+))?$/);
			if (tag?.[1] === "refused") {
				const column = tag[3] === undefined ? text.search(/\S/) + 1 : Number(tag[3]);
				refused.push(`${index + 1}:${column} ${tag[2]}`);
			} else if (tag?.[1] === "seen") {
				seen += 1;
			}
		});
	return { refused, seen };
}

function runnerOn(...args: string[]): { status: number | null; stdout: string; stderr: string } {
	const run = spawnSync(process.execPath, [join(REPO_ROOT, RUNNER), ...args], { cwd: REPO_ROOT, encoding: "utf8" });
	return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("scanUserTextReaders", () => {
	// The gate fails green, not red, when it goes blind: a trim it misses is a second trim rule with no signal
	// anywhere, so the fixture's refused lines are the one place a missed shape shows.
	test("refuses every tagged read in the fixture by line, column, and shape, and nothing else", () => {
		const tags = tagsOf(FIXTURE);
		const allowed = [{ file: FIXTURE, function: "sanctioned", reason: "the fixture's one allowed reader" }];

		const { seen, refused, unusedAllowed } = scanUserTextReaders(TSCONFIG, [join(REPO_ROOT, FIXTURE)], {
			modules: [FIXTURE],
			allowed,
		});

		expect(refused.map((read) => `${read.line}:${read.column} ${read.shape}`)).toEqual(tags.refused);
		expect(refused.every((read) => read.file === FIXTURE)).toBe(true);
		expect(seen).toBe(tags.refused.length + tags.seen);
		expect(unusedAllowed).toEqual([]);
	});

	test("a reader that goes through the homes passes whole with no allowlist row", () => {
		const scan = scanUserTextReaders(TSCONFIG, [join(REPO_ROOT, CLEAN_FIXTURE)], {
			modules: [CLEAN_FIXTURE],
			allowed: [],
		});

		expect(scan).toEqual({ seen: tagsOf(CLEAN_FIXTURE).seen, refused: [], unusedAllowed: [] });
	});

	test("an allowlist row no read uses is reported, and nothing else changes", () => {
		const stale = { file: CLEAN_FIXTURE, function: "readLabel", reason: "no read left here" };

		const scan = scanUserTextReaders(TSCONFIG, [join(REPO_ROOT, CLEAN_FIXTURE)], {
			modules: [CLEAN_FIXTURE],
			allowed: [stale],
		});

		expect(scan).toEqual({ seen: tagsOf(CLEAN_FIXTURE).seen, refused: [], unusedAllowed: [stale] });
	});
});

describe("check-user-text-readers exit code", () => {
	// The exit code is what the hook and the workflow read, so each red is proved through the same process the gate
	// runs, not through the scan result alone.
	test(
		"a scan that sees no read at all is red",
		() => {
			const run = runnerOn("--scope", BLIND_FIXTURE);
			expect(run.status).toBe(1);
			expect(run.stderr).toContain("No trim or number read found at all");
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test(
		"a refused read is red and named",
		() => {
			const [first = ""] = tagsOf(FIXTURE).refused;
			const [position, ...shape] = first.split(" ");

			const run = runnerOn("--scope", FIXTURE, "--allow", `${FIXTURE}:sanctioned`);
			expect(run.status).toBe(1);
			expect(run.stderr).toContain(`${FIXTURE}:${position}: ${shape.join(" ")} reads user text outside the one rule`);
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test(
		"a stale allowlist row is red",
		() => {
			const run = runnerOn("--scope", CLEAN_FIXTURE, "--allow", `${CLEAN_FIXTURE}:readLabel`);
			expect(run.status).toBe(1);
			expect(run.stderr).toContain("ALLOWED_READS names readLabel");
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test(
		"a clean reader is green with its count",
		() => {
			const run = runnerOn("--scope", CLEAN_FIXTURE);
			expect(run.status).toBe(0);
			expect(run.stdout).toBe(
				`User-text readers: ${tagsOf(CLEAN_FIXTURE).seen} trim and number reads, none outside the one rule\n`
			);
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test(
		"a scope spelled with a leading ./ is the same file, so its reads are still judged",
		() => {
			const run = runnerOn("--scope", `./${FIXTURE}`, "--allow", `${FIXTURE}:sanctioned`);
			expect(run.status).toBe(1);
			expect(run.stderr).toContain("reads user text outside the one rule");
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test(
		"a scope that names no file is a usage error, never a clean scan",
		() => {
			const run = runnerOn("--scope", "src/test/bun/scripts/ci/noSuchFixture.ts", "--scope", CLEAN_FIXTURE);
			expect(run.status).toBe(2);
			expect(run.stderr).toContain("names no file");
		},
		CHILD_PROCESS_TIMEOUT_MS
	);
});
