/**
 * The quick-fix feature's two participant commands. What is worth pinning here
 * is not the prose but the shape: both are prompt-shaping commands, so the
 * user's own words survive, the turn's attachments arrive with them, and the
 * instruction leads - the properties that make "@litellm /fix Cannot find name
 * 'x'" reach the model as a question about the attached code rather than as
 * three words with no code behind them.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../../../extension/features/participant/historyConversion";
import type { SlashCommand, SlashCommandTurn } from "../../../../extension/features/participant/slashCommands";
import { createSlashCommandRegistry } from "../../../../extension/features/participant/slashCommands";
import {
	EXPLAIN_INSTRUCTION,
	FIX_INSTRUCTION,
	quickFixSlashCommands,
	registerQuickFixSlashCommands,
} from "../../../../extension/features/quickFixChatCommands";

/** A turn that records what was sent instead of sending it. */
function fakeTurn(overrides: Partial<SlashCommandTurn> = {}): {
	turn: SlashCommandTurn;
	sent: readonly ChatMessage[][];
} {
	const sent: ChatMessage[][] = [];
	const turn: SlashCommandTurn = {
		prompt: "",
		attachments: () => Promise.resolve([]),
		history: [],
		snapshots: () => [],
		report: () => {},
		send: (messages) => {
			sent.push([...messages]);
			return Promise.resolve();
		},
		...overrides,
	};
	return { turn, sent };
}

function commandNamed(name: string): SlashCommand {
	const found = quickFixSlashCommands().find((command) => command.name === name);
	expect(found, `no /${name} command`).toBeDefined();
	return found as SlashCommand;
}

describe("extension/features quickFixChatCommands", () => {
	test("exactly /fix and /explain, each with a description", () => {
		const commands = quickFixSlashCommands();
		expect(commands.map((command) => command.name)).toEqual(["fix", "explain"]);
		for (const command of commands) {
			expect(command.description.trim()).not.toBe("");
		}
	});

	test("a fresh array per call, so no caller can mutate another's view", () => {
		const first = quickFixSlashCommands();
		first.length = 0;
		expect(quickFixSlashCommands()).toHaveLength(2);
	});

	test("/fix sends the instruction, then the user's words, then the attached code", async () => {
		const { turn, sent } = fakeTurn({
			prompt: "Cannot find name 'total'.",
			attachments: () => Promise.resolve([{ name: "src/sum.ts", content: "return total;" }]),
		});
		await commandNamed("fix").run(turn);
		expect(sent).toHaveLength(1);
		const content = sent[0]?.[0]?.content ?? "";
		expect(content.startsWith(FIX_INSTRUCTION)).toBe(true);
		expect(content).toContain("Cannot find name 'total'.");
		// Without this the command reaches the model with the diagnostic text and
		// no code at all, which is the whole failure the attachments seam exists
		// to prevent.
		expect(content).toContain("return total;");
	});

	test("/explain asks for an explanation rather than a rewrite", async () => {
		const { turn, sent } = fakeTurn({ prompt: "why?" });
		await commandNamed("explain").run(turn);
		expect(sent[0]?.[0]?.content.startsWith(EXPLAIN_INSTRUCTION)).toBe(true);
		expect(FIX_INSTRUCTION).not.toBe(EXPLAIN_INSTRUCTION);
	});

	test("history rides along ahead of the new message", async () => {
		const history: ChatMessage[] = [
			{ role: "user", content: "earlier question" },
			{ role: "assistant", content: "earlier answer" },
		];
		const { turn, sent } = fakeTurn({ prompt: "and this one", history });
		await commandNamed("fix").run(turn);
		expect(sent[0]?.slice(0, 2)).toEqual(history);
		expect(sent[0]).toHaveLength(3);
		expect(sent[0]?.[2]?.role).toBe("user");
	});

	test("an empty prompt still sends the instruction, so the lightbulb's attachment-only turn works", async () => {
		const { turn, sent } = fakeTurn({
			prompt: "   ",
			attachments: () => Promise.resolve([{ name: "src/sum.ts", content: "return total;" }]),
		});
		await commandNamed("fix").run(turn);
		expect(sent[0]?.[0]?.content).toContain("return total;");
	});

	test("registration adds both to a live table, and a second registration is refused", () => {
		const registry = createSlashCommandRegistry([]);
		registerQuickFixSlashCommands(registry);
		expect(registry.list().map((command) => command.name)).toEqual(["fix", "explain"]);
		// A silently shadowed command is a routing bug, not a preference.
		expect(() => {
			registerQuickFixSlashCommands(registry);
		}).toThrow();
	});
});
