import * as assert from "node:assert";
import type { Scenario } from "../scenarios";
import { BUILTIN_SCENARIOS, collapseChunks } from "../scenarios";
import type { CommandContext } from "./commands";
import { COMMANDS, dispatchCommand, FALLBACK_TEXT, fallbackReply } from "./commands";

/**
 * Pins the fake backend's command grammar: slash-mandatory recognition on
 * the last non-empty line only, case rules, numeric argument domains, caps,
 * deterministic diagnostics, and byte-determinism. The docker suite proves
 * the same grammar through the real proxy; this suite pins the parsing edge
 * cases cheaply.
 */

const scenarios = new Map<string, Scenario>(Object.entries(BUILTIN_SCENARIOS));

function makeContext(text: string, extra: Record<string, unknown> = {}): CommandContext {
	return {
		request: { model: "text-only", stream: true, messages: [{ role: "user", content: text }], ...extra },
		scenarios,
	};
}

/** Dispatch and collapse to the final message content; undefined when no command matched. */
function runText(text: string, extra: Record<string, unknown> = {}): string | undefined {
	const result = dispatchCommand(makeContext(text, extra));
	if (result === undefined) {
		return undefined;
	}
	assert.strictEqual(result.scenario.type, "sse", `expected a text reply for ${JSON.stringify(text)}`);
	const collapsed = collapseChunks((result.scenario as { chunks: unknown[] }).chunks);
	const message = (collapsed.choices as Array<{ message: { content: string } }>)[0]?.message;
	return message?.content;
}

suite("fakeStack commands: recognition", () => {
	test("a bare slash command dispatches", () => {
		assert.ok(runText("/help")?.includes("/help"));
	});

	test("slashless verbs are not commands", () => {
		assert.strictEqual(dispatchCommand(makeContext("help")), undefined);
	});

	test("leading whitespace disqualifies the line: the slash must be its first byte", () => {
		assert.strictEqual(dispatchCommand(makeContext(" /help")), undefined);
		assert.strictEqual(dispatchCommand(makeContext("\t/echo:x")), undefined);
	});

	test("echo keeps trailing bytes after the colon", () => {
		assert.strictEqual(runText("/echo:kept   "), "kept   ");
	});

	test("echo of a single space echoes the space", () => {
		assert.strictEqual(runText("/echo: "), " ");
	});

	test("only the LAST non-empty line counts: mid-message commands are ignored", () => {
		assert.strictEqual(dispatchCommand(makeContext("/echo:first\nmore prose after it")), undefined);
	});

	test("multiple command-looking lines: the final one dispatches", () => {
		assert.strictEqual(runText("/echo:first\n/echo:second"), "second");
	});

	test("command-looking lines inside earlier pasted context are ignored", () => {
		const pasted = "```\n/help\n/error:500\n```\nwhat does this code do?";
		assert.strictEqual(dispatchCommand(makeContext(pasted)), undefined);
	});

	test("trailing blank lines do not hide the command", () => {
		assert.strictEqual(runText("/echo:kept\n\n  \n"), "kept");
	});

	test("a trailing carriage return is stripped before matching", () => {
		assert.strictEqual(runText("first line\r\n/echo:crlf\r\n"), "crlf");
	});

	test("the verb matches case-insensitively; the argument preserves case", () => {
		assert.strictEqual(runText("/EcHo:CaSe Preserved"), "CaSe Preserved");
	});

	test("echo is byte-exact after the delimiting colon", () => {
		assert.strictEqual(runText("/echo: leading and internal  spaces"), " leading and internal  spaces");
	});

	test("an unknown verb is not a command", () => {
		assert.strictEqual(dispatchCommand(makeContext("/frobnicate:1")), undefined);
	});

	test("a verb with trailing prose is not a command", () => {
		assert.strictEqual(dispatchCommand(makeContext("/help me with this")), undefined);
	});

	test("the command is read from the last USER message text parts", () => {
		const context: CommandContext = {
			request: {
				model: "text-only",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "context" },
							{ type: "text", text: "/echo:parts" },
						],
					},
					{ role: "assistant", content: "/echo:assistant text never dispatches" },
				],
			},
			scenarios,
		};
		const result = dispatchCommand(context);
		assert.ok(result);
		const collapsed = collapseChunks((result.scenario as { chunks: unknown[] }).chunks);
		assert.strictEqual((collapsed.choices as Array<{ message: { content: string } }>)[0]?.message.content, "parts");
	});

	test("no user message means no command", () => {
		assert.strictEqual(dispatchCommand({ request: { messages: [] }, scenarios }), undefined);
	});
});

