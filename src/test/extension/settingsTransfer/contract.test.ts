import * as assert from "node:assert";
import type { StoredServerSecrets } from "../../../extension/servers/serverSync/secrets";
import type { ParseEnvelopeResult, SettingsExportEnvelope } from "../../../extension/settingsTransfer/envelope";
import {
	buildEnvelope,
	parseEnvelope,
	SETTINGS_EXPORT_FORMAT_VERSION,
} from "../../../extension/settingsTransfer/envelope";
import type { SettingsExportEnv, SettingsExportResult } from "../../../extension/settingsTransfer/exportBuild";
import { buildSettingsExport } from "../../../extension/settingsTransfer/exportBuild";
import type {
	CollisionDecision,
	CollisionDecisions,
	ImportApplication,
	ImportPlan,
	IncomingServer,
	SecretWrite,
	ServerCollision,
	SettingWrite,
	SkippedKey,
} from "../../../extension/settingsTransfer/importPlan";
import {
	planSettingsImport,
	resolveImportPlan,
	suggestRenamedLabel,
} from "../../../extension/settingsTransfer/importPlan";
import type { MaterializedEntry, StrippedEntry } from "../../../extension/settingsTransfer/secretSurgery";
import { materializeEntrySecrets, stripEntrySecrets } from "../../../extension/settingsTransfer/secretSurgery";
import type { PreImportSnapshot, SnapshotEntry, SnapshotRestore } from "../../../extension/settingsTransfer/snapshot";
import { buildPreImportSnapshot, planSnapshotRestore } from "../../../extension/settingsTransfer/snapshot";

/**
 * The frozen settings-transfer core contract. Every exported signature is
 * pinned at the type level - each function is assigned to an explicitly
 * written reference of its agreed shape, and every exported type (result
 * shapes included) backs a literal fixture, whose excess-property check
 * catches renamed, added, and removed fields alike - so a contract change
 * fails this file's compile, not a dependent worktree. The runtime
 * assertions only state that the bodies are still the throwing stubs; the
 * implementation replaces them with real suites.
 */

const UNIMPLEMENTED = /unimplemented/;

