import * as assert from "node:assert";
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

	test("validateRequest rejects an empty message list with the mirrored nothing-to-send message", () => {
		assert.throws(
			() => validateRequest([]),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /contained no messages/);
				// English host: the mirror coincides with the display; a bare
				// localized message from shared/validation.ts would land translated
				// text in the output channel.
				assert.strictEqual((e as Error & { englishMessage?: string }).englishMessage, e.message);
				return true;
			}
		);
	});

	test("tool results may be consumed across consecutive user messages", () => {
		const callA = new vscode.LanguageModelToolCallPart("call-a", "toolA", {});
		const callB = new vscode.LanguageModelToolCallPart("call-b", "toolB", {});
		const resultA = new vscode.LanguageModelToolResultPart("call-a", [new vscode.LanguageModelTextPart("a")]);
		const resultB = new vscode.LanguageModelToolResultPart("call-b", [new vscode.LanguageModelTextPart("b")]);
		const messages: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [callA, callB], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.User, content: [resultA], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.User, content: [resultB], name: undefined },
		];
		assert.doesNotThrow(() => validateRequest(messages));
	});

	test("an empty user content array does not satisfy pending tool calls", () => {
		const toolCall = new vscode.LanguageModelToolCallPart("call-1", "toolA", {});
		const messages: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.User, content: [], name: undefined },
		];
		assert.throws(
			() => validateRequest(messages),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /Unpaired tool call IDs: call-1\./);
				assert.strictEqual((e as Error & { englishMessage?: string }).englishMessage, e.message);
				// The call IDs are earlier model output (response-derived), so the
				// public log surfaces get a count-only classification instead.
				assert.strictEqual(
					(e as Error & { logClassification?: string }).logClassification,
					"ValidationError(unpaired tool calls: 1)"
				);
				return true;
			}
		);
	});

	test("a non-result part interleaved with pending tool results is rejected naming the offending part", () => {
		const toolCall = new vscode.LanguageModelToolCallPart("call-1", "toolA", {});
		const result = new vscode.LanguageModelToolResultPart("call-1", [new vscode.LanguageModelTextPart("ok")]);
		const messages: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [result, new vscode.LanguageModelTextPart("extra")],
				name: undefined,
			},
		];
		assert.throws(
			() => validateRequest(messages),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				// The detail embeds the part's constructor name, which is minified
				// in the packaged VS Code API, so only the shape is pinned.
				assert.match(e.message, /Expected a tool result after a tool call, got \S+\./);
				// The constructor name is caller-controlled text, so the
				// classification stays a fixed string without it.
				assert.strictEqual(
					(e as Error & { logClassification?: string }).logClassification,
					"ValidationError(non-tool-result part after tool call)"
				);
				return true;
			}
		);
	});
});
