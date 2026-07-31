import * as assert from "node:assert";
import * as vscode from "vscode";
import { migrateServersToProviderGroups } from "../../../extension/migrations/registryToProviderGroups";
import {
	canMutateRegistry,
	EXTENSION_SETTINGS_FILTER,
	ensureRegistryMutable,
	type ManagementUiMode,
	registerManageCommand,
	warnAboutOrphanedModelParameters,
} from "../../../extension/servers/serverManagement";
import { ServerRegistry } from "../../../extension/servers/serverRegistry";
import { Logger } from "../../../shared/logger";
import { expectDefined, fakeFingerprintSaltSession, makeExtensionStorage, withConfig } from "../../testUtils";

suite("extension/servers/serverManagement", () => {
	// The activated extension already owns the litellm.manage command IDs, so
	// every suite below captures the handlers through a stubbed registerCommand
	// and invokes them directly.
	function captureManageHandlers(
		registry: ServerRegistry,
		logger: Logger,
		mode: ManagementUiMode | (() => ManagementUiMode)
	) {
		const handlers = new Map<string, () => Promise<void>>();
		const origRegister = vscode.commands.registerCommand;
		(vscode.commands as Record<string, unknown>).registerCommand = (id: string, callback: () => Promise<void>) => {
			handlers.set(id, callback);
			return { dispose() {} };
		};
		try {
			registerManageCommand(
				{ subscriptions: [] } as unknown as vscode.ExtensionContext,
				registry,
				logger,
				typeof mode === "function" ? mode : () => mode
			);
		} finally {
			(vscode.commands as Record<string, unknown>).registerCommand = origRegister;
		}
		return {
			manage: expectDefined(handlers.get("litellm.manage"), "registerManageCommand must register litellm.manage"),
			manageServers: expectDefined(
				handlers.get("litellm.manageServers"),
				"registerManageCommand must register litellm.manageServers"
			),
		};
	}

	suite("hub quick pick", () => {
		interface HubRun {
			executed: { command: string; args: unknown[] }[];
			itemLabels: string[];
		}

		async function runHub(selectLabel: string | undefined): Promise<HubRun> {
			const storage = makeExtensionStorage();
			const registry = new ServerRegistry(storage.memento, storage.secrets);
			const logger = new Logger({ info: () => {}, error: () => {} });
			const handler = captureManageHandlers(registry, logger, "nativeRequired").manage;

			const run: HubRun = { executed: [], itemLabels: [] };
			const origExecute = vscode.commands.executeCommand;
			const origQuickPick = vscode.window.showQuickPick;
			(vscode.commands as Record<string, unknown>).executeCommand = async (command: string, ...args: unknown[]) => {
				run.executed.push({ command, args });
			};
			(vscode.window as Record<string, unknown>).showQuickPick = async (items: { label: string }[]) => {
				run.itemLabels = items.map((item) => item.label);
				return selectLabel === undefined ? undefined : items.find((item) => item.label.includes(selectLabel));
			};
			try {
				await handler();
			} finally {
				(vscode.commands as Record<string, unknown>).executeCommand = origExecute;
				(vscode.window as Record<string, unknown>).showQuickPick = origQuickPick;
			}
			return run;
		}

		test("lists every surface in one menu", async () => {
			const run = await runHub(undefined);
			const labels = run.itemLabels.map((label) => label.replace(/^\$\([^)]+\) /, ""));
			assert.deepStrictEqual(labels, [
				"Manage Language Models",
				"Open Dashboard",
				"Sync Models Now",
				"Test Connection",
				"Show Diagnostics",
				"Set Server Secret",
				"Open Settings",
				"Help & Feedback",
				"Report Issue",
			]);
		});

		test("cancelling the hub executes nothing", async () => {
			const run = await runHub(undefined);
			assert.deepStrictEqual(run.executed, []);
		});

		test("Manage Language Models opens the native editor", async () => {
			const run = await runHub("Manage Language Models");
			assert.deepStrictEqual(run.executed, [{ command: "workbench.action.chat.manage", args: [] }]);
		});

		test("Open Settings filters the settings view to this extension", async () => {
			const run = await runHub("Open Settings");
			assert.deepStrictEqual(run.executed, [
				{ command: "workbench.action.openSettings", args: ["@ext:vivswan.litellm-vscode-chat"] },
			]);
		});

		for (const [entry, command] of [
			["Open Dashboard", "litellm.openDashboard"],
			["Sync Models Now", "litellm.syncModels"],
			["Test Connection", "litellm.testConnection"],
			["Show Diagnostics", "litellm.showDiagnostics"],
			["Set Server Secret", "litellm.setServerSecret"],
			["Help & Feedback", "litellm.helpAndFeedback"],
			["Report Issue", "litellm.reportIssue"],
		] as const) {
			test(`${entry} routes to ${command}`, async () => {
				const run = await runHub(entry);
				assert.deepStrictEqual(run.executed, [{ command, args: [] }]);
			});
		}
	});

	suite("server-entry routing", () => {
		interface ManageRun {
			executed: string[];
			errorMessages: string[];
			hubOpened: boolean;
			serverListOpened: boolean;
			inputBoxOpened: boolean;
		}

		// "hub" selects the hub's server entry; "direct" invokes the unlisted
		// litellm.manageServers command that configuration buttons use. Both
		// exercise the mode-dependent native-vs-legacy logic behind the entry.
		async function runManageCommand(
			mode: ManagementUiMode,
			nativeUiFails: boolean,
			entry: "hub" | "direct" = "hub"
		): Promise<ManageRun> {
			const storage = makeExtensionStorage();
			const registry = new ServerRegistry(storage.memento, storage.secrets);
			const logger = new Logger({ info: () => {}, error: () => {} });
			const handlers = captureManageHandlers(registry, logger, mode);

			const run: ManageRun = {
				executed: [],
				errorMessages: [],
				hubOpened: false,
				serverListOpened: false,
				inputBoxOpened: false,
			};
			const origExecute = vscode.commands.executeCommand;
			const origError = vscode.window.showErrorMessage;
			const origQuickPick = vscode.window.showQuickPick;
			const origInputBox = vscode.window.showInputBox;
			(vscode.commands as Record<string, unknown>).executeCommand = async (commandId: string) => {
				run.executed.push(commandId);
				if (nativeUiFails) {
					throw new Error("command 'workbench.action.chat.manage' not found");
				}
			};
			(vscode.window as Record<string, unknown>).showErrorMessage = async (message: string) => {
				run.errorMessages.push(message);
				return undefined;
			};
			(vscode.window as Record<string, unknown>).showQuickPick = async (
				items: { label: string; action?: string }[]
			) => {
				const serverEntry = items.find((item) => item.action === "servers");
				if (serverEntry) {
					run.hubOpened = true;
					return serverEntry;
				}
				run.serverListOpened = true;
				return undefined;
			};
			(vscode.window as Record<string, unknown>).showInputBox = async () => {
				run.inputBoxOpened = true;
				return undefined;
			};
			try {
				await (entry === "hub" ? handlers.manage() : handlers.manageServers());
			} finally {
				(vscode.commands as Record<string, unknown>).executeCommand = origExecute;
				(vscode.window as Record<string, unknown>).showErrorMessage = origError;
				(vscode.window as Record<string, unknown>).showQuickPick = origQuickPick;
				(vscode.window as Record<string, unknown>).showInputBox = origInputBox;
			}
			return run;
		}

		test("nativeRequired shows an error and never opens the legacy flow when the native UI fails", async () => {
			const run = await runManageCommand("nativeRequired", true);

			assert.deepStrictEqual(run.executed, ["workbench.action.chat.manage"]);
			assert.strictEqual(run.errorMessages.length, 1);
			const errorMessage = expectDefined(run.errorMessages[0]);
			assert.ok(errorMessage.includes("Manage Language Models"), errorMessage);
			assert.strictEqual(run.serverListOpened, false, "the quick pick edits configuration nothing serves");
			assert.strictEqual(run.inputBoxOpened, false, "the add-server flow edits configuration nothing serves");
		});

		test("nativePreferred falls back to the legacy flow when the native UI fails", async () => {
			const run = await runManageCommand("nativePreferred", true);

			assert.deepStrictEqual(run.executed, ["workbench.action.chat.manage"]);
			assert.deepStrictEqual(run.errorMessages, []);
			assert.strictEqual(run.inputBoxOpened, true, "an empty registry drops into the add-server flow");
		});

		test("a working native UI opens without touching the legacy flow", async () => {
			const run = await runManageCommand("nativeRequired", false);

			assert.deepStrictEqual(run.executed, ["workbench.action.chat.manage"]);
			assert.deepStrictEqual(run.errorMessages, []);
			assert.strictEqual(run.serverListOpened, false);
			assert.strictEqual(run.inputBoxOpened, false);
		});

		test("legacy mode never invokes the native UI", async () => {
			const run = await runManageCommand("legacy", false);

			assert.deepStrictEqual(run.executed, []);
			assert.strictEqual(run.inputBoxOpened, true, "an empty registry drops into the add-server flow");
		});

		test("litellm.manageServers opens the native editor without showing the hub", async () => {
			const run = await runManageCommand("nativeRequired", false, "direct");

			assert.deepStrictEqual(run.executed, ["workbench.action.chat.manage"]);
			assert.strictEqual(run.hubOpened, false, "configuration buttons must not land on the hub menu");
			assert.strictEqual(run.serverListOpened, false);
		});

		test("litellm.manageServers drops into the legacy add flow without showing the hub", async () => {
			const run = await runManageCommand("legacy", false, "direct");

			assert.deepStrictEqual(run.executed, []);
			assert.strictEqual(run.hubOpened, false, "configuration buttons must not land on the hub menu");
			assert.strictEqual(run.inputBoxOpened, true, "an empty registry drops into the add-server flow");
		});
	});

	suite("legacy server flows", () => {
		/** One captured toast: the message plus the action-button labels showActionableMessage spreads. */
		interface Toast {
			message: string;
			buttons: string[];
		}

		interface WalkResult {
			registry: ServerRegistry;
			/** The registry contents right after seeding, for no-mutation assertions. */
			seeded: { id: string; label: string; baseUrl: string }[];
			/** Every line the flows logged; feeds the issue-report buffer, so secrets must never appear. */
			logged: string[];
			/** The options each showInputBox call received, in prompt order. */
			inputOptions: vscode.InputBoxOptions[];
			/** Every quick pick shown: its options and the items offered. */
			quickPicks: { title?: string; items: { label: string; description?: string }[] }[];
			infoToasts: Toast[];
			warnToasts: { message: string; options: vscode.MessageOptions | undefined; buttons: string[] }[];
			executed: string[];
		}

		interface WalkPlan {
			/** Servers seeded into the registry before the walk: [label, baseUrl, apiKey]. */
			seed?: readonly [string, string, string][];
			/**
			 * Input-box answers in prompt order; undefined cancels. A function
			 * receives the prompt's options (so a test can flip state mid-prompt)
			 * and returns the answer.
			 */
			inputs?: readonly (string | undefined | ((options: vscode.InputBoxOptions) => string | undefined))[];
			/** Selects from each non-hub quick pick by visible label substring; undefined cancels. */
			picks?: readonly (string | undefined)[];
			/** The warning-dialog answer; a function may flip state before answering. */
			warningResponse?: string | undefined | ((message: string) => string | undefined);
			mode?: ManagementUiMode | (() => ManagementUiMode);
			nativeUiFails?: boolean;
		}

		/** Drive litellm.manageServers through stubbed window UI; every stub restores in finally. */
		async function runServerWalk(plan: WalkPlan): Promise<WalkResult> {
			const storage = makeExtensionStorage();
			const registry = new ServerRegistry(storage.memento, storage.secrets);
			for (const [label, baseUrl, apiKey] of plan.seed ?? []) {
				await registry.addServer(label, baseUrl, apiKey);
			}
			const logged: string[] = [];
			const logger = new Logger({
				info: (message: string) => logged.push(message),
				error: (message: string) => logged.push(message),
			});
			const seeded = registry.getServers().map(({ id, label, baseUrl }) => ({ id, label, baseUrl }));
			const handler = captureManageHandlers(registry, logger, plan.mode ?? "legacy").manageServers;

			const result: WalkResult = {
				registry,
				seeded,
				logged,
				inputOptions: [],
				quickPicks: [],
				infoToasts: [],
				warnToasts: [],
				executed: [],
			};
			const inputs = [...(plan.inputs ?? [])];
			const picks = [...(plan.picks ?? [])];

			const origInputBox = vscode.window.showInputBox;
			const origQuickPick = vscode.window.showQuickPick;
			const origInfo = vscode.window.showInformationMessage;
			const origWarn = vscode.window.showWarningMessage;
			const origExecute = vscode.commands.executeCommand;
			(vscode.window as Record<string, unknown>).showInputBox = async (options: vscode.InputBoxOptions) => {
				result.inputOptions.push(options);
				const next = inputs.shift();
				return typeof next === "function" ? next(options) : next;
			};
			(vscode.window as Record<string, unknown>).showQuickPick = async (
				items: { label: string }[],
				options?: { title?: string }
			) => {
				result.quickPicks.push({ ...(options?.title !== undefined ? { title: options.title } : {}), items });
				const wanted = picks.shift();
				return wanted === undefined ? undefined : items.find((item) => item.label.includes(wanted));
			};
			(vscode.window as Record<string, unknown>).showInformationMessage = async (
				message: string,
				...buttons: string[]
			) => {
				result.infoToasts.push({ message, buttons });
				return undefined;
			};
			(vscode.window as Record<string, unknown>).showWarningMessage = async (
				message: string,
				optionsOrButton?: vscode.MessageOptions | string,
				...buttons: string[]
			) => {
				const isOptions = typeof optionsOrButton === "object";
				result.warnToasts.push({
					message,
					options: isOptions ? optionsOrButton : undefined,
					buttons: isOptions ? buttons : [optionsOrButton, ...buttons].filter((b): b is string => b !== undefined),
				});
				return typeof plan.warningResponse === "function" ? plan.warningResponse(message) : plan.warningResponse;
			};
			(vscode.commands as Record<string, unknown>).executeCommand = async (commandId: string) => {
				result.executed.push(commandId);
				if (plan.nativeUiFails) {
					throw new Error("command 'workbench.action.chat.manage' not found");
				}
			};
			try {
				await handler();
			} finally {
				(vscode.window as Record<string, unknown>).showInputBox = origInputBox;
				(vscode.window as Record<string, unknown>).showQuickPick = origQuickPick;
				(vscode.window as Record<string, unknown>).showInformationMessage = origInfo;
				(vscode.window as Record<string, unknown>).showWarningMessage = origWarn;
				(vscode.commands as Record<string, unknown>).executeCommand = origExecute;
			}
			return result;
		}

		/** The captured validateInput of the prompt at `index`, ready to call directly. */
		function validatorOf(result: WalkResult, index: number): (value: string) => string | null {
			const options = expectDefined(result.inputOptions[index], `prompt ${index} was never shown`);
			return expectDefined(options.validateInput, "the prompt must carry a validateInput") as (
				value: string
			) => string | null;
		}

		test("the add walk stores the trimmed label, base URL, and API key and shows the success toast", async () => {
			const run = await runServerWalk({ inputs: ["  Prod  ", " http://localhost:4000 ", " sk-key "] });

			const servers = run.registry.getServers();
			assert.strictEqual(servers.length, 1);
			const server = expectDefined(servers[0]);
			assert.strictEqual(server.label, "Prod");
			assert.strictEqual(server.baseUrl, "http://localhost:4000");
			assert.strictEqual(await run.registry.getApiKey(server.id), "sk-key");
			// The log lines feed the public issue-report buffer; the key must
			// never reach them (the flow logs label and URL only).
			assert.ok(run.logged.length > 0, "the add flow logs its outcome");
			assert.ok(
				!run.logged.some((line) => line.includes("sk-key")),
				`the API key leaked into the log buffer: ${JSON.stringify(run.logged)}`
			);
			assert.strictEqual(run.infoToasts.length, 1);
			const toast = expectDefined(run.infoToasts[0]);
			assert.ok(toast.message.includes('"Prod" added'), toast.message);
			assert.deepStrictEqual(toast.buttons, ["Test Connection", "Open Chat", "Dismiss"]);
		});

		test("cancelling at the base-URL or API-key step leaves the registry untouched; an empty key is not a cancel", async () => {
			const atUrl = await runServerWalk({ inputs: ["Prod", undefined] });
			assert.deepStrictEqual(atUrl.registry.getServers(), []);
			assert.deepStrictEqual(atUrl.infoToasts, []);

			const atKey = await runServerWalk({ inputs: ["Prod", "http://x", undefined] });
			assert.deepStrictEqual(atKey.registry.getServers(), []);
			assert.deepStrictEqual(atKey.infoToasts, []);

			// An empty string answers "no key required"; only undefined cancels.
			const emptyKey = await runServerWalk({ inputs: ["Prod", "http://x", ""] });
			const server = expectDefined(emptyKey.registry.getServers()[0], "the empty-key add must store the server");
			assert.strictEqual(await emptyKey.registry.getApiKey(server.id), "");
		});

		test("the label prompt rejects empty, '/', and duplicate labels, excluding the server being edited", async () => {
			const addRun = await runServerWalk({
				seed: [["Prod", "http://prod", ""]],
				picks: ["Add Server"],
				inputs: [undefined],
			});
			const validate = validatorOf(addRun, 0);
			assert.ok(String(validate("")).includes("required"));
			assert.ok(String(validate("a/b")).includes("'/'"));
			assert.ok(String(validate("Prod")).includes("already exists"));
			assert.strictEqual(validate("Staging"), null);

			// The edit prompt excludes the server's own id: keeping the label is legal.
			const editRun = await runServerWalk({
				seed: [["Prod", "http://prod", ""]],
				picks: ["Prod", "Edit"],
				inputs: [undefined],
			});
			assert.strictEqual(validatorOf(editRun, 0)("Prod"), null);
		});

		test("the base-URL prompt requires an http(s) scheme and rejects blank input", async () => {
			const run = await runServerWalk({ inputs: ["Prod", undefined] });
			const validate = validatorOf(run, 1);
			assert.ok(String(validate("")).includes("required"));
			assert.ok(String(validate("localhost:4000")).includes("http://"));
			assert.ok(String(validate("ftp://x")).includes("http://"));
			assert.strictEqual(validate("http://ok"), null);
			assert.strictEqual(validate("https://ok"), null);
		});

		test("the API-key prompt honors maskApiKeyInput through the password flag, in the add and edit flows alike", async () => {
			const maskedAdd = await withConfig({ maskApiKeyInput: true }, () =>
				runServerWalk({ inputs: ["P", "http://x", undefined] })
			);
			assert.strictEqual(expectDefined(maskedAdd.inputOptions[2]).password, true);

			const bareAdd = await withConfig({ maskApiKeyInput: false }, () =>
				runServerWalk({ inputs: ["P", "http://x", undefined] })
			);
			assert.strictEqual(expectDefined(bareAdd.inputOptions[2]).password, false);

			// The edit flow prefills the STORED key into the prompt, so a dropped
			// password flag there renders an existing credential in cleartext.
			const maskedEdit = await withConfig({ maskApiKeyInput: true }, () =>
				runServerWalk({
					seed: [["Prod", "http://prod", "sk-stored"]],
					picks: ["Prod", "Edit"],
					inputs: ["Prod", "http://prod", undefined],
				})
			);
			const editKeyPrompt = expectDefined(maskedEdit.inputOptions[2]);
			assert.strictEqual(editKeyPrompt.password, true);
			assert.strictEqual(editKeyPrompt.value, "sk-stored");

			const bareEdit = await withConfig({ maskApiKeyInput: false }, () =>
				runServerWalk({
					seed: [["Prod", "http://prod", "sk-stored"]],
					picks: ["Prod", "Edit"],
					inputs: ["Prod", "http://prod", undefined],
				})
			);
			assert.strictEqual(expectDefined(bareEdit.inputOptions[2]).password, false);
		});

		test("a populated registry lists Add Server plus one entry per server and routes a pick to the manage menu", async () => {
			const run = await runServerWalk({ seed: [["Prod", "http://prod", ""]], picks: ["Prod", undefined] });

			const list = expectDefined(run.quickPicks[0]);
			assert.deepStrictEqual(
				list.items.map((item) => item.label),
				["$(add) Add Server", "$(server) Prod"]
			);
			assert.strictEqual(expectDefined(list.items[1]).description, "http://prod");

			const menu = expectDefined(run.quickPicks[1], "picking a server must open its manage menu");
			assert.strictEqual(menu.title, "LiteLLM: Prod");
			assert.deepStrictEqual(
				menu.items.map((item) => item.label.replace(/^\$\([^)]+\) /, "")),
				["Edit Server", "Test All Servers", "Remove Server"]
			);
			// The menu was cancelled: nothing mutated.
			assert.strictEqual(run.registry.getServers().length, 1);
			assert.deepStrictEqual(run.infoToasts, []);
		});

		test("Add Server from a populated list runs the add flow", async () => {
			const run = await runServerWalk({
				seed: [["Prod", "http://prod", ""]],
				picks: ["Add Server"],
				inputs: ["Staging", "http://staging", ""],
			});
			assert.deepStrictEqual(
				run.registry.getServers().map((server) => server.label),
				["Prod", "Staging"]
			);
		});

		test("the edit walk prefills the current label, base URL, and stored key and updates the same server", async () => {
			const run = await runServerWalk({
				seed: [["Old", "http://old", "key1"]],
				picks: ["Old", "Edit"],
				inputs: ["New", "http://new", "key2"],
			});

			assert.strictEqual(expectDefined(run.inputOptions[0]).value, "Old");
			assert.strictEqual(expectDefined(run.inputOptions[1]).value, "http://old");
			assert.strictEqual(expectDefined(run.inputOptions[2]).value, "key1");

			const servers = run.registry.getServers();
			assert.strictEqual(servers.length, 1);
			const server = expectDefined(servers[0]);
			assert.strictEqual(server.label, "New");
			assert.strictEqual(server.baseUrl, "http://new");
			assert.strictEqual(await run.registry.getApiKey(server.id), "key2");
			const toast = expectDefined(run.infoToasts[0]);
			assert.ok(toast.message.includes("updated"), toast.message);
			assert.deepStrictEqual(toast.buttons, ["Test Connection", "Dismiss"]);
			// Neither the old nor the new key may reach the log buffer.
			assert.ok(!run.logged.some((line) => line.includes("key1") || line.includes("key2")));
		});

		test("renaming through the edit walk warns about orphaned modelParameters; keeping the label does not", async () => {
			const renamed = await withConfig({ modelParameters: { "Old/gpt-4": {} } }, () =>
				runServerWalk({ seed: [["Old", "http://old", ""]], picks: ["Old", "Edit"], inputs: ["New", "http://old", ""] })
			);
			assert.strictEqual(renamed.warnToasts.length, 1);
			const warning = expectDefined(renamed.warnToasts[0]);
			assert.ok(warning.message.includes('"Old/"'), warning.message);
			assert.ok(warning.message.includes('"New/"'), warning.message);

			const kept = await withConfig({ modelParameters: { "Old/gpt-4": {} } }, () =>
				runServerWalk({
					seed: [["Old", "http://old", ""]],
					picks: ["Old", "Edit"],
					inputs: ["Old", "http://other", ""],
				})
			);
			assert.deepStrictEqual(kept.warnToasts, []);
		});

		test("remove asks for modal confirmation naming the server and only deletes on 'Remove'", async () => {
			const removed = await runServerWalk({
				seed: [
					["Prod", "http://prod", ""],
					["Staging", "http://staging", ""],
				],
				picks: ["Prod", "Remove"],
				warningResponse: "Remove",
			});
			const confirmation = expectDefined(removed.warnToasts[0]);
			assert.strictEqual(
				expectDefined(confirmation.options).modal,
				true,
				"a focus change must not dismiss into deletion"
			);
			assert.ok(confirmation.message.includes("Prod"), confirmation.message);
			assert.ok(confirmation.message.includes("http://prod"), confirmation.message);
			assert.deepStrictEqual(
				removed.registry.getServers().map((server) => server.label),
				["Staging"]
			);
			assert.ok(expectDefined(removed.infoToasts[0]).message.includes("removed"), "the deletion must be confirmed");

			const dismissed = await runServerWalk({
				seed: [
					["Prod", "http://prod", ""],
					["Staging", "http://staging", ""],
				],
				picks: ["Prod", "Remove"],
				warningResponse: undefined,
			});
			assert.strictEqual(dismissed.registry.getServers().length, 2, "cancelling the dialog must delete nothing");
		});

		test("Test All Servers executes litellm.testConnection and mutates nothing", async () => {
			const run = await runServerWalk({ seed: [["Prod", "http://prod", "k"]], picks: ["Prod", "Test All Servers"] });
			assert.deepStrictEqual(run.executed, ["litellm.testConnection"]);
			const server = expectDefined(run.registry.getServers()[0]);
			assert.strictEqual(server.label, "Prod");
			assert.strictEqual(await run.registry.getApiKey(server.id), "k");
		});

		test("a migration completing while the add prompts are open aborts the write with the language-models-UI notice", async () => {
			let migrated = false;
			const run = await runServerWalk({
				mode: () => (migrated ? "nativeRequired" : "legacy"),
				inputs: [
					"Prod",
					"http://localhost:4000",
					() => {
						// The migration lands while the key prompt is open; the re-check
						// after the prompts must abort the orphan-to-be write.
						migrated = true;
						return "sk-key";
					},
				],
			});
			assert.deepStrictEqual(run.registry.getServers(), [], "the just-migrated registry must not be written");
			const notices = run.infoToasts.filter((toast) => toast.message.includes("language models UI"));
			assert.strictEqual(notices.length, 1);
		});

		test("a migration completing mid-edit or during the remove confirmation aborts the mutation", async () => {
			let migrated = false;
			const edit = await runServerWalk({
				seed: [["Old", "http://old", "key1"]],
				picks: ["Old", "Edit"],
				mode: () => (migrated ? "nativeRequired" : "legacy"),
				inputs: [
					"New",
					"http://new",
					() => {
						migrated = true;
						return "key2";
					},
				],
			});
			const editedServer = expectDefined(edit.registry.getServers()[0]);
			assert.strictEqual(editedServer.label, "Old");
			assert.strictEqual(editedServer.baseUrl, "http://old");
			assert.strictEqual(await edit.registry.getApiKey(editedServer.id), "key1");
			assert.deepStrictEqual(
				edit.infoToasts.filter((toast) => toast.message.includes("updated")),
				[]
			);

			migrated = false;
			const remove = await runServerWalk({
				seed: [["Prod", "http://prod", ""]],
				picks: ["Prod", "Remove"],
				mode: () => (migrated ? "nativeRequired" : "legacy"),
				warningResponse: () => {
					migrated = true;
					return "Remove";
				},
			});
			assert.strictEqual(remove.registry.getServers().length, 1, "the migrated registry must not be mutated");
		});

		test("nativePreferred's fallback lets a fresh-install add complete without tripping the mutation guard", async () => {
			const run = await runServerWalk({
				mode: "nativePreferred",
				nativeUiFails: true,
				inputs: ["Prod", "http://localhost:4000", "sk-key"],
			});
			assert.deepStrictEqual(run.executed, ["workbench.action.chat.manage"]);
			const server = expectDefined(run.registry.getServers()[0], "the fresh-install add must store the server");
			assert.strictEqual(server.label, "Prod");
			assert.deepStrictEqual(
				run.infoToasts.filter((toast) => toast.message.includes("language models UI")),
				[],
				"nativePreferred must not read as a retired registry"
			);
		});

		test("nativePreferred with a working native UI never opens the legacy list; its fallback shows the populated list", async () => {
			const native = await runServerWalk({ seed: [["Prod", "http://prod", ""]], mode: "nativePreferred" });
			assert.deepStrictEqual(native.executed, ["workbench.action.chat.manage"]);
			assert.deepStrictEqual(native.quickPicks, [], "the legacy list must not open beside the native UI");

			const fallback = await runServerWalk({
				seed: [["Prod", "http://prod", ""]],
				mode: "nativePreferred",
				nativeUiFails: true,
				picks: [undefined],
			});
			assert.deepStrictEqual(fallback.executed, ["workbench.action.chat.manage"]);
			const list = expectDefined(fallback.quickPicks[0], "the fallback must open the server list, not the add flow");
			assert.ok(list.items.some((item) => item.label === "$(server) Prod"));
			assert.deepStrictEqual(fallback.inputOptions, [], "a populated registry must not drop into the add flow");
		});

		test("nativeRequired with a failing native UI surfaces the error and leaves a populated registry untouched", async () => {
			const errors: string[] = [];
			const origError = vscode.window.showErrorMessage;
			(vscode.window as Record<string, unknown>).showErrorMessage = async (message: string) => {
				errors.push(message);
				return undefined;
			};
			try {
				const run = await runServerWalk({
					seed: [["Prod", "http://prod", "k"]],
					mode: "nativeRequired",
					nativeUiFails: true,
				});
				assert.deepStrictEqual(run.executed, ["workbench.action.chat.manage"]);
				assert.strictEqual(errors.length, 1);
				assert.ok(expectDefined(errors[0]).includes("Manage Language Models"), expectDefined(errors[0]));
				assert.deepStrictEqual(run.quickPicks, [], "the legacy quick pick would edit dead configuration");
				assert.deepStrictEqual(run.inputOptions, []);
				// Full no-mutation proof: same entry count, ids, labels, and URLs
				// as the moment after seeding, and the key survives untouched.
				assert.deepStrictEqual(
					run.registry.getServers().map(({ id, label, baseUrl }) => ({ id, label, baseUrl })),
					run.seeded
				);
				const server = expectDefined(run.registry.getServers()[0]);
				assert.strictEqual(await run.registry.getApiKey(server.id), "k");
			} finally {
				(vscode.window as Record<string, unknown>).showErrorMessage = origError;
			}
		});
	});

	suite("walkthrough contribution", () => {
		test("the Open Settings button carries the same filter the hub uses", () => {
			const extension = expectDefined(vscode.extensions.getExtension("vivswan.litellm-vscode-chat"));
			const walkthroughs = (
				extension.packageJSON as {
					contributes: { walkthroughs: { steps: { id: string; description: string }[] }[] };
				}
			).contributes.walkthroughs;
			const steps = expectDefined(walkthroughs[0]).steps;
			const fineTune = expectDefined(steps.find((step) => step.id === "litellm.walkthrough.fineTune"));

			// The walkthrough renderer parses the link as a URI and JSON-decodes
			// the query into the command's arguments; replicate that here so a
			// typo on either side (button or hub) fails loudly instead of
			// silently opening an unfiltered settings view.
			const match = expectDefined(
				fineTune.description.match(/\(command:workbench\.action\.openSettings\?([^)]+)\)/) ?? undefined,
				"the fine-tune step must carry an openSettings button with arguments"
			);
			const args: unknown = JSON.parse(decodeURIComponent(expectDefined(match[1])));
			assert.deepStrictEqual(args, [EXTENSION_SETTINGS_FILTER]);
		});
	});

	suite("canMutateRegistry", () => {
		test("refuses with a pointer to the native UI once the migration completed", async () => {
			const messages: string[] = [];
			const origInfo = vscode.window.showInformationMessage;
			(vscode.window as Record<string, unknown>).showInformationMessage = async (message: string) => {
				messages.push(message);
				return undefined;
			};
			try {
				assert.strictEqual(
					canMutateRegistry(() => "legacy"),
					true
				);
				assert.strictEqual(
					canMutateRegistry(() => "nativePreferred"),
					true,
					"the registry is still served while the native UI is merely preferred"
				);
				assert.strictEqual(messages.length, 0);

				assert.strictEqual(
					canMutateRegistry(() => "nativeRequired"),
					false,
					"a migrated registry must not accept mutations"
				);
				assert.strictEqual(messages.length, 1);
				const notice = expectDefined(messages[0]);
				assert.ok(notice.includes("language models UI"), notice);
			} finally {
				(vscode.window as Record<string, unknown>).showInformationMessage = origInfo;
			}
		});
	});

	suite("ensureRegistryMutable", () => {
		test("refuses with a message while a migration is seeding and allows afterwards", async () => {
			const storage = makeExtensionStorage();
			const registry = new ServerRegistry(storage.memento, storage.secrets);
			await registry.addServer("Production", "http://prod.test", "");
			const logger = new Logger({ info: () => {}, error: () => {} });

			let release: (() => void) | undefined;
			const seeding = new Promise<void>((resolve) => {
				release = resolve;
			});

			const messages: string[] = [];
			const origInfo = vscode.window.showInformationMessage;
			(vscode.window as Record<string, unknown>).showInformationMessage = async (message: string) => {
				messages.push(message);
				return undefined;
			};
			try {
				assert.strictEqual(ensureRegistryMutable(), true, "mutations are allowed while no migration runs");

				const migration = migrateServersToProviderGroups(
					registry,
					storage.memento,
					storage.secrets,
					logger,
					fakeFingerprintSaltSession(),
					() => seeding
				);
				// A macrotask lets the migration reach the blocked host command.
				await new Promise((resolve) => setTimeout(resolve, 0));

				assert.strictEqual(ensureRegistryMutable(), false, "mutations must be refused while seeding runs");
				assert.strictEqual(messages.length, 1);
				assert.ok(expectDefined(messages[0]).includes("migration is in progress"), expectDefined(messages[0]));

				expectDefined(release)();
				await migration;

				assert.strictEqual(ensureRegistryMutable(), true, "mutations are allowed again after the migration");
				assert.strictEqual(messages.length, 1, "no message may be shown when mutating is safe");
			} finally {
				(vscode.window as Record<string, unknown>).showInformationMessage = origInfo;
			}
		});
	});

	suite("warnAboutOrphanedModelParameters", () => {
		let toasts: { message: string; buttons: string[] }[];
		let restore: () => void;

		setup(() => {
			toasts = [];
			const origWarn = vscode.window.showWarningMessage;
			(vscode.window as Record<string, unknown>).showWarningMessage = async (message: string, ...buttons: string[]) => {
				toasts.push({ message, buttons });
				return undefined;
			};
			restore = () => {
				(vscode.window as Record<string, unknown>).showWarningMessage = origWarn;
			};
		});

		teardown(() => restore());

		test("warns when modelParameters keys are scoped to the old label", () => {
			warnAboutOrphanedModelParameters("Production", "Prod", ["Production/gpt-4", "Production/claude", "gpt-4"]);
			assert.strictEqual(toasts.length, 1);
			const toast = expectDefined(toasts[0]);
			assert.ok(toast.message.includes('"Production/"'), toast.message);
			assert.ok(toast.message.includes('"Prod/"'), toast.message);
			assert.ok(toast.message.includes("2 modelParameters entries"), toast.message);
			assert.ok(toast.message.includes('"Production/gpt-4"'), toast.message);
			assert.deepStrictEqual(toast.buttons, ["Open Settings", "Dismiss"]);
		});

		test("uses singular phrasing for a single orphaned entry", () => {
			warnAboutOrphanedModelParameters("Production", "Prod", ["Production/gpt-4"]);
			assert.strictEqual(toasts.length, 1);
			const toast = expectDefined(toasts[0]);
			assert.ok(toast.message.includes("1 modelParameters entry "), toast.message);
		});

		test("does not warn when no keys use the old label prefix", () => {
			warnAboutOrphanedModelParameters("Production", "Prod", ["Staging/gpt-4", "gpt-4", "ProductionX/gpt-4"]);
			assert.strictEqual(toasts.length, 0);
		});

		test("does not warn when there are no modelParameters at all", () => {
			warnAboutOrphanedModelParameters("Production", "Prod", []);
			assert.strictEqual(toasts.length, 0);
		});

		test("matches only full label segments, not label substrings", () => {
			warnAboutOrphanedModelParameters("Prod", "Production", ["Prod-East/gpt-4"]);
			assert.strictEqual(toasts.length, 0);
		});
	});
});
