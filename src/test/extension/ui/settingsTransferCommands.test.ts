import * as assert from "node:assert";
import * as vscode from "vscode";
import type { SecretStore, StoredServerSecrets } from "../../../extension/servers/serverSync";
import { updateServerSecret } from "../../../extension/servers/serverSync";
import { ServerSyncEngine } from "../../../extension/servers/serverSync/engine";
import { readServerSecretsRecord, secretDestination } from "../../../extension/servers/serverSync/secrets";
import { acceptedEntry } from "../../../extension/servers/serverSync/setting";
import type { SettingsAccess, SettingsInspection } from "../../../extension/settingsAccess";
import { inSettingsWriteTurn, settingValueOf, writeServersSettingFrom } from "../../../extension/settingsWriteTurn";
import type {
	ImportPreviewSummary,
	SettingsTransferEnv,
	SettingsTransferPrompts,
} from "../../../extension/ui/settingsTransferCommands";
import {
	renderImportPreview,
	runExportSettingsFlow,
	runImportSettingsFlow,
	runUndoLastImportFlow,
} from "../../../extension/ui/settingsTransferCommands";
import { VENDOR_ID } from "../../../shared/config/commandIds";
import { ALL_SETTING_KEYS, SERVERS_SETTING_KEY } from "../../../shared/config/settingSpec";
import { serverSecretsKey } from "../../../shared/config/storageKeys";
import { expectDefined } from "../../pureHelpers";
import { makeSyncEnv } from "../servers/serverSyncHelpers";

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

/** A recorded toast: kind, message, and the action labels it carried. */
interface FakeNotification {
	kind: "info" | "warning" | "error";
	message: string;
	actions: string[];
	run: (label: string) => Promise<void>;
}

/** The per-test prompt script; every field is mutable so a test sets only what it needs. */
interface PromptAnswers {
	confirmImport: boolean | ((summary: ImportPreviewSummary) => boolean);
	/** The undo confirmation modal's answer; defaults to confirmed. */
	confirmUndo: boolean;
	/** Per-label collision answers; a label absent here answers undefined (dismissal). */
	collisions: Record<string, "overwrite" | "skip" | "rename" | undefined>;
	/** The rename box's answer; a function may inspect the suggestion and validator. */
	rename:
		| string
		| undefined
		| ((suggested: string, validate: (candidate: string) => string | undefined) => string | undefined);
}

/** The whole faked world one flow run sees, with every side effect recorded. */
interface FakeWorld {
	env: SettingsTransferEnv;
	answers: PromptAnswers;
	/** The user-scope settings map the fake SettingsAccess serves and mutates. */
	settings: Map<string, unknown>;
	/** Keys inspect() reports as workspace-configured (the shadowing note's input). */
	workspaceValues: Map<string, unknown>;
	/** Keys whose writeGlobal throws. */
	failWrites: Set<string>;
	/** When true, a failing servers write arms secret-store failures (the escalation path). */
	armSecretFailureOnServersWrite: boolean;
	/** When true, a failing servers write arms store()-only failures; delete still works. */
	armStoreFailureOnServersWrite: boolean;
	/** SecretStorage keys whose store() fails (delete still works: a targeted mid-unit failure). */
	failSecretStoreKeys: Set<string>;
	/**
	 * Every mutation and sync request in arrival order: "settings:<key>", "secret-store:<key>", "secret-delete:<key>",
	 * "sync".
	 */
	ops: string[];
	/**
	 * A real engine wired as wiring/servers.ts wires it: woken by a changed secret value, a delete of a present key,
	 * the servers setting write, and the flow's explicit request; held through the flow's hold. Undefined in the
	 * fake-only tests.
	 */
	syncEngine: Pick<ServerSyncEngine, "requestSync" | "withHold"> | undefined;
	/**
	 * When true, every secret write and delete and every settings write lands one macrotask later, so a zero-debounce
	 * engine pass has the chance to run between any two writes unless the flow holds the engine.
	 */
	slowWrites: boolean;
	/** The raw SecretStorage map behind readServerSecrets/updateServerSecret. */
	secretValues: Map<string, string>;
	files: Map<string, Uint8Array>;
	saveTarget: vscode.Uri | undefined;
	openTarget: vscode.Uri | undefined;
	/** Overrides fileSize's answer (the size-cap test). */
	sizeOverride: number | undefined;
	failFileWrite: boolean;
	failSnapshotWrite: boolean;
	snapshotSlot: string | undefined;
	notifications: FakeNotification[];
	summaries: ImportPreviewSummary[];
	collisionPrompts: { label: string; connectionChanged: boolean }[];
	renamePrompts: { suggested: string; validate: (candidate: string) => string | undefined }[];
	/** The snapshot timestamps the undo confirmation modal was shown. */
	undoConfirmations: string[];
	saveDialogs: { defaultUri: vscode.Uri; title: string }[];
	/** The export flow's user-visible steps in arrival order: "notify", "save-dialog", "write-file". */
	events: string[];
	revealed: string[];
	logs: string[];
	syncRequests: number;
}

function makeWorld(
	initialSettings: Record<string, unknown> = {},
	initialBlobs: Record<string, StoredServerSecrets> = {}
): FakeWorld {
	const settings = new Map(Object.entries(initialSettings));
	const workspaceValues = new Map<string, unknown>();
	const failWrites = new Set<string>();
	const secretValues = new Map<string, string>();
	for (const [label, blob] of Object.entries(initialBlobs)) {
		secretValues.set(serverSecretsKey(label), JSON.stringify(blob));
	}
	const files = new Map<string, Uint8Array>();

	const inspectOf = (key: string): SettingsInspection => ({
		globalValue: settings.get(key),
		workspaceValue: workspaceValues.get(key),
	});
	let secretMutationsFail = false;
	let secretStoresFail = false;
	const world: FakeWorld = {} as FakeWorld;
	const secretStore: SecretStore = {
		get: async (key) => secretValues.get(key),
		store: async (key, value) => {
			world.ops.push(`secret-store:${key}`);
			if (secretMutationsFail || secretStoresFail || world.failSecretStoreKeys.has(key)) {
				throw new Error("secret store failed");
			}
			if (world.slowWrites) {
				await macrotask();
			}
			// A rewrite of an unchanged value wakes nothing.
			const changed = secretValues.get(key) !== value;
			secretValues.set(key, value);
			if (changed) {
				world.syncEngine?.requestSync();
			}
		},
		delete: async (key) => {
			world.ops.push(`secret-delete:${key}`);
			if (secretMutationsFail) {
				throw new Error("secret delete failed");
			}
			if (world.slowWrites) {
				await macrotask();
			}
			const changed = secretValues.delete(key);
			if (changed) {
				world.syncEngine?.requestSync();
			}
		},
	};
	const writeUserValue = async (key: string, value: unknown): Promise<void> => {
		world.ops.push(`settings:${key}`);
		if (failWrites.has(key)) {
			if (key === SERVERS_SETTING_KEY && world.armSecretFailureOnServersWrite) {
				secretMutationsFail = true;
			}
			if (key === SERVERS_SETTING_KEY && world.armStoreFailureOnServersWrite) {
				secretStoresFail = true;
			}
			throw new Error(`write failed: ${key}`);
		}
		if (world.slowWrites) {
			await macrotask();
		}
		if (value === undefined) {
			settings.delete(key);
		} else {
			settings.set(key, value);
		}
		if (key === SERVERS_SETTING_KEY) {
			world.syncEngine?.requestSync();
		}
	};
	const access: SettingsAccess = {
		readGlobal: (key) => settings.get(key),
		readEffective: (key) => (workspaceValues.has(key) ? workspaceValues.get(key) : settings.get(key)),
		inspect: inspectOf,
		writeGlobal: (key, value) => inSettingsWriteTurn(() => writeUserValue(key, value)),
		// The flows never call it; a dashboard intent does, so the race tests reach it through the one turn.
		updateAuto: (key, value) => inSettingsWriteTurn(() => writeUserValue(key, value)),
		removeConfigured: async () => {
			throw new Error("removeConfigured is not part of the transfer flows");
		},
		readServersSetting: () => settings.get(SERVERS_SETTING_KEY),
		writeServersSetting: (write) => writeUserValue(SERVERS_SETTING_KEY, settingValueOf(write)),
		writeTurn: (apply) =>
			inSettingsWriteTurn((turn) =>
				apply(
					{
						writeGlobal: writeUserValue,
						updateAuto: writeUserValue,
						removeConfigured: access.removeConfigured,
						readServersSetting: access.readServersSetting,
						// Through the access object, so a test's patch of the servers write is honored inside a turn.
						writeServersSetting: (write) => access.writeServersSetting(write),
					},
					turn
				)
			),
		snapshotReader: () => ({ get: (key) => settings.get(key), inspect: inspectOf }),
	};
	const prompts: SettingsTransferPrompts = {
		confirmImport: async (summary) => {
			world.summaries.push(summary);
			return typeof world.answers.confirmImport === "function"
				? world.answers.confirmImport(summary)
				: world.answers.confirmImport;
		},
		resolveCollision: async (label, connectionChanged) => {
			world.collisionPrompts.push({ label, connectionChanged });
			return world.answers.collisions[label];
		},
		askRenamedLabel: async (suggested, validate) => {
			world.renamePrompts.push({ suggested, validate });
			return typeof world.answers.rename === "function"
				? world.answers.rename(suggested, validate)
				: world.answers.rename;
		},
		confirmUndo: async (snapshotAt) => {
			world.undoConfirmations.push(snapshotAt);
			return world.answers.confirmUndo;
		},
		notify: async (kind, message, actions = []) => {
			world.events.push("notify");
			world.notifications.push({
				kind,
				message,
				actions: actions.map((action) => action.label),
				run: async (label) => {
					await actions.find((action) => action.label === label)?.run();
				},
			});
		},
	};
	Object.assign(world, {
		answers: {
			confirmImport: true,
			confirmUndo: true,
			collisions: {},
			rename: undefined,
		},
		settings,
		workspaceValues,
		failWrites,
		armSecretFailureOnServersWrite: false,
		armStoreFailureOnServersWrite: false,
		failSecretStoreKeys: new Set<string>(),
		ops: [],
		syncEngine: undefined,
		slowWrites: false,
		secretValues,
		files,
		saveTarget: vscode.Uri.file("/tmp/fake-out/litellm-settings.json"),
		openTarget: undefined,
		sizeOverride: undefined,
		failFileWrite: false,
		failSnapshotWrite: false,
		snapshotSlot: undefined,
		notifications: [],
		summaries: [],
		collisionPrompts: [],
		renamePrompts: [],
		undoConfirmations: [],
		saveDialogs: [],
		events: [],
		revealed: [],
		logs: [],
		syncRequests: 0,
	} satisfies Omit<FakeWorld, "env">);
	world.env = {
		settings: access,
		prompts,
		readServerSecrets: (label) => readServerSecretsRecord(secretStore, label),
		updateServerSecret: (label, field, value, owner) => updateServerSecret(secretStore, label, field, value, owner),
		deleteServerSecrets: async (label) => secretStore.delete(serverSecretsKey(label)),
		readSnapshotSlot: async () => world.snapshotSlot,
		writeSnapshotSlot: async (serialized) => {
			if (world.failSnapshotWrite) {
				throw new Error("snapshot write failed");
			}
			world.snapshotSlot = serialized;
		},
		clearSnapshotSlot: async () => {
			world.snapshotSlot = undefined;
		},
		showSaveDialog: async (defaultUri, title) => {
			world.events.push("save-dialog");
			world.saveDialogs.push({ defaultUri, title });
			return world.saveTarget;
		},
		showOpenDialog: async () => world.openTarget,
		fileSize: async (uri) => world.sizeOverride ?? world.files.get(uri.toString())?.byteLength ?? 0,
		readFile: async (uri) => expectDefined(world.files.get(uri.toString()), "no fake file at the opened uri"),
		writeFile: async (uri, contents) => {
			world.events.push("write-file");
			if (world.failFileWrite) {
				throw new Error("file write failed");
			}
			world.files.set(uri.toString(), contents);
		},
		revealFile: async (uri) => {
			world.revealed.push(uri.toString());
		},
		homeDir: () => "/home/fake",
		extensionVersion: "9.9.9-test",
		requestServerSync: () => {
			world.ops.push("sync");
			world.syncRequests += 1;
			world.syncEngine?.requestSync();
		},
		withServerSyncHold: (run) => (world.syncEngine === undefined ? run() : world.syncEngine.withHold(run)),
		log: (message, data) => {
			world.logs.push(data === undefined ? message : `${message} ${JSON.stringify(data)}`);
		},
	};
	return world;
}

