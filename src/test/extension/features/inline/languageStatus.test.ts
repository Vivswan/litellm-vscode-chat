/**
 * The language status row and its toggle: the row's text consumes the same
 * languageAllowed decision as the provider filter, the no-model state reads
 * "no model selected" with a settings-opening action, and the toggle writes
 * the language filter through the shared update-scope rule - one membership
 * flip of the current language in the filter's list, keeping the mode (block
 * mode lists the OFF languages, allow mode the ON ones).
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import {
	InlineLanguageStatusRow,
	registerToggleInlineLanguageCommand,
} from "../../../../extension/features/inline/languageStatus";
import { INTERNAL_CMD } from "../../../../shared/config/commandIds";
import { withConfig } from "../../../testUtils";

interface FakeStatusItem {
	text: string;
	severity: unknown;
	command: vscode.Command | undefined;
	disposed: boolean;
}

interface StatusSpies {
	readonly items: FakeStatusItem[];
	setActiveLanguage(languageId: string | undefined): void;
}

/** Patch the row's VS Code surfaces: the status item, the active editor, and its change event. */
async function withStatusSpies<T>(fn: (spies: StatusSpies) => T | Promise<T>): Promise<Awaited<T>> {
	const items: FakeStatusItem[] = [];
	let activeLanguage: string | undefined = "typescript";
	const originalCreate = vscode.languages.createLanguageStatusItem;
	const originalOnDidChange = vscode.window.onDidChangeActiveTextEditor;
	const originalActiveEditor = Object.getOwnPropertyDescriptor(vscode.window, "activeTextEditor");

	(vscode.languages as Record<string, unknown>).createLanguageStatusItem = () => {
		const item: FakeStatusItem = { text: "", severity: undefined, command: undefined, disposed: false };
		items.push(item);
		return {
			set text(value: string) {
				item.text = value;
			},
			get text() {
				return item.text;
			},
			set severity(value: unknown) {
				item.severity = value;
			},
			get severity() {
				return item.severity;
			},
			set command(value: vscode.Command | undefined) {
				item.command = value;
			},
			get command() {
				return item.command;
			},
			name: "",
			dispose: () => {
				item.disposed = true;
			},
		} as unknown as vscode.LanguageStatusItem;
	};
	(vscode.window as Record<string, unknown>).onDidChangeActiveTextEditor = () => new vscode.Disposable(() => {});
	Object.defineProperty(vscode.window, "activeTextEditor", {
		configurable: true,
		get: () =>
			activeLanguage === undefined
				? undefined
				: ({ document: { languageId: activeLanguage } } as unknown as vscode.TextEditor),
	});

	try {
		return await fn({
			items,
			setActiveLanguage: (languageId) => {
				activeLanguage = languageId;
			},
		});
	} finally {
		(vscode.languages as Record<string, unknown>).createLanguageStatusItem = originalCreate;
		(vscode.window as Record<string, unknown>).onDidChangeActiveTextEditor = originalOnDidChange;
		if (originalActiveEditor !== undefined) {
			Object.defineProperty(vscode.window, "activeTextEditor", originalActiveEditor);
		}
	}
}

const MODEL_REF = { server: "Main", model: "codestral-fim" };

