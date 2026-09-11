import * as vscode from "vscode";
import { statusErrorTexts } from "../../provider/transport/errorMapping";
import type { Logger } from "../../shared/logger";
import { commandErrorActions, showActionableMessage } from "../ui/notifier";

/**
 * This is the command features' one failure boundary.
 * It lives at the features/ root because features may not import each other.
 * Cancellation stays silent by invariant.
 * Everything else logs exactly once here.
 * The consult tool does not call this, because it must rethrow to the chat view that invoked it.
 * A helper that sometimes rethrows would be two behaviors under one name.
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
