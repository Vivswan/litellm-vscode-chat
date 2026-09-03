import { describe, expect, test } from "bun:test";
import type { Branch, Change, Commit, Repository } from "../../../../../extension/features/gitApi";
import {
	collectBranchContext,
	ghprCommitOrder,
	oldestFirstMessages,
	PR_PATCH_FILE_LIMIT,
} from "../../../../../extension/features/prGen/branchContext";
import { buildPrPrompt, PATCHES_CHAR_LIMIT } from "../../../../../extension/features/prGen/prompt";

/**
 * The branch walk and the upstream-context ordering rule. Both are pure over
 * the injected Repository, so the whole thing runs without a git checkout.
 */

function commit(hash: string, message: string, parents: string[] = ["p"]): Commit {
	return { hash, message, parents };
}

function change(fsPath: string): Change {
	return { uri: { fsPath, toString: () => `file://${fsPath}` } as unknown as Change["uri"], status: 5 };
}

interface FakeRepoParts {
	head?: Branch | undefined;
	branchBase?: Branch | undefined;
	mergeBase?: string | undefined;
	commits?: Commit[];
	changes?: Change[];
	/** Per-path patch text; a path with no entry throws, standing in for a binary or vanished file. */
	patches?: Record<string, string>;
	calls?: {
		log?: { range?: string | undefined };
		patchPaths?: string[];
		mergeBaseRefs?: [string, string];
		branchBaseThrows?: boolean;
	};
}

function fakeRepo(parts: FakeRepoParts): Repository {
	const calls = parts.calls ?? {};
	calls.patchPaths = [];
	return {
		rootUri: { fsPath: "/repo", toString: () => "file:///repo" } as unknown as Repository["rootUri"],
		inputBox: { value: "" },
		state: {
			HEAD: parts.head,
			indexChanges: [],
			workingTreeChanges: [],
			untrackedChanges: [],
		},
		diff: () => Promise.resolve(""),
		diffWith: ((ref: string, path?: string) => {
			if (path === undefined) {
				return Promise.resolve(parts.changes ?? []);
			}
			calls.patchPaths?.push(path);
			const patch = parts.patches?.[path];
			if (patch === undefined) {
				return Promise.reject(new Error(`no patch for ${path} against ${ref}`));
			}
			return Promise.resolve(patch);
		}) as Repository["diffWith"],
		log: (options) => {
			calls.log = { range: options?.range };
			return Promise.resolve(parts.commits ?? []);
		},
		getBranch: (name: string) => Promise.reject(new Error(`no branch ${name}`)),
		getBranchBase: () =>
			parts.calls?.branchBaseThrows === true
				? Promise.reject(new Error("read-only repository"))
				: Promise.resolve(parts.branchBase),
		getMergeBase: (ref1: string, ref2: string) => {
			calls.mergeBaseRefs = [ref1, ref2];
			return Promise.resolve(parts.mergeBase);
		},
	};
}

describe("extension/features/prGen ghprCommitOrder", () => {
	test("a branch with no upstream was collected from git log, newest first", () => {
		expect(ghprCommitOrder({ name: "feature" })).toBe("newestFirst");
	});

	test("a pushed, undiverged branch was collected from the compare API, oldest first", () => {
		expect(ghprCommitOrder({ name: "feature", upstream: { remote: "origin", name: "feature" } })).toBe("oldestFirst");
		// Counts git did not report read as in sync, which is the plain
		// upstream-ref rule.
		expect(
			ghprCommitOrder({ name: "feature", upstream: { remote: "origin", name: "feature" }, ahead: 0, behind: 0 })
		).toBe("oldestFirst");
	});

	test("a diverged branch falls back to the git-log order, either direction", () => {
		const upstream = { remote: "origin", name: "feature" };
		expect(ghprCommitOrder({ name: "feature", upstream, ahead: 2, behind: 0 })).toBe("newestFirst");
		expect(ghprCommitOrder({ name: "feature", upstream, ahead: 0, behind: 3 })).toBe("newestFirst");
	});
});

