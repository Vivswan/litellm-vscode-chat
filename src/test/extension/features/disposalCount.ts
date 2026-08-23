/**
 * The probe suites' shared disposal counter: every dashboard-probe pin proves
 * "the source is released exactly once, on every settlement path" by counting
 * CancellationTokenSource disposals process-wide. The count is live (read
 * through `count()`), so a suite can pin mid-run state - a mutant that
 * disposes before or during the run fails the pending-count pin, not just the
 * totals - and the prototype patch is restored in finally, so a failing suite
 * cannot leave the shared host's prototype patched for every later suite.
 */
import * as vscode from "vscode";

/** Run `fn` with a live count of CancellationTokenSource disposals process-wide. */
export async function withDisposalCount<T>(fn: (count: () => number) => Promise<T>): Promise<T> {
	const originalDispose = vscode.CancellationTokenSource.prototype.dispose;
	let disposals = 0;
	vscode.CancellationTokenSource.prototype.dispose = function (this: vscode.CancellationTokenSource) {
		disposals += 1;
		return originalDispose.call(this);
	};
	try {
		return await fn(() => disposals);
	} finally {
		vscode.CancellationTokenSource.prototype.dispose = originalDispose;
	}
}
