import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DashboardControllerEnv, DashboardPanel } from "../../../extension/dashboard/panel";
import { DashboardController } from "../../../extension/dashboard/panel";
import type { ExtensionToWebviewMessage } from "../../../extension/dashboard/protocol";
import type { SettingsReader } from "../../../extension/dashboard/state";
import { makeModelInfo, makeServerStatus } from "../../testUtils";

interface FakePanel {
	panel: DashboardPanel;
	posted: unknown[];
	receiveMessage(message: unknown): void;
	setVisible(visible: boolean): void;
	triggerDispose(): void;
	disposed: boolean;
}

function makeFakePanel(): FakePanel {
	const posted: unknown[] = [];
	const messageEmitter = new vscode.EventEmitter<unknown>();
	const disposeEmitter = new vscode.EventEmitter<void>();
	const viewStateEmitter = new vscode.EventEmitter<unknown>();
	let visible = true;
	const fake: FakePanel = {
		posted,
		disposed: false,
		receiveMessage: (message) => messageEmitter.fire(message),
		setVisible: (next) => {
			visible = next;
			viewStateEmitter.fire({});
		},
		triggerDispose: () => disposeEmitter.fire(),
		panel: {
			webview: {
				html: "",
				postMessage: (message: unknown) => {
					posted.push(message);
					return Promise.resolve(true);
				},
				onDidReceiveMessage: messageEmitter.event,
			},
			get visible() {
				return visible;
			},
			reveal: () => {},
			onDidDispose: disposeEmitter.event,
			onDidChangeViewState: viewStateEmitter.event,
			dispose: () => {
				fake.disposed = true;
				disposeEmitter.fire();
			},
		},
	};
	return fake;
}

interface Harness {
	controller: DashboardController;
	panels: FakePanel[];
	updates: [string, unknown][];
	commands: [string, ...unknown[]][];
	serverWrites: unknown[][];
	secretOps: [string, string, string | undefined][];
	loggedErrors: unknown[];
	loggedMessages: [string, unknown][];
	settingsValues: Record<string, unknown>;
	serversSetting: unknown[];
	/** When set, every updateSetting call rejects with this error. */
	failUpdates?: Error;
	/** When set, storeServerSecret rejects with this error on deletes (value === undefined). */
	failUnstore?: Error;
}

function makeHarness(): Harness {
	const panels: FakePanel[] = [];
	const updates: [string, unknown][] = [];
	const commands: [string, ...unknown[]][] = [];
	const serverWrites: unknown[][] = [];
	const secretOps: [string, string, string | undefined][] = [];
	const loggedErrors: unknown[] = [];
	const loggedMessages: [string, unknown][] = [];
	const settingsValues: Record<string, unknown> = {};
	const reader: SettingsReader = {
		get: (key) => settingsValues[key],
		inspect: (key) => (Object.hasOwn(settingsValues, key) ? { globalValue: settingsValues[key] } : undefined),
	};
	const env: DashboardControllerEnv = {
		createPanel: () => {
			const fake = makeFakePanel();
			panels.push(fake);
			return fake.panel;
		},
		getSnapshots: () => [{ status: makeServerStatus(), models: [makeModelInfo({ id: "m1", name: "m1" })] }],
		getDeclaredServers: () => [],
		settingsReader: () => reader,
		updateSetting: async (key, value) => {
			if (harness.failUpdates !== undefined) {
				throw harness.failUpdates;
			}
			updates.push([key, value]);
		},
		readServersSetting: () => harness.serversSetting,
		writeServersSetting: async (value) => {
			if (harness.failUpdates !== undefined) {
				throw harness.failUpdates;
			}
			// Simulate the real store plus latency: a concurrent second intent
			// that read before this write would lose the update.
			await new Promise((resolve) => setTimeout(resolve, 0));
			harness.serversSetting = [...value];
			serverWrites.push([...value]);
		},
		storeServerSecret: async (label, field, value) => {
			if (value === undefined && harness.failUnstore !== undefined) {
				throw harness.failUnstore;
			}
			secretOps.push([label, field, value]);
		},
		readServerSecrets: async () => ({}),
		copyServerSecrets: async () => {},
		deleteServerSecrets: async () => {},
		requestServerSync: () => {},
		resolveAdoptionCredentials: () => undefined,
		executeCommand: async (command, ...args) => {
			commands.push([command, ...args]);
		},
		log: (message, data) => {
			loggedMessages.push([message, data]);
		},
		logError: (_message, error) => {
			loggedErrors.push(error);
		},
	};
	const harness: Harness = {
		controller: new DashboardController(env),
		panels,
		updates,
		commands,
		serverWrites,
		secretOps,
		loggedErrors,
		loggedMessages,
		settingsValues,
		serversSetting: [],
	};
	return harness;
}

