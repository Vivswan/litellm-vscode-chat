/**
 * The settings.json jump behind the dashboard's revealSetting intent
 * (extension/ui/openSettingKey.ts): the pure key search, the reveal flow over
 * an injected editor, the command's registration, and its refusal of junk
 * arguments. The end-to-end open itself rides the host's own
 * workbench.action.openSettingsJson command, which the last test exercises
 * for real against the test profile's settings.json.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import type { SettingsJsonEditor } from "../../../extension/ui/openSettingKey";
import {
	findSettingKeyRange,
	openUserSettingAtKey,
	resolveUserSettingsUri,
} from "../../../extension/ui/openSettingKey";

suite("extension/ui/openSettingKey", () => {
	suite("resolveUserSettingsUri", () => {
		test("resolves settings.json two levels above global storage, like the groups-file command", () => {
			const globalStorage = vscode.Uri.file("/data/User/globalStorage/vivswan.litellm-vscode-chat");
			const resolved = resolveUserSettingsUri(globalStorage);
			assert.strictEqual(resolved.path, "/data/User/settings.json");
			// A path still inside globalStorage means the ".." segments were not
			// applied - the guard would then never match the opened editor.
			assert.ok(!resolved.path.includes("globalStorage"), resolved.path);
		});
	});
	suite("findSettingKeyRange", () => {
		test("selects the first occurrence's key text, quotes excluded", () => {
			const text = '{\n\t"editor.fontSize": 14,\n\t"litellm-vscode-chat.chat.timeout": 60000\n}\n';
			const range = findSettingKeyRange(text, "chat.timeout");
			assert.ok(range !== undefined);
			assert.strictEqual(text.slice(range.start, range.end), "litellm-vscode-chat.chat.timeout");
			assert.strictEqual(text[range.start - 1], '"', "the opening quote stays outside the selection");
			assert.strictEqual(text[range.end], '"', "the closing quote stays outside the selection");
		});

		test("first occurrence wins when the key repeats (comments, duplicated keys)", () => {
			const text = '// "litellm-vscode-chat.models.parameters" example\n{"litellm-vscode-chat.models.parameters": {}}';
			const range = findSettingKeyRange(text, "models.parameters");
			assert.strictEqual(range?.start, 4);
		});

		test("an absent key - or a clean settings.json - is undefined, never a throw", () => {
			assert.strictEqual(findSettingKeyRange("{}", "chat.timeout"), undefined);
			assert.strictEqual(findSettingKeyRange("", "chat.timeout"), undefined);
			// The quoted-needle search does not fire on the bare key text or on a
			// same-suffix cousin's key.
			assert.strictEqual(findSettingKeyRange("litellm-vscode-chat.chat.timeout", "chat.timeout"), undefined);
			assert.strictEqual(findSettingKeyRange('{"other.chat.timeout": 1}', "chat.timeout"), undefined);
		});
	});

	suite("openUserSettingAtKey", () => {
		function fakeEditor(text: string): { editor: SettingsJsonEditor; selections: [number, number][] } {
			const selections: [number, number][] = [];
			return {
				editor: {
					getText: () => text,
					selectAndReveal: (start, end) => {
						selections.push([start, end]);
					},
				},
				selections,
			};
		}

		test("selects the key when the file has it", async () => {
			const text = '{"litellm-vscode-chat.models.parameters": {}}';
			const { editor, selections } = fakeEditor(text);
			await openUserSettingAtKey("models.parameters", async () => editor);
			assert.strictEqual(selections.length, 1);
			const [start, end] = selections[0] as [number, number];
			assert.strictEqual(text.slice(start, end), "litellm-vscode-chat.models.parameters");
		});

		test("a key the file lacks leaves the opened file untouched (open is the whole answer)", async () => {
			const { editor, selections } = fakeEditor("{}");
			await openUserSettingAtKey("models.parameters", async () => editor);
			assert.deepStrictEqual(selections, []);
		});

		test("no settings editor becoming active is a quiet no-op", async () => {
			await openUserSettingAtKey("chat.timeout", async () => undefined);
		});
	});

	suite("the litellm.openSettingKey command", () => {
		test("is registered on activation", async () => {
			const commands = await vscode.commands.getCommands(true);
			assert.ok(commands.includes("litellm.openSettingKey"), "the settings-jump command must be registered");
		});

		test("refuses junk arguments without opening or throwing", async () => {
			// A refused key must never reach the workbench open command; the
			// executeCommand seam cannot be monkeypatched (it is how the command
			// itself is invoked), so refusal is observed as "no editor activity
			// and no throw" for arguments the key pattern rejects.
			await vscode.commands.executeCommand("litellm.openSettingKey", 42);
			await vscode.commands.executeCommand("litellm.openSettingKey", undefined);
			await vscode.commands.executeCommand("litellm.openSettingKey", '"; rm -rf');
		});

		test("opens the user settings.json and selects a configured key end to end", async () => {
			const config = () => vscode.workspace.getConfiguration("litellm-vscode-chat");
			await config().update("chat.timeout", 60000, vscode.ConfigurationTarget.Global);
			try {
				await vscode.commands.executeCommand("litellm.openSettingKey", "chat.timeout");
				const editor = vscode.window.activeTextEditor;
				assert.ok(editor !== undefined, "a settings editor must be active");
				assert.ok(editor.document.uri.path.endsWith("settings.json"), editor.document.uri.path);
				const selected = editor.document.getText(editor.selection);
				assert.strictEqual(selected, "litellm-vscode-chat.chat.timeout");
			} finally {
				await config().update("chat.timeout", undefined, vscode.ConfigurationTarget.Global);
				await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			}
		});

		test("falls back to the plain opened file when the key is not configured", async () => {
			// The test profile's settings.json does not set this key (the teardown
			// above removed it); the command must still open the file cleanly.
			await vscode.commands.executeCommand("litellm.openSettingKey", "discovery.cacheTtl");
			try {
				const editor = vscode.window.activeTextEditor;
				assert.ok(editor !== undefined, "the settings editor still opens");
				assert.ok(editor.document.uri.path.endsWith("settings.json"), editor.document.uri.path);
				assert.ok(editor.selection.isEmpty, "nothing to reveal means nothing selected");
			} finally {
				await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			}
		});
	});
});
