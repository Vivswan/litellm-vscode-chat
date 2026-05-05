import * as assert from "assert";
import * as vscode from "vscode";
import { validateRequest } from "../../shared/validation";

suite("shared/validation", () => {
	test("validateRequest enforces tool result pairing", () => {
		const callId = "xyz";
		const toolCall = new vscode.LanguageModelToolCallPart(callId, "toolA", { q: 1 });
		const toolRes = new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")]);
		const valid: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.User, content: [toolRes], name: undefined },
		];
		assert.doesNotThrow(() => validateRequest(valid));

		const invalid: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("missing")],
				name: undefined,
			},
		];
		assert.throws(() => validateRequest(invalid));
	});
});
