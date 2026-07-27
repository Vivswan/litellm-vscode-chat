import * as assert from "node:assert";
import * as vscode from "vscode";
import { convertMessages, isToolResultPart } from "../../shared/messages";
import { expectDefined } from "../testUtils";

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

suite("shared/messages", () => {
	test("role 3 maps to system without logging an unknown role", () => {
		const logged: string[] = [];
		const messages = [
			{
				role: 3 as vscode.LanguageModelChatMessageRole,
				content: [new vscode.LanguageModelTextPart("you are helpful")],
				name: undefined,
			},
		];
		const out = convertMessages(messages, { log: (m) => logged.push(m) }) as unknown as { role: string }[];
		assert.equal(expectDefined(out[0]).role, "system");
		assert.deepEqual(logged, []);
	});

	test("unknown role maps to system and is logged", () => {
		const logged: { message: string; data?: unknown }[] = [];
		const messages = [
			{
				role: 99 as vscode.LanguageModelChatMessageRole,
				content: [new vscode.LanguageModelTextPart("mystery")],
				name: undefined,
			},
		];
		const out = convertMessages(messages, { log: (message, data) => logged.push({ message, data }) }) as unknown as {
			role: string;
		}[];
		assert.equal(expectDefined(out[0]).role, "system");
		assert.equal(logged.length, 1);
		const entry = expectDefined(logged[0]);
		assert.ok(entry.message.includes("Unknown message role"));
		assert.deepEqual(entry.data, { role: 99 });
	});

	test("isToolResultPart rejects tool-call parts regardless of caller branch order", () => {
		const toolCall = new vscode.LanguageModelToolCallPart("call1", "search", { q: "hi" });
		assert.equal(isToolResultPart(toolCall), false);
		const toolResult = new vscode.LanguageModelToolResultPart("call1", [new vscode.LanguageModelTextPart("ok")]);
		assert.equal(isToolResultPart(toolResult), true);
	});

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
		assert.equal(out.length, 2);

		const assistantMsg = expectDefined(out[0]);
		assert.equal(assistantMsg.role, "assistant");
		assert.ok(Array.isArray(assistantMsg.tool_calls) && assistantMsg.tool_calls.length === 1);
		const call = expectDefined(assistantMsg.tool_calls[0]);
		assert.equal(call.id, "abc");
		assert.equal(call.function.name, "toolA");
		assert.deepEqual(JSON.parse(call.function.arguments), { foo: 1 });

		const toolMsg = expectDefined(out[1]);
		assert.equal(toolMsg.role, "tool", "Tool results must ride in a tool-role message");
		assert.equal(toolMsg.tool_call_id, "abc", "The result must be paired to the originating call ID");
		assert.equal(toolMsg.content, "result");
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
		const first = expectDefined(out[0]);
		assert.equal(first.role, "assistant");
		assert.ok(first.content?.includes("before"));
		assert.ok(first.content?.includes("after"));
		assert.ok(Array.isArray(first.tool_calls) && first.tool_calls.length === 1);
		assert.equal(expectDefined(first.tool_calls[0]).function.name, "search");
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
		const first = expectDefined(out[0]);
		assert.equal(first.role, "user");
		assert.ok(Array.isArray(first.content), "content should be an array when images present");
		const content = first.content as Array<{ type: string }>;
		assert.equal(content.length, 2);
		assert.equal(expectDefined(content[0]).type, "text");
		assert.equal(expectDefined(content[1]).type, "image_url");
		const imageBlock = expectDefined(content[1]) as { type: string; image_url: { url: string } };
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
		const first = expectDefined(out[0]);
		assert.equal(first.content, "hello");
		assert.equal(typeof first.content, "string");
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
		const content = expectDefined(out[0]).content as Array<{ type: string }>;
		assert.ok(Array.isArray(content));
		assert.equal(content.length, 1);
		assert.equal(expectDefined(content[0]).type, "image_url");
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
		const content = expectDefined(out[0]).content as Array<{ type: string }>;
		assert.ok(Array.isArray(content));
		assert.equal(content.length, 1);
		assert.equal(expectDefined(content[0]).type, "image_url");
		const imageBlock = expectDefined(content[0]) as { type: string; image_url: { url: string } };
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
		const content = expectDefined(out[0]).content as Array<{ type: string }>;
		assert.ok(Array.isArray(content));
		assert.equal(content.length, 3);
		assert.equal(expectDefined(content[0]).type, "text");
		assert.equal(expectDefined(content[1]).type, "image_url");
		assert.equal(expectDefined(content[2]).type, "image_url");
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
		const content = expectDefined(out[0]).content as Array<{ type: string }>;
		assert.ok(Array.isArray(content));
		assert.equal(content.length, 3);
		assert.equal(expectDefined(content[0]).type, "text");
		assert.equal((expectDefined(content[0]) as unknown as { text: string }).text, "before");
		assert.equal(expectDefined(content[1]).type, "image_url");
		assert.equal(expectDefined(content[2]).type, "text");
		assert.equal((expectDefined(content[2]) as unknown as { text: string }).text, "after");
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
		const first = expectDefined(out[0]);
		assert.equal(typeof first.content, "string");
		assert.ok((first.content as string).includes('{"key":"value"}'));
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
		const content = expectDefined(out[0]).content as Array<{ type: string }>;
		assert.ok(Array.isArray(content));
		assert.equal(content.length, 2);
		assert.equal(expectDefined(content[0]).type, "text");
		assert.equal(expectDefined(content[1]).type, "file");
		const fileBlock = expectDefined(content[1]) as { type: string; file: { file_data: string } };
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
		const first = expectDefined(out[0]);
		assert.equal(typeof first.content, "string");
		assert.equal(first.content, "test");
	});

	test("system content stays a plain string; cache markers belong to the prompt-cache pass", () => {
		const systemMsg: vscode.LanguageModelChatRequestMessage = {
			role: 3 as vscode.LanguageModelChatMessageRole,
			content: [new vscode.LanguageModelTextPart("you are helpful")],
			name: undefined,
		};
		const out = convertMessages([systemMsg]);
		assert.equal(out.length, 1);
		const first = expectDefined(out[0]);
		assert.equal(first.role, "system");
		assert.strictEqual(first.content, "you are helpful");
	});

	suite("thinking block replay", () => {
		/** Shape of a host thinking part carried in assistant history. */
		function thinkingPart(value: string, metadata: unknown): unknown {
			return { value, id: "think_1", metadata };
		}

		/** The real proposed-API class, when this test host exposes it. */
		function hostThinkingPartClass(): (new (text: string, id?: string, metadata?: unknown) => object) | undefined {
			const ctor: unknown = Reflect.get(vscode, "LanguageModelThinkingPart");
			return typeof ctor === "function"
				? (ctor as new (
						text: string,
						id?: string,
						metadata?: unknown
					) => object)
				: undefined;
		}

		function assistantMessage(parts: unknown[]): vscode.LanguageModelChatMessage {
			return {
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: parts,
				name: undefined,
			} as vscode.LanguageModelChatMessage;
		}

		test("a signed thinking part replays as a thinking_blocks entry on the assistant text message", () => {
			const out = convertMessages([
				assistantMessage([
					thinkingPart("consider the problem", { type: "thinking", signature: "sig-1" }),
					new vscode.LanguageModelTextPart("Decided."),
				]),
			]) as Array<{ role: string; content?: unknown; thinking_blocks?: unknown }>;
			assert.equal(out.length, 1);
			const message = expectDefined(out[0]);
			assert.strictEqual(message.content, "Decided.");
			assert.deepStrictEqual(message.thinking_blocks, [
				{ type: "thinking", thinking: "consider the problem", signature: "sig-1" },
			]);
		});

		test("signed thinking replays alongside tool calls on the same assistant message", () => {
			const out = convertMessages([
				assistantMessage([
					thinkingPart("weigh options", { type: "thinking", signature: "sig-2" }),
					new vscode.LanguageModelToolCallPart("call_1", "get_weather", { location: "Paris" }),
				]),
			]) as Array<{ role: string; tool_calls?: unknown[]; thinking_blocks?: unknown[] }>;
			assert.equal(out.length, 1);
			const message = expectDefined(out[0]);
			assert.equal(message.tool_calls?.length, 1);
			assert.equal(message.thinking_blocks?.length, 1);
		});

		test("a redacted thinking part replays its opaque data without text", () => {
			const out = convertMessages([
				assistantMessage([
					thinkingPart("", { type: "redacted_thinking", data: "opaque" }),
					new vscode.LanguageModelTextPart("Answer."),
				]),
			]) as Array<{ thinking_blocks?: unknown }>;
			assert.deepStrictEqual(expectDefined(out[0]).thinking_blocks, [{ type: "redacted_thinking", data: "opaque" }]);
		});

		test("thinking without a signature or redacted data does not replay", () => {
			const out = convertMessages([
				assistantMessage([
					thinkingPart("plain reasoning text", undefined),
					thinkingPart("metadata without replay value", { other: true }),
					new vscode.LanguageModelTextPart("Answer."),
				]),
			]) as Array<{ content?: unknown; thinking_blocks?: unknown }>;
			const message = expectDefined(out[0]);
			assert.strictEqual(message.content, "Answer.");
			assert.strictEqual(message.thinking_blocks, undefined);
		});

		test("thinking parts on user messages are ignored", () => {
			const out = convertMessages([
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [thinkingPart("spoofed", { signature: "sig-x" }), new vscode.LanguageModelTextPart("hi")],
					name: undefined,
				} as vscode.LanguageModelChatMessage,
			]) as Array<{ role: string; thinking_blocks?: unknown }>;
			assert.strictEqual(expectDefined(out[0]).thinking_blocks, undefined);
		});

		test("a signature streamed in a separate empty part signs the accumulated text", function () {
			const cls = hostThinkingPartClass();
			if (!cls) {
				this.skip();
				return;
			}
			// Anthropic streams thinking text first and the signature at block
			// end; the replay must reunite them into one signed block.
			const out = convertMessages([
				assistantMessage([
					new cls("part one"),
					new cls(" part two"),
					new cls("", "think_1", { type: "thinking", signature: "sig-split" }),
					new vscode.LanguageModelTextPart("Answer."),
				]),
			]) as Array<{ thinking_blocks?: unknown }>;
			assert.deepStrictEqual(expectDefined(out[0]).thinking_blocks, [
				{ type: "thinking", thinking: "part one part two", signature: "sig-split" },
			]);
		});

		test("a thinking-only assistant turn still replays its signed block", () => {
			const out = convertMessages([
				assistantMessage([thinkingPart("silent deliberation", { type: "thinking", signature: "sig-only" })]),
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("go on")],
					name: undefined,
				} as vscode.LanguageModelChatMessage,
			]) as Array<{ role: string; content?: unknown; thinking_blocks?: unknown }>;
			assert.equal(out.length, 2);
			const message = expectDefined(out[0]);
			assert.strictEqual(message.role, "assistant");
			assert.strictEqual(message.content, "");
			assert.deepStrictEqual(message.thinking_blocks, [
				{ type: "thinking", thinking: "silent deliberation", signature: "sig-only" },
			]);
		});

		test("a malformed redacted block with a signature but no data replays as a signed thinking block", () => {
			const out = convertMessages([
				assistantMessage([
					thinkingPart("text", { type: "redacted_thinking", signature: "sig-m" }),
					new vscode.LanguageModelTextPart("Answer."),
				]),
			]) as Array<{ thinking_blocks?: unknown }>;
			assert.deepStrictEqual(expectDefined(out[0]).thinking_blocks, [
				{ type: "thinking", thinking: "text", signature: "sig-m" },
			]);
		});
	});
});
