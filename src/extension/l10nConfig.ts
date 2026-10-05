/**
 * MUST run at the top of activate(), before any t() call can resolve. The vscode.l10n.bundle read here (and the
 * dashboard shell's, which forwards the same bundle to the webview) is the only sanctioned use of vscode's l10n
 * surface - scripts/l10n/check.ts bans the rest.
 *
 *   Under English vscode.l10n.bundle is undefined -> t() falls back to its inline message
 */
import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";

export function configureSharedL10n(): void {
	if (vscode.l10n.bundle !== undefined) {
		l10n.config({ contents: vscode.l10n.bundle });
	}
}
