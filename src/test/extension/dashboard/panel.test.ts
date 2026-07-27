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
	loggedErrors: unknown[];
	settingsValues: Record<string, unknown>;
	/** When set, every updateSetting call rejects with this error. */
	failUpdates?: Error;
}

function makeHarness(): Harness {
	const panels: FakePanel[] = [];
	const updates: [string, unknown][] = [];
	const commands: [string, ...unknown[]][] = [];
	const loggedErrors: unknown[] = [];
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
		settingsReader: () => reader,
		updateSetting: async (key, value) => {
			if (harness.failUpdates !== undefined) {
				throw harness.failUpdates;
			}
			updates.push([key, value]);
		},
		executeCommand: async (command, ...args) => {
			commands.push([command, ...args]);
		},
		log: () => {},
		logError: (_message, error) => {
			loggedErrors.push(error);
		},
	};
	const harness: Harness = {
		controller: new DashboardController(env),
		panels,
		updates,
		commands,
		loggedErrors,
		settingsValues,
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

	test("a failing intent is logged and reported back to the webview as a retryable failure", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage({ type: "setNumberSetting", setting: "requestTimeout", value: 1 });
		await settle();

		assert.deepStrictEqual(harness.updates, []);
		assert.strictEqual(harness.loggedErrors.length, 1);
		const notice = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.strictEqual(notice.type, "intentFailed");
		assert.ok(notice.type === "intentFailed" && notice.intentType === "setNumberSetting");
		assert.ok(notice.type === "intentFailed" && notice.message.length > 0);
	});

	test("a rejected settings write is reported back to the webview", async () => {
		const harness = makeHarness();
		harness.failUpdates = new Error("write denied");
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage({ type: "setHeaders", value: { "x-key": "v" } });
		await settle();

		assert.strictEqual(harness.loggedErrors.length, 1);
		const notice = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.ok(notice.type === "intentFailed" && notice.intentType === "setHeaders");
		assert.ok(notice.type === "intentFailed" && notice.message.includes("write denied"));
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
});