suite("fakeStack commands: numeric domains and diagnostics", () => {
	const diagnosticCases: Array<[string, string]> = [
		["/stream:0", "zero count"],
		["/stream:-3", "negative count"],
		["/stream:2.5", "fractional count"],
		["/stream:", "empty arg"],
		["/stream:5:10:9", "extra separator"],
		["/stream:501", "over the chunk cap"],
		["/stream:5:5001", "over the delay cap"],
		["/text:0", "zero word count"],
		["/text:5001", "over the word cap"],
		["/text:5:4294967296", "seed over the 32-bit domain"],
		["/think:0", "zero steps"],
		["/think:101", "over the step cap"],
		["/delay:0", "zero delay"],
		["/delay:60001", "over the delay cap"],
		["/error:999", "status outside the valid set"],
		["/echo:", "empty echo argument"],
		["/echo", "bare echo without a colon"],
		["/tool", "bare tool without a colon"],
		["/play", "bare play without a colon"],
		["/stream:5:0", "zero per-chunk delay"],
		["/error:teapot", "non-numeric status"],
		["/finish:stop", "unsupported finish reason"],
		["/help:extra", "bare command with an argument"],
		["/params:x", "bare command with an argument"],
	];
	for (const [input, label] of diagnosticCases) {
		test(`${label} (${input}) yields the fixed diagnostic text, never an HTTP error`, () => {
			const result = dispatchCommand(makeContext(input));
			assert.ok(result, `${input} must still be recognized`);
			assert.strictEqual(result.scenario.type, "sse", `${input} must reply as text`);
			const text = runText(input);
			assert.ok(text?.startsWith("Bad arguments for /"), `got: ${text}`);
			assert.ok(text?.includes("Usage:"), "the diagnostic points at usage");
		});
	}

	test("numeric arguments tolerate surrounding whitespace", () => {
		const result = dispatchCommand(makeContext("/text: 12 "));
		assert.ok(result);
		assert.ok(!runText("/text: 12 ")?.startsWith("Bad arguments"));
	});

	test("the /text seed is 0-based", () => {
		const zeroSeed = runText("/text:5:0");
		assert.ok(zeroSeed && !zeroSeed.startsWith("Bad arguments"));
		assert.strictEqual(zeroSeed.trim().split(/\s+/).length, 5);
	});

	test("/error with a valid status produces that HTTP error scenario", () => {
		const result = dispatchCommand(makeContext("/error:429"));
		assert.ok(result);
		assert.deepStrictEqual(
			{ type: result.scenario.type, statusCode: (result.scenario as { statusCode: number }).statusCode },
			{ type: "error", statusCode: 429 }
		);
	});
});

