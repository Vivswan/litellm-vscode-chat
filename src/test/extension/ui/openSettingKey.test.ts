/**
 * The settings.json jump behind the dashboard's revealSetting intent: the pure
 * key search, the reveal flow over an injected editor, the command's
 * registration, and its refusal of junk arguments. The end-to-end open rides
 * the host's workbench.action.openSettingsJson, which the last test exercises
 * for real against the test profile's settings.json.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import type { SettingsJsonEditor } from "../../../extension/ui/openSettingKey";
import {
	findSettingKeyRange,
	handleOpenSettingKey,
	openUserSettingAtKey,
	resolveUserSettingsUri,
} from "../../../extension/ui/openSettingKey";
import { catalogOff, ensureActivated } from "../../hostApiHelpers";
import { countOccurrences, shippedSources } from "../../sourceScan";

suite("extension/ui/openSettingKey", () => {
	suite("resolveUserSettingsUri", () => {
		test("resolves settings.json two levels above global storage, like the groups-file command", () => {
			const globalStorage = vscode.Uri.file("/data/User/globalStorage/vivswan.litellm-vscode-chat");
			const resolved = resolveUserSettingsUri(globalStorage);
			assert.strictEqual(resolved.path, "/data/User/settings.json");
			// A path still inside globalStorage means ".." was not applied - the
			// guard would then never match the opened editor.
			assert.ok(!resolved.path.includes("globalStorage"), resolved.path);
		});
	});

	suite("the profile User-directory derivation has one home", () => {
		// The two-levels-up walk was once encoded separately in two deep links
		// (the settings reveal and the groups-file open), free to drift apart.
		// This pin fails closed both ways: a re-minted walk anywhere in shipped
		// source flags, and so does a deep link that stops consuming the helper.
		const helperFile = "src/extension/ui/profilePath.ts";

		test("profileUserFileUri owns the only two-levels-up walk in shipped source", () => {
			// A spelling pin, not a semantic one: it covers the joinPath walk's two
			// plausible spellings, which is what a copy-paste re-mint would carry.
			const walks = ['"..", ".."', '"../.."'];
			const holders = shippedSources().filter((source) => walks.some((walk) => source.text.includes(walk)));
			assert.deepStrictEqual(
				holders.map((source) => source.file),
				[helperFile],
				"a User-directory walk outside profileUserFileUri"
			);
			const occurrences = walks.reduce((sum, walk) => sum + countOccurrences(holders[0]?.text ?? "", walk), 0);
			assert.strictEqual(occurrences, 1, "exactly one walk, in the one helper");
		});

		test("both profile deep links resolve through the helper", () => {
			const call = "profileUserFileUri(";
			const callers = shippedSources()
				.filter((source) => source.file !== helperFile && source.text.includes(call))
				.map((source) => source.file)
				.sort();
			assert.deepStrictEqual(callers, ["src/extension/ui/commands.ts", "src/extension/ui/openSettingKey.ts"]);
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
		suiteSetup(async function () {
			this.timeout(30000);
			await ensureActivated();
			await catalogOff();
		});

		test("is registered on activation", async () => {
			const commands = await vscode.commands.getCommands(true);
			assert.ok(commands.includes("litellm.openSettingKey"), "the settings-jump command must be registered");
		});

		test("refuses junk arguments before any open, logging the refusal classification", async () => {
			const logged: string[] = [];
			const logger = {
				log: (message: string) => {
					logged.push(message);
				},
			};
			let opens = 0;
			const opener = async (): Promise<SettingsJsonEditor | undefined> => {
				opens += 1;
				return undefined;
			};

			for (const junk of [42, undefined, '"; rm -rf']) {
				await handleOpenSettingKey(junk, opener, logger);
			}

			assert.strictEqual(opens, 0, "a refused key must never reach the opener");
			assert.deepStrictEqual(
				logged,
				Array.from({ length: 3 }, () => "openSettingKey refused a malformed key argument")
			);
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
