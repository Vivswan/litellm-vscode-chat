import * as assert from "node:assert";
import * as vscode from "vscode";
import { classifyOverall } from "../../../extension/dashboard/protocol";
import type { StatusItemLike, StatusItemView } from "../../../extension/ui/status";
import { StatusBarManager } from "../../../extension/ui/status";
import { LAST_CONNECTION_STATUS_KEY } from "../../../shared/config/storageKeys";
import type { TransportErrorClassification } from "../../../shared/errorClassification";
import { Logger, markLogSafe } from "../../../shared/logger";
import type { ServerStatus } from "../../../shared/servers";

// Managers create real, visible status bar items in the shared test host
// window, so every created context is tracked and its subscriptions are
// disposed after each test.
const createdContexts: vscode.ExtensionContext[] = [];

function createManager(
	persistedStatus: unknown,
	hasConfiguredServers: () => boolean = () => false,
	recorder?: { appendLog(line: string): void; recordError(source: string, error: unknown): void },
	item?: StatusItemLike
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
	// ALWAYS a recording surface: StatusBarManager takes the item as a required
	// parameter precisely so a suite can never create a real, visible status
	// bar item in the shared test host (duplicate items have accumulated there
	// twice; the guard test below pins the invariant).
	return new StatusBarManager(
		context,
		new Logger({ info() {}, error() {} }, recorder),
		hasConfiguredServers,
		item ?? new RecordingItem()
	);
}

/** A recording status-bar surface, so the suite can pin rendered text and severity. */
class RecordingItem implements StatusItemLike {
	command: string | vscode.Command | undefined = undefined;
	views: StatusItemView[] = [];
	dispose(): void {}
	render(view: StatusItemView): void {
		this.views.push(view);
	}
	show(): void {}
	hide(): void {}

	get last(): StatusItemView {
		const view = this.views.at(-1);
		if (view === undefined) {
			throw new assert.AssertionError({ message: "nothing was rendered" });
		}
		return view;
	}
}

/** The single restored element, narrowed to the error variant or failing loudly. */
function expectErrorElement(serverStatuses: readonly ServerStatus[]): ServerStatus & { state: "error" } {
	assert.strictEqual(serverStatuses.length, 1, "the element must survive the restore");
	const element = serverStatuses[0];
	if (element === undefined || element.state !== "error") {
		throw new assert.AssertionError({ message: `expected one error element, got ${JSON.stringify(element)}` });
	}
	return element;
}

