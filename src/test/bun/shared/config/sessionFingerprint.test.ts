/**
 * The session fingerprint: what a request's LiteLLM session id is derived from.
 *
 *   The rules under test are the two fingerprint strategies ticket 13 measured: the durable one takes the fingerprint
 *     from the last question before the assistant's first answer, and the collecting one from the first question
 *     wherever it is, so a chat that opens with something unfingerprintable can be told apart as soon as it says
 *     something.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import {
	resolveSessionFingerprintHeader,
	SESSION_ID_HEADER_NAME,
	type SessionFingerprintMessage,
} from "../../../../shared/config/sessionFingerprint";

const WINDOW_ID = "8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";
const CHAT_FINGERPRINT = /^vscode-chat-[0-9a-f]{12}$/;
const WORKSPACE_FINGERPRINT = /^vscode-ws-[0-9a-f]{12}$/;

function user(text: string): SessionFingerprintMessage {
	return { role: "user", text, data: [] };
}

function assistant(text: string): SessionFingerprintMessage {
	return { role: "assistant", text, data: [] };
}

function image(bytes: readonly number[]): SessionFingerprintMessage {
	return { role: "user", text: "", data: [new Uint8Array(bytes)] };
}

function context(workspacePath?: string) {
	return { windowSessionId: WINDOW_ID, workspacePath };
}

describe("shared/config/sessionFingerprint", () => {
	test("the header name is the one LiteLLM reads the session id from", () => {
		assert.strictEqual(SESSION_ID_HEADER_NAME, "x-litellm-session-id");
	});

	test("off sends no session id at all", () => {
		assert.strictEqual(
			resolveSessionFingerprintHeader({
				value: "off",
				context: context("/home/dev/project"),
				messages: [user("hello")],
			}),
			undefined
		);
	});

	test("the window fingerprint is the editor session id, verbatim", () => {
		assert.strictEqual(
			resolveSessionFingerprintHeader({ value: "window", context: context("/home/dev/project") }),
			WINDOW_ID
		);
	});

	test("the workspace fingerprint hashes the folder's path, so the id carries no path", () => {
		const scoped = resolveSessionFingerprintHeader({ value: "workspace", context: context("/home/dev/project") });
		assert.ok(scoped !== undefined);
		assert.match(scoped, WORKSPACE_FINGERPRINT);
		assert.ok(!scoped.includes("/home/dev"), "the path must not ride the header");
	});

	test("the workspace fingerprint is the same folder's and another folder's apart", () => {
		const here = resolveSessionFingerprintHeader({ value: "workspace", context: context("/home/dev/project") });
		const same = resolveSessionFingerprintHeader({ value: "workspace", context: context("/home/dev/project") });
		const other = resolveSessionFingerprintHeader({ value: "workspace", context: context("/home/dev/other") });
		assert.strictEqual(here, same);
		assert.notStrictEqual(here, other);
	});

	test("a window with no folder open has no workspace to group by, so no session id rides along", () => {
		assert.strictEqual(resolveSessionFingerprintHeader({ value: "workspace", context: context() }), undefined);
	});

	test("the durable strategy keeps one fingerprint for the whole chat", () => {
		const first = resolveSessionFingerprintHeader({
			value: "conversation",
			strategy: "durable",
			context: context(),
			messages: [user("what does this repo do?")],
		});
		const second = resolveSessionFingerprintHeader({
			value: "conversation",
			strategy: "durable",
			context: context(),
			messages: [user("what does this repo do?"), assistant("a test harness"), user("and how do I run it?")],
		});
		assert.ok(first !== undefined);
		assert.match(first, CHAT_FINGERPRINT);
		assert.strictEqual(first, second, "a second turn must not move the chat's fingerprint");
	});

	test("the durable strategy takes the fingerprint from the question before the first answer", () => {
		const scoped = resolveSessionFingerprintHeader({
			value: "conversation",
			strategy: "durable",
			context: context(),
			messages: [user("first question"), assistant("an answer"), user("second question")],
		});
		const firstQuestion = resolveSessionFingerprintHeader({
			value: "conversation",
			strategy: "durable",
			context: context(),
			messages: [user("first question")],
		});
		assert.strictEqual(scoped, firstQuestion);
	});

	test("two chats with different questions have different fingerprints", () => {
		const one = resolveSessionFingerprintHeader({
			value: "conversation",
			strategy: "durable",
			context: context(),
			messages: [user("what does this repo do?")],
		});
		const other = resolveSessionFingerprintHeader({
			value: "conversation",
			strategy: "durable",
			context: context(),
			messages: [user("what is the weather?")],
		});
		assert.notStrictEqual(one, other);
	});

	test("the session id carries neither the question nor the window id in the clear", () => {
		const scoped = resolveSessionFingerprintHeader({
			value: "conversation",
			strategy: "durable",
			context: context(),
			messages: [user("what does this repo do?")],
		});
		assert.ok(scoped !== undefined);
		assert.ok(!scoped.includes("repo"), "the question must not ride the header");
		assert.ok(!scoped.includes(WINDOW_ID), "the window id must not ride the header");
	});

	test("the durable strategy fingerprints the media of a chat that opens with an image", () => {
		const first = resolveSessionFingerprintHeader({
			value: "conversation",
			strategy: "durable",
			context: context(),
			messages: [image([1, 2, 3, 4])],
		});
		const second = resolveSessionFingerprintHeader({
			value: "conversation",
			strategy: "durable",
			context: context(),
			messages: [image([1, 2, 3, 4]), assistant("an answer"), user("what is this?")],
		});
		assert.ok(first !== undefined);
		assert.match(first, CHAT_FINGERPRINT);
		assert.strictEqual(first, second, "an image-only chat keeps its fingerprint once it is answered");
	});

	test("a chat with nothing to fingerprint rides the window id", () => {
		assert.strictEqual(
			resolveSessionFingerprintHeader({ value: "conversation", strategy: "durable", context: context(), messages: [] }),
			WINDOW_ID
		);
		assert.strictEqual(
			resolveSessionFingerprintHeader({
				value: "conversation",
				strategy: "collecting",
				context: context(),
				messages: [],
			}),
			WINDOW_ID
		);
	});

	test("the collecting strategy upgrades a chat that opens with nothing to fingerprint", () => {
		const before = resolveSessionFingerprintHeader({
			value: "conversation",
			strategy: "collecting",
			context: context(),
			messages: [image([1, 2, 3, 4])],
		});
		const after = resolveSessionFingerprintHeader({
			value: "conversation",
			strategy: "collecting",
			context: context(),
			messages: [image([1, 2, 3, 4]), assistant("an answer"), user("what is this?")],
		});
		assert.strictEqual(before, WINDOW_ID, "nothing to fingerprint means the window id");
		assert.ok(after !== undefined);
		assert.match(after, CHAT_FINGERPRINT);
		assert.notStrictEqual(before, after, "the chat moves to a fingerprint of its own once it can be told apart");
	});

	test("the collecting strategy takes the first question wherever it is", () => {
		const scoped = resolveSessionFingerprintHeader({
			value: "conversation",
			strategy: "collecting",
			context: context(),
			messages: [image([1, 2, 3, 4]), assistant("an answer"), user("what is this?")],
		});
		const sameQuestion = resolveSessionFingerprintHeader({
			value: "conversation",
			strategy: "collecting",
			context: context(),
			messages: [user("what is this?")],
		});
		assert.strictEqual(scoped, sameQuestion);
	});
});
