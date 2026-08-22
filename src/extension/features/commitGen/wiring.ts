import * as vscode from "vscode";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import { CMD } from "../../../shared/config/commandIds";
import type { Logger } from "../../../shared/logger";
import { runGenerateCommitMessage } from "./generateCommitCommand";

/**
 * Commit-generation wiring: the handler is registered unconditionally (the
 * SCM-title and palette surfaces hide behind the enable when-clause, but
 * executeCommand and keybindings do not), and the run function answers a
 * disabled invocation with the enable hint. `oneShot` is the activation-shared
 * client, so OAuth tokens cache across invocations and across features and
 * invalidate on 401 like the chat and usage paths.
 */
export function wireCommitGeneration(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: { readonly oneShot: OneShotClient; readonly outputChannel: vscode.OutputChannel }
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.generateCommitMessage, (commandArg?: unknown) =>
			runGenerateCommitMessage(
				deps.oneShot,
				{ secrets: context.secrets, logger, outputChannel: deps.outputChannel },
				commandArg
			)
		)
	);
}
