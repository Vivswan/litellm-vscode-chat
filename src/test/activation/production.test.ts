import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { activate } from "../../extension";
import { applySettingsRedesign, readRedesignSnapshot } from "../../extension/migrations/settingsRedesign/apply";
import { planSettingsRedesign } from "../../extension/migrations/settingsRedesign/transform";
import { liveStatusItemSlots } from "../../extension/ui/status";
import type { LiteLLMChatModelProvider } from "../../provider";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import { MODEL_CAPABILITIES_SETTING_KEY, MODEL_PARAMETERS_SETTING_KEY } from "../../shared/config/settings";
import {
	apiKeySecret,
	FINGERPRINT_SALT_SECRET,
	GROUP_MIGRATION_COMPLETE_KEY,
	HAS_SHOWN_WELCOME_KEY,
	MIGRATED_SERVER_LABELS_KEY,
	PARKED_GLOBAL_HEADERS_KEY,
	SERVER_REGISTRY_KEY,
} from "../../shared/config/storageKeys";
import { catalogFixtureText } from "../catalogFixture";
import { blockCatalogNetwork } from "../hostApiHelpers";
import { expectDefined } from "../pureHelpers";
import { makeExtensionStorage } from "../testUtils";

/**
 * Production-mode activation in its own vscode-test label: the compiled
 * activate() is called ONCE with a fake ExtensionContext whose extensionMode is
 * Production, while the real extension stays inactive. A second activate()
 * throws on duplicate command registration (the artifact-present suite at the
 * bottom re-activates only after disposing this activation wholesale), and
 * executing any contributed litellm.* command would activate the real extension
 * and collide the same way - so these tests only observe, never dispatch.
 *
 * Catalog inputs are controlled, never inherited: the fake context's
 * extensionUri and globalStorageUri are fresh tmpdirs, so whether
 * dist/openrouter-models.json exists is this file's choice per activation, and
 * the OpenRouter fetch is blocked so no live snapshot can swap in.
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
	// Counted from inside the registration stub, so any event activation itself
	// owes is observed from the first possible moment.
	let modelChangeEventsSinceRegistration = 0;
	let modelChangeCounter: vscode.Disposable | undefined;
	// What the modelParameters setting held at the exact moment of registration.
	let modelParametersAtRegistration: Record<string, unknown> | undefined;
	let modelParametersBefore: Record<string, unknown> | undefined;

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

	/** A fake Production-mode ExtensionContext over fresh tmpdirs and the given storage. */
	async function makeProductionContext(extensionStorage: ReturnType<typeof makeExtensionStorage>, tag: string) {
		// Fresh tmpdirs per activation: extensionUri decides whether a bundled
		// dist/openrouter-models.json exists and globalStorageUri whether a
		// catalog cache does, so neither can be inherited state.
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
		// Join the host's startup activation: the label's suppression env makes
		// the real activate() inert, and awaiting it removes the startup race.
		await extension.activate();
		testCommandsBefore = (await vscode.commands.getCommands(true)).filter((id) => id.startsWith("litellm."));
		assert.deepStrictEqual(testCommandsBefore, [], "the suppressed real activation must register nothing");

		// The catalog store arms a periodic refresh 60 seconds after activation;
		// a slow run must never let a live response install a snapshot mid-suite.
		catalogNetworkGuard = blockCatalogNetwork();

		// A modelParameters key under the LEGACY id: the awaited migrations must
		// rename the setting (starring implicit-prefix keys) before the provider
		// registers. Seeded through settings.json, since the host refuses value
		// writes to the uncontributed legacy id.
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		modelParametersBefore = config.inspect<Record<string, unknown>>(MODEL_PARAMETERS_SETTING_KEY)?.globalValue;
		await withExternalSettingsEdit(
			(settings) => {
				settings[`${CONFIG_SECTION}.modelParameters`] = { "Leftover/gpt-4": { temperature: 0.25 } };
			},
			() => vscode.workspace.getConfiguration(CONFIG_SECTION).inspect("modelParameters")?.globalValue !== undefined
		);

		storage = makeExtensionStorage({
			[GROUP_MIGRATION_COMPLETE_KEY]: true,
			[HAS_SHOWN_WELCOME_KEY]: true,
			[MIGRATED_SERVER_LABELS_KEY]: { "http://localhost:49997": ["Leftover"] },
			// Leftover legacy-registry state: the activation-time cleanup must
			// delete the blob, the completion flag, the label map (the retired
			// label-scoped expansion's read source, unread since that expansion was
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

		// No dist/openrouter-models.json in the fresh extension dir: this
		// activation is the artifact-ABSENT world.
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
		// Dispose whichever activation is still live before touching its inputs:
		// the catalog store's refresh timer must die before the fetch guard lifts
		// and the tmpdirs vanish under it.
		for (const disposable of context?.subscriptions.splice(0) ?? []) {
			disposable.dispose();
		}
		catalogNetworkGuard?.dispose();
		modelChangeCounter?.dispose();
		for (const dir of tempDirs.splice(0)) {
			await fs.rm(dir, { recursive: true, force: true }).then(undefined, () => {});
		}
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		await config.update(MODEL_PARAMETERS_SETTING_KEY, modelParametersBefore, vscode.ConfigurationTarget.Global);
		// The legacy seed is consumed by the rename at activation; clear any
		// remnant a failed run could leave (deletions are exempt from the
		// unknown-key refusal).
		await config.update("modelParameters", undefined, vscode.ConfigurationTarget.Global).then(undefined, () => {});
	});

	test("the manifest declares onStartupFinished so activation never depends on Copilot Chat", async () => {
		// Without an activation event the extension only wakes when a chat client
		// queries LM providers: a host without Copilot Chat would get no
		// migrations, no status bar, and no usage surfaces.
		const manifestPath = path.resolve(__dirname, "..", "..", "..", "package.json");
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
		// The _test.* commands mutate storage and inject dashboard messages; in a
		// production build they would be callable by any extension.
		assert.deepStrictEqual(testOnly, []);
	});

	test("activation with the default token-estimation mode loads no tokenizer rank data", () => {
		// The default chat.tokenEstimation ("auto") under an English UI language
		// defers the o200k_base load to the counter's non-Latin detection, so
		// activation must not pull the multi-megabyte gpt-tokenizer modules in.
		const loaded = Object.keys(require.cache).filter((id) => id.includes(`${path.sep}gpt-tokenizer${path.sep}`));
		assert.deepStrictEqual(loaded, []);
	});

	test("activation installs a durable per-install fingerprint salt", () => {
		// Every credential identity in the process is keyed by this salt, and this
		// context started with empty SecretStorage.
		assert.match(storage.secretStore.get(FINGERPRINT_SALT_SECRET) ?? "", /^[0-9a-f]{64}$/);
	});

	test("activation claims each status-item slot exactly once", () => {
		// The real composed wiring path: after activate(), the slot registry holds
		// exactly the connection and usage items. A second construction path for
		// either slot self-heals into a replacement, leaving the count right but
		// the log noisy - which is why the replacement line must be absent too.
		assert.deepStrictEqual([...liveStatusItemSlots()].sort(), ["connection", "usage"]);
		assert.ok(
			!channelLines.some((line) => line.includes("status-item slot replaced")),
			"activation must not double-claim a status-item slot"
		);
	});

	test("activation with hasShownWelcome pre-seeded skips the globalState re-write", () => {
		// The load-bearing assertion: a regression to always-update would rewrite
		// the flag on every activation. The toast check is belt and braces.
		assert.ok(
			!mementoWrites.includes(HAS_SHOWN_WELCOME_KEY),
			"the already-true welcome flag must not be rewritten on every activation"
		);
		assert.deepStrictEqual(
			infoMessages.filter((message) => message.includes("Welcome")),
			[]
		);
	});

	test("the settings rename completes before the provider registers", () => {
		// The settings-redesign rename is awaited before
		// registerLanguageModelChatProvider, so the session's first request can
		// never race it: the legacy key arrives star-appended into an explicit
		// matcher. The deleted label-scoped expansion must add nothing: the
		// seeded label map produces no base-URL copy.
		const captured = expectDefined(
			modelParametersAtRegistration,
			"the registration stub must have captured the setting"
		);
		assert.deepStrictEqual(captured["Leftover/gpt-4*"], { temperature: 0.25 }, "the original key survives, starred");
		assert.strictEqual(
			captured["http://localhost:49997/gpt-4"],
			undefined,
			"the deleted label-scoped expansion must not resurrect base-URL copies"
		);
	});

	test("activation deletes the leftover legacy-registry state and its stored secret", () => {
		// The one-shot cleanup migration, exercised through the real composed
		// activation: the seeded blob, the completion flag, the label map, and
		// the entry's per-server secret are gone. The label map's deletion is
		// the inverse of the retired survival pin - its last reader, the
		// label-scoped expansion, is deleted.
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
		// Every model must reach the picker through a per-group call carrying its
		// group's resolved connection; the configuration-less refresh serves none.
		assert.deepStrictEqual(models, []);
		assert.deepStrictEqual(
			registered.getServerSnapshots().map((snapshot) => snapshot.status.label),
			[],
			"the group-agnostic refresh must not touch any server"
		);
		// The discriminating half, since a failed discovery would also yield no
		// models: the group-agnostic path logs its serves-nothing outcome and
		// never reaches a fetch.
		assert.ok(
			channelLines.some((line) => line.includes("Serving no models for the group-agnostic refresh")),
			`expected the serves-nothing line in: ${JSON.stringify(channelLines)}`
		);
		assert.ok(
			!channelLines.some((line) => line.includes("Fetching models")),
			"a broken contract would fetch without a group configuration"
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

	test("an artifact-absent activation owes no model-change event", async function () {
		// Runs before the positive listener tests below, whose config edits
		// would legitimately increment the counter this test consumes.
		this.timeout(15000);
		expectDefined(provider, "activation must register the provider");
		// By construction nothing can fire here: the fake context saw neither a
		// catalog cache nor a bundled artifact, and no model-affecting edit has
		// happened since registration. The settle makes a regression observable
		// past the 400ms debounce even on a runner that arrives immediately.
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.strictEqual(
			modelChangeEventsSinceRegistration,
			0,
			"activation with no catalog artifact must not fire any model-change event (catalog install is the only producer this controlled world permits)"
		);
		modelChangeCounter?.dispose();
	});

	test("a setting outside the listener's branches fires no model-change event", async function () {
		// Runs before the positive listener tests below, so no pending debounce
		// from their config restores can leak into this observation window.
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
			// Longer than the 400ms debounce: a mis-scoped branch would have
			// fired by now.
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
		const before = config.inspect<boolean>("models.openRouterCatalog")?.globalValue;
		const fired = nextModelChangeEvent(registered);
		try {
			// Opting out changes which capability fields the catalog may fill, so
			// registered models must re-resolve.
			await config.update("models.openRouterCatalog", false, vscode.ConfigurationTarget.Global);
			await fired;
		} finally {
			await config.update("models.openRouterCatalog", before, vscode.ConfigurationTarget.Global);
		}
	});

	/**
	 * This host's user settings.json, located by content: a unique sentinel is
	 * written through the configuration API and the per-label user-data dirs are
	 * scanned for the file carrying it. The layout `<tmp>/lvt/<pid>/<label>` is
	 * .vscode-test.mjs's and this scan is the one other place that knows it, so
	 * the two move together. Content matching rather than newest-mtime: a
	 * concurrent run of another worktree has the same shape under its own pid.
	 */
	async function locateUserSettingsFile(sentinel: string): Promise<string> {
		const label = "activation-production";
		const runs = path.join(os.tmpdir(), "lvt");
		const roots = process.env.VSCODE_TEST_USER_DATA_DIR
			? [path.join(process.env.VSCODE_TEST_USER_DATA_DIR, label)]
			: (await fs.readdir(runs).catch(() => []))
					.filter((name) => /^\d+$/.test(name))
					.map((name) => path.join(runs, name, label));
		for (const root of roots) {
			const candidate = path.join(root, "User", "settings.json");
			const content = await fs.readFile(candidate, "utf8").catch(() => undefined);
			if (content?.includes(sentinel)) {
				return candidate;
			}
		}
		assert.fail(`no user settings.json carries the sentinel (scanned ${roots.length} candidate dir(s))`);
	}

	/**
	 * Write external edits into this host's user settings.json and make the host
	 * reload them: a registered write (chat.timeout carrying a unique sentinel)
	 * locates the file by content, the edit lands beside it, and a second
	 * registered write forces the configuration reload. `edit` may also DELETE
	 * ids by assigning undefined. Restores chat.timeout before returning.
	 */
	async function withExternalSettingsEdit(
		edit: (settings: Record<string, unknown>) => void,
		reloaded: () => boolean
	): Promise<void> {
		const config = () => vscode.workspace.getConfiguration(CONFIG_SECTION);
		const timeoutBefore = config().inspect<number>("chat.timeout")?.globalValue;
		// A unique, registered-valid sentinel value: content search needs it to
		// be one of a kind in the file.
		const sentinel = 300000 + (Date.now() % 100000) * 10 + (process.pid % 10);
		try {
			await config().update("chat.timeout", sentinel, vscode.ConfigurationTarget.Global);
			const settingsFile = await locateUserSettingsFile(String(sentinel));
			const settings = JSON.parse(await fs.readFile(settingsFile, "utf8")) as Record<string, unknown>;
			edit(settings);
			for (const [key, value] of Object.entries(settings)) {
				if (value === undefined) {
					delete settings[key];
				}
			}
			await fs.writeFile(settingsFile, JSON.stringify(settings, null, "\t"));
			// A write through the configuration API reloads the user configuration
			// from disk, which picks the external edit up without depending on the
			// file watcher; the poll below is only a safety net.
			await config().update("chat.timeout", sentinel + 1, vscode.ConfigurationTarget.Global);
			const deadline = Date.now() + 10000;
			while (!reloaded() && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		} finally {
			await config().update("chat.timeout", timeoutBefore, vscode.ConfigurationTarget.Global);
		}
	}

	test("the host inspects and clears stale user-settings values for an uncontributed setting id", async function () {
		// The settings-redesign migration's host assumptions, pinned with an id
		// that was never contributed so the pin cannot rot: (1) the host REFUSES
		// writing a value to an unregistered key, so a value can only exist from
		// the real upgrade scenario, reproduced here by editing settings.json
		// directly; (2) inspect() still reports such a stale value; (3)
		// update(id, undefined, Global) is exempt from the refusal and clears it.
		this.timeout(20000);
		const config = () => vscode.workspace.getConfiguration(CONFIG_SECTION);
		const probeId = "pinnedUncontributedProbe";
		assert.strictEqual(config().inspect<number>(probeId)?.globalValue, undefined, "the probe id must start absent");
		await assert.rejects(
			async () => config().update(probeId, 42, vscode.ConfigurationTarget.Global),
			// Matched loosely: the behavior is the pin, the host's wording is not.
			/registered/,
			"a VALUE write to an unregistered id must be refused (otherwise this pin seeds the easy way)"
		);

		try {
			await withExternalSettingsEdit(
				(settings) => {
					settings[`${CONFIG_SECTION}.${probeId}`] = 42;
				},
				() => config().inspect<number>(probeId)?.globalValue !== undefined
			);
			const inspected = config().inspect<number>(probeId);
			assert.ok(inspected !== undefined, "inspect() must return a result for an uncontributed id");
			assert.strictEqual(inspected.globalValue, 42, "the stale uncontributed value must be readable");

			await config().update(probeId, undefined, vscode.ConfigurationTarget.Global);
			assert.strictEqual(
				config().inspect<number>(probeId)?.globalValue,
				undefined,
				"update(id, undefined, Global) must clear the stale uncontributed value"
			);
		} finally {
			// Belt and braces: if the delete leg failed, the probe must not leak
			// into later runs against a kept user-data dir.
			await config()
				.update(probeId, undefined, vscode.ConfigurationTarget.Global)
				.then(undefined, () => {});
		}
	});

	test("the settings-redesign applier migrates a seeded old-world configuration end to end", async function () {
		// The applier against the REAL configuration API and the registered
		// manifest: legacy ids seeded the only way an upgrade produces them
		// (external settings.json edits), then applySettingsRedesign executes its
		// plan at the Global target and the new world is read back through
		// inspect(). A re-plan against the migrated settings must write nothing.
		this.timeout(30000);
		const config = () => vscode.workspace.getConfiguration(CONFIG_SECTION);
		const seededIds = ["requestTimeout", "modelParameters", "defaultContextLength", "headers"];
		const newIds = ["chat.timeout", "models.parameters", "models.capabilities", "servers"];
		const parked = new Map<string, unknown>();
		const store = {
			get: <T>(key: string): T | undefined => parked.get(key) as T | undefined,
			update: (key: string, value: unknown) => {
				parked.set(key, value);
				return Promise.resolve();
			},
		};
		const logger = {
			log: (line: string) => channelLines.push(line),
			error: (line: string) => channelLines.push(line),
		} as unknown as Parameters<typeof applySettingsRedesign>[2];
		try {
			// A clean slate on the new-name ids: earlier tests leave values there,
			// and the rename's sync-race rule would otherwise keep them and drop
			// the seeds below without writing.
			for (const id of newIds) {
				await config().update(id, undefined, vscode.ConfigurationTarget.Global);
			}
			await withExternalSettingsEdit(
				(settings) => {
					settings[`${CONFIG_SECTION}.requestTimeout`] = 45000;
					settings[`${CONFIG_SECTION}.modelParameters`] = { gpt: { temperature: 0.2 } };
					settings[`${CONFIG_SECTION}.defaultContextLength`] = 64000;
					settings[`${CONFIG_SECTION}.headers`] = { "x-env": "prod" };
					settings[`${CONFIG_SECTION}.servers`] = [
						{ label: "prod", baseUrl: "https://gw", apiKey: "sk-e2e", modelParameters: { gpt: { seed: 7 } } },
					];
				},
				() => config().inspect<number>("requestTimeout")?.globalValue !== undefined
			);
			assert.strictEqual(config().inspect<number>("requestTimeout")?.globalValue, 45000, "the seed must land");

			await applySettingsRedesign(config(), store, logger);

			// The renamed and restructured world, read back through the host.
			assert.strictEqual(config().inspect<number>("chat.timeout")?.globalValue, 45000);
			assert.deepStrictEqual(config().inspect("models.parameters")?.globalValue, {
				"gpt*": { temperature: 0.2 },
			});
			assert.deepStrictEqual(config().inspect("models.capabilities")?.globalValue, {
				"*": { context_length: 64000, _fallback: ["context_length"], _inheritable: true },
			});
			assert.deepStrictEqual(config().inspect("servers")?.globalValue, [
				{
					label: "prod",
					baseUrl: "https://gw",
					auth: { apiKey: "sk-e2e" },
					headers: { "x-env": "prod" },
					models: { parameters: { "gpt*": { seed: 7 } } },
				},
			]);
			for (const id of seededIds) {
				assert.strictEqual(config().inspect(id)?.globalValue, undefined, `${id} must be deleted`);
			}
			const parkedRecord = parked.get(PARKED_GLOBAL_HEADERS_KEY) as { headers?: unknown } | undefined;
			assert.deepStrictEqual(parkedRecord?.headers, { "x-env": "prod" }, "the consumed headers value parks once");

			// Idempotent rerun against the REAL migrated settings: nothing to write.
			const rerun = planSettingsRedesign(readRedesignSnapshot(config()));
			assert.deepStrictEqual(rerun.writes, [], "re-planning the migrated user settings must write nothing");
		} finally {
			for (const id of [...seededIds, ...newIds]) {
				await config()
					.update(id, undefined, vscode.ConfigurationTarget.Global)
					.then(undefined, () => {});
			}
		}
	});

	// Mocha runs a suite's own tests before its nested suites, so this
	// artifact-PRESENT world runs last: its setup disposes the first activation
	// wholesale (unregistering every litellm.* command), which is the only way a
	// second activate() can run in the same host.
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
				// Subscribed inside the stub: initialize() is fire-and-forget, so its
				// notify races activate()'s return.
				notified = nextModelChangeEvent(registered);
				return { dispose() {} };
			};
			let notifyDeadline: ReturnType<typeof setTimeout> | undefined;
			try {
				await activate(rerunContext);
				// The artifact-present contract: the bundled snapshot installed, so
				// activation owes the catalog notify. Nothing else can produce one
				// here, and the artifact-absent twin above pins the zero-event side,
				// so the pair discriminates.
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
