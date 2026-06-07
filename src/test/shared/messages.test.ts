import * as assert from "assert";
import * as vscode from "vscode";
import { convertMessages } from "../../shared/messages";

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
});

interface CacheableTextBlock {
	type: string;
	text: string;
	// Mirrors the on-the-wire CacheControl shape: 5m is encoded by omitting
	// `ttl` entirely, so the only valid explicit value is "1h".
	cache_control?: { type: "ephemeral"; ttl?: "1h" };
}
interface CacheableMessage {
	role: string;
	content?: string | CacheableTextBlock[];
}

function countCacheControlMarkers(messages: CacheableMessage[]): number {
	let count = 0;
	for (const m of messages) {
		if (Array.isArray(m.content)) {
			for (const block of m.content) {
				if (block.cache_control) {
					count++;
				}
			}
		}
	}
	return count;
}

function findFirstUserMessage(messages: CacheableMessage[]): CacheableMessage | undefined {
	return messages.find((m) => m.role === "user");
}

suite("shared/messages cache_control breakpoints", () => {
	const buildAgentTranscript = (): vscode.LanguageModelChatMessage[] => [
		{
			role: vscode.LanguageModelChatMessageRole.User, // System prompts arrive as User role w/ Assistant after via VS Code mapping
			content: [new vscode.LanguageModelTextPart("you are a helpful assistant")],
			name: undefined,
		},
		{
			role: vscode.LanguageModelChatMessageRole.User,
			content: [new vscode.LanguageModelTextPart("first user task: build a feature")],
			name: undefined,
		},
		{
			role: vscode.LanguageModelChatMessageRole.Assistant,
			content: [new vscode.LanguageModelTextPart("understood, working on it")],
			name: undefined,
		},
		{
			role: vscode.LanguageModelChatMessageRole.User,
			content: [new vscode.LanguageModelTextPart("follow-up: also do X")],
			name: undefined,
		},
		{
			role: vscode.LanguageModelChatMessageRole.Assistant,
			content: [new vscode.LanguageModelTextPart("ok, last assistant reply")],
			name: undefined,
		},
	];

	test("firstUser anchor tags the first user message", () => {
		const out = convertMessages(buildAgentTranscript(), {
			cache: { firstUser: { ttl: "5m" } },
		}) as CacheableMessage[];
		const first = findFirstUserMessage(out);
		assert.ok(first, "expected at least one user message");
		assert.ok(Array.isArray(first.content), "first user content should be promoted to array form when tagged");
		const blocks = first.content as CacheableTextBlock[];
		const taggedBlocks = blocks.filter((b) => b.cache_control);
		assert.equal(taggedBlocks.length, 1, "first user message should have exactly one cache_control marker");
		assert.equal(taggedBlocks[0].cache_control?.type, "ephemeral");
		assert.equal(taggedBlocks[0].cache_control?.ttl, undefined, "5m TTL must omit the ttl field on the wire");
	});

	test('firstUser anchor with ttl "1h" emits the ttl field', () => {
		const out = convertMessages(buildAgentTranscript(), {
			cache: { firstUser: { ttl: "1h" } },
		}) as CacheableMessage[];
		const first = findFirstUserMessage(out);
		assert.ok(first && Array.isArray(first.content));
		const tagged = (first.content as CacheableTextBlock[]).filter((b) => b.cache_control);
		assert.equal(tagged.length, 1);
		assert.equal(tagged[0].cache_control?.ttl, "1h", '1h TTL must emit ttl: "1h"');
	});

	test("firstUser anchor only tags the FIRST user message (not later user messages)", () => {
		const out = convertMessages(buildAgentTranscript(), {
			cache: { firstUser: { ttl: "5m" } },
		}) as CacheableMessage[];
		const userMessages = out.filter((m) => m.role === "user");
		assert.ok(userMessages.length >= 2, "expected multiple user messages in fixture");
		// First user message should be tagged
		const firstBlocks = userMessages[0].content as CacheableTextBlock[];
		assert.ok(Array.isArray(firstBlocks) && firstBlocks.some((b) => b.cache_control));
		// Subsequent user messages should NOT be tagged by this option alone
		for (let i = 1; i < userMessages.length; i++) {
			const c = userMessages[i].content;
			if (Array.isArray(c)) {
				for (const b of c as CacheableTextBlock[]) {
					assert.ok(!b.cache_control, `user message #${i} should not be tagged by cacheFirstUserMessage`);
				}
			}
		}
	});

	test("firstUser anchor is idempotent across repeated calls (deterministic output)", () => {
		const messages = buildAgentTranscript();
		const out1 = convertMessages(messages, { cache: { firstUser: { ttl: "5m" } } });
		const out2 = convertMessages(messages, { cache: { firstUser: { ttl: "5m" } } });
		assert.deepEqual(out1, out2, "convertMessages should be deterministic for identical input");
	});

	test("no cache_control markers are emitted when no cache options are set", () => {
		const out = convertMessages(buildAgentTranscript()) as CacheableMessage[];
		assert.equal(countCacheControlMarkers(out), 0);
	});

	test("system anchor tags only the final leading system message", () => {
		const systemRole = 0 as vscode.LanguageModelChatMessageRole;
		const messages: vscode.LanguageModelChatMessage[] = [
			{ role: systemRole, content: [new vscode.LanguageModelTextPart("system part one")], name: undefined },
			{ role: systemRole, content: [new vscode.LanguageModelTextPart("system part two")], name: undefined },
			{ role: systemRole, content: [new vscode.LanguageModelTextPart("system part three")], name: undefined },
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
			cache: {
				system: { ttl: "1h" },
				firstUser: { ttl: "1h" },
				rolling: { ttl: "5m", placement: "always" },
			},
		}) as CacheableMessage[];

		assert.equal(countCacheControlMarkers(out), 3, "system + firstUser + rolling should use three message markers");
		const systemMessages = out.filter((m) => m.role === "system");
		assert.equal(systemMessages.length, 3);
		assert.equal(Array.isArray(systemMessages[0].content), false, "first system part must not be tagged");
		assert.equal(Array.isArray(systemMessages[1].content), false, "middle system part must not be tagged");
		assert.ok(Array.isArray(systemMessages[2].content), "final leading system part should be tagged");
		const finalSystemBlocks = systemMessages[2].content as CacheableTextBlock[];
		assert.equal(finalSystemBlocks.filter((b) => b.cache_control).length, 1);
		assert.equal(finalSystemBlocks[0].cache_control?.ttl, "1h");
	});

	test("combining firstUser + rolling never exceeds 2 message-level markers", () => {
		const out = convertMessages(buildAgentTranscript(), {
			cache: {
				firstUser: { ttl: "5m" },
				rolling: { ttl: "5m", placement: "always" },
			},
		}) as CacheableMessage[];
		const total = countCacheControlMarkers(out);
		// First user (1) + last text-bearing message (1) = 2.
		// If they happen to land on the same message, we get 1.
		assert.ok(total === 1 || total === 2, `expected 1 or 2 markers, got ${total}`);
		// First user message must be tagged.
		const first = findFirstUserMessage(out);
		assert.ok(first && Array.isArray(first.content));
		const firstBlocks = first.content as CacheableTextBlock[];
		assert.ok(firstBlocks.some((b) => b.cache_control));
		// Last text-bearing message must be tagged.
		let lastTagged = false;
		for (let i = out.length - 1; i >= 0; i--) {
			const c = out[i].content;
			if (Array.isArray(c) && (c as CacheableTextBlock[]).some((b) => b.cache_control)) {
				lastTagged = true;
				break;
			} else if (typeof c === "string" && c.length > 0) {
				// Untagged text-bearing message reached before any tagged one => fail.
				break;
			}
		}
		assert.ok(lastTagged, "last text-bearing message should carry a cache_control marker");
	});

	test("firstUser anchor with single-user-only conversation tags that one message", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("only one user turn")],
				name: undefined,
			},
		];
		const out = convertMessages(messages, { cache: { firstUser: { ttl: "5m" } } }) as CacheableMessage[];
		assert.equal(out.length, 1);
		assert.equal(out[0].role, "user");
		assert.ok(Array.isArray(out[0].content));
		const blocks = out[0].content as CacheableTextBlock[];
		assert.equal(blocks.filter((b) => b.cache_control).length, 1);
	});

	test("regression: rolling (5m) must not downgrade a firstUser (1h) marker on the same message", () => {
		// Single user turn => firstUser and rolling both resolve to the same
		// message. firstUser is 1h, rolling is 5m. The upgrade-only guard must
		// keep the 1h marker rather than demoting it to 5m (which would also
		// violate Bedrock's non-increasing-TTL ordering invariant).
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("only one user turn")],
				name: undefined,
			},
		];
		const out = convertMessages(messages, {
			cache: {
				firstUser: { ttl: "1h" },
				rolling: { ttl: "5m", placement: "always" },
			},
		}) as CacheableMessage[];
		const user = out.find((m) => m.role === "user");
		assert.ok(user && Array.isArray(user.content));
		const tagged = (user.content as CacheableTextBlock[]).filter((b) => b.cache_control);
		assert.equal(tagged.length, 1, "exactly one marker on the shared message");
		assert.equal(tagged[0].cache_control?.ttl, "1h", "1h must survive; rolling 5m must not demote it");
	});

	test("rolling (1h) MAY upgrade a firstUser (5m) marker on the same message", () => {
		// Symmetric to the downgrade guard: a longer rolling TTL is allowed to
		// overwrite a shorter existing marker (upgrade is always safe).
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("only one user turn")],
				name: undefined,
			},
		];
		const out = convertMessages(messages, {
			cache: {
				firstUser: { ttl: "5m" },
				rolling: { ttl: "1h", placement: "always" },
			},
		}) as CacheableMessage[];
		const user = out.find((m) => m.role === "user");
		assert.ok(user && Array.isArray(user.content));
		const tagged = (user.content as CacheableTextBlock[]).filter((b) => b.cache_control);
		assert.equal(tagged.length, 1);
		assert.equal(tagged[0].cache_control?.ttl, "1h", "longer rolling TTL may upgrade the existing 5m marker");
	});

	test("firstUser anchor skips assistant messages even if they come first", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("assistant pre-amble")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("user task")],
				name: undefined,
			},
		];
		const out = convertMessages(messages, { cache: { firstUser: { ttl: "5m" } } }) as CacheableMessage[];
		const assistant = out.find((m) => m.role === "assistant");
		const user = out.find((m) => m.role === "user");
		// Assistant must remain untagged (string or array without cache_control).
		if (assistant && Array.isArray(assistant.content)) {
			for (const b of assistant.content as CacheableTextBlock[]) {
				assert.ok(!b.cache_control, "assistant message must not be tagged by the firstUser anchor");
			}
		}
		// User must be tagged.
		assert.ok(user && Array.isArray(user.content));
		const blocks = user.content as CacheableTextBlock[];
		assert.equal(blocks.filter((b) => b.cache_control).length, 1);
	});
});

