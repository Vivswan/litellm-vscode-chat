import * as vscode from "vscode";
import type { CommandId } from "../shared/commandIds";
import { CMD, INTERNAL_CMD, MANAGE_COMMAND_TITLE } from "../shared/commandIds";
import type { Logger } from "../shared/logger";
import { CONFIG_SECTION } from "../shared/settingSpec";
import { getMaskApiKeyInput, getModelParametersConfig, MODEL_PARAMETERS_SETTING_KEY } from "../shared/settings";
import { isGroupMigrationRunning } from "./migrations/registryToProviderGroups";
import {
	dismissAction,
	openChatAction,
	openSettingsAction,
	showActionableMessage,
	testConnectionAction,
} from "./notifier";
import type { ServerRegistry } from "./serverRegistry";

/**
 * Registry mutations racing the provider-group migration would be stranded or
 * silently reverted by its cleanup, so the add/edit/remove flows refuse while
 * a migration is seeding groups. Returns true when mutating is safe.
 */
export function ensureRegistryMutable(): boolean {
	if (!isGroupMigrationRunning()) {
		return true;
	}
	void vscode.window.showInformationMessage("Server migration is in progress, try again in a moment.");
	return false;
}

/**
 * Whether the legacy registry is still served in each UI mode (only
 * "nativeRequired" means migration retired it). The one predicate behind the
 * mutation guard below and the provider's grouplessRegistryEnabled gate, so
 * the two cannot drift; exhaustive by construction, so a mode added to
 * ManagementUiMode does not compile until it takes a side here.
 */
export const REGISTRY_SERVED_IN_MODE: Record<ManagementUiMode, boolean> = {
	legacy: true,
	nativePreferred: true,
	nativeRequired: false,
};

/**
 * Full mutation guard: the migration lock, plus a UI-mode read at the moment
 * of mutation. Re-reading the mode here closes the window between a migration
 * finishing and a prompt flow's write: a server added into an
 * already-migrated registry would only be cleaned up as an orphan.
 */
export function canMutateRegistry(getUiMode: () => ManagementUiMode): boolean {
	if (!ensureRegistryMutable()) {
		return false;
	}
	if (!REGISTRY_SERVED_IN_MODE[getUiMode()]) {
		void vscode.window.showInformationMessage(
			`LiteLLM servers are now managed in VS Code's language models UI. Re-run "${MANAGE_COMMAND_TITLE}" to open it.`
		);
		return false;
	}
	return true;
}

/**
 * The three input prompts return their value already trimmed (undefined on
 * cancel), so callers store, log, and compare exactly the string the
 * validation checked.
 */
async function promptForServerLabel(
	registry: ServerRegistry,
	initial?: string,
	excludeId?: string
): Promise<string | undefined> {
	const editing = initial !== undefined;
	const value = await vscode.window.showInputBox({
		title: editing ? "LiteLLM: Edit Server - Label" : "LiteLLM: Add Server - Label",
		prompt: editing
			? "Update the server label"
			: "Enter a unique label for this server (e.g., 'Production', 'Local Dev')",
		ignoreFocusOut: true,
		...(editing ? { value: initial } : { placeHolder: "My LiteLLM Server" }),
		validateInput: (value) => {
			if (!value.trim()) {
				return "Label is required";
			}
			if (value.includes("/")) {
				return "Label cannot contain '/' (used as separator in model parameters)";
			}
			if (registry.hasLabel(value.trim(), excludeId)) {
				return "A server with this label already exists";
			}
			return null;
		},
	});
	return value?.trim();
}

async function promptForBaseUrl(initial?: string): Promise<string | undefined> {
	const editing = initial !== undefined;
	const value = await vscode.window.showInputBox({
		title: editing ? "LiteLLM: Edit Server - Base URL" : "LiteLLM: Add Server - Base URL",
		prompt: editing ? "Update the LiteLLM base URL" : "Enter the LiteLLM base URL",
		ignoreFocusOut: true,
		...(editing ? { value: initial } : { placeHolder: "http://localhost:4000" }),
		validateInput: (value) => {
			if (!value.trim()) {
				return "Base URL is required";
			}
			if (!value.startsWith("http://") && !value.startsWith("https://")) {
				return "URL must start with http:// or https://";
			}
			return null;
		},
	});
	return value?.trim();
}

async function promptForApiKey(masked: boolean, initial?: string): Promise<string | undefined> {
	const editing = initial !== undefined;
	const value = await vscode.window.showInputBox({
		title: editing ? "LiteLLM: Edit Server - API Key" : "LiteLLM: Add Server - API Key",
		prompt: editing && initial ? "Update the API key" : "Enter the API key (leave empty if not required)",
		ignoreFocusOut: true,
		password: masked,
		...(editing ? { value: initial } : {}),
	});
	return value?.trim();
}

/**
 * Renaming a server orphans modelParameters entries scoped to the old label
 * prefix ("OldLabel/model"). We warn instead of auto-migrating because the
 * setting may live in user or workspace scope and the user may prefer to keep
 * entries for a label they plan to reuse.
 */
