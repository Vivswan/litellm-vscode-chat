import * as assert from "node:assert";
import * as vscode from "vscode";
import { ensureActivated } from "../../hostApiHelpers";

/**
 * Integration over the REAL dashboard wiring: unlike panel.test.ts (fake env
 * closures), these tests activate the extension and drive
 * litellm._test.dashboardMessage, whose handler opens the real panel first -
 * so createRealPanel, createNonce, buildDashboardHtml, and the real env
 * closures (workspace configuration, SecretStorage, the sync engine) all
 * execute. Assertions read real side effects: configuration inspection, the
 * sync engine's declared views, and the injection outcome class. The real
 * webview's posted messages are not observable here; the webview suite and
 * panel.test.ts cover that half.
 */
suite("extension/dashboard/panelIntegration", () => {
	const CONFIG = "litellm-vscode-chat";
	/** Settings this suite writes; each teardown returns them to unset. */
	const TOUCHED_KEYS = ["defaultMaxOutputTokens", "servers"] as const;

	type Outcome = "ok" | "validation-error" | "ignored-malformed";

	function inject(raw: unknown): Thenable<Outcome> {
		return vscode.commands.executeCommand<Outcome>("litellm._test.dashboardMessage", raw);
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
	});

	suiteTeardown(async function () {
		this.timeout(20000);
		// Dispose the real dashboard panel the injection command opened; a
		// webview surviving the suite would keep receiving state pushes from
		// later suites' configuration churn.
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
	});

	teardown(async function () {
		this.timeout(20000);
		// Remove leftover entries through the dashboard's own removal intent,
		// not a raw settings write: removeServerSetting also deletes the
		// entry's SecretStorage blob, so a bare config.update would strand
		// secure blobs in the shared test host. What this cannot undo is the
		// host-side provider group a sync pass may have upserted (VS Code has
		// no group-removal API); that pollution is bounded to this label's
		// disposable user-data-dir, which is why these tests stay in the unit
		// label instead of paying a whole extra host launch for isolation.
		// LANDMINE for future msw-based suites in this label: that leftover
		// group can make the host refresh our provider against its baseUrl at
		// any later point, and msw's onUnhandledRequest:"error" would flag the
		// stray request. Keep such suites' handlers tolerant of
		// localhost:49999 or move them ahead of this file.
		for (const view of await declared()) {
			await inject({ type: "removeServerSetting", label: view.label, requestId: `pi-teardown-${view.label}` });
		}
		const config = vscode.workspace.getConfiguration(CONFIG);
		for (const key of TOUCHED_KEYS) {
			if (config.inspect(key)?.globalValue !== undefined) {
				await config.update(key, undefined, vscode.ConfigurationTarget.Global);
			}
		}
		// Let the servers-setting change listener finish its sync pass so no
		// stray traffic leaks into later suites (msw runs onUnhandledRequest:
		// "error").
		await declaredEventually((views) => views.length === 0, "the servers setting to sync away");
	});

	test("litellm._test.dashboardMessage opens the real dashboard panel and a ready message classifies ok", async function () {
		this.timeout(20000);
		// The command opens the panel through the real litellm.openDashboard
		// path, so createRealPanel, createNonce, and buildDashboardHtml all
		// execute against the real extension URI - a construction-time throw
		// (bad Uri.joinPath, a template error) fails here. What this cannot
		// see is the page actually loading: a wrong bundle filename or CSP
		// still ships a blank webview (the packaged-file-list check and its
		// bundle floor cover the filename; rendering stays manual F5).
		assert.strictEqual(await inject({ type: "ready" }), "ok");
		// And the schema boundary still rejects junk after the panel exists.
		assert.strictEqual(await inject({ type: "no-such-intent" }), "ignored-malformed");
	});

	test("a setNumberSetting intent lands in real user settings via the resolved update scope", async () => {
		assert.strictEqual(
			await inject({ type: "setNumberSetting", setting: "defaultMaxOutputTokens", value: 4242 }),
			"ok"
		);
		const inspected = vscode.workspace.getConfiguration(CONFIG).inspect<number>("defaultMaxOutputTokens");
		assert.strictEqual(
			inspected?.globalValue,
			4242,
			"the write must land in the user scope, not vanish or shadow-write"
		);
	});

	test("a resetSetting intent removes the configured value with the global fallback", async () => {
		assert.strictEqual(
			await inject({ type: "setNumberSetting", setting: "defaultMaxOutputTokens", value: 4242 }),
			"ok"
		);
		assert.strictEqual(await inject({ type: "resetSetting", setting: "defaultMaxOutputTokens" }), "ok");
		const inspected = vscode.workspace.getConfiguration(CONFIG).inspect<number>("defaultMaxOutputTokens");
		assert.strictEqual(inspected?.globalValue, undefined, "the dashboard claimed a reset; the value must be gone");
	});

	test("saveServerSetting with a secure-location apiKey keeps the secret out of the settings value", async function () {
		this.timeout(20000);
		const outcome = await inject({
			type: "saveServerSetting",
			server: { label: "PanelIT", baseUrl: "http://localhost:49999" },
			secrets: {
				apiKey: { action: "set", location: "secure", value: "sk-panel-integration-secret" },
				oauthClientSecret: noTouch,
				virtualKeyValue: noTouch,
			},
			requestId: "pi-save-1",
		});
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
		await inject({
			type: "saveServerSetting",
			server: { label: "PanelIT", baseUrl: "http://localhost:49999" },
			secrets: {
				apiKey: { action: "set", location: "secure", value: "sk-carry-me" },
				oauthClientSecret: noTouch,
				virtualKeyValue: noTouch,
			},
			requestId: "pi-save-2",
		});
		const renamed = await inject({
			type: "saveServerSetting",
			server: { label: "PanelIT-Renamed", baseUrl: "http://localhost:49999" },
			secrets: { apiKey: noTouch, oauthClientSecret: noTouch, virtualKeyValue: noTouch },
			replaceLabel: "PanelIT",
			requestId: "pi-rename-1",
		});
		assert.strictEqual(renamed, "ok");

		// The location under the NEW label proves copyServerSecrets ran: had the
		// blob been orphaned under the old label, the view would read "none" and
		// the renamed server would silently lose auth.
		const views = await declaredEventually(
			(v) => v.some((view) => view.label === "PanelIT-Renamed" && view.secrets.apiKey === "secure"),
			"the renamed entry to carry its secret"
		);
		assert.ok(!views.some((view) => view.label === "PanelIT"), "the old label must be replaced, not duplicated");

		assert.strictEqual(
			await inject({ type: "removeServerSetting", label: "PanelIT-Renamed", requestId: "pi-remove-1" }),
			"ok"
		);
		await declaredEventually((v) => v.length === 0, "the removed entry to sync away");
		const globalValue = vscode.workspace.getConfiguration(CONFIG).inspect("servers")?.globalValue;
		assert.ok(!JSON.stringify(globalValue ?? {}).includes("PanelIT"), "the settings entry must be gone");
	});

	test("an executeCommand intent dispatches through the real vscode.commands bridge", async function () {
		this.timeout(20000);
		// syncModels is a real registered command; with nothing declared it
		// completes without network. A dead bridge would classify as a failure.
		assert.strictEqual(await inject({ type: "executeCommand", command: "syncModels" }), "ok");
	});

	test("adoptServer with no matching host group still saves the entry instead of failing the intent", async function () {
		this.timeout(20000);
		const outcome = await inject({
			type: "adoptServer",
			label: "PanelIT-Adopted",
			baseUrl: "http://localhost:49999",
			sourceHandle: "no-such-handle",
			secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
			requestId: "pi-adopt-1",
		});
		// Degrading instead of throwing is the contract: adoption must stay
		// usable exactly when the group vanished. The caveat message rides the
		// unobservable webview ack; what this can prove is the outcome class
		// and the saved entry.
		assert.strictEqual(outcome, "ok");
		const globalValue = vscode.workspace.getConfiguration(CONFIG).inspect("servers")?.globalValue;
		assert.ok(JSON.stringify(globalValue ?? {}).includes("PanelIT-Adopted"), "the adopted entry must be saved");
		// Clean up through the same real path.
		assert.strictEqual(
			await inject({ type: "removeServerSetting", label: "PanelIT-Adopted", requestId: "pi-adopt-rm" }),
			"ok"
		);
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
			// The REAL registered command, not a captured handler: this covers
			// registerManageCommand's registration and the test-mode arm of the
			// activation-time mode selection.
			await vscode.commands.executeCommand("litellm.manage");
		} finally {
			(vscode.window as Record<string, unknown>).showQuickPick = origQuickPick;
		}
		assert.strictEqual(opened, 1, "the hub quick pick must open and a cancel must resolve cleanly");
	});
});
