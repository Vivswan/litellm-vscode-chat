/**
 * The thin applier around the pure pipeline: read the snapshot through the
 * configuration API, run the transform, execute the plan's writes at the User
 * (Global) scope, log the count lines. No SecretStorage access (blob keys and
 * field ids are unchanged and stored values keep working under the new entry
 * shape), no fingerprint touch (a migrated entry's group args are
 * byte-identical, except the wire-inert-fragment exception), and no idempotency
 * ledger (source-key absence is the state signal). The one globalState touch is
 * the write-once parking of a consumed global headers value.
 */

import * as vscode from "vscode";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import { PARKED_GLOBAL_HEADERS_KEY } from "../../../shared/config/storageKeys";
import type { Logger } from "../../../shared/logger";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "../index";
import {
	LEGACY_HEADERS_ID,
	LEGACY_MODEL_CAPABILITIES_ID,
	LEGACY_MODEL_PARAMETERS_ID,
	LEGACY_SCALAR_RENAMES,
	NEW_MODEL_CAPABILITIES_ID,
	NEW_MODEL_PARAMETERS_ID,
	REMOVED_TOKEN_DEFAULTS,
	SERVERS_ID,
} from "./legacyIds";
import { planSettingsRedesign } from "./transform";
import type { SettingLayers, SettingsSnapshot } from "./types";

/** The slice of WorkspaceConfiguration the migration needs; tests fake it. */
export interface RedesignSettings {
	inspect(section: string): SettingLayers | undefined;
	update(section: string, value: unknown, target: vscode.ConfigurationTarget): Thenable<void>;
}

/** Every id the snapshot carries: the legacy sources, their new-name targets (for the race rule), and servers. */
const SNAPSHOT_IDS: readonly string[] = [
	...LEGACY_SCALAR_RENAMES.flatMap((rename) => [rename.oldId, rename.newId]),
	LEGACY_MODEL_PARAMETERS_ID,
	NEW_MODEL_PARAMETERS_ID,
	LEGACY_MODEL_CAPABILITIES_ID,
	NEW_MODEL_CAPABILITIES_ID,
	LEGACY_HEADERS_ID,
	...REMOVED_TOKEN_DEFAULTS.map((source) => source.id),
	SERVERS_ID,
];

export function readRedesignSnapshot(setting: RedesignSettings): SettingsSnapshot {
	const sections: Record<string, SettingLayers> = {};
	for (const id of SNAPSHOT_IDS) {
		const inspected = setting.inspect(id);
		if (inspected === undefined) {
			continue;
		}
		const layers: SettingLayers = {
			...(inspected.globalValue !== undefined ? { globalValue: inspected.globalValue } : {}),
			...(inspected.workspaceValue !== undefined ? { workspaceValue: inspected.workspaceValue } : {}),
			...(inspected.workspaceFolderValue !== undefined ? { workspaceFolderValue: inspected.workspaceFolderValue } : {}),
		};
		if (Object.keys(layers).length > 0) {
			sections[id] = layers;
		}
	}
	return sections;
}

/** The Memento slice the headers parking needs; MigrationContext.globalState satisfies it. */
export interface ParkedHeadersStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

/**
 * Plan against the current user settings and execute: park the consumed global
 * headers value first (once - an existing parked record is never overwritten,
 * so a rerun after a crash cannot clobber the original), then the writes in
 * plan order (values before deletions) at the Global target, then the
 * count-only log lines. Log lines can accompany a "nothing-to-do" outcome
 * (workspace leftovers, an inert global headers value, a blocked trio merge).
 */
export async function applySettingsRedesign(
	setting: RedesignSettings,
	store: ParkedHeadersStore,
	logger: Logger
): Promise<MigrationOutcome> {
	const snapshot = readRedesignSnapshot(setting);
	const plan = planSettingsRedesign(snapshot);
	if (plan.parkedHeaders !== undefined && store.get(PARKED_GLOBAL_HEADERS_KEY) === undefined) {
		await store.update(PARKED_GLOBAL_HEADERS_KEY, { headers: plan.parkedHeaders, migratedAt: Date.now() });
	}
	for (const write of plan.writes) {
		await setting.update(write.section, write.value, vscode.ConfigurationTarget.Global);
	}
	for (const line of plan.logLines) {
		logger.log(line);
	}
	return plan.outcome;
}

/**
 * Migrates away from: the pre-redesign settings namespace of v0.4.4 and
 * earlier - the flat setting names, the flat entry fields, the global headers
 * setting, implicit-prefix record keys, server-URL-scoped global keys, the
 * default* token trio, and the `_declare` directive. Deletable once installs
 * carrying any of that state are judged extinct.
 *
 * Runs before registration so the first registration of a session already sees
 * the new-name settings and the restructured entries.
 */
export const settingsRedesignMigration: ExtensionMigration = {
	state: "settings-redesign",
	description: "Renamed and restructured the pre-redesign settings into the redesigned namespace",
	sourceRelease: "0.4.4",
	run(ctx: MigrationContext): Promise<MigrationOutcome> {
		return applySettingsRedesign(vscode.workspace.getConfiguration(CONFIG_SECTION), ctx.globalState, ctx.logger);
	},
};
