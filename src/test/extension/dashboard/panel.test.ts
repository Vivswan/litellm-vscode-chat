import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ExtensionToWebviewMessage, ReadMethod } from "../../../dashboard/endpoints";
import type { CatalogModelSummary } from "../../../dashboard/viewModels";
import { modelScopeKey } from "../../../extension/dashboard/adoptHandle";
import type { DashboardControllerEnv, DashboardPanel, ServerResolution } from "../../../extension/dashboard/panel";
import {
	DashboardController,
	declaredMergedSnapshots,
	declaredViewsFromSetting,
	entryParametersResolver,
} from "../../../extension/dashboard/panel";
import type {
	EntryCapabilitiesRecord,
	EntryParametersResolution,
	SettingsReader,
} from "../../../extension/dashboard/state";
import { EMPTY_CATALOG_STATUS, EMPTY_USAGE_VIEW } from "../../../extension/dashboard/state";
import { entryModelParametersFor } from "../../../extension/servers/serverSync";
import { RequestError } from "../../../provider/transport/errorMapping";
import { EMPTY_CATALOG_LOOKUP } from "../../../shared/config/capabilityResolution";
import { expectDefined, makeModelInfo } from "../../pureHelpers";
import { makeServerStatus } from "../../testUtils";
import { serverPayload } from "./recordedEnv";

/** One request envelope as the webview posts it; tests inject raw values, so the payload stays unknown. */
let nextAutoRequestId = 0;
function request(method: string, payload: unknown, id?: string): unknown {
	nextAutoRequestId += 1;
	return { kind: "request", id: id ?? `req-auto-${nextAutoRequestId}`, method, payload };
}

/** Whether a posted message is the named read's response envelope, narrowing to it. */
function isResponse<M extends ReadMethod>(
	message: unknown,
	method: M
): message is Extract<ExtensionToWebviewMessage, { kind: "response"; method: M }> {
	const candidate = message as { kind?: unknown; method?: unknown };
	return candidate.kind === "response" && candidate.method === method;
}

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
	/** Every removeSetting call (the resetSetting intent's removals). */
	removals: string[];
	commands: [string, ...unknown[]][];
	serverWrites: unknown[][];
	secretOps: [string, string, string | undefined][];
	loggedErrors: unknown[];
	loggedMessages: [string, unknown][];
	settingsValues: Record<string, unknown>;
	serversSetting: unknown[];
	/** What getSnapshots answers; defaults to one healthy "srv1" server serving "m1". */
	snapshots: ReturnType<DashboardControllerEnv["getSnapshots"]>;
	/** The legacy registry's servers, as getLegacyServers reports them. */
	legacyServers: { baseUrl: string }[];
	/** What resolveEntryParameters answers per snapshot server ID. */
	entryResolutions: Record<string, EntryParametersResolution>;
	/** What resolveEntryCapabilities answers per snapshot server ID. */
	entryCapabilities: Record<string, EntryCapabilitiesRecord>;
	/** Every searchCatalog query, with catalogResults as the canned answer. */
	catalogQueries: string[];
	catalogResults: CatalogModelSummary[];
	/** How many staleness-gated usage kicks open() fired (refreshUsageIfStale). */
	usageStaleKicks: number;
	/** When set, every updateSetting call rejects with this error. */
	failUpdates?: Error;
	/** When set, storeServerSecret rejects with this error on deletes (value === undefined). */
	failUnstore?: Error;
	/** When set, probeDraftConnection waits on this before resolving; lets a test hold a slow probe open. */
	probeGate?: Promise<void>;
	/** When set, probeDraftConnection rejects with this error (a failing draft test). */
	probeError?: Error;
}