export function warnAboutOrphanedModelParameters(
	oldLabel: string,
	newLabel: string,
	parameterKeys: readonly string[]
): void {
	const prefix = `${oldLabel}/`;
	const orphaned = parameterKeys.filter((key) => key.startsWith(prefix));
	if (orphaned.length === 0) {
		return;
	}
	const noun = orphaned.length === 1 ? "entry" : "entries";
	void showActionableMessage(
		"warning",
		`Renaming the server left ${orphaned.length} modelParameters ${noun} scoped to the old label (e.g., "${orphaned[0]}"). Update the "${prefix}" prefix to "${newLabel}/" in settings to keep them applied.`,
		[openSettingsAction(`${CONFIG_SECTION}.${MODEL_PARAMETERS_SETTING_KEY}`), dismissAction()]
	);
}

async function addServerFlow(
	registry: ServerRegistry,
	logger: Logger,
	getUiMode: () => ManagementUiMode
): Promise<boolean> {
	if (!canMutateRegistry(getUiMode)) {
		return false;
	}
	const label = await promptForServerLabel(registry);
	if (label === undefined) {
		return false;
	}

	const baseUrl = await promptForBaseUrl();
	if (baseUrl === undefined) {
		return false;
	}

	const apiKey = await promptForApiKey(getMaskApiKeyInput());
	if (apiKey === undefined) {
		return false;
	}

	// A migration may have started while the input boxes were open.
	if (!canMutateRegistry(getUiMode)) {
		return false;
	}
	await registry.addServer(label, baseUrl, apiKey);
	logger.log(`Added server "${label}" at ${baseUrl}`);

	void showActionableMessage("info", `Server "${label}" added!`, [
		testConnectionAction(),
		openChatAction(),
		dismissAction(),
	]);

	return true;
}

async function manageServerFlow(
	registry: ServerRegistry,
	serverId: string,
	logger: Logger,
	getUiMode: () => ManagementUiMode
): Promise<void> {
	const servers = registry.getServers();
	const server = servers.find((s) => s.id === serverId);
	if (!server) {
		return;
	}

	const pick = await vscode.window.showQuickPick(
		[
			{ label: "$(edit) Edit Server", action: "edit" },
			{ label: "$(testing-run-icon) Test All Servers", action: "test" },
			{ label: "$(trash) Remove Server", action: "remove" },
		],
		{
			title: `LiteLLM: ${server.label}`,
			placeHolder: `Manage server "${server.label}" (${server.baseUrl})`,
		}
	);

	if (!pick) {
		return;
	}

	if (pick.action === "edit") {
		if (!canMutateRegistry(getUiMode)) {
			return;
		}
		const label = await promptForServerLabel(registry, server.label, serverId);
		if (label === undefined) {
			return;
		}

		const baseUrl = await promptForBaseUrl(server.baseUrl);
		if (baseUrl === undefined) {
			return;
		}

		const existingApiKey = await registry.getApiKey(serverId);
		const apiKey = await promptForApiKey(getMaskApiKeyInput(), existingApiKey);
		if (apiKey === undefined) {
			return;
		}

		const oldLabel = server.label;
		// A migration may have started while the input boxes were open.
		if (!canMutateRegistry(getUiMode)) {
			return;
		}
		await registry.updateServer(serverId, label, baseUrl, apiKey);
		logger.log(`Updated server "${label}"`);

		void showActionableMessage("info", `Server "${label}" updated!`, [testConnectionAction(), dismissAction()]);

		if (label !== oldLabel) {
			warnAboutOrphanedModelParameters(oldLabel, label, Object.keys(getModelParametersConfig()));
		}
	} else if (pick.action === "test") {
		await vscode.commands.executeCommand(CMD.testConnection);
	} else if (pick.action === "remove") {
		if (!canMutateRegistry(getUiMode)) {
			return;
		}
		const confirm = await vscode.window.showWarningMessage(
			`Remove server "${server.label}" (${server.baseUrl})?`,
			{ modal: true },
			"Remove"
		);
		if (confirm === "Remove") {
			// A migration may have started while the confirmation dialog was open.
			if (!canMutateRegistry(getUiMode)) {
				return;
			}
			await registry.removeServer(serverId);
			logger.log(`Removed server "${server.label}"`);
			void vscode.window.showInformationMessage(`Server "${server.label}" removed.`);
		}
	}
}

/** Opens the Models Management editor, where VS Code manages provider groups. */
const NATIVE_MANAGE_MODELS_COMMAND = "workbench.action.chat.manage";

/** Settings-view filter that narrows to this extension's settings. */
export const EXTENSION_SETTINGS_FILTER = "@ext:vivswan.litellm-vscode-chat";

/**
 * Which UI the hub's server entry opens. "legacy" is the quick-pick server
 * flow. "nativePreferred" tries the native Manage Models UI and falls back to
 * the quick pick (fresh installs: the registry is still live, so servers
 * added there are served and migrated later). "nativeRequired" never falls
 * back: after the migration the registry is no longer served, so the quick
 * pick would edit dead configuration.
 */
