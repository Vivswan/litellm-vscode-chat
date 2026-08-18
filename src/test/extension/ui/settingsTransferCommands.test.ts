import * as assert from "node:assert";
import * as vscode from "vscode";
import type { SecretStore, StoredServerSecrets } from "../../../extension/servers/serverSync";
import { readServerSecrets, updateServerSecret } from "../../../extension/servers/serverSync";
import type { SettingsAccess, SettingsInspection } from "../../../extension/settingsAccess";
import type {
	ImportPreviewSummary,
	SettingsTransferEnv,
	SettingsTransferPrompts,
} from "../../../extension/ui/settingsTransferCommands";
import {
	runExportSettingsFlow,
	runImportSettingsFlow,
	runUndoLastImportFlow,
} from "../../../extension/ui/settingsTransferCommands";
import { ALL_SETTING_KEYS, SERVERS_SETTING_KEY } from "../../../shared/config/settingSpec";
import { serverSecretsKey } from "../../../shared/config/storageKeys";
import { expectDefined } from "../../pureHelpers";

/** A recorded toast: kind, message, and the action labels it carried. */
interface FakeNotification {
	kind: "info" | "warning" | "error";
	message: string;
	actions: string[];
	run: (label: string) => Promise<void>;
}

/** The per-test prompt script; every field is mutable so a test sets only what it needs. */
interface PromptAnswers {
	confirmSecrets: "include" | "exclude" | undefined;
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
	/** SecretStorage keys whose store() fails (delete still works: a targeted mid-unit failure). */
	failSecretStoreKeys: Set<string>;
	/** Every mutation and sync request in arrival order: "settings:<key>", "secret-store:<key>", "secret-delete:<key>", "sync". */
	ops: string[];
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
	confirmSecretsCalls: number;
	saveDialogDefaults: vscode.Uri[];
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
	const world: FakeWorld = {} as FakeWorld;
	const secretStore: SecretStore = {
		get: async (key) => secretValues.get(key),
		store: async (key, value) => {
			world.ops.push(`secret-store:${key}`);
			if (secretMutationsFail || world.failSecretStoreKeys.has(key)) {
				throw new Error("secret store failed");
			}
			secretValues.set(key, value);
		},
		delete: async (key) => {
			world.ops.push(`secret-delete:${key}`);
			if (secretMutationsFail) {
				throw new Error("secret delete failed");
			}
			secretValues.delete(key);
		},
	};
	const access: SettingsAccess = {
		readGlobal: (key) => settings.get(key),
		readEffective: (key) => (workspaceValues.has(key) ? workspaceValues.get(key) : settings.get(key)),
		inspect: inspectOf,
		writeGlobal: async (key, value) => {
			world.ops.push(`settings:${key}`);
			if (failWrites.has(key)) {
				if (key === SERVERS_SETTING_KEY && world.armSecretFailureOnServersWrite) {
					secretMutationsFail = true;
				}
				throw new Error(`write failed: ${key}`);
			}
			if (value === undefined) {
				settings.delete(key);
			} else {
				settings.set(key, value);
			}
		},
		updateAuto: async () => {
			throw new Error("updateAuto is not part of the transfer flows");
		},
		removeConfigured: async () => {
			throw new Error("removeConfigured is not part of the transfer flows");
		},
		snapshotReader: () => ({ get: (key) => settings.get(key), inspect: inspectOf }),
	};
	const prompts: SettingsTransferPrompts = {
		confirmSecrets: async () => {
			world.confirmSecretsCalls += 1;
			return world.answers.confirmSecrets;
		},
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
		answers: { confirmSecrets: undefined, confirmImport: true, confirmUndo: true, collisions: {}, rename: undefined },
		settings,
		workspaceValues,
		failWrites,
		armSecretFailureOnServersWrite: false,
		failSecretStoreKeys: new Set<string>(),
		ops: [],
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
		confirmSecretsCalls: 0,
		saveDialogDefaults: [],
		revealed: [],
		logs: [],
		syncRequests: 0,
	} satisfies Omit<FakeWorld, "env">);
	world.env = {
		settings: access,
		prompts,
		readServerSecrets: (label) => readServerSecrets(secretStore, label),
		updateServerSecret: (label, field, value) => updateServerSecret(secretStore, label, field, value),
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
		showSaveDialog: async (defaultUri) => {
			world.saveDialogDefaults.push(defaultUri);
			return world.saveTarget;
		},
		showOpenDialog: async () => world.openTarget,
		fileSize: async (uri) => world.sizeOverride ?? world.files.get(uri.toString())?.byteLength ?? 0,
		readFile: async (uri) => expectDefined(world.files.get(uri.toString()), "no fake file at the opened uri"),
		writeFile: async (uri, contents) => {
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
		},
		log: (message, data) => {
			world.logs.push(data === undefined ? message : `${message} ${JSON.stringify(data)}`);
		},
	};
	return world;
}

