import * as assert from "node:assert";
import { APIConnectionError } from "openai";
import * as vscode from "vscode";
import type { DeclaredServerView } from "../../../extension/servers/serverSync";
import { reconfigureAction, showMessage } from "../../../extension/ui/notifier";
import { zeroModelJudgment, zeroModelTexts } from "../../../extension/ui/status";
import { isHostCancellation } from "../../../provider/transport/cancellation";
import { mapSdkError } from "../../../provider/transport/errorMapping";
import type { TransportErrorClassification } from "../../../shared/errorClassification";
import { transportClassificationOf } from "../../../shared/errorClassification";
import { failureTexts } from "../../../shared/failureCause";
import { Logger, publicErrorText } from "../../../shared/logger";
import type { AggregatedStatus, ServerStatus } from "../../../shared/servers";
import type { Timer } from "../../../shared/util/timer";
import { expectDefined } from "../../pureHelpers";
import { createStatusBarManager, RecordingItem } from "./statusBarHarness";
import { windowNotifier } from "./verdictHarness";

suite("extension/ui/notifier", () => {
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

	function okStatus(servedModelCount: number): ServerStatus {
		return {
			serverId: "srv1",
			label: "Default",
			baseUrl: "http://litellm.test",
			state: "ok",
			servedModelCount,
			lastChecked: new Date().toISOString(),
		};
	}

	function errorStatus(error: string, classification?: TransportErrorClassification): ServerStatus {
		return {
			serverId: "srv1",
			label: "Default",
			baseUrl: "http://litellm.test",
			state: "error",
			cause: classification !== undefined ? { kind: "transport", classification } : { kind: "unclassified" },
			logSafeError: publicErrorText(error),
			servedModelCount: 0,
			lastChecked: new Date().toISOString(),
		};
	}

	/** A failure in a category the entry's expectedFailures declares. */
	function expectedErrorStatus(error: string, serverId = "srv1"): ServerStatus {
		return {
			serverId,
			label: "Default",
			baseUrl: "http://litellm.test",
			state: "error",
			cause: { kind: "unclassified" },
			logSafeError: publicErrorText(error),
			servedModelCount: 0,
			expected: true,
			lastChecked: new Date().toISOString(),
		};
	}

	const noServers = (silent = true): AggregatedStatus => ({ serverStatuses: [], totalModels: 0, silent });
	const allFailed = (
		error: string,
		silent = true,
		classification?: TransportErrorClassification
	): AggregatedStatus => ({
		serverStatuses: [errorStatus(error, classification)],
		totalModels: 0,
		silent,
	});
	const noModels = (silent = true): AggregatedStatus => ({
		serverStatuses: [okStatus(0)],
		totalModels: 0,
		silent,
	});
	const success = (silent = true): AggregatedStatus => ({
		serverStatuses: [okStatus(3)],
		totalModels: 3,
		silent,
	});

	function manualTimer(): { timer: Timer; elapseGrace(): void; pendingCount(): number } {
		let nextHandle = 0;
		const pending = new Map<number, () => void>();
		return {
			timer: {
				set: (callback) => {
					nextHandle += 1;
					const handle = nextHandle;
					pending.set(handle, callback);
					return () => pending.delete(handle);
				},
			},
			elapseGrace: () => {
				const callbacks = [...pending.values()];
				pending.clear();
				for (const callback of callbacks) {
					callback();
				}
			},
			pendingCount: () => pending.size,
		};
	}

	function makeNotifier(hasConfiguredServers: () => boolean) {
		const clock = manualTimer();
		return {
			notifier: windowNotifier(hasConfiguredServers, { graceMs: 5000, timer: clock.timer }),
			elapseGrace: clock.elapseGrace,
			pendingCount: clock.pendingCount,
		};
	}

	test("the deferred no-servers claim toasts once even when reported twice", () => {
		const { notifier, elapseGrace } = makeNotifier(() => false);
		notifier.handleAggregatedStatus(noServers());
		notifier.handleAggregatedStatus(noServers());
		elapseGrace();
		assert.strictEqual(toasts.length, 1);
		const toast = expectDefined(toasts[0]);
		assert.strictEqual(toast.kind, "warning");
		assert.ok(toast.message.includes("No servers configured"));
		elapseGrace();
		assert.strictEqual(toasts.length, 1, "nothing re-arms without a new report");
	});

	test("condition change produces a new toast", () => {
		const { notifier, elapseGrace } = makeNotifier(() => false);
		notifier.handleAggregatedStatus(noServers());
		elapseGrace();
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED", true, { kind: "connection" }));
		assert.strictEqual(toasts.length, 2);
		const toast = expectDefined(toasts[1]);
		assert.strictEqual(toast.kind, "error");
		assert.strictEqual(toast.message, "LiteLLM: Could not connect to http://litellm.test");
	});

	test("the failure toast masks the rendered cause: a registered value in the configured URL shows its reveal", () => {
		const key = `Q17key${"X".repeat(34)}`;
		Logger.registerSecrets([key]);
		const notifier = windowNotifier(() => false);
		const failed = allFailed("ECONNREFUSED", true, { kind: "connection" });
		notifier.handleAggregatedStatus({
			...failed,
			serverStatuses: failed.serverStatuses.map((server) => ({ ...server, baseUrl: `http://host.test/${key}` })),
		});
		assert.strictEqual(expectDefined(toasts[0]).message, "LiteLLM: Could not connect to http://host.test/Q17key...");
	});

	test("a different failure cause counts as a new condition; the same cause with another log rendering does not", () => {
		const notifier = windowNotifier(() => false);
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED", true, { kind: "connection" }));
		notifier.handleAggregatedStatus(allFailed("401 Unauthorized", true, { kind: "auth", status: 401 }));
		notifier.handleAggregatedStatus(allFailed("401 Unauthorized, retried", true, { kind: "auth", status: 401 }));
		assert.strictEqual(toasts.length, 2);
	});

	test("successful refresh resets dedup so the same condition notifies again", () => {
		const { notifier, elapseGrace } = makeNotifier(() => false);
		notifier.handleAggregatedStatus(noServers());
		elapseGrace();
		notifier.handleAggregatedStatus(success());
		notifier.handleAggregatedStatus(noServers());
		elapseGrace();
		assert.strictEqual(toasts.length, 2);
	});

	test("non-silent refresh never toasts, not even after the grace", () => {
		const { notifier, elapseGrace, pendingCount } = makeNotifier(() => false);
		notifier.handleAggregatedStatus(noServers(false));
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED", false));
		notifier.handleAggregatedStatus(noModels(false));
		assert.strictEqual(pendingCount(), 0, "a non-silent empty window must not arm the deferred claim");
		elapseGrace();
		assert.strictEqual(toasts.length, 0);
	});

	test("a silent failure toasts even when the same failure was seen non-silently first", () => {
		const notifier = windowNotifier(() => false);
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED", false));
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED", true));
		assert.strictEqual(toasts.length, 1, "The non-silent pass must not consume the dedup signature");
		assert.strictEqual(expectDefined(toasts[0]).kind, "error");
	});

	function hiddenGroupStatus(serverId = "srv1"): ServerStatus {
		return {
			serverId,
			label: "Default",
			baseUrl: "http://litellm.test",
			state: "ok",
			servedModelCount: 0,
			hiddenByRemoval: true,
			lastChecked: new Date().toISOString(),
		};
	}

	test("zero models with reachable servers warns with recovery actions", () => {
		const notifier = windowNotifier(() => false);
		notifier.handleAggregatedStatus(noModels());
		assert.strictEqual(toasts.length, 1);
		const toast = expectDefined(toasts[0]);
		assert.strictEqual(toast.kind, "warning");
		assert.ok(toast.message.includes("no models"));
		assert.deepStrictEqual(toast.buttons, ["Check Server", "Reconfigure", "Report Issue"]);
	});

	test("zero models explained by a hidden group names the removal and opens the dashboard, never blames the proxy", () => {
		// The only group is hidden by the user's configuration; "Check your LiteLLM proxy configuration" was actively
		// wrong here.
		const notifier = windowNotifier(() => true);
		notifier.handleAggregatedStatus({ serverStatuses: [hiddenGroupStatus()], totalModels: 0, silent: true });
		assert.strictEqual(toasts.length, 1);
		const toast = expectDefined(toasts[0]);
		assert.strictEqual(toast.kind, "warning");
		assert.ok(toast.message.includes("is hidden and serves no models"), toast.message);
		assert.ok(toast.message.includes("The dashboard's server list shows which"), toast.message);
		assert.ok(!toast.message.includes("proxy"), toast.message);
		assert.deepStrictEqual(toast.buttons, ["Open Dashboard", "Report Issue"]);
	});

	test("a hidden group beside an answering-empty server names both causes in one toast", () => {
		const notifier = windowNotifier(() => true);
		notifier.handleAggregatedStatus({
			serverStatuses: [hiddenGroupStatus("srv-hidden"), okStatus(0)],
			totalModels: 0,
			silent: true,
		});
		assert.strictEqual(toasts.length, 1);
		const toast = expectDefined(toasts[0]);
		assert.ok(toast.message.includes("is hidden and serves no models"), toast.message);
		assert.ok(toast.message.includes("answered but listed no models"), toast.message);
	});

	test("a hidden group beside an unexpected failure is a degraded window: the notifier stands down", () => {
		// A genuine failure is in the mix, so the verdict is degraded and the status bar says "1 server failing"; a
		// zero-model toast beside it would blame the catalog for what is really an outage.
		const notifier = windowNotifier(() => true);
		notifier.handleAggregatedStatus({
			serverStatuses: [hiddenGroupStatus("srv-hidden"), errorStatus("ECONNREFUSED")],
			totalModels: 0,
			silent: true,
		});
		assert.strictEqual(toasts.length, 0, "the degraded window's story belongs to the degraded surfaces");
	});

	test("all failures expected with nothing declared warns needs-declare, not 'returned no models'", () => {
		// Discovery never returned a list here, so the toast mirrors the dashboard and status bar's needs-declare
		// verdict and points at the fix (the entry's discovery.declared list).
		const notifier = windowNotifier(() => true);
		notifier.handleAggregatedStatus({
			serverStatuses: [expectedErrorStatus("404 page not found")],
			totalModels: 0,
			silent: true,
		});
		assert.strictEqual(toasts.length, 1);
		const toast = expectDefined(toasts[0]);
		assert.strictEqual(toast.kind, "warning");
		assert.ok(toast.message.includes("no models are declared"), toast.message);
		assert.ok(toast.message.includes("discovery.declared"), toast.message);
		assert.deepStrictEqual(toast.buttons, ["Reconfigure", "Report Issue"]);
	});

	test("an expected failure beside a reachable zero-model server keeps the zero-model warning", () => {
		// A healthy server DID return an (empty) list, so the answered-but-empty wording is the truthful description;
		// needs-declare needs every server failing expectedly.
		const notifier = windowNotifier(() => true);
		notifier.handleAggregatedStatus({
			serverStatuses: [okStatus(0), expectedErrorStatus("404 page not found", "srv2")],
			totalModels: 0,
			silent: true,
		});
		assert.strictEqual(toasts.length, 1);
		assert.ok(expectDefined(toasts[0]).message.includes("answered but listed no models"));
	});

	suite("the zero-model judgment is the one text source for toast and tooltip", () => {
		// The equality pin below is the guard that no surface re-minted its own zero-model prose.
		const table: { name: string; serverStatuses: ServerStatus[]; totalModels: number }[] = [
			{ name: "one answering-empty server", serverStatuses: [okStatus(0)], totalModels: 0 },
			{ name: "several answering-empty servers", serverStatuses: [okStatus(0), okStatus(0)], totalModels: 0 },
			{ name: "a hidden group alone", serverStatuses: [hiddenGroupStatus()], totalModels: 0 },
			{
				name: "a hidden group beside an answering-empty server",
				serverStatuses: [hiddenGroupStatus("srv-hidden"), okStatus(0)],
				totalModels: 0,
			},
			{
				name: "an expected failure beside an answering-empty server",
				serverStatuses: [okStatus(0), expectedErrorStatus("404 page not found", "srv2")],
				totalModels: 0,
			},
			{
				name: "an unreachable server beside an answering-empty server (degraded)",
				serverStatuses: [okStatus(0), errorStatus("ECONNREFUSED")],
				totalModels: 0,
			},
			{
				name: "a hidden group beside an unexpected failure (degraded)",
				serverStatuses: [hiddenGroupStatus("srv-hidden"), errorStatus("ECONNREFUSED")],
				totalModels: 0,
			},
			{ name: "every server failed unexpectedly (error)", serverStatuses: [errorStatus("boom")], totalModels: 0 },
			{
				name: "expected failures only (needs-declare)",
				serverStatuses: [expectedErrorStatus("404 page not found")],
				totalModels: 0,
			},
			{ name: "healthy servers with models (connected)", serverStatuses: [okStatus(3)], totalModels: 3 },
		];

		for (const { name, serverStatuses, totalModels } of table) {
			test(name, async () => {
				const judgment = zeroModelJudgment(serverStatuses, totalModels);
				const report: AggregatedStatus = { serverStatuses, totalModels, silent: true };
				windowNotifier(() => true).handleAggregatedStatus(report);
				const item = new RecordingItem();
				const { manager, context } = createStatusBarManager({ item });
				try {
					manager.handleAggregatedStatus(report);
					await new Promise((resolve) => setImmediate(resolve));
					if (judgment !== undefined) {
						assert.strictEqual(toasts.length, 1, "the zero-model judgment must toast");
						const texts = zeroModelTexts(judgment);
						assert.strictEqual(expectDefined(toasts[0]).message, `LiteLLM: ${texts.display}`);
						assert.ok(item.last.tooltip.includes(texts.display), item.last.tooltip);
						assert.ok(item.last.tooltip.includes("No models available"), item.last.tooltip);
					} else {
						for (const surface of [item.last.tooltip, ...toasts.map((toast) => toast.message)]) {
							assert.ok(!surface.includes("listed no models"), surface);
							assert.ok(!surface.includes("is hidden and serves no models"), surface);
						}
						assert.ok(!item.last.tooltip.includes("No models available"), item.last.tooltip);
					}
				} finally {
					for (const disposable of context.subscriptions) {
						disposable.dispose();
					}
				}
			});
		}
	});

	test("an empty status window stays silent while servers are configured elsewhere", () => {
		const notifier = windowNotifier(() => true);
		notifier.handleAggregatedStatus(noServers());
		assert.strictEqual(toasts.length, 0, "declared or group-served servers must suppress the no-servers claim");
		// Real failures are not gated: reachability problems are true regardless of where the servers were configured.
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		assert.strictEqual(toasts.length, 1);
		assert.strictEqual(expectDefined(toasts[0]).kind, "error");
	});

	suite("the cold-start ordering", () => {
		test("empty groupless report, then the latch flips: no toast, ever", () => {
			// The migrated-user sequence: the host's groupless refresh reports an empty window while the gate is still
			// false.
			let configured = false;
			const { notifier, elapseGrace, pendingCount } = makeNotifier(() => configured);
			notifier.handleAggregatedStatus(noServers());
			assert.strictEqual(toasts.length, 0, "the claim must not fire on the spot");
			assert.strictEqual(pendingCount(), 1, "the claim is deferred, not dropped");
			configured = true;
			elapseGrace();
			assert.strictEqual(toasts.length, 0, "re-gated at expiry: group evidence withdraws the claim");
		});

		test("empty report with the gate still false toasts once the grace elapses", () => {
			const { notifier, elapseGrace } = makeNotifier(() => false);
			notifier.handleAggregatedStatus(noServers());
			assert.strictEqual(toasts.length, 0);
			elapseGrace();
			assert.strictEqual(toasts.length, 1, "the genuinely-unconfigured user still gets the claim");
			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "warning");
			assert.ok(toast.message.includes("No servers configured"));
			assert.deepStrictEqual(toast.buttons, ["Configure Now"]);
		});

		test("a suppressed report withdraws a claim armed before the gate flipped", () => {
			let configured = false;
			const { notifier, elapseGrace, pendingCount } = makeNotifier(() => configured);
			notifier.handleAggregatedStatus(noServers());
			assert.strictEqual(pendingCount(), 1);
			configured = true;
			notifier.handleAggregatedStatus(noServers());
			assert.strictEqual(pendingCount(), 0, "the suppressed report cancels the pending claim");
			elapseGrace();
			assert.strictEqual(toasts.length, 0);
		});

		test("a report with servers present cancels the pending claim", () => {
			const { notifier, elapseGrace } = makeNotifier(() => false);
			notifier.handleAggregatedStatus(noServers());
			notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
			elapseGrace();
			assert.strictEqual(toasts.length, 1, "only the real failure toasts; the cold-start artifact is withdrawn");
			assert.strictEqual(expectDefined(toasts[0]).kind, "error");
		});

		test("a second empty report does not arm a second claim", () => {
			const { notifier, pendingCount } = makeNotifier(() => false);
			notifier.handleAggregatedStatus(noServers());
			notifier.handleAggregatedStatus(noServers());
			assert.strictEqual(pendingCount(), 1, "re-reports ride the already-armed claim");
		});

		test("a non-silent empty report leaves a pending claim armed, and it still fires at expiry", () => {
			const { notifier, elapseGrace, pendingCount } = makeNotifier(() => false);
			notifier.handleAggregatedStatus(noServers());
			// A user-initiated check while the claim is pending: its caller surfaces the outcome directly, so it
			// neither arms nor withdraws the deferred background claim.
			notifier.handleAggregatedStatus(noServers(false));
			assert.strictEqual(pendingCount(), 1, "the non-silent report leaves the pending claim untouched");
			elapseGrace();
			assert.strictEqual(toasts.length, 1);
			assert.strictEqual(expectDefined(toasts[0]).kind, "warning");
		});

		test("dispose withdraws a pending claim so it cannot fire after deactivation", () => {
			const { notifier, elapseGrace, pendingCount } = makeNotifier(() => false);
			notifier.handleAggregatedStatus(noServers());
			assert.strictEqual(pendingCount(), 1);
			notifier.dispose();
			assert.strictEqual(pendingCount(), 0, "disposal must clear the timer, not just forget it");
			elapseGrace();
			assert.strictEqual(toasts.length, 0, "no toast may fire from a deactivated extension");
		});
	});

	suite("the classification on the all-failed toast", () => {
		const hinted: TransportErrorClassification = { kind: "connection", setupHint: "proxy-not-running" };

		test("a hint-carrying cause renders its text and adds Troubleshooting Docs", () => {
			// The cause's rendering already names the failure; the hint's whole value on the toast is the docs action.
			const notifier = windowNotifier(() => false);
			notifier.handleAggregatedStatus(allFailed("ECONNREFUSED", true, hinted));
			assert.strictEqual(toasts.length, 1);
			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "error");
			assert.strictEqual(toast.message, "LiteLLM: Could not connect to http://litellm.test");
			assert.deepStrictEqual(toast.buttons, ["Reconfigure", "Troubleshooting Docs", "Report Issue"]);
		});

		test("without a transport classification the toast renders the unclassified cause and today's actions", () => {
			const notifier = windowNotifier(() => false);
			notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.message, "LiteLLM: Model discovery failed; the output log has the details");
			assert.deepStrictEqual(toast.buttons, ["Reconfigure", "Report Issue"]);
		});

		test("a hintless classification renders its cause with today's actions", () => {
			// A classified error whose construction site opted out of a hint (a timeout, an upstream-auth 401) must not
			// grow a docs button with no cause-specific target.
			const notifier = windowNotifier(() => false);
			notifier.handleAggregatedStatus(allFailed("timed out", true, { kind: "timeout" }));
			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.message, "LiteLLM: The request to http://litellm.test timed out");
			assert.deepStrictEqual(toast.buttons, ["Reconfigure", "Report Issue"]);
		});

		test("the same cause with the same hint still dedups", () => {
			const notifier = windowNotifier(() => false);
			notifier.handleAggregatedStatus(allFailed("boom", true, hinted));
			notifier.handleAggregatedStatus(allFailed("boom", true, hinted));
			assert.strictEqual(toasts.length, 1, "an unchanged failure must not re-fire");
		});

		test("an unclassified failure followed by a hinted cause re-fires", () => {
			// The signature keys on the whole cause: the hint identifies it, so its arrival is new information (and the
			// first toast that carries the Troubleshooting Docs action), not a duplicate.
			const notifier = windowNotifier(() => false);
			notifier.handleAggregatedStatus(allFailed("boom"));
			notifier.handleAggregatedStatus(allFailed("boom", true, hinted));
			assert.strictEqual(toasts.length, 2, "the hinted re-report must not dedup against the bare one");
			assert.deepStrictEqual(expectDefined(toasts[1]).buttons, ["Reconfigure", "Troubleshooting Docs", "Report Issue"]);
		});

		test("distinct causes sharing a toast headline re-fire: DNS failure then connection refused", () => {
			// Composed from real transport mappings so the shared-rendering premise cannot drift: ENOTFOUND and
			// ECONNREFUSED are both connection causes and render the same toast line, but only ECONNREFUSED carries
			// proxy-not-running, so a signature over the rendered text alone would suppress the toast offering the docs
			// action.
			const ctx = { surface: "discovery" as const, baseUrl: "http://litellm.test", timeoutMs: 5000 };
			const connectionFailure = (deepest: string) =>
				expectDefined(
					transportClassificationOf(
						mapSdkError(
							new APIConnectionError({
								cause: Object.assign(new TypeError("fetch failed"), { cause: new Error(deepest) }),
							}),
							ctx,
							isHostCancellation
						)
					)
				);
			const dns = connectionFailure("getaddrinfo ENOTFOUND litellm.test");
			const refused = connectionFailure("connect ECONNREFUSED 127.0.0.1:4000");
			assert.strictEqual(
				failureTexts({ kind: "transport", classification: dns }, ctx.baseUrl).display,
				failureTexts({ kind: "transport", classification: refused }, ctx.baseUrl).display,
				"the premise: both causes render one toast line"
			);
			assert.strictEqual(dns.setupHint, undefined, "DNS failure must carry no hint");
			assert.strictEqual(refused.setupHint, "proxy-not-running");

			const notifier = windowNotifier(() => false);
			notifier.handleAggregatedStatus(allFailed("ENOTFOUND", true, dns));
			notifier.handleAggregatedStatus(allFailed("ECONNREFUSED", true, refused));
			assert.strictEqual(toasts.length, 2, "the refused connection must not dedup against the DNS failure");
			assert.deepStrictEqual(expectDefined(toasts[1]).buttons, ["Reconfigure", "Troubleshooting Docs", "Report Issue"]);
		});
	});

	suite("the toast renders the cause", () => {
		test("the toast is the cause's one-line rendering, and a changed log rendering does not re-fire it", () => {
			const notifier = windowNotifier(() => false);
			notifier.handleAggregatedStatus(allFailed("ECONNREFUSED", true, { kind: "connection" }));
			assert.strictEqual(toasts.length, 1);
			assert.strictEqual(expectDefined(toasts[0]).message, "LiteLLM: Could not connect to http://litellm.test");
			// The log rendering carries variable classification detail; the same cause is not new information.
			notifier.handleAggregatedStatus(allFailed("ETIMEDOUT", true, { kind: "connection" }));
			assert.strictEqual(toasts.length, 1, "a log-rendering-only change must not re-toast");
		});
	});

	test("a suppressed empty window preserves dedup, so a recurring error toasts once", () => {
		// A group-configured install whose groupless refresh reports an empty window between per-group refreshes.
		const notifier = windowNotifier(() => true);
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		assert.strictEqual(toasts.length, 1);
		// The empty window is suppressed (not recovered), so it must not reset the dedup signature the way a healthy
		// refresh would.
		notifier.handleAggregatedStatus(noServers());
		assert.strictEqual(toasts.length, 1, "the gated empty window makes no claim");
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		assert.strictEqual(toasts.length, 1, "the suppressed window must not have re-armed the same error");
	});

	test("an empty window beside a declared entry awaiting its report is suppressed too, never a recovery", () => {
		// With the entry declared, the empty window's verdict rows hold one unchecked row (waiting), not nothing
		// (not configured); both mean the world is not fully known, so neither resets dedup.
		const notifier = windowNotifier(() => true, {
			getDeclared: () => [
				{
					label: "Default",
					baseUrl: "http://litellm.test",
					secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				},
			],
		});
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		assert.strictEqual(toasts.length, 1);
		notifier.handleAggregatedStatus(noServers());
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		assert.strictEqual(toasts.length, 1, "the awaiting entry's empty window must not have re-armed the same error");
	});

	test("an awaiting entry joining a failed one reads degraded, which is no recovery: dedup holds", () => {
		// Nothing serves in that window; only something serving may re-arm the toast.
		const failed = {
			label: "pending",
			baseUrl: "http://pending.test",
			secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
			syncFailure: { class: "upsertFailed" },
		} as const;
		const awaiting = {
			label: "fresh",
			baseUrl: "http://fresh.test",
			secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
		} as const;
		let declared: readonly DeclaredServerView[] = [failed];
		const notifier = windowNotifier(() => true, { getDeclared: () => declared });
		notifier.handleAggregatedStatus(noServers());
		assert.strictEqual(toasts.length, 1, "the synthesized failure toasts once");
		declared = [failed, awaiting];
		notifier.refreshFromSync();
		declared = [failed];
		notifier.refreshFromSync();
		assert.strictEqual(toasts.length, 1, "the awaiting entry coming and going re-armed nothing");
	});

	test("a genuine recovery still re-arms dedup", () => {
		const notifier = windowNotifier(() => true);
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		notifier.handleAggregatedStatus(success());
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		assert.strictEqual(toasts.length, 2, "a healthy refresh between failures re-arms the toast");
	});

	test("a sync pass before any report toasts a setting whose only entry the parser refused", () => {
		// No overlay (nothing declared) but one verdict row: the same error the bar and the hero show, so the toast
		// cannot stay silent beside them.
		const notifier = windowNotifier(() => true, {
			entryReports: () => [
				{
					index: 0,
					label: "x",
					baseUrl: "http://x.test",
					problems: ["auth: apiKey must be a string"],
					accepted: false,
				},
			],
		});
		notifier.refreshFromSync();
		assert.strictEqual(toasts.length, 1);
		const toast = expectDefined(toasts[0]);
		assert.strictEqual(toast.kind, "error");
		assert.ok(toast.message.includes("misconfigured"), toast.message);
	});

	test("Configure Now opens the dashboard, not the hub menu or a native editor", async () => {
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
		assert.deepStrictEqual(executed, ["litellm.openDashboard"]);
	});

	// The door is the one place toast text is masked, so it must change nothing in text that carries no value: a byte
	// lost here would be a byte lost from every toast and modal in the extension.
	test("showMessage hands a secret-free message, detail, and labels to VS Code unchanged", async () => {
		const calls: unknown[][] = [];
		const origWarn = vscode.window.showWarningMessage;
		(vscode.window as Record<string, unknown>).showWarningMessage = async (...args: unknown[]) => {
			calls.push(args);
			return undefined;
		};
		const message = 'A server named "Prod (http://localhost:4000/v1)" already exists.';
		const detail = "Overwriting replaces the entry and its stored secrets.\n\tTab, trailing space ";
		try {
			await showMessage("warning", message, ["Overwrite", "Skip"], { modal: true, detail });
			await showMessage("warning", message, ["Overwrite"]);
		} finally {
			(vscode.window as Record<string, unknown>).showWarningMessage = origWarn;
		}
		assert.deepStrictEqual(calls, [
			[message, { modal: true, detail }, "Overwrite", "Skip"],
			[message, "Overwrite"],
		]);
	});

	test("showMessage masks a registered value in the message and a URL's userinfo in the detail", async () => {
		const calls: unknown[][] = [];
		const origError = vscode.window.showErrorMessage;
		(vscode.window as Record<string, unknown>).showErrorMessage = async (...args: unknown[]) => {
			calls.push(args);
			return undefined;
		};
		Logger.registerSecrets(["toast-key-Q7-marker"]);
		try {
			await showMessage("error", "LiteLLM: 401 for toast-key-Q7-marker", ["Reconfigure"], {
				modal: true,
				detail: "Seen at http://user:sekret@localhost:4000/v1",
			});
		} finally {
			(vscode.window as Record<string, unknown>).showErrorMessage = origError;
		}
		assert.deepStrictEqual(calls, [
			[
				"LiteLLM: 401 for [redacted]",
				{ modal: true, detail: "Seen at http://[redacted]@localhost:4000/v1" },
				"Reconfigure",
			],
		]);
	});
});
