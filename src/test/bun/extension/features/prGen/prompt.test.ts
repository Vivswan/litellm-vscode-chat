import { describe, expect, test } from "bun:test";
import {
	BUILT_IN_PR_INSTRUCTION,
	buildPrPrompt,
	COMMIT_MESSAGE_COUNT,
	COMMIT_MESSAGES_CHAR_LIMIT,
	ISSUES_CHAR_LIMIT,
	PATCHES_CHAR_LIMIT,
	TEMPLATE_CHAR_LIMIT,
	type TitleAndDescriptionContext,
} from "../../../../../extension/features/prGen/prompt";

function context(overrides: Partial<TitleAndDescriptionContext> = {}): TitleAndDescriptionContext {
	return { commitMessages: [], patches: [], ...overrides };
}

describe("extension/features/prGen buildPrPrompt", () => {
	test("every prompt leads with the built-in instruction", () => {
		expect(buildPrPrompt(context()).startsWith(BUILT_IN_PR_INSTRUCTION)).toBe(true);
	});

	test("string patches ride verbatim", () => {
		const prompt = buildPrPrompt(context({ patches: ["--- a/one.ts\n+++ b/one.ts\n+first", "+second"] }));
		expect(prompt).toContain("Patches:");
		expect(prompt).toContain("+first");
		expect(prompt).toContain("+second");
		expect(prompt).not.toContain("File:");
	});

	test("object patches gain a relativized File: header, and a rename names the previous file", () => {
		const prompt = buildPrPrompt(
			context({
				patches: [
					{ patch: "+plain", fileUri: "file:///Users/someone/repo/plain.ts" },
					{
						patch: "+moved",
						fileUri: "file:///Users/someone/repo/src/new.ts",
						previousFileUri: "file:///Users/someone/repo/src/old.ts",
					},
					{
						patch: "+same",
						fileUri: "file:///Users/someone/repo/same.ts",
						previousFileUri: "file:///Users/someone/repo/same.ts",
					},
				],
			})
		);
		expect(prompt).toContain("File: plain.ts\n+plain");
		expect(prompt).toContain("File: src/new.ts (renamed from src/old.ts)\n+moved");
		expect(prompt).toContain("File: same.ts\n+same");
		expect(prompt).not.toContain("(renamed from same.ts)");
		expect(prompt).not.toContain("file:///Users");
		expect(prompt).not.toContain("someone");
	});

	test("a single object patch relativizes to its own directory - absolute URIs never ship", () => {
		const prompt = buildPrPrompt(
			context({ patches: [{ patch: "+only", fileUri: "file:///Users/someone/repo/src/only.ts" }] })
		);
		expect(prompt).toContain("File: only.ts\n+only");
		expect(prompt).not.toContain("someone");
	});

	test("mixed-root patches fall back to basenames - no path segment ships", () => {
		const prompt = buildPrPrompt(
			context({
				patches: [
					{ patch: "+a", fileUri: "file:///Users/someone/repo/a.ts" },
					{ patch: "+b", fileUri: "file:///Volumes/scratch/b.ts" },
				],
			})
		);
		expect(prompt).toContain("File: a.ts\n+a");
		expect(prompt).toContain("File: b.ts\n+b");
		expect(prompt).not.toContain("Users");
		expect(prompt).not.toContain("Volumes");
		expect(prompt).not.toContain("someone");
	});

	test("a Windows drive letter is root metadata, not a shared segment - the account name never ships there either", () => {
		// "/C:/Users/" would otherwise count two segments and pass, leaking the
		// account name as the first segment of every header.
		for (const drive of ["C:", "c%3A"]) {
			const prompt = buildPrPrompt(
				context({
					patches: [
						{ patch: "+a", fileUri: `file:///${drive}/Users/alice/work/a.ts` },
						{ patch: "+b", fileUri: `file:///${drive}/Users/bob/work/b.ts` },
					],
				})
			);
			expect(prompt).toContain("File: a.ts\n+a");
			expect(prompt).toContain("File: b.ts\n+b");
			expect(prompt).not.toContain("alice");
			expect(prompt).not.toContain("bob");
		}
	});

	test("a real shared directory below a Windows drive still relativizes", () => {
		const prompt = buildPrPrompt(
			context({
				patches: [
					{ patch: "+a", fileUri: "file:///C:/Users/alice/repo/src/a.ts" },
					{ patch: "+b", fileUri: "file:///C:/Users/alice/repo/src/b.ts" },
				],
			})
		);
		expect(prompt).toContain("File: a.ts\n+a");
		expect(prompt).not.toContain("alice");
	});

	test("a shared TOP-LEVEL directory is not a shared directory - the account name never ships", () => {
		// The prefix here is "file:///Users/", one segment deep. Stripping only
		// that would leave the account name as the first segment of every header.
		const prompt = buildPrPrompt(
			context({
				patches: [
					{ patch: "+a", fileUri: "file:///Users/alice/work/a.ts" },
					{ patch: "+b", fileUri: "file:///Users/bob/work/b.ts" },
				],
			})
		);
		expect(prompt).toContain("File: a.ts\n+a");
		expect(prompt).toContain("File: b.ts\n+b");
		expect(prompt).not.toContain("alice");
		expect(prompt).not.toContain("bob");
	});

	test("a shared URI authority is not a shared directory - remote mixed roots basename too", () => {
		const prompt = buildPrPrompt(
			context({
				patches: [
					{ patch: "+a", fileUri: "vscode-remote://wsl/home/someone/a.ts" },
					{ patch: "+b", fileUri: "vscode-remote://wsl/opt/b.ts" },
				],
			})
		);
		expect(prompt).toContain("File: a.ts\n+a");
		expect(prompt).toContain("File: b.ts\n+b");
		expect(prompt).not.toContain("home/");
		expect(prompt).not.toContain("someone");
	});

	test("a genuine shared directory past the authority still relativizes", () => {
		const prompt = buildPrPrompt(
			context({
				patches: [
					{ patch: "+a", fileUri: "vscode-remote://wsl/home/someone/repo/a.ts" },
					{ patch: "+b", fileUri: "vscode-remote://wsl/home/someone/repo/src/b.ts" },
				],
			})
		);
		expect(prompt).toContain("File: a.ts\n+a");
		expect(prompt).toContain("File: src/b.ts\n+b");
		expect(prompt).not.toContain("someone");
	});

	test("a cross-root rename never reads as renamed from itself", () => {
		const prompt = buildPrPrompt(
			context({
				patches: [{ patch: "+m", fileUri: "file:///Volumes/x/a.ts", previousFileUri: "file:///Users/someone/y/a.ts" }],
			})
		);
		expect(prompt).toContain("File: a.ts\n+m");
		expect(prompt).not.toContain("renamed");
		expect(prompt).not.toContain("someone");
	});

	test("a directory-shaped URI never ships absolute - the basename stands in", () => {
		const prompt = buildPrPrompt(context({ patches: [{ patch: "+d", fileUri: "file:///Users/someone/repo/src/" }] }));
		expect(prompt).toContain("File: src\n+d");
		expect(prompt).not.toContain("someone");
	});

	test("no patches means no Patches section", () => {
		expect(buildPrPrompt(context())).not.toContain("Patches:");
		expect(buildPrPrompt(context({ patches: [""] }))).not.toContain("Patches:");
	});

	test("the joined patches are head-truncated at exactly PATCHES_CHAR_LIMIT characters", () => {
		const atLimit = "a".repeat(PATCHES_CHAR_LIMIT);
		const untruncated = buildPrPrompt(context({ patches: [atLimit] }));
		expect(untruncated).toContain(atLimit);
		expect(untruncated).not.toContain("[patches truncated]");

		const overByOne = buildPrPrompt(context({ patches: [`${atLimit}Z`] }));
		expect(overByOne).toContain(atLimit);
		expect(overByOne).not.toContain("aZ");
		expect(overByOne).toContain("[patches truncated]");

		const truncated = buildPrPrompt(context({ patches: [atLimit, "TAIL-BEYOND-THE-LIMIT"] }));
		expect(truncated).toContain(atLimit);
		expect(truncated).not.toContain("TAIL-BEYOND-THE-LIMIT");
		expect(truncated).toContain("[patches truncated]");
	});

	test("a template rides verbatim with the follow-it instruction, and a blank one stays out", () => {
		const template = "## Summary\n\n## Checklist";
		const prompt = buildPrPrompt(context({ template }));
		expect(prompt).toContain(`Structure the description to follow this pull request template:\n${template}`);
		expect(buildPrPrompt(context())).not.toContain("pull request template");
		for (const blank of ["", "  \n"]) {
			expect(buildPrPrompt(context({ template: blank }))).not.toContain("pull request template");
		}
	});

	test("the template is head-truncated at exactly TEMPLATE_CHAR_LIMIT", () => {
		expect(buildPrPrompt(context({ template: "t".repeat(TEMPLATE_CHAR_LIMIT) }))).not.toContain("[template truncated]");
		const prompt = buildPrPrompt(context({ template: `${"t".repeat(TEMPLATE_CHAR_LIMIT)}TEMPLATE-TAIL` }));
		expect(prompt).not.toContain("TEMPLATE-TAIL");
		expect(prompt).toContain("[template truncated]");
	});

	test("the compare branch rides as a named line, and a blank one stays out", () => {
		expect(buildPrPrompt(context({ compareBranch: "feat/add-mcp" }))).toContain("Branch name: feat/add-mcp");
		expect(buildPrPrompt(context())).not.toContain("Branch name:");
		expect(buildPrPrompt(context({ compareBranch: "  " }))).not.toContain("Branch name:");
	});

	test("an over-long commit list is thinned from the middle, so both ends survive whichever holds the recent end", () => {
		const messages = Array.from({ length: COMMIT_MESSAGE_COUNT + 3 }, (_, i) => `feat: change ${i}`);
		const prompt = buildPrPrompt(context({ commitMessages: [...messages, "   "] }));
		expect(prompt).toContain("Commit messages on this branch");
		// Both ends ride: the selection cannot depend on knowing which end is
		// recent, because that end is inferred rather than known.
		expect(prompt).toContain("feat: change 0");
		expect(prompt).toContain(`feat: change ${COMMIT_MESSAGE_COUNT + 2}`);
		// The middle is dropped, and the gap is marked so the halves do not read
		// as consecutive.
		expect(prompt).not.toContain("feat: change 11\n");
		expect(prompt).toContain("[3 more commit messages omitted]");
		// Exactly the bound survives, plus the one elision line.
		const kept = messages.filter((message) => prompt.includes(`${message}\n`) || prompt.endsWith(message));
		expect(kept.length).toBe(COMMIT_MESSAGE_COUNT);
		const none = buildPrPrompt(context({ commitMessages: ["", "  "] }));
		expect(none).not.toContain("Commit messages on this branch");
	});

	test("a list at exactly the bound rides whole, with no elision marker", () => {
		const messages = Array.from({ length: COMMIT_MESSAGE_COUNT }, (_, i) => `feat: change ${i}`);
		const prompt = buildPrPrompt(context({ commitMessages: messages }));
		expect(prompt).not.toContain("omitted]");
		for (const message of messages) {
			expect(prompt).toContain(message);
		}
	});

	test("a single omitted message is counted in the singular", () => {
		const messages = Array.from({ length: COMMIT_MESSAGE_COUNT + 1 }, (_, i) => `feat: change ${i}`);
		expect(buildPrPrompt(context({ commitMessages: messages }))).toContain("[1 more commit message omitted]");
	});

	test("a lone commit message is head-truncated at exactly COMMIT_MESSAGES_CHAR_LIMIT", () => {
		const exact = buildPrPrompt(context({ commitMessages: ["m".repeat(COMMIT_MESSAGES_CHAR_LIMIT)] }));
		expect(exact).not.toContain("[commit messages truncated]");
		const huge = `${"m".repeat(COMMIT_MESSAGES_CHAR_LIMIT)}MESSAGE-TAIL`;
		const prompt = buildPrPrompt(context({ commitMessages: [huge] }));
		expect(prompt).not.toContain("MESSAGE-TAIL");
		expect(prompt).toContain("[commit messages truncated]");
	});

	test("a commit list that already fits is never truncated", () => {
		// The budget exists to bound an over-long list, not to cut text that fits.
		const messages = Array.from({ length: 5 }, (_value, i) => `feat: change ${i}${"m".repeat(100)}`);
		const prompt = buildPrPrompt(context({ commitMessages: messages }));
		expect(prompt).not.toContain("[commit messages truncated]");
		for (const message of messages) {
			expect(prompt).toContain(message);
		}
	});

	test("the whole commit-message section stays within COMMIT_MESSAGES_CHAR_LIMIT, markers included", () => {
		// A cut message pays for its own marker out of its share, so the marker
		// cannot push the section past the bound the constant names.
		const messages = Array.from({ length: 6 }, (_value, i) => `${String(i)}${"m".repeat(COMMIT_MESSAGES_CHAR_LIMIT)}`);
		const prompt = buildPrPrompt(context({ commitMessages: messages }));
		const heading = "Commit messages on this branch, as content and style context:\n";
		const section = prompt.slice(prompt.indexOf(heading) + heading.length);
		expect(section.length).toBeLessThanOrEqual(COMMIT_MESSAGES_CHAR_LIMIT);
	});

	test("a list summing to exactly the limit still fits once its separators are counted", () => {
		// The fast path: judged on message lengths ALONE this list fits, and the
		// blank lines between the messages then push the assembled section past
		// the bound. Both paths must charge the separators.
		const count = 20;
		const each = COMMIT_MESSAGES_CHAR_LIMIT / count;
		const messages = Array.from({ length: count }, (_value, i) => `${String(i)}`.padEnd(each, "m"));
		expect(messages.reduce((sum, message) => sum + message.length, 0)).toBe(COMMIT_MESSAGES_CHAR_LIMIT);
		const prompt = buildPrPrompt(context({ commitMessages: messages }));
		const heading = "Commit messages on this branch, as content and style context:\n";
		const section = prompt.slice(prompt.indexOf(heading) + heading.length);
		expect(section.length).toBeLessThanOrEqual(COMMIT_MESSAGES_CHAR_LIMIT);
	});

	test("the budget water-fills: short messages keep their surplus for the long ones", () => {
		// Two short messages plus one long one whose total exceeds the limit. An
		// even split would cut all three; water-filling keeps the short ones whole.
		const short = "feat: a short subject";
		const long = "m".repeat(COMMIT_MESSAGES_CHAR_LIMIT);
		const prompt = buildPrPrompt(context({ commitMessages: [short, short, long] }));
		expect(prompt).toContain(short);
		expect(prompt).toContain("[commit messages truncated]");
	});

	test("the character budget cannot decide which end of the list survives", () => {
		// Head-truncating the JOINED text would keep whichever end came first,
		// putting the whole selection back at the mercy of the inferred order.
		const long = (tag: string) => `${tag}-${"m".repeat(COMMIT_MESSAGES_CHAR_LIMIT)}`;
		const messages = ["FIRST", "MIDDLE", "LAST"].map(long);
		const forward = buildPrPrompt(context({ commitMessages: messages }));
		const reversed = buildPrPrompt(context({ commitMessages: [...messages].reverse() }));
		for (const prompt of [forward, reversed]) {
			// Every message is present and every one is trimmed: no end is dropped.
			expect(prompt).toContain("FIRST-");
			expect(prompt).toContain("MIDDLE-");
			expect(prompt).toContain("LAST-");
			expect(prompt).toContain("[commit messages truncated]");
		}
		// Reversal changes only the order, never which messages survive.
		expect(forward.length).toBe(reversed.length);
	});

	test("referenced issues ride as reference-plus-content blocks, head-truncated at exactly ISSUES_CHAR_LIMIT", () => {
		const prompt = buildPrPrompt(context({ issues: [{ reference: "#12", content: "Steps to reproduce the crash" }] }));
		expect(prompt).toContain("Issues referenced by the change:\n#12:\nSteps to reproduce the crash");
		expect(buildPrPrompt(context())).not.toContain("Issues referenced");
		expect(buildPrPrompt(context({ issues: [] }))).not.toContain("Issues referenced");

		const fill = "i".repeat(ISSUES_CHAR_LIMIT - "#13:\n".length);
		const exact = buildPrPrompt(context({ issues: [{ reference: "#13", content: fill }] }));
		expect(exact).not.toContain("[issues truncated]");
		const huge = buildPrPrompt(context({ issues: [{ reference: "#13", content: `${fill}ISSUE-TAIL` }] }));
		expect(huge).not.toContain("ISSUE-TAIL");
		expect(huge).toContain("[issues truncated]");
	});
});
