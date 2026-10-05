/**
 * Imported by modelFacingExitsFixture.ts and never a scan root: a tool body reached only through an import gets no
 * construct judgment, so its construct is refused as the return itself. One tag per judgment, as in the importer.
 */
import * as vscode from "vscode";

export class ImportedTool implements vscode.LanguageModelTool<unknown> {
	invoke(): vscode.LanguageModelToolResult {
		return new vscode.LanguageModelToolResult([]); // refused@10 return return in invoke
	}
}
