import * as l10n from "@vscode/l10n";
import { errorLabel } from "../../../shared/util/errorLabel";
import {
	type ChatMessage,
	type HistoryTurn,
	historyMessages,
	normalizeForWire,
	requestContent,
} from "./historyConversion";
import type { ProviderSnapshot } from "./modelsMarkdown";
import { type ResolvedReference, withReferences } from "./references";
import type { SlashCommandRegistry } from "./slashCommands";

/**
 * The participant's request handler as a pure function over injected
 * capability: the wiring adapts the host's ChatRequestHandler signature onto
 * this and owns the logging boundary, mapping a failed outcome's log line to
 * the output channel. No vscode import, so the whole turn logic tests in the
 * bun tree.
 */

/** The current turn, structurally mirroring what the host hands the handler. */
export interface ParticipantRequest {
	/** The free text after the participant and command mentions, verbatim. */
	readonly prompt: string;
	/** The slash command the user picked, without the slash; undefined for a plain question. */
	readonly command?: string;
	/** The prior turns from ChatContext.history, passed straight through. */
	readonly history: readonly HistoryTurn[];
	/**
	 * The turn's attachments - the editor selection, the implicitly attached
	 * open file, every explicit `#file:` - read on demand by the wiring. They
	 * ride BELOW the user's text rather than replacing it, and deliberately do
	 * not count toward the empty-prompt test: "@litellm" alone with a file open
	 * still lists the commands instead of shipping the file nowhere, and that
	 * path never reads them at all.
	 */
	attachments?(): Promise<readonly ResolvedReference[]>;
}

export interface ParticipantDeps {
	/** Send messages to the request's own model and resolve to its streamed text fragments. */
	sendRequest(messages: readonly ChatMessage[]): Promise<AsyncIterable<string>>;
	/** The response stream; report writes markdown. */
	readonly stream: { report(markdown: string): void };
	/**
	 * The provider groups' last known models, for the zero-network answers.
	 * Handed to a command as-is rather than called here, so only a command that
	 * answers FROM snapshots reads them: /tests and /docs never look, and a
	 * plain question never touches them at all. A read that does throw happens
	 * inside this turn's try, so it surfaces as this turn's failure - one
	 * friendly text, one classification - rather than as a second failure
	 * vocabulary beside turnFailedText.
	 */
	snapshots(): readonly ProviderSnapshot[];
	readonly commands: SlashCommandRegistry;
	/**
	 * Recognize the host's cancellation error, which must ride out uncaught
	 * and unlogged. The default matches vscode.CancellationError structurally
	 * (its name is "Canceled"), so the wiring only overrides it when it can
	 * offer the real instanceof check.
	 */
	isCancellation?(error: unknown): boolean;
}

/**
 * How the turn ended, for the wiring's logging boundary. The log line is a
 * shape-gated classification, never the error's message, because handler
 * errors can wrap response-derived text and logs feed public issue reports.
 */
export type ParticipantOutcome = { readonly kind: "completed" } | { readonly kind: "failed"; readonly log: string };

/** Total cancellation test: a hostile error whose property walk throws must degrade, not reject. */
function isCanceledError(error: unknown): boolean {
	try {
		return error instanceof Error && error.name === "Canceled";
	} catch {
		return false;
	}
}

/** What the user reads when a turn fails: steady advice, never the error text. */
function turnFailedText(): string {
	return l10n.t(
		"Something went wrong while talking to the model. Try again; if it keeps failing, check the model's server connection."
	);
}

/** The lead-in above the command listing an empty prompt answers with. */
function commandListingIntro(): string {
	return l10n.t("Ask me anything, or pick a command:");
}

/** The whole answer when no command is registered to list. */
function noCommandsText(): string {
	return l10n.t("Ask me anything.");
}

/**
 * Handle one turn: route a slash command through the registry, answer a plain
 * prompt through the model with the converted history ahead of it, and turn
 * an empty prompt without a runnable command into a short command listing
 * instead of an empty request. A command name the registry does not know
 * falls back to the plain-prompt path with the command preserved in its
 * typed form, so a contribution/registry drift degrades instead of erroring.
 * Every outgoing message array is normalized to wire shape at the send
 * boundary, so dropped history turns cannot produce a leading answer or a
 * same-role run a provider would reject. Errors are caught per turn: the
 * user gets friendly text, the wiring gets a classification, and
 * cancellation alone rides out uncaught.
 */
export async function handleParticipantTurn(
	request: ParticipantRequest,
	deps: ParticipantDeps
): Promise<ParticipantOutcome> {
	const isCancellation = deps.isCancellation ?? isCanceledError;
	// One read per turn at most, on the paths that build model content: the
	// command listing and any command that never asks never open a document.
	const readAttachments = async (): Promise<readonly ResolvedReference[]> =>
		request.attachments === undefined ? [] : await request.attachments();
	// The one send boundary: every outgoing array is normalized here, whatever
	// built it. normalizeForWire can EMPTY a non-empty array - it drops answers
	// standing before the first user message, so a history of assistant turns
	// alone normalizes to nothing - and an empty messages array is what reaches
	// the model in that case. Guarding it here would be the wrong place: a
	// caller that forwards history alone has a bug the transport's own
	// empty-request error names better than a silent no-op would.
	const send = async (messages: readonly ChatMessage[]): Promise<void> => {
		const fragments = await deps.sendRequest(normalizeForWire(messages));
		for await (const fragment of fragments) {
			deps.stream.report(fragment);
		}
	};
	try {
		const command = request.command === undefined ? undefined : deps.commands.find(request.command);
		if (command !== undefined) {
			await command.run({
				prompt: request.prompt,
				attachments: readAttachments,
				history: historyMessages(request.history),
				snapshots: deps.snapshots,
				report: (markdown) => deps.stream.report(markdown),
				send,
			});
			return { kind: "completed" };
		}
		if (request.prompt.trim() === "") {
			const listing = deps.commands
				.list()
				.map((entry) => `- \`/${entry.name}\` - ${entry.description}`)
				.join("\n");
			deps.stream.report(listing === "" ? noCommandsText() : `${commandListingIntro()}\n\n${listing}`);
			return { kind: "completed" };
		}
		const content = requestContent({ prompt: request.prompt, command: request.command });
		await send([
			...historyMessages(request.history),
			{ role: "user", content: withReferences(content, await readAttachments()) },
		]);
		return { kind: "completed" };
	} catch (error) {
		let cancelled = false;
		try {
			cancelled = isCancellation(error);
		} catch {
			cancelled = false;
		}
		if (cancelled) {
			throw error;
		}
		deps.stream.report(turnFailedText());
		return { kind: "failed", log: `chat participant turn failed: ${errorLabel(error)}` };
	}
}