describe("extension/features/prGen oldestFirstMessages", () => {
	test("an oldest-first list passes through and a newest-first list is reversed", () => {
		const messages = ["first", "second", "third"];
		expect(oldestFirstMessages(messages, "oldestFirst")).toEqual(["first", "second", "third"]);
		expect(oldestFirstMessages(messages, "newestFirst")).toEqual(["third", "second", "first"]);
	});

	test("the input is never mutated - the caller's context array survives", () => {
		const messages = ["a", "b"];
		oldestFirstMessages(messages, "newestFirst");
		expect(messages).toEqual(["a", "b"]);
	});

	test("empty and single-element lists are order-invariant", () => {
		expect(oldestFirstMessages([], "newestFirst")).toEqual([]);
		expect(oldestFirstMessages(["only"], "newestFirst")).toEqual(["only"]);
	});
});

describe("extension/features/prGen collectBranchContext", () => {
	const head: Branch = { name: "feature/x", commit: "abc" };
	// The shape getBranchBase actually returns: a remote-tracking branch, whose
	// `name` carries no remote prefix and whose `remote` names the remote.
	const base: Branch = { name: "main", remote: "origin", commit: "base-sha" };

	test("collects the branch's commits oldest first and one patch block per changed file", async () => {
		const calls: FakeRepoParts["calls"] = {};
		const repo = fakeRepo({
			head,
			branchBase: base,
			mergeBase: "base-sha",
			// git log answers newest first; the context must not.
			commits: [commit("c", "third"), commit("b", "second"), commit("a", "first")],
			changes: [change("/repo/one.ts"), change("/repo/two.ts")],
			patches: { "/repo/one.ts": "@@ one", "/repo/two.ts": "@@ two" },
			calls,
		});
		const outcome = await collectBranchContext(repo);
		expect(outcome.kind).toBe("collected");
		if (outcome.kind !== "collected") {
			return;
		}
		expect(outcome.context.commitMessages).toEqual(["first", "second", "third"]);
		expect(outcome.context.compareBranch).toBe("feature/x");
		expect(outcome.context.patches).toEqual([
			{ patch: "@@ one", fileUri: "file:///repo/one.ts" },
			{ patch: "@@ two", fileUri: "file:///repo/two.ts" },
		]);
		// The comparison runs from the merge base, not the base tip, so commits
		// that landed on the base meanwhile are not this branch's work.
		expect(calls.log?.range).toBe("base-sha..HEAD");
		// And the base is addressed by its REMOTE ref: a bare "main" would name a
		// local branch that may be missing or stale.
		expect(calls.mergeBaseRefs).toEqual(["origin/main", "HEAD"]);
		// Nothing the GitHub extension enriches is invented locally.
		expect(outcome.context.template).toBeUndefined();
		expect(outcome.context.issues).toBeUndefined();
	});

	test("merge commits and blank messages stay out of the commit list", async () => {
		const repo = fakeRepo({
			head,
			branchBase: base,
			mergeBase: "base-sha",
			commits: [
				commit("m", "Merge branch 'main' into feature/x", ["p1", "p2"]),
				commit("b", "   \n  "),
				commit("a", "feat: real work"),
			],
			changes: [change("/repo/one.ts")],
			patches: { "/repo/one.ts": "@@ one" },
		});
		const outcome = await collectBranchContext(repo);
		expect(outcome.kind === "collected" && outcome.context.commitMessages).toEqual(["feat: real work"]);
	});

	test("a file whose patch cannot be read is skipped, not fatal", async () => {
		const repo = fakeRepo({
			head,
			branchBase: base,
			mergeBase: "base-sha",
			commits: [commit("a", "feat: x")],
			changes: [change("/repo/binary.png"), change("/repo/one.ts")],
			patches: { "/repo/one.ts": "@@ one" },
		});
		const outcome = await collectBranchContext(repo);
		expect(outcome.kind === "collected" && outcome.context.patches).toEqual([
			{ patch: "@@ one", fileUri: "file:///repo/one.ts" },
		]);
	});

	test("an empty patch contributes no block", async () => {
		const repo = fakeRepo({
			head,
			branchBase: base,
			mergeBase: "base-sha",
			commits: [commit("a", "feat: x")],
			changes: [change("/repo/one.ts")],
			patches: { "/repo/one.ts": "   \n" },
		});
		expect(await collectBranchContext(repo)).toEqual({
			kind: "collected",
			context: { commitMessages: ["feat: x"], patches: [], compareBranch: "feature/x" },
		});
	});

	test("the per-file git calls are bounded by PR_PATCH_FILE_LIMIT", async () => {
		const files = Array.from({ length: PR_PATCH_FILE_LIMIT + 25 }, (_value, index) => `/repo/file${index}.ts`);
		const calls: FakeRepoParts["calls"] = {};
		const repo = fakeRepo({
			head,
			branchBase: base,
			mergeBase: "base-sha",
			commits: [commit("a", "feat: x")],
			changes: files.map(change),
			patches: Object.fromEntries(files.map((file) => [file, `@@ ${file}`])),
			calls,
		});
		const outcome = await collectBranchContext(repo);
		expect(calls.patchPaths?.length).toBe(PR_PATCH_FILE_LIMIT);
		expect(outcome.kind === "collected" && outcome.context.patches.length).toBe(PR_PATCH_FILE_LIMIT);
	});

	test("a detached HEAD or unborn branch has nothing to describe", async () => {
		expect((await collectBranchContext(fakeRepo({ head: undefined }))).kind).toBe("noBranch");
		expect((await collectBranchContext(fakeRepo({ head: { commit: "abc" } }))).kind).toBe("noBranch");
		expect((await collectBranchContext(fakeRepo({ head: { name: "" } }))).kind).toBe("noBranch");
	});

	test("no base branch and a nameless base read as noBase", async () => {
		expect((await collectBranchContext(fakeRepo({ head, branchBase: undefined }))).kind).toBe("noBase");
		// A nameless base cannot be addressed at all.
		expect((await collectBranchContext(fakeRepo({ head, branchBase: { commit: "x" } }))).kind).toBe("noBase");
	});

	test("unrelated histories - no merge base - read as noBase rather than an empty comparison", async () => {
		const repo = fakeRepo({ head, branchBase: base, mergeBase: undefined });
		expect((await collectBranchContext(repo)).kind).toBe("noBase");
	});

	test("a branch level with its base has nothing to describe", async () => {
		const repo = fakeRepo({ head, branchBase: base, mergeBase: "base-sha", commits: [], changes: [] });
		expect((await collectBranchContext(repo)).kind).toBe("noChanges");
	});

	test("a base carrying only an upstream ref still resolves to the remote form", async () => {
		const calls: FakeRepoParts["calls"] = {};
		const repo = fakeRepo({
			head,
			branchBase: { name: "main", upstream: { remote: "upstream", name: "trunk" } },
			mergeBase: "dev-sha",
			commits: [commit("a", "feat: x")],
			changes: [],
			calls,
		});
		expect((await collectBranchContext(repo)).kind).toBe("collected");
		expect(calls.mergeBaseRefs).toEqual(["upstream/trunk", "HEAD"]);
	});

	test("a base with neither remote nor upstream falls back to its bare name", async () => {
		const calls: FakeRepoParts["calls"] = {};
		const repo = fakeRepo({
			head,
			branchBase: { name: "develop" },
			mergeBase: "dev-sha",
			commits: [commit("a", "feat: x")],
			changes: [],
			calls,
		});
		expect((await collectBranchContext(repo)).kind).toBe("collected");
		expect(calls.mergeBaseRefs).toEqual(["develop", "HEAD"]);
	});

	test("a rejecting getBranchBase is the noBase advice, not an error", async () => {
		// It writes the resolved base back to git config, so a read-only
		// repository makes it throw.
		const repo = fakeRepo({ head, calls: { branchBaseThrows: true } });
		expect((await collectBranchContext(repo)).kind).toBe("noBase");
	});

	test("the walk count-bounds nothing: both ends reach the prompt, which thins the middle", async () => {
		// Trimming one end here would hand the selection back to whichever end
		// this function cut, which is exactly what the prompt's middle thinning
		// exists to avoid.
		const many = Array.from({ length: 200 }, (_value, index) => commit(`c${index}`, `feat: change ${index}`));
		const repo = fakeRepo({ head, branchBase: base, mergeBase: "base-sha", commits: many, changes: [] });
		const outcome = await collectBranchContext(repo);
		expect(outcome.kind === "collected" && outcome.context.commitMessages.length).toBe(200);
		// The log answers newest first; the context is oldest first.
		expect(outcome.kind === "collected" && outcome.context.commitMessages[0]).toBe("feat: change 199");
		expect(outcome.kind === "collected" && outcome.context.commitMessages.at(-1)).toBe("feat: change 0");
	});

	test("patch collection stops once the prompt's whole patch budget is spent", async () => {
		const files = Array.from({ length: 20 }, (_value, index) => `/repo/big${index}.ts`);
		const calls: FakeRepoParts["calls"] = {};
		const repo = fakeRepo({
			head,
			branchBase: base,
			mergeBase: "base-sha",
			commits: [commit("a", "feat: x")],
			changes: files.map(change),
			// Each file alone is a third of the prompt's whole patch budget.
			patches: Object.fromEntries(files.map((file) => [file, "x".repeat(50_000)])),
			calls,
		});
		await collectBranchContext(repo);
		expect(calls.patchPaths?.length).toBeLessThan(files.length);
	});

	test("the collected patches survive prompt assembly whole - no tail file lost to the second cut", async () => {
		// The property the per-block overhead charge exists for: the prompt cuts
		// the ASSEMBLED blocks (File: headers and separators included) at the same
		// constant, so a collection charged only for raw patch text would lose its
		// last files there.
		//
		// The paths must DIVERGE, not merely be long: patchBlocks relativizes
		// against the common prefix, so files sharing one deep directory collapse
		// to bare basenames and the assembled cost stays tiny however long the
		// URIs are. Here only "/repo/src/" is shared, so each header carries ~180
		// characters and the real per-block cost is impossible to under-reserve
		// by accident. Measured: a flat 32-character reserve accepts 60 blocks (59
		// whole plus a truncated stub) and the prompt truncates; the per-block
		// charge accepts 55 and it does not.
		const files = Array.from(
			{ length: 100 },
			(_value, index) => `/repo/src/pkg${index}/${"deeply/nested/".repeat(12)}file${index}.ts`
		);
		const repo = fakeRepo({
			head,
			branchBase: base,
			mergeBase: "base-sha",
			commits: [commit("a", "feat: x")],
			changes: files.map(change),
			// Each body carries its own marker: identical bodies would let a
			// tail-block assertion match the FIRST block and prove nothing.
			patches: Object.fromEntries(files.map((file, index) => [file, `patch-${index}-${"x".repeat(2_000)}`])),
		});
		const outcome = await collectBranchContext(repo);
		expect(outcome.kind).toBe("collected");
		if (outcome.kind !== "collected") {
			return;
		}
		const prompt = buildPrPrompt(outcome.context);
		expect(prompt).not.toContain("[patches truncated]");
		// Every block the walk collected reached the prompt - counted, not sampled,
		// and the LAST one named by its own marker so the check cannot be
		// satisfied by an earlier block.
		expect(outcome.context.patches.length).toBeGreaterThan(1);
		expect((prompt.match(/^File: /gm) ?? []).length).toBe(outcome.context.patches.length);
		const last = outcome.context.patches.at(-1) as { patch: string };
		expect(prompt).toContain(`patch-${outcome.context.patches.length - 1}-`);
		expect(prompt).toContain(last.patch.slice(0, 40));
	});

	test("a truncated patch is cut surrogate-safely - no lone half reaches the request body", async () => {
		// The cut position depends on the file URI's length, so a single fixture
		// could land on an even offset and pass even with a raw slice(). Two URIs
		// differing by one character give the two cuts opposite parity, so one of
		// them MUST fall inside a pair: a raw slice() fails this test.
		for (const path of ["/repo/a.ts", "/repo/ab.ts"]) {
			const repo = fakeRepo({
				head,
				branchBase: base,
				mergeBase: "base-sha",
				commits: [commit("a", "feat: x")],
				changes: [change(path)],
				// Every offset is half of a surrogate pair, so any odd cut splits one.
				patches: { [path]: "\u{1f389}".repeat(PATCHES_CHAR_LIMIT) },
			});
			const outcome = await collectBranchContext(repo);
			const patch = outcome.kind === "collected" ? (outcome.context.patches[0] as { patch: string }).patch : "";
			expect(patch.length).toBeGreaterThan(0);
			for (let i = 0; i < patch.length; i++) {
				const code = patch.charCodeAt(i);
				if (code >= 0xd800 && code <= 0xdbff) {
					const next = patch.charCodeAt(i + 1);
					expect(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at ${String(i)} for ${path}`).toBe(true);
					i++;
				} else {
					expect(code >= 0xdc00 && code <= 0xdfff, `lone low surrogate at ${String(i)} for ${path}`).toBe(false);
				}
			}
		}
	});

	test("even a single enormous patch is cut to the budget - the first file is not exempt", async () => {
		const repo = fakeRepo({
			head,
			branchBase: base,
			mergeBase: "base-sha",
			commits: [commit("a", "feat: x")],
			changes: [change("/repo/generated.ts")],
			patches: { "/repo/generated.ts": `${"x".repeat(PATCHES_CHAR_LIMIT * 4)}TAIL-BEYOND-THE-BUDGET` },
		});
		const outcome = await collectBranchContext(repo);
		const patch = outcome.kind === "collected" ? (outcome.context.patches[0] as { patch: string }).patch : "";
		expect(patch.length).toBeLessThanOrEqual(PATCHES_CHAR_LIMIT + "\n[patch truncated]".length);
		expect(patch).not.toContain("TAIL-BEYOND-THE-BUDGET");
	});

	test("a cancelled walk answers cancelled, so its partial gather is never sent", async () => {
		// Returning the partial context would put repository content on the wire
		// after the user asked for it to stop; answering noChanges would lie.
		const repo = fakeRepo({
			head,
			branchBase: base,
			mergeBase: "base-sha",
			commits: [commit("a", "feat: x")],
			changes: [change("/repo/one.ts")],
			patches: { "/repo/one.ts": "@@ one" },
		});
		expect((await collectBranchContext(repo, { isCancellationRequested: true } as never)).kind).toBe("cancelled");
	});

	test("a cancelled walk stops paying for per-file git calls", async () => {
		const files = Array.from({ length: 30 }, (_value, index) => `/repo/f${index}.ts`);
		const calls: FakeRepoParts["calls"] = {};
		const repo = fakeRepo({
			head,
			branchBase: base,
			mergeBase: "base-sha",
			commits: [commit("a", "feat: x")],
			changes: files.map(change),
			patches: Object.fromEntries(files.map((file) => [file, "@@ small"])),
			calls,
		});
		await collectBranchContext(repo, { isCancellationRequested: true } as never);
		expect(calls.patchPaths?.length).toBe(0);
	});

	test("a base whose leaf name matches the local branch is a real comparison, not a self-comparison", async () => {
		// Standing on local "main" with base "origin/main" - the fork-from-main
		// workflow. Refusing it would leave the user advice that fixes nothing.
		const calls: FakeRepoParts["calls"] = {};
		const repo = fakeRepo({
			head: { name: "main", commit: "abc" },
			branchBase: { name: "main", remote: "origin" },
			mergeBase: "base-sha",
			commits: [commit("a", "feat: unpushed work")],
			changes: [],
			calls,
		});
		expect((await collectBranchContext(repo)).kind).toBe("collected");
		expect(calls.mergeBaseRefs).toEqual(["origin/main", "HEAD"]);
	});

	test("a base that IS the branch's own upstream is its own outcome, not the noBase advice", async () => {
		const repo = fakeRepo({
			head: { name: "feature/x", commit: "abc", upstream: { remote: "origin", name: "feature/x" } },
			branchBase: { name: "feature/x", remote: "origin" },
			mergeBase: "base-sha",
			commits: [commit("a", "feat: x")],
			changes: [],
		});
		// Its own kind, because "set the upstream" would be advice that cannot
		// fix anything on a branch that already has one.
		expect((await collectBranchContext(repo)).kind).toBe("selfCompare");
	});
});
