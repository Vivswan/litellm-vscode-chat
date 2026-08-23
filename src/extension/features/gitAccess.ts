import * as vscode from "vscode";
import type { API, GitExtension, Repository } from "./gitApi";

/**
 * The features' shared entry into the built-in Git extension. At the features/
 * root like gitApi.d.ts and featureChatSend.ts, because features may not import
 * each other (Biome-enforced) and every git-backed feature needs the same two
 * things: the API handle, and the repository one invocation targets. Copy per
 * feature is what this exists to prevent - the repository-picking rules
 * (command argument, single repository, quick pick, dismissal) are one
 * behavior, not one per command.
 */

/**
 * The built-in Git extension's API, activating the extension when needed.
 * Undefined when it is unavailable or disabled (git.enabled: false).
 */
export async function resolveGitApi(): Promise<API | undefined> {
	const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
	if (extension === undefined) {
		return undefined;
	}
	const gitExtension = extension.isActive ? extension.exports : await extension.activate();
	return gitExtension.enabled ? gitExtension.getAPI(1) : undefined;
}

/** The quick pick's own strings; each command names itself, so no localized text lives in this module. */
export interface RepositoryPickTexts {
	readonly title: string;
	readonly placeHolder: string;
}

/**
 * The repository the invocation targets: a menu button passes its SourceControl
 * (matched by rootUri), the palette gets the single open repository or a
 * picker. Undefined when there is none; "dismissed" when the user backed out of
 * the picker (silence, not advice, is the right answer).
 */
export async function pickRepository(
	git: API,
	commandArg: unknown,
	texts: RepositoryPickTexts
): Promise<Repository | "dismissed" | undefined> {
	const argRoot =
		typeof commandArg === "object" && commandArg !== null && "rootUri" in commandArg
			? (commandArg as { rootUri?: vscode.Uri }).rootUri?.toString()
			: undefined;
	if (argRoot !== undefined) {
		const matched = git.repositories.find((repo) => repo.rootUri.toString() === argRoot);
		if (matched !== undefined) {
			return matched;
		}
	}
	if (git.repositories.length <= 1) {
		return git.repositories[0];
	}
	const picked = await vscode.window.showQuickPick(
		git.repositories.map((repo) => ({ label: repo.rootUri.fsPath, repo })),
		{ title: texts.title, placeHolder: texts.placeHolder }
	);
	return picked?.repo ?? "dismissed";
}

/**
 * The label a file travels to the model under: its workspace-relative path,
 * or - for a file in no workspace folder, where asRelativePath hands back the
 * absolute filesystem path - the bare file name. Home directories and user
 * names are not part of a code review, and the docs promise a relative path.
 */
export function documentLabel(uri: vscode.Uri): string {
	const relative = vscode.workspace.asRelativePath(uri, false);
	// asRelativePath returns the input untouched when nothing contains it; on
	// Windows that is a drive path, so both separators count.
	const outsideWorkspace = relative === uri.fsPath || relative === uri.path;
	return outsideWorkspace ? (relative.split(/[\\/]/).pop() ?? relative) : relative;
}

/**
 * A file's path relative to its repository root, slash-normalized - the form
 * git itself speaks, for passing to git commands. NOT the label a model sees:
 * a URI outside the root keeps its full path here rather than being rewritten
 * into a wrong relative one, and documentLabel is what guarantees no absolute
 * path reaches a prompt.
 */
export function repositoryRelativePath(root: vscode.Uri, uri: vscode.Uri): string {
	const rootPath = root.fsPath.replace(/[/\\]+$/, "");
	const full = uri.fsPath;
	const relative =
		full.startsWith(`${rootPath}/`) || full.startsWith(`${rootPath}\\`)
			? full.slice(rootPath.length).replace(/^[/\\]+/, "")
			: full;
	return relative.replace(/\\/g, "/");
}
