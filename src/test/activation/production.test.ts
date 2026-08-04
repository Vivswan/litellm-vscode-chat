import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { activate } from "../../extension";
import type { LiteLLMChatModelProvider } from "../../provider";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import { MODEL_CAPABILITIES_SETTING_KEY, MODEL_PARAMETERS_SETTING_KEY } from "../../shared/config/settings";
import {
	FINGERPRINT_SALT_SECRET,
	GROUP_MIGRATION_COMPLETE_KEY,
	HAS_SHOWN_WELCOME_KEY,
	MIGRATED_SERVER_LABELS_KEY,
	SERVER_REGISTRY_KEY,
} from "../../shared/config/storageKeys";
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
	// Snapshot taken inside the registration stub: what the modelParameters
	// setting held at the exact moment the provider registered.
	let modelParametersAtRegistration: Record<string, unknown> | undefined;
	let modelParametersBefore: Record<string, unknown> | undefined;

	suiteSetup(async function () {
		this.timeout(30000);
		const extension = expectDefined(
			vscode.extensions.getExtension("vivswan.litellm-vscode-chat"),
			"the dev extension must be installed in the test host"
		);
		assert.strictEqual(extension.isActive, false, "the real extension must stay inactive in this label");
		testCommandsBefore = (await vscode.commands.getCommands(true)).filter((id) => id.startsWith("litellm."));
		assert.deepStrictEqual(testCommandsBefore, [], "no litellm.* command may exist before the fake activation");

		// A label-scoped modelParameters key plus the persisted label map: the
		// pre-registration migration must rewrite the user setting before the
		// provider registers, which the registration stub below observes.
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		modelParametersBefore = config.inspect<Record<string, unknown>>(MODEL_PARAMETERS_SETTING_KEY)?.globalValue;
		await config.update(
			MODEL_PARAMETERS_SETTING_KEY,
			{ "Leftover/gpt-4": { temperature: 0.25 } },
			vscode.ConfigurationTarget.Global
		);

		storage = makeExtensionStorage({
			[GROUP_MIGRATION_COMPLETE_KEY]: true,
			[HAS_SHOWN_WELCOME_KEY]: true,
			[MIGRATED_SERVER_LABELS_KEY]: { "http://localhost:49997": ["Leftover"] },
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
			modelParametersAtRegistration = vscode.workspace
				.getConfiguration(CONFIG_SECTION)
				.get<Record<string, unknown>>(MODEL_PARAMETERS_SETTING_KEY);
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
		await vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.update(MODEL_PARAMETERS_SETTING_KEY, modelParametersBefore, vscode.ConfigurationTarget.Global);
	});

	test("production-mode activation registers no litellm._test.* commands", async () => {
		const litellmCommands = (await vscode.commands.getCommands(true)).filter((id) => id.startsWith("litellm."));
		assert.ok(litellmCommands.includes("litellm.manage"), "the fake activation must have registered its commands");
		const testOnly = litellmCommands.filter((id) => id.startsWith("litellm._test."));
		// The _test.* commands mutate storage and inject dashboard messages; in a
		// production build they would be callable by any extension.
		assert.deepStrictEqual(testOnly, []);
	});

	test("activation installs a durable per-install fingerprint salt", () => {
		// Every credential identity in the process is keyed by this salt, so
		// activation must have generated and stored it (this context started
		// with empty SecretStorage) before anything computed a fingerprint.
		assert.match(storage.secretStore.get(FINGERPRINT_SALT_SECRET) ?? "", /^[0-9a-f]{64}$/);
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

	test("the label-scoped modelParameters rewrite completes before the provider registers", () => {
		// The load-bearing half of the pre-registration phase: the copy pass is
		// awaited before registerLanguageModelChatProvider, so the session's
		// first request can never race it. The stub captured the setting at
		// registration time; the base-URL copy must already be there.
		const captured = expectDefined(
			modelParametersAtRegistration,
			"the registration stub must have captured the setting"
		);
		assert.deepStrictEqual(captured["http://localhost:49997/gpt-4"], { temperature: 0.25 });
		assert.deepStrictEqual(captured["Leftover/gpt-4"], { temperature: 0.25 }, "the original key is kept");
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

	/** The next model-change event from the captured provider, however the listener triggers it. */
	function nextModelChangeEvent(registered: LiteLLMChatModelProvider): Promise<void> {
		return new Promise<void>((resolve) => {
			const subscription = registered.onDidChangeLanguageModelChatInformation(() => {
				subscription.dispose();
				resolve();
			});
		});
	}

	/** Resolves once no model-change event has fired for 600ms (bounded at 5s), absorbing activation's own notifies. */
	async function eventsQuiesced(registered: LiteLLMChatModelProvider): Promise<void> {
		const deadline = Date.now() + 5000;
		let lastEvent = Date.now();
		const subscription = registered.onDidChangeLanguageModelChatInformation(() => {
			lastEvent = Date.now();
		});
		try {
			while (Date.now() - lastEvent < 600 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		} finally {
			subscription.dispose();
		}
	}

	test("a setting outside the listener's branches fires no model-change event", async function () {
		// Runs before the positive listener tests below, so no pending debounce
		// from their config restores can leak into this observation window.
		this.timeout(15000);
		const registered = expectDefined(provider, "activation must register the provider");
		// Activation itself owes one legitimate event this test must not count:
		// the catalog store's initialize() notifies when a bundled or cached
		// snapshot installs (a production `bundle` leaves dist/openrouter-models.json
		// behind, so local runs after one see that notify; artifact-less runs do
		// not). Absorb it by waiting for the event stream to go quiet first.
		await eventsQuiesced(registered);
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const before = config.inspect<boolean>("maskApiKeyInput")?.globalValue;
		let fired = 0;
		const subscription = registered.onDidChangeLanguageModelChatInformation(() => {
			fired += 1;
		});
		try {
			await config.update("maskApiKeyInput", false, vscode.ConfigurationTarget.Global);
			// Longer than the 400ms debounce: a mis-scoped branch would have
			// fired by now.
			await new Promise((resolve) => setTimeout(resolve, 1200));
			assert.strictEqual(fired, 0, "the listener notifies only for the model-affecting settings");
		} finally {
			subscription.dispose();
			await config.update("maskApiKeyInput", before, vscode.ConfigurationTarget.Global);
		}
	});

	test("a modelCapabilities edit fires the debounced model-change event", async function () {
		this.timeout(15000);
		const registered = expectDefined(provider, "activation must register the provider");
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const before = config.inspect<Record<string, unknown>>(MODEL_CAPABILITIES_SETTING_KEY)?.globalValue;
		const fired = nextModelChangeEvent(registered);
		try {
			// Capability overrides apply where models attach, so the listener's
			// notify is the whole re-registration story: no sync pass, no cache
			// clear, just the host re-resolving through the provider.
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
		const before = config.inspect<boolean>("openRouterCatalog.enabled")?.globalValue;
		const fired = nextModelChangeEvent(registered);
		try {
			// Opting out changes which capability fields the catalog may fill,
			// so registered models must re-resolve; the notify is the listener's
			// registration effect (the catalog store's refresh timer is its own).
			await config.update("openRouterCatalog.enabled", false, vscode.ConfigurationTarget.Global);
			await fired;
		} finally {
			await config.update("openRouterCatalog.enabled", before, vscode.ConfigurationTarget.Global);
		}
	});

	test("a deprecated default* token setting edit fires the debounced model-change event", async function () {
		this.timeout(15000);
		const registered = expectDefined(provider, "activation must register the provider");
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const before = config.inspect<number>("defaultContextLength")?.globalValue;
		const fired = nextModelChangeEvent(registered);
		try {
			// The trio's values are baked into cached discovery results; the
			// listener clears the injected discovery cache before this notify,
			// so the host's re-resolution reads through an empty cache.
			await config.update("defaultContextLength", 65536, vscode.ConfigurationTarget.Global);
			await fired;
		} finally {
			await config.update("defaultContextLength", before, vscode.ConfigurationTarget.Global);
		}
	});
});
