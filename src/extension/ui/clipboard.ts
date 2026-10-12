import * as vscode from "vscode";
import { Logger } from "../../shared/logger";

/**
 * The one clipboard door: a configured value (a URL's password among them) quoted in diagnostics, a draft, or a
 * report never reaches the clipboard whole, and secret-free text comes out byte for byte. `clipboard` is injectable
 * because vscode.env.clipboard is read-only and a test cannot replace it.
 */
export function copyToClipboard(
	text: string,
	clipboard: Pick<vscode.Clipboard, "writeText"> = vscode.env.clipboard
): Thenable<void> {
	return clipboard.writeText(Logger.redact(text));
}
