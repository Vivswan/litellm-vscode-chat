import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { INTERNAL_CMD } from "../../../shared/config/commandIds";
import type { QuickFixMode } from "./query";
import { selectDiagnostics } from "./query";

/**
 * The Fix and Explain lightbulb actions. Everything here is SYNCHRONOUS and
 * touches no network: provideCodeActions runs on every cursor move in a file
 * with diagnostics, so an await here would put the extension in the editor's
 * latency path, and a request here would send the user's code somewhere
 * without them ever clicking anything. The actions carry a command instead;
 * the model is reached only once one is invoked.
 *
 * Which diagnostics an action claims is the pure core's decision
 * (selectDiagnostics), so the lightbulb, the chat query, and the fallback
 * prompt all speak about the same set.
 */

/**
 * What an invoked action hands its command. Real objects, not a serialized
 * payload: the command is internal and in-process, so the diagnostics ride
 * through unflattened and the fallback prompt can read their code and source.
 */
export interface QuickFixChatArgs {
	readonly uri: vscode.Uri;
	/** The lines the action claimed, already padded and clamped; what gets attached to the chat turn. */
	readonly range: vscode.Range;
	readonly diagnostics: readonly vscode.Diagnostic[];
	readonly mode: QuickFixMode;
}

/**
 * Lines of surrounding code the attached range carries beyond the claimed
 * diagnostics. A diagnostic's own range is frequently one token wide ("Cannot
 * find name 'x'"), and a model handed one token has been told nothing; two
 * lines either side is the smallest window that reliably carries the statement
 * and its neighbours.
 */
const CONTEXT_LINES = 2;

/**
 * The claimed diagnostics' lines, padded by CONTEXT_LINES and clamped to the
 * document, expanded to whole lines. Whole lines matter: a range ending
 * mid-token attaches a fragment the model has to guess the shape of.
 */
function claimedRange(document: vscode.TextDocument, diagnostics: readonly vscode.Diagnostic[]): vscode.Range {
	let first = Number.MAX_SAFE_INTEGER;
	let last = 0;
	for (const diagnostic of diagnostics) {
		first = Math.min(first, diagnostic.range.start.line);
		last = Math.max(last, diagnostic.range.end.line);
	}
	const startLine = Math.max(0, Math.min(first, document.lineCount - 1) - CONTEXT_LINES);
	const endLine = Math.min(document.lineCount - 1, last + CONTEXT_LINES);
	return new vscode.Range(new vscode.Position(startLine, 0), document.lineAt(endLine).range.end);
}

/** The lightbulb's title per mode; what the user reads before anything is sent. */
function actionTitle(mode: QuickFixMode): string {
	return mode === "fix" ? l10n.t("Fix with LiteLLM") : l10n.t("Explain with LiteLLM");
}

function buildAction(
	mode: QuickFixMode,
	document: vscode.TextDocument,
	diagnostics: readonly vscode.Diagnostic[]
): vscode.CodeAction {
	const action = new vscode.CodeAction(actionTitle(mode), vscode.CodeActionKind.QuickFix);
	// Attaching the diagnostics is what makes the editor draw the action against
	// them (and what "Fix All"-style UI reads); deliberately NOT isPreferred - a
	// real quick fix from the language server should always win the default.
	action.diagnostics = [...diagnostics];
	const args: QuickFixChatArgs = {
		uri: document.uri,
		range: claimedRange(document, diagnostics),
		diagnostics,
		mode,
	};
	action.command = {
		command: INTERNAL_CMD.quickFixChat,
		title: actionTitle(mode),
		arguments: [args],
	};
	return action;
}

/**
 * The provider itself. Actions appear only where the editor already has
 * something to say - an empty `context.diagnostics` means the user asked for
 * actions on clean code, and offering to fix nothing there would put a
 * LiteLLM entry in every lightbulb in the workspace.
 */
export function createQuickFixActionsProvider(): vscode.CodeActionProvider {
	return {
		provideCodeActions: (document, _range, context) => {
			const claimed = selectDiagnostics(context.diagnostics);
			if (claimed.length === 0) {
				return [];
			}
			return [buildAction("fix", document, claimed), buildAction("explain", document, claimed)];
		},
	};
}

/** The kinds the provider advertises; the host uses it to skip us when another kind was requested. */
export const QUICK_FIX_METADATA: vscode.CodeActionProviderMetadata = {
	providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
};