suite("extension/settingsTransfer: frozen stub contract", () => {
	test("envelope: the format version, the file shape, and both function signatures", () => {
		assert.strictEqual(SETTINGS_EXPORT_FORMAT_VERSION, 1);
		const envelope: SettingsExportEnvelope = {
			"litellm-vscode-chat": SETTINGS_EXPORT_FORMAT_VERSION,
			exportedBy: "0.0.0",
			settings: { servers: [] },
		};
		const verdicts: ParseEnvelopeResult[] = [
			{ ok: true, settings: envelope.settings, unknownKeys: [] },
			{ ok: false, reason: "not-json" },
			{ ok: false, reason: "not-an-export" },
			{ ok: false, reason: "newer-version" },
		];
		assert.strictEqual(verdicts.filter((verdict) => verdict.ok).length, 1);
		const build: (settings: Readonly<Record<string, unknown>>, exportedBy: string) => SettingsExportEnvelope =
			buildEnvelope;
		assert.throws(() => build({}, "0.0.0"), UNIMPLEMENTED);
		const parse: (raw: string) => ParseEnvelopeResult = parseEnvelope;
		assert.throws(() => parse("{}"), UNIMPLEMENTED);
	});

	test("secretSurgery: the strip and materialize signatures and their result shapes", () => {
		const stripped: StrippedEntry = {
			entry: { label: "A", baseUrl: "http://a.test" },
			secrets: { apiKey: "k" },
		};
		const materialized: MaterializedEntry = {
			entry: { label: "A", auth: { apiKey: "k" } },
			unmaterialized: 1,
		};
		assert.notDeepStrictEqual(stripped.entry, materialized.entry);
		const strip: (rawEntry: Readonly<Record<string, unknown>>) => StrippedEntry = stripEntrySecrets;
		assert.throws(() => strip({ label: "A", auth: { apiKey: "k" } }), UNIMPLEMENTED);
		const materialize: (rawEntry: Readonly<Record<string, unknown>>, blob: StoredServerSecrets) => MaterializedEntry =
			materializeEntrySecrets;
		assert.throws(() => materialize({ label: "A" }, { apiKey: "k" }), UNIMPLEMENTED);
	});

	test("exportBuild: the injected env, the result counts, and the signature", () => {
		const env: SettingsExportEnv = {
			readGlobalSetting: () => undefined,
			readServerSecrets: () => Promise.resolve({}),
			extensionVersion: "0.0.0",
			includeSecrets: false,
		};
		const result: SettingsExportResult = {
			envelope: { "litellm-vscode-chat": SETTINGS_EXPORT_FORMAT_VERSION, exportedBy: "0.0.0", settings: {} },
			settingCount: 1,
			serverCount: 1,
			secretFieldCount: 0,
			unmaterializedSecretCount: 0,
		};
		assert.strictEqual(result.envelope.exportedBy, env.extensionVersion);
		const build: (env: SettingsExportEnv) => Promise<SettingsExportResult> = buildSettingsExport;
		assert.throws(() => build(env), UNIMPLEMENTED);
	});

	test("importPlan: the plan, the decisions, and the application shapes", () => {
		const plan: (envelopeSettings: Readonly<Record<string, unknown>>, currentServersRaw: unknown) => ImportPlan =
			planSettingsImport;
		assert.throws(() => plan({}, undefined), UNIMPLEMENTED);

		const settingWrite: SettingWrite = { key: "chat.timeout", value: 60000 };
		const skipped: SkippedKey = { key: "chat.promptCaching", reason: "wrong-type" };
		const incoming: IncomingServer = {
			raw: { label: "A", baseUrl: "http://a.test" },
			report: { index: 0, label: "A", baseUrl: "http://a.test", problems: [], accepted: true },
			skipped: false,
		};
		const collision: ServerCollision = { label: "A", connectionChanged: true };
		const fixturePlan: ImportPlan = {
			settingsWrites: [settingWrite],
			skippedKeys: [skipped],
			incomingServers: [incoming],
			collisions: [collision],
			secretFieldCount: 1,
			currentServersRaw: [],
		};
		const decisions: CollisionDecisions = {
			A: { action: "overwrite" },
			B: { action: "skip" },
			C: { action: "rename", newLabel: "C (imported)" },
		};
		const oneDecision: CollisionDecision = { action: "skip" };
		assert.strictEqual(oneDecision.action, "skip");
		const secretWrite: SecretWrite = { label: "A", secrets: { apiKey: "k" } };
		const application: ImportApplication = {
			settingsWrites: [settingWrite],
			serversValue: [incoming.raw],
			secretWrites: [secretWrite],
			touchedLabels: ["A"],
			counts: { imported: 0, overwritten: 1, renamed: 0, skipped: 0 },
		};
		assert.strictEqual(application.touchedLabels[0], secretWrite.label);
		const resolve: (plan: ImportPlan, decisions: CollisionDecisions) => ImportApplication = resolveImportPlan;
		assert.throws(() => resolve(fixturePlan, decisions), UNIMPLEMENTED);
		const suggest: (label: string, takenLabels: ReadonlySet<string>) => string = suggestRenamedLabel;
		assert.throws(() => suggest("A", new Set(["A"])), UNIMPLEMENTED);
	});

	test("snapshot: the recorded shape and the restore lists", () => {
		const recorded: SnapshotEntry<unknown> = { present: true, value: 60000 };
		const absent: SnapshotEntry<StoredServerSecrets> = { present: false };
		const snapshot: PreImportSnapshot = {
			settings: { "chat.timeout": recorded },
			blobs: { A: absent },
			at: new Date(0).toISOString(),
		};
		const restoreLists: SnapshotRestore = {
			settingWrites: [{ key: "chat.timeout", value: 60000 }],
			settingRemovals: ["usage.statusBar"],
			blobWrites: [{ label: "A", secrets: { apiKey: "k" } }],
			blobRemovals: ["B"],
		};
		assert.strictEqual(restoreLists.settingWrites.length, Object.keys(snapshot.settings).length);
		const build: (
			readGlobalSetting: (key: string) => unknown,
			readServerSecrets: (label: string) => Promise<StoredServerSecrets>,
			touchedLabels: readonly string[]
		) => Promise<PreImportSnapshot> = buildPreImportSnapshot;
		assert.throws(
			() =>
				build(
					() => undefined,
					() => Promise.resolve({}),
					["A"]
				),
			UNIMPLEMENTED
		);
		const restore: (snapshot: PreImportSnapshot) => SnapshotRestore = planSnapshotRestore;
		assert.throws(() => restore(snapshot), UNIMPLEMENTED);
	});
});
