/**
 * The dashboard probes' shared cancellation scaffold, pinned directly (it
 * shipped covered only through the feature wirings' probes): withProbeToken
 * hands the run a fresh token from a source that stays live for the run's
 * whole pendency, passes the result and the error through untouched, and
 * disposes the source in finally on every path - resolve, rejection, and a
 * synchronous throw alike - so probes cannot accumulate live sources across
 * dashboard sessions. Disposal is counted live, so a mutant that disposes
 * before or during the run fails the pending-count pin, not just the totals.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import { withProbeToken } from "../../../extension/features/probeToken";

/** Run `fn` with a live count of CancellationTokenSource disposals process-wide. */
async function withDisposalCount<T>(fn: (count: () => number) => Promise<T>): Promise<T> {
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

suite("extension/features probeToken", () => {
	test("the run receives a live token and its resolution passes through untouched", async () => {
		let seen: vscode.CancellationToken | undefined;
		const sentinel = { body: "probe answer" };
		const result = await withProbeToken(async (token) => {
			seen = token;
			return sentinel;
		});
		assert.strictEqual(result, sentinel, "the run's resolution is returned as-is");
		assert.ok(seen !== undefined, "the run receives a token");
		assert.strictEqual(seen.isCancellationRequested, false, "the token starts uncancelled");
		assert.strictEqual(typeof seen.onCancellationRequested, "function", "the token is a real CancellationToken");
	});

	test("the source stays live while the run is pending, and each call disposes its own fresh source once", async () => {
		await withDisposalCount(async (count) => {
			let release: (value: string) => void = () => {};
			const gate = new Promise<string>((resolve) => {
				release = resolve;
			});
			let first: vscode.CancellationToken | undefined;
			const pending = withProbeToken((token) => {
				first = token;
				return gate;
			});
			// The pin codifying "the send's own timeout bounds the call": nothing
			// may dispose the source before the run settles.
			assert.strictEqual(count(), 0, "the source stays live while the run is pending");
			assert.strictEqual(first?.isCancellationRequested, false, "the pending token is uncancelled");
			release("done");
			assert.strictEqual(await pending, "done", "the deferred resolution passes through");
			assert.strictEqual(count(), 1, "settlement disposes the source exactly once");
			const second = await withProbeToken(async (token) => token);
			assert.ok(first !== undefined && second !== first, "each call mints its own token");
			assert.strictEqual(count(), 2, "the second call disposes its own source");
		});
	});

	test("a rejected run disposes the source in finally and the error passes through untouched", async () => {
		const boom = new Error("probe failed");
		await withDisposalCount(async (count) => {
			await assert.rejects(
				withProbeToken(() => Promise.reject(boom)),
				(error: unknown) => {
					assert.strictEqual(error, boom, "the rejection reaches the caller as-is");
					return true;
				}
			);
			assert.strictEqual(count(), 1, "a rejected probe still releases its source");
		});
	});

	test("a synchronous throw inside the run still disposes the source", async () => {
		const boom = new Error("threw before returning a promise");
		await withDisposalCount(async (count) => {
			await assert.rejects(
				withProbeToken(() => {
					throw boom;
				}),
				(error: unknown) => {
					assert.strictEqual(error, boom, "the synchronous throw reaches the caller as-is");
					return true;
				}
			);
			assert.strictEqual(count(), 1, "the finally covers the synchronous-throw path too");
		});
	});
});
