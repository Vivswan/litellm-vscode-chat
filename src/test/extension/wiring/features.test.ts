import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { wireFeatures } from "../../../extension/wiring/features";
import { Logger } from "../../../shared/logger";
import { fixedHeaderValue } from "../../../shared/util/headers";
import { REPO_ROOT } from "../../util/repoRoot";

function fakeContext(): vscode.ExtensionContext {
	const workspaceStore = new Map<string, unknown>();
	return {
		subscriptions: [] as vscode.Disposable[],
		secrets: {
			get: async () => undefined,
			store: async () => {},
			delete: async () => {},
			onDidChange: () => new vscode.Disposable(() => {}),
		},
		globalState: { keys: () => [], get: () => undefined, update: async () => {} },
		extensionUri: vscode.Uri.file(REPO_ROOT),
		// Review comments restore their threads from workspaceState at wiring time, so a context without one is not a
		// context this seam can run on.
		workspaceState: {
			get: (key: string) => workspaceStore.get(key),
			update: (key: string, value: unknown) => {
				workspaceStore.set(key, value);
				return Promise.resolve();
			},
			keys: () => [...workspaceStore.keys()],
		},
	} as unknown as vscode.ExtensionContext;
}

function quietLogger(): Logger {
	return new Logger({ info() {}, error() {} });
}

/**
 * Run `fn` with command registration stubbed instead of real: the shared host already runs the activated extension, so
 * a real registration of the same ids would collide across tests.
 */
async function withCommandSpy<T>(fn: () => T | Promise<T>): Promise<Awaited<T>> {
	const originalRegisterCommand = vscode.commands.registerCommand;
	const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;
	const originalRegisterMcpProvider = vscode.lm.registerMcpServerDefinitionProvider;
	(vscode.commands as Record<string, unknown>).registerCommand = () => new vscode.Disposable(() => {});
	(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = () => new vscode.Disposable(() => {});
	// The MCP provider registers unconditionally, so a real registration here would linger in the shared host for every
	// later suite.
	(vscode.lm as Record<string, unknown>).registerMcpServerDefinitionProvider = () => new vscode.Disposable(() => {});
	try {
		return await fn();
	} finally {
		(vscode.commands as Record<string, unknown>).registerCommand = originalRegisterCommand;
		(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = originalOnDidChangeConfiguration;
		(vscode.lm as Record<string, unknown>).registerMcpServerDefinitionProvider = originalRegisterMcpProvider;
	}
}

suite("extension/wiring features", () => {
	test("the render fixture's probe list is the shipped probe registry", async () => {
		await withCommandSpy(async () => {
			const outputChannel = { appendLine() {} } as unknown as vscode.OutputChannel;
			const { featureProbes } = wireFeatures(fakeContext(), quietLogger(), {
				ua: fixedHeaderValue("test-agent"),
				outputChannel,
			});
			// The render fixtures carry their OWN probe list, and a page rendered from a stale one under-represents the
			// shipped state - visual review then judges a page users never see. Read as TEXT because the host
			// tsconfig's rootDir is src/: the fixture lives under scripts/ and cannot be imported from here.
			//
			//   Pinned to the production set -> the next feature cannot drift it silently
			const fixtureSource = fs.readFileSync(
				path.join(REPO_ROOT, "scripts", "dev", "renderFixtures", "shared.ts"),
				"utf8"
			);
			const declared = /featureProbes:\s*\[([^\]]*)\]/.exec(fixtureSource);
			assert.ok(declared !== null, "the render fixture declares a featureProbes list");
			const fixtureProbes = [...(declared[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
			assert.deepStrictEqual(fixtureProbes.sort(), Object.keys(featureProbes).sort());
		});
	});
});
