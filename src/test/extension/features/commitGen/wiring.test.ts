/**
 * The commit-generation wiring's dashboard probe: the real prompt assembly
 * over the canned sample, the feature's own send (featureChatSend under the
 * commitGeneration surface), and the same fence-stripped emptiness rule the
 * command applies - so a green probe proves what a real generation would do.
 */
import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import { createCommitProbe } from "../../../../extension/features/commitGen/wiring";
import { OneShotClient } from "../../../../provider/transport/oneShotClient";
import { CHAT_COMPLETIONS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../../mocks/handlers";
import { withConfig } from "../../../testUtils";

/** The settings that make the probe live against the msw-mocked server. */
const ENABLED_CONFIG = {
	"commitGeneration.enabled": true,
	"commitGeneration.model": { server: "alpha", model: "gpt-test" },
	servers: [{ label: "alpha", baseUrl: TEST_BASE_URL, auth: { apiKey: "sk-test" } }],
};

const MODEL = { server: "alpha", model: "gpt-test" };

function client(): OneShotClient {
	return new OneShotClient({ userAgent: "test-agent" });
}

function fakeSecrets(): Parameters<typeof createCommitProbe>[0] {
	return {
		get: () => Promise.resolve(undefined),
		store: () => Promise.resolve(),
		delete: () => Promise.resolve(),
	} as unknown as Parameters<typeof createCommitProbe>[0];
}

/** One canned reply, capturing the request body the probe sent. */
function answerWith(content: string): { body: () => Record<string, unknown>; prompt: () => string } {
	let seen: Record<string, unknown> = {};
	mswServer.use(
		http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
			seen = (await request.json()) as Record<string, unknown>;
			return HttpResponse.json({ choices: [{ message: { role: "assistant", content } }] });
		})
	);
	return {
		body: () => seen,
		prompt: () => (seen.messages as { content: string }[] | undefined)?.[0]?.content ?? "",
	};
}

suite("extension/features/commitGen wiring probe", () => {
	useMsw();

	test("the probe sends the real prompt assembly over the canned diff, never anything of the user's", async () => {
		const observed = answerWith("feat: add a retry to the upload path");
		const probe = createCommitProbe(fakeSecrets(), client(), () => {});
		const answer = await withConfig(ENABLED_CONFIG, () => probe(MODEL));
		assert.strictEqual(answer, "feat: add a retry to the upload path");
		// The pass-through contract on this path: the body is exactly
		// model/messages/stream:false, no max_tokens, no parameter records.
		assert.deepStrictEqual(Object.keys(observed.body()).sort(), ["messages", "model", "stream"]);
		assert.strictEqual(observed.body().stream, false);
		assert.strictEqual(observed.body().model, "gpt-test");
		const prompt = observed.prompt();
		assert.ok(prompt.includes("diff --git a/upload.ts b/upload.ts"), "the canned sample diff rides the prompt");
		assert.ok(prompt.includes("feat: add the upload path"), "so do the canned style subjects");
		assert.ok(prompt.includes("Conventional Commits"), "the built-in instruction leads when no custom prompt is set");
	});

	test("the user's custom instruction setting reaches the probe prompt, like a real generation", async () => {
		const observed = answerWith("anything");
		const probe = createCommitProbe(fakeSecrets(), client(), () => {});
		await withConfig({ ...ENABLED_CONFIG, "commitGeneration.prompt": "Describe the change in pirate speak." }, () =>
			probe(MODEL)
		);
		assert.ok(observed.prompt().startsWith("Describe the change in pirate speak."));
	});

	test("an all-fence reply strips to empty, so the dashboard shows the empty-answer warning", async () => {
		answerWith("```\n```");
		const probe = createCommitProbe(fakeSecrets(), client(), () => {});
		const answer = await withConfig(ENABLED_CONFIG, () => probe(MODEL));
		assert.strictEqual(answer, "");
	});

	test("a fenced commit message is unwrapped, mirroring the command's own rule", async () => {
		answerWith("```\nfix: unwrap the fence\n```");
		const probe = createCommitProbe(fakeSecrets(), client(), () => {});
		const answer = await withConfig(ENABLED_CONFIG, () => probe(MODEL));
		assert.strictEqual(answer, "fix: unwrap the fence");
	});
});
