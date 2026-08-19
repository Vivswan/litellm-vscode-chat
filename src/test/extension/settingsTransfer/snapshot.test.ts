import * as assert from "node:assert";
import type { StoredSecretsRecord, StoredServerSecrets } from "../../../extension/servers/serverSync/secrets";
import type { PreImportSnapshot, SnapshotEntry, SnapshotRestore } from "../../../extension/settingsTransfer/snapshot";
import { buildPreImportSnapshot, planSnapshotRestore } from "../../../extension/settingsTransfer/snapshot";
import { ALL_SETTING_KEYS } from "../../../shared/config/settingSpec";

suite("extension/settingsTransfer/snapshot", () => {
	test("the frozen signatures and the entry shape", () => {
		const build: (
			readGlobalSetting: (key: string) => unknown,
			readServerSecrets: (label: string) => Promise<StoredSecretsRecord>,
			touchedLabels: readonly string[]
		) => Promise<PreImportSnapshot> = buildPreImportSnapshot;
		const restore: (snapshot: PreImportSnapshot) => SnapshotRestore = planSnapshotRestore;
		assert.strictEqual(typeof build, "function");
		assert.strictEqual(typeof restore, "function");
		const present: SnapshotEntry<number> = { present: true, value: 1 };
		const absent: SnapshotEntry<number> = { present: false };
		assert.notDeepStrictEqual(present, absent);
	});

	test("records every setting key as present or absent and each touched label's blob", async () => {
		const values: Record<string, unknown> = { "chat.timeout": 60000, servers: [{ label: "A" }] };
		const blobs: Record<string, StoredServerSecrets> = { A: { apiKey: "sk-a" }, B: {} };
		const snapshot = await buildPreImportSnapshot(
			(key) => values[key],
			(label) => Promise.resolve({ values: blobs[label] ?? {}, owners: {} }),
			["A", "B", "A"]
		);
		assert.deepStrictEqual(Object.keys(snapshot.settings), [...ALL_SETTING_KEYS]);
		assert.deepStrictEqual(snapshot.settings["chat.timeout"], { present: true, value: 60000 });
		assert.deepStrictEqual(snapshot.settings.servers, { present: true, value: [{ label: "A" }] });
		assert.deepStrictEqual(snapshot.settings["chat.promptCaching"], { present: false });
		assert.deepStrictEqual(snapshot.blobs, {
			A: { present: true, value: { apiKey: "sk-a" } },
			B: { present: false },
		});
		assert.ok(Number.isFinite(Date.parse(snapshot.at)), "at must be a parseable ISO 8601 timestamp");
		assert.strictEqual(snapshot.at, new Date(snapshot.at).toISOString());
	});

	test("the snapshot is JSON-safe by construction on the settings side", async () => {
		const snapshot = await buildPreImportSnapshot(
			(key) => (key === "chat.timeout" ? 1 : undefined),
			() => Promise.resolve({ values: {}, owners: {} }),
			[]
		);
		assert.deepStrictEqual(JSON.parse(JSON.stringify(snapshot.settings)), snapshot.settings);
	});

	test("planSnapshotRestore partitions present entries into writes and absent ones into removals", () => {
		const snapshot: PreImportSnapshot = {
			settings: {
				"chat.timeout": { present: true, value: 60000 },
				"usage.statusBar": { present: false },
				servers: { present: true, value: [] },
			},
			blobs: {
				A: { present: true, value: { apiKey: "sk-a" } },
				B: { present: false },
			},
			at: new Date(0).toISOString(),
		};
		assert.deepStrictEqual(planSnapshotRestore(snapshot), {
			settingWrites: [
				{ key: "chat.timeout", value: 60000 },
				{ key: "servers", value: [] },
			],
			settingRemovals: ["usage.statusBar"],
			blobWrites: [{ label: "A", secrets: { apiKey: "sk-a" }, owners: {} }],
			blobRemovals: ["B"],
		});
	});

	test("snapshot then restore round-trips present and absent states exactly", async () => {
		const values: Record<string, unknown> = {
			"chat.timeout": 12345,
			"models.capabilities": { "*": { toolCalling: true } },
		};
		const blobs: Record<string, StoredServerSecrets> = { kept: { virtualKeyValue: "vk" } };
		const snapshot = await buildPreImportSnapshot(
			(key) => values[key],
			(label) => Promise.resolve({ values: blobs[label] ?? {}, owners: {} }),
			["kept", "appended-by-import"]
		);
		const restore = planSnapshotRestore(snapshot);

		// Apply the restore lists to a divergent post-import state.
		const settingsAfter: Record<string, unknown> = { "chat.timeout": 1, "usage.statusBar": "off" };
		for (const write of restore.settingWrites) {
			settingsAfter[write.key] = write.value;
		}
		for (const key of restore.settingRemovals) {
			delete settingsAfter[key];
		}
		const blobsAfter: Record<string, StoredServerSecrets> = { "appended-by-import": { apiKey: "imported" } };
		for (const write of restore.blobWrites) {
			blobsAfter[write.label] = write.secrets;
		}
		for (const label of restore.blobRemovals) {
			delete blobsAfter[label];
		}

		assert.deepStrictEqual(settingsAfter, values);
		assert.deepStrictEqual(blobsAfter, blobs);
	});
});
