import * as assert from "node:assert";
import { APIConnectionError } from "openai";
import * as vscode from "vscode";
import { Notifier, reconfigureAction } from "../../../extension/ui/notifier";
import { mapSdkError, statusErrorTexts } from "../../../provider/transport/errorMapping";
import type { TransportErrorClassification } from "../../../shared/errorClassification";
import { publicErrorText } from "../../../shared/logger";
import type { AggregatedStatus, ServerStatus } from "../../../shared/servers";
import type { Timer } from "../../../shared/util/timer";
import { expectDefined } from "../../pureHelpers";

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

	function okStatus(modelCount: number): ServerStatus {
		return {
			serverId: "srv1",
			label: "Default",
			baseUrl: "http://litellm.test",
			state: "ok",
			modelCount,
			lastChecked: new Date().toISOString(),
		};
	}

	function errorStatus(error: string, classification?: TransportErrorClassification): ServerStatus {
		return {
			serverId: "srv1",
			label: "Default",
			baseUrl: "http://litellm.test",
			state: "error",
			error,
			logSafeError: publicErrorText(error),
			...(classification !== undefined ? { classification } : {}),
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
			error,
			logSafeError: publicErrorText(error),
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

	/** A hand-cranked Timer: nothing fires until the test elapses the grace itself. */
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
			notifier: new Notifier(hasConfiguredServers, 5000, clock.timer),
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
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		assert.strictEqual(toasts.length, 2);
		const toast = expectDefined(toasts[1]);
		assert.strictEqual(toast.kind, "error");
		assert.ok(toast.message.includes("ECONNREFUSED"));
	});

	test("different failure message counts as a new condition", () => {
		const notifier = new Notifier(() => false);
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		notifier.handleAggregatedStatus(allFailed("401 Unauthorized"));
		notifier.handleAggregatedStatus(allFailed("401 Unauthorized"));
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
		const notifier = new Notifier(() => false);
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED", false));
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED", true));
		assert.strictEqual(toasts.length, 1, "The non-silent pass must not consume the dedup signature");
		assert.strictEqual(expectDefined(toasts[0]).kind, "error");
	});

	/** A group serving zero models because the user explicitly removed (hid) it. */
	function hiddenGroupStatus(serverId = "srv1"): ServerStatus {
		return {
			serverId,
			label: "Default",
			baseUrl: "http://litellm.test",
			state: "ok",
			modelCount: 0,
			hiddenByRemoval: true,
			lastChecked: new Date().toISOString(),
		};
	}

	test("zero models with reachable servers warns with recovery actions", () => {
		const notifier = new Notifier(() => false);
		notifier.handleAggregatedStatus(noModels());
		assert.strictEqual(toasts.length, 1);
		const toast = expectDefined(toasts[0]);
		assert.strictEqual(toast.kind, "warning");
		assert.ok(toast.message.includes("no models"));
		assert.deepStrictEqual(toast.buttons, ["Check Server", "Reconfigure", "Report Issue"]);
	});

	test("zero models explained by a hidden group names the removal and opens the dashboard, never blames the proxy", () => {
		// The only group is hidden by an explicit removal; "Check your LiteLLM
		// proxy configuration" was actively wrong here.
		const notifier = new Notifier(() => true);
		notifier.handleAggregatedStatus({ serverStatuses: [hiddenGroupStatus()], totalModels: 0, silent: true });
		assert.strictEqual(toasts.length, 1);
		const toast = expectDefined(toasts[0]);
		assert.strictEqual(toast.kind, "warning");
		assert.ok(toast.message.includes("hidden by an explicit removal"), toast.message);
		assert.ok(toast.message.includes("Restore it from the dashboard's server list"), toast.message);
		assert.ok(!toast.message.includes("proxy"), toast.message);
		assert.deepStrictEqual(toast.buttons, ["Open Dashboard", "Report Issue"]);
	});

	test("a hidden group beside an answering-empty server names both causes in one toast", () => {
		const notifier = new Notifier(() => true);
		notifier.handleAggregatedStatus({
			serverStatuses: [hiddenGroupStatus("srv-hidden"), okStatus(0)],
			totalModels: 0,
			silent: true,
		});
		assert.strictEqual(toasts.length, 1);
		const toast = expectDefined(toasts[0]);
		assert.ok(toast.message.includes("hidden by an explicit removal"), toast.message);
		assert.ok(toast.message.includes("answered but listed no models"), toast.message);
	});

	test("a hidden group beside an unexpected failure keeps the plain no-models warning", () => {
		// A genuine failure is in the mix: restore advice must not paper over it,
		// so the toast keeps the wording that points at checking the servers.
		const notifier = new Notifier(() => true);
		notifier.handleAggregatedStatus({
			serverStatuses: [hiddenGroupStatus("srv-hidden"), errorStatus("ECONNREFUSED")],
			totalModels: 0,
			silent: true,
		});
		assert.strictEqual(toasts.length, 1);
		const toast = expectDefined(toasts[0]);
		assert.ok(toast.message.includes("returned no models"), toast.message);
		assert.ok(!toast.message.includes("hidden"), toast.message);
		assert.deepStrictEqual(toast.buttons, ["Check Server", "Reconfigure", "Report Issue"]);
	});

	test("all failures expected with nothing declared warns needs-declare, not 'returned no models'", () => {
		// Discovery never returned a list here, so the toast mirrors the dashboard
		// and status bar's needs-declare verdict and points at the fix (the
		// entry's discovery.declared list).
		const notifier = new Notifier(() => true);
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

	test("an expected failure beside a reachable zero-model server keeps the plain no-models warning", () => {
		// A healthy server DID return an (empty) list, so "returned no models"
		// is the truthful description; needs-declare needs every server failing
		// expectedly.
		const notifier = new Notifier(() => true);
		notifier.handleAggregatedStatus({
			serverStatuses: [okStatus(0), expectedErrorStatus("404 page not found", "srv2")],
			totalModels: 0,
			silent: true,
		});
		assert.strictEqual(toasts.length, 1);
		assert.ok(expectDefined(toasts[0]).message.includes("returned no models"));
	});

	test("an empty status window stays silent while servers are configured elsewhere", () => {
		const notifier = new Notifier(() => true);
		notifier.handleAggregatedStatus(noServers());
		assert.strictEqual(toasts.length, 0, "declared or group-served servers must suppress the no-servers claim");
		// Real failures are not gated: reachability problems are true regardless
		// of where the servers were configured.
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		assert.strictEqual(toasts.length, 1);
		assert.strictEqual(expectDefined(toasts[0]).kind, "error");
	});

	suite("the cold-start ordering", () => {
		test("empty groupless report, then the latch flips: no toast, ever", () => {
			// The migrated-user sequence: the host's groupless refresh reports an
			// empty window while the gate is still false.
			let configured = false;
			const { notifier, elapseGrace, pendingCount } = makeNotifier(() => configured);
			notifier.handleAggregatedStatus(noServers());
			assert.strictEqual(toasts.length, 0, "the claim must not fire on the spot");
			assert.strictEqual(pendingCount(), 1, "the claim is deferred, not dropped");
			// Milliseconds later the host hands over a group and the latch flips.
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
			// A user-initiated check while the claim is pending: its caller surfaces
			// the outcome directly, so it neither arms nor withdraws the deferred
			// background claim.
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

		test("a hint-carrying classification keeps today's message and adds Troubleshooting Docs", () => {
			// The transport message already carries its own advice; the
			// classification's whole value on the toast is the docs action.
			const notifier = new Notifier(() => false);
			notifier.handleAggregatedStatus(
				allFailed("Connection Error: Unable to connect to http://litellm.test.", true, hinted)
			);
			assert.strictEqual(toasts.length, 1);
			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "error");
			assert.strictEqual(toast.message, "LiteLLM: Connection Error: Unable to connect to http://litellm.test.");
			assert.deepStrictEqual(toast.buttons, ["Reconfigure", "Troubleshooting Docs", "Report Issue"]);
		});

		test("without a classification the toast renders exactly today's message and actions", () => {
			const notifier = new Notifier(() => false);
			notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.message, "LiteLLM: ECONNREFUSED");
			assert.deepStrictEqual(toast.buttons, ["Reconfigure", "Report Issue"]);
		});

		test("a hintless classification renders today's UI too", () => {
			// A classified error whose construction site opted out of a hint (a
			// timeout, an upstream-auth 401) must not grow a docs button with no
			// cause-specific target.
			const notifier = new Notifier(() => false);
			notifier.handleAggregatedStatus(allFailed("timed out", true, { kind: "timeout" }));
			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.message, "LiteLLM: timed out");
			assert.deepStrictEqual(toast.buttons, ["Reconfigure", "Report Issue"]);
		});

		test("the same text with the same hint still dedups", () => {
			const notifier = new Notifier(() => false);
			notifier.handleAggregatedStatus(allFailed("boom", true, hinted));
			notifier.handleAggregatedStatus(allFailed("boom", true, hinted));
			assert.strictEqual(toasts.length, 1, "an unchanged failure must not re-fire");
		});

		test("a bare failure followed by the same text with a hint re-fires", () => {
			// The signature keys on error text PLUS hint: the hint identifies the
			// cause, so its arrival is new information (and the first toast that
			// carries the Troubleshooting Docs action), not a duplicate.
			const notifier = new Notifier(() => false);
			notifier.handleAggregatedStatus(allFailed("boom"));
			notifier.handleAggregatedStatus(allFailed("boom", true, hinted));
			assert.strictEqual(toasts.length, 2, "the hinted re-report must not dedup against the bare one");
			assert.deepStrictEqual(expectDefined(toasts[1]).buttons, ["Reconfigure", "Troubleshooting Docs", "Report Issue"]);
		});

		test("distinct causes sharing display text re-fire: DNS failure then connection refused", () => {
			// Composed from real transport mappings so the shared-text premise cannot
			// drift: ENOTFOUND and ECONNREFUSED render the same connection message, but
			// only ECONNREFUSED carries proxy-not-running, so a text-only signature would
			// suppress the toast offering the docs action.
			const ctx = { surface: "discovery" as const, baseUrl: "http://litellm.test", timeoutMs: 5000 };
			const connectionFailure = (deepest: string) =>
				statusErrorTexts(
					mapSdkError(
						new APIConnectionError({
							cause: Object.assign(new TypeError("fetch failed"), { cause: new Error(deepest) }),
						}),
						ctx
					)
				);
			const dns = connectionFailure("getaddrinfo ENOTFOUND litellm.test");
			const refused = connectionFailure("connect ECONNREFUSED 127.0.0.1:4000");
			assert.strictEqual(dns.error, refused.error, "the premise: both causes share one display text");
			assert.strictEqual(dns.classification?.setupHint, undefined, "DNS failure must carry no hint");
			assert.strictEqual(refused.classification?.setupHint, "proxy-not-running");

			const notifier = new Notifier(() => false);
			notifier.handleAggregatedStatus(allFailed(dns.error, true, dns.classification));
			notifier.handleAggregatedStatus(allFailed(refused.error, true, refused.classification));
			assert.strictEqual(toasts.length, 2, "the refused connection must not dedup against the DNS failure");
			assert.deepStrictEqual(expectDefined(toasts[1]).buttons, ["Reconfigure", "Troubleshooting Docs", "Report Issue"]);
		});
	});

	suite("two-part failure messages", () => {
		test("the toast carries the headline line only, and detail churn does not re-fire it", () => {
			const notifier = new Notifier(() => false);
			notifier.handleAggregatedStatus(
				allFailed("The server could not be reached.\nGET http://litellm.test/v1/models: ECONNREFUSED")
			);
			assert.strictEqual(toasts.length, 1);
			assert.strictEqual(expectDefined(toasts[0]).message, "LiteLLM: The server could not be reached.");
			// The detail line carries variable server-derived text (spend figures,
			// cause chains); its churn is not new information.
			notifier.handleAggregatedStatus(
				allFailed("The server could not be reached.\nGET http://litellm.test/v1/models: ETIMEDOUT")
			);
			assert.strictEqual(toasts.length, 1, "a detail-only change must not re-toast");
		});
	});

	test("a suppressed empty window preserves dedup, so a recurring error toasts once", () => {
		// A group-configured install whose groupless refresh reports an empty
		// window between per-group refreshes.
		const notifier = new Notifier(() => true);
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		assert.strictEqual(toasts.length, 1);
		// The empty window is suppressed (not recovered), so it must not reset the
		// dedup signature the way a healthy refresh would.
		notifier.handleAggregatedStatus(noServers());
		assert.strictEqual(toasts.length, 1, "the gated empty window makes no claim");
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		assert.strictEqual(toasts.length, 1, "the suppressed window must not have re-armed the same error");
	});

	test("a genuine recovery still re-arms dedup", () => {
		const notifier = new Notifier(() => true);
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		notifier.handleAggregatedStatus(success());
		notifier.handleAggregatedStatus(allFailed("ECONNREFUSED"));
		assert.strictEqual(toasts.length, 2, "a healthy refresh between failures re-arms the toast");
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
});
