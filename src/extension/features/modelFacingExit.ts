import * as vscode from "vscode";

/**
 * The two values a language model tool hands the host, built here and nowhere else, so every tool's text leaves the
 * extension through one construction site. At the features/ root because features may not import each other.
 */

export function toolResult(text: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

export function preparedInvocation(
	invocationMessage: string,
	card?: { readonly title: string; readonly message: string }
): vscode.PreparedToolInvocation {
	return card === undefined
		? { invocationMessage }
		: {
				invocationMessage,
				confirmationMessages: { title: card.title, message: new vscode.MarkdownString(card.message) },
			};
}
