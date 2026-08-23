import * as l10n from "@vscode/l10n";
import type { ChatMessage } from "./historyConversion";
import { modelsMarkdown, type ProviderSnapshot } from "./modelsMarkdown";
import { type ResolvedReference, withReferences } from "./references";

/**
 * The participant's slash commands: the built-in table plus the registration
 * seam other features extend (quick fixes add /fix and /explain through it).
 * A command sees one turn's worth of injected capability - the prompt, the
 * converted history, the provider snapshots, and the two output channels -
 * so commands stay pure and the handler owns transport and error handling.
 */

/** What one slash command may do with the current turn. */
export interface SlashCommandTurn {
	/** The free text after the command, verbatim - the user's words only, with nothing attached. */
	readonly prompt: string;
	/**
	 * The turn's attachments (the selection, the open file, every `#file:`),
	 * read on demand. A thunk for the same reason snapshots is one: reading
	 * them costs document opens, and a command that answers without the user's
	 * code - /models, for one - should not pay for context it discards.
	 */
	attachments(): Promise<readonly ResolvedReference[]>;
	/** The prior turns, already converted; a command sending a request decides whether they ride along. */
	readonly history: readonly ChatMessage[];
	/**
	 * The provider groups' last known models, for zero-network answers. A
	 * function, not an array: only the commands that answer FROM the snapshots
	 * should pay for reading them, so a snapshot read that fails cannot take
	 * down /tests or /docs, which never look.
	 */
	snapshots(): readonly ProviderSnapshot[];
	/** Write markdown to the response stream. */
	report(markdown: string): void;
	/**
	 * Send messages to the request's model and stream its reply; rejects ride
	 * to the handler's catch. The array is normalized to wire shape first,
	 * which can empty it, not just reshape it: answers before the first user
	 * message drop, so forward history alone only with a user message behind it.
	 */
	send(messages: readonly ChatMessage[]): Promise<void>;
}

export interface SlashCommand {
	/** The name the host routes on: the contribution's command name, without the slash. */
	readonly name: string;
	/**
	 * Shown in the participant's help listing, resolved through the RUNTIME
	 * l10n bundle. The manifest carries its own package.nls copy of the same
	 * prose for the host's `/` picker, because the host reads the manifest long
	 * before this process exists and the two runtimes cannot share one string.
	 * What IS shared is the name vocabulary, pinned by the contribution test.
	 */
	readonly description: string;
	run(turn: SlashCommandTurn): Promise<void>;
}

/**
 * The model-facing instructions the prompt-shaping commands prepend.
 * Model-facing text stays English by policy.
 */
export const TESTS_INSTRUCTION = [
	"Write tests for the code or request below.",
	"Reply with runnable test code in fenced code blocks, following the conventions visible in the conversation.",
	"State any assumptions briefly before the code.",
].join("\n");

export const DOCS_INSTRUCTION = [
	"Write documentation for the code or request below.",
	"Reply in markdown, concise and example-led: what it is for, how to use it, and the edge cases worth knowing.",
].join("\n");

/** The instruction with the user's text below it; an empty prompt sends the instruction alone. */
function instructed(instruction: string, prompt: string): string {
	return prompt.trim() === "" ? instruction : `${instruction}\n\n${prompt}`;
}

/**
 * A prompt-shaping command: history plus one instructed user message to the
 * model, with the turn's attachments below the user's own words. These are the
 * commands whose sample requests say "the selected function", so they are
 * exactly the ones that must not arrive without it.
 */
function promptCommand(name: string, description: string, instruction: string): SlashCommand {
	return {
		name,
		description,
		run: async (turn) => {
			const prompt = withReferences(turn.prompt, await turn.attachments());
			await turn.send([...turn.history, { role: "user", content: instructed(instruction, prompt) }]);
		},
	};
}

/** The built-in table; a fresh array per call so no caller can mutate another's view. */
export function builtinSlashCommands(): SlashCommand[] {
	return [
		promptCommand("tests", l10n.t("Write tests for the code or behavior you describe"), TESTS_INSTRUCTION),
		promptCommand("docs", l10n.t("Write documentation for the code or behavior you describe"), DOCS_INSTRUCTION),
		{
			name: "models",
			description: l10n.t("List the models your LiteLLM servers offer, without a model request"),
			run: (turn) => {
				turn.report(modelsMarkdown(turn.snapshots()));
				return Promise.resolve();
			},
		},
	];
}

/** The registration seam: lookup for the handler, register for the features that extend the table. */
export interface SlashCommandRegistry {
	/** Add a command; a name collision throws, because a silently shadowed command is a routing bug. */
	register(command: SlashCommand): void;
	find(name: string): SlashCommand | undefined;
	/** Every command in registration order. */
	list(): readonly SlashCommand[];
}

export function createSlashCommandRegistry(
	initial: readonly SlashCommand[] = builtinSlashCommands()
): SlashCommandRegistry {
	const commands = new Map<string, SlashCommand>();
	const register = (command: SlashCommand): void => {
		if (commands.has(command.name)) {
			throw new Error(`duplicate slash command name: /${command.name}`);
		}
		commands.set(command.name, command);
	};
	for (const command of initial) {
		register(command);
	}
	return {
		register,
		find: (name) => commands.get(name),
		list: () => [...commands.values()],
	};
}
