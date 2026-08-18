import * as assert from "node:assert";
import * as vscode from "vscode";
import { convertMessages } from "../../../shared/conversion/messages";
import { isToolResultPart } from "../../../shared/conversion/toolCallIds";
import { expectDefined } from "../../pureHelpers";

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

suite("shared/conversion/messages", () => {
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
		const out = convertMessages(messages, { imageInput: true });
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
		const out = convertMessages(messages, { imageInput: true });
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
		const out = convertMessages(messages, { imageInput: true });
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
		const out = convertMessages(messages, { imageInput: true });
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
		const out = convertMessages(messages, { imageInput: true });
		const content = expectDefined(out[0]).content as Array<{ type: string }>;
		assert.ok(Array.isArray(content));
		assert.equal(content.length, 3);
		assert.equal(expectDefined(content[0]).type, "text");
		assert.equal((expectDefined(content[0]) as unknown as { text: string }).text, "before");
		assert.equal(expectDefined(content[1]).type, "image_url");
		assert.equal(expectDefined(content[2]).type, "text");
		assert.equal((expectDefined(content[2]) as unknown as { text: string }).text, "after");
	});

	test("user-message images drop with the no-wire-mapping log when the model lacks imageInput", () => {
		const logged: { message: string; data?: unknown }[] = [];
		const img = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
		const out = convertMessages(
			[
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("look:"), img],
					name: undefined,
				},
			],
			{ log: (message, data) => logged.push({ message, data }) }
		);
		const first = expectDefined(out[0]);
		assert.strictEqual(first.content, "look:", "the text survives; no image block reaches a non-vision model");
		assert.deepEqual(expectDefined(logged[0]).data, { role: "user", mimeType: "image/png" });
	});

	test("an image-bearing history replays to a non-vision model without image blocks", () => {
		// The model-switch case: the history carries images the previous
		// (vision) model accepted; the new model must not receive them.
		const img = () => new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
		const history: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("what is this?"), img()],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("A red pixel.")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("and now?"), img()],
				name: undefined,
			},
		];
		const out = convertMessages(history);
		assert.equal(out.length, 3, "every turn keeps its text");
		assert.ok(!JSON.stringify(out).includes("image_url"), "no image block may reach the wire");
		assert.strictEqual(expectDefined(out[0]).content, "what is this?");
		assert.strictEqual(expectDefined(out[2]).content, "and now?");
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

	test("an assistant turn of text then generated image keeps its text; the image is log-skipped", () => {
		const logged: { message: string; data?: unknown }[] = [];
		const img = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("Here is your image."), img],
				name: undefined,
			},
		];
		const out = convertMessages(messages, { log: (message, data) => logged.push({ message, data }) });
		assert.equal(out.length, 1, "the assistant turn must not vanish from history");
		const first = expectDefined(out[0]);
		assert.equal(first.role, "assistant");
		assert.equal(first.content, "Here is your image.");
		assert.equal(logged.length, 1);
		assert.deepEqual(expectDefined(logged[0]).data, { role: "assistant", mimeType: "image/png" });
	});

	test("an assistant turn of generated image then text keeps its text in either order", () => {
		const img = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [img, new vscode.LanguageModelTextPart("Here is your image.")],
				name: undefined,
			},
		];
		const out = convertMessages(messages);
		assert.equal(out.length, 1);
		assert.equal(expectDefined(out[0]).content, "Here is your image.");
	});

	test("an assistant turn with a generated audio clip keeps its text by design, not by accident", () => {
		const logged: { message: string; data?: unknown }[] = [];
		const clip = new vscode.LanguageModelDataPart(new Uint8Array([0x52, 0x49]), "audio/wav");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [clip, new vscode.LanguageModelTextPart("Transcribed words.")],
				name: undefined,
			},
		];
		const out = convertMessages(messages, { log: (message, data) => logged.push({ message, data }) });
		assert.equal(out.length, 1);
		assert.equal(expectDefined(out[0]).content, "Transcribed words.");
		assert.deepEqual(expectDefined(logged[0]).data, { role: "assistant", mimeType: "audio/wav" });
	});

	test("a PDF on an assistant turn is dropped like any other non-text block, keeping the text", () => {
		// PDFs convert to content blocks only for user messages; the assistant
		// wire shape has none, so the same keep-the-text rule applies.
		const pdf = new vscode.LanguageModelDataPart(new Uint8Array([0x25, 0x50]), "application/pdf");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("See the report."), pdf],
				name: undefined,
			},
		];
		const out = convertMessages(messages);
		assert.equal(out.length, 1);
		assert.equal(expectDefined(out[0]).content, "See the report.");
	});

	test("dropped DataParts log once per conversion, however media-heavy the history", () => {
		const logged: { message: string; data?: unknown }[] = [];
		const img = () => new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
		const turn = (text: string) => ({
			role: vscode.LanguageModelChatMessageRole.Assistant,
			content: [new vscode.LanguageModelTextPart(text), img(), img()],
			name: undefined,
		});
		const out = convertMessages([turn("one"), turn("two"), turn("three")], {
			log: (message, data) => logged.push({ message, data }),
		});
		assert.equal(out.length, 3, "every turn keeps its text");
		assert.equal(
			logged.filter((l) => l.message.includes("Skipping LanguageModelDataPart")).length,
			1,
			"six dropped parts must produce one log, not evict the issue buffer"
		);
	});

	test("a model-controlled mime never reaches the skip log unless it is a safe type/subtype", () => {
		const logged: { message: string; data?: unknown }[] = [];
		const evilMime = "text injection\nwith newlines and no slash";
		const part = new vscode.LanguageModelDataPart(new Uint8Array([1]), evilMime);
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("kept"), part],
				name: undefined,
			},
		];
		const out = convertMessages(messages, { log: (message, data) => logged.push({ message, data }) });
		assert.equal(expectDefined(out[0]).content, "kept");
		assert.deepEqual(expectDefined(logged[0]).data, { role: "assistant", mimeType: "unparseable" });
		assert.ok(!JSON.stringify(logged).includes("injection"), "the raw mime must not appear anywhere in the log");
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

	suite("tool-result images", () => {
		const LEAD_IN = "Images returned by the tool calls above:";

		function assistantToolCalls(...callIds: string[]): vscode.LanguageModelChatMessage {
			return {
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: callIds.map((id) => new vscode.LanguageModelToolCallPart(id, "screenshot", {})),
				name: undefined,
			};
		}

		function toolResultMessage(callId: string, resultParts: unknown[]): vscode.LanguageModelChatMessage {
			return {
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelToolResultPart(callId, resultParts as vscode.LanguageModelTextPart[])],
				name: undefined,
			};
		}

		function png(): vscode.LanguageModelDataPart {
			return new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
		}

		test("the tool message keeps flat text; the images ride one user message after it", () => {
			const out = convertMessages(
				[
					assistantToolCalls("call_img"),
					toolResultMessage("call_img", [
						new vscode.LanguageModelTextPart("before"),
						png(),
						new vscode.LanguageModelTextPart("after"),
					]),
				],
				{ imageInput: true }
			) as unknown as Array<Record<string, unknown>>;
			assert.deepEqual(
				out.map((m) => m.role),
				["assistant", "tool", "user"],
				"the synthesized image message follows the turn's tool message"
			);
			const toolMsg = expectDefined(out[1]);
			assert.strictEqual(toolMsg.tool_call_id, "call_img", "tool-call pairing must survive");
			assert.strictEqual(toolMsg.content, "beforeafter", "tool content stays the flattened text on every provider");
			const imageMsg = expectDefined(out[2]).content as Array<Record<string, unknown>>;
			assert.deepEqual(
				imageMsg.map((b) => b.type),
				["text", "image_url"]
			);
			assert.deepEqual(imageMsg[0], { type: "text", text: LEAD_IN }, "the lead-in is a fixed string");
			const imageBlock = imageMsg[1] as { image_url: { url: string } };
			assert.ok(imageBlock.image_url.url.startsWith("data:image/png;base64,"));
		});

		test("images from all tool results of a turn collect into one message after the last tool message", () => {
			// One host message carrying both results, and the split-across-host-
			// messages shape, must both keep OpenAI's pairing rule: nothing
			// between the assistant tool_calls message and its tool messages.
			const shapes: vscode.LanguageModelChatMessage[][] = [
				[
					assistantToolCalls("call_a", "call_b"),
					{
						role: vscode.LanguageModelChatMessageRole.User,
						content: [
							new vscode.LanguageModelToolResultPart("call_a", [png()]),
							new vscode.LanguageModelToolResultPart("call_b", [png()]),
						],
						name: undefined,
					},
				],
				[
					assistantToolCalls("call_a", "call_b"),
					toolResultMessage("call_a", [png()]),
					toolResultMessage("call_b", [png()]),
				],
			];
			for (const messages of shapes) {
				const out = convertMessages(messages, { imageInput: true }) as unknown as Array<Record<string, unknown>>;
				assert.deepEqual(
					out.map((m) => m.role),
					["assistant", "tool", "tool", "user"],
					"exactly one image message, after the final tool message, never interleaved"
				);
				const imageMsg = expectDefined(out[3]).content as Array<{ type: string }>;
				assert.deepEqual(
					imageMsg.map((b) => b.type),
					["text", "image_url", "image_url"]
				);
			}
		});

		test("a trailing tool turn still flushes its image message at end of history", () => {
			const out = convertMessages([assistantToolCalls("call_img"), toolResultMessage("call_img", [png()])], {
				imageInput: true,
			}) as unknown as Array<Record<string, unknown>>;
			assert.deepEqual(
				out.map((m) => m.role),
				["assistant", "tool", "user"]
			);
		});

		test("the image message flushes before the next assistant turn in replayed history", () => {
			const out = convertMessages(
				[
					assistantToolCalls("call_img"),
					toolResultMessage("call_img", [png()]),
					{
						role: vscode.LanguageModelChatMessageRole.Assistant,
						content: [new vscode.LanguageModelTextPart("I see a red pixel.")],
						name: undefined,
					},
				],
				{ imageInput: true }
			) as unknown as Array<Record<string, unknown>>;
			assert.deepEqual(
				out.map((m) => m.role),
				["assistant", "tool", "user", "assistant"],
				"the image message lands between the tool turn and the next assistant turn"
			);
		});

		test("without imageInput the image drops with the existing log and no message is synthesized", () => {
			const logged: string[] = [];
			const out = convertMessages(
				[
					assistantToolCalls("call_img"),
					toolResultMessage("call_img", [new vscode.LanguageModelTextPart("text only"), png()]),
				],
				{ log: (m) => logged.push(m) }
			) as unknown as Array<Record<string, unknown>>;
			assert.deepEqual(
				out.map((m) => m.role),
				["assistant", "tool"]
			);
			assert.strictEqual(expectDefined(out[1]).content, "text only");
			assert.ok(
				logged.some((m) => m.includes("Tool returned image data")),
				`the drop must stay observable, got: ${logged.join(" | ")}`
			);
		});

		test("a text-only tool result synthesizes nothing even for a vision model", () => {
			const out = convertMessages(
				[assistantToolCalls("call_img"), toolResultMessage("call_img", [new vscode.LanguageModelTextPart("plain")])],
				{ imageInput: true }
			) as unknown as Array<Record<string, unknown>>;
			assert.deepEqual(
				out.map((m) => m.role),
				["assistant", "tool"]
			);
			assert.strictEqual(expectDefined(out[1]).content, "plain");
		});

		test("non-image media inside a tool result drops with its own classification log", () => {
			// PDF and audio blocks exist only on user messages; inside a tool
			// result they cannot ride the wire even for a fully capable model,
			// and the drop must stay observable like the non-vision image case.
			const logged: { message: string; data?: unknown }[] = [];
			const pdf = new vscode.LanguageModelDataPart(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf");
			const clip = new vscode.LanguageModelDataPart(new Uint8Array([0x52, 0x49, 0x46, 0x46]), "audio/wav");
			const out = convertMessages(
				[
					assistantToolCalls("call_media"),
					toolResultMessage("call_media", [new vscode.LanguageModelTextPart("report"), pdf, clip]),
				],
				{ imageInput: true, audioInput: true, log: (message, data) => logged.push({ message, data }) }
			) as unknown as Array<Record<string, unknown>>;
			assert.deepEqual(
				out.map((m) => m.role),
				["assistant", "tool"],
				"no message may be synthesized for undeliverable media"
			);
			assert.strictEqual(expectDefined(out[1]).content, "report", "the text survives, the media drops");
			const drops = logged.filter((l) => l.message === "Tool returned media with no tool-result wire mapping");
			assert.deepEqual(
				drops.map((l) => l.data),
				[{ mimeType: "application/pdf" }, { mimeType: "audio/wav" }],
				"each dropped part logs its classification"
			);
		});
	});

	suite("audio input", () => {
		function userWithAudio(mime: string): vscode.LanguageModelChatMessage[] {
			const clip = new vscode.LanguageModelDataPart(new Uint8Array([0x52, 0x49, 0x46, 0x46]), mime);
			return [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("transcribe this:"), clip],
					name: undefined,
				},
			];
		}

		test("audio/wav and audio/mpeg DataParts become input_audio blocks for audio-capable models", () => {
			for (const [mime, format] of [
				["audio/wav", "wav"],
				["audio/vnd.wave", "wav"],
				["audio/mpeg", "mp3"],
				["audio/mp3", "mp3"],
			] as const) {
				const out = convertMessages(userWithAudio(mime), { audioInput: true });
				const content = expectDefined(out[0]).content as unknown as Array<Record<string, unknown>>;
				assert.ok(Array.isArray(content), `${mime} must convert to array content`);
				assert.deepEqual(
					content.map((b) => b.type),
					["text", "input_audio"]
				);
				const audioBlock = content[1] as { input_audio: { data: string; format: string } };
				assert.strictEqual(audioBlock.input_audio.format, format, `${mime} maps to ${format}`);
				assert.strictEqual(audioBlock.input_audio.data, Buffer.from([0x52, 0x49, 0x46, 0x46]).toString("base64"));
			}
		});

		test("audio DataParts drop with the no-wire-mapping log when the model lacks audio input", () => {
			const logged: { message: string; data?: unknown }[] = [];
			const out = convertMessages(userWithAudio("audio/wav"), {
				log: (message, data) => logged.push({ message, data }),
			});
			const first = expectDefined(out[0]);
			assert.strictEqual(first.content, "transcribe this:", "the text survives, the clip drops");
			assert.deepEqual(expectDefined(logged[0]).data, { role: "user", mimeType: "audio/wav" });
		});

		test("audio types outside the wire vocabulary drop even for audio-capable models", () => {
			const logged: { message: string; data?: unknown }[] = [];
			const out = convertMessages(userWithAudio("audio/ogg"), {
				audioInput: true,
				log: (message, data) => logged.push({ message, data }),
			});
			assert.strictEqual(expectDefined(out[0]).content, "transcribe this:");
			assert.deepEqual(expectDefined(logged[0]).data, { role: "user", mimeType: "audio/ogg" });
		});
	});

	suite("prompt-tsx parts and tool-result content", () => {
		function userMessage(parts: unknown[]): vscode.LanguageModelChatMessage {
			return {
				role: vscode.LanguageModelChatMessageRole.User,
				content: parts,
				name: undefined,
			} as vscode.LanguageModelChatMessage;
		}

		function circular(): Record<string, unknown> {
			const value: Record<string, unknown> = {};
			value.self = value;
			return value;
		}

		test("a PromptTsxPart with a string value flows into user message text", () => {
			const out = convertMessages([
				userMessage([
					new vscode.LanguageModelPromptTsxPart("rendered @workspace context"),
					new vscode.LanguageModelTextPart(" and a question"),
				]),
			]);
			assert.strictEqual(expectDefined(out[0]).content, "rendered @workspace context and a question");
		});

		test("a PromptTsxPart with an object value is JSON-stringified; a circular value is dropped without crashing", () => {
			const out = convertMessages([
				userMessage([new vscode.LanguageModelPromptTsxPart({ node: "root", flags: [1, 2] })]),
			]);
			assert.strictEqual(expectDefined(out[0]).content, '{"node":"root","flags":[1,2]}');

			// A host-supplied circular value must not kill the whole request.
			const dropped = convertMessages([
				userMessage([new vscode.LanguageModelPromptTsxPart(circular()), new vscode.LanguageModelTextPart("kept")]),
			]);
			assert.strictEqual(expectDefined(dropped[0]).content, "kept");
		});

		test("a PromptTsxPart with a null or undefined value contributes nothing", () => {
			const out = convertMessages([
				userMessage([
					new vscode.LanguageModelPromptTsxPart(null),
					new vscode.LanguageModelPromptTsxPart(undefined),
					new vscode.LanguageModelTextPart("kept"),
				]),
			]);
			// A regression would push the literal strings "null"/"undefined" into the prompt.
			assert.strictEqual(expectDefined(out[0]).content, "kept");

			const empty = convertMessages([userMessage([new vscode.LanguageModelPromptTsxPart(null)])]);
			assert.deepStrictEqual(empty, []);
		});

		test("tool result content collects PromptTsxPart, raw string, and unknown-object elements", () => {
			const result = new vscode.LanguageModelToolResultPart("call_1", [
				new vscode.LanguageModelPromptTsxPart("tsx says: "),
				// Some hosts hand tool-result content over as bare strings after a
				// serialization round trip; unknown shapes fall back to JSON.
				"raw string, " as unknown as vscode.LanguageModelTextPart,
				{ verdict: "ok" } as unknown as vscode.LanguageModelTextPart,
			]);
			const out = convertMessages([
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [result],
					name: undefined,
				} as vscode.LanguageModelChatMessage,
			]);
			const toolMessage = expectDefined(out[0]);
			assert.strictEqual(toolMessage.role, "tool");
			assert.strictEqual(toolMessage.content, 'tsx says: raw string, {"verdict":"ok"}');
		});

		test("a circular unknown object inside a tool result is ignored rather than throwing", () => {
			const result = new vscode.LanguageModelToolResultPart("call_1", [
				new vscode.LanguageModelTextPart("before "),
				circular() as unknown as vscode.LanguageModelTextPart,
				new vscode.LanguageModelTextPart("after"),
			]);
			const out = convertMessages([
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [result],
					name: undefined,
				} as vscode.LanguageModelChatMessage,
			]);
			assert.strictEqual(expectDefined(out[0]).content, "before after");
		});

		test("non-vision tool result DataParts: text mimes decode, image and other binary mimes each log their drop", () => {
			const logged: string[] = [];
			const result = new vscode.LanguageModelToolResultPart("call_1", [
				new vscode.LanguageModelDataPart(new TextEncoder().encode('{"rows":3}'), "application/json"),
				new vscode.LanguageModelDataPart(new Uint8Array([0x89, 0x50]), "image/png"),
				new vscode.LanguageModelDataPart(new Uint8Array([0x00, 0x01]), "application/octet-stream"),
			]);
			const out = convertMessages(
				[
					{
						role: vscode.LanguageModelChatMessageRole.Assistant,
						content: [result],
						name: undefined,
					} as vscode.LanguageModelChatMessage,
				],
				{ log: (message) => logged.push(message) }
			);
			assert.strictEqual(expectDefined(out[0]).content, '{"rows":3}');
			// The vision arm (imageInput: true synthesizing an image message) is
			// pinned by the tool-result images suite above; this is the gate's
			// other side, with no imageInput capability.
			assert.strictEqual(logged.length, 2, "the image and the opaque binary each log their drop");
			assert.ok(expectDefined(logged[0]).includes("cannot be forwarded"), expectDefined(logged[0]));
			assert.ok(expectDefined(logged[1]).includes("no tool-result wire mapping"), expectDefined(logged[1]));
		});

		test("an empty tool result still emits a tool message with empty-string content", () => {
			const emptyArray = new vscode.LanguageModelToolResultPart("call_a", []);
			// A serialization round trip can legally drop the content field.
			const noContent = new vscode.LanguageModelToolResultPart("call_b", []);
			(noContent as unknown as { content: unknown }).content = undefined;
			const out = convertMessages([
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [emptyArray, noContent],
					name: undefined,
				} as vscode.LanguageModelChatMessage,
			]);
			// OpenAI requires the tool message for call/result pairing even when empty.
			assert.deepStrictEqual(out, [
				{ role: "tool", tool_call_id: "call_a", content: "" },
				{ role: "tool", tool_call_id: "call_b", content: "" },
			]);
		});

		test("a tool call with an empty callId gets a generated id, and circular input serializes as {}", () => {
			const out = convertMessages([
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [new vscode.LanguageModelToolCallPart("", "lookup", circular())],
					name: undefined,
				} as vscode.LanguageModelChatMessage,
			]) as Array<{ tool_calls?: { id: string; function: { arguments: string } }[] }>;
			const call = expectDefined(expectDefined(out[0]).tool_calls?.[0]);
			assert.ok(call.id.length > 0, "an empty callId would break tool-call/result pairing on the wire");
			assert.strictEqual(call.function.arguments, "{}");
		});

		test("an empty-id call/result pair ships one minted id on both halves", () => {
			const out = convertMessages([
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [new vscode.LanguageModelToolCallPart("", "lookup", { q: 1 })],
					name: undefined,
				} as vscode.LanguageModelChatMessage,
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelToolResultPart("", [new vscode.LanguageModelTextPart("ok")])],
					name: undefined,
				} as vscode.LanguageModelChatMessage,
			]) as Array<{ role: string; tool_calls?: { id: string }[]; tool_call_id?: string }>;
			const callId = expectDefined(expectDefined(out[0]).tool_calls?.[0]).id;
			// Deterministic mint: the same history always ships the same id.
			assert.strictEqual(callId, "call_synth_0");
			assert.strictEqual(expectDefined(out[1]).tool_call_id, callId, "the result must reference the minted id");
		});

		test("minted ids never collide with a real id already in the history", () => {
			const out = convertMessages([
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [
						new vscode.LanguageModelToolCallPart("call_synth_0", "real", {}),
						new vscode.LanguageModelToolCallPart("", "minted", {}),
					],
					name: undefined,
				} as vscode.LanguageModelChatMessage,
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [
						new vscode.LanguageModelToolResultPart("call_synth_0", [new vscode.LanguageModelTextPart("a")]),
						new vscode.LanguageModelToolResultPart("", [new vscode.LanguageModelTextPart("b")]),
					],
					name: undefined,
				} as vscode.LanguageModelChatMessage,
			]) as Array<{ role: string; tool_calls?: { id: string }[]; tool_call_id?: string }>;
			const minted = expectDefined(expectDefined(out[0]).tool_calls?.[1]).id;
			assert.notStrictEqual(minted, "call_synth_0", "the mint must skip ids the history already uses");
			assert.strictEqual(expectDefined(out[2]).tool_call_id, minted, "the empty-id result pairs with the minted call");
		});

		test("a null or primitive part in assistant content is ignored", () => {
			const out = convertMessages([
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [null, 42, "a stray string", new vscode.LanguageModelTextPart("kept")],
					name: undefined,
				} as unknown as vscode.LanguageModelChatMessage,
			]);
			assert.strictEqual(expectDefined(out[0]).content, "kept");
		});

		test("a role-3 system message carrying an image DataPart keeps its text and logs the drop with role system", () => {
			const logged: { message: string; data?: unknown }[] = [];
			const out = convertMessages(
				[
					{
						role: 3 as vscode.LanguageModelChatMessageRole,
						content: [
							new vscode.LanguageModelTextPart("you are helpful"),
							new vscode.LanguageModelDataPart(new Uint8Array([1, 2]), "image/png"),
						],
						name: undefined,
					},
				],
				{ log: (message, data) => logged.push({ message, data }) }
			);
			// Content-block arrays on system messages are rejected by many
			// OpenAI-compatible backends; the text must stay a plain string.
			assert.deepStrictEqual(out, [{ role: "system", content: "you are helpful" }]);
			assert.deepStrictEqual(expectDefined(logged[0]).data, { role: "system", mimeType: "image/png" });
		});

		test("a message with undefined content converts to nothing without crashing", () => {
			const out = convertMessages([
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: undefined,
					name: undefined,
				} as unknown as vscode.LanguageModelChatRequestMessage,
			]);
			assert.deepStrictEqual(out, []);
		});
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

		test("a signed thinking part whose value is not a string replays with empty thinking text", () => {
			const out = convertMessages([
				assistantMessage([
					{ value: 42, id: "think_1", metadata: { type: "thinking", signature: "sig-n" } },
					new vscode.LanguageModelTextPart("Answer."),
				]),
			]) as Array<{ thinking_blocks?: unknown }>;
			// Replaying a non-string value verbatim would produce an invalid
			// thinking_blocks entry the provider rejects, failing the follow-up.
			assert.deepStrictEqual(expectDefined(out[0]).thinking_blocks, [
				{ type: "thinking", thinking: "", signature: "sig-n" },
			]);
		});

		test("a redacted block resets accumulated unsigned text and trailing unsigned text is dropped", function () {
			const cls = hostThinkingPartClass();
			if (!cls) {
				this.skip();
				return;
			}
			const out = convertMessages([
				assistantMessage([
					new cls("unsigned before redaction"),
					thinkingPart("", { type: "redacted_thinking", data: "opaque" }),
					thinkingPart("late signed", { type: "thinking", signature: "sig-late" }),
					new cls("trailing unsigned"),
					new vscode.LanguageModelTextPart("Answer."),
				]),
			]) as Array<{ thinking_blocks?: unknown }>;
			// Text accumulated before the redaction must not attach to the later
			// signature (providers reject the mismatch), and trailing unsigned
			// text has no replay value.
			assert.deepStrictEqual(expectDefined(out[0]).thinking_blocks, [
				{ type: "redacted_thinking", data: "opaque" },
				{ type: "thinking", thinking: "late signed", signature: "sig-late" },
			]);
		});
	});
});
