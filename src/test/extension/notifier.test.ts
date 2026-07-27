import * as assert from "node:assert";
import * as vscode from "vscode";
import { Notifier, reconfigureAction } from "../../extension/notifier";
import type { AggregatedStatus, ServerStatus } from "../../shared/servers";
import { expectDefined } from "../testUtils";

suite("extension/notifier", () => {
	let toasts: { kind: "info" | "warning" | "error"; message: string; buttons: string[] }[];
	let restore: () => void;

	setup(() => {
		toasts = [];
		const origInfo = vscode.window.showInformationMessage;
		const origWarn = vscode.window.showWarningMessage;
		const origError = vscode.window.showErrorMessage;
		const record =
			(kind: "info" | "warning" | "error") =>
			async (message: string, ...buttons: string[]) => {
				toasts.push({ kind, message, buttons });
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

	teardown(() => restore());

	function serverStatus(state: "ok" | "error", modelCount: number, error?: string): ServerStatus {
		return {
			serverId: "srv1",
			label: "Default",
			baseUrl: "http://litellm.test",
			state,
			modelCount,
			error,
			lastChecked: new Date().toISOString(),
		};
	}

	const noServers = (silent = true): AggregatedStatus => ({ serverStatuses: [], totalModels: 0, silent });
	const allFailed = (error: string, silent = true): AggregatedStatus => ({
		serverStatuses: [serverStatus("error", 0, error)],
		totalModels: 0,
		silent,
	});
	const noModels = (silent = true): AggregatedStatus => ({
		serverStatuses: [serverStatus("ok", 0)],
		totalModels: 0,
		silent,
	});
	const success = (silent = true): AggregatedStatus => ({
		serverStatuses: [serverStatus("ok", 3)],
		totalModels: 3,
		silent,
	});

	test("same condition twice produces one toast", () => {
		const notifier = new Notifier();
		notifier.handleAggregatedStatus(noServers());
		notifier.handleAggregatedStatus(noServers());
		assert.strictEqual(toasts.length, 1);
		const toast = expectDefined(toasts[0]);
		assert.strictEqual(toast.kind, "warning");
		assert.ok(toast.message.includes("No servers configured"));
	});

	test("condition change produces a new toast", () => {
		const notifier = new Notifier();
		notifier.handleAggregatedStatus(noServers());
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		assert.strictEqual(toasts.length, 2);
		const toast = expectDefined(toasts[1]);
		assert.strictEqual(toast.kind, "error");
		assert.ok(toast.message.includes("ECONNREFUSED"));
	});

	test("different failure message counts as a new condition", () => {
		const notifier = new Notifier();
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		notifier.handleAggregatedStatus(allFailed("401 Unauthorized"));
		notifier.handleAggregatedStatus(allFailed("401 Unauthorized"));
		assert.strictEqual(toasts.length, 2);
	});

	test("successful refresh resets dedup so the same condition notifies again", () => {
		const notifier = new Notifier();
		notifier.handleAggregatedStatus(noServers());
		notifier.handleAggregatedStatus(success());
		notifier.handleAggregatedStatus(noServers());
		assert.strictEqual(toasts.length, 2);
	});

	test("non-silent refresh never toasts", () => {
		const notifier = new Notifier();
		notifier.handleAggregatedStatus(noServers(false));
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED", false));
		notifier.handleAggregatedStatus(noModels(false));
		assert.strictEqual(toasts.length, 0);
	});

	test("a silent failure toasts even when the same failure was seen non-silently first", () => {
		const notifier = new Notifier();
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED", false));
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED", true));
		assert.strictEqual(toasts.length, 1, "The non-silent pass must not consume the dedup signature");
		assert.strictEqual(expectDefined(toasts[0]).kind, "error");
	});

	test("zero models with reachable servers warns with recovery actions", () => {
		const notifier = new Notifier();
		notifier.handleAggregatedStatus(noModels());
		assert.strictEqual(toasts.length, 1);
		const toast = expectDefined(toasts[0]);
		assert.strictEqual(toast.kind, "warning");
		assert.ok(toast.message.includes("no models"));
		assert.deepStrictEqual(toast.buttons, ["Check Server", "Reconfigure", "Report Issue"]);
	});

	test("Configure Now routes to the server editor, not the hub menu", async () => {
		const executed: string[] = [];
		const origExecute = vscode.commands.executeCommand;
		(vscode.commands as Record<string, unknown>).executeCommand = async (command: string) => {
			executed.push(command);
		};
		try {
			await reconfigureAction("Configure Now").run();
		} finally {
			(vscode.commands as Record<string, unknown>).executeCommand = origExecute;
		}
		assert.deepStrictEqual(executed, ["litellm.manageServers"]);
	});
});
