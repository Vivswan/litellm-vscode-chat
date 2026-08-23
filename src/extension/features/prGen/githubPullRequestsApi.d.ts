/**
 * Minimal hand-typed subset of the GitHub Pull Requests extension's exported
 * API, mirrored from the upstream declaration file (src/api/api.d.ts in the
 * microsoft/vscode-pull-request-github repository). Only the members the PR
 * title-and-description flow touches are declared, and member shapes match
 * upstream so a fuller vendored copy would merge as identical declarations,
 * with one deliberate narrowing: `registerTitleAndDescriptionProvider` is
 * declared optional (upstream requires it) because installed builds predating
 * the provider API lack the member, and the wiring feature-detects it with
 * `typeof` before calling. Acquired at runtime via
 * vscode.extensions.getExtension<GitHubPullRequestsApi>("GitHub.vscode-pull-request-github").
 */
import type { CancellationToken, Disposable } from "vscode";

export interface TitleAndDescriptionProvider {
	provideTitleAndDescription(
		context: {
			commitMessages: string[];
			patches: string[] | { patch: string; fileUri: string; previousFileUri?: string }[];
			issues?: { reference: string; content: string }[];
			template?: string;
			compareBranch?: string;
		},
		token: CancellationToken
	): Promise<{ title: string; description?: string } | undefined>;
}

/** Upstream's `API` interface, narrowed to the one member this feature touches. */
export interface GitHubPullRequestsApi {
	registerTitleAndDescriptionProvider?(title: string, provider: TitleAndDescriptionProvider): Disposable;
}
