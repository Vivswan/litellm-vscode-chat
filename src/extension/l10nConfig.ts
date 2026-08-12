/**
 * Feeds the host-resolved l10n bundle into @vscode/l10n, the one l10n API
 * every runtime localizes with. This runs at the top of activate(), before
 * any t() call can resolve; the vscode.l10n.bundle read here (and the
 * dashboard shell's, which forwards the same bundle to the webview) is the
 * only sanctioned use of vscode's l10n surface - scripts/l10n/check.ts bans
 * the rest. Under English vscode.l10n.bundle is undefined and t() falls back
 * to its inline message.
 */
import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";

export function configureSharedL10n(): void {
	if (vscode.l10n.bundle !== undefined) {
		l10n.config({ contents: vscode.l10n.bundle });
	}
}
