/**
 * Negative control for a constructs-only exit site, the response stream's shape: the test names LanguageModelTextPart
 * as this file's one construct and reads the tags as in modelFacingExitsFixture.ts. Never imported.
 */
import * as vscode from "vscode";

declare const raw: string;

export function relay(): vscode.PreparedToolInvocation {
	new vscode.LanguageModelTextPart(raw); // allowed@2 construct new LanguageModelTextPart
	new vscode.LanguageModelToolResult([]); // refused@2 construct new LanguageModelToolResult
	vscode.LanguageModelDataPart.text(raw); // refused@2 construct LanguageModelDataPart.text
	return { invocationMessage: raw }; // refused@9 construct { invocationMessage }
}