function makeHarness(): Harness {
	const panels: FakePanel[] = [];
	const updates: [string, unknown][] = [];
	const removals: string[] = [];
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
	const serverResolution: ServerResolution = {
		isGroupSnapshot: () => true,
		resolveEntryParameters: (serverId) => harness.entryResolutions[serverId],
		resolveEntryCapabilities: (serverId) => harness.entryCapabilities[serverId],
	};
	const env: DashboardControllerEnv = {
		createPanel: () => {
			const fake = makeFakePanel();
			panels.push(fake);
			return fake.panel;
		},
		getSnapshots: () => harness.snapshots,
		getDeclaredServers: () => [],
		getLegacyServers: () => harness.legacyServers,
		getRemovedGroups: () => ({ tombstones: [], origins: [] }),
		serverResolution,
		getCatalogLookup: () => EMPTY_CATALOG_LOOKUP,
		getCatalogStatus: () => EMPTY_CATALOG_STATUS,
		getUsage: () => EMPTY_USAGE_VIEW,
		getParkedGlobalHeaders: () => undefined,
		refreshCatalogNow: () => {},
		refreshUsageNow: () => {},
		refreshUsageIfStale: () => {
			harness.usageStaleKicks += 1;
		},
		searchCatalog: (query) => {
			harness.catalogQueries.push(query);
			return harness.catalogResults;
		},
		settingsReader: () => reader,
		updateSetting: async (key, value) => {
			if (harness.failUpdates !== undefined) {
				throw harness.failUpdates;
			}
			updates.push([key, value]);
		},
		removeSetting: async (key) => {
			if (harness.failUpdates !== undefined) {
				throw harness.failUpdates;
			}
			removals.push(key);
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
		resolveExternalGroup: () => undefined,
		hideGroup: async () => {},
		unhideGroup: async () => false,
		// The probe is gated so tests can hold it open (a slow discovery) and
		// prove a later Save is not queued behind it; ungated it resolves empty.
		probeDraftConnection: () => {
			if (harness.probeError !== undefined) {
				return Promise.reject(harness.probeError);
			}
			return harness.probeGate === undefined
				? Promise.resolve<readonly string[]>([])
				: harness.probeGate.then<readonly string[]>(() => []);
		},
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
		removals,
		commands,
		serverWrites,
		secretOps,
		loggedErrors,
		loggedMessages,
		settingsValues,
		serversSetting: [],
		snapshots: [
			{ discoveredRawIds: [], status: makeServerStatus(), models: [makeModelInfo({ id: "m1", name: "m1" })] },
		],
		legacyServers: [],
		entryResolutions: {},
		entryCapabilities: {},
		catalogQueries: [],
		catalogResults: [],
		usageStaleKicks: 0,
	};
	return harness;
}

function lastState(fake: FakePanel): Extract<ExtensionToWebviewMessage, { kind: "push" }> {
	const message = fake.posted.at(-1) as ExtensionToWebviewMessage | undefined;
	assert.ok(message !== undefined, "no state was pushed");
	assert.ok(message.kind === "push", `expected a state push, got ${message.kind}`);
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

	test("open kicks the staleness-gated usage refresh, never the unconditional one", () => {
		// The gate itself lives in the poller (refreshIfStale reads the last
		// completed pass); the panel's job is only to ask the gated seam on every open.
		const harness = makeHarness();
		harness.controller.open();
		harness.controller.open();

		assert.strictEqual(harness.usageStaleKicks, 2);
	});

	test("the ready handshake triggers a state push", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);
		const before = fake.posted.length;

		fake.receiveMessage(request("ready", null));
		await settle();

		assert.strictEqual(fake.posted.length, before + 1);
	});

	suite("the diagnostics deep link (open with a target section)", () => {
		function focusMessages(fake: FakePanel): Extract<ExtensionToWebviewMessage, { kind: "focusSection" }>[] {
			return (fake.posted as ExtensionToWebviewMessage[]).filter((message) => message.kind === "focusSection");
		}

		test("a fresh panel gets the focus after the ready handshake, exactly once", async () => {
			const harness = makeHarness();
			harness.controller.open("diagnostics");
			const fake = harness.panels[0];
			assert.ok(fake);
			assert.deepStrictEqual(focusMessages(fake), [], "a page that has not signaled ready gets no focus yet");

			fake.receiveMessage(request("ready", null));
			await settle();

			assert.deepStrictEqual(focusMessages(fake), [{ kind: "focusSection", section: "diagnostics" }]);
			const last = fake.posted.at(-1) as ExtensionToWebviewMessage;
			assert.strictEqual(last.kind, "focusSection", "the focus lands after the handshake's state push");

			// A later reload must not replay the consumed deep link.
			fake.receiveMessage(request("ready", null));
			await settle();
			assert.strictEqual(focusMessages(fake).length, 1);
		});

		test("a panel whose page already completed the handshake gets the focus immediately", async () => {
			const harness = makeHarness();
			harness.controller.open();
			const fake = harness.panels[0];
			assert.ok(fake);
			fake.receiveMessage(request("ready", null));
			await settle();

			harness.controller.open("diagnostics");

			const last = fake.posted.at(-1) as ExtensionToWebviewMessage;
			assert.deepStrictEqual(last, { kind: "focusSection", section: "diagnostics" });
			assert.strictEqual(harness.panels.length, 1, "the deep link reveals the existing panel");
		});

		test("a deep link racing the initial page load waits for the ready handshake", async () => {
			const harness = makeHarness();
			harness.controller.open();
			const fake = harness.panels[0];
			assert.ok(fake);

			// The page is still loading (no ready yet): an immediate post would
			// be dropped on the floor, so the focus must stay pending.
			harness.controller.open("diagnostics");
			assert.deepStrictEqual(focusMessages(fake), []);

			fake.receiveMessage(request("ready", null));
			await settle();
			assert.deepStrictEqual(focusMessages(fake), [{ kind: "focusSection", section: "diagnostics" }]);
		});

		test("a hidden panel defers the focus to the reload's own ready handshake", async () => {
			const harness = makeHarness();
			harness.controller.open();
			const fake = harness.panels[0];
			assert.ok(fake);
			fake.receiveMessage(request("ready", null));
			await settle();
			fake.setVisible(false);

			harness.controller.open("diagnostics");
			assert.deepStrictEqual(focusMessages(fake), [], "a hidden page would drop the message");

			// Revealing re-fires the view state, but the torn-down page reloads:
			// only its own ready proves it can receive the focus.
			fake.setVisible(true);
			assert.deepStrictEqual(focusMessages(fake), []);
			fake.receiveMessage(request("ready", null));
			await settle();
			assert.deepStrictEqual(focusMessages(fake), [{ kind: "focusSection", section: "diagnostics" }]);
		});

		test("a ready that outlives its page cannot vouch for the next page or eat its focus", async () => {
			const harness = makeHarness();
			harness.controller.open();
			const fake = harness.panels[0];
			assert.ok(fake);

			// The handshake is queued but the page dies (panel hidden) before the
			// serialized chain drains it; the reloaded page has not spoken yet.
			fake.receiveMessage(request("ready", null));
			fake.setVisible(false);
			await settle();

			harness.controller.open("diagnostics");
			assert.deepStrictEqual(focusMessages(fake), [], "the stale handshake must not stand in for the reloading page");

			fake.setVisible(true);
			fake.receiveMessage(request("ready", null));
			await settle();
			assert.deepStrictEqual(focusMessages(fake), [{ kind: "focusSection", section: "diagnostics" }]);
		});

		test("a plain open cancels a pending focus: the latest open call defines the target", async () => {
			const harness = makeHarness();
			harness.controller.open();
			const fake = harness.panels[0];
			assert.ok(fake);
			fake.setVisible(false);
			harness.controller.open("diagnostics");

			harness.controller.open();
			fake.setVisible(true);
			fake.receiveMessage(request("ready", null));
			await settle();

			assert.deepStrictEqual(focusMessages(fake), [], "the user asked for the dashboard, not the old deep link");
		});
	});

	test("state pushes count legacy registry servers that have no row of their own", () => {
		const harness = makeHarness();
		harness.legacyServers = [
			{ baseUrl: "http://old.test" },
			// Same host as the live snapshot (modulo the trailing slash): it
			// already renders as a server row, so it must not count again.
			{ baseUrl: "http://prod.test/" },
		];
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		assert.strictEqual(lastState(fake).state.legacyServerCount, 1);
	});

	suite("declaredViewsFromSetting", () => {
		test("maps accepted entries with setting-provable secret locations only", () => {
			const views = declaredViewsFromSetting([
				{ label: "Inline", baseUrl: "http://a.test", auth: { apiKey: "sk-inline" } },
				{ label: "Bare", baseUrl: "http://b.test", auth: { virtualKey: { header: "x-vk" } } },
			]);

			assert.strictEqual(views.length, 2);
			assert.strictEqual(views[0]?.label, "Inline");
			assert.strictEqual(views[0]?.baseUrl, "http://a.test");
			assert.deepStrictEqual(views[0]?.secrets, {
				apiKey: "settings",
				oauthClientSecret: "none",
				virtualKeyValue: "none",
			});
			// A secure blob may exist for Bare, but the setting cannot prove it,
			// so the synchronous fallback reads "none".
			assert.deepStrictEqual(views[1]?.secrets, { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" });
			assert.strictEqual(views[1]?.virtualKeyHeader, "x-vk");
			assert.ok(!JSON.stringify(views).includes("sk-inline"), "the view carries locations, never values");
		});

		test("carries the entry's record fields, matching the engine's post-sync view", () => {
			// The fallback covers the window before the first sync pass lands;
			// dropping these fields there would blank the edit form's prefill
			// (and, for a saved-through draft, silently delete them).
			const views = declaredViewsFromSetting([
				{
					label: "Prod",
					baseUrl: "http://a.test",
					models: {
						parameters: { "gpt-4": { temperature: 0.2 } },
						capabilities: { "gpt-4": { supports_vision: true } },
					},
					discovery: { expectedFailures: ["modelInfo"] },
				},
				{ label: "Bare", baseUrl: "http://b.test" },
			]);

			assert.deepStrictEqual(views[0]?.modelParameters, { "gpt-4": { temperature: 0.2 } });
			assert.deepStrictEqual(views[0]?.modelCapabilities, { "gpt-4": { supports_vision: true } });
			assert.deepStrictEqual(views[0]?.expectedFailures, ["modelInfo"]);
			const bare = views[1];
			assert.ok(bare);
			assert.ok(!("modelParameters" in bare) && !("modelCapabilities" in bare) && !("expectedFailures" in bare));
		});

		test("junk settings read as empty", () => {
			assert.deepStrictEqual(declaredViewsFromSetting("not an array"), []);
			assert.deepStrictEqual(declaredViewsFromSetting([{ label: 42 }]), []);
		});
	});

	test("a setting intent reaches updateSetting; malformed messages are ignored without effects", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage(request("setNumberSetting", { setting: "chat.timeout", value: 60000 }));
		fake.receiveMessage(request("setNumberSetting", { setting: "chat.timeout", value: "60000" }));
		fake.receiveMessage({ type: "definitely-not-a-message" });
		await settle();

		assert.deepStrictEqual(harness.updates, [["chat.timeout", 60000]]);
		assert.deepStrictEqual(harness.loggedErrors, [], "malformed messages are ignored, not errors");
	});

	test("the appearance intents write their settings, and a value outside the vocabulary is refused", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage(request("setUiTheme", { value: "dark" }));
		fake.receiveMessage(request("setUiAccent", { value: "teal" }));
		// The vocabularies are closed at the schema, so a webview that posted
		// anything else writes nothing rather than putting junk in the setting.
		fake.receiveMessage(request("setUiTheme", { value: "solarized" }));
		fake.receiveMessage(request("setUiAccent", { value: 7 }));
		await settle();

		assert.deepStrictEqual(harness.updates, [
			["ui.theme", "dark"],
			["ui.accent", "teal"],
		]);
	});

	test("a command intent reaches executeCommand", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage(request("executeCommand", { command: "openOutput" }));
		await settle();

		assert.deepStrictEqual(harness.commands, [["litellm.openOutput"]]);
	});

	test("a slow draft-connection probe runs off the mutation chain: a later Save lands before the probe resolves", async () => {
		const harness = makeHarness();
		let releaseProbe: () => void = () => {};
		harness.probeGate = new Promise<void>((resolve) => {
			releaseProbe = resolve;
		});
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		// A probe that will hang for a whole discovery timeout, then a Save.
		fake.receiveMessage(
			request(
				"testServerDraft",
				{
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
					secrets: {
						apiKey: { action: "keep" },
						oauthClientSecret: { action: "keep" },
						virtualKeyValue: { action: "keep" },
					},
				},
				"probe-1"
			)
		);
		fake.receiveMessage(
			request(
				"saveServerSetting",
				{
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
					secrets: {
						apiKey: { action: "keep" },
						oauthClientSecret: { action: "keep" },
						virtualKeyValue: { action: "keep" },
					},
				},
				"save-1"
			)
		);
		// Several ticks: the save's writeServersSetting carries its own
		// setTimeout latency, and the probe stays parked on its gate throughout.
		for (let i = 0; i < 5; i += 1) {
			await settle();
		}

		// The Save's write landed while the probe is still hanging: were the
		// probe on the chain, this would be empty until releaseProbe ran.
		assert.deepStrictEqual(harness.serverWrites, [[{ label: "Prod", baseUrl: "http://prod.test" }]]);
		assert.ok(
			fake.posted.some(
				(message) =>
					(message as ExtensionToWebviewMessage).kind === "ack" && (message as { id?: string }).id === "save-1"
			),
			"the Save acked before the probe finished"
		);
		assert.ok(
			!fake.posted.some((message) => (message as { id?: string }).id === "probe-1"),
			"the probe has not acked yet; it is still hanging"
		);

		// Releasing the probe lets its own ack arrive, carrying the composed count.
		releaseProbe();
		await settle();
		const probeAck = fake.posted.find((message) => (message as { id?: string }).id === "probe-1") as
			| ExtensionToWebviewMessage
			| undefined;
		assert.ok(probeAck?.kind === "ack" && probeAck.message === "Connected - 0 models");
	});

	test("readModelCapabilities answers with the resolved walk, and a stale scope answers honestly empty", async () => {
		const harness = makeHarness();
		harness.settingsValues["models.capabilities"] = { m1: { supports_vision: true } };
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage(
			request(
				"readModelCapabilities",
				{
					scopeKey: modelScopeKey("srv1"),
					rawId: "m1",
				},
				"caps-1"
			)
		);
		fake.receiveMessage(
			request(
				"readModelCapabilities",
				{
					scopeKey: modelScopeKey("no-such-server"),
					rawId: "m1",
				},
				"caps-2"
			)
		);
		await settle();

		const answered = fake.posted.filter((message) => isResponse(message, "readModelCapabilities")) as Extract<
			ExtensionToWebviewMessage,
			{ kind: "response"; method: "readModelCapabilities" }
		>[];
		assert.strictEqual(answered.length, 2);
		const [live, stale] = answered;
		assert.strictEqual(live?.id, "caps-1");
		assert.strictEqual(live?.payload.capabilities?.fields.supports_vision.value, true);
		assert.strictEqual(live?.payload.capabilities?.fields.supports_vision.level, "global");
		assert.strictEqual(stale?.id, "caps-2");
		assert.strictEqual(stale?.payload.capabilities, undefined, "a de-resolved scope answers without inventing values");
		assert.ok(
			!fake.posted.some((message) => {
				const kind = (message as ExtensionToWebviewMessage).kind;
				return kind === "ack" || kind === "fail";
			}),
			"pure reads produce no outcome notices"
		);
	});

	test("readModelCapabilities filters unrecognized-key hints against the server's observed set", async () => {
		const harness = makeHarness();
		harness.settingsValues["models.capabilities"] = { m1: { mystery_flag: true, observed_flag: 1 } };
		harness.snapshots = [
			{
				discoveredRawIds: [],
				status: makeServerStatus(),
				models: [makeModelInfo({ id: "m1", name: "m1" })],
				observedModelInfoKeys: ["observed_flag"],
			},
		];
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage(
			request(
				"readModelCapabilities",
				{
					scopeKey: modelScopeKey("srv1"),
					rawId: "m1",
				},
				"caps-adv"
			)
		);
		await settle();

		const answer = fake.posted.find((message) => isResponse(message, "readModelCapabilities")) as
			| Extract<ExtensionToWebviewMessage, { kind: "response"; method: "readModelCapabilities" }>
			| undefined;
		assert.deepStrictEqual(
			answer?.payload.capabilities?.diagnostics,
			[{ kind: "unrecognized-key", recordKey: "m1", key: "mystery_flag", layer: "global" }],
			"the observed key's hint drops; the unobserved key's survives"
		);
		assert.strictEqual(
			answer?.payload.capabilities?.fields.mystery_flag?.value,
			true,
			"the field itself still applies"
		);

		// The same evidence reaches the state push: the surviving global-record
		// hint is advisory, and the observed set rides the server row and union.
		const statePush = fake.posted.filter((message) => (message as ExtensionToWebviewMessage).kind === "push").at(-1) as
			| Extract<ExtensionToWebviewMessage, { kind: "push" }>
			| undefined;
		assert.ok(statePush !== undefined, "opening pushed a state");
		const state = statePush.state;
		assert.deepStrictEqual(state.observedModelInfoKeys, ["observed_flag"]);
		assert.deepStrictEqual(state.servers[0]?.observedModelInfoKeys, ["observed_flag"]);
		const recordDiagnostics = state.diagnostics.filter((diagnostic) => diagnostic.kind === "record");
		assert.deepStrictEqual(recordDiagnostics, [
			{
				kind: "record",
				setting: "models.capabilities",
				diagnostic: { kind: "unrecognized-key", recordKey: "m1", key: "mystery_flag" },
				severity: "advisory",
			},
		]);
	});

	test("searchCatalog answers with the bounded result list and echoes the requestId", async () => {
		const harness = makeHarness();
		harness.catalogResults = Array.from({ length: 25 }, (_, index) => ({ id: `v/m${index}`, name: `M${index}` }));
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage(request("searchCatalog", { query: "gpt" }, "cat-1"));
		await settle();

		assert.deepStrictEqual(harness.catalogQueries, ["gpt"]);
		const answer = fake.posted.find((message) => isResponse(message, "searchCatalog")) as
			| Extract<ExtensionToWebviewMessage, { kind: "response"; method: "searchCatalog" }>
			| undefined;
		assert.strictEqual(answer?.id, "cat-1");
		assert.strictEqual(answer?.payload.results.length, 20, "the panel bounds what crosses the boundary");
	});

	test("a failing intent is reported back to the webview as a retryable failure, with our validation text", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage(request("setNumberSetting", { setting: "chat.timeout", value: 1 }));
		await settle();

		assert.deepStrictEqual(harness.updates, []);
		assert.ok(
			harness.loggedMessages.some(([message]) => message === "Dashboard intent rejected"),
			"validation failures log as rejections"
		);
		const notice = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.strictEqual(notice.kind, "fail");
		assert.ok(notice.kind === "fail" && notice.method === "setNumberSetting");
		assert.ok(notice.kind === "fail" && notice.message.includes("at least"));
		assert.ok(notice.kind === "fail" && notice.failureKind === "validation", "a refused intent is validation-kind");
		assert.ok(!("classification" in notice), "a non-transport validation failure carries no classification");
		// The fail envelope names the owning settings row, derived from the
		// validated payload, so the page can place the notice without a
		// correlation map of its own.
		assert.ok(notice.kind === "fail" && notice.row === "chat.timeout");
	});

	test("a failing draft probe's transport classification rides the intentFailed notice", async () => {
		const harness = makeHarness();
		harness.probeError = new RequestError("the server answered 404", "http", {
			englishMessage: "the server answered 404",
			status: 404,
			setupHint: "check-base-url",
		});
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage(
			request(
				"testServerDraft",
				{
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
					secrets: {
						apiKey: { action: "keep" },
						oauthClientSecret: { action: "keep" },
						virtualKeyValue: { action: "keep" },
					},
				},
				"probe-404"
			)
		);
		await settle();

		const notice = fake.posted.find(
			(message) => (message as ExtensionToWebviewMessage).kind === "fail"
		) as ExtensionToWebviewMessage;
		assert.ok(notice !== undefined && notice.kind === "fail");
		assert.strictEqual(notice.id, "probe-404");
		assert.strictEqual(notice.failureKind, "validation");
		assert.deepStrictEqual(notice.classification, { kind: "http", status: 404, setupHint: "check-base-url" });
		// The log carries the classification enums (they feed issue-report
		// triage) but never the message's response-derived text.
		const rejection = harness.loggedMessages.find(([message]) => message === "Dashboard intent rejected");
		assert.deepStrictEqual(rejection?.[1], {
			method: "testServerDraft",
			kind: "validation",
			classification: { kind: "http", status: 404, setupHint: "check-base-url" },
		});
		assert.ok(!JSON.stringify(harness.loggedMessages).includes("answered 404"), "the message stays out of the log");
	});

	test("a validation failure's message reaches the webview but never the log", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);
		// The validation message quotes the offending record key, so the message
		// must stay out of the log (user-entered keys can be anything pasted).
		fake.receiveMessage(
			request(
				"setModelParameters",
				{
					value: { constructor: { temperature: 1 } },
				},
				"req-params-1"
			)
		);
		await settle();

		const notice = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.ok(notice.kind === "fail" && notice.message.includes("constructor"), "the webview names the key");
		const logged = JSON.stringify(harness.loggedMessages);
		assert.ok(!logged.includes("constructor"), "the quoted key must not reach the log");
		assert.ok(!logged.includes("reserved name"), "the validation message itself must not reach the log");
		assert.ok(logged.includes('"kind":"validation"'), "the log carries a classification only");
	});

	test("a rejected settings write is classified: the raw error text reaches neither the webview nor the log", async () => {
		const harness = makeHarness();
		harness.failUpdates = new Error("write denied: /home/user/.config/secret-path");
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage(
			request(
				"setModelParameters",
				{
					value: { "gpt-4": { temperature: 0.2 } },
				},
				"req-params-2"
			)
		);
		await settle();

		const notice = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.ok(notice.kind === "fail" && notice.method === "setModelParameters");
		assert.ok(notice.kind === "fail" && !notice.message.includes("write denied"));
		assert.ok(notice.kind === "fail" && notice.message.length > 0);
		assert.ok(notice.kind === "fail" && notice.failureKind === "validation", "an unapplied write is validation-kind");
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

		fake.receiveMessage(
			request(
				"saveServerSetting",
				{
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
					secrets: {
						apiKey: { action: "set", location: "secure", value: "sk-secret-value" },
						oauthClientSecret: { action: "keep" },
						virtualKeyValue: { action: "keep" },
					},
				},
				"req-42"
			)
		);
		await settle();
		await settle();

		assert.deepStrictEqual(harness.serverWrites, [[{ label: "Prod", baseUrl: "http://prod.test" }]]);
		assert.deepStrictEqual(harness.secretOps, [["Prod", "apiKey", "sk-secret-value"]]);
		const messages = fake.posted as ExtensionToWebviewMessage[];
		const ackIndex = messages.findIndex((m) => m.kind === "ack");
		assert.ok(ackIndex >= 0, "the ack was posted");
		const ack = messages[ackIndex];
		assert.ok(ack?.kind === "ack" && ack.id === "req-42");
		assert.ok(
			messages.slice(ackIndex + 1).some((m) => m.kind === "push"),
			"a state push follows the ack"
		);
	});

	test("a save payload omitting the always-sent fields is rejected at the schema, deleting nothing", async () => {
		// The save rebuilds the entry from the intent, so a payload that could
		// omit modelCapabilities or expectedFailures would silently delete
		// hand-written configuration; the schema requires the fields instead.
		const harness = makeHarness();
		harness.serversSetting = [
			{
				label: "Prod",
				baseUrl: "http://prod.test",
				models: { capabilities: { "gpt-4": { supports_vision: true } } },
				discovery: { expectedFailures: ["modelInfo"] },
			},
		];
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage(
			request(
				"saveServerSetting",
				{
					server: { label: "Prod", baseUrl: "http://prod.test" },
					secrets: {
						apiKey: { action: "set", location: "settings", value: "sk-rotated" },
						oauthClientSecret: { action: "keep" },
						virtualKeyValue: { action: "keep" },
					},
					replaceLabel: "Prod",
				},
				"req-carry"
			)
		);
		await settle();
		await settle();

		assert.deepStrictEqual(harness.serverWrites, [], "a malformed save must not write");
		assert.deepStrictEqual(harness.secretOps, [], "a malformed save must not touch secrets");
		assert.ok(
			harness.loggedMessages.some(([message]) => message === "Ignoring malformed dashboard message"),
			"the schema rejection is logged"
		);
		// The envelope frame parsed, so the refusal answers the caller: an
		// editor waiting on this id must not sit in its pending state forever.
		const refusal = fake.posted.find((message) => (message as ExtensionToWebviewMessage).kind === "fail") as
			| ExtensionToWebviewMessage
			| undefined;
		assert.ok(refusal !== undefined && refusal.kind === "fail");
		assert.strictEqual(refusal.id, "req-carry");
		assert.strictEqual(refusal.method, "saveServerSetting");
		assert.strictEqual(refusal.failureKind, "validation");
	});

	test("a frame-parsed payload rejection classifies as a refused intent through the injection seam", async () => {
		const harness = makeHarness();
		harness.controller.open();

		assert.strictEqual(
			await harness.controller.injectMessageForTest(
				request("setNumberSetting", { setting: "chat.timeout", value: "not-a-number" }, "req-bounds")
			),
			"validation-error"
		);
		assert.deepStrictEqual(harness.updates, [], "the refused payload must not act");
	});

	test("an adoption without resolvable credentials acks success with the caveat message", async () => {
		const harness = makeHarness();
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage(
			request(
				"adoptServer",
				{
					label: "Adopted",
					baseUrl: "http://ext.test",
					sourceHandle: "handle-ext",
					secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
				},
				"req-adopt"
			)
		);
		await settle();
		await settle();

		assert.deepStrictEqual(harness.serverWrites, [[{ label: "Adopted", baseUrl: "http://ext.test" }]]);
		const messages = fake.posted as ExtensionToWebviewMessage[];
		const ack = messages.find((m) => m.kind === "ack");
		assert.ok(ack !== undefined && ack.kind === "ack" && ack.id === "req-adopt");
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
		fake.receiveMessage(
			request(
				"saveServerSetting",
				{
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
					secrets: {
						apiKey: { action: "set", location: "settings", value: "sk-inline" },
						oauthClientSecret: { action: "keep" },
						virtualKeyValue: { action: "keep" },
					},
					replaceLabel: "Prod",
				},
				"req-cleanup"
			)
		);
		await settle();
		await settle();

		assert.deepStrictEqual(harness.serverWrites, [
			[{ label: "Prod", baseUrl: "http://prod.test", auth: { apiKey: "sk-inline" } }],
		]);
		const messages = fake.posted as ExtensionToWebviewMessage[];
		const ack = messages.find((m) => m.kind === "ack");
		assert.ok(ack !== undefined && ack.kind === "ack" && ack.id === "req-cleanup");
		assert.ok(!messages.some((m) => m.kind === "fail"), "the committed write must not report failure");
	});

	test("a failed clear reports the partial failure to the webview, with a classification-only log", async () => {
		const harness = makeHarness();
		harness.serversSetting = [{ label: "Prod", baseUrl: "http://prod.test" }];
		harness.failUnstore = new Error("keychain locked: /Users/someone/Library");
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage(
			request(
				"saveServerSetting",
				{
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
					secrets: {
						apiKey: { action: "clear" },
						oauthClientSecret: { action: "keep" },
						virtualKeyValue: { action: "keep" },
					},
					replaceLabel: "Prod",
				},
				"req-clear"
			)
		);
		await settle();
		await settle();

		assert.deepStrictEqual(harness.serverWrites, [[{ label: "Prod", baseUrl: "http://prod.test" }]]);
		const notice = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.ok(notice.kind === "fail" && notice.method === "saveServerSetting");
		assert.ok(notice.kind === "fail" && notice.id === "req-clear");
		assert.ok(
			notice.kind === "fail" && notice.failureKind === "operation",
			"a committed save reports an operation-kind failure so the webview treats the entry as saved"
		);
		assert.ok(
			notice.kind === "fail" && notice.message.includes("Set Server Secret"),
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
		fake.receiveMessage(
			request(
				"saveServerSetting",
				{
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
					secrets: {
						apiKey: { action: "set", location: "secure", value: "sk-new" },
						oauthClientSecret: { action: "keep" },
						virtualKeyValue: { action: "keep" },
					},
					replaceLabel: "Prod",
				},
				"req-rollback"
			)
		);
		await settle();
		await settle();

		const notice = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.ok(notice.kind === "fail" && notice.method === "saveServerSetting");
		assert.ok(notice.kind === "fail" && notice.id === "req-rollback");
		assert.ok(notice.kind === "fail" && notice.failureKind === "operation", "durable state changed");
		assert.ok(notice.kind === "fail" && notice.message.includes("Set Server Secret"));
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

		fake.receiveMessage(request("removeServerSetting", { label: "Missing" }, "req-7"));
		await settle();

		const notice = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.ok(notice.kind === "fail" && notice.method === "removeServerSetting");
		assert.ok(notice.kind === "fail" && notice.id === "req-7");
	});

	test("readInlineSecrets answers with inline values only: secure and absent fields carry no key", async () => {
		const harness = makeHarness();
		harness.serversSetting = [
			{ label: "Inline", baseUrl: "http://a.test", auth: { apiKey: "sk-inline" } },
			// Mixed entry: inline key, everything else lives elsewhere or nowhere.
			{ label: "Mixed", baseUrl: "http://c.test", auth: { apiKey: "sk-mixed", virtualKey: { header: "x-vk" } } },
		];
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);

		fake.receiveMessage(request("readInlineSecrets", { label: "Mixed" }, "req-inline"));
		await settle();

		const response = fake.posted.at(-1) as ExtensionToWebviewMessage;
		assert.ok(isResponse(response, "readInlineSecrets"), `expected the response, got ${response.kind}`);
		assert.strictEqual(response.id, "req-inline");
		assert.deepStrictEqual(response.payload.values, { apiKey: "sk-mixed" });
		assert.ok(!("oauthClientSecret" in response.payload.values), "a secure-side field must be absent, not empty");
		assert.ok(!("virtualKeyValue" in response.payload.values), "an unset field must be absent, not empty");
	});

	test("readInlineSecrets triggers no state push, and the value never reaches the log", async () => {
		const harness = makeHarness();
		harness.serversSetting = [{ label: "Inline", baseUrl: "http://a.test", auth: { apiKey: "sk-inline-value" } }];
		harness.controller.open();
		const fake = harness.panels[0];
		assert.ok(fake);
		const before = fake.posted.length;

		fake.receiveMessage(request("readInlineSecrets", { label: "Inline" }, "req-a"));
		fake.receiveMessage(request("readInlineSecrets", { label: "No Such Entry" }, "req-b"));
		await settle();

		assert.strictEqual(fake.posted.length, before + 2, "exactly the two responses, no state pushes");
		const [first, second] = fake.posted.slice(before) as ExtensionToWebviewMessage[];
		assert.ok(first !== undefined && isResponse(first, "readInlineSecrets") && first.id === "req-a");
		assert.deepStrictEqual(isResponse(first, "readInlineSecrets") ? first.payload.values : undefined, {
			apiKey: "sk-inline-value",
		});
		assert.ok(second !== undefined && isResponse(second, "readInlineSecrets") && second.id === "req-b");
		assert.deepStrictEqual(
			isResponse(second, "readInlineSecrets") ? second.payload.values : undefined,
			{},
			"unknown label: no values"
		);
		const logged = JSON.stringify({ logs: harness.loggedMessages, errors: harness.loggedErrors });
		assert.ok(!logged.includes("sk-inline-value"), "the value must never reach the log");
		// The state canary: the pushes that did happen (the open) carry no
		// inline secret even though the setting holds one.
		const states = (fake.posted as ExtensionToWebviewMessage[]).filter((m) => m.kind === "push");
		assert.ok(!JSON.stringify(states).includes("sk-inline-value"), "state pushes must not carry inline values");
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

		fake.receiveMessage(
			request(
				"saveServerSetting",
				{
					server: serverPayload({ label: "A", baseUrl: "http://a.test" }),
					secrets: keepAll,
				},
				"req-a"
			)
		);
		fake.receiveMessage(
			request(
				"saveServerSetting",
				{
					server: serverPayload({ label: "B", baseUrl: "http://b.test" }),
					secrets: keepAll,
				},
				"req-b"
			)
		);
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
		fake.receiveMessage(
			request(
				"saveServerSetting",
				{
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
					secrets: {
						apiKey: { action: "set", location: "secure", value: secret },
						oauthClientSecret: { action: "keep" },
						virtualKeyValue: { action: "keep" },
					},
				},
				"req-1"
			)
		);
		fake.receiveMessage(
			request(
				"saveServerSetting",
				{
					server: serverPayload({ label: "Prod", baseUrl: "not a url" }),
					secrets: {
						apiKey: { action: "set", location: "secure", value: secret },
						oauthClientSecret: { action: "keep" },
						virtualKeyValue: { action: "keep" },
					},
				},
				"req-2"
			)
		);
		await settle();
		await settle();

		assert.ok(
			(fake.posted as ExtensionToWebviewMessage[]).some((m) => m.kind === "fail"),
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

	suite("injectMessageForTest", () => {
		test("classifies outcomes through the real schema boundary", async () => {
			const harness = makeHarness();
			harness.controller.open();

			assert.strictEqual(
				await harness.controller.injectMessageForTest(
					request("setBooleanSetting", { setting: "ui.maskSecretInputs", value: true })
				),
				"ok"
			);
			assert.deepStrictEqual(harness.updates.at(-1), ["ui.maskSecretInputs", true]);

			assert.strictEqual(await harness.controller.injectMessageForTest({ junk: 1 }), "ignored-malformed");
			assert.strictEqual(
				await harness.controller.injectMessageForTest(
					request("setNumberSetting", { setting: "chat.timeout", value: -1 })
				),
				"validation-error"
			);
			assert.strictEqual(harness.updates.length, 1, "rejected messages must never act");
		});

		test("injected messages join the same serialized chain as webview posts", async () => {
			const harness = makeHarness();
			harness.controller.open();
			const fake = harness.panels[0];
			assert.ok(fake);

			// The webview save lands with simulated latency; the injected removal
			// finds its entry ONLY if the chain serialized it behind the save.
			fake.receiveMessage(
				request(
					"saveServerSetting",
					{
						server: serverPayload({ label: "Chained", baseUrl: "http://chained.test" }),
						secrets: {
							apiKey: { action: "keep" },
							oauthClientSecret: { action: "keep" },
							virtualKeyValue: { action: "keep" },
						},
					},
					"req-chain-1"
				)
			);
			assert.strictEqual(
				await harness.controller.injectMessageForTest(
					request("removeServerSetting", { label: "Chained" }, "req-chain-2")
				),
				"ok"
			);
			assert.deepStrictEqual(harness.serversSetting, [], "the removal ran after the save it was queued behind");
		});
	});

	suite("readModelParameters through the panel", () => {
		test("the env's entry resolution reaches the projection, and a stale scope answers honestly empty", async () => {
			const harness = makeHarness();
			// makeServerStatus defaults to serverId "srv1".
			harness.entryResolutions.srv1 = { entryLabel: "Prod", entryParameters: { m1: { temperature: 0.2 } } };
			harness.controller.open();
			const fake = harness.panels[0];
			assert.ok(fake);

			fake.receiveMessage(
				request(
					"readModelParameters",
					{
						scopeKey: modelScopeKey("srv1"),
						rawId: "m1",
					},
					"params-1"
				)
			);
			fake.receiveMessage(
				request(
					"readModelParameters",
					{
						scopeKey: modelScopeKey("no-such-server"),
						rawId: "m1",
					},
					"params-2"
				)
			);
			await settle();

			const answered = fake.posted.filter((message) => isResponse(message, "readModelParameters")) as Extract<
				ExtensionToWebviewMessage,
				{ kind: "response"; method: "readModelParameters" }
			>[];
			assert.strictEqual(answered.length, 2);
			const [live, stale] = answered;
			assert.strictEqual(live?.id, "params-1");
			const row = live?.payload.projection?.rows.find((candidate) => candidate.name === "temperature");
			assert.ok(row !== undefined, "the entry parameter reaches the projection");
			assert.strictEqual(row.value, 0.2);
			assert.deepStrictEqual(row.source, { layer: "entry", key: "m1", entryLabel: "Prod" });
			assert.strictEqual(stale?.id, "params-2");
			assert.strictEqual(stale?.payload.projection, undefined, "a de-resolved scope answers without inventing values");
			assert.ok(
				!fake.posted.some((message) => {
					const kind = (message as ExtensionToWebviewMessage).kind;
					return kind === "ack" || kind === "fail";
				}),
				"pure reads produce no outcome notices"
			);
		});
	});

	suite("entryParametersResolver", () => {
		const setting = [
			{
				label: "Team A",
				baseUrl: "http://prod.test",
				models: { parameters: { "gpt-4": { temperature: 0.2 } } },
			},
			{ label: "No Params", baseUrl: "http://prod.test" },
		];
		const resolver = (groups: Record<string, { label?: string; baseUrl: string }>) =>
			entryParametersResolver(
				(serverId) => groups[serverId],
				(label, baseUrl) => entryModelParametersFor(setting, label, baseUrl)
			);

		test("a labeled group at the entry's URL resolves the entry's parameters", () => {
			const resolve = resolver({ g1: { label: "Team A", baseUrl: "http://prod.test" } });
			assert.deepStrictEqual(resolve("g1"), {
				entryLabel: "Team A",
				entryParameters: { "gpt-4": { temperature: 0.2 } },
			});
		});

		test("a rotated-credentials group still resolves: the lookup is by snapshot server ID, the match by label and URL", () => {
			// Rotating credentials mints a new fingerprinted server ID, so the
			// strict labeled-identity join fails - but the request path matches
			// label plus URL, and the inspector must agree with the request path.
			const resolve = resolver({
				"group:labeled:rotated-fingerprint:http://prod.test": { label: "Team A", baseUrl: "http://prod.test" },
			});
			assert.deepStrictEqual(resolve("group:labeled:rotated-fingerprint:http://prod.test"), {
				entryLabel: "Team A",
				entryParameters: { "gpt-4": { temperature: 0.2 } },
			});
		});

		test("unlabeled groups, unknown server IDs, and label matches at another URL resolve to nothing", () => {
			const resolve = resolver({
				unlabeled: { baseUrl: "http://prod.test" },
				elsewhere: { label: "Team A", baseUrl: "http://elsewhere.test" },
			});
			assert.strictEqual(resolve("unlabeled"), undefined);
			assert.strictEqual(resolve("elsewhere"), undefined, "a label at another URL proves nothing");
			assert.strictEqual(resolve("missing"), undefined);
		});

		test("an entry without modelParameters resolves to nothing, like the request path", () => {
			const resolve = resolver({ g1: { label: "No Params", baseUrl: "http://prod.test" } });
			assert.strictEqual(resolve("g1"), undefined);
		});
	});

	suite("declaredMergedSnapshots", () => {
		// The real getSnapshots closure registerDashboardCommand wires: the
		// provider's snapshots with the declared projection appended, so the
		// dashboard's model list equals the set the picker serves.
		const withDeclared = {
			discoveredRawIds: ["m1"],
			status: makeServerStatus({ serverId: "srv-declared" }),
			models: [makeModelInfo({ id: "m1", name: "m1" })],
		};
		const withoutDeclared = {
			discoveredRawIds: [],
			status: makeServerStatus({ serverId: "srv-plain" }),
			models: [makeModelInfo({ id: "m2", name: "m2" })],
		};

		test("projected declared models are appended to the snapshot's discovered models", () => {
			const declaredInfo = makeModelInfo({ id: "my-declared", name: "my-declared" });
			const merged = declaredMergedSnapshots({
				getServerSnapshots: () => [withDeclared],
				declaredModelsForSnapshot: (snapshot) => (snapshot === withDeclared ? [declaredInfo] : []),
			});
			assert.deepStrictEqual(
				merged.map((snapshot) => snapshot.models.map((model) => model.id)),
				[["m1", "my-declared"]],
				"declared models append after the discovered ones"
			);
			assert.strictEqual(expectDefined(merged[0]).status, withDeclared.status);
		});

		test("a snapshot with nothing declared passes through with object identity", () => {
			const merged = declaredMergedSnapshots({
				getServerSnapshots: () => [withoutDeclared],
				declaredModelsForSnapshot: () => [],
			});
			assert.strictEqual(merged[0], withoutDeclared, "no-op merges must not rebuild the snapshot");
		});
	});
});