function lastState(fake: FakePanel): Extract<ExtensionToWebviewMessage, { type: "state" }> {
	const message = fake.posted.at(-1) as ExtensionToWebviewMessage | undefined;
	assert.ok(message !== undefined, "no state was pushed");
	assert.ok(message.type === "state", `expected a state push, got ${message.type}`);
	return message;
}

/** Let the async message handler chain settle. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

suite("extension/dashboard/panel", () => {
	test("open creates one panel and pushes the state built from the stores", () => {
		const harness = makeHarness();
		harness.controller.open();

		assert.strictEqual(harness.panels.length, 1);
		const fake = harness.panels[0];
		assert.ok(fake);
		const state = lastState(fake).state;
		assert.strictEqual(state.servers[0]?.label, "Prod");
		assert.strictEqual(state.models[0]?.id, "m1");
	});

	test("a second open reveals the existing panel instead of creating another", () => {
		const harness = makeHarness();
		harness.controller.open();
		harness.controller.open();

		assert.strictEqual(harness.panels.length, 1);
	});

	test("the ready handshake triggers a state push", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);
		const before = fake.posted.length;

		fake.receiveMessage({ type: "ready" });
		await settle();

		assert.strictEqual(fake.posted.length, before + 1);
	});

	test("a setting intent reaches updateSetting; malformed messages are ignored without effects", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage({ type: "setNumberSetting", setting: "requestTimeout", value: 60000 });
		fake.receiveMessage({ type: "setNumberSetting", setting: "requestTimeout", value: "60000" });
		fake.receiveMessage({ type: "definitely-not-a-message" });
		await settle();

		assert.deepStrictEqual(harness.updates, [["requestTimeout", 60000]]);
		assert.deepStrictEqual(harness.loggedErrors, [], "malformed messages are ignored, not errors");
	});

	test("a command intent reaches executeCommand", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage({ type: "executeCommand", command: "syncModels" });
		await settle();

		assert.deepStrictEqual(harness.commands, [["litellm.syncModels"]]);
	});

	test("a failing intent is reported back to the webview as a retryable failure, with our validation text", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage({ type: "setNumberSetting", setting: "requestTimeout", value: 1 });
		await settle();

		assert.deepStrictEqual(harness.updates, []);
		assert.ok(
			harness.loggedMessages.some(([message]) => message === "Dashboard intent rejected"),
			"validation failures log as rejections"
		);
		const notice = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.strictEqual(notice.type, "intentFailed");
		assert.ok(notice.type === "intentFailed" && notice.intentType === "setNumberSetting");
		assert.ok(notice.type === "intentFailed" && notice.message.includes("at least"));
		assert.ok(notice.type === "intentFailed" && notice.kind === "validation", "a refused intent is validation-kind");
	});

	test("a validation failure's message reaches the webview but never the log", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);
		// A secret pasted into a header-name field: the validation message quotes
		// the name, so the message must stay out of the log.
		const pastedSecret = "sk-pasted into the wrong field";

		fake.receiveMessage({ type: "setHeaders", value: { [pastedSecret]: "v" } });
		await settle();

		const notice = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.ok(notice.type === "intentFailed" && notice.message.includes(pastedSecret), "the webview names the field");
		const logged = JSON.stringify(harness.loggedMessages);
		assert.ok(!logged.includes(pastedSecret), "the pasted value must not reach the log");
		assert.ok(!logged.includes("header name"), "the validation message itself must not reach the log");
		assert.ok(logged.includes('"kind":"validation"'), "the log carries a classification only");
	});

	test("a rejected settings write is classified: the raw error text reaches neither the webview nor the log", async () => {
		const harness = makeHarness();
		harness.failUpdates = new Error("write denied: /home/user/.config/secret-path");
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage({ type: "setHeaders", value: { "x-key": "v" } });
		await settle();

		const notice = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.ok(notice.type === "intentFailed" && notice.intentType === "setHeaders");
		assert.ok(notice.type === "intentFailed" && !notice.message.includes("write denied"));
		assert.ok(notice.type === "intentFailed" && notice.message.length > 0);
		assert.ok(notice.type === "intentFailed" && notice.kind === "validation", "an unapplied write is validation-kind");
		const observable = JSON.stringify({ posted: fake.posted, logged: harness.loggedMessages });
		assert.ok(!observable.includes("write denied"), "the raw message must not reach observable surfaces");
		assert.ok(observable.includes('"error":"Error"'), "the log carries the error name only");
	});

	test("refresh pushes to a visible panel and skips a hidden one", () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);
		const before = fake.posted.length;

		harness.controller.refresh();
		assert.strictEqual(fake.posted.length, before + 1);

		fake.setVisible(false);
		const hiddenCount = fake.posted.length;
		harness.controller.refresh();
		assert.strictEqual(fake.posted.length, hiddenCount, "hidden panels get no pushes");
	});

	test("becoming visible again pushes fresh state", () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);
		fake.setVisible(false);
		const before = fake.posted.length;

		fake.setVisible(true);

		assert.strictEqual(fake.posted.length, before + 1);
	});

	test("refresh without a panel is a no-op", () => {
		const harness = makeHarness();
		harness.controller.refresh();

		assert.strictEqual(harness.panels.length, 0);
	});

	test("after the panel is disposed, open creates a fresh one", () => {
		const harness = makeHarness();
		harness.controller.open();
		const first = harness.panels[0];
		assert.ok(first);

		first.triggerDispose();
		harness.controller.open();

		assert.strictEqual(harness.panels.length, 2);
	});

	test("disposing the controller disposes the panel", () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		harness.controller.dispose();

		assert.strictEqual(fake.disposed, true);
	});

	test("a successful server intent posts its intentSucceeded ack and a state push", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage({
			type: "saveServerSetting",
			server: { label: "Prod", baseUrl: "http://prod.test" },
			secrets: {
				apiKey: { action: "set", location: "secure", value: "sk-secret-value" },
				oauthClientSecret: { action: "keep" },
				virtualKeyValue: { action: "keep" },
			},
			requestId: "req-42",
		});
		await settle();
		await settle();

		assert.deepStrictEqual(harness.serverWrites, [[{ label: "Prod", baseUrl: "http://prod.test" }]]);
		assert.deepStrictEqual(harness.secretOps, [["Prod", "apiKey", "sk-secret-value"]]);
		const messages = fake.posted as ExtensionToWebviewMessage[];
		const ackIndex = messages.findIndex((m) => m.type === "intentSucceeded");
		assert.ok(ackIndex >= 0, "the ack was posted");
		const ack = messages[ackIndex];
		assert.ok(ack?.type === "intentSucceeded" && ack.requestId === "req-42");
		assert.ok(
			messages.slice(ackIndex + 1).some((m) => m.type === "state"),
			"a state push follows the ack"
		);
	});

	test("an adoption without resolvable credentials acks success with the caveat message", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage({
			type: "adoptServer",
			label: "Adopted",
			baseUrl: "http://ext.test",
			sourceHandle: "handle-ext",
			secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
			requestId: "req-adopt",
		});
		await settle();
		await settle();

		assert.deepStrictEqual(harness.serverWrites, [[{ label: "Adopted", baseUrl: "http://ext.test" }]]);
		const messages = fake.posted as ExtensionToWebviewMessage[];
		const ack = messages.find((m) => m.type === "intentSucceeded");
		assert.ok(ack !== undefined && ack.type === "intentSucceeded" && ack.requestId === "req-adopt");
		assert.ok(
			typeof ack.message === "string" && /could not be read/.test(ack.message),
			"the caveat travels on the ack"
		);
	});

	test("a dormant cleanup failure after the settings write committed still acks success", async () => {
		const harness = makeHarness();
		harness.serversSetting = [{ label: "Prod", baseUrl: "http://prod.test" }];
		harness.failUnstore = new Error("keychain locked");
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		// An inline write leaves at most a dormant secure copy behind, so its
		// failed cleanup must not fail the intent.
		fake.receiveMessage({
			type: "saveServerSetting",
			server: { label: "Prod", baseUrl: "http://prod.test" },
			secrets: {
				apiKey: { action: "set", location: "settings", value: "sk-inline" },
				oauthClientSecret: { action: "keep" },
				virtualKeyValue: { action: "keep" },
			},
			replaceLabel: "Prod",
			requestId: "req-cleanup",
		});
		await settle();
		await settle();

		assert.deepStrictEqual(harness.serverWrites, [
			[{ label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-inline" }],
		]);
		const messages = fake.posted as ExtensionToWebviewMessage[];
		const ack = messages.find((m) => m.type === "intentSucceeded");
		assert.ok(ack !== undefined && ack.type === "intentSucceeded" && ack.requestId === "req-cleanup");
		assert.ok(!messages.some((m) => m.type === "intentFailed"), "the committed write must not report failure");
	});

	test("a failed clear reports the partial failure to the webview, with a classification-only log", async () => {
		const harness = makeHarness();
		harness.serversSetting = [{ label: "Prod", baseUrl: "http://prod.test" }];
		harness.failUnstore = new Error("keychain locked: /Users/someone/Library");
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage({
			type: "saveServerSetting",
			server: { label: "Prod", baseUrl: "http://prod.test" },
			secrets: {
				apiKey: { action: "clear" },
				oauthClientSecret: { action: "keep" },
				virtualKeyValue: { action: "keep" },
			},
			replaceLabel: "Prod",
			requestId: "req-clear",
		});
		await settle();
		await settle();

		assert.deepStrictEqual(harness.serverWrites, [[{ label: "Prod", baseUrl: "http://prod.test" }]]);
		const notice = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.ok(notice.type === "intentFailed" && notice.intentType === "saveServerSetting");
		assert.ok(notice.type === "intentFailed" && notice.requestId === "req-clear");
		assert.ok(
			notice.type === "intentFailed" && notice.kind === "operation",
			"a committed save reports an operation-kind failure so the webview treats the entry as saved"
		);
		assert.ok(
			notice.type === "intentFailed" && notice.message.includes("Set Server Secret"),
			"the message names the recovery path"
		);
		const logged = JSON.stringify(harness.loggedMessages);
		assert.ok(!logged.includes("keychain locked"), "the raw error stays out of the log");
		assert.ok(logged.includes('"kind":"operation"'), "the log carries a classification only");
	});

	test("a failed write whose rollback also fails reports operation-kind, never a clean validation failure", async () => {
		const harness = makeHarness();
		harness.serversSetting = [{ label: "Prod", baseUrl: "http://prod.test" }];
		harness.failUpdates = new Error("write denied: /home/user/.config/secret-path");
		harness.failUnstore = new Error("keychain locked");
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		// The set-secure write lands, the settings write fails, and the rollback
		// delete fails too: the new secret is durably stored and active, so the
		// webview must not reopen the form as if nothing landed.
		fake.receiveMessage({
			type: "saveServerSetting",
			server: { label: "Prod", baseUrl: "http://prod.test" },
			secrets: {
				apiKey: { action: "set", location: "secure", value: "sk-new" },
				oauthClientSecret: { action: "keep" },
				virtualKeyValue: { action: "keep" },
			},
			replaceLabel: "Prod",
			requestId: "req-rollback",
		});
		await settle();
		await settle();

		const notice = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.ok(notice.type === "intentFailed" && notice.intentType === "saveServerSetting");
		assert.ok(notice.type === "intentFailed" && notice.requestId === "req-rollback");
		assert.ok(notice.type === "intentFailed" && notice.kind === "operation", "durable state changed");
		assert.ok(notice.type === "intentFailed" && notice.message.includes("Set Server Secret"));
		const observable = JSON.stringify({ posted: fake.posted, logged: harness.loggedMessages });
		assert.ok(
			!observable.includes("write denied") && !observable.includes("keychain locked"),
			"raw errors stay off observable surfaces"
		);
		assert.ok(!observable.includes("sk-new"), "the secret value never surfaces");
		assert.ok(JSON.stringify(harness.loggedMessages).includes('"kind":"operation"'));
	});

	test("a failed server intent echoes its requestId in the failure notice", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage({ type: "removeServerSetting", label: "Missing", requestId: "req-7" });
		await settle();

		const notice = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.ok(notice.type === "intentFailed" && notice.intentType === "removeServerSetting");
		assert.ok(notice.type === "intentFailed" && notice.requestId === "req-7");
	});

	test("mutating intents are serialized: two rapid saves never lose an update", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);
		const keepAll = {
			apiKey: { action: "keep" },
			oauthClientSecret: { action: "keep" },
			virtualKeyValue: { action: "keep" },
		};

		fake.receiveMessage({
			type: "saveServerSetting",
			server: { label: "A", baseUrl: "http://a.test" },
			secrets: keepAll,
			requestId: "req-a",
		});
		fake.receiveMessage({
			type: "saveServerSetting",
			server: { label: "B", baseUrl: "http://b.test" },
			secrets: keepAll,
			requestId: "req-b",
		});
		await settle();
		await settle();
		await settle();

		assert.deepStrictEqual(harness.serversSetting, [
			{ label: "A", baseUrl: "http://a.test" },
			{ label: "B", baseUrl: "http://b.test" },
		]);
	});

	test("secret values never appear in logs, failure notices, or state pushes", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);
		const secret = "sk-super-secret-value";

		// A save that succeeds and one that fails validation, both carrying the secret.
		fake.receiveMessage({
			type: "saveServerSetting",
			server: { label: "Prod", baseUrl: "http://prod.test" },
			secrets: {
				apiKey: { action: "set", location: "secure", value: secret },
				oauthClientSecret: { action: "keep" },
				virtualKeyValue: { action: "keep" },
			},
			requestId: "req-1",
		});
		fake.receiveMessage({
			type: "saveServerSetting",
			server: { label: "Prod", baseUrl: "not a url" },
			secrets: {
				apiKey: { action: "set", location: "secure", value: secret },
				oauthClientSecret: { action: "keep" },
				virtualKeyValue: { action: "keep" },
			},
			requestId: "req-2",
		});
		await settle();
		await settle();

		assert.ok(
			(fake.posted as ExtensionToWebviewMessage[]).some((m) => m.type === "intentFailed"),
			"the invalid save fails"
		);
		const observable = JSON.stringify({
			posted: fake.posted,
			logged: harness.loggedMessages,
			errors: harness.loggedErrors.map((error) => (error instanceof Error ? error.message : String(error))),
		});
		assert.ok(!observable.includes(secret), "the secret leaked into an observable surface");
		assert.deepStrictEqual(harness.secretOps.at(0), ["Prod", "apiKey", secret], "the secret store is the one sink");
	});
});
