import * as assert from "node:assert";
import * as vscode from "vscode";
import {
	CHARS_PER_TOKEN,
	estimateMessagesTokens,
	estimatePartTokens,
	estimateToolTokens,
	IMAGE_TOKEN_ESTIMATE,
	PDF_TOKEN_ESTIMATE,
} from "../../shared/tokenEstimation";

const withMultimodal = { includeMultimodal: true };
const textOnly = { includeMultimodal: false };

suite("shared/tokenEstimation", () => {
	test("text parts count characters divided by CHARS_PER_TOKEN in both modes", () => {
		const part = new vscode.LanguageModelTextPart("hello world");
		const expected = Math.ceil("hello world".length / CHARS_PER_TOKEN);
		assert.strictEqual(estimatePartTokens(part, withMultimodal), expected);
		assert.strictEqual(estimatePartTokens(part, textOnly), expected);
	});

	test("image parts use the fixed estimate only with multimodal enabled", () => {
		const part = new vscode.LanguageModelDataPart(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png");
		assert.strictEqual(estimatePartTokens(part, withMultimodal), IMAGE_TOKEN_ESTIMATE);
		assert.strictEqual(estimatePartTokens(part, textOnly), 0);
	});

	test("pdf parts use the fixed estimate only with multimodal enabled", () => {
		const part = new vscode.LanguageModelDataPart(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf");
		assert.strictEqual(estimatePartTokens(part, withMultimodal), PDF_TOKEN_ESTIMATE);
		assert.strictEqual(estimatePartTokens(part, textOnly), 0);
	});

	test("JSON data parts count byte length divided by CHARS_PER_TOKEN in both modes", () => {
		const payload = new TextEncoder().encode(JSON.stringify({ answer: 42 }));
		const part = new vscode.LanguageModelDataPart(payload, "application/json");
		const expected = Math.ceil(payload.length / CHARS_PER_TOKEN);
		assert.strictEqual(estimatePartTokens(part, withMultimodal), expected);
		assert.strictEqual(estimatePartTokens(part, textOnly), expected);
	});

	test("tool call parts count name plus serialized input", () => {
		const part = new vscode.LanguageModelToolCallPart("call-1", "toolA", { foo: 1 });
		const expected = Math.ceil(("toolA".length + JSON.stringify({ foo: 1 }).length) / CHARS_PER_TOKEN);
		assert.strictEqual(estimatePartTokens(part, textOnly), expected);
	});

	test("unknown parts count as zero", () => {
		assert.strictEqual(estimatePartTokens({ some: "object" }, withMultimodal), 0);
	});

	test("thinking parts count their text plus replayed signature and redacted data", () => {
		const signed = { value: "x".repeat(8), metadata: { type: "thinking", signature: "s".repeat(4) } };
		assert.strictEqual(estimatePartTokens(signed, withMultimodal), Math.ceil(12 / CHARS_PER_TOKEN));

		const redacted = { value: "", metadata: { type: "redacted_thinking", data: "d".repeat(9) } };
		assert.strictEqual(estimatePartTokens(redacted, withMultimodal), Math.ceil(9 / CHARS_PER_TOKEN));

		const plain = { value: "just thinking text" };
		assert.strictEqual(
			estimatePartTokens(plain, withMultimodal),
			Math.ceil("just thinking text".length / CHARS_PER_TOKEN)
		);
	});

	test("estimateMessagesTokens sums parts across messages", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [
					new vscode.LanguageModelTextPart("describe"),
					new vscode.LanguageModelDataPart(new Uint8Array(4), "image/png"),
				],
				name: undefined,
			},
		];
		const textTokens = Math.ceil("describe".length / CHARS_PER_TOKEN);
		assert.strictEqual(estimateMessagesTokens(messages, withMultimodal), textTokens + IMAGE_TOKEN_ESTIMATE);
		assert.strictEqual(estimateMessagesTokens(messages, textOnly), textTokens);
	});

	test("estimateToolTokens counts serialized definitions and handles absence", () => {
		assert.strictEqual(estimateToolTokens(undefined), 0);
		assert.strictEqual(estimateToolTokens([]), 0);
		const tools = [{ type: "function" as const, function: { name: "toolA", description: "does a thing" } }];
		assert.strictEqual(estimateToolTokens(tools), Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN));
	});
});
