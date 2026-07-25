import * as assert from "node:assert";
import * as vscode from "vscode";
import type { AggregatedStatus } from "../../shared/servers";
import { jsonResponse, makeProvider, withFetch } from "../testUtils";

suite("provider/diagnostics", () => {
	test("status callback reports successful fetch with model count", async () => {
		const provider = makeProvider("http://test");
		let callbackStatus: AggregatedStatus | undefined;
		provider.setStatusCallback((status: AggregatedStatus) => {
			callbackStatus = status;
		});
		await withFetch(
			async () =>
				jsonResponse({
					object: "list",
					data: [
						{
							id: "model-1",
							object: "model",
							created: 0,
							owned_by: "test",
							providers: [{ provider: "test-provider", status: "active", supports_tools: true }],
						},
						{
							id: "model-2",
							object: "model",
							created: 0,
							owned_by: "test",
							providers: [{ provider: "test-provider", status: "active", supports_tools: true }],
						},
					],
				}),
			() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
		);

		assert.ok(callbackStatus);
		assert.strictEqual(callbackStatus!.silent, true, "The callback must carry the silent flag of the refresh");
		assert.ok(callbackStatus!.totalModels > 0);
		assert.ok(callbackStatus!.serverStatuses.every((s) => s.state === "ok"));
	});

	test("status callback reports error on fetch failure", async () => {
		const provider = makeProvider("http://test");
		let callbackStatus: AggregatedStatus | undefined;
		provider.setStatusCallback((status: AggregatedStatus) => {
			callbackStatus = status;
		});
		await withFetch(
			async () => {
				throw new Error("Network error");
			},
			() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
		);

		assert.ok(callbackStatus);
		assert.equal(callbackStatus!.totalModels, 0);
		assert.ok(callbackStatus!.serverStatuses.some((s) => s.state === "error"));
		assert.ok(callbackStatus!.serverStatuses.some((s) => s.error?.includes("Network")));
	});

	test("status callback reports empty model list", async () => {
		const provider = makeProvider("http://test");
		let callbackStatus: AggregatedStatus | undefined;
		provider.setStatusCallback((status: AggregatedStatus) => {
			callbackStatus = status;
		});
		await withFetch(
			async () => jsonResponse({ object: "list", data: [] }),
			() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
		);

		assert.ok(callbackStatus);
		assert.equal(callbackStatus!.totalModels, 0);
	});

	test("status callback reports missing configuration", async () => {
		const provider = makeProvider();
		let callbackStatus: AggregatedStatus | undefined;
		provider.setStatusCallback((status: AggregatedStatus) => {
			callbackStatus = status;
		});
		await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

		assert.ok(callbackStatus);
		assert.equal(callbackStatus!.totalModels, 0);
		assert.equal(callbackStatus!.serverStatuses.length, 0);
	});

	test("output channel receives log messages", async () => {
		const logs: string[] = [];
		const mockOutputChannel = {
			appendLine: (message: string) => logs.push(message),
			show: () => {},
			dispose: () => {},
		} as unknown as vscode.OutputChannel;

		const provider = makeProvider(undefined, "test-key", mockOutputChannel);
		await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

		assert.ok(logs.length > 0);
		assert.ok(logs.some((log) => log.includes("provideLanguageModelChatInformation")));
		assert.ok(logs.some((log) => log.includes("No") && (log.includes("config") || log.includes("servers"))));
	});

	test("output channel receives error logs with timestamps", async () => {
		const logs: string[] = [];
		const mockOutputChannel = {
			appendLine: (message: string) => logs.push(message),
			show: () => {},
			dispose: () => {},
		} as unknown as vscode.OutputChannel;

		const provider = makeProvider("http://test", "test-key", mockOutputChannel);
		await withFetch(
			async () => {
				throw new Error("Test error");
			},
			() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
		);

		assert.ok(logs.length > 0);
		assert.ok(logs.some((log) => log.includes("ERROR")));
		assert.ok(logs.some((log) => log.includes("Test error")));
		assert.ok(logs.some((log) => /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(log)));
	});
});
