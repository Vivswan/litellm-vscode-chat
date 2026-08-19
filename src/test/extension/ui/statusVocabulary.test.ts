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
import type { DashboardServer } from "../../../dashboard/viewModels";
import { buildDashboardState, type SettingsReader } from "../../../extension/dashboard/state";
import type { DeclaredServerView, ServerEntryReport } from "../../../extension/servers/serverSync";
import { applySyncFailures } from "../../../extension/servers/syncFailureOverlay";
import { Notifier } from "../../../extension/ui/notifier";
import { GroupStatusReporter } from "../../../provider/catalog/statusReporting";
import { StatusWindow } from "../../../provider/catalog/statusWindow";
import type { AggregatedStatus } from "../../../shared/servers";
import { isHiddenGroupServerStatus } from "../../../shared/servers";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import type { Timer } from "../../../shared/util/timer";
import type { WindowStateRow } from "../../statusVocabulary";
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

/**
 * The row's declared rows as sync-engine views: what the state builder joins
 * and what the bar's and notifier's overlay reads, with the row's sync
 * failures riding as syncError - the same one input on every surface.
 */
function declaredViews(row: WindowStateRow): DeclaredServerView[] {
	return row.rows
		.filter((server) => server.origin === "declared")
		.map((server) => {
			const failure = row.syncFailures?.find((candidate) => candidate.label === server.label);
			return {
				label: server.label,
				baseUrl: server.baseUrl,
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } as const,
				expectedClientId: row.window.find((status) => status.label === server.label)?.serverId,
				syncError: failure?.message,
				syncErrorClass: failure?.failureClass,
			};
		});
}

/**
 * The row's misconfigured rows as the parser's entry reports: what
 * serverSettingReports hands the state builder for an entry it refused, so the
 * mirror exercises the builder's misconfigured-row branch rather than assuming
 * the hand-written literal.
 */
function rejectedReports(row: WindowStateRow): ServerEntryReport[] {
	return row.rows
		.filter((server): server is Extract<DashboardServer, { origin: "misconfigured" }> => {
			return server.origin === "misconfigured";
		})
		.map((server, index) => ({
			index,
			label: server.label,
			baseUrl: server.baseUrl,
			problems: [...server.problems],
			accepted: false,
		}));
}

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
		// same state, the SAME served count, same expectedness, same notices -
		// field by field. Hidden window statuses become tombstones, the way the
		// removal store feeds the real builder; parser-refused entries ride in as
		// the entry reports serverSettingReports would produce for them.
		for (const row of WINDOW_STATE_ROWS) {
			const declaredRows = row.rows.filter((server) => server.origin === "declared");
			const rejects = rejectedReports(row);
			const state = buildDashboardState({
				snapshots: row.window.map((status) => ({ status, models: [] })),
				reader: EMPTY_READER,
				declared: { source: "engine", views: declaredViews(row) },
				entryReports: rejects,
				isGroupSnapshot: () => true,
				removedGroups: {
					tombstones: row.window
						.filter(isHiddenGroupServerStatus)
						.map((status) => ({ label: status.label, baseUrl: status.baseUrl })),
					origins: [],
				},
			});
			// Exactly the table's rows, no extras: a builder inventing a row would
			// change every verdict without failing a per-row lookup.
			assert.strictEqual(state.servers.length, declaredRows.length + rejects.length, `${row.name}: row count`);
			assert.strictEqual(state.hiddenGroups.length, row.hiddenGroups ?? 0, `${row.name}: hidden groups`);
			// The builder's merged served count is the same reduce the bar's
			// totalModels uses, so the hero can never contradict the table.
			assert.strictEqual(state.servedModelCount, row.totalModels, `${row.name}: servedModelCount`);
			for (const expected of declaredRows) {
				const built = state.servers.find((server) => server.label === expected.label);
				assert.ok(built !== undefined, `${row.name}: the builder must produce the "${expected.label}" row`);
				assert.strictEqual(built.state, expected.state, `${row.name}: state of "${expected.label}"`);
				assert.strictEqual(
					built.servedModelCount,
					expected.servedModelCount,
					`${row.name}: served count of "${expected.label}"`
				);
				assert.deepStrictEqual(
					built.notices ?? [],
					expected.notices ?? [],
					`${row.name}: notices of "${expected.label}"`
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
			// The misconfigured mirror is the whole row: the builder derives every
			// field of a parser-refused entry's row from the report alone.
			for (const expected of row.rows.filter((server) => server.origin === "misconfigured")) {
				const built = state.servers.find((server) => server.label === expected.label);
				assert.ok(built !== undefined, `${row.name}: the builder must produce the "${expected.label}" reject row`);
				assert.deepStrictEqual(built, expected, `${row.name}: the misconfigured "${expected.label}" row`);
			}
		}
	});

	test("the table's totalModels is the merged count reportMerged derives from the window", () => {
		// The claim asserted against the REAL reporter: record the row's window
		// into a StatusWindow and read the merged report back, so the table's
		// count can never drift from the reduce reportMerged actually runs.
		const groupServer = { baseUrl: normalizeBaseUrl("http://litellm.test"), apiKey: "" };
		const nothingServed = { discovered: [], declared: [] } as const;
		for (const row of WINDOW_STATE_ROWS) {
			const window = new StatusWindow(
				() => 0,
				() => 0
			);
			const reporter = new GroupStatusReporter(window);
			const reports: AggregatedStatus[] = [];
			reporter.setCallback((status) => reports.push(status));
			for (const status of row.window) {
				// The ok branch carries the observations parameter the error
				// overload forbids; passing none, the arms differ only in which
				// overload they satisfy, and merging them stops compiling.
				if (status.state === "ok") {
					window.record(status, nothingServed, groupServer, {});
				} else {
					window.record(status, nothingServed, groupServer);
				}
			}
			reporter.reportMerged(true);
			const merged = reports.at(-1);
			assert.ok(merged !== undefined, `${row.name}: reportMerged must report`);
			assert.deepStrictEqual(merged.serverStatuses, [...row.window], `${row.name}: the window statuses round-trip`);
			assert.strictEqual(merged.totalModels, row.totalModels, `${row.name}: totalModels`);
		}
	});

	test("one verdict from both inputs: the overlaid window and the dashboard rows classify identically", () => {
		for (const row of WINDOW_STATE_ROWS) {
			assert.strictEqual(
				classifyOverall(row.rows, { hiddenGroupCount: row.hiddenGroups ?? 0 }),
				row.expect.verdict,
				`${row.name}: rows verdict`
			);
			// The bar's real input: the window with the row's sync failures overlaid.
			const overlaid = applySyncFailures(row.window, declaredViews(row));
			if (overlaid.length > 0) {
				assert.strictEqual(classifyOverall(overlaid), row.expect.verdict, `${row.name}: window verdict`);
			}
		}
	});

	test("the status bar renders each window state with the table's state and severity", async () => {
		for (const row of WINDOW_STATE_ROWS) {
			const item = new RecordingItem();
			const harness = createStatusBarManager({
				hasConfiguredServers: () => row.configured,
				getDeclared: () => declaredViews(row),
				item,
			});
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
			const notifier = new Notifier(
				() => row.configured,
				() => declaredViews(row),
				0,
				IMMEDIATE_TIMER
			);
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
			assert.strictEqual(
				overallStatusText([...row.rows], row.totalModels, { hiddenGroupCount: row.hiddenGroups ?? 0 }),
				row.expect.statusLine,
				row.name
			);
		}
	});
});
