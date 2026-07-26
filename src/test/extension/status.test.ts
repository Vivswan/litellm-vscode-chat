import * as assert from "node:assert";
import type * as vscode from "vscode";
import { type ConnectionStatus, StatusBarManager } from "../../extension/status";
import { Logger } from "../../shared/logger";
import { LAST_CONNECTION_STATUS_KEY } from "../../shared/storageKeys";

function createManager(persistedStatus: unknown): StatusBarManager {
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
	return new StatusBarManager(context, new Logger({ appendLine() {} }));
}

const CONNECTION_STATES: ReadonlyArray<ConnectionStatus["state"]> = [
	"not-configured",
	"loading",
	"connected",
	"degraded",
	"error",
];

suite("extension/status", () => {
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
