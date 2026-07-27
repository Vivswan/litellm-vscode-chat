import * as assert from "node:assert";
import * as vscode from "vscode";
import type { NotifierTimer } from "../../extension/notifier";
import { createConfigurationPrompt, Notifier, reconfigureAction } from "../../extension/notifier";
import type { AggregatedStatus, ServerStatus } from "../../shared/servers";
import { expectDefined } from "../testUtils";

suite("extension/notifier", () => {
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

	function serverStatus(state: "ok" | "error", modelCount: number, error?: string): ServerStatus {
		return {
			serverId: "srv1",
			label: "Default",
			baseUrl: "http://litellm.test",
			state,
			modelCount,
			error,
			lastChecked: new Date().toISOString(),
		};
	}

	const noServers = (silent = true): AggregatedStatus => ({ serverStatuses: [], totalModels: 0, silent });
	const allFailed = (error: string, silent = true): AggregatedStatus => ({
		serverStatuses: [serverStatus("error", 0, error)],
		totalModels: 0,
		silent,
	});
	const noModels = (silent = true): AggregatedStatus => ({
		serverStatuses: [serverStatus("ok", 0)],
		totalModels: 0,
		silent,
	});
	const success = (silent = true): AggregatedStatus => ({
		serverStatuses: [serverStatus("ok", 3)],
		totalModels: 3,
		silent,
	});

	/** A hand-cranked NotifierTimer: nothing fires until the test elapses the grace itself. */
	function manualTimer(): { timer: NotifierTimer; elapseGrace(): void; pendingCount(): number } {
		let nextHandle = 0;
		const pending = new Map<number, () => void>();
		return {
			timer: {
				set: (callback) => {
					nextHandle += 1;
					pending.set(nextHandle, callback);
					return nextHandle;
				},
				clear: (handle) => {
					pending.delete(handle as number);
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

	test("zero models with reachable servers warns with recovery actions", () => {
		const notifier = new Notifier(() => false);
		notifier.handleAggregatedStatus(noModels());
		assert.strictEqual(toasts.length, 1);
		const toast = expectDefined(toasts[0]);
		assert.strictEqual(toast.kind, "warning");
		assert.ok(toast.message.includes("no models"));
		assert.deepStrictEqual(toast.buttons, ["Check Server", "Reconfigure", "Report Issue"]);
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
			// The exact migrated-user sequence: the host's groupless refresh runs
			// first and reports an empty window while the gate is still false (the
			// per-group prepares that flip the latch have not happened yet).
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
			// background claim - the world is still empty, the claim still holds.
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

	test("Configure Now routes to the server editor, not the hub menu", async () => {
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
		assert.deepStrictEqual(executed, ["litellm.manageServers"]);
	});

	suite("createConfigurationPrompt", () => {
		test("stays silent when servers are configured outside the legacy registry", async () => {
			const prompt = createConfigurationPrompt(() => true);

			assert.strictEqual(await prompt.promptToConfigure(), false);
			assert.deepStrictEqual(toasts, [], "a configured provider group must not trigger the not-configured toast");
		});

		test("toasts when nothing is configured anywhere", async () => {
			const prompt = createConfigurationPrompt(() => false);

			assert.strictEqual(await prompt.promptToConfigure(), false);
			assert.strictEqual(toasts.length, 1);
			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "error");
			assert.ok(toast.message.includes("not configured"));
			assert.deepStrictEqual(toast.buttons, ["Configure Now", "Learn More"]);
		});

		test("Configure Now runs the manage flow and reports completion", async () => {
			const executed: string[] = [];
			const origError = vscode.window.showErrorMessage;
			const origExecute = vscode.commands.executeCommand;
			(vscode.window as Record<string, unknown>).showErrorMessage = async () => "Configure Now";
			(vscode.commands as Record<string, unknown>).executeCommand = async (command: string) => {
				executed.push(command);
			};
			try {
				const prompt = createConfigurationPrompt(() => false);
				assert.strictEqual(await prompt.promptToConfigure(), true);
			} finally {
				(vscode.window as Record<string, unknown>).showErrorMessage = origError;
				(vscode.commands as Record<string, unknown>).executeCommand = origExecute;
			}
			assert.deepStrictEqual(executed, ["litellm.manageServers"]);
		});
	});
});
