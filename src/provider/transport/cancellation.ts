import * as vscode from "vscode";

/**
 * The host's cancellation class, handed to mapSdkError as its predicate: the mapper loads under bun, which has no
 * vscode module, so the one vscode value it needs arrives from its callers.
 */
export function isHostCancellation(error: unknown): error is vscode.CancellationError {
	return error instanceof vscode.CancellationError;
}