/** The label's stored secret VALUES as the map holds them right now; the ownership stamps ride ownersOf. */
function blobOf(world: FakeWorld, label: string): StoredServerSecrets {
	const raw = world.secretValues.get(serverSecretsKey(label));
	if (raw === undefined) {
		return {};
	}
	const { _owner, ...values } = JSON.parse(raw) as StoredServerSecrets & { _owner?: Record<string, string> };
	return values;
}

/** The label's ownership stamps as stored, for the stamping assertions. */
function ownersOf(world: FakeWorld, label: string): Record<string, unknown> {
	const raw = world.secretValues.get(serverSecretsKey(label));
	if (raw === undefined) {
		return {};
	}
	return (JSON.parse(raw) as { _owner?: Record<string, unknown> })._owner ?? {};
}

/** Point the open dialog at a fake file holding `contents`. */
function stageImportFile(world: FakeWorld, contents: string): void {
	const uri = vscode.Uri.file("/tmp/fake-in/import.json");
	world.files.set(uri.toString(), Buffer.from(contents, "utf8"));
	world.openTarget = uri;
}

function stageEnvelope(world: FakeWorld, settings: Record<string, unknown>): void {
	stageImportFile(world, JSON.stringify({ "litellm-vscode-chat": 1, exportedBy: "1.0.0", settings }));
}

/**
 * A dashboard write whose servers-setting write is held until `release`: the turn read the setting and is waiting on
 * the host, the window in which a flow's own write used to land over a stale read.
 */
function heldDashboardAppend(world: FakeWorld, entry: unknown): { turn: Promise<boolean>; release: () => void } {
	const original = world.env.settings.writeServersSetting;
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let holdNext = true;
	world.env.settings.writeServersSetting = async (write) => {
		if (holdNext) {
			holdNext = false;
			await held;
		}
		await original(write);
	};
	const turn = writeServersSettingFrom(world.env.settings, (fresh) => [...fresh, entry]);
	return { turn, release };
}

function serversWriteCount(world: FakeWorld): number {
	return world.ops.filter((op) => op === `settings:${SERVERS_SETTING_KEY}`).length;
}

// The servers key is refused by every keyed writer at the type level; the store methods are the one path. Each
// directive turns unused and fails the typecheck if a signature widens.
function directServersWritesDoNotCompile(settings: SettingsAccess): void {
	// @ts-expect-error the servers key is not a keyed write
	void settings.writeGlobal(SERVERS_SETTING_KEY, []);
	// @ts-expect-error the servers key is not a keyed write
	void settings.updateAuto(SERVERS_SETTING_KEY, []);
	// @ts-expect-error the servers key is not a keyed removal
	void settings.removeConfigured(SERVERS_SETTING_KEY);
	const widened: string = SERVERS_SETTING_KEY;
	// @ts-expect-error a string is not a setting id either; the writers take the closed vocabulary
	void settings.writeGlobal(widened, []);
}
void directServersWritesDoNotCompile;

function writtenExport(world: FakeWorld): string {
	const target = expectDefined(world.saveTarget, "the test staged no save target");
	return Buffer.from(expectDefined(world.files.get(target.toString()), "no export file was written")).toString("utf8");
}

function onlyNotification(world: FakeWorld): FakeNotification {
	assert.strictEqual(
		world.notifications.length,
		1,
		`expected one notification, got ${JSON.stringify(world.notifications)}`
	);
	return expectDefined(world.notifications[0]);
}

/**
 * The host as the engine sees it: add-only (a second add under a taken name is the duplicate refusal), and
 * refusing every add while `refusing` holds. Every add's args are kept, credentials included, because the
 * assertion is about which credential each add paired with which entry.
 */
function attachSyncEngine(world: FakeWorld): {
	engine: ServerSyncEngine;
	adds: Record<string, string>[];
	refusing: { value: boolean };
	settle(): Promise<void>;
} {
	const adds: Record<string, string>[] = [];
	const refusing = { value: false };
	const hostNames = new Set<string>();
	const recorded = makeSyncEnv();
	const engine = new ServerSyncEngine(
		{
			...recorded.env,
			readServersSetting: () => world.settings.get(SERVERS_SETTING_KEY),
			readSecrets: (label) => world.env.readServerSecrets(label),
			addProviderGroup: async (args) => {
				if (refusing.value) {
					throw new Error("host refused the group");
				}
				if (hostNames.has(args.name ?? "")) {
					throw new Error(`Language model group with name ${args.name} already exists for vendor litellm`);
				}
				hostNames.add(args.name ?? "");
				adds.push({ ...args });
			},
		},
		0
	);
	world.syncEngine = engine;
	return {
		engine,
		adds,
		refusing,
		settle: async () => {
			for (let i = 0; i < 10; i += 1) {
				await macrotask();
			}
		},
	};
}

/** The group args the host receives for label "a" at `baseUrl` with exactly `credentials`. */
const hostAdd = (baseUrl: string, credentials: Record<string, string>) => ({
	name: "a",
	vendor: VENDOR_ID,
	label: "a",
	baseUrl,
	...credentials,
});

suite("settingsTransferCommands export flow", () => {
	const CREDENTIALS_WARNING_KEY = "The file contains your server credentials in plain text, so keep it private.";

	test("nothing configured stops with an info toast before the save dialog", async () => {
		const world = makeWorld();
		await runExportSettingsFlow(world.env);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "info");
		assert.match(note.message, /nothing to export/);
		assert.deepStrictEqual(world.saveDialogs, []);
		assert.strictEqual(world.files.size, 0);
	});

	test("the warning shows before the save dialog: a dismissed dialog has seen it, and nothing else follows", async () => {
		// macOS shows no title on a save dialog, so the notice is the one warning a user there sees, and it must come
		// before the file exists.
		const world = makeWorld({ "chat.timeout": 5000 });
		world.saveTarget = undefined;
		await runExportSettingsFlow(world.env);
		assert.strictEqual(world.files.size, 0);
		assert.deepStrictEqual(
			{ notes: world.notifications.map((note) => [note.kind, note.message]), events: world.events },
			{ notes: [["info", CREDENTIALS_WARNING_KEY]], events: ["notify", "save-dialog"] }
		);
	});

	test("the save dialog defaults to litellm-settings.json in the home directory and carries the warning", async () => {
		const world = makeWorld({ "chat.timeout": 5000 });
		await runExportSettingsFlow(world.env);
		const dialog = expectDefined(world.saveDialogs[0]);
		assert.strictEqual(dialog.defaultUri.path, "/home/fake/litellm-settings.json");
		assert.strictEqual(dialog.title, CREDENTIALS_WARNING_KEY);
	});

	test("the file is the stored configuration, stored key at its field and URL unchanged; the warning precedes the counts", async () => {
		const world = makeWorld(
			{
				"chat.timeout": 5000,
				servers: [{ label: "a", baseUrl: "http://user:pass@x:4000" }],
			},
			{ a: { apiKey: "BLOB-SECRET" } }
		);
		await runExportSettingsFlow(world.env);
		const contents = writtenExport(world);
		assert.ok(contents.endsWith("\n"));
		assert.ok(contents.includes("\n\t"));
		const parsed = JSON.parse(contents) as { settings: Record<string, unknown> };
		assert.deepStrictEqual(parsed.settings, {
			"chat.timeout": 5000,
			servers: [{ label: "a", baseUrl: "http://user:pass@x:4000", auth: { apiKey: "BLOB-SECRET" } }],
		});
		assert.deepStrictEqual(
			{
				warned: world.notifications.map((note) => note.message.includes(CREDENTIALS_WARNING_KEY)),
				events: world.events,
			},
			{ warned: [true, false], events: ["notify", "save-dialog", "write-file", "notify"] }
		);
		const note = expectDefined(world.notifications[1]);
		assert.strictEqual(note.kind, "info");
		assert.match(note.message, /2 settings/);
		assert.match(note.message, /1 server\b/);
		assert.deepStrictEqual(note.actions, ["Reveal File"]);
	});

	test("unmaterialized secrets are counted in the summary", async () => {
		// An oauthClientSecret has no legal home in an entry without an oauth shape.
		const world = makeWorld(
			{ servers: [{ label: "a", baseUrl: "http://x:4000" }] },
			{ a: { oauthClientSecret: "HOMELESS-SECRET" } }
		);
		await runExportSettingsFlow(world.env);
		assert.ok(!writtenExport(world).includes("HOMELESS-SECRET"));
		assert.match(expectDefined(world.notifications[1]).message, /1 stored secret had no place/);
	});

	test("a write failure logs a classification and shows a localized error", async () => {
		const world = makeWorld({ "chat.timeout": 5000 });
		world.failFileWrite = true;
		await runExportSettingsFlow(world.env);
		const note = expectDefined(world.notifications[1]);
		assert.strictEqual(note.kind, "error");
		assert.match(note.message, /export failed/);
		assert.ok(world.logs.some((line) => line.startsWith("Settings export failed")));
	});
});

