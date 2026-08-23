import { describe, expect, test } from "bun:test";
import { NO_FINDINGS_REPLY, parsePlacements } from "../../../../../extension/features/reviewComments/placements";
import {
	buildDiffReviewPrompt,
	buildFileReviewPrompt,
	buildReplyMessages,
	type DiffReviewPromptArgs,
	type FileReviewPromptArgs,
	REVIEW_COMMENT_CHAR_LIMIT,
	REVIEW_DIFF_CHAR_LIMIT,
	REVIEW_FILE_CHAR_LIMIT,
	REVIEW_FORMAT_INSTRUCTION,
	REVIEW_REPLY_TURN_LIMIT,
	REVIEW_SNIPPET_CHAR_LIMIT,
} from "../../../../../extension/features/reviewComments/reviewPrompt";

const DIFF = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,3 @@", " context", "+added line", " context"].join("\n");

describe("extension/features/reviewComments/reviewPrompt", () => {
	test("the frozen signatures and the stated budgets", () => {
		const buildDiff: (args: DiffReviewPromptArgs) => string = buildDiffReviewPrompt;
		const buildFile: (args: FileReviewPromptArgs) => string = buildFileReviewPrompt;
		expect(typeof buildDiff).toBe("function");
		expect(typeof buildFile).toBe("function");
		expect(REVIEW_DIFF_CHAR_LIMIT).toBe(80_000);
		expect(REVIEW_FILE_CHAR_LIMIT).toBe(80_000);
	});

	test("both prompts open with the shared instruction: the LINE format and the no-findings reply", () => {
		for (const prompt of [
			buildDiffReviewPrompt({ path: "src/a.ts", diff: DIFF }),
			buildFileReviewPrompt({ path: "src/a.ts", content: "const x = 1;" }),
		]) {
			expect(prompt.startsWith(REVIEW_FORMAT_INSTRUCTION)).toBe(true);
			expect(prompt).toContain("LINE <start>-<end>:");
			expect(prompt).toContain(`reply with exactly: ${NO_FINDINGS_REPLY}`);
		}
	});

	test("the diff prompt names the file and carries the diff verbatim when under budget", () => {
		const prompt = buildDiffReviewPrompt({ path: "src/a.ts", diff: DIFF });
		expect(prompt).toContain("Working tree diff of src/a.ts:");
		expect(prompt).toContain(DIFF);
		expect(prompt).not.toContain("[diff truncated]");
	});

	test("the diff is head-truncated at exactly REVIEW_DIFF_CHAR_LIMIT characters", () => {
		const atLimit = buildDiffReviewPrompt({ path: "a", diff: "d".repeat(REVIEW_DIFF_CHAR_LIMIT) });
		expect(atLimit).not.toContain("[diff truncated]");
		const overLimit = buildDiffReviewPrompt({ path: "a", diff: `${"d".repeat(REVIEW_DIFF_CHAR_LIMIT)}TAIL` });
		expect(overLimit).toContain(`${"d".repeat(REVIEW_DIFF_CHAR_LIMIT)}\n[diff truncated]`);
		expect(overLimit).not.toContain("TAIL");
	});

	test("a truncation cut never leaves a lone surrogate in the body", () => {
		// The cut delegates to the shared truncateKeepingHead, so an astral
		// character straddling the bound loses the whole character rather than
		// half of it - an unpaired surrogate is exactly what a gateway rejects.
		const diff = `${"d".repeat(REVIEW_DIFF_CHAR_LIMIT - 1)}\u{1F600}tail`;
		const prompt = buildDiffReviewPrompt({ path: "a", diff });
		expect(prompt).toContain("[diff truncated]");
		for (const unit of prompt) {
			const code = unit.charCodeAt(0);
			expect(code >= 0xd800 && code <= 0xdfff && unit.length === 1).toBe(false);
		}
		// The emoji straddled the bound, so neither half survives.
		expect(prompt).not.toContain("\u{1F600}");
	});

	test("the file prompt numbers every line 1-based and names the file and language", () => {
		const prompt = buildFileReviewPrompt({ path: "src/b.py", content: "alpha\nbeta\ngamma", languageId: "python" });
		expect(prompt).toContain("File src/b.py (python):");
		expect(prompt).toContain("1: alpha\n2: beta\n3: gamma");
		expect(buildFileReviewPrompt({ path: "src/b.py", content: "alpha" })).toContain("File src/b.py:\n");
		expect(buildFileReviewPrompt({ path: "src/b.py", content: "alpha", languageId: "  " })).toContain(
			"File src/b.py:\n"
		);
	});

	test("numbering splits on the same line breaks the parser does, lone CR included", () => {
		expect(buildFileReviewPrompt({ path: "a", content: "alpha\rbeta\r\ngamma" })).toContain(
			"1: alpha\n2: beta\n3: gamma"
		);
	});

	test("incremental numbering matches the naive render on newline-heavy over-budget content", () => {
		const content = Array.from({ length: 30_000 }, (_, index) => `line body ${index}`).join("\n");
		const naiveNumbered = content
			.split(/\r\n|[\r\n]/)
			.map((line, index) => `${index + 1}: ${line}`)
			.join("\n");
		expect(naiveNumbered.length).toBeGreaterThan(REVIEW_FILE_CHAR_LIMIT);
		const expected = `${naiveNumbered.slice(0, REVIEW_FILE_CHAR_LIMIT)}\n[file truncated]`;
		expect(buildFileReviewPrompt({ path: "a", content })).toContain(expected);
	});

	test("the numbered content is head-truncated at exactly REVIEW_FILE_CHAR_LIMIT characters", () => {
		// One line: the numbered form is "1: " + content, so this sits exactly at the limit.
		const atLimit = buildFileReviewPrompt({ path: "a", content: "c".repeat(REVIEW_FILE_CHAR_LIMIT - 3) });
		expect(atLimit).not.toContain("[file truncated]");
		const overLimit = buildFileReviewPrompt({ path: "a", content: `${"c".repeat(REVIEW_FILE_CHAR_LIMIT - 3)}TAIL` });
		expect(overLimit).toContain("\n[file truncated]");
		expect(overLimit).not.toContain("TAIL");
	});

	test("builder and parser agree: an answer in the instructed format parses, the instruction itself never does", () => {
		const answer = "LINE 2: The added line is dead code.\nLINE 1-3: The hunk drops the trailing newline.";
		expect(parsePlacements(answer, 3).placements).toEqual([
			{ startLine: 2, endLine: 2, body: "The added line is dead code." },
			{ startLine: 1, endLine: 3, body: "The hunk drops the trailing newline." },
		]);
		expect(parsePlacements(NO_FINDINGS_REPLY, 3)).toEqual({ placements: [], dropped: 0, sawNoFindings: true });
		// The instruction's own LINE placeholders are not digit anchors, so echoing it back yields no placements.
		expect(parsePlacements(REVIEW_FORMAT_INSTRUCTION, 3).placements).toEqual([]);
	});

	describe("buildReplyMessages", () => {
		const TURNS = [
			{ author: "model" as const, body: "This loop reads one past the end." },
			{ author: "user" as const, body: "Does it? values.length is the count." },
		];

		test("leads with a system turn naming the file, the range, and the quoted lines", () => {
			const [system, ...rest] = buildReplyMessages({
				path: "src/a.ts",
				snippet: "4: for (let i = 0; i <= n; i++) {",
				startLine: 4,
				endLine: 4,
				turns: TURNS,
			});
			expect(system?.role).toBe("system");
			expect(system?.content).toContain("src/a.ts, line 4");
			expect(system?.content).toContain("4: for (let i = 0; i <= n; i++) {");
			expect(rest).toHaveLength(2);
		});

		test("a multi-line thread names the range as a span", () => {
			const [system] = buildReplyMessages({ path: "a", snippet: "", startLine: 4, endLine: 9, turns: TURNS });
			expect(system?.content).toContain("a, lines 4-9");
		});

		test("the thread replays as alternating turns: model comments as assistant, the user's as user", () => {
			const messages = buildReplyMessages({ path: "a", snippet: "s", startLine: 1, endLine: 1, turns: TURNS });
			expect(messages.slice(1)).toEqual([
				{ role: "assistant", content: "This loop reads one past the end." },
				{ role: "user", content: "Does it? values.length is the count." },
			]);
		});

		test("the follow-up asks for prose, never the line-anchored finding format", () => {
			const [system] = buildReplyMessages({ path: "a", snippet: "s", startLine: 1, endLine: 1, turns: TURNS });
			expect(system?.content).toContain("plain prose");
			expect(system?.content).not.toContain("LINE <start>-<end>");
		});

		test("an unreadable document sends the conversation without a quote rather than an empty one", () => {
			const [system] = buildReplyMessages({ path: "a", snippet: "", startLine: 2, endLine: 2, turns: TURNS });
			expect(system?.content).not.toContain("The lines under discussion:");
		});

		test("the snippet and every comment body are head-truncated at their stated bounds", () => {
			const [system, , userTurn] = buildReplyMessages({
				path: "a",
				snippet: `${"s".repeat(REVIEW_SNIPPET_CHAR_LIMIT)}SNIPTAIL`,
				startLine: 1,
				endLine: 1,
				turns: [
					{ author: "model", body: "short" },
					{ author: "user", body: `${"u".repeat(REVIEW_COMMENT_CHAR_LIMIT)}BODYTAIL` },
				],
			});
			expect(system?.content).toContain("[snippet truncated]");
			expect(system?.content).not.toContain("SNIPTAIL");
			expect(userTurn?.content).toContain("[truncated]");
			expect(userTurn?.content).not.toContain("BODYTAIL");
		});

		test("a long thread is capped at its newest turns, so the request stays bounded", () => {
			const turns = Array.from({ length: REVIEW_REPLY_TURN_LIMIT + 5 }, (_, index) => ({
				author: (index % 2 === 0 ? "model" : "user") as "model" | "user",
				body: `turn ${index}`,
			}));
			const messages = buildReplyMessages({ path: "a", snippet: "", startLine: 1, endLine: 1, turns });
			expect(messages).toHaveLength(REVIEW_REPLY_TURN_LIMIT + 1);
			// The newest turns survive: the reply is about those, not the opening.
			expect(messages.at(-1)?.content).toBe(`turn ${turns.length - 1}`);
			expect(messages.some((message) => message.content === "turn 0")).toBe(false);
		});

		test("a thread with no turns still sends its context, so the request is never message-less", () => {
			const messages = buildReplyMessages({ path: "a", snippet: "1: x", startLine: 1, endLine: 1, turns: [] });
			expect(messages).toHaveLength(1);
			expect(messages[0]?.role).toBe("system");
		});
	});
});
