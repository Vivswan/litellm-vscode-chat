import * as assert from "node:assert";
import { applyPromptCacheBreakpoints, type PromptCachedRequest } from "../../../shared/conversion/promptCache";
import type { OpenAIChatContentBlock, OpenAIChatMessage, OpenAIFunctionToolDef } from "../../../shared/conversion/wire";
import { expectDefined } from "../../testUtils";

const EPHEMERAL = { type: "ephemeral" } as const;

function system(text: string): OpenAIChatMessage {
	return { role: "system", content: text };
}

function user(text: string): OpenAIChatMessage {
	return { role: "user", content: text };
}

function assistant(text: string): OpenAIChatMessage {
	return { role: "assistant", content: text };
}

function assistantToolCall(): OpenAIChatMessage {
	return {
		role: "assistant",
		content: undefined,
		tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
	};
}

function toolResult(text: string): OpenAIChatMessage {
	return { role: "tool", tool_call_id: "call_1", content: text };
}

function toolDef(name: string): OpenAIFunctionToolDef {
	return { type: "function", function: { name, description: "a tool", parameters: { type: "object" } } };
}

/** Every cache_control marker in the result, tagged with where it sits. */
function markers(result: PromptCachedRequest): string[] {
	const found: string[] = [];
	for (const [i, tool] of (result.tools ?? []).entries()) {
		if (tool.cache_control) {
			found.push(`tool:${i}`);
		}
	}
	for (const [i, message] of result.messages.entries()) {
		if (message.role === "tool" && message.cache_control) {
			found.push(`message:${i}`);
		}
		if (Array.isArray(message.content)) {
			for (const [j, block] of message.content.entries()) {
				if (block.type === "text" && block.cache_control) {
					found.push(`message:${i}:block:${j}`);
				}
			}
		}
	}
	return found;
}

