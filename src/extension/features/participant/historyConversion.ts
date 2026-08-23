/**
 * Chat-history conversion for the participant: prior turns from the host's
 * ChatContext become the plain message array the current request rides on.
 * The input types are minimal structural mirrors of vscode.ChatRequestTurn and
 * vscode.ChatResponseTurn - the wiring passes context.history straight in -
 * so the module needs no vscode import and stays pure for the bun tree. The
 * output is equally neutral: the wiring maps each ChatMessage onto the host's
 * LanguageModelChatMessage constructors.
 */

type ChatMessageRole = "user" | "assistant";

/** One converted history message, ready to map onto a LanguageModelChatMessage. */
export interface ChatMessage {
	readonly role: ChatMessageRole;
	readonly content: string;
}

/** Structural mirror of vscode.ChatRequestTurn: the user's prompt plus the slash command it rode in on. */
export interface HistoryRequestTurn {
	readonly prompt: string;
	readonly command?: string | undefined;
}

/**
 * Structural mirror of vscode.ChatResponseTurn. The response parts stay
 * unknown because the host's part vocabulary is open (markdown, anchors,
 * file trees, tool invocations); conversion keeps the markdown text and
 * skips the rest.
 */
export interface HistoryResponseTurn {
	readonly response: readonly unknown[];
}

export type HistoryTurn = HistoryRequestTurn | HistoryResponseTurn;

/**
 * Head-drop bound for the converted history's total content length: a chat
 * that accumulated huge turns (a /models table on a large install, pasted
 * logs) keeps its newest messages and sheds the oldest whole ones, so every
 * request stays bounded without truncating any message mid-text. History may
 * drop to nothing; the current prompt never rides through here.
 */
export const HISTORY_CHAR_LIMIT = 80_000;

/** Request turns carry a string prompt; response turns never do. */
function isRequestTurn(turn: HistoryTurn): turn is HistoryRequestTurn {
	return typeof (turn as HistoryRequestTurn).prompt === "string";
}

/**
 * The text of one response part, or undefined for parts that carry none. A
 * markdown part's value is a MarkdownString ({ value: string }); every other
 * part kind - tool invocations, anchors, file trees, progress - contributes
 * nothing. Parts whose value is a plain string are deliberately excluded:
 * no markdown part is shaped that way, and the parts that are carry progress
 * chatter, not response text.
 */
function partText(part: unknown): string | undefined {
	if (typeof part !== "object" || part === null || !("value" in part)) {
		return undefined;
	}
	const value = (part as { value: unknown }).value;
	if (typeof value === "object" && value !== null && "value" in value) {
		const inner = (value as { value: unknown }).value;
		if (typeof inner === "string") {
			return inner;
		}
	}
	return undefined;
}

/**
 * A request as the model should see it: the slash command rides along in its
 * typed form, so the model knows what the user asked for, not just the free
 * text beside it.
 */
export function requestContent(turn: HistoryRequestTurn): string {
	if (turn.command === undefined || turn.command === "") {
		return turn.prompt;
	}
	return turn.prompt.trim() === "" ? `/${turn.command}` : `/${turn.command} ${turn.prompt}`;
}

/**
 * Normalize a message array to wire shape: drop answers leading without any
 * question before them (some providers reject a conversation opening with
 * the assistant), then merge consecutive same-role messages into one, joined
 * by a blank line (dropped turns make same-role runs reachable - a canceled
 * response leaves two user questions adjacent - and some providers reject
 * such a sequence outright). Every outgoing message array passes through
 * here, so the rules hold whatever a command built.
 */
export function normalizeForWire(messages: readonly ChatMessage[]): ChatMessage[] {
	const firstUser = messages.findIndex((message) => message.role === "user");
	const coalesced: ChatMessage[] = [];
	for (const message of firstUser === -1 ? [] : messages.slice(firstUser)) {
		const last = coalesced[coalesced.length - 1];
		if (last !== undefined && last.role === message.role) {
			coalesced[coalesced.length - 1] = { role: last.role, content: `${last.content}\n\n${message.content}` };
		} else {
			coalesced.push(message);
		}
	}
	return coalesced;
}

/**
 * Convert prior turns to messages, in order - a faithful turns-to-messages
 * conversion; wire shape (user-first, alternating roles) is normalizeForWire's
 * job at the send boundary.
 *
 * A prior turn's ATTACHMENTS are deliberately not re-read. vscode's
 * ChatRequestTurn carries its own `references`, so re-resolving them here is
 * possible, but a thread that discusses one file would then ship that file
 * once per turn - the request grows with the conversation, and the newest copy
 * is the only one that reflects edits since. The host re-attaches the live
 * editor context on every turn instead, so a follow-up about the file in front
 * of you still arrives with it; what is lost is a file attached once, edited
 * away from, and referred back to, which the user can re-attach.
 *
 * Markdown fragments of one response concatenate back into the text the user
 * saw; turns that convert to whitespace alone (a tool-only response, an empty
 * prompt) are dropped rather than sent as empty messages; and once the total
 * content passes HISTORY_CHAR_LIMIT the oldest whole messages fall off,
 * possibly all of them.
 */
export function historyMessages(turns: readonly HistoryTurn[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const turn of turns) {
		if (isRequestTurn(turn)) {
			const content = requestContent(turn);
			if (content.trim() !== "") {
				messages.push({ role: "user", content });
			}
			continue;
		}
		const content = turn.response.map((part) => partText(part) ?? "").join("");
		if (content.trim() !== "") {
			messages.push({ role: "assistant", content });
		}
	}
	let total = messages.reduce((sum, message) => sum + message.content.length, 0);
	while (messages.length > 0 && total > HISTORY_CHAR_LIMIT) {
		total -= (messages.shift() as ChatMessage).content.length;
	}
	return messages;
}
