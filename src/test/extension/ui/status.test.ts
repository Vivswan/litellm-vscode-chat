import * as assert from "node:assert";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { classifyOverall } from "../../../dashboard/presenters";
import type { DeclaredServerView } from "../../../extension/servers/serverSync/engine";
import type { ServerEntryReport } from "../../../extension/servers/serverSync/setting";
import { detectSetupProblem } from "../../../extension/ui/setupGate";
import type { StatusBarManager, StatusItemLike } from "../../../extension/ui/status";
import { LAST_CONNECTION_STATUS_KEY } from "../../../shared/config/storageKeys";
import type { TransportErrorClassification } from "../../../shared/errorClassification";
import type { FailureCause } from "../../../shared/failureCause";
import { failureClassification } from "../../../shared/failureCause";
import { Logger, markLogSafe } from "../../../shared/logger";
import type { AggregatedStatus, ServerStatus } from "../../../shared/servers";
import { displayUrl } from "../../../shared/util/displayUrl";
import { expectDefined } from "../../pureHelpers";
import { makeServerStatus } from "../../testUtils";
import { REPO_ROOT } from "../../util/repoRoot";
import { createStatusBarManager, RecordingItem } from "./statusBarHarness";

/** A failure nothing classified: the cause every text-free fixture below carries unless the test is about the cause. */
const UNCLASSIFIED: FailureCause = { kind: "unclassified" };

const createdContexts: vscode.ExtensionContext[] = [];

function createManager(
	persistedStatus: unknown,
	hasConfiguredServers: () => boolean = () => false,
	recorder?: { appendLog(line: string): void; recordError(source: string, error: unknown): void },
	item?: StatusItemLike
): StatusBarManager {
	// ALWAYS a recording surface (the harness defaults to one): a suite can never create a real, visible status bar
	// item in the shared test host (the guard test below pins the invariant).
	const harness = createStatusBarManager({ persistedStatus, hasConfiguredServers, recorder, item });
	createdContexts.push(harness.context);
	return harness.manager;
}

function expectErrorElement(serverStatuses: readonly ServerStatus[]): ServerStatus & { state: "error" } {
	assert.strictEqual(serverStatuses.length, 1, "the element must survive the restore");
	const element = serverStatuses[0];
	if (element === undefined || element.state !== "error") {
		throw new assert.AssertionError({ message: `expected one error element, got ${JSON.stringify(element)}` });
	}
	return element;
}

/**
 * The stamp is pinned literally: it is the on-disk format, so a version bump must consciously visit every restore
 * expectation here.
 */
function stamped(status: unknown): unknown {
	return { v: 7, status };
}

