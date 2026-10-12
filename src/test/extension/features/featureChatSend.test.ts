/**
 * The quick-fix editor, the SCM input box, and the persisted review comments take the reply from the shared send with
 * no door of their own, so this pins the one mask they rely on. Without it, a configured value the model echoed
 * would reach the user's editor or workspaceState whole.
 */
import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { featureChatSend } from "../../../extension/features/featureChatSend";
import { OneShotClient } from "../../../provider/transport/oneShotClient";
import { Logger } from "../../../shared/logger";
import { fixedHeaderValue } from "../../../shared/util/headers";
import { CHAT_COMPLETIONS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../mocks/handlers";
import { withConfig } from "../../testUtils";
import { memorySecretStorage } from "./wiringSpies";

const MODEL = { server: "alpha", model: "gpt-test" };
const SERVERS_CONFIG = { servers: [{ label: "alpha", baseUrl: TEST_BASE_URL, auth: { apiKey: "sk-test" } }] };

function chatReply(content: string): Response {
	return HttpResponse.json({ choices: [{ message: { role: "assistant", content } }] });
}

suite("extension/features featureChatSend", () => {
	useMsw();

	test("the reply passes the door as received: a configured value and a configured URL's password come back masked, and a second pass changes nothing", async () => {
		const key = `sk-live-${"A".repeat(32)}`;
		Logger.registerSecrets([key, "url-pass-Q7"]);
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, () => chatReply(`Use ${key} at http://bob:url-pass-Q7@hub.test/v1.`))
		);
		const reply = await withConfig(SERVERS_CONFIG, () =>
			featureChatSend(
				"quickFix",
				{ oneShot: new OneShotClient({ userAgent: fixedHeaderValue("test-agent") }), secrets: memorySecretStorage() },
				MODEL,
				[{ role: "user", content: "Which key?" }],
				new vscode.CancellationTokenSource().token,
				() => {}
			)
		);
		assert.strictEqual(reply, "Use sk-liv... at http://bob:[redacted]@hub.test/v1.");
		// The exits that mask again (the consult result, the PR fields, the toast) must be no-ops over this text.
		assert.strictEqual(Logger.redact(reply), reply);
	});
});
