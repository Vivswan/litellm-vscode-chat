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

/**
 * The contribution identities of the upcoming features, declared ahead of
 * their manifests so registrations and package.json cannot drift apart once
 * they land (the same contract as CMD). Each is pinned fail-closed by
 * commandIds.test.ts: the manifest section stays EMPTY until the feature
 * ships, and any entry it ever contributes must carry exactly this identity.
 */
/** The chatParticipants contribution's id (the @litellm participant). */
export const PARTICIPANT_ID = "litellm.participant";
/** The languageModelTools contribution's name (the consult tool). */
export const TOOL_NAME = "litellm_consult";
/**
 * The context key the consult tool's contribution gates on. The wiring sets it
 * to whether the tool is REGISTERED - both the enable boolean and a model ref -
 * so the agent's tool picker never advertises the half-configured state, where
 * every call could only fail. A setting-only when-clause could not express that.
 */
export const CONSULT_TOOL_READY_CONTEXT_KEY = "litellm.consultToolReady";
/** The mcpServerDefinitionProviders contribution's id. */
export const MCP_PROVIDER_ID = "litellm.mcpServers";

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
	generateCommitMessage: "litellm.generateCommitMessage",
	generatePrDescription: "litellm.generatePrDescription",
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

/** CMD.generateCommitMessage's palette title; same call-time-resolution contract. */
export function generateCommitMessageCommandTitle(): string {
	return l10n.t("LiteLLM: Generate Commit Message");
}

/** CMD.generatePrDescription's palette title; same call-time-resolution contract. */
export function generatePrDescriptionCommandTitle(): string {
	return l10n.t("LiteLLM: Generate Pull Request Description");
}

/**
 * The title the GitHub Pull Requests extension lists this generator under in
 * its create-PR view. It must never contain "Copilot": that extension selects
 * a provider by case-insensitive substring, and "Copilot" is the search term
 * its own Copilot slot uses, so a title carrying it would hijack a slot this
 * extension has no business answering (commandIds.test.ts pins the
 * rule across every translation). Same call-time-resolution contract as the
 * palette titles.
 */
export function prGenerationProviderTitle(): string {
	return l10n.t("Generate with LiteLLM");
}

/**
 * User-facing commands registered at runtime but kept out of
 * contributes.commands on purpose - the palette shows only the manage hub.
 * openGroupsFile opens the host's provider-groups JSON directly: the one place
 * a leftover provider group can be deleted, since no editor UI for it is
 * sanctioned. quickFixChat is the command a quick-fix lightbulb runs: it takes
 * a structured payload no user could type, so contributing it to the palette
 * would offer an action that fails on every invocation from there. The
 * litellm._test.* harness commands are deliberately not mapped here: they are
 * test-mode-only, and their ids double as oracle strings in the suites.
 */
export const INTERNAL_CMD = {
	manageServers: "litellm.manageServers",
	openGroupsFile: "litellm.openGroupsFile",
	openOutput: "litellm.openOutput",
	openSettingKey: "litellm.openSettingKey",
	openUsage: "litellm.openUsage",
	quickFixChat: "litellm.quickFixChat",
	toggleInlineCompletionsLanguage: "litellm.toggleInlineCompletionsLanguage",
} as const;

/** Any command ID this extension registers, contributed or internal. */
export type CommandId = (typeof CMD)[keyof typeof CMD] | (typeof INTERNAL_CMD)[keyof typeof INTERNAL_CMD];
