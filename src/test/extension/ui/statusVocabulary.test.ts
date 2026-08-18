/**
 * The host half of the cross-surface serving-vocabulary pin (the bun webview
 * suite is the other half; src/test/statusVocabulary.ts is the shared table):
 * for every window state, the status bar, the notifier, the shared verdict,
 * and the diagnostics paste line must say what the table says; the table's
 * hand-written dashboard rows must be what the REAL state builder produces;
 * the table itself must be class-consistent; and coverage fails closed - every
 * verdict and every pill word must have a row.
 */

import * as assert from "node:assert";
import * as vscode from "vscode";
import { classifyOverall, overallStatusText } from "../../../dashboard/presenters";
import { buildDashboardState, type SettingsReader } from "../../../extension/dashboard/state";
import type { DeclaredServerView } from "../../../extension/servers/serverSync";
import { Notifier } from "../../../extension/ui/notifier";
import type { Timer } from "../../../shared/util/timer";
import { aggregateContradictions, uncoveredPills, uncoveredVerdicts, WINDOW_STATE_ROWS } from "../../statusVocabulary";
import { createStatusBarManager, RecordingItem } from "./statusBarHarness";

/** The notifier's deferral timer, fired synchronously so the deferred no-servers claim lands inside the test. */
const IMMEDIATE_TIMER: Timer = {
	set: (callback) => {
		callback();
		return () => {};
	},
};

const EMPTY_READER: SettingsReader = { get: () => undefined, inspect: () => ({ defaultValue: undefined }) };

