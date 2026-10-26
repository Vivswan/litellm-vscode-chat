/**
 * Minimal hand-typed subset of the vscode.git extension's exported API, mirrored from the upstream declaration file
 * (extensions/git/src/api/git.d.ts in the microsoft/vscode repository).
 *
 *   Only the members the commit-message and PR-description flows touch -> are declared
 */
import type { Uri } from "vscode";

export interface InputBox {
	value: string;
}

/**
 * One changed file. `status` is upstream's Status enum value, a number here because a const enum in a .d.ts has no
 * runtime object to import.
 */
export interface Change {
	readonly uri: Uri;
	readonly status: number;
}

/** A branch's tracked remote branch: the remote's name plus the branch name on it. */
export interface UpstreamRef {
	readonly remote: string;
	readonly name: string;
	readonly commit?: string;
}

/**
 * A branch. Upstream declares this as `Ref` plus the tracking members; only the
 * members the PR flow reads are declared here, and `type` is left to a fuller
 * copy. `remote` is set on remote-tracking branches (the shape `getBranchBase`
 * answers with, where `name` carries no remote prefix); `upstream` is set on
 * local branches that track one. `ahead`/`behind` count the commits by which a
 * local branch and its tracked remote branch have diverged as of the last
 * fetch, and are absent when git reported none.
 */
export interface Branch {
	readonly name?: string;
	readonly commit?: string;
	readonly remote?: string;
	readonly upstream?: UpstreamRef;
	readonly ahead?: number;
	readonly behind?: number;
}

/**
 * `HEAD` is the checked-out branch, or undefined before the repository state has loaded. It is present but partial in
 * two states, because upstream builds it from `.git/HEAD` first and only then resolves the ref: on an unborn branch
 * `name` is set and `commit` is absent (there is no commit to resolve, and `git diff HEAD` cannot answer), and on a
 * detached HEAD `commit` is set and `name` may be absent.
 *
 * `untrackedChanges` holds the untracked files when git.untrackedChanges is "separate"; "mixed" (the default) puts
 * them in `workingTreeChanges`.
 */
export interface RepositoryState {
	readonly HEAD: Branch | undefined;
	readonly indexChanges: Change[];
	readonly workingTreeChanges: Change[];
	readonly untrackedChanges: Change[];
}

/** One log entry. `parents` holds the parent hashes; a merge commit has more than one. */
export interface Commit {
	readonly hash: string;
	readonly message: string;
	readonly parents: string[];
}

export interface LogOptions {
	/** Max log entries; IGNORED when `range` is set, since git's log builder passes the range or -n, never both. */
	readonly maxEntries?: number;

	/** A git revision range, e.g. "<mergeBase>..HEAD"; the log answers newest first within it. */
	readonly range?: string;
}

export interface Repository {
	readonly rootUri: Uri;

	readonly inputBox: InputBox;

	readonly state: RepositoryState;

	/** The working-tree diff, or the index diff when `cached` is true. */
	diff(cached?: boolean): Promise<string>;

	/**
	 * `git diff <ref>`: the files changed against a ref, or one file's diff
	 * against it. Against HEAD that is every uncommitted change, staged and
	 * unstaged together - which neither `diff()` overload reports - with
	 * untracked files excluded by construction (upstream runs
	 * `--diff-filter=ADMR`). `path` is repository-relative.
	 */
	diffWith(ref: string): Promise<Change[]>;

	diffWith(ref: string, path: string): Promise<string>;

	log(options?: LogOptions): Promise<Commit[]>;

	/** Rejects when no branch carries the name. */
	getBranch(name: string): Promise<Branch>;

	/**
	 * The branch a PR from `name` would target: a REMOTE-tracking branch (git's
	 * own resolution only accepts one), so its `name` carries no remote prefix
	 * and `remote` names the remote. May reject - it writes the branch's
	 * recorded merge base back to git config.
	 */
	getBranchBase(name: string): Promise<Branch | undefined>;

	/** The best common ancestor of two refs. */
	getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
}

export interface API {
	readonly repositories: Repository[];
}

export interface GitExtension {
	readonly enabled: boolean;
	getAPI(version: 1): API;
}
