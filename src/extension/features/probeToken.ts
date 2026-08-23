import * as vscode from "vscode";

/**
 * The dashboard probes' shared cancellation scaffold, at the features/ root
 * because features may not import each other: the source exists only to
 * satisfy each send's token seam (the send's own timeout bounds the call), and
 * it is disposed deterministically so probes cannot accumulate live sources
 * across dashboard sessions.
 */
export async function withProbeToken<T>(run: (token: vscode.CancellationToken) => Promise<T>): Promise<T> {
	const source = new vscode.CancellationTokenSource();
	try {
		return await run(source.token);
	} finally {
		source.dispose();
	}
}
