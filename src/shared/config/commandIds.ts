/**
 * The extension's command IDs, contribution identities, and language-model vendor, in one place so registrations,
 * executeCommand calls, and package.json cannot drift apart: the manifest's contributes blocks are generated from
 * these constants (scripts/dev/manifest). The provider layer's "litellm" strings are a different concept - a
 * provider-name and model-family fallback that happens to share the spelling - and deliberately stay literal over
 * there.
 */

import * as l10n from "@vscode/l10n";
import type { AgentWriteToolId, FeatureId } from "./settingSpec";

/** The vendor this extension registers with the language-model host; provider groups carry it. */
export const VENDOR_ID = "litellm";

/** The chatParticipants contribution's id (the @litellm participant). */
export const PARTICIPANT_ID = "litellm.participant";

/** The handle typed after "@" and submitted by the quick fixes; VENDOR_ID only happens to share the spelling. */
export const PARTICIPANT_NAME = "litellm";

/** The languageModelTools contribution's name (the consult tool). */
export const TOOL_NAME = "litellm_consult";

/** Whether the tool is REGISTERED (enabled with a model ref), so the picker never offers a half-configured tool. */
export const CONSULT_TOOL_READY_CONTEXT_KEY = "litellm.consultToolReady";

/** The agent tools, in manifest order: the four reads first, then the five writes. */
export const AGENT_TOOL_IDS = [
	"diagnostics",
	"configuration",
	"inspectModel",
	"searchCatalog",
	"setSetting",
	"editModelRecords",
	"saveServer",
	"removeServer",
	"runAction",
] as const;

export type AgentToolId = (typeof AGENT_TOOL_IDS)[number];

export interface AgentToolContribution {
	/** The languageModelTools contribution's name: snake_case, namespaced like TOOL_NAME. */
	readonly name: string;

	/** The `#handle` a user types to reference the tool in a prompt. */
	readonly referenceName: string;

	/** The write toggle that also gates the tool; undefined for a read, which the feature switch alone registers. */
	readonly toggle: AgentWriteToolId | undefined;
}

/** A read registers under the feature switch alone, a write also under its toggle; the when clauses read both. */
export const AGENT_TOOLS = {
	diagnostics: { name: "litellm_diagnostics", referenceName: "litellmDiagnostics", toggle: undefined },
	configuration: { name: "litellm_configuration", referenceName: "litellmConfiguration", toggle: undefined },
	inspectModel: { name: "litellm_inspect_model", referenceName: "litellmInspectModel", toggle: undefined },
	searchCatalog: { name: "litellm_search_catalog", referenceName: "litellmSearchCatalog", toggle: undefined },
	setSetting: { name: "litellm_set_setting", referenceName: "litellmSetSetting", toggle: "setSetting" },
	editModelRecords: {
		name: "litellm_edit_model_records",
		referenceName: "litellmEditModelRecords",
		toggle: "editModelRecords",
	},
	saveServer: { name: "litellm_save_server", referenceName: "litellmSaveServer", toggle: "saveServer" },
	removeServer: { name: "litellm_remove_server", referenceName: "litellmRemoveServer", toggle: "removeServer" },
	runAction: { name: "litellm_run_action", referenceName: "litellmRunAction", toggle: "runAction" },
} as const satisfies Record<AgentToolId, AgentToolContribution>;

/** The mcpServerDefinitionProviders contribution's id. */
export const MCP_PROVIDER_ID = "litellm.mcpServers";

/** Made at runtime, not contributed; the comment menus' when-clauses name it, so it drifts like a contribution. */
export const COMMENT_CONTROLLER_ID = "litellm.review";

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
	reviewChanges: "litellm.reviewChanges",
	reviewFile: "litellm.reviewFile",
	// The review threads' own actions. Contributed because a menus entry may only name a contributed command, and
	// hidden from the palette by an explicit `when: false` - they are meaningless without a thread to act on.
	reviewReply: "litellm.reviewReply",
	reviewResolveThread: "litellm.reviewResolveThread",
	reviewUnresolveThread: "litellm.reviewUnresolveThread",
	reviewDeleteThread: "litellm.reviewDeleteThread",
} as const;

