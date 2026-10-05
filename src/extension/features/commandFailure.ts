import * as vscode from "vscode";
import { type FailureLineMessage, logFailure } from "../../provider/catalog/discoveryLog";
import { thrownErrorDisplayText } from "../../provider/transport/errorMapping";
import { transportClassificationOf } from "../../shared/errorClassification";
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
	logLine: FailureLineMessage
): Promise<void> {
	if (error instanceof vscode.CancellationError) {
		// User cancellation: never logged, nothing to show.
		return;
	}
	logFailure((message, data, cause) => deps.logger.failure(message, data, cause), logLine, error);
	await showActionableMessage(
		"error",
		thrownErrorDisplayText(error),
		commandErrorActions(transportClassificationOf(error), deps.outputChannel)
	);
}