suite("extension/ui/status", () => {
	// The regression pin for the duplicate-status-item class: NOTHING in this
	// suite may create a real status bar item in the shared test host. The
	// real vscode.window.createStatusBarItem is wrapped for the suite's
	// duration; any call fails the test that made it. (StatusBarManager takes
	// its item as a required parameter for the same reason.)
	const realCreateStatusBarItem = vscode.window.createStatusBarItem;
	let realItemCreations = 0;
	suiteSetup(() => {
		(vscode.window as { createStatusBarItem: typeof vscode.window.createStatusBarItem }).createStatusBarItem = ((
			...args: Parameters<typeof vscode.window.createStatusBarItem>
		) => {
			realItemCreations += 1;
			return realCreateStatusBarItem(...args);
		}) as typeof vscode.window.createStatusBarItem;
	});
	suiteTeardown(() => {
		(vscode.window as { createStatusBarItem: typeof vscode.window.createStatusBarItem }).createStatusBarItem =
			realCreateStatusBarItem;
	});
	teardown(() => {
		for (const context of createdContexts.splice(0)) {
			for (const disposable of context.subscriptions) {
				disposable.dispose();
			}
		}
		assert.strictEqual(realItemCreations, 0, "a test created a real status bar item in the shared host");
	});

	test("clicking the status bar item runs the injected item's command", () => {
		// The command rides the injected item (activation pins it to
		// CMD.openDashboard when it constructs the real StatusItem); the manager
		// only surfaces it.
		const item = new RecordingItem();
		item.command = "litellm.openDashboard";
		const manager = createManager(undefined, () => false, undefined, item);

		assert.strictEqual(manager.clickCommand, "litellm.openDashboard");
	});

	suite("the item's text keeps the bar quiet: counts live in the tooltip", () => {
		const okServers: ServerStatus[] = [
			{
				serverId: "srv1",
				label: "Prod",
				baseUrl: "http://prod.test",
				state: "ok",
				modelCount: 3,
				lastChecked: new Date().toISOString(),
			},
			{
				serverId: "srv2",
				label: "Backup",
				baseUrl: "http://backup.test",
				state: "ok",
				modelCount: 4,
				lastChecked: new Date().toISOString(),
			},
		];

		test("connected shows no model count in the text; the tooltip carries both counts", async () => {
			const item = new RecordingItem();
			createManager(undefined, () => true, undefined, item).handleAggregatedStatus({
				serverStatuses: okServers,
				totalModels: 7,
				silent: true,
			});
			// updateStatusBar persists the status before rendering it; let that
			// microtask chain settle.
			await new Promise((resolve) => setImmediate(resolve));

			assert.strictEqual(item.last.text, "$(check) LiteLLM");
			assert.strictEqual(item.last.severity, "plain");
			assert.ok(item.last.tooltip.includes("7 models available from 2 servers"), item.last.tooltip);
		});

		test("degraded shows no model count in the text; the tooltip carries the counts", async () => {
			const item = new RecordingItem();
			const failed: ServerStatus = {
				serverId: "srv3",
				label: "Down",
				baseUrl: "http://down.test",
				state: "error",
				error: "boom",
				logSafeError: markLogSafe("RequestError(connection)"),
				lastChecked: new Date().toISOString(),
			};
			createManager(undefined, () => true, undefined, item).handleAggregatedStatus({
				serverStatuses: [...okServers, failed],
				totalModels: 7,
				silent: true,
			});
			await new Promise((resolve) => setImmediate(resolve));

			assert.strictEqual(item.last.text, "$(warning) LiteLLM");
			assert.strictEqual(item.last.severity, "warning");
			assert.ok(item.last.tooltip.includes("7 models available"), item.last.tooltip);
			assert.ok(item.last.tooltip.includes("1 server unreachable"), item.last.tooltip);
		});
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

	test("an all-failed report copies the first failure's classification; the zero-models synthetic carries none", () => {
		const manager = createManager(undefined, () => true);
		const classification: TransportErrorClassification = { kind: "http", status: 404, setupHint: "check-base-url" };
		const failed: ServerStatus = {
			serverId: "srv1",
			label: "Prod",
			baseUrl: "http://prod.test",
			state: "error",
			error: "answered 404",
			logSafeError: markLogSafe("RequestError(http, status 404, discovery)"),
			classification,
			lastChecked: new Date().toISOString(),
		};

		manager.handleAggregatedStatus({ serverStatuses: [failed], totalModels: 0, silent: true });
		const allFailed = manager.connectionStatus;
		assert.ok(allFailed.state === "error");
		assert.deepStrictEqual(allFailed.classification, classification);

		const ok: ServerStatus = {
			serverId: "srv1",
			label: "Prod",
			baseUrl: "http://prod.test",
			state: "ok",
			modelCount: 0,
			lastChecked: new Date().toISOString(),
		};
		manager.handleAggregatedStatus({ serverStatuses: [ok], totalModels: 0, silent: true });
		const zeroModels = manager.connectionStatus;
		assert.ok(zeroModels.state === "error");
		assert.ok(!("classification" in zeroModels), "the synthetic zero-models verdict is not a transport failure");
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

		test("a restored degraded connecting survives the connection test's loading overwrite", async () => {
			// The restore path seeds the manager's carry directly (no report has
			// arrived yet), so last session's degraded verdict must still be
			// there when a loading overwrite and an empty report follow.
			const manager = createManager({ state: "connecting" }, () => true);
			assert.strictEqual(manager.connectingAttention, true);

			await manager.updateStatusBar({ state: "loading" });
			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });

			assert.strictEqual(manager.connectionStatus.state, "connecting");
			assert.strictEqual(manager.connectingAttention, true, "the restored verdict survives the transient loading");
		});
	});

	suite("expected failures", () => {
		const expectedFailure = (declaredModelCount?: number): ServerStatus => ({
			serverId: "srv1",
			label: "Gateway",
			baseUrl: "http://gw.test",
			state: "error",
			error: "discovery down",
			logSafeError: markLogSafe("RequestError(http, status 404)"),
			expected: true,
			...(declaredModelCount !== undefined ? { declaredModelCount } : {}),
			lastChecked: new Date().toISOString(),
		});
		const okServer: ServerStatus = {
			serverId: "srv2",
			label: "Prod",
			baseUrl: "http://prod.test",
			state: "ok",
			modelCount: 3,
			lastChecked: new Date().toISOString(),
		};
		const unexpectedFailure: ServerStatus = {
			serverId: "srv3",
			label: "Down",
			baseUrl: "http://down.test",
			state: "error",
			error: "boom",
			logSafeError: markLogSafe("RequestError(connection)"),
			lastChecked: new Date().toISOString(),
		};

		test("the all-expected/no-declared case is neutral on BOTH surfaces: needs-declare and the attention warning", () => {
			// The two headline surfaces must move together (the settled status
			// semantics): the dashboard's shared verdict says needs-declare, and
			// the status bar shows the actionable warning presentation instead of
			// the zero-model red branch.
			assert.strictEqual(classifyOverall([{ state: "error", expected: true }]), "needs-declare");
			const manager = createManager(undefined, () => true);
			manager.handleAggregatedStatus({ serverStatuses: [expectedFailure()], totalModels: 0, silent: true });
			assert.deepStrictEqual(
				{ state: manager.connectionStatus.state, attention: manager.connectingAttention },
				{ state: "connecting", attention: true },
				"never the red zero-model branch"
			);
		});

		test("an expected failure serving declared models reads as connected, not degraded", () => {
			assert.strictEqual(
				classifyOverall([{ state: "error", expected: true, declaredModelCount: 2 }]),
				"connected",
				"the shared dashboard verdict"
			);
			const manager = createManager(undefined, () => true);
			const serving = expectedFailure(2);
			manager.handleAggregatedStatus({ serverStatuses: [serving], totalModels: 2, silent: true });
			const status = manager.connectionStatus;
			assert.ok(status.state === "connected", `expected connected, got ${status.state}`);
			assert.strictEqual(status.totalModels, 2);
			assert.deepStrictEqual(status.serverStatuses, [serving]);
		});

		test("an expected failure beside a healthy server never degrades the verdict", () => {
			assert.strictEqual(classifyOverall([{ state: "ok" }, { state: "error", expected: true }]), "connected");
			const manager = createManager(undefined, () => true);
			manager.handleAggregatedStatus({ serverStatuses: [okServer, expectedFailure()], totalModels: 3, silent: true });
			assert.strictEqual(manager.connectionStatus.state, "connected");
		});

		test("an unexpected failure degrades; red needs EVERY server failing unexpectedly, mirroring classifyOverall", () => {
			const manager = createManager(undefined, () => true);
			manager.handleAggregatedStatus({
				serverStatuses: [okServer, unexpectedFailure, expectedFailure()],
				totalModels: 3,
				silent: true,
			});
			const degraded = manager.connectionStatus;
			assert.strictEqual(degraded.state, "degraded");

			// The mixed all-failed case pins both surfaces together: an expected
			// failure beside an unexpected one is degraded, never the red
			// all-failed verdict, on the dashboard AND the status bar.
			assert.strictEqual(
				classifyOverall([{ state: "error" }, { state: "error", expected: true }]),
				"degraded",
				"the shared dashboard verdict"
			);
			manager.handleAggregatedStatus({
				serverStatuses: [unexpectedFailure, expectedFailure()],
				totalModels: 0,
				silent: true,
			});
			const mixed = manager.connectionStatus;
			assert.strictEqual(mixed.state, "degraded");

			assert.strictEqual(classifyOverall([{ state: "error" }]), "error");
			manager.handleAggregatedStatus({ serverStatuses: [unexpectedFailure], totalModels: 0, silent: true });
			const red = manager.connectionStatus;
			assert.ok(red.state === "error");
			assert.strictEqual(red.error, "boom");
		});

		test("an expected failure with declared models rescues an otherwise all-failed report to degraded", () => {
			const manager = createManager(undefined, () => true);
			manager.handleAggregatedStatus({
				serverStatuses: [unexpectedFailure, expectedFailure(1)],
				totalModels: 1,
				silent: true,
			});
			assert.strictEqual(manager.connectionStatus.state, "degraded", "a declared-serving server counts as serving");
		});

		test("expected and declaredModelCount survive the persisted round trip; junk drops the field only", () => {
			const manager = createManager({
				state: "degraded",
				totalModels: 1,
				serverStatuses: [
					{
						state: "error",
						label: "Gateway",
						baseUrl: "http://gw.test",
						error: "discovery down",
						logSafeError: "RequestError(http, status 404)",
						expected: true,
						declaredModelCount: 1,
					},
					{
						state: "error",
						label: "Junky",
						baseUrl: "http://junk.test",
						error: "boom",
						logSafeError: "RequestError(connection)",
						expected: "yes",
						declaredModelCount: -3,
					},
				],
			});
			const status = manager.connectionStatus;
			assert.ok(status.state === "degraded");
			const [restored, junky] = status.serverStatuses;
			assert.ok(restored?.state === "error");
			assert.strictEqual(restored.expected, true);
			assert.strictEqual(restored.declaredModelCount, 1);
			assert.ok(junky?.state === "error", "junk optional fields never drop the element");
			assert.ok(!("expected" in junky) || junky.expected === undefined);
			assert.ok(!("declaredModelCount" in junky) || junky.declaredModelCount === undefined);
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

		suite("error classification", () => {
			// The persisted shape is enum ids plus an integer status (never message
			// text); junk drops the smallest thing that contains it, matching the
			// hasApiKey treatment: a junk optional field keeps the rest of the
			// classification, a junk kind or non-object drops the whole field, and
			// nothing ever drops the element.
			const classification = { kind: "connection", setupHint: "proxy-not-running" };
			const fieldDroppingJunk: ReadonlyArray<[string, unknown, unknown]> = [
				[
					"a fractional status",
					{ kind: "http", status: 404.5, setupHint: "check-base-url" },
					{ kind: "http", setupHint: "check-base-url" },
				],
				["a bogus setupHint", { kind: "http", status: 404, setupHint: "reboot" }, { kind: "http", status: 404 }],
			];
			const classificationDroppingJunk: ReadonlyArray<[string, unknown]> = [
				["an unknown kind", { kind: "exploded", status: 404 }],
				["a non-object value", "check-base-url"],
			];

			test("restores at the top level", () => {
				const manager = createManager({ state: "error", error: "boom", classification });

				const status = manager.connectionStatus;
				assert.ok(status.state === "error");
				assert.deepStrictEqual(status.classification, classification);
			});

			test("restores on a nested error element", () => {
				const manager = createManager({
					state: "degraded",
					totalModels: 0,
					serverStatuses: [
						{ label: "Prod", baseUrl: "http://prod.test", state: "error", error: "boom", classification },
					],
				});

				const status = manager.connectionStatus;
				assert.ok(status.state === "degraded");
				const element = expectErrorElement(status.serverStatuses);
				assert.deepStrictEqual(element.classification, classification);
			});

			test("an absent field restores as absent at both sites", () => {
				const manager = createManager({
					state: "error",
					error: "boom",
					serverStatuses: [{ label: "Prod", baseUrl: "http://prod.test", state: "error", error: "boom" }],
				});

				const status = manager.connectionStatus;
				assert.ok(status.state === "error");
				assert.ok(!("classification" in status), "the top-level restore must not invent a classification");
				const element = expectErrorElement(status.serverStatuses ?? []);
				assert.ok(!("classification" in element), "the element restore must not invent a classification");
			});

			for (const [label, junk, preserved] of fieldDroppingJunk) {
				test(`${label} drops that field and keeps the rest, at the top level`, () => {
					const manager = createManager({ state: "error", error: "boom", classification: junk });

					const status = manager.connectionStatus;
					assert.ok(status.state === "error", "the error status itself must survive");
					assert.deepStrictEqual(status.classification, preserved);
				});

				test(`${label} drops that field and keeps the rest, on the nested element`, () => {
					const manager = createManager({
						state: "degraded",
						totalModels: 0,
						serverStatuses: [
							{ label: "Prod", baseUrl: "http://prod.test", state: "error", error: "boom", classification: junk },
						],
					});

					const status = manager.connectionStatus;
					assert.ok(status.state === "degraded");
					assert.deepStrictEqual(expectErrorElement(status.serverStatuses).classification, preserved);
				});
			}

			for (const [label, junk] of classificationDroppingJunk) {
				test(`${label} drops the whole field but keeps the top-level error`, () => {
					const manager = createManager({ state: "error", error: "boom", classification: junk });

					const status = manager.connectionStatus;
					assert.ok(status.state === "error", "the error status itself must survive");
					assert.strictEqual(status.error, "boom");
					assert.ok(!("classification" in status), "junk must drop the field, not poison the status");
				});

				test(`${label} drops the whole field but keeps the nested element`, () => {
					const manager = createManager({
						state: "degraded",
						totalModels: 0,
						serverStatuses: [
							{ label: "Prod", baseUrl: "http://prod.test", state: "error", error: "boom", classification: junk },
						],
					});

					const status = manager.connectionStatus;
					assert.ok(status.state === "degraded");
					const element = expectErrorElement(status.serverStatuses);
					assert.strictEqual(element.error, "boom");
					assert.ok(!("classification" in element), "junk must drop the field, not the element");
				});
			}
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

		test("a loading blob persisted with a carried attention flag restores neutral and never counts as consecutive", () => {
			// Older versions persisted the connection test's loading status with
			// the smuggled attention flag; the session boundary makes it stale,
			// so the restored state drops it and the first empty report after the
			// restart stays the neutral spinner.
			const manager = createManager({ state: "loading", attention: true }, () => true);

			assert.deepStrictEqual(manager.connectionStatus, { state: "loading" });

			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });
			assert.strictEqual(manager.connectionStatus.state, "connecting");
			assert.strictEqual(manager.connectingAttention, false, "last session's flag must not degrade this session");
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
