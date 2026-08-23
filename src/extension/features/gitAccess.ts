import * as vscode from "vscode";
import type { API, GitExtension, Repository } from "./gitApi";

/**
 * The features' shared entry into the built-in Git extension. At the features/
 * root like gitApi.d.ts and errorLabel.ts, because features may not import
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
