import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { activate } from "../../extension";
import type { LiteLLMChatModelProvider } from "../../provider";
import { GROUP_MIGRATION_COMPLETE_KEY, HAS_SHOWN_WELCOME_KEY, SERVER_REGISTRY_KEY } from "../../shared/storageKeys";
import { expectDefined, makeExtensionStorage } from "../testUtils";

/**
 * Production-mode activation, run in its own vscode-test label (see
 * .vscode-test.mjs): the compiled activate() is called ONCE with a fake
 * ExtensionContext whose extensionMode is Production, while the real
 * extension stays inactive. Hard limits of this harness: a second activate()
 * throws on duplicate command registration, and executing any contributed
 * litellm.* command would implicitly activate the real extension and collide
 * the same way - so these tests only observe, never dispatch commands.
 * vscode.lm.registerLanguageModelChatProvider is stubbed to capture the
 * provider instance (keeping the host's vendor registry untouched).
 */
suite("production activation", () => {
	const infoMessages: string[] = [];
	const mementoWrites: string[] = [];
	const channelLines: string[] = [];
	let provider: LiteLLMChatModelProvider | undefined;
	let registeredVendor: string | undefined;
	let testCommandsBefore: string[] = [];
	let storage: ReturnType<typeof makeExtensionStorage>;

	suiteSetup(async function () {
		this.timeout(30000);
		const extension = expectDefined(
			vscode.extensions.getExtension("vivswan.litellm-vscode-chat"),
			"the dev extension must be installed in the test host"
		);
		assert.strictEqual(extension.isActive, false, "the real extension must stay inactive in this label");
		testCommandsBefore = (await vscode.commands.getCommands(true)).filter((id) => id.startsWith("litellm."));
		assert.deepStrictEqual(testCommandsBefore, [], "no litellm.* command may exist before the fake activation");

		storage = makeExtensionStorage({
			[GROUP_MIGRATION_COMPLETE_KEY]: true,
			[HAS_SHOWN_WELCOME_KEY]: true,
			// A leftover registry server: after the migration completed, the
			// groupless refresh must NOT serve it in production.
			[SERVER_REGISTRY_KEY]: {
				version: 1,
				servers: [{ id: "srv-prod-1", label: "Leftover", baseUrl: "http://localhost:49997" }],
			},
		});
		const originalUpdate = storage.memento.update.bind(storage.memento);
		(storage.memento as { update: (key: string, value: unknown) => Thenable<void> }).update = (key, value) => {
			mementoWrites.push(key);
			return originalUpdate(key, value);
		};
		(storage.memento as unknown as { keys?: () => readonly string[] }).keys = () => [...storage.mementoStore.keys()];

		const context = {
			subscriptions: [] as vscode.Disposable[],
			extensionMode: vscode.ExtensionMode.Production,
			extensionUri: extension.extensionUri,
			globalStorageUri: vscode.Uri.file(path.join(os.tmpdir(), `lvt-activation-${process.pid}`)),
			globalState: storage.memento,
			secrets: storage.secrets,
			// No version field: activation must fall back to "unknown" instead of throwing.
			extension: { packageJSON: {} },
		} as unknown as vscode.ExtensionContext;

		const origInfo = vscode.window.showInformationMessage;
		const origRegisterProvider = vscode.lm.registerLanguageModelChatProvider;
		const origCreateChannel = vscode.window.createOutputChannel;
		// A capturing output channel: the Logger only needs the LogSink half
		// (info/error), and the refresh test below asserts on logged lines.
		(vscode.window as Record<string, unknown>).createOutputChannel = () => ({
			name: "LiteLLM",
			info: (message: string) => channelLines.push(message),
			error: (message: string) => channelLines.push(message),
			warn: () => {},
			debug: () => {},
			trace: () => {},
			append: () => {},
			appendLine: () => {},
			replace: () => {},
			clear: () => {},
			show: () => {},
			hide: () => {},
			dispose: () => {},
		});
		(vscode.window as Record<string, unknown>).showInformationMessage = async (message: string) => {
			infoMessages.push(message);
			return undefined;
		};
		(vscode.lm as Record<string, unknown>).registerLanguageModelChatProvider = (
			vendor: string,
			registered: LiteLLMChatModelProvider
		) => {
			registeredVendor = vendor;
			provider = registered;
			return { dispose() {} };
		};
		try {
			await activate(context);
		} finally {
			(vscode.window as Record<string, unknown>).showInformationMessage = origInfo;
			(vscode.lm as Record<string, unknown>).registerLanguageModelChatProvider = origRegisterProvider;
			(vscode.window as Record<string, unknown>).createOutputChannel = origCreateChannel;
		}
	});

	test("production-mode activation registers no litellm._test.* commands", async () => {
		const litellmCommands = (await vscode.commands.getCommands(true)).filter((id) => id.startsWith("litellm."));
		assert.ok(litellmCommands.includes("litellm.manage"), "the fake activation must have registered its commands");
		const testOnly = litellmCommands.filter((id) => id.startsWith("litellm._test."));
		// The _test.* commands mutate storage and inject dashboard messages; in a
		// production build they would be callable by any extension.
		assert.deepStrictEqual(testOnly, []);
	});

	test("activation with hasShownWelcome pre-seeded skips the globalState re-write", () => {
		// The load-bearing assertion: a regression to always-update would
		// rewrite the flag on every activation. The toast check below is only
		// belt and braces - the seeded registry server independently
		// suppresses the welcome toast, so its absence cannot prove the
		// hasShownWelcome gate on its own.
		assert.ok(
			!mementoWrites.includes(HAS_SHOWN_WELCOME_KEY),
			"the already-true welcome flag must not be rewritten on every activation"
		);
		assert.deepStrictEqual(
			infoMessages.filter((message) => message.includes("Welcome")),
			[]
		);
	});

	test("production activation with migration complete disables the groupless registry refresh", async () => {
		assert.strictEqual(registeredVendor, "litellm");
		const registered = expectDefined(provider, "activation must register the provider");

		// The activation-time migration may have rewritten the registry blob
		// (today's orphan cleanup deletes servers it does not recognize; the
		// evidence-based rework keeps them). Depend on neither: re-seed the
		// fixture under a strictly newer version - the registry adopts newer
		// blobs on its next read - and prove it is present immediately before
		// the refresh, so the refusal below judges a POPULATED registry.
		await storage.memento.update(SERVER_REGISTRY_KEY, {
			version: 1000,
			servers: [{ id: "srv-prod-1", label: "Leftover", baseUrl: "http://localhost:49997" }],
		});
		assert.ok(
			JSON.stringify(storage.mementoStore.get(SERVER_REGISTRY_KEY)).includes("Leftover"),
			"the seeded server must exist immediately before the refresh"
		);

		channelLines.length = 0;
		const token = new vscode.CancellationTokenSource().token;
		const models = await registered.provideLanguageModelChatInformation({ silent: true }, token);
		// Serving "Leftover" would double-list every server beside its
		// provider group; the refresh must not even attempt its discovery.
		assert.deepStrictEqual(models, []);
		assert.deepStrictEqual(
			registered.getServerSnapshots().map((snapshot) => snapshot.status.label),
			[],
			"the groupless refresh must not touch the migrated registry's servers"
		);
		// The discriminating half (a failed discovery would also yield no
		// models, so the empties above cannot prove the gate alone): the gated
		// path logs its refusal and never reaches the fetch.
		assert.ok(
			channelLines.some((line) => line.includes("serving no models for the group-agnostic refresh")),
			`expected the migrated-registry refusal in: ${JSON.stringify(channelLines)}`
		);
		assert.ok(
			!channelLines.some((line) => line.includes("Fetching models from servers")),
			"a broken gate would fetch the seeded registry server"
		);
	});
});
