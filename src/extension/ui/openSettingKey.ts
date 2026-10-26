/**
 * Best-effort by contract: a key the file does not contain leaves the plain opened file as the whole answer.
 */

import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { INTERNAL_CMD } from "../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import type { Logger } from "../../shared/logger";
import { showMessage } from "./notifier";
import { profileUserFileUri } from "./profilePath";

/** The host's own command resolves the profile's real settings resource and creates the file; a derived path cannot. */
const OPEN_USER_SETTINGS_JSON = "workbench.action.openSettingsJson";

/** Direct executeCommand callers bypass the intent layer's REVEALABLE_SETTING_IDS pin; junk degrades to a refusal. */
const SETTING_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.]*$/;

export function findSettingKeyRange(text: string, key: string): { start: number; end: number } | undefined {
	const needle = `"${CONFIG_SECTION}.${key}"`;
	const index = text.indexOf(needle);
	return index < 0 ? undefined : { start: index + 1, end: index + needle.length - 1 };
}

export interface SettingsJsonEditor {
	getText(): string;
	selectAndReveal(start: number, end: number): void;
}

export async function openUserSettingAtKey(
	key: string,
	openSettingsJson: () => Promise<SettingsJsonEditor | undefined>
): Promise<void> {
	const editor = await openSettingsJson();
	if (editor === undefined) {
		return;
	}
	const range = findSettingKeyRange(editor.getText(), key);
	if (range === undefined) {
		return;
	}
	editor.selectAndReveal(range.start, range.end);
}

/**
 * The reveal compares the opened editor against this path and stands down on a mismatch - a workspace
 * .vscode/settings.json that wins focus must never receive the selection.
 */
export function resolveUserSettingsUri(globalStorageUri: vscode.Uri): vscode.Uri {
	return profileUserFileUri(globalStorageUri, "settings.json");
}

/**
 * Never throws to the caller; a failed open logs a classification - never the key or any file text - and shows a plain
 * error toast.
 */
export async function handleOpenSettingKey(
	key: unknown,
	openSettingsJson: () => Promise<SettingsJsonEditor | undefined>,
	logger: Pick<Logger, "log">
): Promise<void> {
	if (typeof key !== "string" || !SETTING_KEY_PATTERN.test(key)) {
		logger.log("openSettingKey refused a malformed key argument");
		return;
	}
	try {
		await openUserSettingAtKey(key, openSettingsJson);
	} catch {
		logger.log("Open user settings.json failed");
		void showMessage("error", l10n.t("LiteLLM: Could not open the user settings.json."), []);
	}
}

export function registerOpenSettingKeyCommand(context: vscode.ExtensionContext, logger: Logger): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(INTERNAL_CMD.openSettingKey, (key: unknown) =>
			handleOpenSettingKey(
				key,
				async () => {
					await vscode.commands.executeCommand(OPEN_USER_SETTINGS_JSON);
					const editor = vscode.window.activeTextEditor;
					// Select only in the document the command was asked to open, compared by path so a scheme
					// difference cannot defeat the check: if something else won the focus race, the plain open is the
					// whole answer rather than a selection scribbled into another document.
					const expectedPath = resolveUserSettingsUri(context.globalStorageUri).path;
					if (editor === undefined || editor.document.uri.path !== expectedPath) {
						return undefined;
					}
					return {
						getText: () => editor.document.getText(),
						selectAndReveal: (start, end) => {
							const range = new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end));
							editor.selection = new vscode.Selection(range.start, range.end);
							editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
						},
					};
				},
				logger
			)
		)
	);
}
