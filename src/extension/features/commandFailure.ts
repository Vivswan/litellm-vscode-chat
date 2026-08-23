import * as vscode from "vscode";
import { statusErrorTexts } from "../../provider/transport/errorMapping";
import type { Logger } from "../../shared/logger";
import { commandErrorActions, showActionableMessage } from "../ui/notifier";

/**
 * The command features' ONE failure boundary, at the features/ root (like
 * featureChatSend.ts) because features may not import each other: cancellation
 * is silent by invariant, everything else logs exactly once at the feature's
 * own boundary and answers with the shared error notification. The consult
 * tool deliberately does not call this - it must RETHROW so the classified
 * error travels on to the chat view that invoked it, and a shared helper that
 * sometimes rethrows would be two behaviors under one name.
 *
 * `logLine` is log output, so it stays English by policy.
 */
export async function reportCommandFailure(
	deps: { readonly logger: Logger; readonly outputChannel: vscode.OutputChannel },
	error: unknown,
	logLine: string
): Promise<void> {
	if (error instanceof vscode.CancellationError) {
		// User cancellation: never logged, nothing to show.
		return;
	}
	// The feature's single logging boundary; the logger records the English
	// mirror or classification the thrown error carries.
	deps.logger.error(logLine, error);
	const texts = statusErrorTexts(error);
	await showActionableMessage("error", texts.error, commandErrorActions(texts.classification, deps.outputChannel));
}
