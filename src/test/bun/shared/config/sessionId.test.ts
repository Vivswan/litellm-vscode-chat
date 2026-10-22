/**
 * The LiteLLM session id a chat request carries.
 *
 *   What would drift silently: the proxy groups requests by this id, so a rule change that moves a chat's id between
 *     its turns, or leaks a path or a question into it, shows up only in someone's LiteLLM session view.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import {
	resolveSessionIdHeader,
	type SessionIdContext,
	type SessionIdMessage,
} from "../../../../shared/config/sessionId";

const WINDOW_ID = "8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";
const CHAT_SESSION = /^vscode-chat-[0-9a-f]{12}$/;
const FOLDER_SESSION = /^vscode-folder-[0-9a-f]{12}$/;
const WINDOW_SESSION = /^vscode-window-[0-9a-f]{12}$/;

function user(text: string): SessionIdMessage {
	return { role: "user", text, data: [] };
}

function assistant(text: string): SessionIdMessage {
	return { role: "assistant", text, data: [] };
}

function image(...parts: readonly (readonly number[])[]): SessionIdMessage {
	return { role: "user", text: "", data: parts.map((bytes) => new Uint8Array(bytes)) };
}

function context(folderPath?: string): SessionIdContext {
	return { windowSessionId: WINDOW_ID, folderPath };
}

function chatSession(messages: readonly SessionIdMessage[]): string | undefined {
	return resolveSessionIdHeader({ mode: "on", context: context(), messages });
}

describe("shared/config/sessionId", () => {
	test("off sends no session id at all", () => {
		const header = resolveSessionIdHeader({
			mode: "off",
			context: context("/home/dev/project"),
			messages: [user("hi")],
		});
		assert.strictEqual(header, undefined);
	});

	test("window hashes the window's own id, so the id never rides the header and two windows stay apart", () => {
		const here = resolveSessionIdHeader({ mode: "window", context: context() });
		const same = resolveSessionIdHeader({ mode: "window", context: context() });
		const other = resolveSessionIdHeader({ mode: "window", context: { windowSessionId: "another-window" } });
		assert.ok(here !== undefined);
		assert.match(here, WINDOW_SESSION);
		assert.ok(!here.includes(WINDOW_ID), "the window id must not ride the header");
		assert.strictEqual(here, same);
		assert.notStrictEqual(here, other);
	});

	test("folder hashes the folder's path: the same folder's twice, another folder's apart", () => {
		const here = resolveSessionIdHeader({ mode: "folder", context: context("/home/dev/project") });
		const same = resolveSessionIdHeader({ mode: "folder", context: context("/home/dev/project") });
		const other = resolveSessionIdHeader({ mode: "folder", context: context("/home/dev/other") });
		assert.ok(here !== undefined);
		assert.match(here, FOLDER_SESSION);
		assert.ok(!here.includes("/home/dev"), "the path must not ride the header");
		assert.strictEqual(here, same);
		assert.notStrictEqual(here, other);
	});

	test("a window with no folder open has no folder to group by, so no session id rides along", () => {
		assert.strictEqual(resolveSessionIdHeader({ mode: "folder", context: context() }), undefined);
	});

	test("one chat keeps one session id: the question before the first answer, whatever follows it", () => {
		const first = chatSession([user("what does this repo do?")]);
		const second = chatSession([
			user("what does this repo do?"),
			assistant("a test harness"),
			user("and how do I run it?"),
		]);
		assert.ok(first !== undefined);
		assert.match(first, CHAT_SESSION);
		assert.strictEqual(first, second, "a second turn must not move the chat's session id");
	});

	test("two chats with different questions have different session ids", () => {
		assert.notStrictEqual(chatSession([user("what does this repo do?")]), chatSession([user("what is the weather?")]));
	});

	test("the session id carries neither the question nor the window id in the clear", () => {
		const header = chatSession([user("what does this repo do?")]);
		assert.ok(header !== undefined);
		assert.ok(!header.includes("repo"), "the question must not ride the header");
		assert.ok(!header.includes(WINDOW_ID), "the window id must not ride the header");
	});

	test("a chat that opens with an image is identified by the image, and keeps that id once answered", () => {
		const first = chatSession([image([1, 2, 3, 4])]);
		const second = chatSession([image([1, 2, 3, 4]), assistant("an answer"), user("what is this?")]);
		assert.ok(first !== undefined);
		assert.match(first, CHAT_SESSION);
		assert.strictEqual(first, second);
	});

	test("an image and a text spelling the same bytes are different chats", () => {
		const bytes = [0x62, 0x79, 0x74, 0x65, 0x73];
		assert.notStrictEqual(chatSession([image(bytes)]), chatSession([user(String.fromCharCode(...bytes))]));
	});

	test("two images and one image spelling the same bytes end to end are different chats", () => {
		// A review probe found [1] + [2] hashing like [1, 0, 2] when a separator byte stood between the parts; the
		// parts' lengths now go into the hash, so a part boundary is never a byte the data could contain.
		assert.notStrictEqual(chatSession([image([1], [2])]), chatSession([image([1, 0, 2])]));
	});

	test("a chat with nothing to hash rides the window's session", () => {
		const windowSession = resolveSessionIdHeader({ mode: "window", context: context() });
		assert.strictEqual(chatSession([]), windowSession);
		assert.strictEqual(chatSession([{ role: "user", text: "", data: [] }]), windowSession);
	});
});
