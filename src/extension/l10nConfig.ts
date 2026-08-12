/**
 * Feeds the host-resolved l10n bundle into @vscode/l10n, which src/shared
 * and the src/dashboard tree localize with (they cannot import vscode).
 * This is the one sanctioned host-side @vscode/l10n import; all
 * other extension and provider code uses vscode.l10n.t, and Biome's
 * noRestrictedImports pins both directions. Under English
 * vscode.l10n.bundle is undefined and t() falls back to its inline message.
 */
import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";

export function configureSharedL10n(): void {
	if (vscode.l10n.bundle !== undefined) {
		l10n.config({ contents: vscode.l10n.bundle });
	}
}