suite("extension/ui statusVocabulary (cross-surface table, host half)", () => {
	const createdContexts: vscode.ExtensionContext[] = [];
	let toasts: { kind: "info" | "warning" | "error"; message: string }[];
	let restore: () => void;

	setup(() => {
		toasts = [];
		const origInfo = vscode.window.showInformationMessage;
		const origWarn = vscode.window.showWarningMessage;
		const origError = vscode.window.showErrorMessage;
		const record =
			(kind: "info" | "warning" | "error") =>
			async (message: string): Promise<undefined> => {
				toasts.push({ kind, message });
				return undefined;
			};
		(vscode.window as Record<string, unknown>).showInformationMessage = record("info");
		(vscode.window as Record<string, unknown>).showWarningMessage = record("warning");
		(vscode.window as Record<string, unknown>).showErrorMessage = record("error");
		restore = () => {
			(vscode.window as Record<string, unknown>).showInformationMessage = origInfo;
			(vscode.window as Record<string, unknown>).showWarningMessage = origWarn;
			(vscode.window as Record<string, unknown>).showErrorMessage = origError;
		};
	});
	teardown(() => {
		restore();
		for (const context of createdContexts.splice(0)) {
			for (const disposable of context.subscriptions) {
				disposable.dispose();
			}
		}
	});

	test("the table's own expectations are class-consistent (no surface may contradict another)", () => {
		for (const row of WINDOW_STATE_ROWS) {
			assert.deepStrictEqual(aggregateContradictions(row), [], row.name);
		}
	});

	test("coverage fails closed: every verdict and every pill word has a row", () => {
		assert.deepStrictEqual(uncoveredVerdicts(), [], "every OverallVerdict needs a window-state row");
		assert.deepStrictEqual(uncoveredPills(), [], "every pill word needs a window-state row");
	});

	test("the dashboard rows are what the REAL state builder makes of the window", () => {
		// The one-vocabulary pin behind the modelCount/declaredModelCount split:
		// the table's rows are hand-written for the bun suite, so this test
		// rebuilds them through buildDashboardState and proves the mirror holds -
		// same state, the SAME served count, same expectedness - field by field.
		for (const row of WINDOW_STATE_ROWS) {
			const declaredRows = row.rows.filter((server) => server.origin === "declared");
			const declared: DeclaredServerView[] = declaredRows.map((server) => ({
				label: server.label,
				baseUrl: server.baseUrl,
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				expectedClientId: row.window.find((status) => status.label === server.label)?.serverId,
			}));
			const state = buildDashboardState({
				snapshots: row.window.map((status) => ({ status, models: [], discoveredRawIds: [] })),
				reader: EMPTY_READER,
				declared,
				isGroupSnapshot: () => true,
			});
			// Exactly the table's rows, no extras: a builder inventing a row would
			// change every verdict without failing a per-row lookup.
			assert.strictEqual(state.servers.length, declaredRows.length, `${row.name}: row count`);
			for (const expected of declaredRows) {
				const built = state.servers.find((server) => server.label === expected.label);
				assert.ok(built !== undefined, `${row.name}: the builder must produce the "${expected.label}" row`);
				assert.strictEqual(built.state, expected.state, `${row.name}: state of "${expected.label}"`);
				assert.strictEqual(
					built.servedModelCount,
					expected.servedModelCount,
					`${row.name}: served count of "${expected.label}"`
				);
				if (built.state === "error" && expected.state === "error") {
					assert.strictEqual(built.expected, expected.expected, `${row.name}: expectedness of "${expected.label}"`);
					assert.strictEqual(
						built.declaredModelCount,
						expected.declaredModelCount,
						`${row.name}: declared count of "${expected.label}"`
					);
					assert.strictEqual(built.error, expected.error, `${row.name}: error of "${expected.label}"`);
				}
			}
			// The table's totalModels is the merged count reportMerged derives.
			assert.strictEqual(
				row.window.reduce((sum, status) => sum + status.servedModelCount, 0),
				row.totalModels,
				`${row.name}: totalModels`
			);
		}
	});

	test("one verdict from both inputs: the window and the dashboard rows classify identically", () => {
		for (const row of WINDOW_STATE_ROWS) {
			assert.strictEqual(classifyOverall(row.rows), row.expect.verdict, `${row.name}: rows verdict`);
			if (row.window.length > 0) {
				assert.strictEqual(classifyOverall(row.window), row.expect.verdict, `${row.name}: window verdict`);
			}
		}
	});

	test("the status bar renders each window state with the table's state and severity", async () => {
		for (const row of WINDOW_STATE_ROWS) {
			const item = new RecordingItem();
			const harness = createStatusBarManager({ hasConfiguredServers: () => row.configured, item });
			createdContexts.push(harness.context);
			harness.manager.handleAggregatedStatus({
				serverStatuses: [...row.window],
				totalModels: row.totalModels,
				silent: true,
			});
			await new Promise((resolve) => setImmediate(resolve));

			assert.strictEqual(harness.manager.connectionStatus.state, row.expect.bar.state, `${row.name}: bar state`);
			assert.strictEqual(item.last.severity, row.expect.bar.severity, `${row.name}: bar severity`);
		}
	});

	test("the notifier toasts each window state with the table's kind, or stays silent", () => {
		for (const row of WINDOW_STATE_ROWS) {
			toasts.length = 0;
			// Zero grace on an immediate timer: the deferred no-servers claim (the
			// not-configured row) fires inside the test instead of 15s later.
			const notifier = new Notifier(() => row.configured, 0, IMMEDIATE_TIMER);
			notifier.handleAggregatedStatus({
				serverStatuses: [...row.window],
				totalModels: row.totalModels,
				silent: true,
			});
			notifier.dispose();
			if (row.expect.notifier === "none") {
				assert.deepStrictEqual(toasts, [], `${row.name}: no toast`);
			} else {
				const toast = toasts[0];
				assert.ok(toast !== undefined, `${row.name}: a toast must fire`);
				assert.strictEqual(toast.kind, row.expect.notifier.kind, `${row.name}: toast kind`);
				assert.ok(
					toast.message.includes(row.expect.notifier.contains),
					`${row.name}: toast "${toast.message}" must name "${row.expect.notifier.contains}"`
				);
			}
		}
	});

	test("the diagnostics paste line says what the table says", () => {
		for (const row of WINDOW_STATE_ROWS) {
			assert.strictEqual(overallStatusText([...row.rows], row.totalModels), row.expect.statusLine, row.name);
		}
	});
});
