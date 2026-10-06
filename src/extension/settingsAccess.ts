/**
 * Unified access to the litellm-vscode-chat.* configuration section: the one place that owns which scope reads come
 * from and which ConfigurationTarget writes land in. The dashboard panel, the dev seed, and the settings export/import
 * flows all go through here rather than resolving scope themselves against vscode.workspace.getConfiguration.
 */

import * as vscode from "vscode";
import type { SettingScope } from "../dashboard/viewModels";
import type { KeyedSettingId } from "../shared/config/settingSpec";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../shared/config/settingSpec";
import type { ServersSettingStore } from "./servers/serversSettingWrite";
import { settingValueOf } from "./servers/serversSettingWrite";

/** The per-scope values configuration inspection reports; a seam over WorkspaceConfiguration.inspect. */
export interface SettingsInspection {
	readonly defaultValue?: unknown;
	readonly globalValue?: unknown;
	readonly workspaceValue?: unknown;
	readonly workspaceFolderValue?: unknown;
}

/**
 * WorkspaceFolder values are never written to - the dashboard's configuration access is resource-less, and a
 * WorkspaceFolder update without a resource throws in multi-root workspaces.
 */
export function resolveUpdateScope(
	inspection: Pick<SettingsInspection, "workspaceValue"> | undefined
): "global" | "workspace" {
	return inspection?.workspaceValue !== undefined ? "workspace" : "global";
}

/**
 * The highest-precedence scope that explicitly configures a key, or null when only the default applies (VS Code's own
 * merge order: workspaceFolder over workspace over global). This is what "modified" means in the dashboard form, and
 * the scope a reset removes first, so repeated resets walk down the scopes until nothing is configured.
 */
export function resolveConfiguredScope(inspection: SettingsInspection | undefined): SettingScope | null {
	if (inspection?.workspaceFolderValue !== undefined) {
		return "workspaceFolder";
	}
	if (inspection?.workspaceValue !== undefined) {
		return "workspace";
	}
	if (inspection?.globalValue !== undefined) {
		return "global";
	}
	return null;
}

// Scalar writes never land in the folder scope (see resolveUpdateScope). Resets differ: they must remove the
// highest-precedence configured value, folder scope included, or a reset would delete a hidden lower-scope value while
// the displayed one survives - so the reset map carries all three.
const TARGET_BY_SCOPE = {
	global: vscode.ConfigurationTarget.Global,
	workspace: vscode.ConfigurationTarget.Workspace,
} as const;

const RESET_TARGET_BY_SCOPE = {
	...TARGET_BY_SCOPE,
	workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
} as const;

/** A consistent get/inspect pair over one WorkspaceConfiguration snapshot, captured when the reader is created. */
export interface SettingsSnapshotReader {
	get(key: string): unknown;
	inspect(key: string): SettingsInspection | undefined;
}

/**
 * Every method fetches the live configuration at call time: WorkspaceConfiguration is a snapshot, so a captured one
 * would serve stale values to a read that follows an awaited write. snapshotReader is the deliberate exception.
 *
 * The keyed writers take the closed vocabulary minus the servers setting, so no string can name it there. That one is
 * machine-scoped (a workspace cannot re-point a label at another host to harvest its stored secrets) and is written
 * only through serversSettingWrite.ts's turn, by the store methods, in the user scope.
 */
export interface SettingsAccess extends ServersSettingStore {
	readGlobal(key: string): unknown;
	readEffective(key: string): unknown;
	inspect(key: string): SettingsInspection | undefined;
	/** Write the key's user-scope value; undefined removes it there. */
	writeGlobal(key: KeyedSettingId, value: unknown): Promise<void>;
	updateAuto(key: KeyedSettingId, value: unknown): Promise<void>;
	removeConfigured(key: KeyedSettingId): Promise<void>;
	/** All reads served from one snapshot captured here, so a build over many reads sees one configuration version. */
	snapshotReader(): SettingsSnapshotReader;
}

export function createSettingsAccess(): SettingsAccess {
	const config = () => vscode.workspace.getConfiguration(CONFIG_SECTION);
	return {
		readGlobal: (key) => config().inspect(key)?.globalValue,
		readEffective: (key) => config().get<unknown>(key),
		inspect: (key) => config().inspect(key),
		writeGlobal: async (key, value) => {
			await config().update(key, value, vscode.ConfigurationTarget.Global);
		},
		readServersSetting: () => config().inspect(SERVERS_SETTING_KEY)?.globalValue,
		writeServersSetting: async (write) => {
			await config().update(SERVERS_SETTING_KEY, settingValueOf(write), vscode.ConfigurationTarget.Global);
		},
		updateAuto: async (key, value) => {
			const current = config();
			await current.update(key, value, TARGET_BY_SCOPE[resolveUpdateScope(current.inspect(key))]);
		},
		removeConfigured: async (key) => {
			const current = config();
			const scope = resolveConfiguredScope(current.inspect(key)) ?? "global";
			await current.update(key, undefined, RESET_TARGET_BY_SCOPE[scope]);
		},
		snapshotReader: () => {
			const current = config();
			return {
				get: (key) => current.get<unknown>(key),
				inspect: (key) => current.inspect(key),
			};
		},
	};
}
