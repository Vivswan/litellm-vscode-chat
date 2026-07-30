import * as assert from "node:assert";
import type * as vscode from "vscode";
import { StatusBarManager } from "../../extension/status";
import { Logger, markLogSafe } from "../../shared/logger";
import type { ServerStatus } from "../../shared/servers";
import { LAST_CONNECTION_STATUS_KEY } from "../../shared/storageKeys";

// Managers create real, visible status bar items in the shared test host
// window, so every created context is tracked and its subscriptions are
// disposed after each test.
const createdContexts: vscode.ExtensionContext[] = [];

function createManager(
	persistedStatus: unknown,
	hasConfiguredServers: () => boolean = () => false,
	recorder?: { appendLog(line: string): void; recordError(source: string, error: unknown): void }
): StatusBarManager {
	const mementoStore = new Map<string, unknown>();
	if (persistedStatus !== undefined) {
		mementoStore.set(LAST_CONNECTION_STATUS_KEY, persistedStatus);
	}
	const globalState = {
		get: (key: string, defaultValue?: unknown) => (mementoStore.has(key) ? mementoStore.get(key) : defaultValue),
		update: async (key: string, value: unknown) => {
			mementoStore.set(key, value);
		},
	} as unknown as vscode.Memento;
	const context = {
		subscriptions: [],
		globalState,
	} as unknown as vscode.ExtensionContext;
	createdContexts.push(context);
	return new StatusBarManager(context, new Logger({ info() {}, error() {} }, recorder), hasConfiguredServers);
}

