import { stripMarkdownFences, truncateHeadWithMarker, truncationMarker } from "../../../shared/util/text";
import type { Commit, Repository } from "../gitApi";

/**
 * The commit-message generation core: pure prompt assembly plus one
 * dependency-injected flow, so the whole pipeline typechecks and tests without
 * the settings readers and the command surface that wire it up. No vscode
 * imports beyond the git API types (erased), no UI, no logging: the command
 * that consumes this maps the returned outcomes to progress and notifications
 * and owns the logging boundary.
 */

/** Head-truncation bound for the diff sent to the model; everything past it is noise for a commit subject. */
export const DIFF_CHAR_LIMIT = 80_000;

/** How many recent commit subjects ride along as style examples. */
export const STYLE_EXAMPLE_COUNT = 5;

/** How many untracked paths may ride the prompt; a count marker stands in for the tail of a huge tree. */
export const UNTRACKED_PATHS_LIMIT = 100;

/**
 * The built-in instruction, used when the user's custom prompt is blank.
 * Model-facing text, so it lives here and stays English by policy (it is
 * quoted in the docs for users to copy-edit into their own prompt setting).
 */
export const BUILT_IN_COMMIT_INSTRUCTION = [
	"Write a commit message for the change in the diff below.",
	'Use the Conventional Commits form: one subject line like "type(scope): summary" (types such as feat, fix, docs, refactor, test, chore), at most about 72 characters, in the imperative mood.',
	"When the change needs explanation, add a blank line and a short body of one to three sentences saying what changed and why.",
	"Answer with the commit message text only: no markdown fences, no surrounding quotes, no commentary.",
].join("\n");

/** The user's chosen model: a declared server entry label plus the raw model ID it serves. */
export interface CommitModelRef {
	readonly server: string;
	readonly model: string;
}

/** The configuration this flow reads, injected so the core stays independent of the settings surface. */
export interface CommitGenerationReader {
	/** The configured feature model; undefined when unset (the feature is fail-closed inert without one). */
	modelRef(): CommitModelRef | undefined;
	/** The user's custom instruction; blank means the built-in one. */
	prompt(): string;
}

/** Sends the assembled prompt to the referenced model and returns the reply text. */
export type CommitMessageSend = (ref: CommitModelRef, prompt: string) => Promise<string>;

/** Which diff the message describes: the index, or the whole working tree when nothing is staged. */
export type CommitDiffSource = "staged" | "workingTree";

/**
 * The flow's result as a closed set of values; the command maps each to its
 * localized presentation, so no UI string lives here.
 */
export type CommitMessageOutcome =
	| { readonly kind: "generated"; readonly message: string; readonly source: CommitDiffSource }
	| { readonly kind: "noModel" }
	| { readonly kind: "noChanges" }
	| { readonly kind: "emptyResult" };

export interface CommitPromptArgs {
	/** The user's custom instruction; blank (empty or whitespace) selects the built-in one, non-blank replaces it wholesale and verbatim. */
	readonly customPrompt: string;
	readonly diff: string;
	/** Recent commit subjects, newest first - subjects only, bodies never ride along. */
	readonly recentSubjects: readonly string[];
	/** Untracked file paths riding along on the working-tree fallback - paths only, never contents. */
	readonly untrackedPaths: readonly string[];
}

/**
 * Assemble the model prompt: the instruction, the style examples (riding along
 * whichever instruction is active), the head-truncated diff, and the untracked
 * paths. An empty diff keeps its section out (an untracked-only change has
 * only the path list to describe).
 */
export function buildCommitPrompt(args: CommitPromptArgs): string {
	const instruction = args.customPrompt.trim() === "" ? BUILT_IN_COMMIT_INSTRUCTION : args.customPrompt;
	// The marker rides inside the limit (the shared wrapper's contract), so the
	// diff section never exceeds the stated bound.
	const diff = truncateHeadWithMarker(args.diff, DIFF_CHAR_LIMIT, truncationMarker("diff"));
	const sections = [instruction];
	if (args.recentSubjects.length > 0) {
		const examples = args.recentSubjects.map((subject) => `- ${subject}`).join("\n");
		sections.push(`Recent commit subjects from this repository, newest first, as style examples:\n${examples}`);
	}
	if (args.untrackedPaths.length > 0) {
		const listed = args.untrackedPaths.slice(0, UNTRACKED_PATHS_LIMIT);
		const omitted = args.untrackedPaths.length - listed.length;
		const paths = listed.map((path) => `- ${path}`).join("\n");
		const overflow = omitted > 0 ? `\n[and ${omitted} more untracked ${omitted === 1 ? "file" : "files"}]` : "";
		sections.push(`New files added in this change (paths only; contents not shown):\n${paths}${overflow}`);
	}
	if (diff.trim() !== "") {
		sections.push(`Diff:\n${diff}`);
	}
	return sections.join("\n\n");
}

