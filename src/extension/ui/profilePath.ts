import * as vscode from "vscode";

/**
 * THE profile User-directory derivation: `globalStorage/<extension-id>` sits
 * directly under the profile's User directory (default and named profiles
 * alike), so a file kept there is two levels up from the extension's global
 * storage. VS Code exposes no API for these files, so every deep link into
 * them resolves through this one function; a source-shape test pins the
 * walk's spelling to this file.
 */
export function profileUserFileUri(globalStorageUri: vscode.Uri, fileName: string): vscode.Uri {
	return vscode.Uri.joinPath(globalStorageUri, "..", "..", fileName);
}
