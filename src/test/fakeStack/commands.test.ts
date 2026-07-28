import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Scenario } from "../scenarios";
import { BUILTIN_SCENARIOS, collapseChunks } from "../scenarios";
import type { CommandContext } from "./commands";
import {
	COMMAND_SIGIL,
	COMMANDS,
	dispatchCommand,
	FALLBACK_TEXT,
	fallbackReply,
	PNG_SHA256,
	WAV_SHA256,
} from "./commands";

/**
 * Pins the fake backend's command grammar: "%"-mandatory recognition on
 * the last non-empty line only, case rules, numeric argument domains, caps,
 * deterministic diagnostics, and byte-determinism. The docker suite proves
 * the same grammar through the real proxy; this suite pins the parsing edge
 * cases cheaply. "/"- and "!"-prefixed lines are deliberately ordinary
 * text: Copilot Chat intercepts "/" and agent CLIs intercept "!" in their
 * inputs, so neither can carry a command.
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
	test(`a bare ${COMMAND_SIGIL} command dispatches`, () => {
		assert.ok(runText(`${COMMAND_SIGIL}help`)?.includes(`${COMMAND_SIGIL}help`));
	});

	test("sigil-less verbs are not commands", () => {
		assert.strictEqual(dispatchCommand(makeContext("help")), undefined);
	});

	test("a slash-prefixed line is ordinary text: /help never dispatches", () => {
		// The exact Copilot-intercepted shape: even when a literal "/help" DOES
		// reach the model (pasted, or sent by a non-Copilot client), it is text.
		assert.strictEqual(dispatchCommand(makeContext("/help")), undefined);
		assert.strictEqual(dispatchCommand(makeContext("/echo:x")), undefined);
		assert.strictEqual(dispatchCommand(makeContext("/stream:5:50")), undefined);
	});

	test("a bang-prefixed line is ordinary text: !help never dispatches", () => {
		// The retired second sigil: agent CLIs (Claude Code) run "!"-prefixed
		// input as shell commands, so "!" lines are plain text like "/" lines.
		assert.strictEqual(dispatchCommand(makeContext("!help")), undefined);
		assert.strictEqual(dispatchCommand(makeContext("!echo:x")), undefined);
		assert.strictEqual(dispatchCommand(makeContext("!stream:5:50")), undefined);
	});

	test("a doubled sigil is ordinary text: cell-magic and comment-marker shapes never dispatch", () => {
		// Jupyter cell magics (%%), Erlang %% comments, and PostScript DSC
		// lines all double the sigil - the second sigil is itself the
		// protection, since "%verb" cannot start with another "%".
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL}${COMMAND_SIGIL}help`)), undefined);
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL}${COMMAND_SIGIL}text`)), undefined);
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL}${COMMAND_SIGIL}cache`)), undefined);
	});

	test("sigil-prefixed non-verbs are ordinary text: percent-encoded, batch-variable, printf, strftime shapes", () => {
		// URL-encoding, Windows batch variables, printf conversions, and
		// strftime formats all start lines with the sigil; none name a verb.
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL}20foo`)), undefined);
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL}PATH${COMMAND_SIGIL}`)), undefined);
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL}s`)), undefined);
		assert.strictEqual(
			dispatchCommand(makeContext(`${COMMAND_SIGIL}Y-${COMMAND_SIGIL}m-${COMMAND_SIGIL}d`)),
			undefined
		);
	});

	test("trimEnd regression guard: a space after the sigil is plain text, never a command", () => {
		// THE pin a future "be more lenient" refactor would silently undo:
		// %-comment languages (MATLAB, LaTeX, Erlang, csh transcripts) write
		// "% word" and "% word: args" at line start. Under full trim(),
		// "% error: 429" once returned a real HTTP 429 that looked like a
		// genuine proxy failure; under trimEnd() the comment class falls
		// through to the fallback, which itself points at the help command.
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL} help`)), undefined);
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL} image`)), undefined);
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL} error: 429`)), undefined);
	});

	test("case-insensitivity and trailing tolerance survive the hardening", () => {
		assert.ok(runText(`${COMMAND_SIGIL}HELP`)?.includes(`${COMMAND_SIGIL}help`), "%HELP dispatches");
		assert.ok(
			runText(`${COMMAND_SIGIL}help `)?.includes(`${COMMAND_SIGIL}help`),
			"trailing space after the verb is fine"
		);
	});

	test("multi-word %-comment lines are ordinary text", () => {
		// The comment corpus stays safe via the internal space even where the
		// first word happens to be a verb.
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL} TODO: fix this`)), undefined);
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL} Error handling below`)), undefined);
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL} echo hello`)), undefined);
	});

	test("known-benign keyword collisions dispatch by design: the bare text verb yields the diagnostic", () => {
		// %text (Zeppelin's display system) and %help (Metakernel's line magic)
		// are the two known real-world line-start collisions that ARE verbs;
		// both are accepted by design - the reply is an obvious fake-model
		// diagnostic or the help text, never a confusing stream shape.
		const text = runText(`${COMMAND_SIGIL}text`);
		assert.ok(text?.startsWith(`Bad arguments for ${COMMAND_SIGIL}text`), `got: ${text}`);
	});

	test("leading whitespace disqualifies the line: the sigil must be its first byte", () => {
		assert.strictEqual(dispatchCommand(makeContext(` ${COMMAND_SIGIL}help`)), undefined);
		assert.strictEqual(dispatchCommand(makeContext(`\t${COMMAND_SIGIL}echo:x`)), undefined);
	});

	test("echo keeps trailing bytes after the colon", () => {
		assert.strictEqual(runText(`${COMMAND_SIGIL}echo:kept   `), "kept   ");
	});

	test("echo of a single space echoes the space", () => {
		assert.strictEqual(runText(`${COMMAND_SIGIL}echo: `), " ");
	});

	test("only the LAST non-empty line counts: mid-message commands are ignored", () => {
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL}echo:first\nmore prose after it`)), undefined);
	});

	test("multiple command-looking lines: the final one dispatches", () => {
		assert.strictEqual(runText(`${COMMAND_SIGIL}echo:first\n${COMMAND_SIGIL}echo:second`), "second");
	});

	test("command-looking lines inside earlier pasted context are ignored", () => {
		const pasted = `\`\`\`\n${COMMAND_SIGIL}help\n${COMMAND_SIGIL}error:500\n\`\`\`\nwhat does this code do?`;
		assert.strictEqual(dispatchCommand(makeContext(pasted)), undefined);
	});

	test("trailing blank lines do not hide the command", () => {
		assert.strictEqual(runText(`${COMMAND_SIGIL}echo:kept\n\n  \n`), "kept");
	});

	test("a trailing carriage return is stripped before matching", () => {
		assert.strictEqual(runText(`first line\r\n${COMMAND_SIGIL}echo:crlf\r\n`), "crlf");
	});

	test("the verb matches case-insensitively; the argument preserves case", () => {
		assert.strictEqual(runText(`${COMMAND_SIGIL}EcHo:CaSe Preserved`), "CaSe Preserved");
	});

	test("echo is byte-exact after the delimiting colon", () => {
		assert.strictEqual(runText(`${COMMAND_SIGIL}echo: leading and internal  spaces`), " leading and internal  spaces");
	});

	test("an unknown verb is not a command", () => {
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL}frobnicate:1`)), undefined);
	});

	test("a verb with trailing prose is not a command", () => {
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL}help me with this`)), undefined);
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
							{ type: "text", text: `${COMMAND_SIGIL}echo:parts` },
						],
					},
					{ role: "assistant", content: `${COMMAND_SIGIL}echo:assistant text never dispatches` },
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
		[`${COMMAND_SIGIL}stream:0`, "zero count"],
		[`${COMMAND_SIGIL}stream:-3`, "negative count"],
		[`${COMMAND_SIGIL}stream:2.5`, "fractional count"],
		[`${COMMAND_SIGIL}stream:`, "empty arg"],
		[`${COMMAND_SIGIL}stream:5:10:9`, "extra separator"],
		[`${COMMAND_SIGIL}stream:501`, "over the chunk cap"],
		[`${COMMAND_SIGIL}stream:5:5001`, "over the delay cap"],
		[`${COMMAND_SIGIL}text:0`, "zero word count"],
		[`${COMMAND_SIGIL}text:5001`, "over the word cap"],
		[`${COMMAND_SIGIL}text:5:4294967296`, "seed over the 32-bit domain"],
		[`${COMMAND_SIGIL}think:0`, "zero steps"],
		[`${COMMAND_SIGIL}think:101`, "over the step cap"],
		[`${COMMAND_SIGIL}delay:0`, "zero delay"],
		[`${COMMAND_SIGIL}delay:60001`, "over the delay cap"],
		[`${COMMAND_SIGIL}error:999`, "status outside the valid set"],
		[`${COMMAND_SIGIL}echo:`, "empty echo argument"],
		[`${COMMAND_SIGIL}echo`, "bare echo without a colon"],
		[`${COMMAND_SIGIL}tool`, "bare tool without a colon"],
		[`${COMMAND_SIGIL}play`, "bare play without a colon"],
		[`${COMMAND_SIGIL}stream:5:0`, "zero per-chunk delay"],
		[`${COMMAND_SIGIL}error:teapot`, "non-numeric status"],
		[`${COMMAND_SIGIL}finish:stop`, "unsupported finish reason"],
		[`${COMMAND_SIGIL}help:extra`, "bare command with an argument"],
		[`${COMMAND_SIGIL}params:x`, "bare command with an argument"],
	];
	for (const [input, label] of diagnosticCases) {
		test(`${label} (${input}) yields the fixed diagnostic text, never an HTTP error`, () => {
			const result = dispatchCommand(makeContext(input));
			assert.ok(result, `${input} must still be recognized`);
			assert.strictEqual(result.scenario.type, "sse", `${input} must reply as text`);
			const text = runText(input);
			assert.ok(text?.startsWith(`Bad arguments for ${COMMAND_SIGIL}`), `got: ${text}`);
			assert.ok(text?.includes("Usage:"), "the diagnostic points at usage");
		});
	}

	test("numeric arguments tolerate surrounding whitespace", () => {
		const result = dispatchCommand(makeContext(`${COMMAND_SIGIL}text: 12 `));
		assert.ok(result);
		assert.ok(!runText(`${COMMAND_SIGIL}text: 12 `)?.startsWith("Bad arguments"));
	});

	test(`the ${COMMAND_SIGIL}text seed is 0-based`, () => {
		const zeroSeed = runText(`${COMMAND_SIGIL}text:5:0`);
		assert.ok(zeroSeed && !zeroSeed.startsWith("Bad arguments"));
		assert.strictEqual(zeroSeed.trim().split(/\s+/).length, 5);
	});

	test(`${COMMAND_SIGIL}error with a valid status produces that HTTP error scenario`, () => {
		const result = dispatchCommand(makeContext(`${COMMAND_SIGIL}error:429`));
		assert.ok(result);
		assert.deepStrictEqual(
			{ type: result.scenario.type, statusCode: (result.scenario as { statusCode: number }).statusCode },
			{ type: "error", statusCode: 429 }
		);
	});
});

suite("fakeStack commands: behavior", () => {
	test("help lists every command usage and the play targets", () => {
		const text = runText(`${COMMAND_SIGIL}help`);
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
		assert.strictEqual(serialize(`${COMMAND_SIGIL}text:40`), serialize(`${COMMAND_SIGIL}text:40`));
		assert.deepStrictEqual(
			dispatchCommand(makeContext(`${COMMAND_SIGIL}help`)),
			dispatchCommand(makeContext(`${COMMAND_SIGIL}help`))
		);
	});

	test("the envelope id hashes the full request: a non-message field changes it", () => {
		const idOf = (extra: Record<string, unknown>): string => {
			const result = dispatchCommand(makeContext(`${COMMAND_SIGIL}echo:same`, extra));
			assert.ok(result && result.scenario.type === "sse");
			return (result.scenario.chunks[0] as { id: string }).id;
		};
		assert.strictEqual(idOf({ temperature: 0.2 }), idOf({ temperature: 0.2 }));
		assert.notStrictEqual(idOf({ temperature: 0.2 }), idOf({ temperature: 0.7 }));
	});

	test("every chunk envelope carries service_tier", () => {
		const result = dispatchCommand(makeContext(`${COMMAND_SIGIL}echo:tiered`));
		assert.ok(result && result.scenario.type === "sse");
		for (const chunk of result.scenario.chunks) {
			assert.strictEqual((chunk as { service_tier?: string }).service_tier, "default");
		}
	});

	test("the usage trailer appears only when stream_options.include_usage asks for it", () => {
		const usageChunks = (extra: Record<string, unknown>): number => {
			const result = dispatchCommand(makeContext(`${COMMAND_SIGIL}echo:gated`, extra));
			assert.ok(result && result.scenario.type === "sse");
			return result.scenario.chunks.filter((chunk) => (chunk as { usage?: unknown }).usage !== undefined).length;
		};
		assert.strictEqual(usageChunks({}), 0, "no stream_options, no trailer");
		assert.strictEqual(usageChunks({ stream_options: { include_usage: true } }), 1);
	});

	test(`${COMMAND_SIGIL}stream's trailer carries both token-detail objects`, () => {
		const result = dispatchCommand(
			makeContext(`${COMMAND_SIGIL}stream:3`, { stream_options: { include_usage: true } })
		);
		assert.ok(result && result.scenario.type === "sse-delayed");
		const trailer = result.scenario.chunks[result.scenario.chunks.length - 1] as {
			usage?: { prompt_tokens_details?: unknown; completion_tokens_details?: unknown };
		};
		assert.ok(trailer.usage, `${COMMAND_SIGIL}stream emits the trailer like every textual reply`);
		assert.ok(trailer.usage.prompt_tokens_details, "prompt_tokens_details present");
		assert.ok(trailer.usage.completion_tokens_details, "completion_tokens_details present");
	});

	test(`${COMMAND_SIGIL}image and ${COMMAND_SIGIL}audio emit byte-stable payloads matching the exported pinned hashes`, () => {
		// The reply text derives its sha256 from the actual bytes, so this
		// keeps the exported literals honest against the byte constants.
		assert.ok(runText(`${COMMAND_SIGIL}image`)?.includes(`sha256=${PNG_SHA256}`));
		assert.ok(runText(`${COMMAND_SIGIL}audio`)?.includes(`sha256=${WAV_SHA256}`));
	});

	test(`different conversations draw different default ${COMMAND_SIGIL}text seeds`, () => {
		assert.notStrictEqual(runText(`${COMMAND_SIGIL}text:40`), runText(`a different prefix\n${COMMAND_SIGIL}text:40`));
	});

	test(`an explicit seed pins ${COMMAND_SIGIL}text output across conversations`, () => {
		assert.strictEqual(
			runText(`prefix one\n${COMMAND_SIGIL}text:12:7`),
			runText(`another prefix\n${COMMAND_SIGIL}text:12:7`)
		);
	});

	test(`${COMMAND_SIGIL}text produces exactly n words`, () => {
		const text = runText(`${COMMAND_SIGIL}text:25:3`);
		assert.strictEqual(text?.trim().split(/\s+/).length, 25);
	});

	test(`${COMMAND_SIGIL}play plays the named scenario verbatim`, () => {
		const result = dispatchCommand(makeContext(`${COMMAND_SIGIL}play:parallel-tool-calls`));
		assert.deepStrictEqual(result?.scenario, BUILTIN_SCENARIOS["parallel-tool-calls"]);
	});

	test(`${COMMAND_SIGIL}play with an unknown name yields the fixed diagnostic pointing at ${COMMAND_SIGIL}help`, () => {
		const text = runText(`${COMMAND_SIGIL}play:nope`);
		assert.ok(text?.includes('Unknown scenario "nope"'));
		assert.ok(text?.includes(`${COMMAND_SIGIL}help`));
	});

	test(`${COMMAND_SIGIL}stream emits n content chunks under an sse-delayed scenario`, () => {
		const result = dispatchCommand(makeContext(`${COMMAND_SIGIL}stream:5:50`));
		assert.ok(result && result.scenario.type === "sse-delayed");
		assert.strictEqual(result.scenario.delayMs, 50);
		const text = collapseChunks(result.scenario.chunks) as { choices: Array<{ message: { content: string } }> };
		assert.strictEqual(text.choices[0]?.message.content, "chunk1 chunk2 chunk3 chunk4 chunk5 ");
	});

	test(`${COMMAND_SIGIL}delay carries the first-byte delay alongside a text scenario`, () => {
		const result = dispatchCommand(makeContext(`${COMMAND_SIGIL}delay:1500`));
		assert.strictEqual(result?.firstByteDelayMs, 1500);
		assert.strictEqual(result?.scenario.type, "sse");
	});

	test(`${COMMAND_SIGIL}finish ends with the requested finish_reason`, () => {
		const result = dispatchCommand(makeContext(`${COMMAND_SIGIL}finish:length`));
		assert.ok(result && result.scenario.type === "sse");
		const collapsed = collapseChunks(result.scenario.chunks) as { choices: Array<{ finish_reason: string }> };
		assert.strictEqual(collapsed.choices[0]?.finish_reason, "length");
	});

	test("two cuttable pieces yield exactly two content deltas", () => {
		const result = dispatchCommand(makeContext(`${COMMAND_SIGIL}echo:ab cd`));
		assert.ok(result && result.scenario.type === "sse");
		const contentDeltas = result.scenario.chunks
			.map((chunk) => (chunk as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content)
			.filter((content): content is string => typeof content === "string");
		assert.deepStrictEqual(contentDeltas, ["ab ", "cd"]);
	});

	test(`a malformed percent-escape in a data URL never throws: ${COMMAND_SIGIL}attachments hashes the raw URL`, () => {
		const context: CommandContext = {
			request: {
				model: "text-only",
				messages: [
					{
						role: "user",
						content: [
							{ type: "image_url", image_url: { url: "data:image/svg+xml,%zz-not-percent-encoded" } },
							{ type: "text", text: `${COMMAND_SIGIL}attachments` },
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

	test("fallback, usage, and help strings all carry the live sigil", () => {
		// Runtime consistency, not source-level derivation: whatever byte the
		// sigil is, the user-facing strings must present that same byte.
		assert.strictEqual(COMMAND_SIGIL.length, 1, "the sigil is a single byte");
		assert.ok(FALLBACK_TEXT.includes(`${COMMAND_SIGIL}help`), "the fallback names the sigil-derived help command");
		for (const command of COMMANDS) {
			assert.ok(
				command.usage.startsWith(`${COMMAND_SIGIL}${command.verb}`),
				`usage for ${command.verb} must interpolate the sigil, got "${command.usage}"`
			);
		}
	});
});

suite("fakeStack commands: tool flow", () => {
	const tools = [
		{ type: "function", function: { name: "get_weather", description: "Get the weather" } },
		{ type: "function", function: { name: "run_query", description: "Run a query" } },
	];

	test("a call turn emits one tool call with a deterministic id", () => {
		const result = dispatchCommand(makeContext(`${COMMAND_SIGIL}tool:get_weather {"location":"Paris"}`, { tools }));
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
					{ role: "user", content: `${COMMAND_SIGIL}tool:get_weather` },
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
					{ role: "user", content: `${COMMAND_SIGIL}tool:get_weather` },
					{ role: "assistant", content: null },
					{ role: "tool", content: "first result" },
					{ role: "user", content: `${COMMAND_SIGIL}tool:run_query` },
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
		const text = runText(`${COMMAND_SIGIL}tool:not_offered`, { tools });
		assert.ok(text?.includes('The tool "not_offered" is not offered'));
	});

	test("malformed JSON args yield a fixed text reply", () => {
		const text = runText(`${COMMAND_SIGIL}tool:get_weather {"broken`, { tools });
		assert.ok(text?.includes("not valid JSON"));
	});

	test("tool JSON args over 16 KiB yield the fixed diagnostic", () => {
		const oversized = `{"pad":"${"x".repeat(17 * 1024)}"}`;
		const text = runText(`${COMMAND_SIGIL}tool:get_weather ${oversized}`, { tools });
		assert.ok(text?.startsWith(`Bad arguments for ${COMMAND_SIGIL}tool`), `got: ${text?.slice(0, 80)}`);
	});
});

suite("fakeStack commands: docs drift guard", () => {
	// README and AGENTS.md cannot import COMMAND_SIGIL, so this suite turns
	// the two prose copies of the grammar into CI-enforced mirrors: verb
	// coverage and the sigil byte are pinned; the surrounding sentences stay
	// free to change. Tests run from out/test/fakeStack, so the repo root is
	// three levels up.
	const repoRoot = path.resolve(__dirname, "..", "..", "..");
	const sigilPattern = COMMAND_SIGIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	/**
	 * The cheat-sheet rows: the fenced block containing a line that opens with
	 * the help command, reduced to its sigil-leading lines. The first line of
	 * each raw block is the fence info string (```text) or the empty remainder
	 * of the bare ``` line, so it is always dropped; blank, grouping, and
	 * comment lines inside the fence are tolerated as non-rows.
	 */
	function cheatSheetRows(): string[] {
		const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
		const fence = readme
			.split("```")
			.map((block) => block.split("\n").slice(1))
			.find((lines) => lines.some((line) => line.startsWith(`${COMMAND_SIGIL}help`)));
		assert.ok(fence, `README.md has no fenced block with a ${COMMAND_SIGIL}help row`);
		return fence.filter((line) => line.startsWith(COMMAND_SIGIL));
	}

	test("the README cheat sheet's command column names exactly the dispatch table's verbs", () => {
		// Verbs are read from each row's COMMAND COLUMN (before the 2+ space
		// gap), never from description text - a missing command row must not
		// be masked by a mention of its verb inside another row's description.
		const verbPattern = new RegExp(`^${sigilPattern}([a-z]+)`);
		const mentioned = new Set<string>();
		for (const row of cheatSheetRows()) {
			const column = row.split(/\s{2,}/)[0] ?? "";
			for (const token of column.split(",").map((entry) => entry.trim())) {
				const match = verbPattern.exec(token);
				assert.ok(match, `command-column tokens lead with the sigil and a verb; got "${token}" in row "${row}"`);
				mentioned.add(match[1] as string);
			}
		}
		const declared = new Set(COMMANDS.map((command) => command.verb));
		assert.deepStrictEqual([...mentioned].sort(), [...declared].sort(), "cheat-sheet rows mirror the dispatch table");
	});

	test("the AGENTS.md grammar mention uses the live sigil", () => {
		const agents = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
		assert.ok(agents.includes(`${COMMAND_SIGIL}play:<name>`), "AGENTS.md points at the sigil-derived play command");
	});
});
