import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanOutputChannelAccess } from "../../../../../scripts/ci/output-channel-writes";
import { REPO_ROOT } from "../../../util/repoRoot";

const FIXTURE = "src/test/bun/scripts/ci/outputChannelWritesFixture.ts";

function taggedLines(source: string, tag: string): number[] {
	return source.split("\n").flatMap((text, index) => (text.endsWith(`// ${tag}`) ? [index + 1] : []));
}

describe("scanOutputChannelAccess", () => {
	// The gate fails green, not red, when it goes blind: a write it misses is a credential in the channel with no
	// signal anywhere, so the fixture's refused lines are the one place a missed shape shows.
	test("refuses every tagged write shape in the fixture and nothing else", () => {
		const source = readFileSync(join(REPO_ROOT, FIXTURE), "utf8");
		const refusedLines = taggedLines(source, "refused");
		const allowedLines = taggedLines(source, "allowed");

		const { seen, refused } = scanOutputChannelAccess(join(REPO_ROOT, "tsconfig.prod.json"), [
			join(REPO_ROOT, FIXTURE),
		]);

		expect(refused.map((access) => access.line)).toEqual(refusedLines);
		expect(refused.every((access) => access.file === FIXTURE)).toBe(true);
		expect(seen).toBe(refusedLines.length + allowedLines.length);
	});
});
