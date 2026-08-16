/**
 * The extension's command IDs and language-model vendor, in one place so
 * registrations, executeCommand calls, and package.json cannot drift apart
 * (commandIds.test.ts pins the package.json mirror). The provider layer's
 * "litellm" strings are a different concept - a provider-name and model-family
 * fallback that happens to share the spelling - and deliberately stay literal
 * over there.
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
	refreshUsage: "litellm.refreshUsage",
	refreshOpenRouterCatalog: "litellm.refreshOpenRouterCatalog",
	exportSettings: "litellm.exportSettings",
	importSettings: "litellm.importSettings",
	undoLastImport: "litellm.undoLastImport",
} as const;

/**
 * CMD.manage's palette title, exactly as package.json contributes it. A
 * function, not a constant: it must resolve through the l10n bundle at call
 * time, after l10n.config has run.
 */
export function manageCommandTitle(): string {
	return l10n.t("Manage LiteLLM Provider");
}

/** CMD.syncModels' palette title; same call-time-resolution contract. */
export function syncModelsCommandTitle(): string {
	return l10n.t("LiteLLM: Sync Models Now");
}

/** CMD.refreshUsage's palette title; same call-time-resolution contract. */
export function refreshUsageCommandTitle(): string {
	return l10n.t("LiteLLM: Refresh Usage Now");
}

/**
 * User-facing commands registered at runtime but kept out of
 * contributes.commands on purpose - the palette shows only the manage hub.
 * openGroupsFile opens the host's provider-groups JSON directly: the one place
 * a leftover provider group can be deleted, since no editor UI for it is
 * sanctioned. The litellm._test.* harness commands are deliberately not mapped
 * here: they are test-mode-only, and their ids double as oracle strings in the
 * suites.
 */
export const INTERNAL_CMD = {
	manageServers: "litellm.manageServers",
	openGroupsFile: "litellm.openGroupsFile",
	openOutput: "litellm.openOutput",
	openSettingKey: "litellm.openSettingKey",
	openUsage: "litellm.openUsage",
} as const;

/** Any command ID this extension registers, contributed or internal. */
export type CommandId = (typeof CMD)[keyof typeof CMD] | (typeof INTERNAL_CMD)[keyof typeof INTERNAL_CMD];
