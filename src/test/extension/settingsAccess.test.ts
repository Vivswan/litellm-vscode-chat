import * as assert from "node:assert";
import * as vscode from "vscode";
import type { SettingsInspection, SettingsSnapshotReader } from "../../extension/settingsAccess";
import { createSettingsAccess, resolveConfiguredScope, resolveUpdateScope } from "../../extension/settingsAccess";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";

interface RecordedUpdate {
	readonly key: string;
	readonly value: unknown;
	readonly target: vscode.ConfigurationTarget;
}

/** What the fake configuration observed: the writes, and how often the configuration itself was fetched. */
interface RecordedConfig {
	readonly updates: RecordedUpdate[];
	fetches(): number;
}

/**
 * Run `fn` with vscode.workspace.getConfiguration faked for the extension's
 * section: `inspections` back inspect() and the merged get(), and updates are
 * recorded instead of written. Not testUtils' withConfig, because these tests
 * also need update() targets and a fetch counter.
 */
async function withRecordedConfig<T>(
	inspections: Record<string, SettingsInspection>,
	fn: (recorded: RecordedConfig) => T | Promise<T>
): Promise<Awaited<T>> {
	const original = vscode.workspace.getConfiguration;
	const updates: RecordedUpdate[] = [];
	let fetchCount = 0;
	const merged = (key: string): unknown => {
		const inspection = inspections[key];
		if (inspection?.workspaceFolderValue !== undefined) {
			return inspection.workspaceFolderValue;
		}
		if (inspection?.workspaceValue !== undefined) {
			return inspection.workspaceValue;
		}
		if (inspection?.globalValue !== undefined) {
			return inspection.globalValue;
		}
		return inspection?.defaultValue;
	};
	vscode.workspace.getConfiguration = ((section?: string, scope?: vscode.ConfigurationScope | null) => {
		if (section !== CONFIG_SECTION) {
			return original(section, scope);
		}
		fetchCount += 1;
		return {
			get: (key: string) => merged(key),
			inspect: (key: string) => inspections[key],
			update: async (key: string, value: unknown, target: vscode.ConfigurationTarget) => {
				updates.push({ key, value, target });
			},
		} as unknown as vscode.WorkspaceConfiguration;
	}) as typeof vscode.workspace.getConfiguration;
	try {
		return await fn({ updates, fetches: () => fetchCount });
	} finally {
		vscode.workspace.getConfiguration = original;
	}
}