/** The feature switch that hides each command until on (undefined: always offered); literal-typed for the generator. */
export const COMMAND_FEATURES = {
	manage: undefined,
	openDashboard: undefined,
	testConnection: undefined,
	syncModels: undefined,
	showDiagnostics: undefined,
	helpAndFeedback: undefined,
	setServerSecret: undefined,
	reportIssue: undefined,
	refreshUsage: undefined,
	refreshOpenRouterCatalog: undefined,
	exportSettings: undefined,
	importSettings: undefined,
	undoLastImport: undefined,
	generateCommitMessage: "commitGeneration",
	generatePrDescription: "prGeneration",
	reviewChanges: "reviewComments",
	reviewFile: "reviewComments",
	reviewReply: "reviewComments",
	reviewResolveThread: "reviewComments",
	reviewUnresolveThread: "reviewComments",
	reviewDeleteThread: "reviewComments",
} as const satisfies Record<keyof typeof CMD, FeatureId | undefined>;

/**
 * CMD.manage's palette title, exactly as package.json contributes it. A function, not a constant: it must resolve
 * through the l10n bundle at call time, after l10n.config has run.
 */
export function manageCommandTitle(): string {
	return l10n.t("Manage LiteLLM Provider");
}

export function syncModelsCommandTitle(): string {
	return l10n.t("LiteLLM: Sync Models Now");
}

export function refreshUsageCommandTitle(): string {
	return l10n.t("LiteLLM: Refresh Usage Now");
}

export function generateCommitMessageCommandTitle(): string {
	return l10n.t("LiteLLM: Generate Commit Message");
}

export function generatePrDescriptionCommandTitle(): string {
	return l10n.t("LiteLLM: Generate Pull Request Description");
}

/**
 * The title the GitHub Pull Requests extension lists this generator under in its create-PR view. It must never
 * contain "Copilot": that extension selects a provider by case-insensitive substring, and "Copilot" is the search term
 * its own Copilot slot uses, so a title carrying it would hijack a slot this extension has no business answering
 * (commandIds.test.ts pins the rule across every translation).
 */
export function prGenerationProviderTitle(): string {
	return l10n.t("Generate with LiteLLM");
}

export function reviewChangesCommandTitle(): string {
	return l10n.t("LiteLLM: Review Changes");
}

export function reviewFileCommandTitle(): string {
	return l10n.t("LiteLLM: Review This File");
}

/** Registered at runtime but kept out of contributes.commands on purpose, so the palette never offers them. */
export const INTERNAL_CMD = {
	manageServers: "litellm.manageServers",
	// The host's provider-groups JSON, the fallback for deleting a group the Manage Language Models editor cannot reach.
	openGroupsFile: "litellm.openGroupsFile",
	openOutput: "litellm.openOutput",
	openSettingKey: "litellm.openSettingKey",
	openUsage: "litellm.openUsage",
	// Takes a structured payload no user could type, so a palette entry would fail on every invocation.
	quickFixChat: "litellm.quickFixChat",
	toggleInlineCompletionsLanguage: "litellm.toggleInlineCompletionsLanguage",
} as const;

/** The host's own commands this extension drives. */
export const HOST_CMD = {
	// The provider-group add serverSync talks to; the family is add-only (hostGroupCommand.test.ts pins it).
	addProviderGroup: "lm.addLanguageModelsProviderGroup",
	// The Manage Language Models editor the removal notices open; its group menu carries the Delete action.
	manageLanguageModels: "workbench.action.chat.manage",
} as const;

export type CommandId = (typeof CMD)[keyof typeof CMD] | (typeof INTERNAL_CMD)[keyof typeof INTERNAL_CMD];
