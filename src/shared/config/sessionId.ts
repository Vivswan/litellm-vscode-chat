/**
 * The LiteLLM session id a chat request carries: what it is derived from, and the hash that keeps the source on the
 * machine.
 *
 *   Node-only, unlike its neighbours in this folder: it hashes, and the webview bundle must not pull node:crypto in.
 *     The vocabulary it judges modes by lives in settingSpec.ts, which the webview may import.
 *
 * Pure by construction - no vscode, no configuration, no editor state: the caller hands over the mode, the window and
 * folder identity, and the conversation, and gets back the header value or nothing.
 */
import { createHash } from "node:crypto";
import { fixedHeaderValue, type HeaderValue } from "../util/headers";
import type { SessionIdMode } from "./settingSpec";

/**
 * The one header the session id rides. LiteLLM reads it on every route the extension uses and writes it to the spend
 * log's session column, so the requests that share a value group together in the proxy's session view.
 *
 *   Not the trace header: the proxy reads x-litellm-trace-id first, so a trace id on a server entry outranks this.
 */
export const SESSION_ID_HEADER_NAME = "x-litellm-session-id";

/** The hash's readable prefix, so a session id in the proxy's UI says what kind of session it is. */
const CHAT_SESSION_PREFIX = "vscode-chat-";
const FOLDER_SESSION_PREFIX = "vscode-folder-";
const WINDOW_SESSION_PREFIX = "vscode-window-";

/** The hash's width: 12 hex characters, short enough to read in a UI and long enough not to collide in one proxy. */
const SESSION_HASH_LENGTH = 12;

/** The editor identity a session id is derived from. */
export interface SessionIdContext {
	/**
	 * vscode.env.sessionId: one per VS Code window, a new one every time it opens. With telemetry disabled VS Code
	 * hands every window the same placeholder, so those windows share one session; the value is hashed like every
	 * other, never sent as is.
	 */
	readonly windowSessionId: string;
	/** The open folder's path; undefined when the window has no folder. */
	readonly folderPath?: string | undefined;
}

/**
 * One turn of the conversation, reduced to what the chat rule reads: its role, its text, and the media it carries.
 *
 *   The reduction happens in the caller's tree, because telling a text part from a data part needs the host's own
 *     classes; no vscode type reaches this module.
 */
export interface SessionIdMessage {
	readonly role: "user" | "assistant" | "system";
	/** The turn's text parts, joined; empty when it carries none. */
	readonly text: string;
	/** The media the turn carries; empty when it carries none. */
	readonly data: readonly Uint8Array[];
}

export interface SessionIdInput {
	/** What the session id is derived from; "off" resolves to no header at all. */
	readonly mode: SessionIdMode;
	readonly context: SessionIdContext;
	/** The conversation, as the provider receives it: before the wire conversion, so no synthetic turn can be picked. */
	readonly messages?: readonly SessionIdMessage[] | undefined;
}

/** What a hash is fed: text or bytes, each tagged so a question can never spell the same stream as an image. */
type HashPart = string | Uint8Array;

/** Each part goes in behind its byte length, so no two part sequences can spell the same byte stream. */
function sessionHash(prefix: string, parts: readonly HashPart[]): HeaderValue {
	const hash = createHash("sha256");
	for (const part of parts) {
		hash.update(`${Buffer.byteLength(part)}:`);
		hash.update(part);
	}
	return fixedHeaderValue(`${prefix}${hash.digest("hex").slice(0, SESSION_HASH_LENGTH)}`);
}

/** The window's own session: the one a chat with nothing to hash rides too. */
function windowSession(context: SessionIdContext): HeaderValue {
	return sessionHash(WINDOW_SESSION_PREFIX, [context.windowSessionId]);
}

/** A turn's own content: its text when it has any, else its media, else nothing. */
function turnContent(turn: SessionIdMessage): readonly HashPart[] | undefined {
	if (turn.text.length > 0) {
		return ["text", turn.text];
	}
	return turn.data.length > 0 ? ["bytes", ...turn.data] : undefined;
}

/**
 * What a chat is identified by: the last question before the assistant's first answer, so the session id cannot move
 * while the chat is being answered.
 *
 *   A chat that opens with an image has no question to hash, so its first user turn's content stands in; a first user
 *     turn carrying neither text nor media yields nothing, and the chat rides the window's session.
 */
function chatSource(messages: readonly SessionIdMessage[]): readonly HashPart[] | undefined {
	const firstAnswer = messages.findIndex((message) => message.role === "assistant");
	const opening = firstAnswer === -1 ? messages : messages.slice(0, firstAnswer);
	const questions = opening.filter((message) => message.role === "user" && message.text.length > 0);
	const lastQuestion = questions[questions.length - 1];
	if (lastQuestion !== undefined) {
		return ["text", lastQuestion.text];
	}

	const firstUserTurn = messages.find((message) => message.role === "user");
	return firstUserTurn === undefined ? undefined : turnContent(firstUserTurn);
}

/**
 * The session id header value for a chat request, or undefined when the request carries none.
 *
 *   off     -> nothing: the request goes out byte for byte as it does with no session id at all
 *   on      -> the chat's own content, hashed with the window id so two windows asking the same thing stay apart; a
 *              chat with nothing to hash yet rides the window's session
 *   folder  -> the folder's path, hashed; no folder open means no folder to group by, so nothing rides along
 *   window  -> the window's own id, hashed
 */
export function resolveSessionIdHeader(input: SessionIdInput): HeaderValue | undefined {
	const { mode, context } = input;
	switch (mode) {
		case "off":
			return undefined;
		case "window":
			return windowSession(context);
		case "folder": {
			const path = context.folderPath;
			return path === undefined ? undefined : sessionHash(FOLDER_SESSION_PREFIX, [path]);
		}
		case "on": {
			const source = chatSource(input.messages ?? []);
			if (source === undefined) {
				return windowSession(context);
			}
			return sessionHash(CHAT_SESSION_PREFIX, [context.windowSessionId, ...source]);
		}
	}
}
