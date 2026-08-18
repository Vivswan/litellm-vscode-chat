import * as assert from "node:assert";
import * as vscode from "vscode";
import { detectSetupProblem, type SetupProblem, showSetupProblemGate } from "../../../extension/ui/setupGate";
import type { ConnectionStatus } from "../../../extension/ui/status";
import { SETUP_HINT_KINDS } from "../../../shared/errorClassification";
import { markLogSafe } from "../../../shared/logger";
import type { ServerStatus } from "../../../shared/servers";
import { makeServerStatus } from "../../testUtils";

suite("extension/ui/setupGate", () => {
	function errorStatus(overrides: Partial<Extract<ConnectionStatus, { state: "error" }>> = {}): ConnectionStatus {
		return {
			state: "error",
			error: "boom",
			logSafeError: markLogSafe("boom"),
			...overrides,
		};
	}

	/** The zero-model state rides "connected" now (nothing failed); the gate reads it from there. */
	function connectedStatus(
		overrides: { totalModels?: number; serverStatuses?: ServerStatus[] } = {}
	): ConnectionStatus {
		return { state: "connected", totalModels: 0, serverStatuses: [], ...overrides };
	}

	test("a not-configured status is the not-configured problem", () => {
		assert.strictEqual(detectSetupProblem({ state: "not-configured" }), "not-configured");
	});

	for (const setupHint of SETUP_HINT_KINDS) {
		test(`an error status hinted ${setupHint} is that problem`, () => {
			const status = errorStatus({ classification: { kind: "http", status: 404, setupHint } });
			assert.strictEqual(detectSetupProblem(status), setupHint);
		});
	}

	test("an error status without a classification is not a setup problem", () => {
		assert.strictEqual(detectSetupProblem(errorStatus()), undefined);
	});

	test("an error status with a hintless classification is not a setup problem", () => {
		// A classified failure without a setup hint is a real bug report (e.g. a
		// 500): the gate must not stand between it and GitHub.
		assert.strictEqual(detectSetupProblem(errorStatus({ classification: { kind: "http", status: 500 } })), undefined);
	});

	test("the zero-model verdict explained by a hidden group is the hidden-groups problem", () => {
		// The only group is tombstone-suppressed and the rollup built the
		// synthetic zero-model verdict, so Report Issue must route through the
		// gate instead of opening a blank issue.
		const status = connectedStatus({
			totalModels: 0,
			serverStatuses: [makeServerStatus({ servedModelCount: 0, hiddenByRemoval: true })],
		});
		assert.strictEqual(detectSetupProblem(status), "hidden-groups");
	});

	test("a zero-model verdict from servers that answered empty is not a setup problem", () => {
		// The server genuinely listed no models: that may be a real bug, so it
		// goes straight to GitHub like any unclassified error.
		const status = connectedStatus({
			totalModels: 0,
			serverStatuses: [makeServerStatus({ servedModelCount: 0 })],
		});
		assert.strictEqual(detectSetupProblem(status), undefined);
	});

	test("a hidden group beside an answering-empty server does not gate: the removal only partly explains it", () => {
		// The answering-empty server may be a real bug; the gate must not stand
		// between it and GitHub just because a hidden group also exists.
		const status = connectedStatus({
			totalModels: 0,
			serverStatuses: [
				makeServerStatus({ servedModelCount: 0, hiddenByRemoval: true }),
				makeServerStatus({ serverId: "srv2", servedModelCount: 0 }),
			],
		});
		assert.strictEqual(detectSetupProblem(status), undefined);
	});

	test("a hidden group beside an expected failure still gates: both outcomes are user-declared", () => {
		const status = connectedStatus({
			totalModels: 0,
			serverStatuses: [
				makeServerStatus({ servedModelCount: 0, hiddenByRemoval: true }),
				makeServerStatus({ serverId: "srv2", state: "error", error: "discovery down", expected: true }),
			],
		});
		assert.strictEqual(detectSetupProblem(status), "hidden-groups");
	});

	test("a hidden group beside served models never gates", () => {
		// Models are being served, so zero-models cannot be the complaint; the
		// hidden group is irrelevant to whatever error carried this status.
		const status = connectedStatus({
			totalModels: 3,
			serverStatuses: [
				makeServerStatus({ servedModelCount: 0, hiddenByRemoval: true }),
				makeServerStatus({ servedModelCount: 3 }),
			],
		});
		assert.strictEqual(detectSetupProblem(status), undefined);
	});

	test("a setup hint wins over the hidden-group explanation", () => {
		const status = errorStatus({
			totalModels: 0,
			classification: { kind: "connection", setupHint: "proxy-not-running" },
			serverStatuses: [makeServerStatus({ servedModelCount: 0, hiddenByRemoval: true })],
		});
		assert.strictEqual(detectSetupProblem(status), "proxy-not-running");
	});

	test("healthy and transient states are never setup problems", () => {
		const statuses: ConnectionStatus[] = [
			{ state: "connected", totalModels: 3, serverStatuses: [makeServerStatus({ servedModelCount: 3 })] },
			{
				state: "degraded",
				totalModels: 1,
				serverStatuses: [
					makeServerStatus({ servedModelCount: 1 }),
					makeServerStatus({ state: "error", error: "down" }),
				],
			},
			{ state: "loading" },
			{ state: "connecting", attention: true },
		];
		for (const status of statuses) {
			assert.strictEqual(detectSetupProblem(status), undefined, status.state);
		}
	});

	test("every gate message names its cause and carries its button set", async () => {
		// Swapping two gateMessage branches would compile and pass every other
		// test while naming the wrong cause: the substrings pin each message to
		// its verdict, and the labels pin each verdict's buttons.
		const expected: Record<SetupProblem, { substring: string; labels: string[] }> = {
			"not-configured": {
				substring: "No server is configured yet",
				labels: ["Configure Now", "Report Anyway"],
			},
			"hidden-groups": {
				substring: "hidden by an explicit removal",
				labels: ["Open Dashboard", "Report Anyway"],
			},
			"proxy-not-running": {
				substring: "nothing is answering at the configured address",
				labels: ["Troubleshooting Docs", "Test Connection", "Report Anyway"],
			},
			"configure-api-key": {
				substring: "the server rejected the API key",
				labels: ["Troubleshooting Docs", "Test Connection", "Report Anyway"],
			},
			"check-base-url": {
				substring: "the server answered 404 at the configured base URL",
				labels: ["Troubleshooting Docs", "Test Connection", "Report Anyway"],
			},
		};
		const original = vscode.window.showWarningMessage;
		const shown: { message: string; labels: string[] }[] = [];
		(vscode.window as { showWarningMessage: unknown }).showWarningMessage = (message: string, ...labels: string[]) => {
			shown.push({ message, labels });
			return Promise.resolve(undefined); // dismissed: no action runs
		};
		try {
			for (const problem of [...SETUP_HINT_KINDS, "not-configured", "hidden-groups"] as SetupProblem[]) {
				shown.length = 0;
				await showSetupProblemGate(problem, () => {
					throw new Error("dismissal must not report");
				});
				assert.strictEqual(shown.length, 1, problem);
				assert.ok(shown[0]?.message.includes(expected[problem].substring), `${problem}: ${shown[0]?.message}`);
				assert.deepStrictEqual(shown[0]?.labels, expected[problem].labels, problem);
			}
		} finally {
			(vscode.window as { showWarningMessage: unknown }).showWarningMessage = original;
		}
	});

	test("a failing Report Anyway surfaces an error toast instead of dying unheard", async () => {
		// The command voids the gate promise, so a rejection here would
		// otherwise vanish as an unhandled rejection with no user feedback.
		const origWarn = vscode.window.showWarningMessage;
		const origError = vscode.window.showErrorMessage;
		const errorToasts: string[] = [];
		(vscode.window as { showWarningMessage: unknown }).showWarningMessage = (_message: string, ...labels: string[]) =>
			Promise.resolve(labels.find((label) => label === "Report Anyway"));
		(vscode.window as { showErrorMessage: unknown }).showErrorMessage = (message: string) => {
			errorToasts.push(message);
			return Promise.resolve(undefined);
		};
		try {
			await showSetupProblemGate("check-base-url", () => Promise.reject(new Error("clipboard unavailable")));
			assert.strictEqual(errorToasts.length, 1);
			assert.ok(errorToasts[0]?.includes("Could not open the issue report"), `got: ${errorToasts[0]}`);
			assert.ok(errorToasts[0]?.includes("clipboard unavailable"), `got: ${errorToasts[0]}`);
		} finally {
			(vscode.window as { showWarningMessage: unknown }).showWarningMessage = origWarn;
			(vscode.window as { showErrorMessage: unknown }).showErrorMessage = origError;
		}
	});
});
