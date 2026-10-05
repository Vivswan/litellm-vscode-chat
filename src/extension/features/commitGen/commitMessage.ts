import { stripMarkdownFences, truncateHeadWithMarker, truncationMarker } from "../../../shared/util/text";
import type { Commit, Repository } from "../gitApi";
import { repositoryRelativePath } from "../gitPaths";

/**
 * The commit-message generation core: pure prompt assembly plus one dependency-injected flow, so the whole pipeline
 * typechecks and tests without the settings readers and the command surface that wire it up. No vscode imports beyond
 * the git API types (erased) and the pure gitPaths helper, no UI, no logging: the command that consumes this maps the
 * returned outcomes to progress and notifications and owns the logging boundary.
 */

/** Head-truncation bound for the diff sent to the model; everything past it is noise for a commit subject. */
export const DIFF_CHAR_LIMIT = 80_000;

export const STYLE_EXAMPLE_COUNT = 5;

export const UNTRACKED_PATHS_LIMIT = 100;

/**
 * Model-facing text, so it lives here and stays English by policy (it is quoted in the docs for users to copy-edit
 * into their own prompt setting).
 */
export const BUILT_IN_COMMIT_INSTRUCTION = [
	"Write a commit message for the change in the diff below.",
	'Use the Conventional Commits form: one subject line like "type(scope): summary" (types such as feat, fix, docs, refactor, test, chore), at most about 72 characters, in the imperative mood.',
	"When the change needs explanation, add a blank line and a short body of one to three sentences saying what changed and why.",
	"Answer with the commit message text only: no markdown fences, no surrounding quotes, no commentary.",
].join("\n");

export interface CommitModelRef {
	readonly server: string;
	readonly model: string;
}

export interface CommitGenerationReader {
	modelRef(): CommitModelRef | undefined;
	prompt(): string;
}

export type CommitMessageSend = (ref: CommitModelRef, prompt: string) => Promise<string>;

export type CommitDiffSource = "staged" | "workingTree";

export type CommitMessageOutcome =
	| { readonly kind: "generated"; readonly message: string; readonly source: CommitDiffSource }
	| { readonly kind: "noModel" }
	| { readonly kind: "noChanges" }
	| { readonly kind: "emptyResult" };

export interface CommitPromptArgs {
	readonly customPrompt: string;
	readonly diff: string;
	/** Recent commit subjects, newest first - subjects only, bodies never ride along. */
	readonly recentSubjects: readonly string[];
	/** Untracked file paths riding along on the working-tree fallback - paths only, never contents. */
	readonly untrackedPaths: readonly string[];
}

export function buildCommitPrompt(args: CommitPromptArgs): string {
	const instruction = args.customPrompt.trim() === "" ? BUILT_IN_COMMIT_INSTRUCTION : args.customPrompt;
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

export function commitSubjects(commits: readonly Commit[]): string[] {
	return commits.map((commit) => (commit.message.split("\n", 1)[0] ?? "").trim()).filter((subject) => subject !== "");
}

/**
 * Upstream vscode.git's Status.UNTRACKED (extensions/git/src/api/git.d.ts in microsoft/vscode); a plain number because
 * the upstream const enum has no runtime object a hand-typed subset could import.
 */
const GIT_STATUS_UNTRACKED = 7;

/**
 * Both state arrays are read because the user's git.untrackedChanges setting decides where untracked files land:
 * "mixed" (the default) puts them in workingTreeChanges, "separate" in untrackedChanges. Paths only, never contents:
 * untracked files can be large and can be exactly the files that hold secrets, so the prompt names them and no more.
 *
 *   the diff hunks beside them use forward slashes -> slash-normalized
 */
export function untrackedRelativePaths(repo: Pick<Repository, "rootUri" | "state">): string[] {
	const paths = [...repo.state.workingTreeChanges, ...repo.state.untrackedChanges]
		.filter((change) => change.status === GIT_STATUS_UNTRACKED)
		.map((change) => repositoryRelativePath(repo.rootUri, change.uri));
	return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

/**
 * Cancellation thrown by `send` propagates uncaught, as everywhere.
 *
 *   The fallback is the git API's plain working-tree diff, which excludes untracked files - like `git diff` itself ->
 *     their PATHS ride along from the repository state instead
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
		// A repository with no commits yet: git log fails, and the prompt simply carries no style examples.
	}
	const prompt = buildCommitPrompt({ customPrompt: reader.prompt(), diff, recentSubjects, untrackedPaths });
	const message = stripMarkdownFences(await send(ref, prompt));
	if (message === "") {
		return { kind: "emptyResult" };
	}
	return { kind: "generated", message, source };
}
