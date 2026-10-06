import { afterAll, describe, it, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { userTextReaders } from "../../../../../scripts/lint/userTextReaders";
import { REPO_ROOT } from "../../../util/repoRoot";

/**
 * The first case builds the fixture project's TypeScript program, which took six seconds on the macOS CI runner (run
 * 37507915564) against bun's five-second default; bun charges a hook's time to the hook, so a warm-up would not help.
 */
setDefaultTimeout(30_000);

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const FIXTURE = "src/test/bun/scripts/lint/userTextReadersFixture.ts";
const CLEAN_FIXTURE = "src/test/bun/scripts/lint/userTextReadersCleanFixture.ts";

interface RefusedTag {
	readonly line: number;
	readonly column: number;
	readonly shape: string;
}

function refusedTags(source: string): RefusedTag[] {
	return source.split("\n").flatMap((text, index) => {
		// A tag follows a statement; the legend in the header comment has none.
		const tag = text.match(/;\s+\/\/ refused (.+?)(?: at (\d+))?$/);
		if (tag?.[1] === undefined) {
			return [];
		}
		const column = tag[2] === undefined ? text.search(/\S/) + 1 : Number(tag[2]);
		return [{ line: index + 1, column, shape: tag[1] }];
	});
}

function fixture(file: string): { filename: string; code: string } {
	return { filename: join(REPO_ROOT, file), code: readFileSync(join(REPO_ROOT, file), "utf8") };
}

// The gate fails green, not red, when it goes blind: a trim it misses is a second trim rule with no signal anywhere, so
// the fixture's refused lines are the one place a missed shape shows. The fixtures are linted under their own paths, so
// the type checker resolves the lib declarations the way the repository's lint run does.
const ruleTester = new RuleTester({
	languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: REPO_ROOT } },
});

const negative = fixture(FIXTURE);
const allowed = [
	{ file: FIXTURE, function: "sanctioned", reason: "the fixture's allowed function" },
	{ file: FIXTURE, function: "assigned", reason: "the fixture's allowed arrow, keyed by its binding" },
];

ruleTester.run("user-text-readers", userTextReaders, {
	valid: [
		{
			name: "a reader that goes through the homes passes whole with no allow row",
			...fixture(CLEAN_FIXTURE),
		},
		{
			name: "an allow row for another file is not this file's row, so it is neither applied nor stale here",
			...fixture(CLEAN_FIXTURE),
			options: [{ allow: allowed }],
		},
	],
	invalid: [
		{
			name: "refuses every tagged read in the fixture by line, column, and shape, and nothing else",
			...negative,
			options: [{ allow: allowed }],
			errors: refusedTags(negative.code).map(({ line, column, shape }) => ({
				messageId: "read",
				data: { shape },
				line,
				column,
			})),
		},
		{
			name: "an allow row no read uses is reported at the file, and nothing else changes",
			...fixture(CLEAN_FIXTURE),
			options: [{ allow: [{ file: CLEAN_FIXTURE, function: "readLabel", reason: "no read left here" }] }],
			errors: [{ messageId: "staleAllow", data: { function: "readLabel" }, line: 1, column: 1 }],
		},
	],
});
