import * as assert from "node:assert";
import * as vscode from "vscode";
import { detectSetupProblem, type SetupProblem, showSetupProblemGate } from "../../../extension/ui/setupGate";
import type { ConnectionStatus } from "../../../extension/ui/status";
import { SETUP_HINT_KINDS } from "../../../shared/errorClassification";
import { markLogSafe } from "../../../shared/logger";
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

	test("healthy and transient states are never setup problems", () => {
		const statuses: ConnectionStatus[] = [
			{ state: "connected", totalModels: 3, serverStatuses: [makeServerStatus({ modelCount: 3 })] },
			{
				state: "degraded",
				totalModels: 1,
				serverStatuses: [makeServerStatus({ modelCount: 1 }), makeServerStatus({ state: "error", error: "down" })],
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
		// test while telling users the wrong cause; the substrings pin each
		// message to its verdict, and the labels pin each verdict's buttons.
		const expected: Record<SetupProblem, { substring: string; labels: string[] }> = {
			"not-configured": {
				substring: "No server is configured yet",
				labels: ["Configure Now", "Report Anyway"],
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
			for (const problem of [...SETUP_HINT_KINDS, "not-configured"] as SetupProblem[]) {
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
