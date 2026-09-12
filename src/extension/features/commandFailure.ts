import * as vscode from "vscode";
import { statusErrorTexts } from "../../provider/transport/errorMapping";
import type { Logger } from "../../shared/logger";
import { commandErrorActions, showActionableMessage } from "../ui/notifier";

/**
 * The command features' one failure boundary, at the features/ root because features may not import each other.
 * The consult tool deliberately does not call it, because it must rethrow so the classified error reaches the
 * chat view that invoked it, and a helper that sometimes rethrows would be two behaviors under one name.
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