suite("extension/status", () => {
	teardown(() => {
		for (const context of createdContexts.splice(0)) {
			for (const disposable of context.subscriptions) {
				disposable.dispose();
			}
		}
	});

	test("clicking the status bar item opens the dashboard", () => {
		const manager = createManager(undefined);

		assert.strictEqual(manager.clickCommand, "litellm.openDashboard");
	});

	test("an all-failed report logs the log-safe rendering, never the display error", () => {
		// The "All servers failed" line lands in the issue-report buffer, which
		// prefills public GitHub issues, so it must carry logSafeError; the
		// display error (which embeds the response body for http failures)
		// stays on the UI surfaces only.
		const bufferLines: string[] = [];
		const manager = createManager(undefined, () => true, {
			appendLog: (line) => bufferLines.push(line),
			recordError: () => {},
		});
		const failed: ServerStatus = {
			serverId: "srv1",
			label: "Prod",
			baseUrl: "http://prod.test",
			state: "error",
			error: "LiteLLM API error: 502\n<html>internal-billing-host-MARKER</html>",
			logSafeError: markLogSafe("RequestError(http, status 502)"),
			lastChecked: new Date().toISOString(),
		};

		manager.handleAggregatedStatus({ serverStatuses: [failed], totalModels: 0, silent: true });

		assert.ok(
			bufferLines.some((line) => line.includes("All servers failed: RequestError(http, status 502)")),
			`the buffer must carry the classification; lines: ${bufferLines.join(" | ")}`
		);
		assert.ok(
			bufferLines.every((line) => !line.includes("internal-billing-host-MARKER")),
			"the display error's body text leaked into the buffer"
		);
		const status = manager.connectionStatus;
		assert.ok(status.state === "error" && status.error.includes("MARKER"), "the display surface keeps the full text");
	});

	suite("the empty status window", () => {
		test("claims not-configured only when nothing proves servers exist", () => {
			const manager = createManager(undefined, () => false);

			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });

			assert.strictEqual(manager.connectionStatus.state, "not-configured");
		});

		test("renders as connecting while configured servers have not reported", () => {
			// Cold start on a group-configured install: the groupless refresh
			// reports an empty window before the per-group refreshes arrive. The
			// persisted state feeds public issue reports, so the honest verdict is
			// "connecting", never "not-configured".
			const manager = createManager(undefined, () => true);

			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });

			assert.strictEqual(manager.connectionStatus.state, "connecting");
			assert.strictEqual(manager.connectingAttention, false, "one empty report is normal cold-start ordering");
		});

		test("a second consecutive empty report degrades connecting to needs-attention", () => {
			// Evidence of persistence: a declared entry whose sync keeps failing or
			// a deleted native group behind a sticky latch must not spin neutrally
			// forever.
			const manager = createManager(undefined, () => true);

			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });
			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });

			assert.strictEqual(manager.connectionStatus.state, "connecting");
			assert.strictEqual(manager.connectingAttention, true);
		});

		test("a report with servers resets the connecting degradation", () => {
			const manager = createManager(undefined, () => true);
			const okStatus: ServerStatus = {
				serverId: "srv1",
				label: "Prod",
				baseUrl: "http://prod.test",
				state: "ok",
				modelCount: 2,
				lastChecked: new Date().toISOString(),
			};

			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });
			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });
			manager.handleAggregatedStatus({ serverStatuses: [okStatus], totalModels: 2, silent: true });
			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });

			assert.strictEqual(manager.connectionStatus.state, "connecting");
			assert.strictEqual(manager.connectingAttention, false, "the sweep in between restarts the evidence clock");
		});

		test("a restored persisted connecting state starts degraded, not spinning", () => {
			// The state survived a whole session boundary without resolving, so the
			// stale spinner from last session must not render indefinitely.
			const manager = createManager({ state: "connecting" }, () => true);

			assert.strictEqual(manager.connectionStatus.state, "connecting");
			assert.strictEqual(manager.connectingAttention, true);
		});

		test("a transient loading state does not clear the connecting attention", async () => {
			// The connection test overwrites the status with "loading" before it
			// runs; an empty report arriving mid-test must not reset the warning
			// back to the neutral spinner.
			const manager = createManager(undefined, () => true);

			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });
			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });
			assert.strictEqual(manager.connectingAttention, true);

			await manager.updateStatusBar({ state: "loading" });
			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });

			assert.strictEqual(manager.connectionStatus.state, "connecting");
			assert.strictEqual(manager.connectingAttention, true, "the transient loading state must carry the evidence");
		});

		test("a loading state over a neutral connecting stays neutral", async () => {
			const manager = createManager(undefined, () => true);

			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });
			assert.strictEqual(manager.connectingAttention, false);

			await manager.updateStatusBar({ state: "loading" });
			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });

			assert.strictEqual(manager.connectionStatus.state, "connecting");
			assert.strictEqual(manager.connectingAttention, false, "loading must not invent attention it never carried");
		});
	});

	suite("persisted status restore normalizes at the trust boundary", () => {
		test("a connected status missing its counts restores with defaults", () => {
			const manager = createManager({ state: "connected" });

			assert.deepStrictEqual(manager.connectionStatus, { state: "connected", totalModels: 0, serverStatuses: [] });
		});

		for (const state of ["not-configured", "loading"] as const) {
			test(`restores state "${state}"`, () => {
				const manager = createManager({ state });

				assert.deepStrictEqual(manager.connectionStatus, { state });
			});
		}

		for (const state of ["connected", "degraded"] as const) {
			test(`restores state "${state}" with its counts`, () => {
				const manager = createManager({ state, totalModels: 3, serverStatuses: [] });

				assert.deepStrictEqual(manager.connectionStatus, { state, totalModels: 3, serverStatuses: [] });
			});
		}

		test("restores an error status with its message; a pre-upgrade one gets the fail-closed log rendering", () => {
			const manager = createManager({ state: "error", error: "boom" });

			assert.deepStrictEqual(manager.connectionStatus, {
				state: "error",
				error: "boom",
				// Persisted before logSafeError existed: the display message may
				// embed response text, so it never gets promoted to the log slot.
				logSafeError: "server error restored from a previous session (message withheld from logs)",
				serverStatuses: [],
			});
		});

		test("restores a persisted logSafeError alongside the display message", () => {
			const manager = createManager({
				state: "error",
				error: "boom body",
				logSafeError: "RequestError(http, status 502)",
			});

			const status = manager.connectionStatus;
			assert.ok(status.state === "error");
			assert.strictEqual(status.error, "boom body");
			assert.strictEqual(status.logSafeError, "RequestError(http, status 502)");
		});

		test("an error status that lost its message downgrades to degraded connecting", () => {
			// The message cannot be invented and the state is as stale as a
			// restored connecting, so it degrades the same way instead of
			// rendering a made-up "Unknown error".
			const manager = createManager({ state: "error" });

			assert.deepStrictEqual(manager.connectionStatus, { state: "connecting", attention: true });
		});

		test("an empty persisted error message counts as lost, not as a message", () => {
			const manager = createManager({ state: "error", error: "" });

			assert.deepStrictEqual(manager.connectionStatus, { state: "connecting", attention: true });
		});

		test("a restored connecting state carries the needs-attention flag", () => {
			const manager = createManager({ state: "connecting", attention: false });

			assert.deepStrictEqual(manager.connectionStatus, { state: "connecting", attention: true });
		});

		test("junk serverStatuses elements are dropped, never rendered or crashed on", () => {
			// A persisted [null] element used to throw in the degraded renderer;
			// junk of any shape must become a dropped element instead.
			const ok = {
				serverId: "srv1",
				label: "Prod",
				baseUrl: "http://prod.test",
				state: "ok",
				modelCount: 2,
				lastChecked: "2026-07-26T00:00:00.000Z",
			};
			const manager = createManager({
				state: "degraded",
				totalModels: 2,
				serverStatuses: [null, 42, "junk", { label: "Prod", baseUrl: "http://x", state: "ok" }, ok],
			});

			assert.deepStrictEqual(manager.connectionStatus, {
				state: "degraded",
				totalModels: 2,
				serverStatuses: [ok],
			});
		});

		test("an ok element without a model count and an error element without a message are malformed", () => {
			// The same shapes the legacy diagnostics renderer refuses to print
			// ("OK (undefined models)", "Error: undefined") never survive the
			// restore in the first place; an empty error message counts as none.
			const manager = createManager({
				state: "connected",
				totalModels: 0,
				serverStatuses: [
					{ label: "Prod", baseUrl: "http://prod.test", state: "ok" },
					{ label: "Backup", baseUrl: "http://backup.test", state: "error" },
					{ label: "Blank", baseUrl: "http://blank.test", state: "error", error: "" },
				],
			});

			assert.deepStrictEqual(manager.connectionStatus, { state: "connected", totalModels: 0, serverStatuses: [] });
		});

		test("a junk-typed optional field drops the field, never the whole element", () => {
			const manager = createManager({
				state: "connected",
				totalModels: 1,
				serverStatuses: [
					{ serverId: 42, hasApiKey: "yes", label: "Prod", baseUrl: "http://prod.test", state: "ok", modelCount: 1 },
				],
			});

			assert.deepStrictEqual(manager.connectionStatus, {
				state: "connected",
				totalModels: 1,
				serverStatuses: [
					{ serverId: "", label: "Prod", baseUrl: "http://prod.test", state: "ok", modelCount: 1, lastChecked: "" },
				],
			});
		});

		test("an element missing serverId or lastChecked still restores with empty defaults", () => {
			// Older versions' elements are classified by serverId in diagnostics;
			// a missing one reads as a legacy (non-group) entry, not junk.
			const manager = createManager({
				state: "connected",
				totalModels: 1,
				serverStatuses: [{ label: "Prod", baseUrl: "http://prod.test", state: "ok", modelCount: 1 }],
			});

			assert.deepStrictEqual(manager.connectionStatus, {
				state: "connected",
				totalModels: 1,
				serverStatuses: [
					{ serverId: "", label: "Prod", baseUrl: "http://prod.test", state: "ok", modelCount: 1, lastChecked: "" },
				],
			});
		});

		test("unknown top-level fields are dropped by the normalizing parse", () => {
			const manager = createManager({ state: "degraded", totalModels: 3, futureField: { nested: true } });

			assert.deepStrictEqual(manager.connectionStatus, { state: "degraded", totalModels: 3, serverStatuses: [] });
		});

		suite("falls back to not-configured", () => {
			const rejected: ReadonlyArray<[string, unknown]> = [
				["state is missing", { totalModels: 5 }],
				["state is not a known connection state", { state: "exploded" }],
				["serverStatuses is not an array", { state: "connected", serverStatuses: "oops" }],
				["the persisted value is null", null],
				["the persisted value is a plain string", "connected"],
			];

			for (const [label, persisted] of rejected) {
				test(`when ${label}`, () => {
					const manager = createManager(persisted);

					assert.deepStrictEqual(manager.connectionStatus, { state: "not-configured" });
				});
			}

			test("when nothing was persisted", () => {
				const manager = createManager(undefined);

				assert.deepStrictEqual(manager.connectionStatus, { state: "not-configured" });
			});
		});
	});
});
