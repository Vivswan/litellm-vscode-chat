/**
 * The extension's command IDs and language-model vendor, in one place so
 * registrations, executeCommand calls, and package.json cannot drift apart
 * (commandIds.test.ts pins the package.json mirror). The provider layer's
 * "litellm" strings are a different concept - a provider-name and model-family
 * fallback that happens to share the spelling - and deliberately stay literal
 * over there. No vscode, no Node; localization goes through @vscode/l10n so
 * the host, the provider layer, and the webview can all resolve the title.
 */

import * as l10n from "@vscode/l10n";

/** The vendor this extension registers with the language-model host; provider groups carry it. */
export const VENDOR_ID = "litellm";

/** The commands package.json contributes; the palette and walkthrough deep-links use exactly these. */
export const CMD = {
	manage: "litellm.manage",
	openDashboard: "litellm.openDashboard",
	testConnection: "litellm.testConnection",
	syncModels: "litellm.syncModels",
	showDiagnostics: "litellm.showDiagnostics",
	helpAndFeedback: "litellm.helpAndFeedback",
	setServerSecret: "litellm.setServerSecret",
	reportIssue: "litellm.reportIssue",
} as const;

/**
 * CMD.manage's palette title, exactly as package.json contributes it
 * (commandIds.test.ts pins the mirror). User-facing messages that tell the
 * user to run the command interpolate this so they always name what the
 * palette really shows. A function, not a constant: it must resolve through
 * the l10n bundle at call time, after l10n.config has run.
 */
export function manageCommandTitle(): string {
	return l10n.t("Manage LiteLLM Provider");
}

/**
 * CMD.syncModels' palette title, exactly as package.json contributes it
 * (commandIds.test.ts pins the mirror); same call-time-resolution contract as
 * manageCommandTitle above.
 */
export function syncModelsCommandTitle(): string {
	return l10n.t("LiteLLM: Sync Models Now");
}

/**
 * User-facing commands registered at runtime but kept out of
 * contributes.commands on purpose: manageServers is the server-management
 * route the hub's server entry and the dashboard's manage intent share
 * (the dashboard, or the legacy quick pick before migration), and
 * openGroupsFile opens the host's provider-groups JSON directly - the one
 * place a leftover provider group can be deleted, since no editor UI for it
 * is sanctioned. openOutput shows the extension's output channel (the
 * dashboard Diagnostics tab's Open-output-log action), and openSettingKey
 * opens the user settings.json at one litellm-vscode-chat.* key (the
 * dashboard's revealSetting intent). The palette shows only the manage hub
 * (see registerManageCommand). The litellm._test.* harness commands are
 * deliberately not mapped here: they are test-mode-only, and their ids
 * double as oracle strings in the suites.
 */
export const INTERNAL_CMD = {
	manageServers: "litellm.manageServers",
	openGroupsFile: "litellm.openGroupsFile",
	openOutput: "litellm.openOutput",
	openSettingKey: "litellm.openSettingKey",
} as const;

/** Any command ID this extension registers, contributed or internal. */
export type CommandId = (typeof CMD)[keyof typeof CMD] | (typeof INTERNAL_CMD)[keyof typeof INTERNAL_CMD];
