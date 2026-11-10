import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { activate } from "../../extension";
import { liveStatusItemSlots } from "../../extension/ui/status";
import type { LiteLLMChatModelProvider } from "../../provider";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import { MODEL_CAPABILITIES_SETTING_KEY } from "../../shared/config/settings";
import {
	apiKeySecret,
	FINGERPRINT_SALT_SECRET,
	GROUP_MIGRATION_COMPLETE_KEY,
	HAS_SHOWN_WELCOME_KEY,
	MIGRATED_SERVER_LABELS_KEY,
	SERVER_REGISTRY_KEY,
} from "../../shared/config/storageKeys";
import { catalogFixtureText } from "../catalogFixture";
import { blockCatalogNetwork } from "../hostApiHelpers";
import { expectDefined } from "../pureHelpers";
import { makeExtensionStorage } from "../testUtils";
import { REPO_ROOT } from "../util/repoRoot";

/**
 * Two production activations cannot overlap in one host, since a second activate() throws on duplicate command
 * registration, so the re-activation suite at the bottom disposes this one's subscriptions first.
 */
suite("production activation", () => {
	const infoMessages: string[] = [];
	const mementoWrites: string[] = [];
	const channelLines: string[] = [];
	const tempDirs: string[] = [];
	let provider: LiteLLMChatModelProvider | undefined;
	let registeredVendor: string | undefined;
	let testCommandsBefore: string[] = [];
	let storage: ReturnType<typeof makeExtensionStorage>;
	let context: vscode.ExtensionContext | undefined;
	let catalogNetworkGuard: vscode.Disposable | undefined;
	// Counted from inside the registration stub, so any event activation itself owes is observed from the first
	// possible moment.
	let modelChangeEventsSinceRegistration = 0;
	let modelChangeCounter: vscode.Disposable | undefined;

	/** A capturing output channel: the Logger only needs the LogSink half (info/error). */
	function fakeOutputChannel(lines: string[]): unknown {
		return {
			name: "LiteLLM",
			info: (message: string) => lines.push(message),
			error: (message: string) => lines.push(message),
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
		};
	}

	async function makeProductionContext(extensionStorage: ReturnType<typeof makeExtensionStorage>, tag: string) {
		// Fresh tmpdirs per activation: extensionUri decides whether a bundled dist/openrouter-models.json exists and
		// globalStorageUri whether a catalog cache does, so neither can be inherited state.
		const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), `lvt-activation-${tag}-ext-`));
		const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), `lvt-activation-${tag}-storage-`));
		tempDirs.push(extensionDir, storageDir);
		const fakeContext = {
			subscriptions: [] as vscode.Disposable[],
			extensionMode: vscode.ExtensionMode.Production,
			extensionUri: vscode.Uri.file(extensionDir),
			globalStorageUri: vscode.Uri.file(storageDir),
			globalState: extensionStorage.memento,
			secrets: extensionStorage.secrets,
			// No version field: activation must fall back to "unknown" instead of throwing.
			extension: { packageJSON: {} },
		} as unknown as vscode.ExtensionContext;
		return { context: fakeContext, extensionDir };
	}

	suiteSetup(async function () {
		this.timeout(30000);
		const extension = expectDefined(
			vscode.extensions.getExtension("vivswan.litellm-vscode-chat"),
			"the dev extension must be installed in the test host"
		);
		// Join the host's startup activation: the label's suppression env makes the real activate() inert, and awaiting
		// it removes the startup race.
		await extension.activate();
		testCommandsBefore = (await vscode.commands.getCommands(true)).filter((id) => id.startsWith("litellm."));
		assert.deepStrictEqual(testCommandsBefore, [], "the suppressed real activation must register nothing");

		// The catalog store arms a periodic refresh 60 seconds after activation;
		// a slow run must never let a live response install a snapshot mid-suite.
		catalogNetworkGuard = blockCatalogNetwork();

		storage = makeExtensionStorage({
			[GROUP_MIGRATION_COMPLETE_KEY]: true,
			[HAS_SHOWN_WELCOME_KEY]: true,
			[MIGRATED_SERVER_LABELS_KEY]: { "http://localhost:49997": ["Leftover"] },
			// Leftover legacy-registry state: the activation-time cleanup must delete the blob, the completion flag,
			// the label map (the retired label-scoped expansion's read source, unread since that expansion was
			// deleted), and the entry's stored secret.
			[SERVER_REGISTRY_KEY]: {
				version: 1,
				servers: [{ id: "srv-prod-1", label: "Leftover", baseUrl: "http://localhost:49997" }],
			},
		});
		storage.secretStore.set(apiKeySecret("srv-prod-1"), "sk-leftover");
		const originalUpdate = storage.memento.update.bind(storage.memento);
		(storage.memento as { update: (key: string, value: unknown) => Thenable<void> }).update = (key, value) => {
			mementoWrites.push(key);
			return originalUpdate(key, value);
		};
		(storage.memento as unknown as { keys?: () => readonly string[] }).keys = () => [...storage.mementoStore.keys()];

		// No dist/openrouter-models.json in the fresh extension dir: this activation is the artifact-ABSENT world.
		({ context } = await makeProductionContext(storage, "absent"));

		const origInfo = vscode.window.showInformationMessage;
		const origRegisterProvider = vscode.lm.registerLanguageModelChatProvider;
		const origCreateChannel = vscode.window.createOutputChannel;
		// The refresh test below asserts on logged lines.
		(vscode.window as Record<string, unknown>).createOutputChannel = () => fakeOutputChannel(channelLines);
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
			modelChangeCounter = registered.onDidChangeLanguageModelChatInformation(() => {
				modelChangeEventsSinceRegistration += 1;
			});
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

	suiteTeardown(async () => {
		// Dispose whichever activation is still live before touching its inputs: the catalog store's refresh timer must
		// die before the fetch guard lifts and the tmpdirs vanish under it.
		for (const disposable of context?.subscriptions.splice(0) ?? []) {
			disposable.dispose();
		}
		catalogNetworkGuard?.dispose();
		modelChangeCounter?.dispose();
		for (const dir of tempDirs.splice(0)) {
			await fs.rm(dir, { recursive: true, force: true }).then(undefined, () => {});
		}
	});

	test("the manifest declares onStartupFinished so activation never depends on Copilot Chat", async () => {
		// Without an activation event the extension only wakes when a chat client queries LM providers: a host without
		// Copilot Chat would get no migrations, no status bar, and no usage surfaces.
		const manifestPath = path.join(REPO_ROOT, "package.json");
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { activationEvents?: string[] };
		assert.ok(
			manifest.activationEvents?.includes("onStartupFinished"),
			"package.json activationEvents must include onStartupFinished"
		);
	});

	test("production-mode activation registers no litellm._test.* commands", async () => {
		const litellmCommands = (await vscode.commands.getCommands(true)).filter((id) => id.startsWith("litellm."));
		assert.ok(litellmCommands.includes("litellm.manage"), "the fake activation must have registered its commands");
		const testOnly = litellmCommands.filter((id) => id.startsWith("litellm._test."));
		// The _test.* commands mutate storage and inject dashboard messages; in a production build they would be
		// callable by any extension.
		assert.deepStrictEqual(testOnly, []);
	});

	test("activation with the default token-estimation mode loads no tokenizer rank data", () => {
		// The default chat.tokenEstimation ("auto") under an English UI language defers the o200k_base load to the
		// counter's non-Latin detection, so activation must not pull the multi-megabyte gpt-tokenizer modules in.
		const loaded = Object.keys(require.cache).filter((id) => id.includes(`${path.sep}gpt-tokenizer${path.sep}`));
		assert.deepStrictEqual(loaded, []);
	});

	test("activation installs a durable per-install fingerprint salt", () => {
		// Every credential identity in the process is keyed by this salt, and this context started with empty
		// SecretStorage.
		assert.match(storage.secretStore.get(FINGERPRINT_SALT_SECRET) ?? "", /^[0-9a-f]{64}$/);
	});

	test("activation claims each status-item slot exactly once", () => {
		// A second construction path for either slot self-heals into a replacement, leaving the count right but the log
		// noisy - which is why the replacement line must be absent too.
		assert.deepStrictEqual([...liveStatusItemSlots()].sort(), ["connection", "usage"]);
		assert.ok(
			!channelLines.some((line) => line.includes("status-item slot replaced")),
			"activation must not double-claim a status-item slot"
		);
	});

	test("activation with hasShownWelcome pre-seeded skips the globalState re-write", () => {
		// The load-bearing assertion: a regression to always-update would rewrite the flag on every activation. The
		// toast check is belt and braces.
		assert.ok(
			!mementoWrites.includes(HAS_SHOWN_WELCOME_KEY),
			"the already-true welcome flag must not be rewritten on every activation"
		);
		assert.deepStrictEqual(
			infoMessages.filter((message) => message.includes("Welcome")),
			[]
		);
	});

	test("activation deletes the leftover legacy-registry state and its stored secret", () => {
		assert.strictEqual(storage.memento.get(SERVER_REGISTRY_KEY), undefined);
		assert.strictEqual(storage.memento.get(GROUP_MIGRATION_COMPLETE_KEY), undefined);
		assert.strictEqual(storage.secretStore.get(apiKeySecret("srv-prod-1")), undefined);
		assert.strictEqual(storage.memento.get(MIGRATED_SERVER_LABELS_KEY), undefined);
	});

	test("the group-agnostic refresh serves no models", async () => {
		assert.strictEqual(registeredVendor, "litellm");
		const registered = expectDefined(provider, "activation must register the provider");

		channelLines.length = 0;
		const token = new vscode.CancellationTokenSource().token;
		const models = await registered.provideLanguageModelChatInformation({ silent: true }, token);
		// Every model must reach the picker through a per-group call carrying its group's resolved connection; the
		// configuration-less refresh serves none.
		assert.deepStrictEqual(models, []);
		assert.deepStrictEqual(
			registered.getServerSnapshots().map((snapshot) => snapshot.status.label),
			[],
			"the group-agnostic refresh must not touch any server"
		);
		// The discriminating half, since a failed discovery would also yield no models: the group-agnostic path logs
		// its serves-nothing outcome and never reaches a fetch.
		assert.ok(
			channelLines.some((line) => line.includes("Serving no models for the group-agnostic refresh")),
			`expected the serves-nothing line in: ${JSON.stringify(channelLines)}`
		);
		assert.ok(
			!channelLines.some((line) => line.includes("Fetching models")),
			"a broken contract would fetch without a group configuration"
		);
	});

	function nextModelChangeEvent(registered: LiteLLMChatModelProvider): Promise<void> {
		return new Promise<void>((resolve) => {
			const subscription = registered.onDidChangeLanguageModelChatInformation(() => {
				subscription.dispose();
				resolve();
			});
		});
	}

	test("an artifact-absent activation owes no model-change event", async function () {
		// Runs before the positive listener tests below, whose config edits would legitimately increment the counter
		// this test consumes.
		this.timeout(15000);
		expectDefined(provider, "activation must register the provider");
		// By construction nothing can fire here: the fake context saw neither a catalog cache nor a bundled artifact,
		// and no model-affecting edit has happened since registration. The settle makes a regression observable past
		// the 400ms debounce even on a runner that arrives immediately.
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.strictEqual(
			modelChangeEventsSinceRegistration,
			0,
			"activation with no catalog artifact must not fire any model-change event (catalog install is the only producer this controlled world permits)"
		);
		modelChangeCounter?.dispose();
	});

	test("a setting outside the listener's branches fires no model-change event", async function () {
		// Runs before the positive listener tests below, so no pending debounce from their config restores can leak
		// into this observation window.
		this.timeout(15000);
		const registered = expectDefined(provider, "activation must register the provider");
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const before = config.inspect<boolean>("ui.maskSecretInputs")?.globalValue;
		let fired = 0;
		const subscription = registered.onDidChangeLanguageModelChatInformation(() => {
			fired += 1;
		});
		try {
			await config.update("ui.maskSecretInputs", false, vscode.ConfigurationTarget.Global);
			// Longer than the 400ms debounce: a wrongly scoped branch would have fired by now.
			await new Promise((resolve) => setTimeout(resolve, 1200));
			assert.strictEqual(fired, 0, "the listener notifies only for the model-affecting settings");
		} finally {
			subscription.dispose();
			await config.update("ui.maskSecretInputs", before, vscode.ConfigurationTarget.Global);
		}
	});

	test("a modelCapabilities edit fires the debounced model-change event", async function () {
		this.timeout(15000);
		const registered = expectDefined(provider, "activation must register the provider");
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const before = config.inspect<Record<string, unknown>>(MODEL_CAPABILITIES_SETTING_KEY)?.globalValue;
		const fired = nextModelChangeEvent(registered);
		try {
			// Capability overrides apply where models attach, so the listener's notify is the whole re-registration
			// story: no sync pass, no cache clear, just the host re-resolving through the provider.
			await config.update(
				MODEL_CAPABILITIES_SETTING_KEY,
				{ "gpt-4": { supports_vision: true } },
				vscode.ConfigurationTarget.Global
			);
			await fired;
		} finally {
			await config.update(MODEL_CAPABILITIES_SETTING_KEY, before, vscode.ConfigurationTarget.Global);
		}
	});

	test("an OpenRouter catalog opt-out edit fires the debounced model-change event", async function () {
		this.timeout(15000);
		const registered = expectDefined(provider, "activation must register the provider");
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const before = config.inspect<boolean>("models.openRouterCatalog")?.globalValue;
		const fired = nextModelChangeEvent(registered);
		try {
			// Opting out changes which capability fields the catalog may fill, so registered models must re-resolve.
			await config.update("models.openRouterCatalog", false, vscode.ConfigurationTarget.Global);
			await fired;
		} finally {
			await config.update("models.openRouterCatalog", before, vscode.ConfigurationTarget.Global);
		}
	});

	// Mocha runs a suite's own tests before its nested suites, so this artifact-PRESENT world runs last: its setup
	// disposes the first activation wholesale (unregistering every litellm.* command), which is the only way a second
	// activate() can run in the same host.
	suite("re-activation with a bundled catalog artifact", () => {
		suiteSetup(() => {
			for (const disposable of expectDefined(context, "the first activation must have run").subscriptions.splice(0)) {
				disposable.dispose();
			}
		});

		test("a bundled dist/openrouter-models.json installs at activation and fires the catalog notify", async function () {
			this.timeout(30000);
			const rerunStorage = makeExtensionStorage({
				[HAS_SHOWN_WELCOME_KEY]: true,
			});
			(rerunStorage.memento as unknown as { keys?: () => readonly string[] }).keys = () => [
				...rerunStorage.mementoStore.keys(),
			];
			const { context: rerunContext, extensionDir } = await makeProductionContext(rerunStorage, "present");
			await fs.mkdir(path.join(extensionDir, "dist"), { recursive: true });
			await fs.writeFile(path.join(extensionDir, "dist", "openrouter-models.json"), catalogFixtureText());

			const origInfo = vscode.window.showInformationMessage;
			const origRegisterProvider = vscode.lm.registerLanguageModelChatProvider;
			const origCreateChannel = vscode.window.createOutputChannel;
			(vscode.window as Record<string, unknown>).createOutputChannel = () => fakeOutputChannel([]);
			(vscode.window as Record<string, unknown>).showInformationMessage = async () => undefined;
			let notified: Promise<void> | undefined;
			(vscode.lm as Record<string, unknown>).registerLanguageModelChatProvider = (
				_vendor: string,
				registered: LiteLLMChatModelProvider
			) => {
				// Subscribed inside the stub: initialize() is fire-and-forget, so its notify races activate()'s return.
				notified = nextModelChangeEvent(registered);
				return { dispose() {} };
			};
			let notifyDeadline: ReturnType<typeof setTimeout> | undefined;
			try {
				await activate(rerunContext);
				// The artifact-present contract: the bundled snapshot installed, so activation owes the catalog notify.
				// Nothing else can produce one here, and the artifact-absent twin above pins the zero-event side, so
				// the pair discriminates.
				await Promise.race([
					expectDefined(notified, "re-activation must register the provider"),
					new Promise<never>((_, reject) => {
						notifyDeadline = setTimeout(
							() => reject(new Error("the bundled catalog artifact must fire the catalog-install notify")),
							15000
						);
					}),
				]);
			} finally {
				if (notifyDeadline !== undefined) {
					clearTimeout(notifyDeadline);
				}
				(vscode.window as Record<string, unknown>).showInformationMessage = origInfo;
				(vscode.lm as Record<string, unknown>).registerLanguageModelChatProvider = origRegisterProvider;
				(vscode.window as Record<string, unknown>).createOutputChannel = origCreateChannel;
				for (const disposable of rerunContext.subscriptions.splice(0)) {
					disposable.dispose();
				}
			}
		});
	});
});
