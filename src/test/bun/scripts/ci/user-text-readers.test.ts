import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanUserTextReaders } from "../../../../../scripts/ci/user-text-readers";
import { REPO_ROOT } from "../../../util/repoRoot";

const FIXTURE = "src/test/bun/scripts/ci/userTextReadersFixture.ts";
const CLEAN_FIXTURE = "src/test/bun/scripts/ci/userTextReadersCleanFixture.ts";
const TSCONFIG = join(REPO_ROOT, "tsconfig.prod.json");

interface Tags {
	/** `line shape`, in file order. */
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
			const tag = /;\s+\/\/ (refused|seen)(?: (.+))?$/.exec(text);
			if (tag?.[1] === "refused") {
				refused.push(`${index + 1} ${tag[2]}`);
			} else if (tag?.[1] === "seen") {
				seen += 1;
			}
		});
	return { refused, seen };
}

describe("scanUserTextReaders", () => {
	// The gate fails green, not red, when it goes blind: a trim it misses is a second trim rule with no signal
	// anywhere, so the fixture's refused lines are the one place a missed shape shows.
	test("refuses every tagged read in the fixture by shape and nothing else", () => {
		const tags = tagsOf(FIXTURE);
		const allowed = [{ file: FIXTURE, function: "sanctioned", reason: "the fixture's one allowed reader" }];

		const { seen, refused, unusedAllowed } = scanUserTextReaders(TSCONFIG, [join(REPO_ROOT, FIXTURE)], {
			modules: [FIXTURE],
			allowed,
		});

		expect(refused.map((read) => `${read.line} ${read.shape}`)).toEqual(tags.refused);
		expect(refused.every((read) => read.file === FIXTURE)).toBe(true);
		expect(seen).toBe(tags.refused.length + tags.seen);
		expect(unusedAllowed).toEqual([]);
	});

	test("passes a reader that goes through the homes, and reports an allowlist row no read uses", () => {
		const tags = tagsOf(CLEAN_FIXTURE);
		const stale = { file: CLEAN_FIXTURE, function: "readLabel", reason: "no read left here" };

		const { seen, refused, unusedAllowed } = scanUserTextReaders(TSCONFIG, [join(REPO_ROOT, CLEAN_FIXTURE)], {
			modules: [CLEAN_FIXTURE],
			allowed: [stale],
		});

		expect(refused).toEqual([]);
		expect(seen).toBe(tags.seen);
		expect(unusedAllowed).toEqual([stale]);
	});
});
