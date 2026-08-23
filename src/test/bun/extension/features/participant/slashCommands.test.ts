import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../../../../extension/features/participant/historyConversion";
import {
	builtinSlashCommands,
	createSlashCommandRegistry,
	DOCS_INSTRUCTION,
	type SlashCommand,
	type SlashCommandTurn,
	TESTS_INSTRUCTION,
} from "../../../../../extension/features/participant/slashCommands";

const HISTORY: ChatMessage[] = [
	{ role: "user", content: "earlier question" },
	{ role: "assistant", content: "earlier answer" },
];

/** A recording turn: what a command reported and what it sent. */
function fakeTurn(overrides: Partial<SlashCommandTurn> = {}): {
	turn: SlashCommandTurn;
	reported: string[];
	sent: (readonly ChatMessage[])[];
} {
	const reported: string[] = [];
	const sent: (readonly ChatMessage[])[] = [];
	return {
		reported,
		sent,
		turn: {
			prompt: "",
			history: [],
			snapshots: () => [],
			attachments: () => Promise.resolve([]),
			report: (markdown) => {
				reported.push(markdown);
			},
			send: (messages) => {
				sent.push(messages);
				return Promise.resolve();
			},
			...overrides,
		},
	};
}

function command(name: string): SlashCommand {
	return { name, description: `the ${name} command`, run: () => Promise.resolve() };
}

describe("extension/features/participant builtinSlashCommands", () => {
	test("the built-in table is exactly /tests, /docs, /models, each described", () => {
		const names = builtinSlashCommands().map((entry) => entry.name);
		expect(names).toEqual(["tests", "docs", "models"]);
		for (const entry of builtinSlashCommands()) {
			expect(entry.description.trim()).not.toBe("");
		}
	});

	test("each call returns a fresh array, so no caller can mutate another's view", () => {
		const first = builtinSlashCommands();
		const second = builtinSlashCommands();
		expect(first).not.toBe(second);
		first.pop();
		expect(second.map((entry) => entry.name)).toEqual(["tests", "docs", "models"]);
	});

	test("/tests sends history plus one instructed user message", async () => {
		const { turn, sent } = fakeTurn({ prompt: "the chunk parser", history: HISTORY });
		const tests = builtinSlashCommands().find((entry) => entry.name === "tests");
		await tests?.run(turn);
		expect(sent).toEqual([[...HISTORY, { role: "user", content: `${TESTS_INSTRUCTION}\n\nthe chunk parser` }]]);
	});

	test("/docs shapes its own instruction the same way", async () => {
		const { turn, sent } = fakeTurn({ prompt: "the resolver" });
		const docs = builtinSlashCommands().find((entry) => entry.name === "docs");
		await docs?.run(turn);
		expect(sent).toEqual([[{ role: "user", content: `${DOCS_INSTRUCTION}\n\nthe resolver` }]]);
	});

	test("an empty prompt sends the instruction alone, never a dangling blank line", async () => {
		const { turn, sent } = fakeTurn({ prompt: "   " });
		const tests = builtinSlashCommands().find((entry) => entry.name === "tests");
		await tests?.run(turn);
		expect(sent).toEqual([[{ role: "user", content: TESTS_INSTRUCTION }]]);
	});

	test("/models reports the snapshot table and never sends a model request", async () => {
		const { turn, sent, reported } = fakeTurn({
			snapshots: () => [{ label: "alpha", models: [{ id: "gpt-test", capabilities: "tools" }] }],
		});
		const models = builtinSlashCommands().find((entry) => entry.name === "models");
		await models?.run(turn);
		expect(sent).toEqual([]);
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain("`gpt-test`");
	});
});

describe("extension/features/participant createSlashCommandRegistry", () => {
	test("defaults to the built-in table, in table order", () => {
		const registry = createSlashCommandRegistry();
		expect(registry.list().map((entry) => entry.name)).toEqual(["tests", "docs", "models"]);
		expect(registry.find("tests")?.name).toBe("tests");
		expect(registry.find("missing")).toBeUndefined();
	});

	test("register extends the table and list keeps registration order", () => {
		const registry = createSlashCommandRegistry();
		registry.register(command("fix"));
		registry.register(command("explain"));
		expect(registry.list().map((entry) => entry.name)).toEqual(["tests", "docs", "models", "fix", "explain"]);
		expect(registry.find("fix")?.description).toBe("the fix command");
	});

	test("registering over a built-in name throws instead of silently shadowing", () => {
		const registry = createSlashCommandRegistry();
		expect(() => registry.register(command("models"))).toThrow("duplicate slash command name: /models");
	});

	test("registering the same extension name twice throws too", () => {
		const registry = createSlashCommandRegistry();
		registry.register(command("fix"));
		expect(() => registry.register(command("fix"))).toThrow("duplicate slash command name: /fix");
	});

	test("a duplicate inside the initial table fails at construction", () => {
		expect(() => createSlashCommandRegistry([command("fix"), command("fix")])).toThrow(
			"duplicate slash command name: /fix"
		);
	});
});
