import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import type { AggregatedStatus } from "../../shared/servers";
import { discoveryHandlers, MODEL_INFO_URL, MODELS_URL, mswServer, TEST_BASE_URL, useMsw } from "../mocks/handlers";
import { expectDefined, makeProvider, withFetch } from "../testUtils";

suite("provider/diagnostics", () => {
	useMsw();

	test("status callback reports successful fetch with model count", async () => {
		const provider = makeProvider(TEST_BASE_URL);
		let callbackStatus: AggregatedStatus | undefined;
		provider.setStatusCallback((status: AggregatedStatus) => {
			callbackStatus = status;
		});
		mswServer.use(
			...discoveryHandlers({
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
			})
		);
		await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

		assert.ok(callbackStatus);
		assert.strictEqual(
			expectDefined(callbackStatus).silent,
			true,
			"The callback must carry the silent flag of the refresh"
		);
		assert.ok(expectDefined(callbackStatus).totalModels > 0);
		assert.ok(expectDefined(callbackStatus).serverStatuses.every((s) => s.state === "ok"));
	});

	test("status callback reports error on fetch failure", async () => {
		const provider = makeProvider(TEST_BASE_URL);
		let callbackStatus: AggregatedStatus | undefined;
		provider.setStatusCallback((status: AggregatedStatus) => {
			callbackStatus = status;
		});
		mswServer.use(
			http.get(MODEL_INFO_URL, () => HttpResponse.error()),
			http.get(MODELS_URL, () => HttpResponse.error())
		);
		await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

		assert.ok(callbackStatus);
		assert.equal(expectDefined(callbackStatus).totalModels, 0);
		assert.ok(expectDefined(callbackStatus).serverStatuses.some((s) => s.state === "error"));
		assert.ok(expectDefined(callbackStatus).serverStatuses.some((s) => s.error?.includes("Could not reach")));
	});

	// Stays on withFetch: msw cannot produce a rejection with an empty message.
	test("a failure with an empty message still reports a non-empty status message", async () => {
		const provider = makeProvider(TEST_BASE_URL);
		let callbackStatus: AggregatedStatus | undefined;
		provider.setStatusCallback((status: AggregatedStatus) => {
			callbackStatus = status;
		});
		await withFetch(
			async () => {
				throw new Error("");
			},
			() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
		);

		assert.ok(callbackStatus);
		const failure = expectDefined(callbackStatus).serverStatuses.find((s) => s.state === "error");
		assert.ok(
			expectDefined(failure).error.length > 0,
			"the error variant's message renders directly, so it must never be empty"
		);
	});

	test("status callback reports empty model list", async () => {
		const provider = makeProvider(TEST_BASE_URL);
		let callbackStatus: AggregatedStatus | undefined;
		provider.setStatusCallback((status: AggregatedStatus) => {
			callbackStatus = status;
		});
		mswServer.use(...discoveryHandlers({ object: "list", data: [] }));
		await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

		assert.ok(callbackStatus);
		assert.equal(expectDefined(callbackStatus).totalModels, 0);
	});

	test("status callback reports missing configuration", async () => {
		const provider = makeProvider();
		let callbackStatus: AggregatedStatus | undefined;
		provider.setStatusCallback((status: AggregatedStatus) => {
			callbackStatus = status;
		});
		await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

		assert.ok(callbackStatus);
		assert.equal(expectDefined(callbackStatus).totalModels, 0);
		assert.equal(expectDefined(callbackStatus).serverStatuses.length, 0);
	});

	test("output channel receives log messages", async () => {
		const logs: string[] = [];
		const mockOutputChannel = {
			info: (message: string) => logs.push(message),
			error: (message: string) => logs.push(message),
		} as unknown as vscode.LogOutputChannel;

		const provider = makeProvider(undefined, "test-key", mockOutputChannel);
		await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

		assert.ok(logs.length > 0);
		assert.ok(logs.some((log) => log.includes("provideLanguageModelChatInformation")));
		assert.ok(logs.some((log) => log.includes("No") && (log.includes("config") || log.includes("servers"))));
	});

	// Stays on withFetch: the assertion needs a known injected error message
	// ("Test error") to show up in the log lines, which msw cannot produce.
	test("output channel receives error logs at the error level", async () => {
		const errors: string[] = [];
		const mockOutputChannel = {
			info: () => {},
			error: (message: string) => errors.push(message),
		} as unknown as vscode.LogOutputChannel;

		const provider = makeProvider(TEST_BASE_URL, "test-key", mockOutputChannel);
		await withFetch(
			async () => {
				throw new Error("Test error");
			},
			() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
		);

		assert.ok(errors.length > 0);
		assert.ok(errors.some((line) => line.includes("Test error")));
	});
});
