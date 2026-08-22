import { describe, expect, test } from "bun:test";
import {
	BUILT_IN_COMMIT_INSTRUCTION,
	buildCommitPrompt,
	type CommitDiffSource,
	type CommitMessageOutcome,
	type CommitModelRef,
	commitSubjects,
	DIFF_CHAR_LIMIT,
	generateCommitMessage,
	STYLE_EXAMPLE_COUNT,
	stripMarkdownFences,
	UNTRACKED_PATHS_LIMIT,
	untrackedRelativePaths,
} from "../../../../extension/scm/commitMessage";
import type { Change, Commit, Repository } from "../../../../extension/scm/gitApi";

const REF: CommitModelRef = { server: "alpha", model: "gpt-test" };

/** Upstream vscode.git Status values used by the fakes. */
const UNTRACKED = 7;
const MODIFIED = 5;

function reader(overrides: { modelRef?: CommitModelRef | undefined; prompt?: string } = {}) {
	return {
		modelRef: () => ("modelRef" in overrides ? overrides.modelRef : REF),
		prompt: () => overrides.prompt ?? "",
	};
}

type FakeRepo = Pick<Repository, "diff" | "log" | "rootUri" | "state">;

function change(fsPath: string, status: number): Change {
	return { uri: { fsPath } as Change["uri"], status };
}

/** A fake git repository recording which diffs were asked for. */
function fakeRepo(parts: {
	staged?: string;
	working?: string;
	log?: () => Promise<Commit[]>;
	workingTreeChanges?: Change[];
	untrackedChanges?: Change[];
}): {
	repo: FakeRepo;
	diffCalls: boolean[];
} {
	const diffCalls: boolean[] = [];
	return {
		diffCalls,
		repo: {
			rootUri: { fsPath: "/repo" } as Repository["rootUri"],
			state: {
				indexChanges: [],
				workingTreeChanges: parts.workingTreeChanges ?? [],
				untrackedChanges: parts.untrackedChanges ?? [],
			},
			diff: (cached?: boolean) => {
				diffCalls.push(cached === true);
				return Promise.resolve(cached === true ? (parts.staged ?? "") : (parts.working ?? ""));
			},
			log: parts.log ?? (() => Promise.resolve([])),
		},
	};
}