suite("shared/promptCache applyPromptCacheBreakpoints", () => {
	test("marks the last tool definition and leaves earlier tools untouched", () => {
		const tools = [toolDef("alpha"), toolDef("beta"), toolDef("gamma")];
		const result = applyPromptCacheBreakpoints({ messages: [], tools });
		const out = expectDefined(result.tools);
		assert.strictEqual(out[0]?.cache_control, undefined);
		assert.strictEqual(out[1]?.cache_control, undefined);
		assert.deepStrictEqual(out[2]?.cache_control, EPHEMERAL);
		assert.deepStrictEqual(out[2]?.function, tools[2]?.function, "the marked tool keeps its definition");
	});

	test("marks the system message as a single cached text block", () => {
		const result = applyPromptCacheBreakpoints({ messages: [system("be helpful")] });
		assert.deepStrictEqual(result.messages[0]?.content, [
			{ type: "text", text: "be helpful", cache_control: EPHEMERAL },
		]);
	});

	test("marks the first user message as the stable session anchor", () => {
		const result = applyPromptCacheBreakpoints({
			messages: [system("sys"), user("first task"), assistant("ok"), user("follow-up")],
		});
		assert.deepStrictEqual(result.messages[1]?.content, [
			{ type: "text", text: "first task", cache_control: EPHEMERAL },
		]);
	});

	test("marks the last text-bearing message as the rolling anchor", () => {
		const result = applyPromptCacheBreakpoints({
			messages: [system("sys"), user("task"), assistant("thinking..."), user("go on")],
		});
		assert.deepStrictEqual(result.messages[3]?.content, [{ type: "text", text: "go on", cache_control: EPHEMERAL }]);
		assert.strictEqual(result.messages[2]?.content, "thinking...", "non-anchor messages keep string content");
	});

	test("the rolling anchor lands on a tool-role message in agent sessions", () => {
		const result = applyPromptCacheBreakpoints({
			messages: [system("sys"), user("task"), assistantToolCall(), toolResult("file contents")],
		});
		const last = expectDefined(result.messages[3]);
		assert.strictEqual(last.role, "tool");
		assert.strictEqual(last.tool_call_id, "call_1");
		// Message-level marker: LiteLLM copies it onto the top-level tool_result
		// block, the only position Anthropic can cache. The content stays a
		// string; a block-level marker would land on the nested sub-content and
		// silently no-op.
		assert.strictEqual(last.content, "file contents");
		assert.deepStrictEqual(last.cache_control, EPHEMERAL);
	});

	test("the rolling anchor skips trailing tool-call-only and empty messages", () => {
		const result = applyPromptCacheBreakpoints({
			messages: [
				user("task"),
				assistant("done"),
				{ role: "tool", tool_call_id: "call_1", content: "" },
				assistantToolCall(),
			],
		});
		assert.deepStrictEqual(result.messages[1]?.content, [{ type: "text", text: "done", cache_control: EPHEMERAL }]);
		const emptyToolResult = expectDefined(result.messages[2]);
		assert.ok(emptyToolResult.role === "tool", "the empty tool result keeps its role");
		assert.strictEqual(emptyToolResult.content, "", "empty tool results are never marked");
		assert.strictEqual(emptyToolResult.cache_control, undefined);
		assert.strictEqual(result.messages[3]?.content, undefined);
	});

	test("a trailing empty tool result walks the rolling anchor back onto a thinking assistant turn", () => {
		// The agent-mode shape: the newest tool result is empty, so the anchor
		// falls back to the assistant turn that carries text, tool calls, and
		// replayed thinking blocks. Anthropic forbids cache_control on thinking
		// blocks; the marker must sit on the text block and leave the thinking
		// blocks byte-identical.
		const thinkingAssistant: OpenAIChatMessage = {
			role: "assistant",
			content: "I will read the file next.",
			tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
			thinking_blocks: [{ type: "thinking", thinking: "The README hints at a test gap.", signature: "sig_1" }],
		};
		const result = applyPromptCacheBreakpoints({
			messages: [user("task"), thinkingAssistant, { role: "tool", tool_call_id: "call_1", content: "" }],
		});
		assert.deepStrictEqual(markers(result), ["message:0:block:0", "message:1:block:0"]);
		const anchored = expectDefined(result.messages[1]);
		assert.ok(anchored.role === "assistant", "the anchor stays an assistant turn");
		assert.deepStrictEqual(anchored.content, [
			{ type: "text", text: "I will read the file next.", cache_control: EPHEMERAL },
		]);
		assert.deepStrictEqual(anchored.thinking_blocks, thinkingAssistant.thinking_blocks);
		assert.deepStrictEqual(anchored.tool_calls, thinkingAssistant.tool_calls);
	});

	test("colliding first-user and rolling anchors deduplicate to one marker", () => {
		const result = applyPromptCacheBreakpoints({ messages: [system("sys"), user("only turn")] });
		assert.deepStrictEqual(markers(result), ["message:0:block:0", "message:1:block:0"]);
	});

	test("a lone user message gets exactly one marker", () => {
		const result = applyPromptCacheBreakpoints({ messages: [user("hi")] });
		assert.deepStrictEqual(markers(result), ["message:0:block:0"]);
	});

	test("a full agent request spends exactly the four-breakpoint budget", () => {
		const result = applyPromptCacheBreakpoints({
			messages: [
				system("sys"),
				user("task"),
				assistantToolCall(),
				toolResult("output"),
				assistant("summary"),
				user("next step"),
			],
			tools: [toolDef("alpha"), toolDef("beta")],
		});
		assert.deepStrictEqual(markers(result), ["tool:1", "message:0:block:0", "message:1:block:0", "message:5:block:0"]);
	});

	test("multimodal content keeps its blocks and marks the last non-empty text block", () => {
		const blocks: OpenAIChatContentBlock[] = [
			{ type: "text", text: "look at this" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
			{ type: "text", text: "and tell me what it is" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
		];
		const result = applyPromptCacheBreakpoints({ messages: [{ role: "user", content: blocks }] });
		const content = result.messages[0]?.content as OpenAIChatContentBlock[];
		const firstText = content[0];
		assert.ok(firstText?.type === "text" && firstText.cache_control === undefined, "earlier text stays unmarked");
		assert.deepStrictEqual(content[2], { type: "text", text: "and tell me what it is", cache_control: EPHEMERAL });
		assert.deepStrictEqual(content[1], blocks[1]);
		assert.deepStrictEqual(content[3], blocks[3]);
	});

	test("an image-only message is never an anchor", () => {
		const imageOnly: OpenAIChatMessage = {
			role: "user",
			content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
		};
		const result = applyPromptCacheBreakpoints({ messages: [user("describe"), imageOnly] });
		assert.deepStrictEqual(markers(result), ["message:0:block:0"], "the anchors fall back to text-bearing messages");
		assert.deepStrictEqual(result.messages[1], imageOnly);
	});

	test("an empty conversation without tools stays empty", () => {
		assert.deepStrictEqual(applyPromptCacheBreakpoints({ messages: [] }), { messages: [], tools: undefined });
	});

	test("a conversation without a system message spends at most three breakpoints", () => {
		const result = applyPromptCacheBreakpoints({
			messages: [user("task"), assistant("ok"), user("more")],
			tools: [toolDef("alpha")],
		});
		assert.deepStrictEqual(markers(result), ["tool:0", "message:0:block:0", "message:2:block:0"]);
	});

	test("applying the pass twice adds nothing (idempotence)", () => {
		const request = {
			messages: [system("sys"), user("task"), assistantToolCall(), toolResult("output"), user("next")],
			tools: [toolDef("alpha"), toolDef("beta")],
		};
		const once = applyPromptCacheBreakpoints(request);
		const twice = applyPromptCacheBreakpoints({ messages: once.messages, tools: once.tools });
		assert.deepStrictEqual(twice, once);
	});

	test("never mutates its input", () => {
		const messages = [system("sys"), user("task"), toolResult("output")];
		const tools = [toolDef("alpha")];
		const messagesSnapshot = structuredClone(messages);
		const toolsSnapshot = structuredClone(tools);
		applyPromptCacheBreakpoints({ messages, tools });
		assert.deepStrictEqual(messages, messagesSnapshot);
		assert.deepStrictEqual(tools, toolsSnapshot);
	});
});
