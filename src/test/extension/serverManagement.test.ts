import * as assert from "node:assert";
import * as vscode from "vscode";
import { migrateServersToProviderGroups } from "../../extension/groupMigration";
import {
	canMutateRegistry,
	ensureRegistryMutable,
	type ManagementUiMode,
	registerManageCommand,
	warnAboutOrphanedModelParameters,
} from "../../extension/serverManagement";
import { ServerRegistry } from "../../extension/serverRegistry";
import { Logger } from "../../shared/logger";
import { expectDefined, makeExtensionStorage } from "../testUtils";

suite("extension/serverManagement", () => {
	suite("litellm.manage routing", () => {
		interface ManageRun {
			executed: string[];
			errorMessages: string[];
			quickPickOpened: boolean;
			inputBoxOpened: boolean;
		}

		// The activated extension already owns the litellm.manage command ID, so
		// the handler is captured through a stubbed registerCommand and invoked
		// directly.
		async function runManageCommand(mode: ManagementUiMode, nativeUiFails: boolean): Promise<ManageRun> {
			const storage = makeExtensionStorage();
			const registry = new ServerRegistry(storage.memento, storage.secrets);
			const logger = new Logger({ info: () => {}, error: () => {} });

			let handler: (() => Promise<void>) | undefined;
			const origRegister = vscode.commands.registerCommand;
			(vscode.commands as Record<string, unknown>).registerCommand = (_id: string, callback: () => Promise<void>) => {
				handler = callback;
				return { dispose() {} };
			};
			try {
				registerManageCommand(
					{ subscriptions: [] } as unknown as vscode.ExtensionContext,
					registry,
					logger,
					() => mode
				);
			} finally {
				(vscode.commands as Record<string, unknown>).registerCommand = origRegister;
			}

			const run: ManageRun = { executed: [], errorMessages: [], quickPickOpened: false, inputBoxOpened: false };
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
			(vscode.window as Record<string, unknown>).showQuickPick = async () => {
				run.quickPickOpened = true;
				return undefined;
			};
			(vscode.window as Record<string, unknown>).showInputBox = async () => {
				run.inputBoxOpened = true;
				return undefined;
			};
			try {
				await expectDefined(handler, "registerManageCommand must register a handler")();
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
			assert.strictEqual(run.quickPickOpened, false, "the quick pick edits configuration nothing serves");
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
			assert.strictEqual(run.quickPickOpened, false);
			assert.strictEqual(run.inputBoxOpened, false);
		});

		test("legacy mode never invokes the native UI", async () => {
			const run = await runManageCommand("legacy", false);

			assert.deepStrictEqual(run.executed, []);
			assert.strictEqual(run.inputBoxOpened, true, "an empty registry drops into the add-server flow");
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
					canMutateRegistry(() => false),
					true
				);
				assert.strictEqual(messages.length, 0);

				assert.strictEqual(
					canMutateRegistry(() => true),
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