describe("extension/scm buildCommitPrompt", () => {
	test("a blank custom prompt selects the built-in Conventional Commits instruction", () => {
		for (const blank of ["", "   ", "\n\t"]) {
			const prompt = buildCommitPrompt({ customPrompt: blank, diff: "+x", recentSubjects: [], untrackedPaths: [] });
			expect(prompt.startsWith(BUILT_IN_COMMIT_INSTRUCTION)).toBe(true);
		}
	});

	test("a non-blank custom prompt replaces the instruction wholesale and verbatim", () => {
		const custom = "  Summarize in one line, in French.  ";
		const prompt = buildCommitPrompt({ customPrompt: custom, diff: "+x", recentSubjects: [], untrackedPaths: [] });
		expect(prompt.startsWith(custom)).toBe(true);
		expect(prompt).not.toContain(BUILT_IN_COMMIT_INSTRUCTION);
	});

	test("the diff is head-truncated at exactly DIFF_CHAR_LIMIT characters", () => {
		const atLimit = "a".repeat(DIFF_CHAR_LIMIT);
		const untruncated = buildCommitPrompt({ customPrompt: "", diff: atLimit, recentSubjects: [], untrackedPaths: [] });
		expect(untruncated).toContain(atLimit);
		expect(untruncated).not.toContain("[diff truncated]");

		const overLimit = `${atLimit}TAIL-BEYOND-THE-LIMIT`;
		const truncated = buildCommitPrompt({ customPrompt: "", diff: overLimit, recentSubjects: [], untrackedPaths: [] });
		expect(truncated).toContain(atLimit);
		expect(truncated).not.toContain("TAIL-BEYOND-THE-LIMIT");
		expect(truncated).toContain("[diff truncated]");
	});

	test("style examples ride along whichever instruction is active, and vanish when there are none", () => {
		const subjects = ["feat: one", "fix: two"];
		const withBuiltIn = buildCommitPrompt({
			customPrompt: "",
			diff: "+x",
			recentSubjects: subjects,
			untrackedPaths: [],
		});
		const withCustom = buildCommitPrompt({
			customPrompt: "My rules.",
			diff: "+x",
			recentSubjects: subjects,
			untrackedPaths: [],
		});
		for (const prompt of [withBuiltIn, withCustom]) {
			expect(prompt).toContain("- feat: one");
			expect(prompt).toContain("- fix: two");
			expect(prompt).toContain("style examples");
		}
		const none = buildCommitPrompt({ customPrompt: "", diff: "+x", recentSubjects: [], untrackedPaths: [] });
		expect(none).not.toContain("style examples");
	});

	test("the untracked path list is bounded, with a count marker for the omitted tail", () => {
		const paths = Array.from({ length: UNTRACKED_PATHS_LIMIT + 5 }, (_, i) => `file-${String(i).padStart(3, "0")}`);
		const bounded = buildCommitPrompt({ customPrompt: "", diff: "", recentSubjects: [], untrackedPaths: paths });
		expect(bounded).toContain(`- ${paths[UNTRACKED_PATHS_LIMIT - 1]}`);
		expect(bounded).not.toContain(`- ${paths[UNTRACKED_PATHS_LIMIT]}`);
		expect(bounded).toContain("[and 5 more untracked files]");

		const atLimit = buildCommitPrompt({
			customPrompt: "",
			diff: "",
			recentSubjects: [],
			untrackedPaths: paths.slice(0, UNTRACKED_PATHS_LIMIT),
		});
		expect(atLimit).toContain(`- ${paths[UNTRACKED_PATHS_LIMIT - 1]}`);
		expect(atLimit).not.toContain("more untracked");
	});
});

describe("extension/scm untrackedRelativePaths", () => {
	test("keeps only untracked changes, relativized to the repository root and sorted", () => {
		const repo: Pick<Repository, "rootUri" | "state"> = {
			rootUri: { fsPath: "/repo/" } as Repository["rootUri"],
			state: {
				indexChanges: [],
				workingTreeChanges: [
					change("/repo/zebra.txt", UNTRACKED),
					change("/repo/a/alpha.txt", UNTRACKED),
					change("/repo/modified.ts", MODIFIED),
					change("/elsewhere/outside.txt", UNTRACKED),
				],
				untrackedChanges: [],
			},
		};
		expect(untrackedRelativePaths(repo)).toEqual(["/elsewhere/outside.txt", "a/alpha.txt", "zebra.txt"]);
	});

	test('reads the separate untrackedChanges array too - the git.untrackedChanges "separate" layout', () => {
		const repo: Pick<Repository, "rootUri" | "state"> = {
			rootUri: { fsPath: "/repo" } as Repository["rootUri"],
			state: {
				indexChanges: [],
				workingTreeChanges: [change("/repo/modified.ts", MODIFIED)],
				untrackedChanges: [change("/repo/separate.txt", UNTRACKED)],
			},
		};
		expect(untrackedRelativePaths(repo)).toEqual(["separate.txt"]);
	});

	test("a sibling directory sharing the root's prefix is not relativized, and backslashes normalize", () => {
		const repo: Pick<Repository, "rootUri" | "state"> = {
			rootUri: { fsPath: "/repo" } as Repository["rootUri"],
			state: {
				indexChanges: [],
				workingTreeChanges: [
					change("/repo-backup/file.txt", UNTRACKED),
					{ uri: { fsPath: "/repo\\nested\\win.txt" } as Change["uri"], status: UNTRACKED },
				],
				untrackedChanges: [],
			},
		};
		expect(untrackedRelativePaths(repo)).toEqual(["/repo-backup/file.txt", "nested/win.txt"]);
	});
});