/** The label's stored blob as the map holds it right now. */
function blobOf(world: FakeWorld, label: string): StoredServerSecrets {
	const raw = world.secretValues.get(serverSecretsKey(label));
	return raw === undefined ? {} : (JSON.parse(raw) as StoredServerSecrets);
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

suite("settingsTransferCommands export flow", () => {
	test("nothing configured stops with an info toast before the secrets prompt", async () => {
		const world = makeWorld();
		await runExportSettingsFlow(world.env);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "info");
		assert.match(note.message, /nothing to export/);
		assert.strictEqual(world.confirmSecretsCalls, 0);
		assert.strictEqual(world.files.size, 0);
	});

	test("dismissing the secrets prompt aborts silently", async () => {
		const world = makeWorld({ "chat.timeout": 5000 });
		world.answers.confirmSecrets = undefined;
		await runExportSettingsFlow(world.env);
		assert.strictEqual(world.confirmSecretsCalls, 1);
		assert.strictEqual(world.files.size, 0);
		assert.deepStrictEqual(world.notifications, []);
	});

	test("dismissing the save dialog aborts silently", async () => {
		const world = makeWorld({ "chat.timeout": 5000 });
		world.answers.confirmSecrets = "exclude";
		world.saveTarget = undefined;
		await runExportSettingsFlow(world.env);
		assert.strictEqual(world.files.size, 0);
		assert.deepStrictEqual(world.notifications, []);
	});

	test("the save dialog defaults to litellm-settings.json in the home directory", async () => {
		const world = makeWorld({ "chat.timeout": 5000 });
		world.answers.confirmSecrets = "exclude";
		await runExportSettingsFlow(world.env);
		assert.strictEqual(expectDefined(world.saveDialogDefaults[0]).path, "/home/fake/litellm-settings.json");
	});

	test("exclude strips inline secrets with no placeholders and writes tab-indented JSON", async () => {
		const world = makeWorld({
			"chat.timeout": 5000,
			servers: [{ label: "a", baseUrl: "http://x:4000", auth: { apiKey: "INLINE-SECRET" } }],
		});
		world.answers.confirmSecrets = "exclude";
		await runExportSettingsFlow(world.env);
		const contents = writtenExport(world);
		assert.ok(!contents.includes("INLINE-SECRET"));
		assert.ok(!contents.includes("apiKey"), "no placeholder may remain for a stripped secret");
		assert.ok(contents.endsWith("\n"));
		assert.ok(contents.includes("\n\t"));
		const parsed = JSON.parse(contents) as { settings: Record<string, unknown> };
		assert.deepStrictEqual(parsed.settings.servers, [{ label: "a", baseUrl: "http://x:4000" }]);
		const note = onlyNotification(world);
		assert.match(note.message, /2 settings/);
		assert.match(note.message, /1 server\b/);
		assert.ok(!note.message.includes("plaintext"));
		assert.deepStrictEqual(note.actions, ["Reveal File"]);
	});

	test("include materializes the stored blob and appends the plaintext reminder", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://x:4000" }] }, { a: { apiKey: "BLOB-SECRET" } });
		world.answers.confirmSecrets = "include";
		await runExportSettingsFlow(world.env);
		const parsed = JSON.parse(writtenExport(world)) as { settings: { servers: [{ auth: { apiKey: string } }] } };
		assert.strictEqual(parsed.settings.servers[0].auth.apiKey, "BLOB-SECRET");
		const note = onlyNotification(world);
		assert.match(note.message, /plaintext/);
	});

	test("unmaterialized secrets are counted in the include summary", async () => {
		// An oauthClientSecret has no legal home in an entry without an oauth shape.
		const world = makeWorld(
			{ servers: [{ label: "a", baseUrl: "http://x:4000" }] },
			{ a: { oauthClientSecret: "HOMELESS-SECRET" } }
		);
		world.answers.confirmSecrets = "include";
		await runExportSettingsFlow(world.env);
		assert.ok(!writtenExport(world).includes("HOMELESS-SECRET"));
		assert.match(onlyNotification(world).message, /1 stored secret had no place/);
	});

	test("unsanitizable shapes are omitted from a no-secrets export and counted", async () => {
		const world = makeWorld({ servers: [42, { label: "a", baseUrl: "http://x:4000" }] });
		world.answers.confirmSecrets = "exclude";
		await runExportSettingsFlow(world.env);
		const parsed = JSON.parse(writtenExport(world)) as { settings: { servers: unknown[] } };
		assert.deepStrictEqual(parsed.settings.servers, [{ label: "a", baseUrl: "http://x:4000" }]);
		assert.match(onlyNotification(world).message, /1 unrecognized part/);
	});

	test("a write failure logs a classification and shows a localized error", async () => {
		const world = makeWorld({ "chat.timeout": 5000 });
		world.answers.confirmSecrets = "exclude";
		world.failFileWrite = true;
		await runExportSettingsFlow(world.env);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "error");
		assert.match(note.message, /export failed/);
		assert.ok(world.logs.some((line) => line.startsWith("Settings export failed")));
	});
});