suite("shared/messages rolling-last cache_control modes", () => {
	// Build a transcript whose LAST message is a tool result (most volatile,
	// the case stableTurnsOnly is designed to skip).
	const buildTranscriptEndingWithToolResult = (): vscode.LanguageModelChatMessage[] => {
		const toolCall = new vscode.LanguageModelToolCallPart("call-1", "readFile", { path: "x.ts" });
		const toolResult = new vscode.LanguageModelToolResultPart("call-1", [
			new vscode.LanguageModelTextPart("file contents that may change between turns"),
		]);
		return [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("please read the file")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("reading"), toolCall],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [toolResult],
				name: undefined,
			},
		];
	};

	const buildTranscriptEndingWithAssistantText = (): vscode.LanguageModelChatMessage[] => [
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

	test('rolling placement "always" tags last message even when it is a tool result', () => {
		const placed = { role: "" };
		const out = convertMessages(buildTranscriptEndingWithToolResult(), {
			cache: { rolling: { ttl: "5m", placement: "always" } },
			placedRollingOn: placed,
		}) as CacheableMessage[];
		assert.equal(placed.role, "tool", 'rolling marker should land on the tool result with placement "always"');
		const last = out[out.length - 1];
		assert.equal(last.role, "tool");
		// Tool result content is an array; at least one block should carry cache_control.
		assert.ok(Array.isArray(last.content));
		const tagged = (last.content as CacheableTextBlock[]).filter((b) => b.cache_control);
		assert.equal(tagged.length, 1);
	});

	test('rolling placement "stableTurnsOnly" skips tool result and tags previous assistant turn', () => {
		const placed = { role: "" };
		const out = convertMessages(buildTranscriptEndingWithToolResult(), {
			cache: { rolling: { ttl: "5m", placement: "stableTurnsOnly" } },
			placedRollingOn: placed,
		}) as CacheableMessage[];
		assert.equal(
			placed.role,
			"assistant",
			'rolling marker should land on assistant turn with placement "stableTurnsOnly"'
		);
		// Last message is the tool result and must carry NO cache_control.
		const last = out[out.length - 1];
		assert.equal(last.role, "tool");
		if (Array.isArray(last.content)) {
			for (const b of last.content as CacheableTextBlock[]) {
				assert.ok(!b.cache_control, "tool result must not be tagged in stableTurnsOnly mode");
			}
		}
		// Some prior assistant message should be tagged.
		const taggedCount = countCacheControlMarkers(out);
		assert.equal(taggedCount, 1, "exactly one rolling marker should be placed");
	});

	test("absent rolling spec places no rolling marker", () => {
		const placed = { role: "" };
		const out = convertMessages(buildTranscriptEndingWithToolResult(), {
			cache: {},
			placedRollingOn: placed,
		}) as CacheableMessage[];
		assert.equal(placed.role, "skipped", "placedRollingOn.role should be 'skipped' when no marker is placed");
		assert.equal(countCacheControlMarkers(out), 0, "no rolling marker should be present");
	});

	test('rolling placement "never" places no rolling marker', () => {
		const placed = { role: "" };
		const out = convertMessages(buildTranscriptEndingWithToolResult(), {
			cache: { rolling: { ttl: "5m", placement: "never" } },
			placedRollingOn: placed,
		}) as CacheableMessage[];
		assert.equal(placed.role, "skipped", "placedRollingOn.role should be 'skipped' for placement 'never'");
		assert.equal(countCacheControlMarkers(out), 0, "no rolling marker should be present");
	});

	test('rolling placement "stableTurnsOnly" with assistant-text tail behaves identically to "always"', () => {
		const placed1 = { role: "" };
		const placed2 = { role: "" };
		const a = convertMessages(buildTranscriptEndingWithAssistantText(), {
			cache: { rolling: { ttl: "5m", placement: "always" } },
			placedRollingOn: placed1,
		}) as CacheableMessage[];
		const b = convertMessages(buildTranscriptEndingWithAssistantText(), {
			cache: { rolling: { ttl: "5m", placement: "stableTurnsOnly" } },
			placedRollingOn: placed2,
		}) as CacheableMessage[];
		assert.equal(placed1.role, "assistant");
		assert.equal(placed2.role, "assistant");
		assert.deepEqual(a, b, '"stableTurnsOnly" should match "always" when last message is not a tool result');
	});

	test("rolling anchor carries its TTL (1h emitted, 5m omitted)", () => {
		const out1h = convertMessages(buildTranscriptEndingWithAssistantText(), {
			cache: { rolling: { ttl: "1h", placement: "always" } },
		}) as CacheableMessage[];
		const last1h = out1h[out1h.length - 1];
		const tagged1h = (last1h.content as CacheableTextBlock[]).filter((b) => b.cache_control);
		assert.equal(tagged1h[0].cache_control?.ttl, "1h");

		const out5m = convertMessages(buildTranscriptEndingWithAssistantText(), {
			cache: { rolling: { ttl: "5m", placement: "always" } },
		}) as CacheableMessage[];
		const last5m = out5m[out5m.length - 1];
		const tagged5m = (last5m.content as CacheableTextBlock[]).filter((b) => b.cache_control);
		assert.equal(tagged5m[0].cache_control?.ttl, undefined);
	});

	test('rolling placement "stableTurnsOnly" with all-tool tail places no marker (graceful)', () => {
		// Pathological case: every message is a tool result. stableTurnsOnly should
		// walk to the start without tagging anything rather than tag a tool message.
		const toolResult = new vscode.LanguageModelToolResultPart("c1", [new vscode.LanguageModelTextPart("r")]);
		const messages: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolResult], name: undefined },
		];
		const placed = { role: "" };
		const out = convertMessages(messages, {
			cache: { rolling: { ttl: "5m", placement: "stableTurnsOnly" } },
			placedRollingOn: placed,
		}) as CacheableMessage[];
		assert.equal(placed.role, "skipped");
		assert.equal(countCacheControlMarkers(out), 0);
	});
});
