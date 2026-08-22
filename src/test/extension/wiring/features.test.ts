/**
 * The features' composition point: one shared client, every feature wiring
 * called, and the probe registry the dashboard's Test buttons derive from. A
 * dropped feature-wiring call or a mistyped probe key must fail here rather
 * than ship green.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import { wireFeatures } from "../../../extension/wiring/features";
import { CMD, INTERNAL_CMD } from "../../../shared/config/commandIds";
import { Logger } from "../../../shared/logger";

function fakeContext(): vscode.ExtensionContext {
	return {
		subscriptions: [] as vscode.Disposable[],
		secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
	} as unknown as vscode.ExtensionContext;
}

function quietLogger(): Logger {
	return new Logger({ info() {}, error() {} });
}

/**
 * Run `fn` with command registration recorded instead of real: the shared host
 * already runs the activated extension, so a real registration of the same ids
 * would collide across tests.
 */
async function withCommandSpy<T>(fn: (commandIds: string[]) => T | Promise<T>): Promise<Awaited<T>> {
	const commandIds: string[] = [];
	const originalRegisterCommand = vscode.commands.registerCommand;
	const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;
	(vscode.commands as Record<string, unknown>).registerCommand = (id: string) => {
		commandIds.push(id);
		return new vscode.Disposable(() => {});
	};
	(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = () => new vscode.Disposable(() => {});
	try {
		return await fn(commandIds);
	} finally {
		(vscode.commands as Record<string, unknown>).registerCommand = originalRegisterCommand;
		(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = originalOnDidChangeConfiguration;
	}
}

suite("extension/wiring features", () => {
	test("wireFeatures wires every feature and registers exactly the inline probe", async () => {
		await withCommandSpy(async (commandIds) => {
			const outputChannel = { appendLine() {} } as unknown as vscode.OutputChannel;
			const { featureProbes } = wireFeatures(fakeContext(), quietLogger(), { ua: "test-agent", outputChannel });
			// Both features' wirings ran: the inline toggle command and the commit
			// command are their observable registrations (the inline provider
			// itself is enablement-gated and covered by its own wiring suite).
			assert.ok(
				commandIds.includes(INTERNAL_CMD.toggleInlineCompletionsLanguage),
				"the inline feature wiring did not run"
			);
			assert.ok(commandIds.includes(CMD.generateCommitMessage), "the commit feature wiring did not run");
			// The probe registry: exactly the features whose model rows carry a
			// Test button. A key added here must come with a real probe; a key
			// dropped here silently removes the button.
			assert.deepStrictEqual(Object.keys(featureProbes).sort(), ["inlineCompletions"]);
			assert.strictEqual(typeof featureProbes.inlineCompletions, "function");
		});
	});
});
