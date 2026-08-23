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
import { CMD, INTERNAL_CMD, MCP_PROVIDER_ID, PARTICIPANT_ID } from "../../../shared/config/commandIds";
import { Logger } from "../../../shared/logger";
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
		// Review comments restore their threads from workspaceState at wiring
		// time, so a context without one is not a context this seam can run on.
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
async function withCommandSpy<T>(fn: (registeredIds: string[]) => T | Promise<T>): Promise<Awaited<T>> {
	const registeredIds: string[] = [];
	const originalRegisterCommand = vscode.commands.registerCommand;
	const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;
	const originalCreateChatParticipant = vscode.chat.createChatParticipant;
	const originalRegisterMcpProvider = vscode.lm.registerMcpServerDefinitionProvider;
	(vscode.commands as Record<string, unknown>).registerCommand = (id: string) => {
		registeredIds.push(id);
		return new vscode.Disposable(() => {});
	};
	(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = () => new vscode.Disposable(() => {});
	(vscode.chat as Record<string, unknown>).createChatParticipant = (id: string) =>
		({ id, dispose: () => {} }) as unknown as vscode.ChatParticipant;
	// The MCP provider registers unconditionally, so a real registration here
	// would linger in the shared host for every later suite.
	(vscode.lm as Record<string, unknown>).registerMcpServerDefinitionProvider = (id: string) => {
		registeredIds.push(id);
		return new vscode.Disposable(() => {});
	};
	try {
		return await fn(registeredIds);
	} finally {
		(vscode.commands as Record<string, unknown>).registerCommand = originalRegisterCommand;
		(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = originalOnDidChangeConfiguration;
		(vscode.chat as Record<string, unknown>).createChatParticipant = originalCreateChatParticipant;
		(vscode.lm as Record<string, unknown>).registerMcpServerDefinitionProvider = originalRegisterMcpProvider;
	}
}

suite("extension/wiring features", () => {
	test("wireFeatures wires every feature and registers exactly the shipped probes", async () => {
		await withCommandSpy(async (registeredIds) => {
			const outputChannel = { appendLine() {} } as unknown as vscode.OutputChannel;
			const { featureProbes } = wireFeatures(fakeContext(), quietLogger(), {
				ua: "test-agent",
				outputChannel,
				getSnapshots: () => [],
			});
			// Every feature's wiring ran: the inline toggle command, the commit
			// command, the PR command, the review commands, the MCP provider
			// registration, and the quick-fix chat command are their observable
			// registrations here (the inline provider, the consult tool, the PR
			// integration, the review comment controller and the code-action
			// provider are enablement-gated and covered by their own
			// wiring suites, so with the defaults they stay unregistered; the
			// participant is proven by the slash-command test below).
			assert.ok(
				registeredIds.includes(INTERNAL_CMD.toggleInlineCompletionsLanguage),
				"the inline feature wiring did not run"
			);
			assert.ok(registeredIds.includes(CMD.generateCommitMessage), "the commit feature wiring did not run");
			assert.ok(registeredIds.includes(CMD.generatePrDescription), "the PR feature wiring did not run");
			assert.ok(registeredIds.includes(CMD.reviewChanges), "the review comments feature wiring did not run");
			assert.ok(registeredIds.includes(MCP_PROVIDER_ID), "the MCP feature wiring did not run");
			assert.ok(registeredIds.includes(INTERNAL_CMD.quickFixChat), "the quick-fix feature wiring did not run");
			// The probe registry: exactly the features whose model rows carry a
			// Test button. A key added here must come with a real probe; a key
			// dropped here silently removes the button.
			assert.deepStrictEqual(Object.keys(featureProbes).sort(), [
				"commitGeneration",
				"consultTool",
				"inlineCompletions",
				"prGeneration",
				"quickFix",
				"reviewComments",
			]);
			assert.strictEqual(typeof featureProbes.inlineCompletions, "function");
			assert.strictEqual(typeof featureProbes.commitGeneration, "function");
			assert.strictEqual(typeof featureProbes.consultTool, "function");
			assert.strictEqual(typeof featureProbes.prGeneration, "function");
			assert.strictEqual(typeof featureProbes.quickFix, "function");
			assert.strictEqual(typeof featureProbes.reviewComments, "function");
			// The render fixtures carry their OWN probe list, and a page rendered
			// from a stale one under-represents the shipped state - visual review
			// then judges a page users never see. Pinned to the production set so
			// the next feature cannot drift it silently.
			// Read as TEXT because the host tsconfig's rootDir is src/: the fixture
			// lives under scripts/ and cannot be imported from here.
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

	test("participant readiness reaches the quick fixes through the seam, refusal included", async () => {
		// The whole chat path hangs off this predicate, and every quickFix test
		// injects its own - so without this the producer and the wiring that
		// carries it are unpinned, and a predicate that merely read the enable
		// setting would ship green.
		await withCommandSpy(async () => {
			const outputChannel = { appendLine() {} } as unknown as vscode.OutputChannel;
			const live = wireFeatures(fakeContext(), quietLogger(), {
				ua: "test-agent",
				outputChannel,
				getSnapshots: () => [],
			});
			assert.strictEqual(live.chatParticipant.isRegistered(), true, "a wired participant reads as ready");
		});

		await withCommandSpy(async () => {
			// Inside the spy, which installs its own working stub on entry and
			// restores the real API on exit: refusing has to be the LAST word.
			(vscode.chat as Record<string, unknown>).createChatParticipant = () => {
				throw new Error("id already registered");
			};
			const outputChannel = { appendLine() {} } as unknown as vscode.OutputChannel;
			const refused = wireFeatures(fakeContext(), quietLogger(), {
				ua: "test-agent",
				outputChannel,
				getSnapshots: () => [],
			});
			assert.strictEqual(
				refused.chatParticipant.isRegistered(),
				false,
				"a refused registration must not read as ready, whatever the setting says"
			);
		});
	});

	test("the seam registration reaches the live table: /fix and /explain answer after wiring", async () => {
		// The runtime half of the quick-fix seam contract. The set-equality pin
		// below would also fail if this registration went missing, but only
		// together with the manifest - this one names the two commands, so a
		// dropped registerQuickFixSlashCommands call reads as what it is.
		await withCommandSpy(async () => {
			const outputChannel = { appendLine() {} } as unknown as vscode.OutputChannel;
			const { chatParticipant } = wireFeatures(fakeContext(), quietLogger(), {
				ua: "test-agent",
				outputChannel,
				getSnapshots: () => [],
			});
			for (const name of ["fix", "explain"]) {
				assert.ok(
					chatParticipant.slashCommands.find(name) !== undefined,
					`/${name} is contributed but nothing registered it into the live table`
				);
			}
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
