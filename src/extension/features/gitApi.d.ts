/**
 * Minimal hand-typed subset of the vscode.git extension's exported API,
 * mirrored from the upstream declaration file
 * (extensions/git/src/api/git.d.ts in the microsoft/vscode repository).
 * Only the members the commit-message flow touches are declared; member
 * shapes match upstream so a fuller vendored copy would merge as identical
 * declarations. Acquired at runtime via
 * vscode.extensions.getExtension<GitExtension>("vscode.git").
 */
import type { Uri } from "vscode";

export interface InputBox {
	value: string;
}

export interface Change {
	readonly uri: Uri;
	/** Upstream's Status enum value; declared as number here because a const enum in a .d.ts has no runtime object to import. */
	readonly status: number;
}

export interface RepositoryState {
	readonly indexChanges: Change[];
	readonly workingTreeChanges: Change[];
	/** Holds the untracked files when git.untrackedChanges is "separate"; "mixed" (the default) puts them in workingTreeChanges. */
	readonly untrackedChanges: Change[];
}

export interface Commit {
	readonly hash: string;
	readonly message: string;
}

export interface LogOptions {
	readonly maxEntries?: number;
}

export interface Repository {
	readonly rootUri: Uri;
	readonly inputBox: InputBox;
	readonly state: RepositoryState;

	/** The working-tree diff, or the index diff when `cached` is true. */
	diff(cached?: boolean): Promise<string>;
	log(options?: LogOptions): Promise<Commit[]>;
}

export interface API {
	readonly repositories: Repository[];
}

export interface GitExtension {
	readonly enabled: boolean;
	getAPI(version: 1): API;
}
