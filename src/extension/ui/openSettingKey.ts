/**
 * The settings.json jump behind the dashboard's revealSetting intent: open the
 * USER settings.json and select the first occurrence of
 * "litellm-vscode-chat.<key>". The file is opened through the host's own
 * "Preferences: Open User Settings (JSON)" command rather than a derived
 * filesystem path, because the host resolves the profile's real settings
 * resource and creates the file when it does not exist yet. Best-effort by
 * contract: a key the file does not contain leaves the plain opened file as
 * the whole answer.
 */

import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { INTERNAL_CMD } from "../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import type { Logger } from "../../shared/logger";
import { profileUserFileUri } from "./profilePath";

/** The host command that opens (and creates if needed) the profile's user settings.json. */
const OPEN_USER_SETTINGS_JSON = "workbench.action.openSettingsJson";

/**
 * The keys the command acts on: dotted setting names, nothing else. The
 * dashboard's intent layer already pins keys to REVEALABLE_SETTING_IDS; this
 * re-check covers direct executeCommand callers, so a junk argument degrades
 * to a refusal instead of a search for arbitrary text.
 */
const SETTING_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.]*$/;

/**
 * The character range of the first `"litellm-vscode-chat.<key>"` occurrence,
 * quotes excluded. Undefined when the file does not mention the key - a clean
 * settings.json is a normal answer, not an error.
 */
export function findSettingKeyRange(text: string, key: string): { start: number; end: number } | undefined {
	const needle = `"${CONFIG_SECTION}.${key}"`;
	const index = text.indexOf(needle);
	return index < 0 ? undefined : { start: index + 1, end: index + needle.length - 1 };
}

/** The slice of the opened settings editor the reveal uses; the register function adapts vscode.TextEditor. */
export interface SettingsJsonEditor {
	getText(): string;
	/** Select the character range and scroll it into view. */
	selectAndReveal(start: number, end: number): void;
}

/**
 * Open the user settings.json and land on the key when the file has it.
 * `openSettingsJson` resolves to undefined when no settings editor became
 * active - the open itself is then all this command can honestly do.
 */
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
 * Where the profile keeps its user settings.json (see profileUserFileUri for
 * the derivation). The reveal compares the opened editor against this path and
 * stands down on a mismatch - a workspace .vscode/settings.json that wins
 * focus must never receive the selection.
 */
export function resolveUserSettingsUri(globalStorageUri: vscode.Uri): vscode.Uri {
	return profileUserFileUri(globalStorageUri, "settings.json");
}

/**
 * The command body, exported so tests can drive it with an injected opener:
 * refuse anything but a dotted setting key before any open, then best-effort
 * reveal. Never throws to the caller; a failed open logs a classification -
 * never the key or any file text - and shows a plain error toast.
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
		void vscode.window.showErrorMessage(l10n.t("LiteLLM: Could not open the user settings.json."));
	}
}

/** Register litellm.openSettingKey, wiring handleOpenSettingKey to the host's settings-json opener. */
export function registerOpenSettingKeyCommand(context: vscode.ExtensionContext, logger: Logger): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(INTERNAL_CMD.openSettingKey, (key: unknown) =>
			handleOpenSettingKey(
				key,
				async () => {
					await vscode.commands.executeCommand(OPEN_USER_SETTINGS_JSON);
					const editor = vscode.window.activeTextEditor;
					// Select only in the document the command was asked to open, compared
					// by path so a scheme difference cannot defeat the check: if
					// something else won the focus race, the plain open is the whole
					// answer rather than a selection scribbled into another document.
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
