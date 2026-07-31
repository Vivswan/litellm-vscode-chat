import * as vscode from "vscode";
import {
	registerHelpAndFeedbackCommand,
	registerReportIssueCommand,
	registerSyncModelsCommand,
	registerTestCommands,
	registerTestConnectionCommand,
} from "./extension/commands";
import { registerDashboardCommand } from "./extension/dashboard/panel";
import { consumeDevSeed, createDevSeedEnv } from "./extension/devSeed";
import { registerDiagnosticsCommand } from "./extension/diagnostics";
import type { MigrationContext } from "./extension/migrations";
import { runMigrations } from "./extension/migrations";
import { getMigratedServerLabels, isGroupMigrationComplete } from "./extension/migrations/registryToProviderGroups";
import {
	CONFIGURE_NOW_LABEL,
	createConfigurationPrompt,
	Notifier,
	reconfigureAction,
	showActionableMessage,
} from "./extension/notifier";
import { registerManageCommand } from "./extension/serverManagement";
import { ServerRegistry } from "./extension/serverRegistry";
import {
	createServerSyncEnv,
	parseServersSetting,
	registerSetServerSecretCommand,
	ServerSyncEngine,
} from "./extension/serverSync";
import { StatusBarManager } from "./extension/status";
import { createIssueReporterEnv, IssueReporter } from "./issueReporter";
import { LiteLLMChatModelProvider } from "./provider";
import { CMD, VENDOR_ID } from "./shared/commandIds";
import type { DevSeed } from "./shared/devSeed";
import { GITHUB_DOCS_URL } from "./shared/links";
import { Logger } from "./shared/logger";
import type { AggregatedStatus } from "./shared/servers";
import { CONFIG_SECTION } from "./shared/settingSpec";
import { SERVERS_SETTING_KEY } from "./shared/settings";
import { HAS_SHOWN_WELCOME_KEY } from "./shared/storageKeys";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const extVersion: string = context.extension.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	const ua = `litellm-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

	const outputChannel = vscode.window.createOutputChannel("LiteLLM", { log: true });
	context.subscriptions.push(outputChannel);

	const issueReporter = new IssueReporter(createIssueReporterEnv(context.globalStorageUri));
	const logger = new Logger(outputChannel, issueReporter);
	logger.log(`LiteLLM Extension activated (v${extVersion})`);
	const registry = new ServerRegistry(context.globalState, context.secrets);
	// Test mode keeps the registry live for the group-agnostic refresh even
	// after migration: there is no programmatic way to remove provider groups,
	// so the host-fidelity suite drives models through the registry.
	const testMode = context.extensionMode !== vscode.ExtensionMode.Production;
	const isMigrated = () => isGroupMigrationComplete(context.globalState);
	const provider = new LiteLLMChatModelProvider({
		userAgent: ua,
		logger,
		getServers: () => registry.getServersWithKeys(),
		getMigratedServerLabels: () => getMigratedServerLabels(context.globalState),
		grouplessRegistryEnabled: () => testMode || !isMigrated(),
	});

	// The setting itself is the truth here, not the sync engine's view: the
	// prompt and the welcome toast can run before the first sync pass finishes.
	const hasDeclaredServers = () =>
		parseServersSetting(vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY)).entries.length > 0;
	// The shared not-configured gate: the registry-backed refresh path knows
	// nothing about the newer stores, so declared servers-setting entries and
	// live provider groups both mean "configured" before anything toasts.
	// hasSeenGroupConfiguration is the cold-start-honest signal: the host's
	// groupless refresh reports an empty window before it re-resolves each
	// group, so the live snapshot count alone would wrongly read as empty.
	const hasConfiguredServers = () =>
		provider.getServerSnapshots().length > 0 || provider.hasSeenGroupConfiguration() || hasDeclaredServers();
	provider.setConfigurationPrompt(createConfigurationPrompt(hasConfiguredServers));

	// The provider must not see a half-migrated registry, so pre-registration
	// migrations complete before registration. Best-effort: a failed migration
	// logs and retries on the next activation.
	const migrationContext: MigrationContext = {
		globalState: context.globalState,
		secrets: context.secrets,
		registry,
		logger,
	};
	await runMigrations("pre-registration", migrationContext);

	vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider);

	// One-shot seed dropped by `bun run dev`; development-mode only. It
	// writes the servers-setting entry and the label's stored API key; the
	// forced server sync pass below turns the entry into the provider group.
	let devSeed: DevSeed | undefined;
	if (testMode) {
		try {
			devSeed = await consumeDevSeed(context.extensionUri, createDevSeedEnv(context.secrets), logger);
		} catch (error) {
			logger.error("Dev seed failed", error);
		}
	}

	// Status bar, refresh notifications, and the dashboard share the same
	// status callback, isolated so one consumer's failure cannot starve the
	// others.
	const statusBar = new StatusBarManager(context, logger, hasConfiguredServers);
	const notifier = new Notifier(hasConfiguredServers);
	// The declarative server sync: litellm-vscode-chat.servers entries become
	// provider groups. Created before the dashboard, which edits the setting
	// and reads the engine's declared-server view.
	const syncEngine = new ServerSyncEngine(createServerSyncEnv(context, logger));
	context.subscriptions.push(
		// Disposal withdraws an armed no-servers claim, so its deferred toast
		// cannot fire from a deactivated extension.
		notifier,
		syncEngine,
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(`${CONFIG_SECTION}.${SERVERS_SETTING_KEY}`)) {
				syncEngine.requestSync();
			}
		})
	);
	registerSetServerSecretCommand(context, syncEngine, logger);
	const dashboard = registerDashboardCommand(context, provider, logger, syncEngine);
	syncEngine.onDidSync = () => dashboard.refresh();
	// Test-only commands; registered after the sync engine and the dashboard
	// exist because the docker-serversync suite reads the engine's declared
	// views through them and the monkey fuzzer injects dashboard messages.
	registerTestCommands(context, registry, provider, issueReporter, syncEngine, dashboard);
	// The first pass runs off the activation path: it may hit the host command
	// (which validates groups against the provider) and the network. Forced,
	// so groups edited or deleted natively since the last session reconcile.
	void syncEngine.syncNow(true);
	provider.setStatusCallback((aggStatus: AggregatedStatus) => {
		try {
			statusBar.handleAggregatedStatus(aggStatus);
		} catch (error) {
			logger.error("Status bar update failed", error);
		}
		try {
			notifier.handleAggregatedStatus(aggStatus);
		} catch (error) {
			logger.error("Notifier update failed", error);
		}
		try {
			dashboard.refresh();
		} catch (error) {
			logger.error("Dashboard refresh failed", error);
		}
	});

	// Hands registry servers to VS Code as provider groups. The host validates
	// each group by calling the registered provider, so this phase runs after
	// registration, and off the activation path because it hits the network.
	void runMigrations("post-registration", migrationContext);

	if (devSeed?.openDashboard) {
		void vscode.commands.executeCommand(CMD.openDashboard).then(undefined, (error: unknown) => {
			logger.error("Dev seed dashboard open failed", error);
		});
	}

	// Welcome message. Gated on the legacy registry and the declared servers
	// setting only: this runs during activation, before the host has handed
	// over any provider group, so the group latch cannot contribute yet.
	const hasShownWelcome = context.globalState.get<boolean>(HAS_SHOWN_WELCOME_KEY, false);
	if (!hasShownWelcome && registry.getServers().length === 0 && !hasDeclaredServers()) {
		showActionableMessage("info", "Welcome to LiteLLM! Connect to 100+ LLMs in VS Code.", [
			reconfigureAction(CONFIGURE_NOW_LABEL),
			{ label: "Documentation", run: () => void vscode.env.openExternal(vscode.Uri.parse(GITHUB_DOCS_URL)) },
		]).catch((error) => {
			logger.error("Welcome message failed", error);
		});
	}
	if (!hasShownWelcome) {
		await context.globalState.update(HAS_SHOWN_WELCOME_KEY, true);
	}

	// Server management command: the native provider-group UI once the registry
	// is migrated (no fallback: the quick pick would edit configuration nothing
	// serves anymore) or was never populated (with the quick pick as fallback).
	registerManageCommand(
		context,
		registry,
		logger,
		() => {
			if (testMode) {
				return "legacy";
			}
			if (isMigrated()) {
				return "nativeRequired";
			}
			return registry.getServers().length === 0 ? "nativePreferred" : "legacy";
		},
		() => !testMode && isMigrated()
	);

	// Test connection command
	registerTestConnectionCommand(context, provider, statusBar, outputChannel, logger);

	// Sync Models Now command: a forced server sync first (reconciling groups
	// edited natively), then a discovery-cache-skipping refetch of every group.
	registerSyncModelsCommand(context, provider, statusBar, outputChannel, logger, () => syncEngine.syncNow(true));

	// Diagnostics command: reads the same stores the dashboard renders, with
	// the status bar's connection status for the legacy-registry-only world.
	registerDiagnosticsCommand(
		context,
		registry,
		() => provider.getServerSnapshots(),
		() => syncEngine.getDeclared(),
		() => statusBar.connectionStatus,
		outputChannel
	);

	// Help & Feedback command
	registerHelpAndFeedbackCommand(context);

	// Report Issue command
	registerReportIssueCommand(
		context,
		registry,
		() => statusBar.connectionStatus,
		extVersion,
		vscodeVersion,
		issueReporter
	);
}

export function deactivate() {}
