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
import { FAKE_MODELS } from "./models";

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

	test("a chat host's request envelope is transparent: the closing tag does not eat the command", () => {
		// The exact shape Copilot Chat sends (observed via /_test/last-request):
		// context and reminder blocks, then the typed text inside <userRequest>.
		const copilotShape = [
			"<context>",
			"The current date is 2026-07-28.",
			"</context>",
			"<reminderInstructions>",
			"Prefer the replace_string_in_file tool.",
			"</reminderInstructions>",
			"<userRequest>",
			`${COMMAND_SIGIL}echo:through-the-envelope`,
			"</userRequest>",
			"",
		].join("\n");
		assert.strictEqual(runText(copilotShape), "through-the-envelope");
		// A run of trailing closers is skipped as a whole.
		assert.strictEqual(runText(`${COMMAND_SIGIL}echo:nested\n</inner>\n</outer>`), "nested");
	});

	test("an INDENTED closing tag is not transparent: pasted markup stays plain text", () => {
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL}help\n  </userRequest>`)), undefined);
	});

	test("only EXACT bare closers are transparent: trailing space or a namespaced tag stays opaque", () => {
		// The opacity boundary a future "be more lenient" refactor would erode:
		// anything beyond a bare </name> line must keep blocking recognition.
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL}help\n</userRequest> `)), undefined);
		assert.strictEqual(dispatchCommand(makeContext(`${COMMAND_SIGIL}help\n</ns:tag>`)), undefined);
	});

	test("a message of only closing tags is plain text", () => {
		assert.strictEqual(dispatchCommand(makeContext("</a>\n</b>")), undefined);
	});

	test("an inline single-line wrap is plain text: the line must start with the sigil", () => {
		assert.strictEqual(dispatchCommand(makeContext(`<userRequest>${COMMAND_SIGIL}help</userRequest>`)), undefined);
	});

	test("pasted markup whose interior line is prose still falls back", () => {
		assert.strictEqual(dispatchCommand(makeContext("some closing text\n</div>")), undefined);
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
		[`${COMMAND_SIGIL}echon:`, "empty echon argument"],
		[`${COMMAND_SIGIL}echon`, "bare echon without a colon"],
		[`${COMMAND_SIGIL}tool`, "bare tool without a colon"],
		[`${COMMAND_SIGIL}play`, "bare play without a colon"],
		[`${COMMAND_SIGIL}stream:5:0`, "zero per-chunk delay"],
		[`${COMMAND_SIGIL}error:teapot`, "non-numeric status"],
		[`${COMMAND_SIGIL}finish:stop`, "unsupported finish reason"],
		[`${COMMAND_SIGIL}help:extra`, "bare command with an argument"],
		[`${COMMAND_SIGIL}params:x`, "bare command with an argument"],
		[`${COMMAND_SIGIL}abort:0`, "zero abort count"],
		[`${COMMAND_SIGIL}abort:501`, "abort count over the chunk cap"],
		[`${COMMAND_SIGIL}abort`, "bare abort without a colon"],
		[`${COMMAND_SIGIL}nodone:0`, "zero nodone count"],
		[`${COMMAND_SIGIL}nodone:2.5`, "fractional nodone count"],
		[`${COMMAND_SIGIL}nodone`, "bare nodone without a colon"],
		[`${COMMAND_SIGIL}stall:0`, "zero stall count"],
		[`${COMMAND_SIGIL}stall:3:0`, "zero stall duration"],
		[`${COMMAND_SIGIL}stall:3:60001`, "stall duration over the cap"],
		[`${COMMAND_SIGIL}stall:3:10:9`, "extra stall separator"],
		[`${COMMAND_SIGIL}stall`, "bare stall without a colon"],
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
	test("help renders a bullet per command and a backticked play-target section", () => {
		// The report shape is markdown on purpose: chat hosts render replies as
		// markdown, where single newlines collapse - bullets keep the lines.
		const text = runText(`${COMMAND_SIGIL}help`);
		assert.ok(text);
		assert.ok(text.startsWith("Commands:\n\n- "), "the Commands section opens the report and leads its bullet list");
		for (const command of COMMANDS) {
			assert.ok(
				text.includes(`- \`${command.usage}\` - ${command.description}`),
				`help must render a bullet for ${command.usage}`
			);
		}
		assert.ok(text.includes("\n\nPlay targets: "), "a blank line separates the play-target section");
		assert.ok(text.includes("`text-only`"), "play targets are backticked scenario names");
		// One hand-typed literal alongside the derived loop: the loop pins the
		// bullet FORMAT from the table, so a description edit would slide
		// through it - this line byte-anchors one full bullet on purpose.
		assert.ok(
			text.includes("- `%help` - list every command and the available %play scenarios"),
			"the help entry's exact bullet bytes are pinned"
		);
	});

	test("introspection reports bullet each fact with variable data in code spans", () => {
		assert.strictEqual(runText(`${COMMAND_SIGIL}deployment`), "- deployment: `text-only`");
		const command = `${COMMAND_SIGIL}messages`;
		assert.strictEqual(runText(command), `- \`message[0] user: text(${command.length})\``);
		assert.strictEqual(
			runText(`${COMMAND_SIGIL}params`, { temperature: 0.4, seed: 11 }),
			['- model: `"text-only"`', "- seed: `11`", "- stream: `true`", "- temperature: `0.4`"].join("\n")
		);
	});

	test(`${COMMAND_SIGIL}cache bullets marker positions, then the total paragraph after a blank line`, () => {
		// The total is a plain paragraph: a bullet there would make CommonMark
		// read the marker list as loose and space every bullet apart.
		const text = runText(`${COMMAND_SIGIL}cache`, {
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
				{ role: "user", content: `${COMMAND_SIGIL}cache` },
			],
		});
		assert.strictEqual(text, "- `messages[0].content[0]: cache_control`\n\ntotal: 1");
	});

	test("report code spans neutralize content-derived markdown: emphasis, backticks, and newlines stay inert", () => {
		// The injection guard: a tool description containing "*", "`", or a
		// newline must not style the report, close its code span early, or
		// break out of the bullet into real markdown structure. Backticks get
		// a wider, space-padded span (CommonMark's escape), newlines collapse
		// to spaces, and empty values render as the fixed (empty) token.
		const tools = [
			{ type: "function", function: { name: "starry", description: "*not italic* in the report" } },
			{ type: "function", function: { name: "ticked", description: "has a `code span` inside" } },
			{ type: "function", function: { name: "sneaky", description: "line one\n\n# injected heading" } },
			{ type: "function", function: { name: "bare" } },
			{ type: "function", function: { name: "", description: "nameless" } },
		];
		assert.strictEqual(
			runText(`${COMMAND_SIGIL}tools`, { tools }),
			[
				"- `starry`: `*not italic* in the report`",
				"- `ticked`: `` has a `code span` inside ``",
				"- `sneaky`: `line one  # injected heading`",
				"- `bare`: `(empty)`",
				"- `(empty)`: `nameless`",
			].join("\n")
		);
	});

	test("the zero-case sentences are pinned single sentences, not bullets", () => {
		// The empty-request shapes cannot dispatch through the chat input (the
		// command line is itself a message with content), so these runs call
		// the COMMANDS entries directly - the sentences are each command's
		// defensive floor and would otherwise rot unpinned.
		const runVerb = (verb: string, request: Record<string, unknown>): string | undefined => {
			const command = COMMANDS.find((entry) => entry.verb === verb);
			assert.ok(command, `${verb} is in the dispatch table`);
			const result = command.run(undefined, { request, scenarios });
			assert.strictEqual(result.scenario.type, "sse");
			const collapsed = collapseChunks((result.scenario as { chunks: unknown[] }).chunks);
			return (collapsed.choices as Array<{ message: { content: string } }>)[0]?.message.content;
		};
		assert.strictEqual(runVerb("messages", {}), "no messages received");
		assert.strictEqual(runVerb("attachments", { messages: [{ role: "assistant" }] }), "no message parts received");
		assert.strictEqual(runVerb("params", {}), "no generation parameters received");
	});

	test("the dispatch table holds exactly the specified verb set", () => {
		// An independent literal list, not derived from the implementation: a
		// verb added or dropped in commands.ts must fail here first.
		const expected = [
			"abort",
			"attachments",
			"audio",
			"cache",
			"delay",
			"deployment",
			"echo",
			"echon",
			"error",
			"finish",
			"help",
			"image",
			"messages",
			"nodone",
			"params",
			"play",
			"stall",
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

	// The transport verbs deliberately emit NO finish_reason chunk and no usage
	// trailer: the point is a stream that never completes, so a well-formed
	// ending would defeat the scenario.
	suite("transport verbs build sse-abort scenarios", () => {
		/** Dispatch a transport verb and narrow to its sse-abort scenario. */
		function abortScenario(input: string): { chunks: unknown[]; tail: string; stallMs?: number } {
			const result = dispatchCommand(makeContext(input));
			assert.ok(result, `${input} must dispatch`);
			assert.strictEqual(result.scenario.type, "sse-abort", `${input} must build an sse-abort scenario`);
			return result.scenario as { chunks: unknown[]; tail: string; stallMs?: number };
		}

		function contentOf(chunks: unknown[]): string {
			const collapsed = collapseChunks(chunks) as { choices: Array<{ message: { content: string } }> };
			return collapsed.choices[0]?.message.content ?? "";
		}

		test(`${COMMAND_SIGIL}abort:<n> emits n numbered chunks then the destroy tail`, () => {
			const scenario = abortScenario(`${COMMAND_SIGIL}abort:3`);
			assert.strictEqual(scenario.tail, "destroy");
			assert.strictEqual(scenario.chunks.length, 3, "content chunks only, no finish or usage chunk");
			assert.strictEqual(contentOf(scenario.chunks), "chunk1 chunk2 chunk3 ");
		});

		test(`${COMMAND_SIGIL}nodone:<n> emits n numbered chunks then the no-done tail`, () => {
			const scenario = abortScenario(`${COMMAND_SIGIL}nodone:5`);
			assert.strictEqual(scenario.tail, "no-done");
			assert.strictEqual(scenario.chunks.length, 5);
			assert.strictEqual(contentOf(scenario.chunks), "chunk1 chunk2 chunk3 chunk4 chunk5 ");
		});

		test(`${COMMAND_SIGIL}stall:<n>:<ms> emits n numbered chunks then the stall tail with that duration`, () => {
			const scenario = abortScenario(`${COMMAND_SIGIL}stall:2:30000`);
			assert.strictEqual(scenario.tail, "stall");
			assert.strictEqual(scenario.stallMs, 30000);
			assert.strictEqual(contentOf(scenario.chunks), "chunk1 chunk2 ");
		});

		test(`${COMMAND_SIGIL}stall without a duration defaults to 10000ms`, () => {
			assert.strictEqual(abortScenario(`${COMMAND_SIGIL}stall:1`).stallMs, 10000);
		});

		test("no finish_reason appears in any transport-verb chunk", () => {
			for (const input of [`${COMMAND_SIGIL}abort:2`, `${COMMAND_SIGIL}nodone:2`, `${COMMAND_SIGIL}stall:2`]) {
				const scenario = abortScenario(input);
				for (const chunk of scenario.chunks) {
					const finish = (chunk as { choices?: Array<{ finish_reason?: unknown }> }).choices?.[0]?.finish_reason;
					assert.strictEqual(finish, undefined, `${input} must not carry a finish_reason`);
				}
			}
		});

		test("transport-verb chunks carry the standard envelope", () => {
			const scenario = abortScenario(`${COMMAND_SIGIL}abort:2`);
			for (const chunk of scenario.chunks) {
				const envelope = chunk as { object?: string; service_tier?: string };
				assert.strictEqual(envelope.object, "chat.completion.chunk");
				assert.strictEqual(envelope.service_tier, "default");
			}
		});
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

	test(`${COMMAND_SIGIL}echon decodes exactly two escapes into a multi-line reply; ${COMMAND_SIGIL}echo stays untouched`, () => {
		// The single-line input grammar cannot carry a real newline, so %echon
		// decodes "\n"; "\\" keeps a literal backslash-n expressible. %echo is
		// the byte-exact oracle and must never gain this interpretation.
		assert.strictEqual(runText(`${COMMAND_SIGIL}echon:a\\nb`), "a\nb", "backslash-n becomes a newline");
		assert.strictEqual(runText(`${COMMAND_SIGIL}echon:a\\n\\nb`), "a\n\nb", "doubled escape yields a blank line");
		assert.strictEqual(runText(`${COMMAND_SIGIL}echon:a\\\\nb`), "a\\nb", "escaped backslash keeps a literal \\n");
		assert.strictEqual(runText(`${COMMAND_SIGIL}echon:trailing\\n`), "trailing\n", "a trailing escape decodes too");
		assert.strictEqual(
			runText(`${COMMAND_SIGIL}echon: kept  \\x bytes `),
			" kept  \\x bytes ",
			"escape-free input (unknown escapes included) passes through byte-exact"
		);
		assert.strictEqual(runText(`${COMMAND_SIGIL}echo:a\\nb`), "a\\nb", "%echo never decodes");
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
		// Record bullets keep the record's bytes verbatim inside ONE code span,
		// so the sha256 stays a bare hex token extractable by regex.
		assert.match(text, /^- `message\[0\] user part\[0\]: kind=image_url mime=- bytes=\d+ sha256=[0-9a-f]{64}`$/m);
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

	test("the README model-list paragraph names exactly the catalog's aliases", () => {
		// The paragraph hand-writes every alias in backticks, including the
		// blocked gpt-4-turbo (whose absence from the picker is itself under
		// test). Alias-shaped backtick tokens are compared bidirectionally
		// against FAKE_MODELS, so a catalog rename, addition, or removal fails
		// here instead of leaving the doc naming a model the stack no longer
		// serves. Non-alias tokens in the paragraph (file paths, commands) do
		// not match the alias shape and stay free to change.
		const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
		const paragraph = readme.split("\n").find((line) => line.startsWith("The model list is deliberately small"));
		assert.ok(paragraph, "README.md keeps the fake-stack model-list paragraph");
		// Alias-shaped: the catalog's charset PLUS at least one dash or
		// dot-digit, so a plain backticked word in the paragraph (`bun`, a
		// shortened `models.ts`) cannot become a phantom alias. The self-check
		// keeps the shape in sync with the catalog: an alias the shape cannot
		// capture would otherwise fail the bidirectional compare confusingly.
		const aliasShape = /^(?=.*(?:-|\.\d))[a-z0-9][a-z0-9.-]*$/;
		const declared = FAKE_MODELS.map((model) => model.alias);
		for (const alias of declared) {
			assert.ok(aliasShape.test(alias), `catalog alias "${alias}" escapes the guard's token shape; widen aliasShape`);
		}
		const mentioned = [...paragraph.matchAll(/`([^`]+)`/g)]
			.map((match) => match[1] as string)
			.filter((token) => aliasShape.test(token));
		assert.ok(declared.length >= 2, `FAKE_MODELS keeps a multi-model catalog (found ${declared.length} aliases)`);
		assert.deepStrictEqual(
			[...new Set(mentioned)].sort(),
			[...declared].sort(),
			"the README paragraph mirrors the FAKE_MODELS aliases"
		);
	});
});
