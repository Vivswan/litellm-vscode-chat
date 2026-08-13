import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { CommandId } from "../../shared/config/commandIds";
import { CMD, INTERNAL_CMD, manageCommandTitle } from "../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import {
	getMaskSecretInputs,
	getModelParametersConfig,
	MODEL_PARAMETERS_SETTING_KEY,
} from "../../shared/config/settings";
import type { Logger } from "../../shared/logger";
import { isGroupMigrationRunning } from "../migrations/registryToProviderGroups";
import {
	dismissAction,
	openChatAction,
	openSettingsAction,
	showActionableMessage,
	testConnectionAction,
} from "../ui/notifier";
import {
	MigrationInProgressError,
	type RegistryMutationVerdict,
	RegistryRetiredError,
	type ServerRegistry,
} from "./serverRegistry";

/**
 * Whether the registry is still mutable in each UI mode. Only "groupsOnly"
 * (the migration emptied the registry) refuses: pre-migration modes stay
 * mutable because the migration consumes registry edits - renaming a skipped
 * server is how its skip marker lifts. Exhaustive by construction, so a mode
 * added to ManagementUiMode does not compile until it takes a side here.
 */
const REGISTRY_MUTABLE_IN_MODE: Record<ManagementUiMode, boolean> = {
	legacy: true,
	groupsWithRegistry: true,
	groupsOnly: false,
};

/**
 * What the registry's mutation guard reports right now. "migrating" while the
 * provider-group migration is seeding groups: a racing edit would be marked
 * skipped for manual review and a racing add would wait a whole activation
 * for its group, so writes are refused with a try-again notice instead.
 * "retired" once the migration emptied the registry (see
 * REGISTRY_MUTABLE_IN_MODE): a write would edit legacy state nothing reads
 * anymore. Activation installs this as the registry's guard, so every
 * mutator enforces it at write time; the flows below also consult it before
 * prompting, as a courtesy, so the user does not type into a flow whose
 * write will be refused.
 */
export function registryMutationVerdict(getUiMode: () => ManagementUiMode): RegistryMutationVerdict {
	if (isGroupMigrationRunning()) {
		return "migrating";
	}
	return REGISTRY_MUTABLE_IN_MODE[getUiMode()] ? "ok" : "retired";
}

function showMutationRefusedNotice(verdict: "migrating" | "retired"): void {
	if (verdict === "migrating") {
		void vscode.window.showInformationMessage(l10n.t("Server migration is in progress, try again in a moment."));
		return;
	}
	void vscode.window.showInformationMessage(
		l10n.t('LiteLLM servers are now managed in the LiteLLM dashboard. Re-run "{0}" to open it.', manageCommandTitle())
	);
}

/** The flows' pre-prompt courtesy check; the notice matches what the write-time refusal would show. */
export function canMutateRegistry(getUiMode: () => ManagementUiMode): boolean {
	const verdict = registryMutationVerdict(getUiMode);
	if (verdict === "ok") {
		return true;
	}
	showMutationRefusedNotice(verdict);
	return false;
}

/** Run one guarded registry write, mapping a typed refusal onto its notice. Resolves false when refused. */
async function runRegistryMutation(mutate: () => Promise<void>): Promise<boolean> {
	try {
		await mutate();
		return true;
	} catch (error) {
		if (error instanceof MigrationInProgressError) {
			showMutationRefusedNotice("migrating");
			return false;
		}
		if (error instanceof RegistryRetiredError) {
			showMutationRefusedNotice("retired");
			return false;
		}
		throw error;
	}
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
		title: editing ? l10n.t("LiteLLM: Edit Server - Label") : l10n.t("LiteLLM: Add Server - Label"),
		prompt: editing
			? l10n.t("Update the server label")
			: l10n.t("Enter a unique label for this server (e.g., 'Production', 'Local Dev')"),
		ignoreFocusOut: true,
		...(editing ? { value: initial } : { placeHolder: l10n.t("My LiteLLM Server") }),
		validateInput: (value) => {
			if (!value.trim()) {
				return l10n.t("Label is required");
			}
			if (value.includes("/")) {
				return l10n.t("Label cannot contain '/' (used as separator in model parameters)");
			}
			if (registry.hasLabel(value.trim(), excludeId)) {
				return l10n.t("A server with this label already exists");
			}
			return null;
		},
	});
	return value?.trim();
}

