/**
 * The host's Manage Language Models editor, the one place a provider group
 * can really be deleted (extensions can only add groups). Feature-detected
 * because the command is the host's, not the API's: the removal notices and
 * the dashboard's hidden-groups line share this single detection.
 */

import * as vscode from "vscode";
import { HOST_CMD } from "../../shared/config/commandIds";

export async function manageLanguageModelsAvailable(): Promise<boolean> {
	const commands = await vscode.commands.getCommands(true);
	return commands.includes(HOST_CMD.manageLanguageModels);
}

/**
 * Open the editor, searched for `search` (one group name) when given. Resolves
 * false without opening anything on a host that lacks the command.
 */
export async function openManageLanguageModels(search?: string): Promise<boolean> {
	if (!(await manageLanguageModelsAvailable())) {
		return false;
	}
	await (search === undefined
		? vscode.commands.executeCommand(HOST_CMD.manageLanguageModels)
		: vscode.commands.executeCommand(HOST_CMD.manageLanguageModels, search));
	return true;
}
