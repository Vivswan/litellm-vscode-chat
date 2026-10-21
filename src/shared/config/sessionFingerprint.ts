/**
 * The session fingerprint: what a request's LiteLLM session id is derived from, and how a chat's own fingerprint is
 * chosen.
 *
 *   Node-only, unlike its neighbours in this folder: it hashes, and the webview bundle must not pull node:crypto in.
 *     The vocabulary it judges values by lives in settingSpec.ts, which the webview may import.
 *
 * Pure by construction - no vscode, no configuration, no editor state: the caller hands over the knob's value, the
 * strategy, the window and workspace identity, and the conversation, and gets back the header value or nothing.
 */
import { createHash } from "node:crypto";
import { fixedHeaderValue, type HeaderValue, headerValue } from "../util/headers";
import type { SessionFingerprintStrategy, SessionFingerprintValue } from "./settingSpec";

/**
 * The one header the fingerprint rides. LiteLLM reads the session id from it on every route the extension uses, and it
 * wins over a body-carried one, so the requests of a conversation group together in the proxy's session view.
 *
 *   Not the trace header: the proxy reads x-litellm-trace-id first, so a trace id would outrank the session id and
 *     the grouping would follow the trace instead.
 */
export const SESSION_ID_HEADER_NAME = "x-litellm-session-id";

/** The editor identity a fingerprint is derived from. */
export interface SessionFingerprintContext {
	/** vscode.env.sessionId: one per editor session, a new one on every start. */
	readonly windowSessionId: string;
	/** The open folder's path; undefined when the window has no folder. */
	readonly workspacePath?: string | undefined;
}

/**
 * One turn of the conversation, reduced to what the fingerprint rules read: its role, its text, and the media it
 * carries.
 *
 *   The reduction happens in the caller's tree, because telling a text part from a data part needs the host's own
 *     classes; no vscode type reaches this module.
 */
export interface SessionFingerprintMessage {
	readonly role: "user" | "assistant" | "system";
	/** The turn's text parts, joined; empty when it carries none. */
	readonly text: string;
	/** The media the turn carries; empty when it carries none. */
	readonly data: readonly Uint8Array[];
}

export interface SessionFingerprintInput {
	/** What the fingerprint is derived from; "off" resolves to no header at all. */
	readonly value: SessionFingerprintValue;
	readonly context: SessionFingerprintContext;
	/** Only the conversation fingerprint reads it; the default is the strategy whose fingerprint never changes. */
	readonly strategy?: SessionFingerprintStrategy | undefined;
	/** The conversation, as the provider receives it: before the wire conversion, so no synthetic turn can be picked. */
	readonly messages?: readonly SessionFingerprintMessage[] | undefined;
}

/** The hash's readable prefix, so a session id in the proxy's UI says which kind of fingerprint it is. */
const CHAT_FINGERPRINT_PREFIX = "vscode-chat-";
const WORKSPACE_FINGERPRINT_PREFIX = "vscode-ws-";

/** The hash's width: 12 hex characters, short enough to read in a UI and long enough not to collide in one proxy. */
const FINGERPRINT_HASH_LENGTH = 12;

/** The separator between the window id and the fingerprint, so no two inputs can spell the same pair. */
const FINGERPRINT_INPUT_SEPARATOR = "\u0000";

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, FINGERPRINT_HASH_LENGTH);
}

/**
 * The media a turn carries, as text: the bytes, base64'd, so a turn with no text still has something to fingerprint.
 * The prefix keeps a byte fingerprint from ever spelling a text one.
 */
function mediaSource(data: readonly Uint8Array[]): string | undefined {
	if (data.length === 0) {
		return undefined;
	}
	const bytes = Buffer.concat(data.map((part) => Buffer.from(part)));
	return `bytes:${bytes.toString("base64")}`;
}

/** The turn's own content: its text if it has any, else its media. */
function contentSource(message: SessionFingerprintMessage): string | undefined {
	return message.text.length > 0 ? message.text : mediaSource(message.data);
}

/**
 * The durable strategy's source: the last question before the assistant's first answer, so the fingerprint of a chat
 * cannot move while the chat is being answered.
 *
 *   Falls back to the first user turn's own content when no question precedes the first answer - a chat that opens
 *     with an image has no text to fingerprint - and to nothing at all when that turn carries neither, which leaves
 *     the chat under the window id.
 */
function durableSource(messages: readonly SessionFingerprintMessage[]): string | undefined {
	const firstAnswer = messages.findIndex((message) => message.role === "assistant");
	const before = firstAnswer === -1 ? messages : messages.slice(0, firstAnswer);
	const questions = before.filter((message) => message.role === "user" && message.text.length > 0);
	const lastQuestion = questions[questions.length - 1];
	if (lastQuestion !== undefined) {
		return lastQuestion.text;
	}
	const firstUserMessage = messages.find((message) => message.role === "user");
	return firstUserMessage === undefined ? undefined : contentSource(firstUserMessage);
}

/**
 * The collecting strategy's source: the first question wherever it is, so a chat that opens with something
 * unfingerprintable is told apart as soon as it says something.
 */
function collectingSource(messages: readonly SessionFingerprintMessage[]): string | undefined {
	const firstQuestion = messages.find((message) => message.role === "user" && message.text.length > 0);
	return firstQuestion === undefined ? undefined : firstQuestion.text;
}

/**
 * The chat's own session id.
 *
 *   A chat with nothing to fingerprint rides the window id, which is the collecting strategy's "collect under the
 *     window id" half: the same requests group with the window's other requests until the chat can be told apart,
 *     and move to a fingerprint of their own once it can.
 */
function chatSessionFingerprintValue(
	messages: readonly SessionFingerprintMessage[],
	strategy: SessionFingerprintStrategy,
	context: SessionFingerprintContext
): HeaderValue | undefined {
	const source = strategy === "collecting" ? collectingSource(messages) : durableSource(messages);
	if (source === undefined) {
		return headerValue(context.windowSessionId);
	}
	return fixedHeaderValue(
		`${CHAT_FINGERPRINT_PREFIX}${sha256(context.windowSessionId + FINGERPRINT_INPUT_SEPARATOR + source)}`
	);
}

/**
 * The session id header value for a request, or undefined when the request carries no fingerprint at all.
 *
 *   off        -> nothing: the request goes out byte for byte as it does today
 *   window     -> the editor session id, verbatim
 *   workspace  -> the folder's path, hashed; no folder open means no folder to group by, so nothing rides along
 *   conversation -> the chat's own fingerprint, hashed
 */
export function resolveSessionFingerprintHeader(input: SessionFingerprintInput): HeaderValue | undefined {
	const { value, context } = input;
	if (value === "off") {
		return undefined;
	}
	if (value === "window") {
		return headerValue(context.windowSessionId);
	}
	if (value === "workspace") {
		const path = context.workspacePath;
		return path === undefined ? undefined : fixedHeaderValue(`${WORKSPACE_FINGERPRINT_PREFIX}${sha256(path)}`);
	}
	return chatSessionFingerprintValue(input.messages ?? [], input.strategy ?? "durable", context);
}