suite("settingsTransferCommands import flow", () => {
	test("a file that is foreign, newer, or has nothing valid in it is refused whole: one error, nothing written", async () => {
		// The whole outcome per refusal: the error names why, no preview is shown, and no setting, secret, snapshot,
		// or sync is touched. The nothing-valid case names what each entry failed on, field only, never a value.
		const cases: { name: string; contents: string; message: RegExp | string }[] = [
			{
				name: "not JSON",
				contents: "not json {{{",
				message: /^LiteLLM: This file is not a LiteLLM settings export\.$/,
			},
			{
				name: "foreign shape",
				contents: JSON.stringify({
					settings: { "chat.timeout": 60000 },
					servers: [{ label: "x", baseUrl: "http://x" }],
				}),
				message: /^LiteLLM: This file is not a LiteLLM settings export\.$/,
			},
			{
				name: "newer format",
				contents: JSON.stringify({
					"litellm-vscode-chat": 2,
					exportedBy: "3.1.4",
					settings: { "chat.timeout": 60000 },
				}),
				message: /exported by a newer version of the extension \(3\.1\.4\)/,
			},
			{
				name: "nothing valid",
				contents: JSON.stringify({
					"litellm-vscode-chat": 1,
					exportedBy: "1.0.0",
					settings: {
						"chat.timeout": "slow",
						servers: [{ baseUrl: "http://no-label" }, { label: "x", baseUrl: "nope", auth: { apiKey: "SECRET-X" } }],
					},
				}),
				message: [
					"LiteLLM: Nothing in this file can be imported.",
					"2 server entries were not imported: entry 1 is missing a label or baseUrl.",
					'"x" has a baseUrl that is not a URL with a host; the entry is not used until it is fixed.',
					"chat.timeout must be a whole number between 1000 and 2147483647. It will be skipped.",
				].join(" "),
			},
		];
		for (const { name, contents, message } of cases) {
			const world = makeWorld({ "chat.timeout": 9999 }, { x: { apiKey: "CURRENT" } });
			stageImportFile(world, contents);
			await runImportSettingsFlow(world.env);
			const note = onlyNotification(world);
			assert.strictEqual(note.kind, "error", name);
			if (typeof message === "string") {
				assert.strictEqual(note.message, message, name);
			} else {
				assert.match(note.message, message, name);
			}
			assert.ok(!`${note.message}${world.logs.join()}`.includes("SECRET-X"), name);
			assert.deepStrictEqual(world.summaries, [], `${name}: no preview is shown`);
			assert.deepStrictEqual(world.ops, [], `${name}: nothing is written, not even a sync request`);
			assert.strictEqual(world.settings.get("chat.timeout"), 9999, name);
			assert.strictEqual(world.snapshotSlot, undefined, name);
			assert.deepStrictEqual(blobOf(world, "x"), { apiKey: "CURRENT" }, name);
		}
	});

	test("a newer format version without exportedBy uses the generic message", async () => {
		const world = makeWorld();
		stageImportFile(world, JSON.stringify({ "litellm-vscode-chat": 2, settings: {} }));
		await runImportSettingsFlow(world.env);
		const note = onlyNotification(world);
		assert.match(note.message, /newer version/);
		assert.ok(!note.message.includes("(")); // no version parenthetical
	});

	test("files over the 5 MB cap are rejected before reading", async () => {
		const world = makeWorld();
		stageEnvelope(world, { "chat.timeout": 60000 });
		world.sizeOverride = 5 * 1024 * 1024 + 1;
		await runImportSettingsFlow(world.env);
		assert.match(onlyNotification(world).message, /too large/);
		assert.strictEqual(world.settings.get("chat.timeout"), undefined);
	});

	test("one of three entries failing validation drops that entry alone; the one warning names its field", async () => {
		// Before the contract a labeled entry the parser rejects landed as written and the completion toast said
		// nothing about it. Now the other two land, the dropped one's secret goes nowhere, and the warning says why.
		const world = makeWorld();
		stageEnvelope(world, {
			servers: [
				{ label: "a", baseUrl: "http://a:4000", auth: { apiKey: "KEY-A" } },
				{ label: "broken", baseUrl: "http://b:4000", auth: { apiKey: "KEY-B", extra: 1 } },
				{ label: "c", baseUrl: "http://c:4000" },
			],
		});
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [
			{ label: "a", baseUrl: "http://a:4000" },
			{ label: "c", baseUrl: "http://c:4000" },
		]);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "KEY-A" });
		assert.strictEqual(world.secretValues.get(serverSecretsKey("broken")), undefined);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning");
		assert.strictEqual(
			note.message,
			'LiteLLM: Settings import complete: 2 servers added. 1 server entry was not imported: "broken" has an unknown auth key "extra".'
		);
		assert.deepStrictEqual(note.actions, ["Undo Import"]);
		assert.ok(
			!`${JSON.stringify([...world.settings])}${world.logs.join()}${note.message}`.includes("KEY-B"),
			"the dropped entry's credential reaches nothing"
		);
		const summary = expectDefined(world.summaries[0]);
		assert.strictEqual(summary.serverCount, 2);
		assert.deepStrictEqual(summary.droppedLines, ['"broken" has an unknown auth key "extra".']);
		assert.strictEqual(summary.droppedCount, 1);
	});

	test("an accepted entry with an ignored header, an unsendable key, and an unknown key is kept as written and noted", async () => {
		// The parser accepts the entry, so it lands verbatim (the import repairs nothing it only reads); the one
		// warning carries each note by field, plus the file keys outside the setting vocabulary by name.
		const world = makeWorld();
		stageEnvelope(world, {
			unknownKey: 1,
			servers: [
				{
					label: "a",
					baseUrl: "http://a:4000",
					headers: { "x-bad": "line\nbreak" },
					auth: { apiKey: "KEY\nA" },
					colour: "red",
				},
			],
		});
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [
			{ label: "a", baseUrl: "http://a:4000", headers: { "x-bad": "line\nbreak" }, colour: "red" },
		]);
		assert.deepStrictEqual(blobOf(world, "a"), {});
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning");
		assert.strictEqual(
			note.message,
			[
				"LiteLLM: Settings import complete: 1 server added.",
				'Notes on the imported servers: "a" headers: Ignoring custom header whose value cannot be sent as an HTTP header ("x-bad").',
				'"a" has API key text that cannot be sent as an HTTP header; it is not imported, so enter it again afterwards.',
				'"a" has an unknown key "colour", ignored.',
				"1 unknown key was ignored: unknownKey.",
			].join(" ")
		);
		assert.deepStrictEqual(note.actions, ["Undo Import"]);
		const summary = expectDefined(world.summaries[0]);
		assert.strictEqual(summary.noteCount, 3);
		assert.strictEqual(summary.droppedCount, 0);
		assert.strictEqual(summary.unknownKeyCount, 1);
	});

	test("the preview summary carries counts, caps, and the connection-changed collisions", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] }, { a: { apiKey: "CURRENT" } });
		stageEnvelope(world, {
			"chat.timeout": 60000,
			"chat.promptCaching": true,
			"discovery.timeout": "wrong-type",
			unknownKey: 1,
			servers: [
				{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEXT" } },
				{ label: "b", baseUrl: "http://b:4000" },
				{ label: "broken" },
				{ baseUrl: "http://unlabeled" },
			],
		});
		world.answers.confirmImport = false;
		await runImportSettingsFlow(world.env);
		const summary = expectDefined(world.summaries[0]);
		assert.strictEqual(summary.settingCount, 2);
		assert.deepStrictEqual(summary.settingKeys, ["chat.timeout", "chat.promptCaching"]);
		assert.strictEqual(summary.serverCount, 2);
		assert.strictEqual(summary.collisionCount, 1);
		assert.strictEqual(summary.connectionChangedCount, 1);
		assert.strictEqual(summary.secretFieldCount, 1);
		assert.deepStrictEqual(summary.skippedKeys, ["discovery.timeout"]);
		assert.strictEqual(summary.unknownKeyCount, 1);
		assert.strictEqual(summary.droppedCount, 2);
		assert.deepStrictEqual(summary.droppedLines, [
			'"broken" is missing a label or baseUrl.',
			"entry 4 is missing a label or baseUrl.",
		]);
		assert.strictEqual(summary.noteCount, 0);
		// The preview was declined: nothing may be written.
		assert.strictEqual(world.settings.get("chat.timeout"), undefined);
		assert.strictEqual(world.snapshotSlot, undefined);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "CURRENT" });
	});

	test("a plain import appends new servers, moves secrets to storage, and requests a sync", async () => {
		const world = makeWorld({ "chat.timeout": 9999 });
		stageEnvelope(world, {
			"chat.timeout": 1234,
			servers: [{ label: "new", baseUrl: "http://new:4000", auth: { apiKey: "MOVED-SECRET" } }],
		});
		await runImportSettingsFlow(world.env);
		assert.strictEqual(world.settings.get("chat.timeout"), 1234);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [{ label: "new", baseUrl: "http://new:4000" }]);
		assert.deepStrictEqual(blobOf(world, "new"), { apiKey: "MOVED-SECRET" });
		// The import IS the deliberate pairing, so the moved value is stamped for the imported entry's destination.
		assert.deepStrictEqual(ownersOf(world, "new"), { apiKey: "http://new:4000" });
		assert.ok(world.syncRequests >= 1);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "info");
		assert.match(note.message, /1 setting written/);
		assert.match(note.message, /1 server added/);
		assert.deepStrictEqual(note.actions, ["Undo Import"]);
	});

	test("appending a label with no secrets in the file wipes an orphaned stored blob", async () => {
		// A blob can outlive its entry (the entry was removed, the blob stayed);
		// importing that label fresh must not hand the leftover credential to the
		// imported server.
		const world = makeWorld({}, { retired: { apiKey: "LEFTOVER-KEY", virtualKeyValue: "LEFTOVER-VK" } });
		stageEnvelope(world, { servers: [{ label: "retired", baseUrl: "http://r:4000" }] });
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [{ label: "retired", baseUrl: "http://r:4000" }]);
		assert.strictEqual(
			world.secretValues.get(serverSecretsKey("retired")),
			undefined,
			"the imported entry carries no secrets, so the label's stored blob must be gone"
		);
		assert.deepStrictEqual(world.collisionPrompts, [], "no settings entry exists, so nothing collides");
		assert.match(onlyNotification(world).message, /1 server added/);
	});

	test("appending a label with secrets in the file replaces an orphaned stored blob exactly", async () => {
		const world = makeWorld({}, { retired: { apiKey: "LEFTOVER-KEY", virtualKeyValue: "LEFTOVER-VK" } });
		stageEnvelope(world, {
			servers: [{ label: "retired", baseUrl: "http://r:4000", auth: { apiKey: "FILE-KEY" } }],
		});
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(
			blobOf(world, "retired"),
			{ apiKey: "FILE-KEY" },
			"the blob is exactly the file's secrets; no leftover field may survive"
		);
	});

	test("overwrite replaces the entry in place, replaces the blob, and clears stale fields", async () => {
		const world = makeWorld(
			{
				servers: [
					{ label: "a", baseUrl: "http://old:4000" },
					{ label: "b", baseUrl: "http://b:4000" },
				],
			},
			{ a: { apiKey: "OLD-KEY", virtualKeyValue: "STALE-VALUE" } }
		);
		stageEnvelope(world, { servers: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }] });
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [
			{ label: "a", baseUrl: "http://new:4000" },
			{ label: "b", baseUrl: "http://b:4000" },
		]);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "NEW-KEY" });
		assert.deepStrictEqual(expectDefined(world.collisionPrompts[0]), { label: "a", connectionChanged: true });
		assert.match(onlyNotification(world).message, /1 server overwritten/);
	});

	/** A world whose one entry "a" holds a stored key stamped for its current address. */
	function stampedWorld(): FakeWorld {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] });
		world.secretValues.set(
			serverSecretsKey("a"),
			JSON.stringify({ apiKey: "OLD-KEY", _owner: { apiKey: "http://old:4000" } })
		);
		return world;
	}

	test("an overwrite the file backs with no value always clears the stored key, stamped or not", async () => {
		// The fail-safe direction: a stored secret is never silently paired with imported configuration - re-pointed
		// address, stamped value, no prompt, no keep. The undo snapshot is the regret path.
		const stamped = stampedWorld();
		stageEnvelope(stamped, { servers: [{ label: "a", baseUrl: "http://new:4000" }] });
		stamped.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(stamped.env);
		assert.deepStrictEqual(stamped.settings.get(SERVERS_SETTING_KEY), [{ label: "a", baseUrl: "http://new:4000" }]);
		assert.deepStrictEqual(await stamped.env.readServerSecrets("a"), { values: {}, owners: {} });
		assert.match(onlyNotification(stamped).message, /1 server overwritten/);

		// An unstamped value predates stamping and clears the same way.
		const unstamped = makeWorld(
			{ servers: [{ label: "a", baseUrl: "http://old:4000" }] },
			{ a: { apiKey: "OLD-KEY" } }
		);
		stageEnvelope(unstamped, { servers: [{ label: "a", baseUrl: "http://new:4000" }] });
		unstamped.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(unstamped.env);
		assert.deepStrictEqual(blobOf(unstamped, "a"), {});
	});

	test("a value the file carries replaces the stored one instead of clearing", async () => {
		const world = stampedWorld();
		stageEnvelope(world, { servers: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }] });
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "NEW-KEY" });
	});

	test("a failed servers write rolls the stale-field clear back, value and stamp alike", async () => {
		const world = stampedWorld();
		stageEnvelope(world, { servers: [{ label: "a", baseUrl: "http://new:4000" }] });
		world.answers.collisions = { a: "overwrite" };
		world.failWrites.add(SERVERS_SETTING_KEY);
		await runImportSettingsFlow(world.env);

		assert.deepStrictEqual(await world.env.readServerSecrets("a"), {
			values: { apiKey: "OLD-KEY" },
			owners: { apiKey: "http://old:4000" },
		});
	});

	test("undo after an overwrite restores the cleared stored key, value and stamp alike", async () => {
		const world = stampedWorld();
		stageEnvelope(world, { servers: [{ label: "a", baseUrl: "http://new:4000" }] });
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(await world.env.readServerSecrets("a"), { values: {}, owners: {} });

		world.notifications = [];
		await runUndoLastImportFlow(world.env);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [{ label: "a", baseUrl: "http://old:4000" }]);
		assert.deepStrictEqual(await world.env.readServerSecrets("a"), {
			values: { apiKey: "OLD-KEY" },
			owners: { apiKey: "http://old:4000" },
		});
	});

	test("connectionChanged compares effective secret material through the stored blob", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://x:4000" }] }, { a: { apiKey: "SAME-KEY" } });
		stageEnvelope(world, { servers: [{ label: "a", baseUrl: "http://x:4000", auth: { apiKey: "SAME-KEY" } }] });
		world.answers.collisions = { a: "skip" };
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(expectDefined(world.collisionPrompts[0]), { label: "a", connectionChanged: false });
	});

	test("skip leaves the current entry and blob untouched", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] }, { a: { apiKey: "KEPT" } });
		stageEnvelope(world, { servers: [{ label: "a", baseUrl: "http://new:4000" }] });
		world.answers.collisions = { a: "skip" };
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [{ label: "a", baseUrl: "http://old:4000" }]);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "KEPT" });
		assert.match(onlyNotification(world).message, /1 server skipped/);
	});

	test("rename appends under the accepted label and validates the targets", async () => {
		const world = makeWorld({
			servers: [
				{ label: "a", baseUrl: "http://old:4000" },
				{ label: "taken", baseUrl: "http://t:4000" },
			],
		});
		stageEnvelope(world, {
			servers: [
				{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "RENAMED-SECRET" } },
				{ label: "sibling", baseUrl: "http://s:4000" },
			],
		});
		world.answers.collisions = { a: "rename" };
		world.answers.rename = (suggested) => suggested;
		await runImportSettingsFlow(world.env);
		const prompt = expectDefined(world.renamePrompts[0]);
		assert.strictEqual(prompt.suggested, "a-imported");
		assert.notStrictEqual(prompt.validate(""), undefined);
		assert.notStrictEqual(prompt.validate("__proto__"), undefined);
		assert.notStrictEqual(prompt.validate("taken"), undefined);
		assert.notStrictEqual(prompt.validate("sibling"), undefined);
		assert.strictEqual(prompt.validate("fresh"), undefined);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [
			{ label: "a", baseUrl: "http://old:4000" },
			{ label: "taken", baseUrl: "http://t:4000" },
			{ label: "a-imported", baseUrl: "http://new:4000" },
			{ label: "sibling", baseUrl: "http://s:4000" },
		]);
		assert.deepStrictEqual(blobOf(world, "a-imported"), { apiKey: "RENAMED-SECRET" });
		assert.deepStrictEqual(blobOf(world, "a"), {});
		const note = onlyNotification(world);
		assert.match(note.message, /1 server renamed/);
		assert.match(note.message, /1 server added/);
	});

	test("dismissing a collision prompt aborts the whole import with zero writes", async () => {
		const world = makeWorld(
			{
				"chat.timeout": 9999,
				servers: [
					{ label: "a", baseUrl: "http://a:4000" },
					{ label: "b", baseUrl: "http://b:4000" },
				],
			},
			{ b: { apiKey: "UNTOUCHED" } }
		);
		stageEnvelope(world, {
			"chat.timeout": 60000,
			servers: [
				{ label: "a", baseUrl: "http://new-a:4000" },
				{ label: "b", baseUrl: "http://new-b:4000" },
			],
		});
		world.answers.collisions = { a: "overwrite" }; // b unanswered -> dismissal
		await runImportSettingsFlow(world.env);
		assert.strictEqual(world.settings.get("chat.timeout"), 9999);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [
			{ label: "a", baseUrl: "http://a:4000" },
			{ label: "b", baseUrl: "http://b:4000" },
		]);
		assert.deepStrictEqual(blobOf(world, "b"), { apiKey: "UNTOUCHED" });
		assert.strictEqual(world.snapshotSlot, undefined);
		assert.deepStrictEqual(world.notifications, []);
	});

	test("dismissing the rename box aborts the whole import with zero writes", async () => {
		const world = makeWorld({ "chat.timeout": 9999, servers: [{ label: "a", baseUrl: "http://a:4000" }] });
		stageEnvelope(world, { "chat.timeout": 60000, servers: [{ label: "a", baseUrl: "http://new:4000" }] });
		world.answers.collisions = { a: "rename" };
		world.answers.rename = undefined;
		await runImportSettingsFlow(world.env);
		assert.strictEqual(world.settings.get("chat.timeout"), 9999);
		assert.strictEqual(world.snapshotSlot, undefined);
		assert.deepStrictEqual(world.notifications, []);
	});

	test("a failed snapshot write cancels the import before any mutation", async () => {
		const world = makeWorld({ "chat.timeout": 9999 });
		stageEnvelope(world, { "chat.timeout": 60000, servers: [{ label: "n", baseUrl: "http://n:4000" }] });
		world.failSnapshotWrite = true;
		await runImportSettingsFlow(world.env);
		assert.match(onlyNotification(world).message, /undo snapshot could not be saved/);
		assert.strictEqual(world.settings.get("chat.timeout"), 9999);
		assert.strictEqual(world.settings.get(SERVERS_SETTING_KEY), undefined);
		assert.deepStrictEqual(blobOf(world, "n"), {});
	});

	test("the snapshot records the pre-import state, key-absent included", async () => {
		const world = makeWorld(
			{ "chat.timeout": 9999, servers: [{ label: "a", baseUrl: "http://old:4000" }] },
			{ a: { apiKey: "PRE-KEY" } }
		);
		stageEnvelope(world, {
			"chat.timeout": 60000,
			"discovery.timeout": 2000,
			servers: [
				{ label: "a", baseUrl: "http://new:4000" },
				{ label: "added", baseUrl: "http://added:4000", auth: { apiKey: "ADDED" } },
			],
		});
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		const snapshot = JSON.parse(expectDefined(world.snapshotSlot)) as {
			settings: Record<string, { present: boolean; value?: unknown }>;
			blobs: Record<string, { present: boolean; value?: unknown }>;
		};
		assert.deepStrictEqual(snapshot.settings["chat.timeout"], { present: true, value: 9999 });
		assert.deepStrictEqual(snapshot.settings["discovery.timeout"], { present: false });
		assert.deepStrictEqual(snapshot.settings.servers, {
			present: true,
			value: [{ label: "a", baseUrl: "http://old:4000" }],
		});
		assert.deepStrictEqual(snapshot.blobs.a, { present: true, value: { apiKey: "PRE-KEY" } });
		assert.deepStrictEqual(snapshot.blobs.added, { present: false });
	});

	test("a failed servers write rolls back every recorded blob change", async () => {
		const world = makeWorld(
			{ servers: [{ label: "a", baseUrl: "http://old:4000" }] },
			{ a: { apiKey: "OLD-KEY", virtualKeyValue: "OLD-VK" } }
		);
		stageEnvelope(world, {
			"chat.timeout": 60000,
			servers: [
				{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } },
				{ label: "added", baseUrl: "http://added:4000", auth: { apiKey: "ADDED-KEY" } },
			],
		});
		world.answers.collisions = { a: "overwrite" };
		world.failWrites.add(SERVERS_SETTING_KEY);
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "OLD-KEY", virtualKeyValue: "OLD-VK" });
		assert.deepStrictEqual(blobOf(world, "added"), {});
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [{ label: "a", baseUrl: "http://old:4000" }]);
		// The scalar waits behind the servers unit, so the failed write leaves it unwritten and no snapshot to undo.
		assert.strictEqual(world.settings.get("chat.timeout"), undefined);
		assert.strictEqual(world.snapshotSlot, undefined);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "error");
		assert.match(note.message, /rolled back/);
		assert.deepStrictEqual(note.actions, []);
		assert.ok(world.syncRequests >= 1);
	});

	/**
	 * A failed rollback leaves the imported value under the pre-import entry, stamped for the imported destination;
	 * what the add-only host then receives is the outcome. The entry carries a pending retry (the host refused its
	 * first add).
	 *
	 *   re-pointed        -> the base URL changed, so the live entry refuses the key and makes no host call
	 *   same-destination  -> the live entry owns the key too, so its retry lands with the imported key
	 *   token-url-changed -> same base URL, another token URL: the live entry refuses the client secret
	 */
	const failedRollbackRecipes: Record<
		string,
		{
			initialServers: unknown[];
			initialBlob: StoredServerSecrets;
			imported: unknown[];
			residue: { blob: StoredServerSecrets; owners: Record<string, unknown> };
			expectedAdds: Record<string, string>[];
		}
	> = {
		"re-pointed": {
			initialServers: [{ label: "a", baseUrl: "http://old:4000" }],
			initialBlob: { apiKey: "OLD-KEY" },
			imported: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }],
			residue: { blob: { apiKey: "NEW-KEY" }, owners: { apiKey: "http://new:4000" } },
			expectedAdds: [],
		},
		"same-destination": {
			initialServers: [{ label: "a", baseUrl: "http://same:4000" }],
			initialBlob: { apiKey: "OLD-KEY" },
			imported: [{ label: "a", baseUrl: "http://same:4000", auth: { apiKey: "NEW-KEY" } }],
			residue: { blob: { apiKey: "NEW-KEY" }, owners: { apiKey: "http://same:4000" } },
			expectedAdds: [hostAdd("http://same:4000", { apiKey: "NEW-KEY" })],
		},
		"token-url-changed": {
			initialServers: [
				{
					label: "a",
					baseUrl: "http://same:4000",
					auth: { oauth: { tokenUrl: "https://old-idp.test/token", clientId: "cid" } },
				},
			],
			initialBlob: { oauthClientSecret: "OLD-SECRET" },
			imported: [
				{
					label: "a",
					baseUrl: "http://same:4000",
					auth: { oauth: { tokenUrl: "https://new-idp.test/token", clientId: "cid", clientSecret: "NEW-SECRET" } },
				},
			],
			residue: {
				blob: { oauthClientSecret: "NEW-SECRET" },
				owners: { oauthClientSecret: { tokenUrl: "https://new-idp.test/token", clientId: "cid" } },
			},
			expectedAdds: [],
		},
	};

	for (const [name, recipe] of Object.entries(failedRollbackRecipes)) {
		test(`a failed rollback leaves the imported value stamped for its own destination (${name})`, async () => {
			const world = makeWorld({ servers: recipe.initialServers }, { a: recipe.initialBlob });
			const host = attachSyncEngine(world);
			host.refusing.value = true;
			await host.engine.syncNow();
			host.refusing.value = false;
			stageEnvelope(world, { servers: recipe.imported });
			world.answers.collisions = { a: "overwrite" };
			world.failWrites.add(SERVERS_SETTING_KEY);
			world.armStoreFailureOnServersWrite = true;
			await runImportSettingsFlow(world.env);
			await host.settle();
			const note = onlyNotification(world);
			assert.strictEqual(note.kind, "error");
			assert.match(note.message, /could not be restored/);
			assert.deepStrictEqual(note.actions, ["Undo Import"]);
			assert.ok(world.logs.some((line) => line.includes("also failed")));
			assert.deepStrictEqual(blobOf(world, "a"), recipe.residue.blob);
			assert.deepStrictEqual(ownersOf(world, "a"), recipe.residue.owners);
			assert.deepStrictEqual(host.adds, recipe.expectedAdds, "the host's adds differ from the row's");
			host.engine.dispose();
		});
	}

	test("an unstamped blob under a label the import adds never reaches the host when its blob write fails", async () => {
		// The one input the blob-first order exists for: a blob no entry declares stays unstamped (SecretStorage cannot
		// enumerate it), and an unstamped value is trusted by whatever entry is live.
		const world = makeWorld({ servers: [] }, { retired: { apiKey: "OLD-KEY" } });
		const host = attachSyncEngine(world);
		stageEnvelope(world, { servers: [{ label: "retired", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }] });
		world.failSecretStoreKeys.add(serverSecretsKey("retired"));
		await runImportSettingsFlow(world.env);
		await host.settle();
		assert.deepStrictEqual(host.adds, [], "the old key must not ride with the imported entry");
		assert.deepStrictEqual(blobOf(world, "retired"), { apiKey: "OLD-KEY" });
		host.engine.dispose();
	});

	test("a mid-unit secret write failure rolls back the earlier labels and skips the servers write", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] }, { a: { apiKey: "OLD-KEY" } });
		stageEnvelope(world, {
			servers: [
				{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } },
				{ label: "b", baseUrl: "http://b:4000", auth: { apiKey: "B-KEY" } },
			],
		});
		world.answers.collisions = { a: "overwrite" };
		world.failSecretStoreKeys.add(serverSecretsKey("b"));
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "OLD-KEY" });
		assert.strictEqual(world.secretValues.get(serverSecretsKey("b")), undefined);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [{ label: "a", baseUrl: "http://old:4000" }]);
		assert.ok(!world.ops.includes(`settings:${SERVERS_SETTING_KEY}`), "the servers write must never be attempted");
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "error");
		assert.match(note.message, /rolled back/);
	});

	test("a servers setting that changed during the prompts aborts before the snapshot", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] });
		stageEnvelope(world, { "chat.timeout": 60000, servers: [{ label: "b", baseUrl: "http://b:4000" }] });
		world.answers.confirmImport = () => {
			// A concurrent edit lands while the preview modal is open.
			world.settings.set(SERVERS_SETTING_KEY, [{ label: "a", baseUrl: "http://edited:4000" }]);
			return true;
		};
		await runImportSettingsFlow(world.env);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning");
		assert.match(note.message, /changed while the import/);
		assert.strictEqual(world.snapshotSlot, undefined);
		assert.strictEqual(world.settings.get("chat.timeout"), undefined);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [{ label: "a", baseUrl: "http://edited:4000" }]);
	});

	test("an import that writes nothing keeps the previous snapshot and offers no undo", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] });
		world.snapshotSlot = "PREVIOUS-SNAPSHOT";
		stageEnvelope(world, { servers: [{ label: "a", baseUrl: "http://new:4000" }] });
		world.answers.collisions = { a: "skip" };
		await runImportSettingsFlow(world.env);
		assert.strictEqual(world.snapshotSlot, "PREVIOUS-SNAPSHOT", "a no-op run must not clobber the undo slot");
		const note = onlyNotification(world);
		assert.deepStrictEqual(note.actions, [], "a run that wrote nothing has nothing to undo");
		assert.match(note.message, /1 server skipped/);
		assert.deepStrictEqual(world.ops, ["sync"], "a no-op run writes nothing and only wakes the engine");
	});

	test("an import whose every write fails restores the previous snapshot and offers no undo", async () => {
		const world = makeWorld();
		world.snapshotSlot = "PREVIOUS-SNAPSHOT";
		stageEnvelope(world, { "chat.timeout": 60000 });
		world.failWrites.add("chat.timeout");
		await runImportSettingsFlow(world.env);
		assert.strictEqual(world.snapshotSlot, "PREVIOUS-SNAPSHOT", "a landed-nothing run must put the slot back");
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning");
		assert.match(note.message, /could not be written/);
		assert.deepStrictEqual(note.actions, [], "a run that landed nothing has nothing to undo");
	});

	test("a cleanly rolled-back servers unit with no landed settings restores the previous snapshot", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] }, { a: { apiKey: "OLD-KEY" } });
		world.snapshotSlot = "PREVIOUS-SNAPSHOT";
		stageEnvelope(world, { servers: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }] });
		world.answers.collisions = { a: "overwrite" };
		world.failWrites.add(SERVERS_SETTING_KEY);
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "OLD-KEY" });
		assert.strictEqual(world.snapshotSlot, "PREVIOUS-SNAPSHOT", "nothing changed, so the previous slot comes back");
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "error");
		assert.match(note.message, /rolled back/);
		assert.deepStrictEqual(note.actions, [], "nothing changed, so there is nothing to undo");
	});

	test("a UTF-8 BOM does not stop a valid export from importing", async () => {
		const world = makeWorld();
		stageImportFile(
			world,
			`\uFEFF${JSON.stringify({ "litellm-vscode-chat": 1, exportedBy: "1.0.0", settings: { "chat.timeout": 1234 } })}`
		);
		await runImportSettingsFlow(world.env);
		assert.strictEqual(world.settings.get("chat.timeout"), 1234);
	});

	test("failed non-servers writes are collected into a warning summary; the rest land", async () => {
		const world = makeWorld();
		stageEnvelope(world, { "chat.timeout": 60000, "discovery.timeout": 2000 });
		world.failWrites.add("chat.timeout");
		await runImportSettingsFlow(world.env);
		assert.strictEqual(world.settings.get("discovery.timeout"), 2000);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning");
		assert.match(note.message, /could not be written: chat\.timeout/);
		assert.match(note.message, /1 setting written/);
	});

	test("keys shadowed by workspace values are called out in the summary", async () => {
		const world = makeWorld();
		world.workspaceValues.set("chat.timeout", 42);
		stageEnvelope(world, { "chat.timeout": 60000 });
		await runImportSettingsFlow(world.env);
		assert.match(onlyNotification(world).message, /Workspace settings override chat\.timeout/);
	});

	test("an import racing a dashboard write turn lands behind it and refuses its stale merge instead of dropping an entry", async () => {
		// Both planned over [a]: the dashboard's append is waiting on the host when the import reaches its write. The
		// import's merge is derived from a read the dashboard's write invalidates, so writing it would lose one of
		// the two entries, whichever landed last. The refusal is a whole no-op: the file's scalar stays unwritten too.
		const a = { label: "a", baseUrl: "http://a:4000" };
		const b = { label: "b", baseUrl: "http://b:4000" };
		const world = makeWorld({ servers: [a], "chat.timeout": 5000 });
		stageEnvelope(world, { servers: [{ label: "c", baseUrl: "http://c:4000" }], "chat.timeout": 60000 });
		const dashboard = heldDashboardAppend(world, b);
		const imported = runImportSettingsFlow(world.env);
		await macrotask();
		dashboard.release();
		await Promise.all([dashboard.turn, imported]);

		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [a, b], "the dashboard's entry stands");
		assert.strictEqual(world.settings.get("chat.timeout"), 5000, "no scalar lands under a refused servers write");
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning", "the import must report the changed setting, not a success");
		assert.match(note.message, /changed while the import was running/);
		assert.deepStrictEqual(note.actions, [], "nothing to undo");
		assert.strictEqual(serversWriteCount(world), 1, "the merge over the stale read is never written");
		assert.strictEqual(world.snapshotSlot, undefined, "a run that changed nothing leaves no undo snapshot");
	});

	const importsKI = { label: "a", baseUrl: "http://new:4000", auth: { apiKey: "KI" } };
	test("a dashboard scalar write arriving during the import's turn lands after it, never under it", async () => {
		// The import writes servers [a, c] and chat.timeout 60000 in one turn. A dashboard intent asks for chat.timeout
		// 25000 while that turn runs (right after the servers replacement). Both writers take the one turn, so the
		// dashboard's write queues behind the import's and lands last; the import reports its own writes as landed.
		const a = { label: "a", baseUrl: "http://a:4000" };
		const c = { label: "c", baseUrl: "http://c:4000" };
		const world = makeWorld({ servers: [a], "chat.timeout": 5000 });
		stageEnvelope(world, { servers: [c], "chat.timeout": 60000 });
		const original = world.env.settings.writeServersSetting;
		let dashboardWrite: Promise<void> | undefined;
		world.env.settings.writeServersSetting = async (write) => {
			await original(write);
			dashboardWrite = world.env.settings.updateAuto("chat.timeout", 25000);
		};
		const slotWrites: string[] = [];
		const originalSlot = world.env.writeSnapshotSlot;
		world.env.writeSnapshotSlot = async (serialized) => {
			slotWrites.push(serialized);
			await originalSlot(serialized);
		};
		await runImportSettingsFlow(world.env);
		await dashboardWrite;

		assert.strictEqual(world.settings.get("chat.timeout"), 25000, "the newer dashboard write is never overwritten");
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [a, c]);
		assert.strictEqual(slotWrites.length, 1, "exactly one undo snapshot is saved");
		const snapshot = JSON.parse(expectDefined(slotWrites[0])) as {
			settings: Record<string, { present: boolean; value?: unknown }>;
		};
		assert.deepStrictEqual(snapshot.settings.servers, { present: true, value: [a] }, "it holds the pre-import servers");
		assert.deepStrictEqual(snapshot.settings["chat.timeout"], { present: true, value: 5000 });
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "info");
		assert.match(note.message, /1 setting written/);
		assert.deepStrictEqual(
			world.ops.filter((op) => op.startsWith("settings:")),
			[`settings:${SERVERS_SETTING_KEY}`, "settings:chat.timeout", "settings:chat.timeout"],
			"servers, the import's scalar, then the dashboard's scalar"
		);
	});

	for (const c of [
		{
			name: "leaves a different key a concurrent save stored",
			imported: importsKI,
			saved: { value: "KD", owner: undefined },
			blob: { apiKey: "KD" },
			owners: {},
		},
		{
			name: "leaves the same key a concurrent save stamped for its own destination",
			imported: importsKI,
			saved: { value: "KI", owner: "http://old:4000" },
			blob: { apiKey: "KI" },
			owners: { apiKey: "http://old:4000" },
		},
		{
			// The file spells the address in uppercase; the import stamps the canonical spelling it lands (a
			// parser-rejected entry never lands at all), and the rollback restores the pre-import key over it.
			name: "restores its own key under an entry whose file spelling is not the canonical one",
			imported: { label: "a", baseUrl: "HTTP://NEW:4000", auth: { apiKey: "KI" } },
			saved: undefined,
			blob: { apiKey: "K0" },
			owners: {},
		},
	]) {
		test(`a stale import's rollback ${c.name}`, async () => {
			// The import staged KI for a and was then refused, the setting having moved under it. The pre-import key is
			// restored only over the import's own value and stamp, never over what a save stored in between.
			const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] }, { a: { apiKey: "K0" } });
			stageEnvelope(world, { servers: [c.imported] });
			world.answers.collisions = { a: "overwrite" };
			const original = world.env.updateServerSecret;
			world.env.updateServerSecret = async (label, field, value, owner) => {
				await original(label, field, value, owner);
				if (label === "a" && value === "KI") {
					// The dashboard save: its key (when the case has one), then its setting write through the turn.
					if (c.saved !== undefined) {
						await original("a", "apiKey", c.saved.value, c.saved.owner);
					}
					await writeServersSettingFrom(world.env.settings, () => [
						{ label: "a", baseUrl: "http://old:4000", budget: 5 },
					]);
				}
			};
			await runImportSettingsFlow(world.env);

			assert.deepStrictEqual(blobOf(world, "a"), c.blob, "the field holds what the rollback must leave or restore");
			assert.deepStrictEqual(ownersOf(world, "a"), c.owners);
			assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [
				{ label: "a", baseUrl: "http://old:4000", budget: 5 },
			]);
			assert.match(onlyNotification(world).message, /changed while the import was running/);
		});
	}
});