suite("extension/features/inline languageStatus", () => {
	test("the row reads active/off from the same languageAllowed decision the provider filters by", async () => {
		await withStatusSpies(async (spies) => {
			await withConfig(
				{
					"inlineCompletions.model": MODEL_REF,
					"inlineCompletions.languageFilter": { mode: "block", languages: ["markdown"] },
				},
				() => {
					const row = new InlineLanguageStatusRow(() => {});
					const item = spies.items[0];
					assert.ok(item !== undefined);
					assert.strictEqual(item.text, "LiteLLM inline suggestions: active for typescript");
					assert.strictEqual(item.command?.command, INTERNAL_CMD.toggleInlineCompletionsLanguage);
					assert.deepStrictEqual(item.command?.arguments, ["typescript"]);

					spies.setActiveLanguage("markdown");
					row.refresh();
					assert.strictEqual(item.text, "LiteLLM inline suggestions: off for markdown");
					row.dispose();
					assert.strictEqual(item.disposed, true);
				}
			);
		});
	});

	test("enabled without a model reads no-model and the action opens the model setting instead of toggling", async () => {
		await withStatusSpies(async (spies) => {
			await withConfig({}, () => {
				const row = new InlineLanguageStatusRow(() => {});
				const item = spies.items[0];
				assert.ok(item !== undefined);
				assert.strictEqual(item.text, "LiteLLM inline suggestions: no model selected");
				assert.strictEqual(item.command?.command, INTERNAL_CMD.openSettingKey);
				assert.deepStrictEqual(item.command?.arguments, ["inlineCompletions.model"]);
				row.dispose();
			});
		});
	});

	test("a second construction self-heals the slot: the stale row is disposed and the replacement logged", async () => {
		await withStatusSpies(async (spies) => {
			await withConfig({ "inlineCompletions.model": MODEL_REF }, () => {
				const logs: string[] = [];
				const first = new InlineLanguageStatusRow(() => {});
				const second = new InlineLanguageStatusRow((message) => {
					logs.push(message);
				});
				assert.strictEqual(spies.items[0]?.disposed, true, "the stale holder is disposed");
				assert.ok(logs.some((line) => line.includes("slot replaced")));
				first.dispose();
				second.dispose();
			});
		});
	});

	suite("the toggle command writes the filter through the shared update-scope rule", () => {
		interface RecordedWrite {
			readonly key: string;
			readonly value: unknown;
			readonly target: vscode.ConfigurationTarget;
		}

		/**
		 * withConfig for reads plus a recording update; the toggle reads then
		 * writes the same section. `workspaceHeld` keys inspect as
		 * workspace-configured, so updateAuto's scope rule is under test:
		 * workspace-held lists write to the workspace, everything else Global.
		 */
		async function withRecordedToggle(
			values: Record<string, unknown>,
			languageId: string,
			workspaceHeld: readonly string[] = []
		): Promise<RecordedWrite[]> {
			const writes: RecordedWrite[] = [];
			const original = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string, scope?: vscode.ConfigurationScope | null) => {
				if (section !== "litellm-vscode-chat") {
					return original(section, scope);
				}
				return {
					get: (key: string, defaultValue?: unknown) => (Object.hasOwn(values, key) ? values[key] : defaultValue),
					inspect: (key: string) => (workspaceHeld.includes(key) ? { key, workspaceValue: values[key] } : { key }),
					update: async (key: string, value: unknown, target: vscode.ConfigurationTarget) => {
						writes.push({ key, value, target });
					},
				} as unknown as vscode.WorkspaceConfiguration;
			}) as typeof vscode.workspace.getConfiguration;
			let handler: ((languageId: unknown) => Promise<void>) | undefined;
			const originalRegister = vscode.commands.registerCommand;
			(vscode.commands as Record<string, unknown>).registerCommand = (
				_id: string,
				callback: (languageId: unknown) => Promise<void>
			) => {
				handler = callback;
				return new vscode.Disposable(() => {});
			};
			try {
				registerToggleInlineLanguageCommand(
					{ subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext,
					() => {}
				);
				assert.ok(handler !== undefined);
				await handler(languageId);
				return writes;
			} finally {
				vscode.workspace.getConfiguration = original;
				(vscode.commands as Record<string, unknown>).registerCommand = originalRegister;
			}
		}

		test("in block mode, turning OFF adds the language to the filter's list", async () => {
			const writes = await withRecordedToggle(
				{ "inlineCompletions.languageFilter": { mode: "block", languages: [] } },
				"python"
			);
			assert.deepStrictEqual(writes, [
				{
					key: "inlineCompletions.languageFilter",
					value: { mode: "block", languages: ["python"] },
					target: vscode.ConfigurationTarget.Global,
				},
			]);
		});

		test("in allow mode, turning OFF removes the language and turning ON adds it, keeping the mode", async () => {
			const off = await withRecordedToggle(
				{ "inlineCompletions.languageFilter": { mode: "allow", languages: ["python", "go"] } },
				"python"
			);
			assert.deepStrictEqual(off, [
				{
					key: "inlineCompletions.languageFilter",
					value: { mode: "allow", languages: ["go"] },
					target: vscode.ConfigurationTarget.Global,
				},
			]);
			const on = await withRecordedToggle(
				{ "inlineCompletions.languageFilter": { mode: "allow", languages: ["go"] } },
				"python"
			);
			assert.deepStrictEqual(on, [
				{
					key: "inlineCompletions.languageFilter",
					value: { mode: "allow", languages: ["go", "python"] },
					target: vscode.ConfigurationTarget.Global,
				},
			]);
		});

		test("a workspace-held filter is written IN the workspace scope, never shadow-written to user", async () => {
			// The dashboard's own scope rule (updateAuto): a hardcoded Global
			// write here would leave the workspace value standing and the toggle
			// looking dead while the user scope silently absorbed the filter.
			const writes = await withRecordedToggle(
				{ "inlineCompletions.languageFilter": { mode: "block", languages: ["python"] } },
				"python",
				["inlineCompletions.languageFilter"]
			);
			assert.deepStrictEqual(writes, [
				{
					key: "inlineCompletions.languageFilter",
					value: { mode: "block", languages: [] },
					target: vscode.ConfigurationTarget.Workspace,
				},
			]);
		});

		test("with the filter unset, off-then-on round-trips through the default block mode", async () => {
			const off = await withRecordedToggle({}, "go");
			assert.deepStrictEqual(off, [
				{
					key: "inlineCompletions.languageFilter",
					value: { mode: "block", languages: ["go"] },
					target: vscode.ConfigurationTarget.Global,
				},
			]);
			const on = await withRecordedToggle(
				{ "inlineCompletions.languageFilter": { mode: "block", languages: ["go"] } },
				"go"
			);
			assert.deepStrictEqual(on, [
				{
					key: "inlineCompletions.languageFilter",
					value: { mode: "block", languages: [] },
					target: vscode.ConfigurationTarget.Global,
				},
			]);
		});
	});
});