suite("settingsTransferCommands import flow", () => {
	test("a file that is not JSON is rejected", async () => {
		const world = makeWorld();
		stageImportFile(world, "not json {{{");
		await runImportSettingsFlow(world.env);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "error");
		assert.match(note.message, /not a LiteLLM settings export/);
		assert.strictEqual(world.snapshotSlot, undefined);
	});

	test("JSON without the envelope discriminant is rejected", async () => {
		const world = makeWorld();
		stageImportFile(world, JSON.stringify({ settings: { "chat.timeout": 1 } }));
		await runImportSettingsFlow(world.env);
		assert.match(onlyNotification(world).message, /not a LiteLLM settings export/);
	});

	test("a newer format version names exportedBy when present", async () => {
		const world = makeWorld();
		stageImportFile(world, JSON.stringify({ "litellm-vscode-chat": 2, exportedBy: "3.1.4", settings: {} }));
		await runImportSettingsFlow(world.env);
		const note = onlyNotification(world);
		assert.match(note.message, /newer version/);
		assert.match(note.message, /3\.1\.4/);
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
		stageEnvelope(world, { "chat.timeout": 1 });
		world.sizeOverride = 5 * 1024 * 1024 + 1;
		await runImportSettingsFlow(world.env);
		assert.match(onlyNotification(world).message, /too large/);
		assert.strictEqual(world.settings.get("chat.timeout"), undefined);
	});

	test("a file with nothing importable stops with an info toast", async () => {
		const world = makeWorld();
		stageEnvelope(world, { servers: [{ baseUrl: "http://no-label" }] });
		await runImportSettingsFlow(world.env);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "info");
		assert.match(note.message, /no importable settings/);
	});

	test("the preview summary carries counts, caps, and the connection-changed collisions", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] }, { a: { apiKey: "CURRENT" } });
		stageEnvelope(world, {
			"chat.timeout": 1,
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
		assert.strictEqual(summary.serverCount, 3);
		assert.strictEqual(summary.collisionCount, 1);
		assert.strictEqual(summary.connectionChangedCount, 1);
		assert.strictEqual(summary.secretFieldCount, 1);
		assert.strictEqual(summary.skippedKeyCount, 1);
		assert.strictEqual(summary.unknownKeyCount, 1);
		assert.strictEqual(summary.skippedServerCount, 1);
		assert.ok(summary.problemCount > 0);
		assert.ok(summary.problemLines.length <= 5);
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
			"chat.timeout": 1,
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
		stageEnvelope(world, { "chat.timeout": 1, servers: [{ label: "a", baseUrl: "http://new:4000" }] });
		world.answers.collisions = { a: "rename" };
		world.answers.rename = undefined;
		await runImportSettingsFlow(world.env);
		assert.strictEqual(world.settings.get("chat.timeout"), 9999);
		assert.strictEqual(world.snapshotSlot, undefined);
		assert.deepStrictEqual(world.notifications, []);
	});

	test("a failed snapshot write cancels the import before any mutation", async () => {
		const world = makeWorld({ "chat.timeout": 9999 });
		stageEnvelope(world, { "chat.timeout": 1, servers: [{ label: "n", baseUrl: "http://n:4000" }] });
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
			"chat.timeout": 1,
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
			"chat.timeout": 1,
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
		// The non-servers write already landed; the snapshot and Undo action cover it.
		assert.strictEqual(world.settings.get("chat.timeout"), 1);
		assert.notStrictEqual(world.snapshotSlot, undefined);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "error");
		assert.match(note.message, /rolled back/);
		assert.match(note.message, /Other settings from the file were already written/);
		assert.deepStrictEqual(note.actions, ["Undo Import"]);
		assert.ok(world.syncRequests >= 1);
	});

	test("a rollback that also fails escalates with the restore-failure message", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] }, { a: { apiKey: "OLD-KEY" } });
		stageEnvelope(world, { servers: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }] });
		world.answers.collisions = { a: "overwrite" };
		world.failWrites.add(SERVERS_SETTING_KEY);
		world.armSecretFailureOnServersWrite = true;
		await runImportSettingsFlow(world.env);
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "error");
		assert.match(note.message, /could not be restored/);
		assert.deepStrictEqual(note.actions, ["Undo Import"]);
		assert.ok(world.logs.some((line) => line.includes("also failed")));
	});

	test("the servers unit writes every secret before the single servers write", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] });
		stageEnvelope(world, {
			servers: [
				{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "A-KEY" } },
				{ label: "b", baseUrl: "http://b:4000", auth: { apiKey: "B-KEY" } },
			],
		});
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		const serversWrite = world.ops.indexOf(`settings:${SERVERS_SETTING_KEY}`);
		assert.notStrictEqual(serversWrite, -1);
		const secretOps = world.ops.filter((op) => op.startsWith("secret-"));
		assert.strictEqual(secretOps.length, 2);
		for (const op of secretOps) {
			assert.ok(world.ops.indexOf(op) < serversWrite, `secret op ${op} must precede the servers write`);
		}
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
		stageEnvelope(world, { "chat.timeout": 1, servers: [{ label: "b", baseUrl: "http://b:4000" }] });
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
		stageEnvelope(world, { "chat.timeout": 1 });
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
		stageEnvelope(world, { "chat.timeout": 1, "discovery.timeout": 2000 });
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
		stageEnvelope(world, { "chat.timeout": 1 });
		await runImportSettingsFlow(world.env);
		assert.match(onlyNotification(world).message, /Workspace settings override chat\.timeout/);
	});
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
		// The builder records EVERY vocabulary key; the blob-corruption cases
		// carry that full cover so their specific guards (not the partial-cover
		// one) are what rejects them.
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
			// a partial settings record: the builder always writes the whole
			// vocabulary, and restoring a subset would leave the rest imported.
			JSON.stringify({ settings: {}, blobs: {}, at: "t" }),
			// an absent blob record carrying a value.
			JSON.stringify({ settings: fullCover(), blobs: { a: { present: false, value: { apiKey: "x" } } }, at: "t" }),
			// a blob field outside the secret vocabulary.
			JSON.stringify({ settings: fullCover(), blobs: { a: { present: true, value: { bogus: "x" } } }, at: "t" }),
			// a non-string blob value.
			JSON.stringify({ settings: fullCover(), blobs: { a: { present: true, value: { apiKey: 5 } } }, at: "t" }),
			// a present-but-empty blob (the builder records those as absent).
			JSON.stringify({ settings: fullCover(), blobs: { a: { present: true, value: {} } }, at: "t" }),
			// labels a real entry can never carry (untrimmed, empty): restoring
			// one would write a SecretStorage key no server entry can read.
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
			"chat.timeout": 1,
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

	test("undo restores blobs before settings, mirroring the import's adopt ordering", async () => {
		// The servers settings write is what wakes the sync engine; the blobs
		// must already hold their pre-import values when it lands.
		const world = makeWorld(
			{ "chat.timeout": 9999, servers: [{ label: "a", baseUrl: "http://old:4000" }] },
			{ a: { apiKey: "PRE-KEY" } }
		);
		stageEnvelope(world, {
			"chat.timeout": 1,
			servers: [
				{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } },
				{ label: "added", baseUrl: "http://added:4000", auth: { apiKey: "ADDED-KEY" } },
			],
		});
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		world.ops = [];

		await runUndoLastImportFlow(world.env);
		const secretOps = world.ops.filter((op) => op.startsWith("secret-"));
		const settingOps = world.ops.filter((op) => op.startsWith("settings:"));
		assert.ok(secretOps.length > 0, "the undo must restore blobs");
		assert.ok(settingOps.includes(`settings:${SERVERS_SETTING_KEY}`));
		const firstSetting = world.ops.findIndex((op) => op.startsWith("settings:"));
		const lastSecret = world.ops.length - 1 - [...world.ops].reverse().findIndex((op) => op.startsWith("secret-"));
		assert.ok(lastSecret < firstSetting, "every blob restore must precede every settings write");
	});

	test("a failed blob restore stops the undo before the settings phase", async () => {
		// Writing the servers setting over partially restored credentials would
		// wake the sync engine against a mismatched state; the settings phase
		// must not start, and the kept slot lets a retry finish the job.
		const world = makeWorld(
			{ "chat.timeout": 9999, servers: [{ label: "a", baseUrl: "http://old:4000" }] },
			{ a: { apiKey: "PRE-KEY" } }
		);
		stageEnvelope(world, {
			"chat.timeout": 1,
			servers: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }],
		});
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		world.notifications = [];
		world.ops = [];
		const syncRequestsAfterImport = world.syncRequests;

		world.failSecretStoreKeys.add(serverSecretsKey("a"));
		await runUndoLastImportFlow(world.env);
		assert.ok(!world.ops.some((op) => op.startsWith("settings:")), "no settings write may follow a blob failure");
		assert.strictEqual(world.settings.get("chat.timeout"), 1, "the imported settings stay until the retry");
		assert.strictEqual(
			world.secretValues.get(serverSecretsKey("a")),
			undefined,
			"the abandoned restore leaves no blob under the still-imported entry"
		);
		assert.notStrictEqual(world.snapshotSlot, undefined, "the slot is kept for the retry");
		assert.strictEqual(world.syncRequests, syncRequestsAfterImport, "nothing woke the engine, so nothing re-syncs");
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning");
		assert.match(note.message, /snapshot was kept/);

		// The retry succeeds once the blob write can land again.
		world.failSecretStoreKeys.clear();
		world.notifications = [];
		await runUndoLastImportFlow(world.env);
		assert.strictEqual(world.settings.get("chat.timeout"), 9999);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "PRE-KEY" });
		assert.strictEqual(world.snapshotSlot, undefined);
	});

	test("a failed settings phase re-clears restored blobs whose entries did not restore", async () => {
		// Blobs restore before settings; when the servers write then fails, the
		// imported entries are still live, and a restored pre-import blob under
		// one of them would hand a retired credential to the imported host.
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
		world.notifications = [];
		world.ops = [];

		world.failWrites.add(SERVERS_SETTING_KEY);
		await runUndoLastImportFlow(world.env);
		assert.strictEqual(
			world.secretValues.get(serverSecretsKey("retired")),
			undefined,
			"the restored orphan blob must be cleared again while its imported entry is still live"
		);
		assert.deepStrictEqual(
			blobOf(world, "kept"),
			{ apiKey: "KEPT-KEY" },
			"a label whose live entry already matches the snapshot keeps its restored blob"
		);
		assert.notStrictEqual(world.snapshotSlot, undefined, "the slot is kept for the retry");
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning");
		assert.match(note.message, /snapshot was kept/);
		const lastDelete = world.ops.lastIndexOf(`secret-delete:${serverSecretsKey("retired")}`);
		assert.ok(lastDelete !== -1 && lastDelete < world.ops.indexOf("sync"), "the re-clear precedes waking the engine");

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
		// The false-positive direction: the entries are back, so the restored
		// credentials belong exactly where they are and nothing may clear them.
		const world = makeWorld(
			{ "chat.timeout": 9999, servers: [{ label: "a", baseUrl: "http://old:4000" }] },
			{ a: { apiKey: "PRE-KEY" } }
		);
		stageEnvelope(world, {
			"chat.timeout": 1,
			servers: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }],
		});
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		world.notifications = [];

		world.failWrites.add("chat.timeout");
		await runUndoLastImportFlow(world.env);
		assert.deepStrictEqual(world.settings.get(SERVERS_SETTING_KEY), [{ label: "a", baseUrl: "http://old:4000" }]);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "PRE-KEY" }, "the entry is back, so its blob stays restored");
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning");
		assert.match(note.message, /1 step failed/);
	});

	test("a re-clear that itself fails counts into the kept-snapshot warning", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] }, { a: { apiKey: "PRE-KEY" } });
		stageEnvelope(world, {
			servers: [{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: "NEW-KEY" } }],
		});
		world.answers.collisions = { a: "overwrite" };
		await runImportSettingsFlow(world.env);
		world.notifications = [];

		// The servers write fails, and its failure arms the secret store, so the
		// re-clear of the label's restored blob fails too.
		world.failWrites.add(SERVERS_SETTING_KEY);
		world.armSecretFailureOnServersWrite = true;
		await runUndoLastImportFlow(world.env);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "PRE-KEY" }, "the clear failed, so the blob is still there");
		const note = onlyNotification(world);
		assert.strictEqual(note.kind, "warning");
		assert.match(note.message, /2 steps failed/, "the unmitigated hazard is counted, not silent");
		assert.notStrictEqual(world.snapshotSlot, undefined, "the slot is kept for the retry");
		assert.ok(world.logs.some((line) => line.includes("re-clearing a restored secret")));
	});

	test("undo asks for confirmation with the snapshot time; declining restores nothing", async () => {
		const world = makeWorld({ "chat.timeout": 9999 });
		stageEnvelope(world, { "chat.timeout": 1 });
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
		assert.strictEqual(world.settings.get("chat.timeout"), 1);
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
		stageEnvelope(world, { "chat.timeout": 1 });
		await runImportSettingsFlow(world.env);
		world.notifications = [];
		await runUndoLastImportFlow(world.env);
		const note = onlyNotification(world);
		assert.match(note.message, /pre-import state/);
		assert.ok(!note.message.includes("reconnect"), "nothing reconnects, so nothing is said");
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
		await runUndoLastImportFlow(world.env);
		assert.deepStrictEqual(blobOf(world, "a"), { apiKey: "ONLY-KEY" });
	});

	test("a failed restore step keeps the slot for a retry and warns", async () => {
		const world = makeWorld({ "chat.timeout": 9999 });
		stageEnvelope(world, { "chat.timeout": 1 });
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
		world.answers.confirmSecrets = "include";
		await runExportSettingsFlow(world.env);
		assert.ok(!visibleSurfaces(world).includes(SENTINEL));
	});

	test("the import and undo flows never leak secret values outside secret storage", async () => {
		const world = makeWorld({ servers: [{ label: "a", baseUrl: "http://old:4000" }] }, { a: { apiKey: SENTINEL } });
		stageEnvelope(world, {
			servers: [
				{ label: "a", baseUrl: "http://new:4000", auth: { apiKey: SENTINEL } },
				{ label: "b", baseUrl: "http://b:4000", auth: { apiKey: SENTINEL } },
				// An uncertifiable auth shape: the entry skips whole, so its text
				// never lands in the settings file.
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
		assert.match(expectDefined(world.notifications[0]).message, /1 server skipped/);
		await runUndoLastImportFlow(world.env);
		assert.ok(!visibleSurfaces(world).includes(SENTINEL));
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
