/**
 * The session fingerprint on the wire: the LiteLLM session id a request carries, and the paths it must not travel on.
 *
 *   The rules themselves are pinned in the bun tree (shared/config/sessionFingerprint); this suite proves the transport
 *     carries what the resolution mints, and that the fingerprint rides the request rather than the client: a header among
 *     the client's own would rebuild the OpenAI client on every new conversation, and would ride the discovery
 *     requests too.
 */
import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import type { OneShotConnection } from "../../../provider/transport/oneShotClient";
import { OneShotClient } from "../../../provider/transport/oneShotClient";
import { featureSessionFingerprintHeader } from "../../../provider/transport/sessionFingerprint";
import { fixedHeaderValue } from "../../../shared/util/headers";
import { CHAT_COMPLETIONS_URL, MODEL_INFO_URL, mswServer, TEST_BASE_URL, useMsw } from "../../mocks/handlers";
import { DEFAULT_DISCOVERY_PAYLOAD, makeModelInfo } from "../../pureHelpers";
import { captureRequest, createConfiguredProvider, userMessage, withConfig } from "../../testUtils";

const modelInfo = makeModelInfo();
const CHAT_FINGERPRINT = /^vscode-chat-[0-9a-f]{12}$/;

function client(): OneShotClient {
	return new OneShotClient({ userAgent: fixedHeaderValue("test-agent") });
}

function connection(): OneShotConnection {
	return { baseUrl: TEST_BASE_URL, apiKey: fixedHeaderValue("sk-test"), headers: {} };
}

function chatJson(content: string): Response {
	return HttpResponse.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
}

async function chatSessionFingerprintHeaderFor(
	messages: vscode.LanguageModelChatRequestMessage[]
): Promise<string | undefined> {
	const { headers } = await withConfig({ "chat.sessionFingerprint": "conversation" }, () =>
		captureRequest(
			createConfiguredProvider(),
			modelInfo,
			{ toolMode: vscode.LanguageModelChatToolMode.Auto },
			{ messages }
		)
	);
	return headers["x-litellm-session-id"];
}

suite("provider/transport session fingerprint", () => {
	useMsw();

	test("the chat request carries the chat's own fingerprint", async () => {
		const fingerprint = await chatSessionFingerprintHeaderFor([userMessage("what does this repo do?")]);
		assert.ok(fingerprint !== undefined, "the session id header must ride the chat request");
		assert.match(fingerprint, CHAT_FINGERPRINT);
	});

	test("one chat keeps one fingerprint across its turns", async () => {
		const first = await chatSessionFingerprintHeaderFor([userMessage("what does this repo do?")]);
		const second = await chatSessionFingerprintHeaderFor([
			userMessage("what does this repo do?"),
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("a test harness")],
				name: undefined,
			},
			userMessage("and how do I run it?"),
		]);
		assert.strictEqual(first, second, "a second turn must not move the chat's fingerprint");
	});

	test("two chats with different questions have different fingerprints", async () => {
		const one = await chatSessionFingerprintHeaderFor([userMessage("what does this repo do?")]);
		const other = await chatSessionFingerprintHeaderFor([userMessage("what is the weather?")]);
		assert.notStrictEqual(one, other);
	});

	test("the window fingerprint is the editor session id, verbatim", async () => {
		const { headers } = await withConfig({ "chat.sessionFingerprint": "window" }, () =>
			captureRequest(createConfiguredProvider(), modelInfo, { toolMode: vscode.LanguageModelChatToolMode.Auto })
		);
		assert.strictEqual(headers["x-litellm-session-id"], vscode.env.sessionId);
	});

	test("no session id rides along when the knob is off", async () => {
		const { headers } = await withConfig({}, () =>
			captureRequest(createConfiguredProvider(), modelInfo, { toolMode: vscode.LanguageModelChatToolMode.Auto })
		);
		assert.strictEqual(headers["x-litellm-session-id"], undefined);
	});

	test("the discovery request carries no session id, so the fingerprint never enters the client's own headers", async () => {
		// The client's cache keys on its own headers, so a fingerprint among them would rebuild the client on every new
		// conversation - and the discovery requests would carry a session id the proxy would group as a model call.
		let seenScope: string | null | undefined;
		mswServer.use(
			http.get(MODEL_INFO_URL, async ({ request }) => {
				seenScope = request.headers.get("x-litellm-session-id");
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			})
		);
		await withConfig({ "chat.sessionFingerprint": "conversation" }, () =>
			createConfiguredProvider().provideLanguageModelChatInformation(
				{ silent: true } as { silent: boolean },
				new vscode.CancellationTokenSource().token
			)
		);
		assert.strictEqual(seenScope, null);
	});

	test("the one-shot path carries the feature's own fingerprint", async () => {
		let seenScope: string | null | undefined;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				seenScope = request.headers.get("x-litellm-session-id");
				return chatJson("ok");
			})
		);
		await withConfig({ "commitGeneration.sessionFingerprint": "window" }, async () => {
			await client().completeChatOnce(
				connection(),
				{ model: "gpt-test", messages: [{ role: "user", content: "diff" }] },
				"commitGeneration",
				{
					timeout: { ms: 5000, setting: "chat.timeout" },
					token: new vscode.CancellationTokenSource().token,
					sessionIdHeader: featureSessionFingerprintHeader("commitGeneration"),
				}
			);
		});
		assert.strictEqual(seenScope, vscode.env.sessionId);
	});

	test("a feature's fingerprint is its own: one feature's knob leaves the others without one", async () => {
		await withConfig({ "commitGeneration.sessionFingerprint": "window" }, () => {
			assert.strictEqual(featureSessionFingerprintHeader("commitGeneration"), vscode.env.sessionId);
			assert.strictEqual(featureSessionFingerprintHeader("prGeneration"), undefined);
		});
	});
});
