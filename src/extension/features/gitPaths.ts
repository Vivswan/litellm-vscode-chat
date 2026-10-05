/**
 * Pure path arithmetic for the git-backed features, kept free of vscode imports so commitGen/commitMessage.ts, whose
 * suite runs in the bun tree, can import it. The structural parameter accepts vscode.Uri and the git API's Uri without
 * naming either.
 */

/**
 * A file's path relative to its repository root, slash-normalized - the form git itself speaks, for passing to git
 * commands and for naming untracked files in a prompt. NOT the label a model sees for file content: a URI outside the
 * root keeps its full path here rather than being rewritten into a wrong relative one, and gitAccess.documentLabel is
 * what guarantees no absolute path reaches a prompt as a document label.
 */
export function repositoryRelativePath(root: { readonly fsPath: string }, uri: { readonly fsPath: string }): string {
	const rootPath = root.fsPath.replace(/[/\\]+$/, "");
	const full = uri.fsPath;
	const relative =
		full.startsWith(`${rootPath}/`) || full.startsWith(`${rootPath}\\`)
			? full.slice(rootPath.length).replace(/^[/\\]+/, "")
			: full;
	return relative.replace(/\\/g, "/");
}