export type ManagementUiMode = "legacy" | "nativePreferred" | "nativeRequired";

/**
 * A hub entry either routes in-module ("servers" and "settings" carry
 * arguments or mode logic) or names the extension command it executes as-is.
 */
interface HubItem extends vscode.QuickPickItem {
	action: "servers" | "settings" | CommandId;
}

const HUB_ITEMS: readonly HubItem[] = [
	{
		label: "$(server) Manage Language Models",
		description: "Servers, API keys, and which models are enabled",
		action: "servers",
	},
	{
		label: "$(dashboard) Open Dashboard",
		description: "Servers, models, and settings in one view",
		action: CMD.openDashboard,
	},
	{
		label: "$(sync) Sync Models Now",
		description: "Refetch the model list from every server",
		action: CMD.syncModels,
	},
	{
		label: "$(testing-run-icon) Test Connection",
		description: "Check every server and report the result",
		action: CMD.testConnection,
	},
	{
		label: "$(pulse) Show Diagnostics",
		description: "Connection state and per-server details",
		action: CMD.showDiagnostics,
	},
	{
		label: "$(key) Set Server Secret",
		description: "Store an API key or OAuth secret outside settings files",
		action: CMD.setServerSecret,
	},
	{
		label: "$(settings-gear) Open Settings",
		description: "Timeouts, caching, headers, model parameters",
		action: "settings",
	},
	{
		label: "$(question) Help & Feedback",
		description: "Documentation, feature requests, bug reports",
		action: CMD.helpAndFeedback,
	},
	{
		label: "$(report) Report Issue",
		description: "Open a prefilled GitHub issue",
		action: CMD.reportIssue,
	},
];

/**
 * The hub's server entry: the native provider-group editor where the mode
 * allows it, otherwise the legacy quick-pick flows over the registry (see
 * ManagementUiMode). Test Connection and Sync Models are not repeated in the
 * legacy list; the hub the user just came from carries both.
 */
async function openServerManagement(
	registry: ServerRegistry,
	logger: Logger,
	getUiMode: () => ManagementUiMode
): Promise<void> {
	const mode = getUiMode();
	if (mode !== "legacy") {
		try {
			await vscode.commands.executeCommand(NATIVE_MANAGE_MODELS_COMMAND);
			return;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (mode === "nativeRequired") {
				logger.log(`Language-model management UI unavailable (${message})`);
				void vscode.window.showErrorMessage(
					"LiteLLM servers are managed in VS Code's Manage Language Models UI, which could not be opened. Update VS Code or check that GitHub Copilot Chat is enabled."
				);
				return;
			}
			logger.log(`Language-model management UI unavailable (${message}); using the server quick pick`);
		}
	}

	const servers = registry.getServers();

	if (servers.length === 0) {
		await addServerFlow(registry, logger, getUiMode);
		return;
	}

	const items: (vscode.QuickPickItem & { action: string })[] = [
		{ label: "$(add) Add Server", action: "add" },
		...servers.map((s) => ({
			label: `$(server) ${s.label}`,
			description: s.baseUrl,
			action: `edit:${s.id}`,
		})),
	];

	const pick = await vscode.window.showQuickPick(items, {
		title: "LiteLLM: Manage Servers",
		placeHolder: "Select an action or server to manage",
	});

	if (!pick) {
		return;
	}

	if (pick.action === "add") {
		await addServerFlow(registry, logger, getUiMode);
	} else if (pick.action.startsWith("edit:")) {
		const serverId = pick.action.slice(5);
		await manageServerFlow(registry, serverId, logger, getUiMode);
	}
}

/**
 * litellm.manage is the extension's front door: a hub quick pick that routes
 * to the native server editor and the individually registered commands. It
 * holds no logic of its own beyond the server entry's UI-mode handling.
 *
 * litellm.manageServers is the direct route to the server editor for buttons
 * that promise configuration ("Configure Now", "Manage Servers"): those must
 * not land a user on the hub menu. It stays out of package.json's
 * contributes.commands, so the palette shows only the hub.
 */
export function registerManageCommand(
	context: vscode.ExtensionContext,
	registry: ServerRegistry,
	logger: Logger,
	getUiMode: () => ManagementUiMode = () => "legacy"
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.manage, async () => {
			const pick = await vscode.window.showQuickPick([...HUB_ITEMS], {
				title: "LiteLLM",
				placeHolder: "Select an action",
			});
			if (!pick) {
				return;
			}
			if (pick.action === "servers") {
				await openServerManagement(registry, logger, getUiMode);
			} else if (pick.action === "settings") {
				await vscode.commands.executeCommand("workbench.action.openSettings", EXTENSION_SETTINGS_FILTER);
			} else {
				await vscode.commands.executeCommand(pick.action);
			}
		}),
		vscode.commands.registerCommand(INTERNAL_CMD.manageServers, () => openServerManagement(registry, logger, getUiMode))
	);
}
