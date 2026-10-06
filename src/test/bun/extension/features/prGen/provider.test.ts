import { describe, expect, test } from "bun:test";
import type { CancellationToken } from "vscode";
import type { TitleAndDescriptionContext } from "../../../../../extension/features/prGen/prompt";
import { createTitleAndDescriptionProvider } from "../../../../../extension/features/prGen/provider";
import { Logger } from "../../../../../shared/logger";

const TOKEN = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
} as unknown as CancellationToken;

function context(overrides: Partial<TitleAndDescriptionContext> = {}): TitleAndDescriptionContext {
	return { commitMessages: [], patches: [], ...overrides };
}

describe("extension/features/prGen createTitleAndDescriptionProvider", () => {
	test("the context flows through prompt assembly to send, with the caller's token", async () => {
		let seenPrompt = "";
		let seenToken: CancellationToken | undefined;
		const provider = createTitleAndDescriptionProvider((prompt, token) => {
			seenPrompt = prompt;
			seenToken = token;
			return Promise.resolve("Title: Add MCP publishing\nDescription:\nAdds an MCP entry field.");
		});
		const result = await provider.provideTitleAndDescription(
			context({ patches: ["+the-changed-line"], commitMessages: ["feat: prior commit"] }),
			TOKEN
		);
		expect(result).toEqual({ title: "Add MCP publishing", description: "Adds an MCP entry field." });
		expect(seenPrompt).toContain("+the-changed-line");
		expect(seenPrompt).toContain("feat: prior commit");
		expect(seenToken).toBe(TOKEN);
	});

	test("a title-only answer omits the description key entirely", async () => {
		const provider = createTitleAndDescriptionProvider(() => Promise.resolve("Title: Add MCP publishing"));
		const result = await provider.provideTitleAndDescription(context(), TOKEN);
		expect(result).toEqual({ title: "Add MCP publishing" });
		expect(result !== undefined && "description" in result).toBe(false);
	});

	test("an unusable answer maps to undefined - the upstream 'provider could not' value", async () => {
		const provider = createTitleAndDescriptionProvider(() => Promise.resolve("```\n\n```"));
		expect(await provider.provideTitleAndDescription(context(), TOKEN)).toBeUndefined();
	});

	test("the returned fields pass the door again: a spelling the parse respells is masked on the way out", async () => {
		// The reply spells the value with CRLF, which the mask at receipt does not match; the parse normalizes line
		// endings, so the description then carries the registered spelling and the exit masks it.
		Logger.registerSecrets(["alpha\nbeta-r6pr"]);
		const provider = createTitleAndDescriptionProvider(() =>
			Promise.resolve("Title: Rotate the key\r\nDescription:\r\nalpha\r\nbeta-r6pr")
		);
		expect(await provider.provideTitleAndDescription(context(), TOKEN)).toEqual({
			title: "Rotate the key",
			description: "[redacted]",
		});
	});

	test("failures from send propagate uncaught to the calling extension", async () => {
		const failure = new Error("boom");
		const provider = createTitleAndDescriptionProvider(() => Promise.reject(failure));
		let caught: unknown;
		try {
			await provider.provideTitleAndDescription(context(), TOKEN);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(failure);
	});
});
