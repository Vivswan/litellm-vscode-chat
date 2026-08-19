/**
 * The status fanout's sync leg: a completed sync pass must re-judge the status
 * bar and the notifier through the sync-failure overlay, because a sync-only
 * change (a failed upsert, a blocked entry clearing) never fires the
 * provider's status callback.
 */

import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DeclaredServerView } from "../../../extension/servers/serverSync";
import { Notifier } from "../../../extension/ui/notifier";
import { wireStatusFanout } from "../../../extension/wiring/ui";
import { Logger } from "../../../shared/logger";
import type { AggregatedStatus } from "../../../shared/servers";
import { createStatusBarManager, RecordingItem } from "../ui/statusBarHarness";

const UPSERT_FAILED = "The host rejected the provider group upsert";

function failedView(label: string): DeclaredServerView {
	return {
		label,
		baseUrl: `http://${label}.test`,
		secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
		syncError: UPSERT_FAILED,
		syncErrorClass: "upsertFailed",
	};
}

suite("extension/wiring statusFanout", () => {
	test("a sync completion re-renders the bar: the pass's failure reaches it with no provider report", async () => {
		let declared: readonly DeclaredServerView[] = [];
		const item = new RecordingItem();
		const harness = createStatusBarManager({
			hasConfiguredServers: () => true,
			getDeclared: () => declared,
			item,
		});
		let statusCallback: ((status: AggregatedStatus) => void) | undefined;
		let syncListener: (() => void) | undefined;
		const toasts: string[] = [];
		const origError = vscode.window.showErrorMessage;
		(vscode.window as Record<string, unknown>).showErrorMessage = async (message: string) => {
			toasts.push(message);
			return undefined;
		};
		try {
			wireStatusFanout(harness.context, new Logger({ info() {}, error() {} }), {
				provider: {
					setStatusCallback: (callback) => {
						statusCallback = callback;
					},
				},
				syncEngine: {
					onDidSync: (listener) => {
						syncListener = listener;
						return { dispose() {} };
					},
				},
				statusBar: harness.manager,
				notifier: new Notifier(
					() => true,
					() => declared
				),
				dashboard: { refresh: () => {} },
			});
			assert.ok(statusCallback !== undefined && syncListener !== undefined, "both legs must wire");

			// The cold-start groupless refresh: an empty window on a configured
			// install renders the neutral spinner.
			statusCallback({ serverStatuses: [], totalModels: 0, silent: true });
			const initial = harness.manager.connectionStatus;
			assert.strictEqual(initial.state, "connecting");

			// The sync pass fails the entry's upsert; its completion alone must
			// move the bar to the honest error, and toast it, with no provider
			// report in between.
			declared = [failedView("pending")];
			syncListener();
			await new Promise((resolve) => setImmediate(resolve));
			const failed = harness.manager.connectionStatus;
			assert.strictEqual(failed.state, "error");
			assert.strictEqual(item.last.severity, "error");
			assert.ok(item.last.tooltip.includes(UPSERT_FAILED), "the tooltip names the sync failure");
			assert.deepStrictEqual(toasts, [`LiteLLM: ${UPSERT_FAILED}`]);

			// The entry recovers on the next pass: the same leg re-judges back to
			// the spinner without waiting for a provider report.
			declared = [];
			syncListener();
			await new Promise((resolve) => setImmediate(resolve));
			const recovered = harness.manager.connectionStatus;
			assert.strictEqual(recovered.state, "connecting");
			assert.strictEqual(harness.manager.connectingAttention, false, "a sync replay never escalates the spinner");

			// A pass that changes nothing re-judges nothing: no render, no
			// escalation, no duplicate log lines.
			const renders = item.views.length;
			syncListener();
			await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(item.views.length, renders, "an unchanged overlay must not re-render");
			assert.strictEqual(harness.manager.connectingAttention, false);
		} finally {
			(vscode.window as Record<string, unknown>).showErrorMessage = origError;
			for (const disposable of harness.context.subscriptions) {
				disposable.dispose();
			}
		}
	});

	test("a sync failure surfaces even before any provider report exists", async () => {
		// Variant: activation's first pass fails before the host ever calls the
		// provider; refreshFromSync must judge the synthesized empty report.
		const item = new RecordingItem();
		const harness = createStatusBarManager({
			hasConfiguredServers: () => true,
			getDeclared: () => [failedView("pending")],
			item,
		});
		try {
			harness.manager.refreshFromSync();
			await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(harness.manager.connectionStatus.state, "error");
			assert.strictEqual(item.last.severity, "error");
		} finally {
			for (const disposable of harness.context.subscriptions) {
				disposable.dispose();
			}
		}
	});
});
