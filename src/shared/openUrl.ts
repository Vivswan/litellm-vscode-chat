import * as vscode from "vscode";

// Not vscode.env.openExternal: it re-encodes an already-encoded query, so "#" reaches the target as "%2523".
export async function openUrl(url: string): Promise<void> {
	await vscode.commands.executeCommand("vscode.open", url);
}