suite("settingsTransferCommands undo flow", () => {
	test("no snapshot means an info toast and nothing else", async () => {
		const world = makeWorld({ "chat.timeout": 5 });
		await runUndoLastImportFlow(world.env);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "info");
		assert.match(note.message, /no settings import to undo/);
		assert.strictEqual(world.settings.get("chat.timeout"), 5);
	});

	test("a corrupt slot is cleared and reported", async () => {
		const world = makeWorld();
		world.snapshotSlot = "not json";
		await runUndoLastImportFlow(world.env);
		assert.strictEqual(world.snapshotSlot, undefined);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "error");
		assert.match(note.message, /could not be read/);
	});

	test("a structurally corrupt slot restores nothing", async () => {
		// The builder records EVERY vocabulary key; the blob-corruption cases carry that full cover so their specific
		// guards (not the partial-cover one) are what rejects them.
		const fullCover = () => Object.fromEntries(ALL_SETTING_KEYS.map((key) => [key, { present: false }]));
		const corruptSlots = [
			// a settings key outside the setting vocabulary.
			JSON.stringify({
				settings: { ...fullCover(), "not.a.setting": { present: true, value: 1 } },
				blobs: {},
				at: "t",
			}),
			// present without a value: would restore as a removal of a set key.
			JSON.stringify({ settings: { "chat.timeout": { present: true } }, blobs: {}, at: "t" }),
			// absent WITH a value: the flag cannot be trusted; "absent" deletes.
			JSON.stringify({ settings: { "chat.timeout": { present: false, value: 1 } }, blobs: {}, at: "t" }),
			// a partial settings record: the builder always writes the whole vocabulary, and restoring a subset would
			// leave the rest imported.
			JSON.stringify({ settings: {}, blobs: {}, at: "t" }),
			// an absent blob record carrying a value.
			JSON.stringify({ settings: fullCover(), blobs: { a: { present: false, value: { apiKey: "x" } } }, at: "t" }),
			// a blob field outside the secret vocabulary.
			JSON.stringify({ settings: fullCover(), blobs: { a: { present: true, value: { bogus: "x" } } }, at: "t" }),
			// a non-string blob value.
			JSON.stringify({ settings: fullCover(), blobs: { a: { present: true, value: { apiKey: 5 } } }, at: "t" }),
			// a present-but-empty blob (the builder records those as absent).
			JSON.stringify({ settings: fullCover(), blobs: { a: { present: true, value: {} } }, at: "t" }),
			// labels a real entry can never carry (untrimmed, empty): restoring one would write a SecretStorage key no
			// server entry can read.
			JSON.stringify({ settings: fullCover(), blobs: { " a": { present: true, value: { apiKey: "x" } } }, at: "t" }),
			JSON.stringify({ settings: fullCover(), blobs: { "": { present: false } }, at: "t" }),
		];
		for (const slot of corruptSlots) {
			const world = makeWorld({ "chat.timeout": 5 }, { a: { apiKey: "KEPT" } });
			world.snapshotSlot = slot;
			await runUndoLastImportFlow(world.env);
			assert.strictEqual(world.snapshotSlot, undefined, `slot must be cleared for ${slot}`);
			assert.strictEqual(onlyNotification(world).kind, "error");
			assert.strictEqual(world.settings.get("chat.timeout"), 5);
			assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "KEPT" });
			assert.deepStrictEqual(world.ops, [], `nothing may be written for ${slot}`);
		}
	});

	test("import then undo restores settings and blobs exactly, deleting appended labels' blobs", async () => {
		const initialSettings = {
			"chat.timeout": 9999,
			servers: [{ label: "a", baseUrl: "http://old:4000" }],
		};
		const world = makeWorld(initialSettings, { a: { apiKey: "PRE-KEY" } });
		stageEnvelope(world, {
			"chat.timeout": 60000,
			"discovery.timeout": 2000, // absent before: undo must REMOVE it
			servers: [
				{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } },
				{ label: "added", baseUrl: "http://added:4000", auth: { apiKey: "ADDED-KEY" } },
			],
		});
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		assert.strictEqual(world.settings.get("discovery.timeout"), 2000);
		world.notifications = [];

		await runUndoLastImportFlow(world.env);
		assert.deepStrictEqual(Object.fromEntries(world.settings), initialSettings);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "PRE-KEY" });
		assert.strictEqual(world.secretValues.get(serverSecretsKey("added")), undefined);
		assert.strictEqual(world.snapshotSlot, undefined);
		assert.ok(world.syncRequests >= 2);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "info");
		assert.match(note.message, /pre-import state/);
	});

	/**
	 * What the add-only host receives after an import whose add it refused (so the entry carries a pending retry) and
	 * the undo of that import: a pass runs only once the restore is whole, and every value it sends was recorded for
	 * the entry it rides with.
	 */
	const OAUTH_OLD = {
		label: "a",
		baseUrl: "http://old:4000",
		auth: { oauth: { tokenUrl: "http://auth:4000/token", clientId: "OLD-ID" } },
	};
	const OAUTH_NEW = {
		label: "a",
		baseUrl: "http://new:4000",
		auth: { oauth: { tokenUrl: "http://auth:4000/token", clientId: "NEW-ID", clientSecret: "NEW-SECRET" } },
	};
	const OLD_OAUTH_ADD = hostAdd("http://old:4000", {
		oauthTokenUrl: "http://auth:4000/token",
		oauthClientId: "OLD-ID",
		oauthClientSecret: "OLD-SECRET",
	});
	const mixedUndoRecipes: Record<
		string,
		{
			initialServers: unknown[];
			/** The pre-import blob for "a"; absent when the snapshot records none. */
			preImportSecret?: {
				field: "oauthClientSecret" | "apiKey";
				value: string;
				/** `legacy` is the token URL string older builds stamped a client secret with; the entry still uses it. */
				owner: "stamped" | "legacy" | { raw: string } | undefined;
			};
			imported: unknown[];
			/** When set, the undo's servers write fails, so nothing restores and the imported entry stays live. */
			failServersWrite?: true;
			/** Every add the host may see, whole and in order; a row that expects one says why beside it. */
			expectedAdds: Record<string, string>[];
		}
	> = {
		oauth: {
			initialServers: [OAUTH_OLD],
			preImportSecret: { field: "oauthClientSecret", value: "OLD-SECRET", owner: "stamped" },
			imported: [OAUTH_NEW],
			expectedAdds: [OLD_OAUTH_ADD],
		},
		unstamped: {
			initialServers: [{ label: "a", baseUrl: "http://old:4000" }],
			preImportSecret: { field: "apiKey", value: "OLD-KEY", owner: undefined },
			imported: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }],
			// Recorded without a stamp, restored stamped for the recorded entry.
			expectedAdds: [hostAdd("http://old:4000", { apiKey: "OLD-KEY" })],
		},
		orphan: {
			initialServers: [],
			preImportSecret: { field: "apiKey", value: "OLD-KEY", owner: undefined },
			imported: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }],
			// No entry was declared for the label, so the restored value rides with no add.
			expectedAdds: [],
		},
		"orphan-held": {
			initialServers: [],
			preImportSecret: { field: "apiKey", value: "OLD-KEY", owner: undefined },
			imported: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }],
			failServersWrite: true,
			expectedAdds: [hostAdd("http://new:4000", { apiKey: "NEW-KEY" })],
		},
		"oauth-held": {
			initialServers: [OAUTH_OLD],
			preImportSecret: { field: "oauthClientSecret", value: "OLD-SECRET", owner: "stamped" },
			imported: [OAUTH_NEW],
			failServersWrite: true,
			expectedAdds: [
				hostAdd("http://new:4000", {
					oauthTokenUrl: "http://auth:4000/token",
					oauthClientId: "NEW-ID",
					oauthClientSecret: "NEW-SECRET",
				}),
			],
		},
		legacy: {
			initialServers: [OAUTH_OLD],
			preImportSecret: { field: "oauthClientSecret", value: "OLD-SECRET", owner: "legacy" },
			imported: [OAUTH_NEW],
			expectedAdds: [OLD_OAUTH_ADD],
		},
		"dormant-oauth": {
			initialServers: [{ label: "a", baseUrl: "http://old:4000" }],
			preImportSecret: { field: "oauthClientSecret", value: "OLD-SECRET", owner: undefined },
			imported: [OAUTH_NEW],
			// The dormant value rides with its own entry, as buildGroupArgs always bakes a stored field it may resolve.
			expectedAdds: [hostAdd("http://old:4000", { oauthClientSecret: "OLD-SECRET" })],
		},
		absent: {
			initialServers: [{ label: "a", baseUrl: "http://old:4000" }],
			imported: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }],
			// No pre-import blob: the imported key is removed after the setting, so the old entry adds bare.
			expectedAdds: [hostAdd("http://old:4000", {})],
		},
		"legacy-collision": {
			initialServers: [
				{
					label: "a",
					baseUrl: "http://old:4000",
					auth: { oauth: { tokenUrl: "http://other:4000/token", clientId: "OLD-ID" } },
				},
			],
			// A token URL string stamp can spell the entry's own object form's JSON exactly; a string never matches a
			// structured stamp, so the restored entry cannot use this secret.
			preImportSecret: {
				field: "oauthClientSecret",
				value: "OLD-SECRET",
				owner: { raw: JSON.stringify({ tokenUrl: "http://other:4000/token", clientId: "OLD-ID" }) },
			},
			imported: [OAUTH_NEW],
			expectedAdds: [],
		},
		"same-destination": {
			initialServers: [{ label: "a", baseUrl: "http://same:4000" }],
			imported: [{ label: "a", baseUrl: "http://same:4000", auth: { apiKey: "NEW-KEY" } }],
			// The imported key's stamp names the restored entry too; only the hold keeps a pass from adding it
			// before the removal.
			expectedAdds: [hostAdd("http://same:4000", {})],
		},
	};

	for (const [name, recipe] of Object.entries(mixedUndoRecipes)) {
		test(`an interim pass during the undo pairs nothing mixed on the host (${name})`, async () => {
			const world = makeWorld({ servers: recipe.initialServers });
			if (recipe.preImportSecret !== undefined) {
				const { field, value, owner } = recipe.preImportSecret;
				const entry = acceptedEntry(recipe.initialServers, "a")?.entry;
				await world.env.updateServerSecret(
					"a",
					field,
					value,
					owner === "stamped"
						? secretDestination(expectDefined(entry), field)
						: owner === "legacy"
							? expectDefined(entry).oauthTokenUrl
							: owner?.raw
				);
			}
			const host = attachSyncEngine(world);
			host.refusing.value = true;
			await host.engine.syncNow();
			stageEnvelope(world, { servers: recipe.imported });
			world.answers.collisions = { a: "overwrite" };
			await runImportSettingsFlow(world.env);
			await host.settle();
			assert.deepStrictEqual(host.adds, [], "the host refused every add so far, so the entry carries a pending retry");

			host.refusing.value = false;
			world.slowWrites = true;
			if (recipe.failServersWrite) {
				world.failWrites.add(SERVERS_SETTING_KEY);
			}
			await runUndoLastImportFlow(world.env);
			await host.settle();
			assert.deepStrictEqual(host.adds, recipe.expectedAdds, "the host's adds differ from the row's");
			host.engine.dispose();
		});
	}

	test("a failed blob restore keeps the slot; the entry is back and refuses the imported blob it still holds", async () => {
		const world = makeWorld(
			{ "chat.timeout": 9999, servers: [{ label: "a", baseUrl: "http://old:4000" }] },
			{ a: { apiKey: "PRE-KEY" } }
		);
		stageEnvelope(world, {
			"chat.timeout": 60000,
			servers: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }],
		});
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		world.notifications = [];
		const syncRequestsAfterImport = world.syncRequests;

		world.failSecretStoreKeys.add(serverSecretsKey("a"));
		await runUndoLastImportFlow(world.env);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [{ label: "a", baseUrl: "http://old:4000" }]);
		assert.strictEqual(world.settings.get("chat.timeout"), 9999);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "NEW-KEY" }, "the failed restore never landed");
		assert.deepStrictEqual(ownersOf(world, "a"), { apiKey: "http://new:4000" }, "the stamp the restored entry refuses");
		assert.notStrictEqual(world.snapshotSlot, undefined, "the slot is kept for the retry");
		assert.strictEqual(world.syncRequests, syncRequestsAfterImport + 1, "what did restore earns its pass");
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning");
		assert.match(note.message, /snapshot was kept/);

		// The retry succeeds once the blob write can land again.
		world.failSecretStoreKeys.clear();
		world.notifications = [];
		await runUndoLastImportFlow(world.env);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "PRE-KEY" });
		assert.strictEqual(world.snapshotSlot, undefined);
	});

	test("a failed servers write restores nothing and keeps the slot; the retry restores entries and blobs together", async () => {
		const world = makeWorld(
			{ servers: [{ label: "kept", baseUrl: "http://k:4000" }] },
			{ kept: { apiKey: "KEPT-KEY" }, retired: { apiKey: "RETIRED-KEY" } }
		);
		stageEnvelope(world, {
			servers: [
				{ label: "kept", baseUrl: "http://k:4000" },
				{ label: "retired", baseUrl: "http://r:4000" },
			],
		});
		world.answers.collisions = { kept: "overwrite" };
		await runImportSettingsFlow(world.env);
		assert.strictEqual(world.secretValues.get(serverSecretsKey("retired")), undefined, "the import wiped the orphan");
		assert.deepStrictEqual(blobOf(world, "kept"), {}, "the import cleared the field its entry does not carry");
		world.notifications = [];
		world.ops = [];

		world.failWrites.add(SERVERS_SETTING_KEY);
		await runUndoLastImportFlow(world.env);
		assert.deepStrictEqual(
			world.ops,
			[`settings:${SERVERS_SETTING_KEY}`, "sync"],
			"the failed servers write is the only write; the flow still asks for its one pass"
		);
		assert.notStrictEqual(world.snapshotSlot, undefined, "the slot is kept for the retry");
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning");
		assert.match(note.message, /1 step failed/);

		// The retry restores the orphan blob and removes the imported entry together.
		world.failWrites.clear();
		world.notifications = [];
		await runUndoLastImportFlow(world.env);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [{ label: "kept", baseUrl: "http://k:4000" }]);
		assert.deepStrictEqual(blobOf(world, "retired"), { apiKey: "RETIRED-KEY" });
		assert.deepStrictEqual(blobOf(world, "kept"), { apiKey: "KEPT-KEY" });
		assert.strictEqual(world.snapshotSlot, undefined);
	});

	test("a settings phase that fails while the servers write lands keeps every restored blob", async () => {
		const world = makeWorld(
			{ "chat.timeout": 9999, servers: [{ label: "a", baseUrl: "http://old:4000" }] },
			{ a: { apiKey: "PRE-KEY" } }
		);
		stageEnvelope(world, {
			"chat.timeout": 60000,
			servers: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }],
		});
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		world.notifications = [];
		const syncsAfterImport = world.syncRequests;

		world.failWrites.add("chat.timeout");
		await runUndoLastImportFlow(world.env);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [{ label: "a", baseUrl: "http://old:4000" }]);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "PRE-KEY" }, "the entry is back, so its blob stays restored");
		assert.strictEqual(
			world.syncRequests,
			syncsAfterImport + 1,
			"the entries and blobs both restored, so this partial failure still wakes the engine"
		);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning");
		assert.match(note.message, /1 step failed/);
	});

	test("undo asks for confirmation with the snapshot time; declining restores nothing", async () => {
		const world = makeWorld({ "chat.timeout": 9999 });
		stageEnvelope(world, { "chat.timeout": 60000 });
		await runImportSettingsFlow(world.env);
		world.notifications = [];
		world.ops = [];

		world.answers.confirmUndo = false;
		await runUndoLastImportFlow(world.env);
		assert.strictEqual(world.undoConfirmations.length, 1);
		const shownAt = expectDefined(world.undoConfirmations[0]);
		assert.ok(!Number.isNaN(new Date(shownAt).getTime()), "the modal receives the snapshot's recorded instant");
		assert.deepStrictEqual(world.ops, [], "a declined confirmation restores nothing");
		assert.deepStrictEqual(world.notifications, [], "a declined confirmation aborts silently");
		assert.strictEqual(world.settings.get("chat.timeout"), 60000);
		assert.notStrictEqual(world.snapshotSlot, undefined, "the slot stays for a later undo");

		world.answers.confirmUndo = true;
		await runUndoLastImportFlow(world.env);
		assert.strictEqual(world.settings.get("chat.timeout"), 9999);
		assert.strictEqual(world.snapshotSlot, undefined);
	});

	test("undoing a connection-changing overwrite says the row will show the reconnect steps", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] }, { a: { apiKey: "PRE-KEY" } });
		stageEnvelope(world, {
			servers: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }],
		});
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		world.notifications = [];

		await runUndoLastImportFlow(world.env);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "info");
		assert.match(note.message, /pre-import state/);
		assert.match(note.message, /steps to reconnect/);
	});

	test("undoing a settings-only import carries no reconnect note", async () => {
		const world = makeWorld({ "chat.timeout": 9999 });
		stageEnvelope(world, { "chat.timeout": 60000 });
		await runImportSettingsFlow(world.env);
		world.notifications = [];
		await runUndoLastImportFlow(world.env);
		const note = onlyNotification(world);
		assert.match(note.message, /pre-import state/);
		assert.ok(!note.message.includes("reconnect"), "nothing reconnects, so nothing is said");
	});

	test("a stored value the entry's ownership stamp refuses does not count as a reconnect", async () => {
		// Import a connection change, then hand-edit the baseUrl back to the pre-import value (the settings file is
		// user-editable): the import's stored apiKey is now stamped for a destination the entry no longer names, so the
		// entry resolves it as absent. The undo deletes only that dormant value - effective connection material never
		// changes - so the note must not claim a reconnect.
		//
		//   A raw .values read -> would count it
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://w:4000" }] });
		stageEnvelope(world, {
			servers: [{ label: "a", baseUrl: "http://x:4000", auth: { apiKey: "NEW-KEY" } }],
		});
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(ownersOf(world, "a"), { apiKey: "http://x:4000" }, "the import stamped its write");
		world.settings.set(SERVERS_SETTING_KEY, [{ label: "a", baseUrl: "http://w:4000" }]);
		world.notifications = [];
		await runUndoLastImportFlow(world.env);
		const note = onlyNotification(world);
		assert.match(note.message, /pre-import state/);
		assert.ok(!note.message.includes("reconnect"), "a refused stored value is not connection material");
	});

	test("a snapshot value the pre-import entry's stamp refuses does not count as a reconnect", async () => {
		// The pre-import blob was dormant already: stamped for a destination the entry does not name, so neither the
		// pre-import nor the post-import entry ever resolved it. Clearing it between import and undo changes no
		// effective connection material, so restoring it is no reconnect.
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://x:4000" }] });
		world.secretValues.set(
			serverSecretsKey("a"),
			JSON.stringify({ apiKey: "DORMANT", _owner: { apiKey: "http://elsewhere:4000" } })
		);
		stageEnvelope(world, { servers: [{ label: "a", baseUrl: "http://x:4000" }] });
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		world.secretValues.delete(serverSecretsKey("a"));
		world.notifications = [];
		await runUndoLastImportFlow(world.env);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "DORMANT" }, "the undo restored the recorded blob");
		assert.deepStrictEqual(
			ownersOf(world, "a"),
			{ apiKey: "http://elsewhere:4000" },
			"the snapshot round-trips the stamp the refusal depends on"
		);
		const note = onlyNotification(world);
		assert.match(note.message, /pre-import state/);
		assert.ok(!note.message.includes("reconnect"), "a refused snapshot value is not connection material");
	});

	test("undo restores the whole blob, clearing fields the import added", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://x:4000" }] }, { a: { apiKey: "ONLY-KEY" } });
		stageEnvelope(world, {
			servers: [
				{
					label: "a",
					baseUrl: "http://x:4000",
					auth: { apiKey: "NEW-KEY", virtualKey: { header: "h", value: "NEW-VK" } },
				},
			],
		});
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "NEW-KEY", virtualKeyValue: "NEW-VK" });
		assert.deepStrictEqual(
			ownersOf(world, "a"),
			{ apiKey: "http://x:4000", virtualKeyValue: "http://x:4000" },
			"the import stamped its writes"
		);
		await runUndoLastImportFlow(world.env);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "ONLY-KEY" });
		assert.deepStrictEqual(ownersOf(world, "a"), { apiKey: "http://x:4000" });
	});

	test("a failed restore step keeps the slot for a retry and warns", async () => {
		const world = makeWorld({ "chat.timeout": 9999 });
		stageEnvelope(world, { "chat.timeout": 60000 });
		await runImportSettingsFlow(world.env);
		world.notifications = [];
		world.failWrites.add("chat.timeout");
		await runUndoLastImportFlow(world.env);
		assert.notStrictEqual(world.snapshotSlot, undefined);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning");
		assert.match(note.message, /snapshot was kept/);
		// The retry succeeds once the write can land again.
		world.failWrites.clear();
		world.notifications = [];
		await runUndoLastImportFlow(world.env);
		assert.strictEqual(world.settings.get("chat.timeout"), 9999);
		assert.strictEqual(world.snapshotSlot, undefined);
	});

	test("an undo racing a dashboard write turn lands behind it and keeps the snapshot instead of reverting the entry", async () => {
		// The undo planned its reconnect count over [a, c] while the dashboard's append of b was waiting on the host.
		// Restoring [a] over the landed [a, c, b] would silently revert the dashboard's write.
		const a = { label: "a", baseUrl: "http://a:4000" };
		const b = { label: "b", baseUrl: "http://b:4000" };
		const c = { label: "c", baseUrl: "http://c:4000" };
		const world = makeWorld({ servers: [a] });
		stageEnvelope(world, { servers: [c] });
		await runImportSettingsFlow(world.env);
		world.notifications = [];
		world.ops = [];
		const dashboard = heldDashboardAppend(world, b);
		const undone = runUndoLastImportFlow(world.env);
		await macrotask();
		dashboard.release();
		await Promise.all([dashboard.turn, undone]);

		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [a, c, b], "the dashboard's entry stands");
		assert.notStrictEqual(world.snapshotSlot, undefined, "the snapshot is kept for a retry");
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning");
		assert.match(note.message, /snapshot was kept/);
		assert.strictEqual(serversWriteCount(world), 1, "the restore over the moved setting is never written");
	});
});

