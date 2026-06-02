import * as assert from "assert";
import * as vscode from "vscode";
import { convertMessages } from "../../shared/messages";

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}
interface ConvertedMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | Array<{ type: string; text?: string; cache_control?: { type: "ephemeral" } }>;
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

function countCacheControls(messages: ConvertedMessage[]): number {
	return messages.reduce((count, message) => {
		if (!Array.isArray(message.content)) {
			return count;
		}
		return count + message.content.filter((block) => block.cache_control?.type === "ephemeral").length;
	}, 0);
}

function textBlocks(
	message: ConvertedMessage
): Array<{ type: string; text?: string; cache_control?: { type: "ephemeral" } }> {
	return Array.isArray(message.content) ? message.content : [];
}

suite("shared/messages", () => {
	test("maps user/assistant text", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("hi")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("hello")],
				name: undefined,
			},
		];
		const out = convertMessages(messages) as ConvertedMessage[];
		assert.deepEqual(out, [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		]);
	});

	test("maps tool calls and results", () => {
		const toolCall = new vscode.LanguageModelToolCallPart("abc", "toolA", { foo: 1 });
		const toolResult = new vscode.LanguageModelToolResultPart("abc", [new vscode.LanguageModelTextPart("result")]);
		const messages: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolResult], name: undefined },
		];
		const out = convertMessages(messages) as ConvertedMessage[];
		const hasToolCalls = out.some((m: ConvertedMessage) => Array.isArray(m.tool_calls));
		const hasToolMsg = out.some((m: ConvertedMessage) => m.role === "tool");
		assert.ok(hasToolCalls && hasToolMsg);
	});

	test("handles mixed text + tool calls in one assistant message", () => {
		const toolCall = new vscode.LanguageModelToolCallPart("call1", "search", { q: "hello" });
		const msg: vscode.LanguageModelChatMessage = {
			role: vscode.LanguageModelChatMessageRole.Assistant,
			content: [new vscode.LanguageModelTextPart("before "), toolCall, new vscode.LanguageModelTextPart(" after")],
			name: undefined,
		};
		const out = convertMessages([msg]) as ConvertedMessage[];
		assert.equal(out.length, 1);
		assert.equal(out[0].role, "assistant");
		assert.ok((out[0].content as string).includes("before"));
		assert.ok((out[0].content as string).includes("after"));
		assert.ok(Array.isArray(out[0].tool_calls) && out[0].tool_calls.length === 1);
		assert.equal(out[0].tool_calls?.[0].function.name, "search");
	});

	test("converts user message with image to array content", () => {
		const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		const dataPart = new vscode.LanguageModelDataPart(imageData, "image/png");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("What is in this image?"), dataPart],
				name: undefined,
			},
		];
		const out = convertMessages(messages);
		assert.equal(out.length, 1);
		assert.equal(out[0].role, "user");
		assert.ok(Array.isArray(out[0].content), "content should be an array when images present");
		const content = out[0].content as Array<{ type: string }>;
		assert.equal(content.length, 2);
		assert.equal(content[0].type, "text");
		assert.equal(content[1].type, "image_url");
		const imageBlock = content[1] as { type: string; image_url: { url: string } };
		assert.ok(imageBlock.image_url.url.startsWith("data:image/png;base64,"));
	});

	test("user message without images produces string content", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("hello")],
				name: undefined,
			},
		];
		const out = convertMessages(messages);
		assert.equal(out[0].content, "hello");
		assert.equal(typeof out[0].content, "string");
	});

	test("image-only user message produces array content", () => {
		const imageData = new Uint8Array([0xff, 0xd8, 0xff]);
		const dataPart = new vscode.LanguageModelDataPart(imageData, "image/jpeg");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [dataPart],
				name: undefined,
			},
		];
		const out = convertMessages(messages);
		assert.equal(out.length, 1);
		const content = out[0].content as Array<{ type: string }>;
		assert.ok(Array.isArray(content));
		assert.equal(content.length, 1);
		assert.equal(content[0].type, "image_url");
	});

	test("handles multiple images in a single user message", () => {
		const img1 = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
		const img2 = new vscode.LanguageModelDataPart(new Uint8Array([4, 5, 6]), "image/jpeg");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("Compare these:"), img1, img2],
				name: undefined,
			},
		];
		const out = convertMessages(messages);
		const content = out[0].content as Array<{ type: string }>;
		assert.ok(Array.isArray(content));
		assert.equal(content.length, 3);
		assert.equal(content[0].type, "text");
		assert.equal(content[1].type, "image_url");
		assert.equal(content[2].type, "image_url");
	});

	test("preserves ordering of text and image parts", () => {
		const img = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("before"), img, new vscode.LanguageModelTextPart("after")],
				name: undefined,
			},
		];
		const out = convertMessages(messages);
		const content = out[0].content as Array<{ type: string }>;
		assert.ok(Array.isArray(content));
		assert.equal(content.length, 3);
		assert.equal(content[0].type, "text");
		assert.equal((content[0] as unknown as { text: string }).text, "before");
		assert.equal(content[1].type, "image_url");
		assert.equal(content[2].type, "text");
		assert.equal((content[2] as unknown as { text: string }).text, "after");
	});

	test("decodes text/json LanguageModelDataPart as text", () => {
		const jsonData = new TextEncoder().encode('{"key":"value"}');
		const jsonPart = new vscode.LanguageModelDataPart(jsonData, "application/json");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("here is data: "), jsonPart],
				name: undefined,
			},
		];
		const out = convertMessages(messages);
		assert.equal(typeof out[0].content, "string");
		assert.ok((out[0].content as string).includes('{"key":"value"}'));
	});

	test("converts PDF LanguageModelDataPart to file content block", () => {
		const pdfData = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
		const pdfPart = new vscode.LanguageModelDataPart(pdfData, "application/pdf");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("Analyze this:"), pdfPart],
				name: undefined,
			},
		];
		const out = convertMessages(messages);
		const content = out[0].content as Array<{ type: string }>;
		assert.ok(Array.isArray(content));
		assert.equal(content.length, 2);
		assert.equal(content[0].type, "text");
		assert.equal(content[1].type, "file");
		const fileBlock = content[1] as { type: string; file: { file_data: string } };
		assert.ok(fileBlock.file.file_data.startsWith("data:application/pdf;base64,"));
	});

	test("skips unsupported binary LanguageModelDataPart without crash", () => {
		const binPart = new vscode.LanguageModelDataPart(new Uint8Array([0x00, 0x01]), "application/octet-stream");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("test"), binPart],
				name: undefined,
			},
		];
		const out = convertMessages(messages);
		assert.equal(typeof out[0].content, "string");
		assert.equal(out[0].content, "test");
	});

	test("cacheFirstUserMessage tags only the first user message", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("preface")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("first")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("second")],
				name: undefined,
			},
		];

		const out = convertMessages(messages, { cacheFirstUserMessage: true }) as ConvertedMessage[];

		assert.equal(countCacheControls(out), 1);
		assert.equal(textBlocks(out[1])[0].cache_control?.type, "ephemeral");
		assert.equal(textBlocks(out[0])[0]?.cache_control, undefined);
		assert.equal(out[2].content, "second");
	});

	test("cacheConversation tags the last text-bearing message and skips tool-call-only turns", () => {
		const toolCall = new vscode.LanguageModelToolCallPart("call1", "search", { q: "hello" });
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("first")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("last text")],
				name: undefined,
			},
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
		];

		const out = convertMessages(messages, { cacheConversation: true }) as ConvertedMessage[];

		assert.equal(countCacheControls(out), 1);
		assert.equal(out[0].content, "first");
		assert.equal(textBlocks(out[1])[0].cache_control?.type, "ephemeral");
		assert.equal(out[2].content, undefined);
	});

	test("first-user and rolling cache markers remain within message breakpoint budget", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("first")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("middle")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("last")],
				name: undefined,
			},
		];

		const out = convertMessages(messages, {
			cacheFirstUserMessage: true,
			cacheConversation: true,
		}) as ConvertedMessage[];

		assert.equal(countCacheControls(out), 2);
		assert.equal(textBlocks(out[0])[0].cache_control?.type, "ephemeral");
		assert.equal(textBlocks(out[2])[0].cache_control?.type, "ephemeral");
	});

	test("first-user and rolling cache markers collapse on a single user message", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("only")],
				name: undefined,
			},
		];

		const out = convertMessages(messages, {
			cacheFirstUserMessage: true,
			cacheConversation: true,
		}) as ConvertedMessage[];

		assert.equal(countCacheControls(out), 1);
		assert.equal(textBlocks(out[0])[0].cache_control?.type, "ephemeral");
	});

	test("cache conversion is stable for repeated calls with the same input", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("first")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("last")],
				name: undefined,
			},
		];
		const options = { cacheFirstUserMessage: true, cacheConversation: true };

		assert.deepEqual(convertMessages(messages, options), convertMessages(messages, options));
	});
});