suite("extension/settingsAccess", () => {
	suite("createSettingsAccess", () => {
		test("readGlobal reads exactly the user-scope value, never the merge", async () => {
			await withRecordedConfig({ "chat.timeout": { globalValue: 1000, workspaceValue: 2000 } }, () => {
				const access = createSettingsAccess();
				assert.strictEqual(access.readGlobal("chat.timeout"), 1000);
				assert.strictEqual(access.readGlobal("discovery.timeout"), undefined);
			});
		});

		test("readEffective returns the merged value and inspect the per-scope ones", async () => {
			const inspection: SettingsInspection = { defaultValue: 300000, globalValue: 1000, workspaceValue: 2000 };
			await withRecordedConfig({ "chat.timeout": inspection }, () => {
				const access = createSettingsAccess();
				assert.strictEqual(access.readEffective("chat.timeout"), 2000);
				assert.deepStrictEqual(access.inspect("chat.timeout"), inspection);
			});
		});

		test("writeGlobal always targets the user scope, a configured workspace value notwithstanding", async () => {
			await withRecordedConfig({ servers: { workspaceValue: [] } }, async ({ updates }) => {
				await createSettingsAccess().writeGlobal("servers", [{ label: "A" }]);
				assert.deepStrictEqual(updates, [
					{ key: "servers", value: [{ label: "A" }], target: vscode.ConfigurationTarget.Global },
				]);
			});
		});

		test("updateAuto writes to the workspace only when it already holds a value, never to a folder", async () => {
			const inspections = {
				"chat.timeout": { workspaceValue: 2000 },
				"discovery.timeout": { globalValue: 1000 },
				"discovery.cacheTtl": { workspaceFolderValue: 3000 },
			};
			await withRecordedConfig(inspections, async ({ updates, fetches }) => {
				const access = createSettingsAccess();
				await access.updateAuto("chat.timeout", 1);
				assert.strictEqual(fetches(), 1, "the write target comes from the same snapshot as the write");
				await access.updateAuto("discovery.timeout", 2);
				await access.updateAuto("discovery.cacheTtl", 3);
				assert.deepStrictEqual(
					updates.map(({ key, target }) => ({ key, target })),
					[
						{ key: "chat.timeout", target: vscode.ConfigurationTarget.Workspace },
						{ key: "discovery.timeout", target: vscode.ConfigurationTarget.Global },
						{ key: "discovery.cacheTtl", target: vscode.ConfigurationTarget.Global },
					]
				);
			});
		});

		test("removeConfigured removes from the highest-precedence configured scope, folder included", async () => {
			const inspections = {
				"chat.timeout": { globalValue: 1, workspaceValue: 2, workspaceFolderValue: 3 },
				"discovery.timeout": { globalValue: 1, workspaceValue: 2 },
				"discovery.cacheTtl": { globalValue: 1 },
				"usage.pollInterval": { defaultValue: 300000 },
			};
			await withRecordedConfig(inspections, async ({ updates, fetches }) => {
				const access = createSettingsAccess();
				await access.removeConfigured("chat.timeout");
				assert.strictEqual(fetches(), 1, "the removal target comes from the same snapshot as the removal");
				await access.removeConfigured("discovery.timeout");
				await access.removeConfigured("discovery.cacheTtl");
				await access.removeConfigured("usage.pollInterval");
				assert.ok(
					updates.every(({ value }) => value === undefined),
					"a remove writes undefined"
				);
				assert.deepStrictEqual(
					updates.map(({ key, target }) => ({ key, target })),
					[
						{ key: "chat.timeout", target: vscode.ConfigurationTarget.WorkspaceFolder },
						{ key: "discovery.timeout", target: vscode.ConfigurationTarget.Workspace },
						{ key: "discovery.cacheTtl", target: vscode.ConfigurationTarget.Global },
						// Unconfigured keys walk out at the user scope (a no-op removal).
						{ key: "usage.pollInterval", target: vscode.ConfigurationTarget.Global },
					]
				);
			});
		});

		test("every method fetches the live configuration at call time", async () => {
			// WorkspaceConfiguration is a snapshot: one captured at access-creation
			// time would serve stale values to reads following awaited writes.
			await withRecordedConfig({}, async ({ fetches }) => {
				const access = createSettingsAccess();
				assert.strictEqual(fetches(), 0, "creation itself fetches nothing");
				access.readGlobal("servers");
				access.readEffective("servers");
				await access.writeGlobal("servers", []);
				assert.strictEqual(fetches(), 3);
			});
		});

		test("snapshotReader serves every read from the one configuration it captured", async () => {
			// The deliberate exception: a dashboard build makes many reads and
			// must not mix configuration versions mid-build.
			await withRecordedConfig({ "chat.timeout": { globalValue: 1000 } }, ({ fetches }) => {
				const reader: SettingsSnapshotReader = createSettingsAccess().snapshotReader();
				assert.strictEqual(fetches(), 1, "the snapshot is captured at reader creation");
				assert.strictEqual(reader.get("chat.timeout"), 1000);
				assert.deepStrictEqual(reader.inspect("chat.timeout"), { globalValue: 1000 });
				assert.strictEqual(reader.inspect("servers"), undefined);
				assert.strictEqual(fetches(), 1, "reads never re-fetch");
			});
		});
	});

	suite("resolveUpdateScope", () => {
		test("workspace when the workspace holds a value, user scope otherwise", () => {
			assert.strictEqual(resolveUpdateScope({ workspaceValue: 2 }), "workspace");
			assert.strictEqual(resolveUpdateScope({}), "global");
			assert.strictEqual(resolveUpdateScope(undefined), "global");
		});

		test("never returns workspaceFolder: resource-less folder updates would throw", () => {
			const inspection: SettingsInspection = { workspaceFolderValue: 1 };
			assert.strictEqual(resolveUpdateScope(inspection), "global");
		});
	});

	suite("resolveConfiguredScope", () => {
		test("the highest-precedence configured scope wins; unconfigured keys resolve to null", () => {
			assert.strictEqual(
				resolveConfiguredScope({ globalValue: 1, workspaceValue: 2, workspaceFolderValue: 3 }),
				"workspaceFolder"
			);
			assert.strictEqual(resolveConfiguredScope({ globalValue: 1, workspaceValue: 2 }), "workspace");
			assert.strictEqual(resolveConfiguredScope({ globalValue: 1 }), "global");
			assert.strictEqual(resolveConfiguredScope({ defaultValue: 300000 }), null);
			assert.strictEqual(resolveConfiguredScope(undefined), null);
		});

		test("a folder value alone is the reset target even though writes never land there", () => {
			assert.strictEqual(resolveConfiguredScope({ workspaceFolderValue: 1 }), "workspaceFolder");
		});
	});
});