describe("extension/scm commitSubjects", () => {
	test("keeps first lines only - a commit body never rides into the prompt", () => {
		const commits: Commit[] = [
			{ hash: "a", message: "feat: subject one\n\nSECRET-BODY-DETAIL that stays out" },
			{ hash: "b", message: "fix: subject two" },
			{ hash: "c", message: "   \n\nwhitespace-only subject drops" },
		];
		const subjects = commitSubjects(commits);
		expect(subjects).toEqual(["feat: subject one", "fix: subject two"]);
		expect(subjects.join("\n")).not.toContain("SECRET-BODY-DETAIL");
	});
});

describe("extension/scm stripMarkdownFences", () => {
	test("removes a fence pair, language tag included", () => {
		expect(stripMarkdownFences("```\nfeat: x\n```")).toBe("feat: x");
		expect(stripMarkdownFences("```text\nfeat: x\n\nbody line\n```\n")).toBe("feat: x\n\nbody line");
	});

	test("removes a lone opening fence", () => {
		expect(stripMarkdownFences("```\nfeat: x")).toBe("feat: x");
	});

	test("leaves unfenced text and interior fences alone", () => {
		expect(stripMarkdownFences("feat: x")).toBe("feat: x");
		const interior = "feat: x\n\nadds a ```code``` sample";
		expect(stripMarkdownFences(interior)).toBe(interior);
	});
});