async function promptForBaseUrl(initial?: string): Promise<string | undefined> {
	const editing = initial !== undefined;
	const value = await vscode.window.showInputBox({
		title: editing ? l10n.t("LiteLLM: Edit Server - Base URL") : l10n.t("LiteLLM: Add Server - Base URL"),
		prompt: editing ? l10n.t("Update the LiteLLM base URL") : l10n.t("Enter the LiteLLM base URL"),
		ignoreFocusOut: true,
		// The placeholder is a pure example URL; URLs stay untranslated.
		...(editing ? { value: initial } : { placeHolder: "http://localhost:4000" }),
		validateInput: (value) => {
			if (!value.trim()) {
				return l10n.t("Base URL is required");
			}
			if (!value.startsWith("http://") && !value.startsWith("https://")) {
				return l10n.t("URL must start with http:// or https://");
			}
			return null;
		},
	});
	return value?.trim();
}

async function promptForApiKey(masked: boolean, initial?: string): Promise<string | undefined> {
	const editing = initial !== undefined;
	const value = await vscode.window.showInputBox({
		title: editing ? l10n.t("LiteLLM: Edit Server - API Key") : l10n.t("LiteLLM: Add Server - API Key"),
		prompt:
			editing && initial ? l10n.t("Update the API key") : l10n.t("Enter the API key (leave empty if not required)"),
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
	const firstOrphan = orphaned[0];
	if (firstOrphan === undefined) {
		return;
	}
	void showActionableMessage(
		"warning",
		orphaned.length === 1
			? l10n.t(
					'Renaming the server left 1 modelParameters entry scoped to the old label (e.g., "{0}"). Update the "{1}" prefix to "{2}/" in settings to keep them applied.',
					firstOrphan,
					prefix,
					newLabel
				)
			: l10n.t(
					'Renaming the server left {0} modelParameters entries scoped to the old label (e.g., "{1}"). Update the "{2}" prefix to "{3}/" in settings to keep them applied.',
					orphaned.length,
					firstOrphan,
					prefix,
					newLabel
				),
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

	const apiKey = await promptForApiKey(getMaskSecretInputs());
	if (apiKey === undefined) {
		return false;
	}

	const added = await runRegistryMutation(async () => {
		await registry.addServer(label, baseUrl, apiKey);
	});
	if (!added) {
		return false;
	}
	logger.log(`Added server "${label}" at ${baseUrl}`);

	void showActionableMessage("info", l10n.t('Server "{0}" added!', label), [
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
			{ label: l10n.t("$(edit) Edit Server"), action: "edit" },
			{ label: l10n.t("$(testing-run-icon) Test All Servers"), action: "test" },
			{ label: l10n.t("$(trash) Remove Server"), action: "remove" },
		],
		{
			title: l10n.t("LiteLLM: {0}", server.label),
			placeHolder: l10n.t('Manage server "{0}" ({1})', server.label, server.baseUrl),
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
		const apiKey = await promptForApiKey(getMaskSecretInputs(), existingApiKey);
		if (apiKey === undefined) {
			return;
		}

		const oldLabel = server.label;
		if (!(await runRegistryMutation(() => registry.updateServer(serverId, label, baseUrl, apiKey)))) {
			return;
		}
		logger.log(`Updated server "${label}"`);

		void showActionableMessage("info", l10n.t('Server "{0}" updated!', label), [
			testConnectionAction(),
			dismissAction(),
		]);

		if (label !== oldLabel) {
			warnAboutOrphanedModelParameters(oldLabel, label, Object.keys(getModelParametersConfig()));
		}
	} else if (pick.action === "test") {
		await vscode.commands.executeCommand(CMD.testConnection);
	} else if (pick.action === "remove") {
		if (!canMutateRegistry(getUiMode)) {
			return;
		}
		const removeButton = l10n.t("Remove");
		const confirm = await vscode.window.showWarningMessage(
			l10n.t('Remove server "{0}" ({1})?', server.label, server.baseUrl),
			{ modal: true },
			removeButton
		);
		if (confirm === removeButton) {
			if (!(await runRegistryMutation(() => registry.removeServer(serverId)))) {
				return;
			}
			logger.log(`Removed server "${server.label}"`);
			void vscode.window.showInformationMessage(l10n.t('Server "{0}" removed.', server.label));
		}
	}
}

/** Settings-view filter that narrows to this extension's settings. */
export const EXTENSION_SETTINGS_FILTER = "@ext:vivswan.litellm-vscode-chat";

/**
 * Which UI the hub's server entry opens. "legacy" is the quick-pick server
 * flow over the registry, for a user whose registry still holds unmigrated
 * servers: editing there feeds the migration (a rename lifts a server's skip
 * marker), so the flow survives until isGroupMigrationComplete. The other two
 * open the dashboard's Servers view: "groupsWithRegistry" means the
 * registry was never populated (fresh installs), "groupsOnly" means the
 * migration retired it, so the quick pick would edit dead state.
 */
export type ManagementUiMode = "legacy" | "groupsWithRegistry" | "groupsOnly";

/**
 * A hub entry either routes in-module ("servers" and "settings" carry
 * arguments or mode logic) or names the extension command it executes as-is.
 */
interface HubItem extends vscode.QuickPickItem {
	action: "servers" | "settings" | CommandId;
}

/**
 * The hub entries, resolved per open: a module-level constant would localize
 * before l10n.config and freeze English. Codicon prefixes stay inside the
 * literals so extraction keys match what the quick pick displays.
 */
function hubItems(): readonly HubItem[] {
	return [
		{
			label: l10n.t("$(server) Manage Servers"),
			description: l10n.t("Servers, API keys, and which models are enabled"),
			action: "servers",
		},
		{
			label: l10n.t("$(dashboard) Open Dashboard"),
			description: l10n.t("Servers, models, and settings in one view"),
			action: CMD.openDashboard,
		},
		{
			label: l10n.t("$(sync) Sync Models Now"),
			description: l10n.t("Refetch the model list from every server"),
			action: CMD.syncModels,
		},
		{
			label: l10n.t("$(testing-run-icon) Test Connection"),
			description: l10n.t("Check every server and report the result"),
			action: CMD.testConnection,
		},
		{
			label: l10n.t("$(pulse) Show Diagnostics"),
			description: l10n.t("Connection state and per-server details"),
			action: CMD.showDiagnostics,
		},
		{
			label: l10n.t("$(key) Set Server Secret"),
			description: l10n.t("Store an API key or OAuth secret outside settings files"),
			action: CMD.setServerSecret,
		},
		{
			label: l10n.t("$(settings-gear) Open Settings"),
			description: l10n.t("Timeouts, caching, headers, model parameters"),
			action: "settings",
		},
		{
			label: l10n.t("$(question) Help & Feedback"),
			description: l10n.t("Documentation, feature requests, bug reports"),
			action: CMD.helpAndFeedback,
		},
		{
			label: l10n.t("$(report) Report Issue"),
			description: l10n.t("Open a prefilled GitHub issue"),
			action: CMD.reportIssue,
		},
	];
}

/**
 * The hub's server entry: the dashboard's Servers view where the
 * mode allows it, otherwise the legacy quick-pick flows over the registry
 * (see ManagementUiMode). Test Connection and Sync Models are not repeated in
 * the legacy list; the hub the user just came from carries both.
 */
async function openServerManagement(
	registry: ServerRegistry,
	logger: Logger,
	getUiMode: () => ManagementUiMode
): Promise<void> {
	const mode = getUiMode();
	if (mode !== "legacy") {
		await vscode.commands.executeCommand(CMD.openDashboard);
		return;
	}

	const servers = registry.getServers();

	if (servers.length === 0) {
		await addServerFlow(registry, logger, getUiMode);
		return;
	}

	const items: (vscode.QuickPickItem & { action: string })[] = [
		{ label: l10n.t("$(add) Add Server"), action: "add" },
		...servers.map((s) => ({
			label: `$(server) ${s.label}`,
			description: s.baseUrl,
			action: `edit:${s.id}`,
		})),
	];

	const pick = await vscode.window.showQuickPick(items, {
		title: l10n.t("LiteLLM: Manage Servers"),
		placeHolder: l10n.t("Select an action or server to manage"),
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
 * to the server-management surface and the individually registered commands.
 * It holds no logic of its own beyond the server entry's UI-mode handling.
 *
 * litellm.manageServers is the direct route to server management for callers
 * that promise configuration (the dashboard's manage intent): those must not
 * land a user on the hub menu. It stays out of package.json's
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
			const pick = await vscode.window.showQuickPick([...hubItems()], {
				title: "LiteLLM",
				placeHolder: l10n.t("Select an action"),
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