suite("extension/ui/status", () => {
	// The regression pin for the duplicate-status-item class: NOTHING in this suite may create a real status bar item
	// in the shared test host.
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

	suite("the item's text keeps the bar quiet: counts live in the tooltip", () => {
		const okServers: ServerStatus[] = [
			{
				serverId: "srv1",
				label: "Prod",
				baseUrl: "http://prod.test",
				state: "ok",
				servedModelCount: 3,
				lastChecked: new Date().toISOString(),
			},
			{
				serverId: "srv2",
				label: "Backup",
				baseUrl: "http://backup.test",
				state: "ok",
				servedModelCount: 4,
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
			// updateStatusBar persists the status before rendering it; let that microtask chain settle.
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
				cause: UNCLASSIFIED,
				logSafeError: markLogSafe("RequestError(connection)"),
				servedModelCount: 0,
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
			assert.ok(item.last.tooltip.includes("1 server failing"), item.last.tooltip);
		});
	});

	test("an all-failed report logs the log-safe rendering and carries the failure's cause, never text", async () => {
		// The "All servers failed" line lands in the issue-report buffer, which prefills public GitHub issues, so it
		// must carry logSafeError; the status carries the cause as a key, and the bar renders it at display time.
		const bufferLines: string[] = [];
		const item = new RecordingItem();
		const manager = createManager(
			undefined,
			() => true,
			{ appendLog: (line) => bufferLines.push(line), recordError: () => {} },
			item
		);
		const cause: FailureCause = { kind: "transport", classification: { kind: "http", status: 502 } };
		const failed: ServerStatus = {
			serverId: "srv1",
			label: "Prod",
			baseUrl: "http://prod.test",
			state: "error",
			cause,
			logSafeError: markLogSafe("RequestError(http, status 502)"),
			servedModelCount: 0,
			lastChecked: new Date().toISOString(),
		};

		manager.handleAggregatedStatus({ serverStatuses: [failed], totalModels: 0, silent: true });
		await new Promise((resolve) => setImmediate(resolve));

		assert.ok(
			bufferLines.some((line) => line.includes("All servers failed: RequestError(http, status 502)")),
			`the buffer must carry the classification; lines: ${bufferLines.join(" | ")}`
		);
		const status = manager.connectionStatus;
		assert.ok(status.state === "error");
		assert.deepStrictEqual(status.cause, cause);
		assert.strictEqual(status.baseUrl, "http://prod.test");
		assert.ok(item.last.tooltip.includes("The server at http://prod.test answered 502"), item.last.tooltip);
	});

	test("an all-failed report copies the first failure's cause; the zero-models state carries none", async () => {
		const item = new RecordingItem();
		const manager = createManager(undefined, () => true, undefined, item);
		const classification: TransportErrorClassification = { kind: "http", status: 404, setupHint: "check-base-url" };
		const failed: ServerStatus = {
			serverId: "srv1",
			label: "Prod",
			baseUrl: "http://prod.test",
			state: "error",
			cause: { kind: "transport", classification },
			logSafeError: markLogSafe("RequestError(http, status 404, discovery)"),
			servedModelCount: 0,
			lastChecked: new Date().toISOString(),
		};

		manager.handleAggregatedStatus({ serverStatuses: [failed], totalModels: 0, silent: true });
		const allFailed = manager.connectionStatus;
		assert.ok(allFailed.state === "error");
		assert.deepStrictEqual(failureClassification(allFailed.cause), classification);

		const ok: ServerStatus = {
			serverId: "srv1",
			label: "Prod",
			baseUrl: "http://prod.test",
			state: "ok",
			servedModelCount: 0,
			lastChecked: new Date().toISOString(),
		};
		manager.handleAggregatedStatus({ serverStatuses: [ok], totalModels: 0, silent: true });
		await new Promise((resolve) => setImmediate(resolve));
		const zeroModels = manager.connectionStatus;
		// The zero-model judgment is not a transport failure: the state stays the honest "connected" (which carries no
		// classification by construction) and the bar renders the shared warning.
		assert.ok(zeroModels.state === "connected");
		assert.strictEqual(item.last.severity, "warning");
	});

	suite("the zero-model verdict names its cause", () => {
		const hiddenGroup = (serverId = "srv1"): ServerStatus => ({
			serverId,
			label: "Prod",
			baseUrl: "http://prod.test",
			state: "ok",
			servedModelCount: 0,
			hiddenByRemoval: true,
			lastChecked: new Date().toISOString(),
		});
		const answeredEmpty = (serverId = "srv2"): ServerStatus => ({
			serverId,
			label: "Backup",
			baseUrl: "http://backup.test",
			state: "ok",
			servedModelCount: 0,
			lastChecked: new Date().toISOString(),
		});

		test("a hidden group explains the zero models: the verdict names the count and the recovery, never the proxy", async () => {
			// The only working server's group was hidden by the user's configuration, and every surface used to blame
			// the server ("Connection failed").
			const bufferLines: string[] = [];
			const item = new RecordingItem();
			const manager = createManager(
				undefined,
				() => true,
				{ appendLog: (line) => bufferLines.push(line), recordError: () => {} },
				item
			);

			manager.handleAggregatedStatus({ serverStatuses: [hiddenGroup()], totalModels: 0, silent: true });
			await new Promise((resolve) => setImmediate(resolve));

			// The state is the honest "connected" (nothing failed); the rendering carries the warning, one severity
			// with the notifier and the commands.
			const status = manager.connectionStatus;
			assert.ok(status.state === "connected");
			assert.strictEqual(status.totalModels, 0);
			assert.strictEqual(item.last.severity, "warning");
			assert.strictEqual(item.last.text, "$(warning) LiteLLM");
			assert.ok(!item.last.tooltip.includes("Connection failed"), item.last.tooltip);
			assert.ok(item.last.tooltip.includes("No models available"), item.last.tooltip);
			assert.ok(item.last.tooltip.includes("1 server is hidden and serves no models"), item.last.tooltip);
			assert.ok(item.last.tooltip.includes("The dashboard's server list shows which"), item.last.tooltip);
			// The log line is the English classification, never the localized display.
			assert.ok(
				bufferLines.some((line) => line.includes("Servers returned 0 models (1 hidden by the user's configuration)")),
				bufferLines.join(" | ")
			);
		});

		test("a hidden group beside an answering-empty server names both causes", async () => {
			const item = new RecordingItem();
			const manager = createManager(undefined, () => true, undefined, item);
			manager.handleAggregatedStatus({
				serverStatuses: [hiddenGroup(), answeredEmpty()],
				totalModels: 0,
				silent: true,
			});
			await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(manager.connectionStatus.state, "connected");
			assert.strictEqual(item.last.severity, "warning");
			assert.ok(item.last.tooltip.includes("1 server is hidden and serves no models"), item.last.tooltip);
			assert.ok(item.last.tooltip.includes("The remaining servers answered but listed no models"), item.last.tooltip);
		});

		test("a server that answered with an empty listing is said to have answered, never to have failed", async () => {
			const item = new RecordingItem();
			const manager = createManager(undefined, () => true, undefined, item);
			manager.handleAggregatedStatus({ serverStatuses: [answeredEmpty()], totalModels: 0, silent: true });
			await new Promise((resolve) => setImmediate(resolve));

			assert.strictEqual(manager.connectionStatus.state, "connected");
			assert.strictEqual(item.last.severity, "warning");
			assert.ok(item.last.tooltip.includes("The server answered but listed no models."), item.last.tooltip);
			assert.ok(!item.last.tooltip.includes("Connection failed"), item.last.tooltip);
		});

		test("several answering-empty servers get the plural wording", async () => {
			const item = new RecordingItem();
			const manager = createManager(undefined, () => true, undefined, item);
			manager.handleAggregatedStatus({
				serverStatuses: [answeredEmpty("srv1"), answeredEmpty("srv2")],
				totalModels: 0,
				silent: true,
			});
			await new Promise((resolve) => setImmediate(resolve));
			assert.ok(item.last.tooltip.includes("Your servers answered but listed no models."), item.last.tooltip);
		});

		test("the tooltip masks the rendered cause: a registered value in the configured URL shows its reveal", async () => {
			const key = `Q17key${"X".repeat(34)}`;
			Logger.registerSecrets([key]);
			const item = new RecordingItem();
			const manager = createManager(undefined, () => true, undefined, item);
			manager.handleAggregatedStatus({
				serverStatuses: [
					makeServerStatus({
						state: "error",
						baseUrl: `http://host.test/${key}`,
						cause: { kind: "transport", classification: { kind: "connection" } },
					}),
				],
				totalModels: 0,
				silent: true,
			});
			await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(
				item.last.tooltip,
				"Connection failed\nCould not connect to http://host.test/Q17key...\nClick for details"
			);
		});

		test("a genuine all-failed report keeps the connection-failure wording", async () => {
			const item = new RecordingItem();
			const manager = createManager(undefined, () => true, undefined, item);
			manager.handleAggregatedStatus({
				serverStatuses: [
					{
						serverId: "srv1",
						label: "Down",
						baseUrl: "http://down.test",
						state: "error",
						cause: UNCLASSIFIED,
						logSafeError: markLogSafe("RequestError(connection)"),
						servedModelCount: 0,
						lastChecked: new Date().toISOString(),
					},
				],
				totalModels: 0,
				silent: true,
			});
			await new Promise((resolve) => setImmediate(resolve));

			assert.ok(item.last.tooltip.includes("Connection failed"), item.last.tooltip);
			assert.ok(!item.last.tooltip.includes("No models available"), item.last.tooltip);
		});

		test("hiddenByRemoval survives the persisted round trip; junk drops the field, never the element", () => {
			const manager = createManager(
				stamped({
					state: "connected",
					totalModels: 0,
					serverStatuses: [
						{ label: "Prod", baseUrl: "http://prod.test", state: "ok", servedModelCount: 0, hiddenByRemoval: true },
						{ label: "Junky", baseUrl: "http://junk.test", state: "ok", servedModelCount: 0, hiddenByRemoval: "yes" },
					],
				})
			);
			const status = manager.connectionStatus;
			assert.ok(status.state === "connected");
			const [hidden, junky] = status.serverStatuses;
			assert.ok(hidden?.state === "ok");
			assert.strictEqual(hidden.hiddenByRemoval, true);
			assert.ok(junky?.state === "ok", "junk optional fields never drop the element");
			assert.ok(!("hiddenByRemoval" in junky) || junky.hiddenByRemoval === undefined);
		});

		test("a restored zero-model verdict with a hidden group still gates the issue reporter", () => {
			// Cold start: the persisted verdict must gate exactly like the fresh one, or the first Report Issue after a
			// restart opens a blank issue.
			const manager = createManager(
				stamped({
					state: "connected",
					totalModels: 0,
					serverStatuses: [
						{
							label: "Prod",
							baseUrl: "http://prod.test",
							state: "ok",
							servedModelCount: 0,
							hiddenByRemoval: true,
						},
					],
				})
			);
			assert.strictEqual(detectSetupProblem(manager.connectionStatus), "hidden-groups");
		});

		test("causes written in one locale restore rendered in the other: the store carries keys, never text", async () => {
			// Each case is written under the default (English) bundle, then restored under a swapped bundle; the
			// complete tooltip must be the swapped bundle's rendering. A store carrying rendered text would restore the
			// English sentence inside the swapped wrapper.
			const SWAPPED: Record<string, string> = {
				"Connection failed\n{0}\nClick for details": "SW-FAILED\n{0}",
				"A servers entry is misconfigured and is not used until its configuration is fixed": "SW-MISCONFIGURED",
				"The server at {0} answered {1}": "SW-ANSWERED {1} AT {0}",
				"No models available\n{0}\nClick for details": "SW-NOMODELS\n{0}",
				"The server answered but listed no models.": "SW-EMPTY",
				"A configured API key or virtual key for this entry cannot be sent as an HTTP header, so requests to it are refused. See the Diagnostics tab for the field, then enter the value again.":
					"SW-REFUSED",
				"This server entry's stored secrets could not be read, so its stored copy in VS Code was not used. Check the server row on the dashboard, then run LiteLLM: Sync Models Now.":
					"SW-UNREADABLE",
				"This server entry's {0} cannot be sent as an HTTP header, so no request was made. Enter the value again from the server row on the dashboard.":
					"SW-HEADER-REFUSED {0}",
				"API key": "SW-APIKEY",
			};
			const cases: readonly {
				readonly name: string;
				readonly entryReports: () => readonly ServerEntryReport[];
				readonly getDeclared?: () => readonly DeclaredServerView[];
				readonly report: AggregatedStatus;
				readonly swapped: string;
			}[] = [
				{
					name: "a sync failure the engine classified (a stored key the header rule refuses)",
					entryReports: () => [],
					getDeclared: () => [
						{
							label: "A",
							baseUrl: "http://a.test",
							secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
							syncFailure: { class: "credentialsRefused" },
						},
					],
					report: { serverStatuses: [], totalModels: 0, silent: true },
					swapped: "SW-FAILED\nSW-REFUSED",
				},
				{
					name: "only a refused entry",
					entryReports: () => [
						{
							index: 0,
							label: "x",
							baseUrl: "http://x.test",
							problems: ["auth: apiKey must be a string"],
							accepted: false,
						},
					],
					report: { serverStatuses: [], totalModels: 0, silent: true },
					swapped: "SW-FAILED\nSW-MISCONFIGURED",
				},
				{
					name: "a classified transport failure",
					entryReports: () => [],
					report: {
						serverStatuses: [
							makeServerStatus({
								state: "error",
								baseUrl: "http://down.test",
								classification: { kind: "http", status: 404 },
							}),
						],
						totalModels: 0,
						silent: true,
					},
					swapped: `SW-FAILED\nSW-ANSWERED 404 AT ${displayUrl("http://down.test")}`,
				},
				{
					// The sole entry's stored key read fine at sync time; the read throws at serve time, and the overlay
					// records secretsUnreadable (overlayEntryCredentials) where the sentence used to be stored.
					name: "a stored credential whose read throws at serve time",
					entryReports: () => [],
					report: {
						serverStatuses: [
							makeServerStatus({
								state: "error",
								baseUrl: "http://a.test",
								cause: { kind: "credentials", reason: "secretsUnreadable" },
							}),
						],
						totalModels: 0,
						silent: true,
					},
					swapped: "SW-FAILED\nSW-UNREADABLE",
				},
				{
					// A stored key rotated to a value the platform's Headers refuse: the request path records the refused
					// field, and the field's name is itself a key the restoring locale renders.
					name: "a stored key rotated to a value the header rule refuses",
					entryReports: () => [],
					report: {
						serverStatuses: [
							makeServerStatus({
								state: "error",
								baseUrl: "http://a.test",
								cause: { kind: "credentialsRefused", fields: ["apiKey"] },
							}),
						],
						totalModels: 0,
						silent: true,
					},
					swapped: "SW-FAILED\nSW-HEADER-REFUSED SW-APIKEY",
				},
				{
					name: "a zero-model verdict",
					entryReports: () => [],
					report: { serverStatuses: [makeServerStatus({ servedModelCount: 0 })], totalModels: 0, silent: true },
					swapped: "SW-NOMODELS\nSW-EMPTY",
				},
			];
			for (const { name, entryReports, getDeclared, report, swapped } of cases) {
				const writer = createStatusBarManager({ hasConfiguredServers: () => true, entryReports, getDeclared });
				createdContexts.push(writer.context);
				writer.manager.handleAggregatedStatus(report);
				await new Promise((resolve) => setImmediate(resolve));
				const persisted: unknown = JSON.parse(
					JSON.stringify(writer.context.globalState.get(LAST_CONNECTION_STATUS_KEY))
				);
				const item = new RecordingItem();
				l10n.config({ contents: SWAPPED });
				try {
					createManager(persisted, () => true, undefined, item);
				} finally {
					l10n.config({ contents: {} });
				}
				assert.strictEqual(item.last.tooltip, swapped, name);
			}
		});

		test("the credential causes written under English restore as the zh-cn bundle's whole tooltip", async () => {
			// The two inputs that once stored their English sentence: a stored credential whose read throws at serve
			// time (secretsUnreadable) and a stored key rotated to a value the header rule refuses (credentialsRefused
			// naming the field). Restored under the shipped zh-cn bundle, the entire tooltip is that bundle's
			// rendering, field name included, so the store can have carried nothing but keys.
			const zhCn = JSON.parse(readFileSync(path.join(REPO_ROOT, "l10n", "bundle.l10n.zh-cn.json"), "utf8")) as Record<
				string,
				string
			>;
			const zh = (key: string, ...args: readonly string[]): string =>
				args.reduce((text, arg, index) => text.replaceAll(`{${index}}`, arg), expectDefined(zhCn[key], key));
			const cases: readonly { readonly name: string; readonly cause: FailureCause; readonly detail: string }[] = [
				{
					name: "secretsUnreadable",
					cause: { kind: "credentials", reason: "secretsUnreadable" },
					detail: zh(
						"This server entry's stored secrets could not be read, so its stored copy in VS Code was not used. Check the server row on the dashboard, then run LiteLLM: Sync Models Now."
					),
				},
				{
					name: "rotated key refused",
					cause: { kind: "credentialsRefused", fields: ["apiKey"] },
					detail: zh(
						"This server entry's {0} cannot be sent as an HTTP header, so no request was made. Enter the value again from the server row on the dashboard.",
						zh("API key")
					),
				},
			];
			for (const { name, cause, detail } of cases) {
				const writer = createStatusBarManager({ hasConfiguredServers: () => true });
				createdContexts.push(writer.context);
				writer.manager.handleAggregatedStatus({
					serverStatuses: [makeServerStatus({ state: "error", baseUrl: "http://a.test", cause })],
					totalModels: 0,
					silent: true,
				});
				await new Promise((resolve) => setImmediate(resolve));
				const persisted: unknown = JSON.parse(
					JSON.stringify(writer.context.globalState.get(LAST_CONNECTION_STATUS_KEY))
				);
				assert.ok(!JSON.stringify(persisted).includes(detail.slice(0, 8)), `${name}: the store carries no sentence`);
				const item = new RecordingItem();
				l10n.config({ contents: zhCn });
				try {
					createManager(persisted, () => true, undefined, item);
				} finally {
					l10n.config({ contents: {} });
				}
				assert.strictEqual(item.last.tooltip, zh("Connection failed\n{0}\nClick for details", detail), name);
			}
		});

		test("a sync pass before any report judges a setting whose only entry the parser refused", async () => {
			// No overlay (nothing declared) but one verdict row: the bar must read the same error the hero shows, not
			// stay on the restore-less connecting seed.
			const item = new RecordingItem();
			const harness = createStatusBarManager({
				hasConfiguredServers: () => true,
				entryReports: () => [
					{
						index: 0,
						label: "x",
						baseUrl: "http://x.test",
						problems: ["auth: apiKey must be a string"],
						accepted: false,
					},
				],
				item,
			});
			createdContexts.push(harness.context);
			harness.manager.refreshFromSync();
			await new Promise((resolve) => setImmediate(resolve));
			const status = harness.manager.connectionStatus;
			assert.ok(status.state === "error", `expected error, got ${status.state}`);
			assert.deepStrictEqual(status.cause, { kind: "misconfiguredEntry" });
			assert.strictEqual(item.last.severity, "error");
		});

		test("a restored error that lost its server statuses keeps the connection-failure rendering", async () => {
			// The restore normalization fails closed on an empty status list: without the statuses there is no proof
			// the servers answered.
			const item = new RecordingItem();
			const manager = createManager(
				stamped({ state: "error", cause: UNCLASSIFIED, logSafeError: "RequestError(connection)" }),
				() => true,
				undefined,
				item
			);
			await new Promise((resolve) => setImmediate(resolve));
			assert.ok(manager.connectionStatus.state === "error");
			assert.ok(item.last.tooltip.includes("Connection failed"), item.last.tooltip);
		});
	});

	suite("the empty status window", () => {
		test("claims not-configured only when nothing proves servers exist", () => {
			const manager = createManager(undefined, () => false);

			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });

			assert.strictEqual(manager.connectionStatus.state, "not-configured");
		});

		test("renders as connecting while configured servers have not reported", () => {
			// Cold start on a group-configured install: the groupless refresh reports an empty window before the
			// per-group refreshes arrive. The persisted state feeds public issue reports, so the honest verdict is
			// "connecting".
			const manager = createManager(undefined, () => true);

			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });

			assert.strictEqual(manager.connectionStatus.state, "connecting");
			assert.strictEqual(manager.connectingAttention, false, "one empty report is normal cold-start ordering");
		});

		test("a second consecutive empty report degrades connecting to needs-attention", () => {
			// Evidence of persistence: a declared entry whose sync keeps failing, or a deleted native group behind a
			// sticky latch, must not spin forever.
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
				servedModelCount: 2,
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
			// The state survived a whole session boundary without resolving, so the stale spinner from last session
			// must not render indefinitely.
			const manager = createManager(stamped({ state: "connecting" }), () => true);

			assert.strictEqual(manager.connectionStatus.state, "connecting");
			assert.strictEqual(manager.connectingAttention, true);
		});

		test("a transient loading state does not clear the connecting attention", async () => {
			// The connection test overwrites the status with "loading" before it runs; an empty report arriving
			// mid-test must not reset the warning.
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
			// The restore path seeds the manager's carry directly (no report has arrived yet), so last session's
			// degraded verdict must survive a loading overwrite and an empty report.
			const manager = createManager(stamped({ state: "connecting" }), () => true);
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
			cause: UNCLASSIFIED,
			logSafeError: markLogSafe("RequestError(http, status 404)"),
			expected: true,
			servedModelCount: declaredModelCount ?? 0,
			...(declaredModelCount !== undefined ? { declaredModelCount } : {}),
			lastChecked: new Date().toISOString(),
		});
		const okServer: ServerStatus = {
			serverId: "srv2",
			label: "Prod",
			baseUrl: "http://prod.test",
			state: "ok",
			servedModelCount: 3,
			lastChecked: new Date().toISOString(),
		};
		const unexpectedFailure: ServerStatus = {
			serverId: "srv3",
			label: "Down",
			baseUrl: "http://down.test",
			state: "error",
			cause: UNCLASSIFIED,
			logSafeError: markLogSafe("RequestError(connection)"),
			servedModelCount: 0,
			lastChecked: new Date().toISOString(),
		};

		test("the all-expected/no-declared case is neutral on BOTH surfaces: needs-declare and the attention warning", () => {
			// The two headline surfaces must move together: the dashboard's shared verdict says needs-declare, and the
			// status bar shows the actionable warning instead of the zero-model red branch.
			assert.strictEqual(classifyOverall([{ state: "error", expected: true, servedModelCount: 0 }]), "needs-declare");
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
				classifyOverall([{ state: "error", expected: true, servedModelCount: 2 }]),
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
			assert.strictEqual(
				classifyOverall([
					{ state: "ok", servedModelCount: 3 },
					{ state: "error", expected: true, servedModelCount: 0 },
				]),
				"connected"
			);
			const manager = createManager(undefined, () => true);
			manager.handleAggregatedStatus({ serverStatuses: [okServer, expectedFailure()], totalModels: 3, silent: true });
			assert.strictEqual(manager.connectionStatus.state, "connected");
		});

		test("an unexpected failure degrades; red needs EVERY server failing unexpectedly AND nothing serving", () => {
			const manager = createManager(undefined, () => true);
			manager.handleAggregatedStatus({
				serverStatuses: [okServer, unexpectedFailure, expectedFailure()],
				totalModels: 3,
				silent: true,
			});
			const degraded = manager.connectionStatus;
			assert.strictEqual(degraded.state, "degraded");

			assert.strictEqual(
				classifyOverall([
					{ state: "error", servedModelCount: 0 },
					{ state: "error", expected: true, servedModelCount: 0 },
				]),
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

			assert.strictEqual(classifyOverall([{ state: "error", servedModelCount: 0 }]), "error");
			manager.handleAggregatedStatus({ serverStatuses: [unexpectedFailure], totalModels: 0, silent: true });
			const red = manager.connectionStatus;
			assert.ok(red.state === "error");
			assert.deepStrictEqual(red.cause, UNCLASSIFIED);
		});

		test("an all-failed window still serving its stale-window models reads degraded, never dead", async () => {
			// The serving test precedes the all-failed verdict: a failed group whose stale window (or declarations)
			// still serves models cannot show a red "Connection failed" while the picker serves them.
			assert.strictEqual(classifyOverall([{ state: "error", servedModelCount: 5 }]), "degraded");
			const item = new RecordingItem();
			const manager = createManager(undefined, () => true, undefined, item);
			const staleServing: ServerStatus = { ...unexpectedFailure, servedModelCount: 5 };
			manager.handleAggregatedStatus({ serverStatuses: [staleServing], totalModels: 5, silent: true });
			await new Promise((resolve) => setImmediate(resolve));

			const status = manager.connectionStatus;
			assert.strictEqual(status.state, "degraded");
			assert.strictEqual(item.last.severity, "warning");
			assert.ok(item.last.tooltip.includes("5 models available"), item.last.tooltip);
			assert.ok(item.last.tooltip.includes("1 server failing"), item.last.tooltip);
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

		test("the degraded tooltip counts only unexpected failures, like both command toasts", async () => {
			// One expected + one real failure once showed a count of 1 here and 2 in the toasts; the shared count pins
			// the surfaces together.
			const item = new RecordingItem();
			const manager = createManager(undefined, () => true, undefined, item);
			manager.handleAggregatedStatus({
				serverStatuses: [okServer, unexpectedFailure, expectedFailure()],
				totalModels: 3,
				silent: true,
			});
			await new Promise((resolve) => setImmediate(resolve));

			assert.ok(item.last.tooltip.includes("1 server failing"), item.last.tooltip);
			assert.ok(!item.last.tooltip.includes("2 servers failing"), item.last.tooltip);
		});

		test("expected, servedModelCount, and declaredModelCount survive the persisted round trip; junk drops the smallest thing", () => {
			// Junk in a required count drops the whole element (it cannot render honestly); junk in an optional field
			// drops only that field.
			const manager = createManager(
				stamped({
					state: "degraded",
					totalModels: 1,
					serverStatuses: [
						{
							state: "error",
							label: "Gateway",
							baseUrl: "http://gw.test",
							cause: UNCLASSIFIED,
							logSafeError: "RequestError(http, status 404)",
							expected: true,
							servedModelCount: 3,
							declaredModelCount: 1,
						},
						{
							state: "error",
							label: "Junky",
							baseUrl: "http://junk.test",
							cause: UNCLASSIFIED,
							logSafeError: "RequestError(connection)",
							expected: "yes",
							servedModelCount: 0,
							declaredModelCount: -3,
						},
						{
							state: "error",
							label: "Dropped",
							baseUrl: "http://dropped.test",
							cause: UNCLASSIFIED,
							logSafeError: "RequestError(connection)",
							servedModelCount: -1,
						},
					],
				})
			);
			const status = manager.connectionStatus;
			assert.ok(status.state === "degraded");
			assert.strictEqual(status.serverStatuses.length, 2, "a junk required count drops that element alone");
			const [restored, junky] = status.serverStatuses;
			assert.ok(restored?.state === "error");
			assert.strictEqual(restored.expected, true);
			assert.strictEqual(restored.servedModelCount, 3);
			assert.strictEqual(restored.declaredModelCount, 1);
			assert.ok(junky?.state === "error", "junk optional fields never drop the element");
			assert.ok(!("expected" in junky) || junky.expected === undefined);
			assert.ok(!("declaredModelCount" in junky) || junky.declaredModelCount === undefined);
		});
	});

	suite("persisted status restore accepts exactly the current version-stamped shape", () => {
		test("the write and the restore share one envelope: this session's report round-trips into the next", async () => {
			// The fixture carries EVERY field the live path can stamp on a window element (statusReporting sets
			// hasOAuth on every group status), so a restore that silently drops a current-shape field fails this pin.
			const first = createStatusBarManager({ hasConfiguredServers: () => true });
			createdContexts.push(first.context);
			const ok: ServerStatus = {
				serverId: "srv1",
				label: "Prod",
				entryLabel: "Prod",
				baseUrl: "http://prod.test",
				state: "ok",
				servedModelCount: 2,
				hiddenByRemoval: false,
				hasApiKey: true,
				hasOAuth: false,
				modelInfoUnsupported: "timeout",
				lastChecked: "2026-07-26T00:00:00.000Z",
			};
			const failed: ServerStatus = {
				serverId: "srv2",
				label: "Down",
				entryLabel: "Down",
				baseUrl: "http://down.test",
				state: "error",
				cause: {
					kind: "transport",
					classification: {
						kind: "http",
						status: 404,
						setupHint: "check-base-url",
						unsupportedEndpoint: "modelListing",
					},
				},
				logSafeError: markLogSafe("RequestError(http, status 404, discovery)"),
				expected: true,
				servedModelCount: 1,
				declaredModelCount: 1,
				hasApiKey: true,
				hasOAuth: true,
				lastChecked: "2026-07-26T00:00:00.000Z",
			};
			first.manager.handleAggregatedStatus({ serverStatuses: [ok, failed], totalModels: 3, silent: true });
			await new Promise((resolve) => setImmediate(resolve));

			// Serialized through JSON like the real Memento boundary, so the pin compares persisted DATA, never the
			// in-memory object graph with itself. The live status carries no rendered text, so the envelope is the
			// live status field for field (the failed element's cause is its transport key), the restore is the live
			// status again, and the restored bar renders the whole tooltip the live one did.
			const persisted: unknown = JSON.parse(JSON.stringify(first.context.globalState.get(LAST_CONNECTION_STATUS_KEY)));
			assert.deepStrictEqual(
				persisted,
				JSON.parse(JSON.stringify({ v: 7, status: first.manager.connectionStatus })),
				"the on-disk format is the stamped envelope of keys"
			);
			const item = new RecordingItem();
			const second = createManager(persisted, () => true, undefined, item);
			assert.deepStrictEqual(second.connectionStatus, first.manager.connectionStatus);
			assert.deepStrictEqual(item.last, {
				text: "$(check) LiteLLM",
				tooltip: "3 models available from 2 servers\nClick for diagnostics",
				severity: "plain",
			});
		});

		test("a restore-less start on a configured install claims connecting, never not-configured", () => {
			// The one-time reset after a version bump: the persisted state feeds the setup gate and the diagnostics
			// snapshot that lands in public issue reports, so a configured install must not claim "not configured"
			// while it waits for the first report.
			const manager = createManager({ state: "connected", totalModels: 3, serverStatuses: [] }, () => true);

			assert.deepStrictEqual(manager.connectionStatus, { state: "connecting", attention: false });

			// The seed is not evidence of persistence: the FIRST empty report after it stays the neutral spinner, and
			// only the second one escalates.
			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });
			assert.strictEqual(manager.connectingAttention, false, "the seed must not make the first report consecutive");
			manager.handleAggregatedStatus({ serverStatuses: [], totalModels: 0, silent: true });
			assert.strictEqual(manager.connectingAttention, true);
		});

		test("a connected blob missing its counts is not the current shape and restores as undefined", () => {
			// The live path always writes the counts; a blob without them can only be junk, and the display cache
			// restores from scratch.
			const manager = createManager(stamped({ state: "connected" }));

			assert.deepStrictEqual(manager.connectionStatus, { state: "not-configured" });
		});

		for (const state of ["not-configured", "loading"] as const) {
			test(`restores state "${state}"`, () => {
				const manager = createManager(stamped({ state }));

				assert.deepStrictEqual(manager.connectionStatus, { state });
			});
		}

		for (const state of ["connected", "degraded"] as const) {
			test(`restores state "${state}" with its counts`, () => {
				const manager = createManager(stamped({ state, totalModels: 3, serverStatuses: [] }));

				assert.deepStrictEqual(manager.connectionStatus, { state, totalModels: 3, serverStatuses: [] });
			});
		}

		test("an error blob without its log rendering is not the current shape and restores as undefined", () => {
			// The log slot may never be rebuilt from the cause (the cause is display vocabulary, the log line is a
			// classification), and the current shape always carries it, so a blob without one restores as nothing.
			const manager = createManager(stamped({ state: "error", cause: UNCLASSIFIED }));

			assert.deepStrictEqual(manager.connectionStatus, { state: "not-configured" });
		});

		test("restores a persisted logSafeError alongside the cause", () => {
			const cause: FailureCause = { kind: "transport", classification: { kind: "http", status: 502 } };
			const manager = createManager(stamped({ state: "error", cause, logSafeError: "RequestError(http, status 502)" }));

			const status = manager.connectionStatus;
			assert.ok(status.state === "error");
			assert.deepStrictEqual(status.cause, cause);
			assert.strictEqual(status.logSafeError, "RequestError(http, status 502)");
		});

		suite("the persisted cause", () => {
			// The persisted shape is enum ids plus an integer status, never message text; the transport classification
			// rides inside the cause.
			const classification = { kind: "connection", setupHint: "proxy-not-running" };
			const errorElement = (cause: unknown) => ({
				label: "Prod",
				baseUrl: "http://prod.test",
				state: "error",
				cause,
				logSafeError: "RequestError(connection)",
				servedModelCount: 0,
			});
			const transport = (elementClassification: unknown) => ({
				kind: "transport",
				classification: elementClassification,
			});
			const fieldDroppingJunk: ReadonlyArray<[string, unknown, unknown]> = [
				[
					"a fractional status",
					{ kind: "http", status: 404.5, setupHint: "check-base-url" },
					{ kind: "http", setupHint: "check-base-url" },
				],
				["a bogus setupHint", { kind: "http", status: 404, setupHint: "reboot" }, { kind: "http", status: 404 }],
			];
			const causeDroppingJunk: ReadonlyArray<[string, unknown]> = [
				["an unknown transport kind", transport({ kind: "exploded", status: 404 })],
				["a non-object classification", transport("check-base-url")],
				["an unknown cause kind", { kind: "text", text: "boom" }],
				["a sync arm with an unknown class", { kind: "sync", failureClass: "exploded" }],
				["a refusal naming no field", { kind: "credentialsRefused", fields: [] }],
				["a non-object cause", "boom"],
			];

			test("restores at the top level", () => {
				const manager = createManager(
					stamped({ state: "error", cause: transport(classification), logSafeError: "RequestError(connection)" })
				);

				const status = manager.connectionStatus;
				assert.ok(status.state === "error");
				assert.deepStrictEqual(status.cause, transport(classification));
			});

			test("restores on a nested error element", () => {
				const manager = createManager(
					stamped({
						state: "degraded",
						totalModels: 0,
						serverStatuses: [errorElement(transport(classification))],
					})
				);

				const status = manager.connectionStatus;
				assert.ok(status.state === "degraded");
				const element = expectErrorElement(status.serverStatuses);
				assert.deepStrictEqual(element.cause, transport(classification));
			});

			test("every non-transport arm restores as written, at both sites", () => {
				const causes: readonly FailureCause[] = [
					{ kind: "sync", failureClass: "credentialsRefused" },
					{ kind: "credentials", reason: "secretsUnreadable" },
					{ kind: "credentialsRefused", fields: ["apiKey", "virtualKeyValue"] },
					{ kind: "misconfiguredEntry" },
					{ kind: "unclassified" },
				];
				for (const cause of causes) {
					const manager = createManager(
						stamped({
							state: "error",
							cause,
							logSafeError: "RequestError(connection)",
							serverStatuses: [errorElement(cause)],
						})
					);
					const status = manager.connectionStatus;
					assert.ok(status.state === "error", cause.kind);
					assert.deepStrictEqual(status.cause, cause, cause.kind);
					assert.deepStrictEqual(expectErrorElement(status.serverStatuses ?? []).cause, cause, cause.kind);
					assert.strictEqual(failureClassification(status.cause), undefined, "no transport classification is invented");
				}
			});

			for (const [label, junk, preserved] of fieldDroppingJunk) {
				test(`${label} drops that field and keeps the rest, at the top level`, () => {
					const manager = createManager(
						stamped({ state: "error", cause: transport(junk), logSafeError: "RequestError(connection)" })
					);

					const status = manager.connectionStatus;
					assert.ok(status.state === "error", "the error status itself must survive");
					assert.deepStrictEqual(status.cause, transport(preserved));
				});

				test(`${label} drops that field and keeps the rest, on the nested element`, () => {
					const manager = createManager(
						stamped({
							state: "degraded",
							totalModels: 0,
							serverStatuses: [errorElement(transport(junk))],
						})
					);

					const status = manager.connectionStatus;
					assert.ok(status.state === "degraded");
					assert.deepStrictEqual(expectErrorElement(status.serverStatuses).cause, transport(preserved));
				});
			}

			for (const [label, junk] of causeDroppingJunk) {
				test(`${label} is not the current shape: the top-level status restores as undefined`, () => {
					// The cause is the headline's key: without one there is nothing honest to render, and the display
					// cache restores from scratch rather than guess.
					const manager = createManager(
						stamped({ state: "error", cause: junk, logSafeError: "RequestError(connection)" })
					);

					assert.deepStrictEqual(manager.connectionStatus, { state: "not-configured" });
				});

				test(`${label} is not the current shape: the nested element drops`, () => {
					const manager = createManager(
						stamped({ state: "degraded", totalModels: 0, serverStatuses: [errorElement(junk)] })
					);

					assert.deepStrictEqual(manager.connectionStatus, { state: "degraded", totalModels: 0, serverStatuses: [] });
				});
			}
		});

		test("an error blob without a cause is not the current shape and restores as undefined", () => {
			// The cause cannot be invented, and the live path always writes one, so a cause-less error blob restores
			// as nothing at all.
			const manager = createManager(stamped({ state: "error", logSafeError: "RequestError(connection)" }));

			assert.deepStrictEqual(manager.connectionStatus, { state: "not-configured" });
		});

		test("a previous version's text-bearing envelope restores as undefined, never as text", () => {
			// Earlier versions stored the rendered sentence; the reader accepts exactly its own version, so such a blob
			// starts the bar from scratch instead of restoring a sentence written under last session's locale.
			const manager = createManager({
				v: 6,
				status: { state: "error", headline: { kind: "text", text: "boom" }, logSafeError: "RequestError(connection)" },
			});

			assert.deepStrictEqual(manager.connectionStatus, { state: "not-configured" });
		});

		test("a restored connecting state carries the needs-attention flag", () => {
			const manager = createManager(stamped({ state: "connecting", attention: false }));

			assert.deepStrictEqual(manager.connectionStatus, { state: "connecting", attention: true });
		});

		test("a loading blob persisted with a carried attention flag restores neutral and never counts as consecutive", () => {
			// The loading variant carries no attention flag, so a stray one on a stamped blob is an unknown field the
			// loose parse drops; the session boundary must not let it degrade this session.
			const manager = createManager(stamped({ state: "loading", attention: true }), () => true);

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
				servedModelCount: 2,
				lastChecked: "2026-07-26T00:00:00.000Z",
			};
			const manager = createManager(
				stamped({
					state: "degraded",
					totalModels: 2,
					serverStatuses: [null, 42, "junk", { label: "Prod", baseUrl: "http://x", state: "ok" }, ok],
				})
			);

			assert.deepStrictEqual(manager.connectionStatus, {
				state: "degraded",
				totalModels: 2,
				serverStatuses: [ok],
			});
		});

		test("an ok element without its served count and an error element without its cause or log slots are malformed", () => {
			// The shapes the diagnostics renderer refuses to print ("OK (undefined models)", "Error: undefined") never
			// survive the restore; an empty log rendering counts as none, and a missing one may never be rebuilt from
			// the cause.
			const manager = createManager(
				stamped({
					state: "connected",
					totalModels: 0,
					serverStatuses: [
						{ label: "Prod", baseUrl: "http://prod.test", state: "ok" },
						{ label: "Backup", baseUrl: "http://backup.test", state: "error" },
						{
							label: "Blank",
							baseUrl: "http://blank.test",
							state: "error",
							cause: UNCLASSIFIED,
							logSafeError: "",
							servedModelCount: 0,
						},
						{
							label: "NoLog",
							baseUrl: "http://nolog.test",
							state: "error",
							cause: UNCLASSIFIED,
							servedModelCount: 0,
						},
					],
				})
			);

			assert.deepStrictEqual(manager.connectionStatus, { state: "connected", totalModels: 0, serverStatuses: [] });
		});

		test("a junk-typed optional field drops the field, never the whole element", () => {
			const manager = createManager(
				stamped({
					state: "connected",
					totalModels: 1,
					serverStatuses: [
						{
							serverId: 42,
							hasApiKey: "yes",
							label: "Prod",
							baseUrl: "http://prod.test",
							state: "ok",
							servedModelCount: 1,
						},
					],
				})
			);

			assert.deepStrictEqual(manager.connectionStatus, {
				state: "connected",
				totalModels: 1,
				serverStatuses: [
					{
						serverId: "",
						label: "Prod",
						baseUrl: "http://prod.test",
						state: "ok",
						servedModelCount: 1,
						lastChecked: "",
					},
				],
			});
		});

		test("unknown top-level fields are dropped by the normalizing parse", () => {
			const manager = createManager(
				stamped({ state: "degraded", totalModels: 3, serverStatuses: [], futureField: { nested: true } })
			);

			assert.deepStrictEqual(manager.connectionStatus, { state: "degraded", totalModels: 3, serverStatuses: [] });
		});

		suite("restores as undefined and starts from not-configured", () => {
			const rejected: ReadonlyArray<[string, unknown]> = [
				// The envelope gate: only the current version stamp is readable.
				["the blob has no version stamp (every pre-stamp version's format)", { state: "loading" }],
				["the stamp is the previous release's version", { v: 1, status: { state: "loading" } }],
				["the stamp is not a number", { v: "2", status: { state: "loading" } }],
				["the envelope has no status", { v: 6 }],
				// The status shape gate, inside a current-version envelope.
				["state is missing", stamped({ totalModels: 5 })],
				["state is not a known connection state", stamped({ state: "exploded" })],
				["serverStatuses is not an array", stamped({ state: "connected", totalModels: 1, serverStatuses: "oops" })],
				["the stamped status is null", stamped(null)],
				["the stamped status is a plain string", stamped("connected")],
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
