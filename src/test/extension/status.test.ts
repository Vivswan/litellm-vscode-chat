import * as assert from "node:assert";
import type * as vscode from "vscode";
import { type ConnectionStatus, StatusBarManager } from "../../extension/status";
import { Logger } from "../../shared/logger";
import type { ServerStatus } from "../../shared/servers";
import { LAST_CONNECTION_STATUS_KEY } from "../../shared/storageKeys";

function createManager(persistedStatus: unknown, hasConfiguredServers: () => boolean = () => false): StatusBarManager {
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
	return new StatusBarManager(context, new Logger({ info() {}, error() {} }), hasConfiguredServers);
}

const CONNECTION_STATES: ReadonlyArray<ConnectionStatus["state"]> = [
	"not-configured",
	"connecting",
	"loading",
	"connected",
	"degraded",
	"error",
];

suite("extension/status", () => {
	test("clicking the status bar item opens the dashboard", () => {
		const manager = createManager(undefined);

		assert.strictEqual(manager.clickCommand, "litellm.openDashboard");
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
	});

	suite("persisted status restore", () => {
		test("restores a status whose serverStatuses field is absent", () => {
			const manager = createManager({ state: "connected" });

			assert.deepStrictEqual(manager.connectionStatus, { state: "connected" });
		});

		for (const state of CONNECTION_STATES) {
			test(`restores state "${state}"`, () => {
				const manager = createManager({ state });

				assert.strictEqual(manager.connectionStatus.state, state);
			});
		}

		test("restores serverStatuses arrays without validating their elements", () => {
			const persisted = { state: "connected", serverStatuses: [42, "junk"] };
			const manager = createManager(persisted);

			assert.deepStrictEqual(manager.connectionStatus, persisted);
		});

		test("restores a status carrying unknown top-level fields", () => {
			const persisted = { state: "degraded", totalModels: 3, futureField: { nested: true } };
			const manager = createManager(persisted);

			assert.deepStrictEqual(manager.connectionStatus, persisted);
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
