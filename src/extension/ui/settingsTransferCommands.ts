/**
 * The settings export/import command surface. This registration skeleton
 * pins the three palette commands to their ids; the real flows (dialogs,
 * prompts, snapshot persistence) land here next, driving the pure core in
 * src/extension/settingsTransfer/ (envelope, secretSurgery, exportBuild,
 * importPlan, snapshot). Until then every command reports unimplemented.
 */

import * as vscode from "vscode";
import { CMD } from "../../shared/config/commandIds";

/** LiteLLM: Export Settings... - the full export flow (secrets prompt, save dialog, file write). */
function runExportSettingsFlow(): never {
	throw new Error("unimplemented");
}

/** LiteLLM: Import Settings... - the full import flow (open dialog, preview, collision prompts, snapshot, apply). */
function runImportSettingsFlow(): never {
	throw new Error("unimplemented");
}

/** LiteLLM: Undo Last Settings Import - the wholesale pre-import snapshot restore. */
function runUndoLastImportFlow(): never {
	throw new Error("unimplemented");
}

export function registerSettingsTransferCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.exportSettings, () => runExportSettingsFlow()),
		vscode.commands.registerCommand(CMD.importSettings, () => runImportSettingsFlow()),
		vscode.commands.registerCommand(CMD.undoLastImport, () => runUndoLastImportFlow())
	);
}
