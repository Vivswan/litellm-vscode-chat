/**
 * The extension's command IDs and language-model vendor, in one place so
 * registrations, executeCommand calls, and package.json cannot drift apart
 * (commandIds.test.ts pins the package.json mirror). The provider layer's
 * "litellm" strings are a different concept - a provider-name and model-family
 * fallback that happens to share the spelling - and deliberately stay literal
 * over there. Pure constants: no vscode, no Node.
 */

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
 * palette really shows.
 */
export const MANAGE_COMMAND_TITLE = "Manage LiteLLM Provider";

/**
 * User-facing commands registered at runtime but kept out of
 * contributes.commands on purpose: manageServers is the server-management
 * route the hub's server entry and the dashboard's manage intent share
 * (the dashboard, or the legacy quick pick before migration), and
 * openGroupsFile opens the host's provider-groups JSON directly - the one
 * place a leftover provider group can be deleted, since no editor UI for it
 * is sanctioned. The palette shows only the manage hub (see
 * registerManageCommand). The litellm._test.* harness commands are
 * deliberately not mapped here: they are test-mode-only, and their ids
 * double as oracle strings in the suites.
 */
export const INTERNAL_CMD = {
	manageServers: "litellm.manageServers",
	openGroupsFile: "litellm.openGroupsFile",
} as const;

/** Any command ID this extension registers, contributed or internal. */
export type CommandId = (typeof CMD)[keyof typeof CMD] | (typeof INTERNAL_CMD)[keyof typeof INTERNAL_CMD];