describe("extension/scm generateCommitMessage", () => {
	test("no configured model is a typed outcome before any git call", async () => {
		const { repo, diffCalls } = fakeRepo({ staged: "+x" });
		const outcome = await generateCommitMessage(repo, reader({ modelRef: undefined }), () => {
			throw new Error("send must not run without a model");
		});
		expect(outcome).toEqual({ kind: "noModel" });
		expect(diffCalls).toEqual([]);
	});

	test("a staged diff is used as-is and the working tree is never asked for", async () => {
		const { repo, diffCalls } = fakeRepo({ staged: "+staged change", working: "+working change" });
		let seenPrompt = "";
		const outcome = await generateCommitMessage(repo, reader(), (ref, prompt) => {
			expect(ref).toEqual(REF);
			seenPrompt = prompt;
			return Promise.resolve("feat: staged");
		});
		const source: CommitDiffSource = "staged";
		expect(outcome).toEqual({ kind: "generated", message: "feat: staged", source });
		expect(diffCalls).toEqual([true]);
		expect(seenPrompt).toContain("+staged change");
		expect(seenPrompt).not.toContain("+working change");
	});

	test("an empty staged diff falls back to the working tree", async () => {
		const { repo, diffCalls } = fakeRepo({ staged: "  \n", working: "+working change" });
		const outcome = await generateCommitMessage(repo, reader(), () => Promise.resolve("feat: working"));
		expect(outcome).toEqual({ kind: "generated", message: "feat: working", source: "workingTree" });
		expect(diffCalls).toEqual([true, false]);
	});

	test("the working-tree fallback rides untracked paths along - paths only, never contents", async () => {
		const { repo } = fakeRepo({
			working: "+edited line",
			workingTreeChanges: [change("/repo/src/new-file.ts", UNTRACKED), change("/repo/src/edited.ts", MODIFIED)],
		});
		let seenPrompt = "";
		await generateCommitMessage(repo, reader(), (_ref, prompt) => {
			seenPrompt = prompt;
			return Promise.resolve("feat: adds new-file");
		});
		expect(seenPrompt).toContain("- src/new-file.ts");
		expect(seenPrompt).toContain("paths only");
		expect(seenPrompt).not.toContain("- src/edited.ts");
	});

	test("a staged diff never collects untracked paths", async () => {
		const { repo } = fakeRepo({
			staged: "+staged change",
			workingTreeChanges: [change("/repo/src/new-file.ts", UNTRACKED)],
		});
		let seenPrompt = "";
		await generateCommitMessage(repo, reader(), (_ref, prompt) => {
			seenPrompt = prompt;
			return Promise.resolve("feat: staged");
		});
		expect(seenPrompt).not.toContain("new-file.ts");
	});

	test("an untracked-only change still generates, from the path list alone", async () => {
		const { repo } = fakeRepo({ workingTreeChanges: [change("/repo/notes.md", UNTRACKED)] });
		let seenPrompt = "";
		const outcome = await generateCommitMessage(repo, reader(), (_ref, prompt) => {
			seenPrompt = prompt;
			return Promise.resolve("docs: add notes");
		});
		expect(outcome).toEqual({ kind: "generated", message: "docs: add notes", source: "workingTree" });
		expect(seenPrompt).toContain("- notes.md");
		expect(seenPrompt).not.toContain("Diff:");
	});

	test("both diffs empty is a typed no-changes outcome and send never runs", async () => {
		const { repo } = fakeRepo({});
		const outcome = await generateCommitMessage(repo, reader(), () => {
			throw new Error("send must not run without changes");
		});
		expect(outcome).toEqual({ kind: "noChanges" });
	});

	test("asks the log for STYLE_EXAMPLE_COUNT entries and rides their subjects into the prompt", async () => {
		let seenMaxEntries: number | undefined;
		const { repo } = fakeRepo({ staged: "+x" });
		const logged: FakeRepo = {
			...repo,
			log: (options) => {
				seenMaxEntries = options?.maxEntries;
				return Promise.resolve([{ hash: "a", message: "feat: prior subject\n\nprior body" }]);
			},
		};
		let seenPrompt = "";
		await generateCommitMessage(logged, reader(), (_ref, prompt) => {
			seenPrompt = prompt;
			return Promise.resolve("feat: next");
		});
		expect(seenMaxEntries).toBe(STYLE_EXAMPLE_COUNT);
		expect(seenPrompt).toContain("- feat: prior subject");
		expect(seenPrompt).not.toContain("prior body");
	});

	test("a failing log (no commits yet) still generates, without style examples", async () => {
		const { repo } = fakeRepo({ staged: "+x", log: () => Promise.reject(new Error("bad revision HEAD")) });
		let seenPrompt = "";
		const outcome = await generateCommitMessage(repo, reader(), (_ref, prompt) => {
			seenPrompt = prompt;
			return Promise.resolve("feat: first");
		});
		expect(outcome.kind).toBe("generated");
		expect(seenPrompt).not.toContain("style examples");
	});

	test("the reply is fence-stripped, and a reply that strips to nothing is a typed outcome", async () => {
		const { repo } = fakeRepo({ staged: "+x" });
		const fenced = await generateCommitMessage(repo, reader(), () => Promise.resolve("```\nfeat: fenced\n```"));
		expect(fenced).toEqual({ kind: "generated", message: "feat: fenced", source: "staged" });

		const empty: CommitMessageOutcome = await generateCommitMessage(repo, reader(), () =>
			Promise.resolve("```\n\n```")
		);
		expect(empty).toEqual({ kind: "emptyResult" });
	});

	test("the custom prompt reaches send in place of the built-in instruction", async () => {
		const { repo } = fakeRepo({ staged: "+x" });
		let seenPrompt = "";
		await generateCommitMessage(repo, reader({ prompt: "House rules only." }), (_ref, prompt) => {
			seenPrompt = prompt;
			return Promise.resolve("feat: custom");
		});
		expect(seenPrompt).toContain("House rules only.");
		expect(seenPrompt).not.toContain(BUILT_IN_COMMIT_INSTRUCTION);
	});

	test("cancellation and failures from send propagate uncaught", async () => {
		const { repo } = fakeRepo({ staged: "+x" });
		const failure = new Error("boom");
		let caught: unknown;
		try {
			await generateCommitMessage(repo, reader(), () => Promise.reject(failure));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(failure);
	});
});