suite("settingsTransferCommands secret hygiene", () => {
	const SENTINEL = "SENTINEL-SECRET-VALUE-1337";

	/** Everything user- or log-visible; the export file and SecretStorage are the only sanctioned homes. */
	function visibleSurfaces(world: FakeWorld): string {
		return JSON.stringify({
			logs: world.logs,
			notifications: world.notifications.map((note) => ({ ...note, run: undefined })),
			summaries: world.summaries,
			collisionPrompts: world.collisionPrompts,
			renameSuggestions: world.renamePrompts.map((prompt) => prompt.suggested),
			undoConfirmations: world.undoConfirmations,
		});
	}

	test("the export flow never leaks secret values outside the file", async () => {
		const world = makeWorld(
			{ servers: [{ label: "a", baseUrl: "http://x:4000", auth: { apiKey: SENTINEL } }] },
			{ a: { virtualKeyValue: SENTINEL } }
		);
		await runExportSettingsFlow(world.env);
		assert.ok(!visibleSurfaces(world).includes(SENTINEL));
	});

	test("the import and undo flows never leak secret values outside secret storage", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] }, { a: { apiKey: SENTINEL } });
		stageEnvelope(world, {
			servers: [
				{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: SENTINEL } },
				{ label: "b", baseUrl: "http://b:4000", auth: { apiKey: SENTINEL } },
				// An uncertifiable auth shape: the parser rejects it, the entry drops whole, and its text never lands in
				// the settings file.
				{ label: "m", baseUrl: "http://m:4000", auth: [{ apiKey: SENTINEL }] },
			],
		});
		world.answers.collisions = { a: "rename" };
		world.answers.rename = (suggested) => suggested;
		await runImportSettingsFlow(world.env);
		assert.ok(
			!JSON.stringify(Object.fromEntries(world.settings)).includes(SENTINEL),
			"imported secrets belong in secret storage, never the settings map"
		);
		assert.match(
			expectDefined(world.notifications[0]).message,
			/1 server entry was not imported: "m" has an auth value that is not an object\./
		);
		await runUndoLastImportFlow(world.env);
		assert.ok(!visibleSurfaces(world).includes(SENTINEL));
	});

	test("clearing a stamped stored key never leaks the value or its stamp beyond the label", async () => {
		// The overwrite clears a STAMPED live sentinel key; everything the user or the log sees carries the label
		// alone.
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] });
		world.secretValues.set(
			serverSecretsKey("a"),
			JSON.stringify({ apiKey: SENTINEL, _owner: { apiKey: "http://old:4000" } })
		);
		stageEnvelope(world, { servers: [{ label: "a", baseUrl: "http://new:4000" }] });
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		assert.deepStrictEqual(await world.env.readServerSecrets("a"), { values: {}, owners: {} });
		assert.ok(!visibleSurfaces(world).includes(SENTINEL));
		assert.ok(
			!JSON.stringify(Object.fromEntries(world.settings)).includes(SENTINEL),
			"the cleared value never lands in the settings map"
		);
	});

	test("failure paths never leak secret values either", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] }, { a: { apiKey: SENTINEL } });
		stageEnvelope(world, { servers: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: SENTINEL } }] });
		world.answers.collisions = { a: "overwrite" };
		world.failWrites.add(SERVERS_SETTING_KEY);
		world.armSecretFailureOnServersWrite = true;
		await runImportSettingsFlow(world.env);
		assert.ok(!visibleSurfaces(world).includes(SENTINEL));
	});
});

suite("settingsTransferCommands import preview", () => {
	test("each skipped key is named with the contract it failed, in the dashboard's own words", () => {
		// The preview used to say "1 setting has the wrong type" and never named chat.timeout or its range; a boolean or
		// enum key names its accepted values from the one spec.
		const summary: ImportPreviewSummary = {
			settingCount: 0,
			settingKeys: [],
			serverCount: 0,
			collisionCount: 0,
			connectionChangedCount: 0,
			secretFieldCount: 0,
			droppedLines: [],
			droppedCount: 0,
			noteLines: [],
			noteCount: 0,
			skippedKeys: ["chat.timeout", "usage.pollInterval", "chat.promptCaching", "usage.statusBar"],
			unknownKeyCount: 0,
		};
		const lines = renderImportPreview(summary).split("\n");
		assert.deepStrictEqual(lines, [
			"chat.timeout must be a whole number between 1000 and 2147483647. It will be skipped.",
			"usage.pollInterval must be a whole number between 30000 and 2147483647, or 0 to turn it off. It will be skipped.",
			"chat.promptCaching must be true or false. It will be skipped.",
			"usage.statusBar must be one of always, alerts-only, off. It will be skipped.",
		]);
	});
});