/** The subject lines of a log slice: first line of each message, blanks dropped. Never the bodies. */
export function commitSubjects(commits: readonly Commit[]): string[] {
	return commits.map((commit) => (commit.message.split("\n", 1)[0] ?? "").trim()).filter((subject) => subject !== "");
}

/**
 * Upstream vscode.git's Status.UNTRACKED (extensions/git/src/api/git.d.ts in
 * microsoft/vscode); a plain number because the upstream const enum has no
 * runtime object a hand-typed subset could import.
 */
const GIT_STATUS_UNTRACKED = 7;

/**
 * The untracked files of the working tree as repository-relative paths,
 * sorted and slash-normalized (the diff hunks beside them use forward
 * slashes). Both state arrays are read because the user's git.untrackedChanges
 * setting decides where untracked files land: "mixed" (the default) puts them
 * in workingTreeChanges, "separate" in untrackedChanges. Paths only, never
 * contents: untracked files can be large and can be exactly the files that
 * hold secrets, so the prompt names them and no more.
 */
export function untrackedRelativePaths(repo: Pick<Repository, "rootUri" | "state">): string[] {
	const root = repo.rootUri.fsPath.replace(/[/\\]+$/, "");
	const paths = [...repo.state.workingTreeChanges, ...repo.state.untrackedChanges]
		.filter((change) => change.status === GIT_STATUS_UNTRACKED)
		.map((change) => {
			const full = change.uri.fsPath;
			const relative =
				full.startsWith(`${root}/`) || full.startsWith(`${root}\\`)
					? full.slice(root.length).replace(/^[/\\]+/, "")
					: full;
			return relative.replace(/\\/g, "/");
		});
	return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

/**
 * The flow: staged diff first, the whole working tree when nothing is staged,
 * a typed outcome when both are empty or no model is configured. The fallback
 * is the git API's plain working-tree diff, which excludes untracked files -
 * like `git diff` itself - so their PATHS ride along from the repository
 * state instead, and an untracked-only change still generates. Style examples
 * come from the last STYLE_EXAMPLE_COUNT commit subjects; a repository whose
 * log fails (no commits yet) simply contributes none. Cancellation thrown by
 * `send` propagates uncaught, as everywhere.
 */
export async function generateCommitMessage(
	repo: Pick<Repository, "diff" | "log" | "rootUri" | "state">,
	reader: CommitGenerationReader,
	send: CommitMessageSend
): Promise<CommitMessageOutcome> {
	const ref = reader.modelRef();
	if (ref === undefined) {
		return { kind: "noModel" };
	}
	let diff = await repo.diff(true);
	let source: CommitDiffSource = "staged";
	let untrackedPaths: string[] = [];
	if (diff.trim() === "") {
		diff = await repo.diff(false);
		source = "workingTree";
		untrackedPaths = untrackedRelativePaths(repo);
	}
	if (diff.trim() === "" && untrackedPaths.length === 0) {
		return { kind: "noChanges" };
	}
	let recentSubjects: string[] = [];
	try {
		recentSubjects = commitSubjects(await repo.log({ maxEntries: STYLE_EXAMPLE_COUNT }));
	} catch {
		// A repository with no commits yet: git log fails, and the prompt simply
		// carries no style examples.
	}
	const prompt = buildCommitPrompt({ customPrompt: reader.prompt(), diff, recentSubjects, untrackedPaths });
	const message = stripMarkdownFences(await send(ref, prompt));
	if (message === "") {
		return { kind: "emptyResult" };
	}
	return { kind: "generated", message, source };
}
