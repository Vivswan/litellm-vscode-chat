/**
 * The features' composition point: one shared client, every feature wiring
 * called, and the probe registry the dashboard's Test buttons derive from. A
 * dropped feature-wiring call or a mistyped probe key must fail here rather
 * than ship green.
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { wireFeatures } from "../../../extension/wiring/features";
import { CMD, INTERNAL_CMD, PARTICIPANT_ID } from "../../../shared/config/commandIds";
import { Logger } from "../../../shared/logger";
import { REPO_ROOT } from "../../util/repoRoot";

function fakeContext(): vscode.ExtensionContext {
	return {
		subscriptions: [] as vscode.Disposable[],
		secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
		extensionUri: vscode.Uri.file(REPO_ROOT),
	} as unknown as vscode.ExtensionContext;
}

function quietLogger(): Logger {
	return new Logger({ info() {}, error() {} });
}

/** The participant command names package.json contributes, in manifest order. */
function contributedSlashCommandNames(): string[] {
	const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
		contributes: { chatParticipants?: readonly { id: string; commands?: readonly { name: string }[] }[] };
	};
	const participant = (manifest.contributes.chatParticipants ?? []).find((entry) => entry.id === PARTICIPANT_ID);
	assert.ok(participant !== undefined, `package.json contributes no chat participant with id ${PARTICIPANT_ID}`);
	return (participant.commands ?? []).map((command) => command.name);
}

/**
 * Run `fn` with command registration recorded instead of real: the shared host
 * already runs the activated extension, so a real registration of the same ids
 * would collide across tests. The participant registration is stubbed for the
 * same reason - two live participants sharing one id is a host-level conflict.
 */
async function withCommandSpy<T>(fn: (commandIds: string[]) => T | Promise<T>): Promise<Awaited<T>> {
	const commandIds: string[] = [];
	const originalRegisterCommand = vscode.commands.registerCommand;
	const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;
	const originalCreateChatParticipant = vscode.chat.createChatParticipant;
	(vscode.commands as Record<string, unknown>).registerCommand = (id: string) => {
		commandIds.push(id);
		return new vscode.Disposable(() => {});
	};
	(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = () => new vscode.Disposable(() => {});
	(vscode.chat as Record<string, unknown>).createChatParticipant = (id: string) =>
		({ id, dispose: () => {} }) as unknown as vscode.ChatParticipant;
	try {
		return await fn(commandIds);
	} finally {
		(vscode.commands as Record<string, unknown>).registerCommand = originalRegisterCommand;
		(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = originalOnDidChangeConfiguration;
		(vscode.chat as Record<string, unknown>).createChatParticipant = originalCreateChatParticipant;
	}
}

suite("extension/wiring features", () => {
	test("wireFeatures wires every feature and registers exactly the inline probe", async () => {
		await withCommandSpy(async (commandIds) => {
			const outputChannel = { appendLine() {} } as unknown as vscode.OutputChannel;
			const { featureProbes } = wireFeatures(fakeContext(), quietLogger(), {
				ua: "test-agent",
				outputChannel,
				getSnapshots: () => [],
			});
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

	test("the live slash-command table and the manifest's contributed commands are the same set", async () => {
		// The pin that survives the next feature: the host routes "/name" by the
		// MANIFEST, and the registry is what answers, so a command in one and not
		// the other is either a dead contribution or an unreachable handler. Read
		// off wireFeatures rather than the built-in table on purpose - a feature
		// registering through the seam is included here the day it lands.
		await withCommandSpy(async () => {
			const outputChannel = { appendLine() {} } as unknown as vscode.OutputChannel;
			const { chatParticipant } = wireFeatures(fakeContext(), quietLogger(), {
				ua: "test-agent",
				outputChannel,
				getSnapshots: () => [],
			});
			const live = chatParticipant.slashCommands
				.list()
				.map((command) => command.name)
				.sort();
			assert.deepStrictEqual(live, [...contributedSlashCommandNames()].sort());
		});
	});
});
