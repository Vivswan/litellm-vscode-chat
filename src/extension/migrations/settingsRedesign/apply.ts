/**
 * No SecretStorage access (blob keys and field ids are unchanged and stored values keep working under the new entry
 * shape), no fingerprint touch (a migrated entry's group args are byte-identical, except the wire-inert-fragment
 * exception), and no idempotency ledger (source-key absence is the state signal).
 */

import * as vscode from "vscode";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
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

/**
 * Log lines can accompany a "nothing-to-do" outcome (workspace leftovers, an inert global headers value, a blocked trio
 * merge, a blocked entry field).
 */
export async function applySettingsRedesign(setting: RedesignSettings, logger: Logger): Promise<MigrationOutcome> {
	const snapshot = readRedesignSnapshot(setting);
	const plan = planSettingsRedesign(snapshot);
	for (const write of plan.writes) {
		await setting.update(write.section, write.value, vscode.ConfigurationTarget.Global);
	}
	for (const line of plan.logLines) {
		logger.log(line);
	}
	return plan.outcome;
}

/**
 * Runs before registration so the first registration of a session already sees the new-name settings and the
 * restructured entries.
 */
export const settingsRedesignMigration: ExtensionMigration<"settings-redesign"> = {
	state: "settings-redesign",
	description: "Renamed and restructured the pre-redesign settings into the redesigned namespace",
	sourceRelease: "0.4.4",
	run(ctx: MigrationContext): Promise<MigrationOutcome> {
		return applySettingsRedesign(vscode.workspace.getConfiguration(CONFIG_SECTION), ctx.logger);
	},
};