suite("fakeStack commands: behavior", () => {
	test("help lists every command usage and the play targets", () => {
		const text = runText("/help");
		assert.ok(text);
		for (const command of COMMANDS) {
			assert.ok(text.includes(command.usage), `help must list ${command.usage}`);
		}
		assert.ok(text.includes("text-only"), "help lists play targets");
	});

	test("the dispatch table holds exactly the specified verb set", () => {
		// An independent literal list, not derived from the implementation: a
		// verb added or dropped in commands.ts must fail here first.
		const expected = [
			"attachments",
			"audio",
			"cache",
			"delay",
			"deployment",
			"echo",
			"error",
			"finish",
			"help",
			"image",
			"messages",
			"params",
			"play",
			"stream",
			"text",
			"think",
			"tool",
			"tools",
		];
		assert.deepStrictEqual([...COMMANDS.map((command) => command.verb)].sort(), expected);
	});

	test("identical input produces identical serialized SSE bytes", () => {
		const serialize = (input: string): string => {
			const result = dispatchCommand(makeContext(input));
			assert.ok(result && result.scenario.type === "sse");
			return result.scenario.chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
		};
		assert.strictEqual(serialize("/text:40"), serialize("/text:40"));
		assert.deepStrictEqual(dispatchCommand(makeContext("/help")), dispatchCommand(makeContext("/help")));
	});

	test("the envelope id hashes the full request: a non-message field changes it", () => {
		const idOf = (extra: Record<string, unknown>): string => {
			const result = dispatchCommand(makeContext("/echo:same", extra));
			assert.ok(result && result.scenario.type === "sse");
			return (result.scenario.chunks[0] as { id: string }).id;
		};
		assert.strictEqual(idOf({ temperature: 0.2 }), idOf({ temperature: 0.2 }));
		assert.notStrictEqual(idOf({ temperature: 0.2 }), idOf({ temperature: 0.7 }));
	});

	test("every chunk envelope carries service_tier", () => {
		const result = dispatchCommand(makeContext("/echo:tiered"));
		assert.ok(result && result.scenario.type === "sse");
		for (const chunk of result.scenario.chunks) {
			assert.strictEqual((chunk as { service_tier?: string }).service_tier, "default");
		}
	});

	test("the usage trailer appears only when stream_options.include_usage asks for it", () => {
		const usageChunks = (extra: Record<string, unknown>): number => {
			const result = dispatchCommand(makeContext("/echo:gated", extra));
			assert.ok(result && result.scenario.type === "sse");
			return result.scenario.chunks.filter((chunk) => (chunk as { usage?: unknown }).usage !== undefined).length;
		};
		assert.strictEqual(usageChunks({}), 0, "no stream_options, no trailer");
		assert.strictEqual(usageChunks({ stream_options: { include_usage: true } }), 1);
	});

	test("/stream's trailer carries both token-detail objects", () => {
		const result = dispatchCommand(makeContext("/stream:3", { stream_options: { include_usage: true } }));
		assert.ok(result && result.scenario.type === "sse-delayed");
		const trailer = result.scenario.chunks[result.scenario.chunks.length - 1] as {
			usage?: { prompt_tokens_details?: unknown; completion_tokens_details?: unknown };
		};
		assert.ok(trailer.usage, "/stream emits the trailer like every textual reply");
		assert.ok(trailer.usage.prompt_tokens_details, "prompt_tokens_details present");
		assert.ok(trailer.usage.completion_tokens_details, "completion_tokens_details present");
	});

	test("/image and /audio emit byte-stable payloads, pinned by hash", () => {
		assert.ok(runText("/image")?.includes("sha256=57c5b0ba802ba3aa9c4ebd11a8ef32d173abc6dd5b3deabb7cd540b66e14edc5"));
		assert.ok(runText("/audio")?.includes("sha256=08662970568d4e2cf49988067bee006f7e8ded8c4cd93f4aa6ef4211b891d8af"));
	});

	test("different conversations draw different default /text seeds", () => {
		assert.notStrictEqual(runText("/text:40"), runText("a different prefix\n/text:40"));
	});

	test("an explicit seed pins /text output across conversations", () => {
		assert.strictEqual(runText("prefix one\n/text:12:7"), runText("another prefix\n/text:12:7"));
	});

	test("/text produces exactly n words", () => {
		const text = runText("/text:25:3");
		assert.strictEqual(text?.trim().split(/\s+/).length, 25);
	});

	test("/play plays the named scenario verbatim", () => {
		const result = dispatchCommand(makeContext("/play:parallel-tool-calls"));
		assert.deepStrictEqual(result?.scenario, BUILTIN_SCENARIOS["parallel-tool-calls"]);
	});

	test("/play with an unknown name yields the fixed diagnostic pointing at /help", () => {
		const text = runText("/play:nope");
		assert.ok(text?.includes('Unknown scenario "nope"'));
		assert.ok(text?.includes("/help"));
	});

	test("/stream emits n content chunks under an sse-delayed scenario", () => {
		const result = dispatchCommand(makeContext("/stream:5:50"));
		assert.ok(result && result.scenario.type === "sse-delayed");
		assert.strictEqual(result.scenario.delayMs, 50);
		const text = collapseChunks(result.scenario.chunks) as { choices: Array<{ message: { content: string } }> };
		assert.strictEqual(text.choices[0]?.message.content, "chunk1 chunk2 chunk3 chunk4 chunk5 ");
	});

	test("/delay carries the first-byte delay alongside a text scenario", () => {
		const result = dispatchCommand(makeContext("/delay:1500"));
		assert.strictEqual(result?.firstByteDelayMs, 1500);
		assert.strictEqual(result?.scenario.type, "sse");
	});

	test("/finish ends with the requested finish_reason", () => {
		const result = dispatchCommand(makeContext("/finish:length"));
		assert.ok(result && result.scenario.type === "sse");
		const collapsed = collapseChunks(result.scenario.chunks) as { choices: Array<{ finish_reason: string }> };
		assert.strictEqual(collapsed.choices[0]?.finish_reason, "length");
	});

	test("two cuttable pieces yield exactly two content deltas", () => {
		const result = dispatchCommand(makeContext("/echo:ab cd"));
		assert.ok(result && result.scenario.type === "sse");
		const contentDeltas = result.scenario.chunks
			.map((chunk) => (chunk as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content)
			.filter((content): content is string => typeof content === "string");
		assert.deepStrictEqual(contentDeltas, ["ab ", "cd"]);
	});

	test("a malformed percent-escape in a data URL never throws: /attachments hashes the raw URL", () => {
		const context: CommandContext = {
			request: {
				model: "text-only",
				messages: [
					{
						role: "user",
						content: [
							{ type: "image_url", image_url: { url: "data:image/svg+xml,%zz-not-percent-encoded" } },
							{ type: "text", text: "/attachments" },
						],
					},
				],
			},
			scenarios,
		};
		const result = dispatchCommand(context);
		assert.ok(result && result.scenario.type === "sse", "dispatch survived the malformed escape");
		const collapsed = collapseChunks(result.scenario.chunks) as {
			choices: Array<{ message: { content: string } }>;
		};
		const text = collapsed.choices[0]?.message.content ?? "";
		assert.match(text, /part\[0\]: kind=image_url mime=- bytes=\d+ sha256=[0-9a-f]{64}/);
	});

	test("the fallback reply is fixed and comfortably over 50 characters", () => {
		assert.ok(FALLBACK_TEXT.length > 50);
		const result = fallbackReply(makeContext("anything"));
		const collapsed = collapseChunks((result.scenario as { chunks: unknown[] }).chunks);
		assert.strictEqual(
			(collapsed.choices as Array<{ message: { content: string } }>)[0]?.message.content,
			FALLBACK_TEXT
		);
	});
});

suite("fakeStack commands: tool flow", () => {
	const tools = [
		{ type: "function", function: { name: "get_weather", description: "Get the weather" } },
		{ type: "function", function: { name: "run_query", description: "Run a query" } },
	];

	test("a call turn emits one tool call with a deterministic id", () => {
		const result = dispatchCommand(makeContext('/tool:get_weather {"location":"Paris"}', { tools }));
		assert.ok(result && result.scenario.type === "sse");
		const collapsed = collapseChunks(result.scenario.chunks) as {
			choices: Array<{
				message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
				finish_reason: string;
			}>;
		};
		const choice = collapsed.choices[0];
		assert.strictEqual(choice?.finish_reason, "tool_calls");
		assert.strictEqual(choice?.message.tool_calls?.[0]?.id, "call_fake_0");
		assert.strictEqual(choice?.message.tool_calls?.[0]?.function.name, "get_weather");
		assert.deepStrictEqual(JSON.parse(choice?.message.tool_calls?.[0]?.function.arguments ?? "{}"), {
			location: "Paris",
		});
	});

	test("a tool result after the command turn produces the summary text", () => {
		const context: CommandContext = {
			request: {
				model: "text-only",
				tools,
				messages: [
					{ role: "user", content: "/tool:get_weather" },
					{ role: "assistant", content: null, tool_calls: [{ id: "call_fake_0" }] },
					{ role: "tool", tool_call_id: "call_fake_0", content: "sunny, 21C" },
				],
			},
			scenarios,
		};
		const result = dispatchCommand(context);
		assert.ok(result && result.scenario.type === "sse");
		const collapsed = collapseChunks(result.scenario.chunks) as {
			choices: Array<{ message: { content: string } }>;
		};
		assert.strictEqual(collapsed.choices[0]?.message.content, "tool get_weather returned: sunny, 21C");
	});

	test("the call id counts prior tool turns", () => {
		const context: CommandContext = {
			request: {
				model: "text-only",
				tools,
				messages: [
					{ role: "user", content: "/tool:get_weather" },
					{ role: "assistant", content: null },
					{ role: "tool", content: "first result" },
					{ role: "user", content: "/tool:run_query" },
				],
			},
			scenarios,
		};
		const result = dispatchCommand(context);
		assert.ok(result && result.scenario.type === "sse");
		const collapsed = collapseChunks(result.scenario.chunks) as {
			choices: Array<{ message: { tool_calls?: Array<{ id: string }> } }>;
		};
		assert.strictEqual(collapsed.choices[0]?.message.tool_calls?.[0]?.id, "call_fake_1");
	});

	test("an unavailable tool name yields a fixed text reply, not a call", () => {
		const text = runText("/tool:not_offered", { tools });
		assert.ok(text?.includes('The tool "not_offered" is not offered'));
	});

	test("malformed JSON args yield a fixed text reply", () => {
		const text = runText('/tool:get_weather {"broken', { tools });
		assert.ok(text?.includes("not valid JSON"));
	});

	test("tool JSON args over 16 KiB yield the fixed diagnostic", () => {
		const oversized = `{"pad":"${"x".repeat(17 * 1024)}"}`;
		const text = runText(`/tool:get_weather ${oversized}`, { tools });
		assert.ok(text?.startsWith("Bad arguments for /tool"), `got: ${text?.slice(0, 80)}`);
	});
});
