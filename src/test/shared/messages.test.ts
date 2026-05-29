import * as assert from "assert";
import * as vscode from "vscode";
import { convertMessages } from "../../shared/messages";

function countCacheControlMarkers(messages: unknown[]): number {
	let count = 0;
	for (const msg of messages) {
		const content = (msg as { content?: unknown }).content;
		if (Array.isArray(content)) {
			for (const block of content as Array<{ type?: unknown; cache_control?: unknown }>) {
				if (block?.type === "text" && (block as { cache_control?: unknown }).cache_control) {
					count++;
				}
			}
		}
	}
	return count;
}

function hasCacheControlOnAnyTextBlock(message: unknown): boolean {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return false;
	}
	return (content as Array<{ type?: unknown; cache_control?: unknown }>).some(
		(block) => block?.type === "text" && (block as { cache_control?: unknown }).cache_control
	);
}

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}
interface ConvertedMessage {
	role: "user" | "assistant" | "tool" | "system";
	content?: unknown;
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
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
		const content = out[0].content as string | undefined;
		assert.ok(content?.includes("before"));
		assert.ok(content?.includes("after"));
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

	test("cacheFirstUserMessage tags the first user message only", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: 999 as unknown as vscode.LanguageModelChatMessageRole,
				content: [new vscode.LanguageModelTextPart("sys")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("u1")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("a1")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("u2")],
				name: undefined,
			},
		];

		const out = convertMessages(messages, { cacheFirstUserMessage: true }) as ConvertedMessage[];
		assert.equal(countCacheControlMarkers(out), 1);

		const firstUser = out.find((m) => m.role === "user");
		assert.ok(firstUser, "expected a user message");
		assert.ok(hasCacheControlOnAnyTextBlock(firstUser), "expected first user message to carry cache_control");

		const otherTagged = out.filter((m) => m !== firstUser && hasCacheControlOnAnyTextBlock(m));
		assert.deepEqual(otherTagged, []);
	});

	test("cacheConversation tags the last text-bearing message (skipping tool-call-only assistant)", () => {
		const trailingToolCall = new vscode.LanguageModelToolCallPart("call-last", "search", { q: "x" });
		const toolResult = new vscode.LanguageModelToolResultPart("call-last", [
			new vscode.LanguageModelTextPart("result"),
		]);

		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("u1")],
				name: undefined,
			},
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [trailingToolCall], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolResult], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [trailingToolCall], name: undefined },
		];

		const out = convertMessages(messages, { cacheConversation: true }) as ConvertedMessage[];
		assert.equal(countCacheControlMarkers(out), 1);

		const lastTaggedIndex = out.findLastIndex((m) => hasCacheControlOnAnyTextBlock(m));
		assert.ok(lastTaggedIndex >= 0);
		assert.equal(out[lastTaggedIndex].role, "tool");
	});

	test("cacheFirstUserMessage + cacheConversation stays idempotent and uses <= 2 message markers", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("u1")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("a1")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("u2")],
				name: undefined,
			},
		];

		const out1 = convertMessages(messages, {
			cacheFirstUserMessage: true,
			cacheConversation: true,
		}) as ConvertedMessage[];
		const out2 = convertMessages(messages, {
			cacheFirstUserMessage: true,
			cacheConversation: true,
		}) as ConvertedMessage[];
		assert.deepEqual(out1, out2, "convertMessages should be idempotent for the same inputs/options");
		assert.ok(countCacheControlMarkers(out1) <= 2, "expected at most 2 message cache_control markers");
	});

	test("cacheFirstUserMessage + cacheConversation collapses to one marker for a single-message conversation", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("u1")],
				name: undefined,
			},
		];

		const out = convertMessages(messages, {
			cacheFirstUserMessage: true,
			cacheConversation: true,
		}) as ConvertedMessage[];
		assert.equal(countCacheControlMarkers(out), 1);
	});
});
