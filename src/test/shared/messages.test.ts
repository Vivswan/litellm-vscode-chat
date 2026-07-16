import * as assert from "assert";
import * as vscode from "vscode";
import { convertMessages } from "../../shared/messages";
import type { OpenAIChatMessage, OpenAIChatTextContentBlock } from "../../types";

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}
interface ConvertedMessage {
	role: "user" | "assistant" | "tool";
	content?: string;
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

function cacheControlCount(messages: OpenAIChatMessage[]): number {
	return messages.reduce((count, message) => {
		if (!Array.isArray(message.content)) {
			return count;
		}
		return (
			count +
			message.content.filter(
				(block) => block.type === "text" && (block as OpenAIChatTextContentBlock).cache_control !== undefined
			).length
		);
	}, 0);
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
		assert.ok(out[0].content?.includes("before"));
		assert.ok(out[0].content?.includes("after"));
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

	test("accepts sticker-style image mime aliases", () => {
		const imageData = new Uint8Array([0xff, 0xd8, 0xff]);
		const dataPart = new vscode.LanguageModelDataPart(imageData, "image/jpg");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [dataPart],
				name: undefined,
			},
		];
		const out = convertMessages(messages);
		const content = out[0].content as Array<{ type: string }>;
		assert.ok(Array.isArray(content));
		assert.equal(content.length, 1);
		assert.equal(content[0].type, "image_url");
		const imageBlock = content[0] as { type: string; image_url: { url: string } };
		assert.ok(imageBlock.image_url.url.startsWith("data:image/jpg;base64,"));
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

	test("caches only the first user message when requested", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: 0 as vscode.LanguageModelChatMessageRole,
				content: [new vscode.LanguageModelTextPart("system prompt")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("preamble")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("first task")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("follow-up")],
				name: undefined,
			},
		];

		const out = convertMessages(messages, { cacheFirstUserMessage: true });

		assert.equal(cacheControlCount(out), 1);
		assert.deepEqual(out[2].content, [{ type: "text", text: "first task", cache_control: { type: "ephemeral" } }]);
		assert.equal(out[0].content, "system prompt");
		assert.equal(out[1].content, "preamble");
		assert.equal(out[3].content, "follow-up");
	});

	test("caches the last text-bearing message and skips a trailing tool-call-only message", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("task")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("working")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelToolCallPart("call1", "search", { q: "test" })],
				name: undefined,
			},
		];

		const out = convertMessages(messages, { cacheConversation: true });

		assert.equal(cacheControlCount(out), 1);
		assert.deepEqual(out[1].content, [{ type: "text", text: "working", cache_control: { type: "ephemeral" } }]);
		assert.equal(out[2].content, undefined);
	});

	test("first-user and rolling cache markers are idempotent", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("single task")],
				name: undefined,
			},
		];
		const options = { cacheFirstUserMessage: true, cacheConversation: true };

		const first = convertMessages(messages, options);
		const second = convertMessages(messages, options);

		assert.equal(cacheControlCount(first), 1);
		assert.deepEqual(first, second);
	});

	test("combined message caching never uses more than three breakpoints", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: 0 as vscode.LanguageModelChatMessageRole,
				content: [new vscode.LanguageModelTextPart("system one")],
				name: undefined,
			},
			{
				role: 0 as vscode.LanguageModelChatMessageRole,
				content: [new vscode.LanguageModelTextPart("system two")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("task")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("response")],
				name: undefined,
			},
		];

		const out = convertMessages(messages, {
			cacheSystemPrompt: true,
			cacheFirstUserMessage: true,
			cacheConversation: true,
		});

		assert.equal(cacheControlCount(out), 3);
	});
});
