import * as assert from "node:assert";
import * as vscode from "vscode";
import { catalogOff, ensureActivated } from "../../hostApiHelpers";
import { serverPayload } from "./recordedEnv";

/**
 * Integration over the REAL dashboard wiring: these tests activate the extension and drive
 * litellm._test.dashboardMessage, so createRealPanel, createNonce, buildDashboardHtml, and the real env closures
 * (workspace configuration, SecretStorage, the sync engine) all execute. Assertions read real side effects -
 * configuration inspection, the sync engine's declared views, the injection outcome class - since the real webview's
 * posted messages are not observable here.
 */
suite("extension/dashboard/panelIntegration", () => {
	const CONFIG = "litellm-vscode-chat";
	const TOUCHED_KEYS = ["usage.pollInterval", "servers"] as const;

	type Outcome = "ok" | "validation-error" | "ignored-malformed";

	function inject(raw: unknown): Thenable<Outcome> {
		return vscode.commands.executeCommand<Outcome>("litellm._test.dashboardMessage", raw);
	}

	let nextRequestNumber = 0;
	function request(method: string, payload: unknown, id?: string): unknown {
		nextRequestNumber += 1;
		return { kind: "request", id: id ?? `pi-auto-${nextRequestNumber}`, method, payload };
	}

	interface DeclaredView {
		label: string;
		baseUrl: string;
		secrets: Record<string, string>;
	}

	function declared(): Thenable<readonly DeclaredView[]> {
		return vscode.commands.executeCommand<readonly DeclaredView[]>("litellm._test.getDeclaredServers");
	}

	/** The sync engine refreshes its views asynchronously after a setting write. */
	async function declaredEventually(
		predicate: (views: readonly DeclaredView[]) => boolean,
		what: string
	): Promise<readonly DeclaredView[]> {
		const deadline = Date.now() + 10000;
		let views: readonly DeclaredView[] = [];
		while (Date.now() < deadline) {
			views = await declared();
			if (predicate(views)) {
				return views;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.fail(`timed out waiting for ${what}; declared views: ${JSON.stringify(views.map((v) => v.label))}`);
	}

	const noTouch = { action: "keep" } as const;

	suiteSetup(async function () {
		this.timeout(30000);
		await ensureActivated();
		await catalogOff();
	});

	suiteTeardown(async function () {
		this.timeout(20000);
		// Dispose the real dashboard panel the injection command opened; a webview surviving the suite would keep
		// receiving state pushes from later suites' configuration churn.
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
	});

	teardown(async function () {
		this.timeout(20000);
		// Remove leftover entries through the dashboard's own removal intent, not a raw settings write:
		// removeServerSetting also deletes the entry's SecretStorage blob, so a bare config.update would strand secure
		// blobs in the shared test host. What this cannot undo is the host-side provider group a sync pass may have
		// upserted (VS Code has no group-removal API); that pollution is bounded to this label's disposable
		// user-data-dir, which is why these tests stay in the unit label instead of paying a whole extra host launch
		// for isolation.
		//
		//   Stray host-triggered refreshes of that leftover group  -> absorbed by the baseline localhost:49999 handler
		//                                                             in mocks/handlers.ts
		for (const view of await declared()) {
			await inject(
				request("removeServerSetting", { label: view.label, baseUrl: view.baseUrl }, `pi-teardown-${view.label}`)
			);
		}
		const config = vscode.workspace.getConfiguration(CONFIG);
		for (const key of TOUCHED_KEYS) {
			if (config.inspect(key)?.globalValue !== undefined) {
				await config.update(key, undefined, vscode.ConfigurationTarget.Global);
			}
		}
		// Let the servers-setting change listener finish its sync pass so no stray traffic leaks into later suites (msw
		// runs onUnhandledRequest: "error").
		await declaredEventually((views) => views.length === 0, "the servers setting to sync away");
	});

	test("litellm._test.dashboardMessage opens the real dashboard panel and a ready message classifies ok", async function () {
		this.timeout(20000);
		// The command opens the panel through the real litellm.openDashboard path, so a construction-time throw in
		// createRealPanel, createNonce, or buildDashboardHtml fails here. What it cannot see is the page loading: a
		// wrong bundle filename or CSP still ships a blank webview.
		assert.strictEqual(await inject(request("ready", null)), "ok");
		// And the schema boundary still rejects junk after the panel exists.
		assert.strictEqual(await inject({ type: "no-such-intent" }), "ignored-malformed");
	});

	test("a setNumberSetting intent lands in real user settings via the resolved update scope", async () => {
		assert.strictEqual(
			await inject(request("setNumberSetting", { setting: "usage.pollInterval", value: 42000 })),
			"ok"
		);
		const inspected = vscode.workspace.getConfiguration(CONFIG).inspect<number>("usage.pollInterval");
		assert.strictEqual(
			inspected?.globalValue,
			42000,
			"the write must land in the user scope, not vanish or shadow-write"
		);
	});

	test("a resetSetting intent removes the configured value with the global fallback", async () => {
		assert.strictEqual(
			await inject(request("setNumberSetting", { setting: "usage.pollInterval", value: 42000 })),
			"ok"
		);
		assert.strictEqual(await inject(request("resetSetting", { setting: "usage.pollInterval" })), "ok");
		const inspected = vscode.workspace.getConfiguration(CONFIG).inspect<number>("usage.pollInterval");
		assert.strictEqual(inspected?.globalValue, undefined, "the dashboard claimed a reset; the value must be gone");
	});

	test("saveServerSetting with a secure-location apiKey keeps the secret out of the settings value", async function () {
		this.timeout(20000);
		const outcome = await inject(
			request(
				"saveServerSetting",
				{
					server: serverPayload({ label: "PanelIT", baseUrl: "http://localhost:49999" }),
					secrets: {
						apiKey: { action: "set", location: "secure", value: "sk-panel-integration-secret" },
						oauthClientSecret: noTouch,
						virtualKeyValue: noTouch,
					},
				},
				"pi-save-1"
			)
		);
		assert.strictEqual(outcome, "ok");

		const globalValue = vscode.workspace.getConfiguration(CONFIG).inspect("servers")?.globalValue;
		assert.ok(globalValue !== undefined, "the entry must land in the user-scoped servers setting");
		const serialized = JSON.stringify(globalValue);
		assert.ok(serialized.includes("PanelIT"), serialized);
		assert.ok(!serialized.includes("sk-panel-integration-secret"), "the secret must never sit inline in settings");

		const views = await declaredEventually((v) => v.some((view) => view.label === "PanelIT"), "the entry to sync");
		const view = views.find((v) => v.label === "PanelIT");
		assert.strictEqual(view?.baseUrl, "http://localhost:49999");
		assert.strictEqual(view?.secrets.apiKey, "secure", "the declared view must show the secure storage location");
	});

	test("renaming a saved entry carries its stored secret to the new label; removing deletes the entry", async function () {
		this.timeout(30000);
		await inject(
			request(
				"saveServerSetting",
				{
					server: serverPayload({ label: "PanelIT", baseUrl: "http://localhost:49999" }),
					secrets: {
						apiKey: { action: "set", location: "secure", value: "sk-carry-me" },
						oauthClientSecret: noTouch,
						virtualKeyValue: noTouch,
					},
				},
				"pi-save-2"
			)
		);
		const renamed = await inject(
			request(
				"saveServerSetting",
				{
					server: serverPayload({ label: "PanelIT-Renamed", baseUrl: "http://localhost:49999" }),
					secrets: { apiKey: noTouch, oauthClientSecret: noTouch, virtualKeyValue: noTouch },
					replace: {
						label: "PanelIT",
						baseUrl: "http://localhost:49999",
						secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
					},
				},
				"pi-rename-1"
			)
		);
		assert.strictEqual(renamed, "ok");

		// The location under the NEW label proves the rename's snapshot write ran: had the blob been orphaned under the
		// old label, the view would read "none" and the renamed server would silently lose auth.
		const views = await declaredEventually(
			(v) => v.some((view) => view.label === "PanelIT-Renamed" && view.secrets.apiKey === "secure"),
			"the renamed entry to carry its secret"
		);
		assert.ok(!views.some((view) => view.label === "PanelIT"), "the old label must be replaced, not duplicated");

		assert.strictEqual(
			await inject(
				request("removeServerSetting", { label: "PanelIT-Renamed", baseUrl: "http://localhost:49999" }, "pi-remove-1")
			),
			"ok"
		);
		await declaredEventually((v) => v.length === 0, "the removed entry to sync away");
		const globalValue = vscode.workspace.getConfiguration(CONFIG).inspect("servers")?.globalValue;
		assert.ok(!JSON.stringify(globalValue ?? {}).includes("PanelIT"), "the settings entry must be gone");
	});

	test("saveServerSetting round-trips modelCapabilities and expectedFailures through the entry rebuild", async function () {
		this.timeout(30000);
		// The apply path rebuilds the whole entry from the intent, so a field missed anywhere in the chain is silently
		// DELETED on save; this pins the round trip for both new fields, across an edit-in-place rebuild.
		const capabilities = { "my-model": { context_length: 128000, supports_vision: true } };
		const saved = await inject(
			request(
				"saveServerSetting",
				{
					server: serverPayload({
						label: "PanelIT-Caps",
						baseUrl: "http://localhost:49999",
						modelCapabilities: capabilities,
						expectedFailures: ["modelListing"],
						includeModes: ["completion"],
					}),
					secrets: { apiKey: noTouch, oauthClientSecret: noTouch, virtualKeyValue: noTouch },
				},
				"pi-caps-1"
			)
		);
		assert.strictEqual(saved, "ok");

		const entryAfter = () => {
			const globalValue = vscode.workspace.getConfiguration(CONFIG).inspect("servers")?.globalValue;
			assert.ok(Array.isArray(globalValue), "the servers setting must hold an array");
			return globalValue.find((entry: unknown) => (entry as { label?: string }).label === "PanelIT-Caps") as Record<
				string,
				unknown
			>;
		};
		assert.deepStrictEqual(entryAfter().models, { capabilities });
		assert.deepStrictEqual(entryAfter().discovery, {
			expectedFailures: ["modelListing"],
			includeModes: ["completion"],
		});

		const edited = await inject(
			request(
				"saveServerSetting",
				{
					server: serverPayload({
						label: "PanelIT-Caps",
						baseUrl: "http://localhost:49999",
						modelCapabilities: capabilities,
						expectedFailures: ["modelListing", "modelInfo"],
					}),
					secrets: { apiKey: noTouch, oauthClientSecret: noTouch, virtualKeyValue: noTouch },
					replace: {
						label: "PanelIT-Caps",
						baseUrl: "http://localhost:49999",
						secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
					},
				},
				"pi-caps-2"
			)
		);
		assert.strictEqual(edited, "ok");
		assert.deepStrictEqual(entryAfter().models, { capabilities });
		assert.deepStrictEqual(
			entryAfter().discovery,
			{ expectedFailures: ["modelListing", "modelInfo"] },
			"an edit that no longer includes modes clears the list, like every always-sent field"
		);

		assert.strictEqual(
			await inject(
				request("removeServerSetting", { label: "PanelIT-Caps", baseUrl: "http://localhost:49999" }, "pi-caps-rm")
			),
			"ok"
		);
	});

	test("an executeCommand intent dispatches through the real vscode.commands bridge", async function () {
		this.timeout(20000);
		// openOutput is a real registered command with no network and no dialogs, and it stays dashboard-postable;
		// revealing the Output panel does steal focus in the shared host, the mildest side effect any postable command
		// has. What this proves is the bridge, not the command.
		assert.strictEqual(await inject(request("executeCommand", { command: "openOutput" })), "ok");
	});

	test("a syncModels intent runs the real command and answers only once it has settled", async function () {
		this.timeout(20000);
		// The whole reason this method exists apart from executeCommand: its answer is a completion signal, so the
		// outcome must not resolve until the real litellm.syncModels promise has.
		let settled = false;
		const outcome = inject(request("syncModels", null, "pi-sync-acked"));
		void Promise.resolve(outcome).then(() => {
			settled = true;
		});
		// Not answered synchronously: a handler that forgot to await would have resolved within this turn.
		await Promise.resolve();
		assert.strictEqual(settled, false, "syncModels answered before the command could have run");
		assert.strictEqual(await outcome, "ok");
	});

	test("testServerDraft runs the real probe read-only: an unreachable draft fails the intent and mutates nothing", async function () {
		this.timeout(20000);
		// Port 1 on loopback refuses immediately, so the real discovery path fails fast without leaving a half-open
		// socket for msw-guarded suites.
		const before = vscode.workspace.getConfiguration(CONFIG).inspect("servers")?.globalValue;
		const outcome = await inject(
			request(
				"testServerDraft",
				{
					server: serverPayload({ label: "PanelIT-Probe", baseUrl: "http://127.0.0.1:1" }),
					secrets: { apiKey: noTouch, oauthClientSecret: noTouch, virtualKeyValue: noTouch },
				},
				"pi-test-1"
			)
		);
		assert.strictEqual(outcome, "validation-error", "an unreachable draft must fail its own intent, not throw");
		const after = vscode.workspace.getConfiguration(CONFIG).inspect("servers")?.globalValue;
		assert.deepStrictEqual(after, before, "a probe must never touch the servers setting");
		assert.deepStrictEqual(await declared(), [], "a probe must never create a declared view");

		// And the schema boundary still refuses a directive-free draft: the envelope frame parsed, so the refusal
		// classifies as a refused intent (a correlated fail envelope answers the page) instead of a drop.
		assert.strictEqual(
			await inject(request("testServerDraft", { server: { label: "P", baseUrl: "http://x" } }, "pi-test-2")),
			"validation-error"
		);
	});

	test("adoptServer with no matching host group refuses as a stale row and saves nothing", async function () {
		this.timeout(20000);
		const outcome = await inject(
			request(
				"adoptServer",
				{
					label: "PanelIT-Adopted",
					baseUrl: "http://localhost:49999",
					sourceHandle: "no-such-handle",
					secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
				},
				"pi-adopt-1"
			)
		);
		assert.strictEqual(outcome, "validation-error");
		const globalValue = vscode.workspace.getConfiguration(CONFIG).inspect("servers")?.globalValue;
		assert.ok(!JSON.stringify(globalValue ?? {}).includes("PanelIT-Adopted"), "no entry may be saved");
	});

	test("litellm.manage resolves through the legacy path in the test-mode host with the quick pick cancelled", async function () {
		this.timeout(20000);
		const origQuickPick = vscode.window.showQuickPick;
		let opened = 0;
		(vscode.window as Record<string, unknown>).showQuickPick = async () => {
			opened += 1;
			return undefined;
		};
		try {
			// The REAL registered command, not a captured handler: this covers registerManageCommand's registration and
			// the test-mode arm of the activation-time mode selection.
			await vscode.commands.executeCommand("litellm.manage");
		} finally {
			(vscode.window as Record<string, unknown>).showQuickPick = origQuickPick;
		}
		assert.strictEqual(opened, 1, "the hub quick pick must open and a cancel must resolve cleanly");
	});
});
