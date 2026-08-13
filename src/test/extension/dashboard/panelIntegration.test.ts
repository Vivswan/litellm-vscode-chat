import * as assert from "node:assert";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { DASHBOARD_ENDPOINTS } from "../../../dashboard/endpoints";
import {
	DASHBOARD_BUNDLE_FILENAME,
	DASHBOARD_STYLESHEET_FILENAME,
	WEBVIEW_DIST_SEGMENTS,
} from "../../../shared/webviewPaths";
import { catalogOff, ensureActivated } from "../../hostApiHelpers";
import { serverPayload } from "./recordedEnv";

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
	const TOUCHED_KEYS = ["usage.pollInterval", "servers"] as const;

	type Outcome = "ok" | "validation-error" | "ignored-malformed";

	function inject(raw: unknown): Thenable<Outcome> {
		return vscode.commands.executeCommand<Outcome>("litellm._test.dashboardMessage", raw);
	}

	/** One request envelope as the webview would post it. */
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
		// Stray host-triggered refreshes of that leftover group are absorbed
		// by the baseline localhost:49999 handler in mocks/handlers.ts.
		for (const view of await declared()) {
			await inject(request("removeServerSetting", { label: view.label }, `pi-teardown-${view.label}`));
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
		assert.strictEqual(await inject(request("ready", null)), "ok");
		// And the schema boundary still rejects junk after the panel exists.
		assert.strictEqual(await inject({ type: "no-such-intent" }), "ignored-malformed");
	});

	test("the bundled stylesheet exists beside the bundle at the exact path createRealPanel resolves", () => {
		// The webview suite renders source .tsx and never loads the bundled
		// output, so a bundler regression that stops emitting the stylesheet
		// would ship an unstyled dashboard with every test green. This stats
		// the css through the same constants panel.ts joins into asWebviewUri,
		// beside the bundle the suite's own build step already produced.
		const extension = vscode.extensions.getExtension("vivswan.litellm-vscode-chat");
		assert.ok(extension, "the extension under test must be present");
		const distDir = vscode.Uri.joinPath(extension.extensionUri, ...WEBVIEW_DIST_SEGMENTS);
		assert.ok(fs.existsSync(vscode.Uri.joinPath(distDir, DASHBOARD_BUNDLE_FILENAME).fsPath));

		const stylesheetPath = vscode.Uri.joinPath(distDir, DASHBOARD_STYLESHEET_FILENAME).fsPath;
		assert.ok(
			fs.existsSync(stylesheetPath),
			`the bundle script must emit ${stylesheetPath} beside the dashboard bundle`
		);
		const css = fs.readFileSync(stylesheetPath, "utf8");
		// The dev emit this suite sees weighs ~47,961 bytes (~39,995 minified),
		// so 30000 fails a truncated emit, not just an empty one.
		assert.ok(css.length > 30000, `the stylesheet weighs ${css.length} bytes; the real dashboard styles are missing`);
		assert.ok(css.includes("var(--vscode-foreground)"), "the stylesheet must read the host's theme tokens");
		assert.ok(css.includes("var(--vscode-button-background)"), "the stylesheet must read the host's theme tokens");
	});

	test("every endpoint table method's schema survives bundling and classifies its request", async function () {
		this.timeout(20000);
		// Runs against the bundled dist/extension.js this suite's build step
		// produced: a bare-number payload fails every payload schema (each is
		// z.null() or a strict object), so every probe must come back with its
		// method's exact refusal class without reaching a handler - notifying
		// methods answer validation-error, reads ignored-malformed. A method
		// whose schema or table row went missing from the bundle throws or
		// lands in the wrong class, failing by method name; a future schema
		// that accepts the probe surfaces as "ok" and fails too instead of
		// silently running a handler.
		for (const [method, endpoint] of Object.entries(DASHBOARD_ENDPOINTS)) {
			const outcome = await inject(request(method, 12345, `pi-survival-${method}`));
			const expected = endpoint.outcome === "read" ? "ignored-malformed" : "validation-error";
			assert.strictEqual(outcome, expected, `method ${method} must classify the probe payload`);
		}
	});

	test("a setNumberSetting intent lands in real user settings via the resolved update scope", async () => {
		assert.strictEqual(await inject(request("setNumberSetting", { setting: "usage.pollInterval", value: 4242 })), "ok");
		const inspected = vscode.workspace.getConfiguration(CONFIG).inspect<number>("usage.pollInterval");
		assert.strictEqual(
			inspected?.globalValue,
			4242,
			"the write must land in the user scope, not vanish or shadow-write"
		);
	});

	test("a resetSetting intent removes the configured value with the global fallback", async () => {
		assert.strictEqual(await inject(request("setNumberSetting", { setting: "usage.pollInterval", value: 4242 })), "ok");
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
					replaceLabel: "PanelIT",
				},
				"pi-rename-1"
			)
		);
		assert.strictEqual(renamed, "ok");

		// The location under the NEW label proves copyServerSecrets ran: had the
		// blob been orphaned under the old label, the view would read "none" and
		// the renamed server would silently lose auth.
		const views = await declaredEventually(
			(v) => v.some((view) => view.label === "PanelIT-Renamed" && view.secrets.apiKey === "secure"),
			"the renamed entry to carry its secret"
		);
		assert.ok(!views.some((view) => view.label === "PanelIT"), "the old label must be replaced, not duplicated");

		assert.strictEqual(await inject(request("removeServerSetting", { label: "PanelIT-Renamed" }, "pi-remove-1")), "ok");
		await declaredEventually((v) => v.length === 0, "the removed entry to sync away");
		const globalValue = vscode.workspace.getConfiguration(CONFIG).inspect("servers")?.globalValue;
		assert.ok(!JSON.stringify(globalValue ?? {}).includes("PanelIT"), "the settings entry must be gone");
	});

	test("saveServerSetting round-trips modelCapabilities and expectedFailures through the entry rebuild", async function () {
		this.timeout(30000);
		// The apply path rebuilds the whole entry from the intent, so a field
		// missed anywhere in the chain is silently DELETED on save; this pins
		// the round trip for both new fields, across an edit-in-place rebuild.
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
		assert.deepStrictEqual(entryAfter().discovery, { expectedFailures: ["modelListing"] });

		// The edit-in-place rebuild: the same fields posted again must survive
		// the whole intent -> schema -> saveServer chain, not silently vanish.
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
					replaceLabel: "PanelIT-Caps",
				},
				"pi-caps-2"
			)
		);
		assert.strictEqual(edited, "ok");
		assert.deepStrictEqual(entryAfter().models, { capabilities });
		assert.deepStrictEqual(entryAfter().discovery, { expectedFailures: ["modelListing", "modelInfo"] });

		assert.strictEqual(await inject(request("removeServerSetting", { label: "PanelIT-Caps" }, "pi-caps-rm")), "ok");
	});

	test("an executeCommand intent dispatches through the real vscode.commands bridge", async function () {
		this.timeout(20000);
		// syncModels is a real registered command; with nothing declared it
		// completes without network. A dead bridge would classify as a failure.
		assert.strictEqual(await inject(request("executeCommand", { command: "syncModels" })), "ok");
	});

	test("a syncModels intent runs the real command and answers only once it has settled", async function () {
		this.timeout(20000);
		// The whole reason this method exists apart from executeCommand: its
		// answer is a completion signal, so the outcome must not resolve until
		// the command's own promise has. Same real registered command and the
		// same bridge as the test above - what is pinned here is the awaiting.
		let settled = false;
		const outcome = inject(request("syncModels", null, "pi-sync-acked"));
		void Promise.resolve(outcome).then(() => {
			settled = true;
		});
		// Not answered synchronously: a handler that forgot to await would have
		// resolved within this turn.
		await Promise.resolve();
		assert.strictEqual(settled, false, "syncModels answered before the command could have run");
		assert.strictEqual(await outcome, "ok");
	});

	test("testServerDraft runs the real probe read-only: an unreachable draft fails the intent and mutates nothing", async function () {
		this.timeout(20000);
		// Port 1 on loopback refuses immediately, so the real discovery path
		// (throwaway ChatClient, real fetch) fails fast without leaving a
		// half-open socket for msw-guarded suites to trip on. What this proves
		// is the env wiring end to end: schema, keep-resolution against the real
		// stores, the probe, and the outcome class - with zero writes.
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

		// And the schema boundary still refuses a directive-free draft: the
		// envelope frame parsed, so the refusal classifies as a refused intent
		// (a correlated fail envelope answers the page) instead of a drop.
		assert.strictEqual(
			await inject(request("testServerDraft", { server: { label: "P", baseUrl: "http://x" } }, "pi-test-2")),
			"validation-error"
		);
	});

	test("adoptServer with no matching host group still saves the entry instead of failing the intent", async function () {
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
		// Degrading instead of throwing is the contract: adoption must stay
		// usable exactly when the group vanished. The caveat message rides the
		// unobservable webview ack; what this can prove is the outcome class
		// and the saved entry.
		assert.strictEqual(outcome, "ok");
		const globalValue = vscode.workspace.getConfiguration(CONFIG).inspect("servers")?.globalValue;
		assert.ok(JSON.stringify(globalValue ?? {}).includes("PanelIT-Adopted"), "the adopted entry must be saved");
		// Clean up through the same real path.
		assert.strictEqual(await inject(request("removeServerSetting", { label: "PanelIT-Adopted" }, "pi-adopt-rm")), "ok");
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
