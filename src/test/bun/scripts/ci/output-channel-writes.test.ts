import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Judgment, type Rule, scanRedactionBoundaries } from "../../../../../scripts/ci/output-channel-writes";
import { REPO_ROOT } from "../../../util/repoRoot";

const CHANNEL_FIXTURE = "src/test/bun/scripts/ci/outputChannelWritesFixture.ts";
const EXITS_FIXTURE = "src/test/bun/scripts/ci/modelFacingExitsFixture.ts";
const STREAM_FIXTURE = "src/test/bun/scripts/ci/modelFacingStreamFixture.ts";
/** Imported by the exits fixture and never a root, so a judgment there comes only through the import. */
const HELPER_FIXTURE = "src/test/bun/scripts/ci/modelFacingHelperFixture.ts";

const TSCONFIG = join(REPO_ROOT, "tsconfig.prod.json");

/** One verdict: `refused@7 construct { invocationMessage }`; several on a line are joined by ` | `. */
const VERDICT = /^(refused|allowed)@(\d+) (channel|construct|return|member) (.+)$/;

/**
 * The judgment each fixture tag expects. A tag list alone on a line belongs to the code line above it: the formatter
 * moves a tag off a `{` that opens a broken literal.
 */
function expected(files: readonly string[]): Judgment[] {
	return files.flatMap((file) => {
		const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
		return lines.flatMap((text, index) => {
			const tags = /\/\/ ((?:refused|allowed)@.*)$/.exec(text)?.[1];
			if (tags === undefined) {
				return [];
			}
			const line = text.trim().startsWith("//") ? index : index + 1;
			return tags.split(" | ").map((tag): Judgment => {
				const match = VERDICT.exec(tag);
				if (match === null) {
					throw new Error(`${file}:${index + 1}: malformed tag "${tag}"`);
				}
				const [, verdict, column, rule, shape] = match as unknown as [string, string, string, Rule, string];
				return { file, line, column: Number(column), rule, shape, allowed: verdict === "allowed" };
			});
		});
	});
}

function ordered(judgments: readonly Judgment[]): Judgment[] {
	return [...judgments].sort(
		(a, b) =>
			a.file.localeCompare(b.file) ||
			a.line - b.line ||
			a.column - b.column ||
			a.rule.localeCompare(b.rule) ||
			a.shape.localeCompare(b.shape)
	);
}

describe("scanRedactionBoundaries", () => {
	// The gate fails green, not red, when it goes blind: a write it misses is a credential in the channel or in the
	// model's context with no signal anywhere, so the fixtures' tagged rows are the one place a missed shape shows.
	test("judges every tagged output-channel write shape in the fixture and nothing else", () => {
		const { channel } = scanRedactionBoundaries(TSCONFIG, [join(REPO_ROOT, CHANNEL_FIXTURE)]);

		expect(ordered(channel.judgments)).toEqual(ordered(expected([CHANNEL_FIXTURE])));
	});

	test("judges every tagged model-facing exit shape in the fixtures and nothing else", () => {
		const { exits } = scanRedactionBoundaries(
			TSCONFIG,
			[join(REPO_ROOT, EXITS_FIXTURE), join(REPO_ROOT, STREAM_FIXTURE)],
			[
				{ file: EXITS_FIXTURE, functions: ["sanctionedResult", "sanctionedPrepared"] },
				{ file: STREAM_FIXTURE, constructs: new Set(["LanguageModelTextPart"]) },
			]
		);

		expect(ordered(exits.judgments)).toEqual(ordered(expected([EXITS_FIXTURE, STREAM_FIXTURE, HELPER_FIXTURE])));
	});
});
