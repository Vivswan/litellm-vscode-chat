import * as vscode from "vscode";
import { registerDashboardCommand } from "./extension/dashboard/panel";
import { consumeDevSeed, createDevSeedEnv } from "./extension/devSeed";
import { loadFingerprintSalt } from "./extension/fingerprintSalt";
import { configureSharedL10n } from "./extension/l10nConfig";
import type { MigrationContext } from "./extension/migrations";
import { runMigrations } from "./extension/migrations";
import { isGroupMigrationComplete } from "./extension/migrations/registryToProviderGroups";
import { createOpenRouterCatalogStore } from "./extension/openRouterCatalog";
import { registerOpenRouterCatalogTestSeam } from "./extension/openRouterCatalogTestSeam";
import { GroupRemovalStore } from "./extension/servers/groupRemovals";
import {
	type ManagementUiMode,
	REGISTRY_SERVED_IN_MODE,
	registerManageCommand,
	registryMutationVerdict,
} from "./extension/servers/serverManagement";
import { ServerRegistry } from "./extension/servers/serverRegistry";
import {
	createServerSyncEnv,
	parseServersSetting,
	readEntryDeclaredModels,
	readEntryExpectedFailures,
	readEntryHeaders,
	readEntryModelCapabilities,
	readEntryModelParameters,
	registerSetServerSecretCommand,
	ServerSyncEngine,
} from "./extension/servers/serverSync";
import { createUsagePollerEnv, registerRefreshUsageCommand, UsagePoller } from "./extension/servers/usage";
import {
	createTestEntrySeams,
	registerHelpAndFeedbackCommand,
	registerOpenGroupsFileCommand,
	registerReportIssueCommand,
	registerSyncModelsCommand,
	registerTestCommands,
	registerTestConnectionCommand,
	SessionLogTee,
} from "./extension/ui/commands";
import { createIssueReporterEnv, IssueReporter } from "./extension/ui/issueReporter";
import {
	configureNowLabel,
	createConfigurationPrompt,
	Notifier,
	reconfigureAction,
	showActionableMessage,
} from "./extension/ui/notifier";
import { registerOpenSettingKeyCommand } from "./extension/ui/openSettingKey";
import { StatusBarManager, StatusItem } from "./extension/ui/status";
import { UsageAlerts } from "./extension/ui/usageAlerts";
import { UsageStatusBar } from "./extension/ui/usageStatusItem";
import { LiteLLMChatModelProvider } from "./provider";
import { CMD, INTERNAL_CMD, VENDOR_ID } from "./shared/config/commandIds";
import type { BooleanSettingId, NumberSettingId } from "./shared/config/settingSpec";
import { CONFIG_SECTION } from "./shared/config/settingSpec";
import {
	getUsageAlertThresholds,
	getUsagePollIntervalMs,
	getUsageStatusBarMode,
	isOpenRouterCatalogEnabled,
	MODEL_CAPABILITIES_SETTING_KEY,
	SERVERS_SETTING_KEY,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
	USAGE_STATUS_BAR_SETTING_KEY,
} from "./shared/config/settings";
import { HAS_SHOWN_WELCOME_KEY } from "./shared/config/storageKeys";
import type { DevSeed } from "./shared/devSeed";
import { Logger } from "./shared/logger";
import type { AggregatedStatus } from "./shared/servers";
import { debounced } from "./shared/util/debounce";
import { GITHUB_DOCS_URL } from "./shared/util/links";

const OPENROUTER_CATALOG_SETTING_ID = "models.openRouterCatalog" satisfies BooleanSettingId;

const USAGE_POLL_INTERVAL_SETTING_ID = "usage.pollInterval" satisfies NumberSettingId;

/** How long configuration-change bursts (settings.json keystrokes) coalesce before models re-resolve. */
const CONFIG_CHANGE_DEBOUNCE_MS = 400;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// The activation-production harness calls this compiled function itself
	// with a fake Production-mode context while the real extension loaded into
	// its host (Test mode under @vscode/test-cli) must stay inert:
	// onStartupFinished would otherwise activate it first and every command
	// registration would collide. The env flag is set only by
	// .vscode-test.mjs's activation-production label, and the mode check keeps
	// the harness's own Production-mode call running.
	if (
		context.extensionMode !== vscode.ExtensionMode.Production &&
		process.env.LITELLM_SUPPRESS_STARTUP_ACTIVATION === "1"
	) {
		return;
	}

	// Before anything renders a string: shared modules localize through
	// @vscode/l10n and need the host bundle (see extension/l10nConfig.ts).
	configureSharedL10n();

	const extVersion: string = context.extension.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	const ua = `litellm-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

	const outputChannel = vscode.window.createOutputChannel("LiteLLM", { log: true });
	context.subscriptions.push(outputChannel);

	const issueReporter = new IssueReporter(createIssueReporterEnv(context.globalStorageUri));
	const testMode = context.extensionMode !== vscode.ExtensionMode.Production;
	// Non-production only: litellm._test.getSessionLogs reads the session's
	// log lines losslessly through this tee (the production buffer behind it
	// is a small rolling window a leak scan could race).
	const sessionLogTee = testMode ? new SessionLogTee(issueReporter) : undefined;
	const logger = new Logger(outputChannel, sessionLogTee ?? issueReporter);
	logger.log(`LiteLLM Extension activated (v${extVersion})`);
	// Before anything else: every credential identity in the process (group
	// client IDs, cached clients, the sync engine's fingerprint map) is keyed
	// by this salt, so it must be installed before migrations or the provider
	// can compute a fingerprint.
	const fingerprintSalt = await loadFingerprintSalt(context.secrets, context.globalStorageUri, logger);
	const registry = new ServerRegistry(context.globalState, context.secrets);
	// Test mode keeps the registry live for the group-agnostic refresh even
	// after migration: there is no programmatic way to remove provider groups,
	// so the host-fidelity suite drives models through the registry.
	// The litellm._test.setEntry* seams for the registry path (no programmatic
	// provider-group removal, so the host-fidelity and docker suites exercise
	// entry records there). The seams exist only in non-production mode, and
	// the composed resolvers below are the single entry-record read path for
	// both the provider and the dashboard's capability inspector.
	const testEntrySeams = testMode ? createTestEntrySeams() : undefined;
	const getEntryModelCapabilities =
		testEntrySeams === undefined
			? readEntryModelCapabilities
			: (label: string, baseUrl: string) =>
					testEntrySeams.capabilities.get(label) ?? readEntryModelCapabilities(label, baseUrl);
	const getEntryDeclaredModels =
		testEntrySeams === undefined
			? readEntryDeclaredModels
			: (label: string, baseUrl: string) =>
					testEntrySeams.declared.get(label) ?? readEntryDeclaredModels(label, baseUrl);
	const isMigrated = () => isGroupMigrationComplete(context.globalState);
	// The management UI mode is also the registry-liveness truth (see
	// REGISTRY_SERVED_IN_MODE): the dashboard once the registry is migrated
	// (the quick pick would edit configuration nothing serves anymore) or was
	// never populated, and always the legacy flows in test mode.
	const getManagementUiMode = (): ManagementUiMode => {
		if (testMode) {
			return "legacy";
		}
		if (isMigrated()) {
			return "groupsOnly";
		}
		return registry.getServers().length === 0 ? "groupsWithRegistry" : "legacy";
	};
	// The registry-side enforcement of the same verdict the prompt flows show
	// notices for: mutators refuse with typed errors while the migration seeds
	// groups or after it retired the registry; the migrations and the
	// litellm._test.* seams mutate through the unguarded methods.
	registry.installMutationGuard(() => registryMutationVerdict(getManagementUiMode));
	// Groups the user explicitly removed (the host command is add-only, so
	// removal works by tombstoning): the provider consults the store on every
	// group refresh, and tombstone changes fire the model-change event below.
	const groupRemovals = new GroupRemovalStore(context.globalState);
	// The OpenRouter capability catalog: bundled snapshot, globalStorage cache,
	// weekly refresh. Created before the provider because the provider's
	// catalog seam reads its lookup; the snapshot loads later (see the
	// initialize call below), and lookups answer not-found until it lands.
	const catalogStore = createOpenRouterCatalogStore({
		extensionUri: context.extensionUri,
		globalStorageUri: context.globalStorageUri,
		globalState: context.globalState,
		logger,
		isEnabled: isOpenRouterCatalogEnabled,
	});
	context.subscriptions.push(catalogStore);
	// The palette twin of the dashboard row's Refresh button: one immediate
	// catalog refresh; outcomes report in the row status, never as a toast.
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.refreshOpenRouterCatalog, () => catalogStore.refreshNow())
	);
	const provider = new LiteLLMChatModelProvider({
		userAgent: ua,
		logger,
		getServers: () => registry.getServersWithKeys(),
		getEntryModelParameters: readEntryModelParameters,
		getEntryModelCapabilities,
		getEntryHeaders: readEntryHeaders,
		getEntryDeclaredModels,
		getExpectedFailures: readEntryExpectedFailures,
		getCatalogLookup: () => catalogStore.lookup,
		grouplessRegistryEnabled: () => REGISTRY_SERVED_IN_MODE[getManagementUiMode()],
		isGroupSuppressed: (label, baseUrl) => groupRemovals.isTombstoned(label, baseUrl),
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
		fingerprintSalt,
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
	const statusBar = new StatusBarManager(
		context,
		logger,
		hasConfiguredServers,
		new StatusItem({
			slot: "connection",
			alignment: vscode.StatusBarAlignment.Right,
			priority: 100,
			command: CMD.openDashboard,
			log: (message) => logger.log(message),
		})
	);
	const notifier = new Notifier(hasConfiguredServers);
	// The declarative server sync: litellm-vscode-chat.servers entries become
	// provider groups. Created before the dashboard, which edits the setting
	// and reads the engine's declared-server view.
	const syncEngine = new ServerSyncEngine(createServerSyncEnv(context, logger, fingerprintSalt, groupRemovals));
	// The headless usage poller: per-server spend, budgets, and threshold
	// crossings for the usage surfaces (#232). Polls on its own cadence
	// (usage.pollInterval; 0 = off) independent of discovery.
	const usagePoller = new UsagePoller(createUsagePollerEnv(context, logger, ua));
	// Assigned once the dashboard exists (its click command needs the panel);
	// the configuration listener below is registered first, so it reaches the
	// item through this slot.
	let usageStatusBar: UsageStatusBar | undefined;
	// One debounced notify shared by every configuration branch below, so a
	// multi-setting edit re-resolves models once. Errors are isolated like the
	// other notify call sites: a throw must not escape into the timer.
	const notifyModelsChanged = debounced(() => {
		try {
			provider.notifyModelInformationChanged();
		} catch (error) {
			logger.error("Configuration-change model notification failed", error);
		}
	}, CONFIG_CHANGE_DEBOUNCE_MS);
	context.subscriptions.push(
		// Disposal withdraws an armed no-servers claim, so its deferred toast
		// cannot fire from a deactivated extension.
		notifier,
		syncEngine,
		usagePoller,
		notifyModelsChanged,
		vscode.workspace.onDidChangeConfiguration((event) => {
			const affects = (id: string) => event.affectsConfiguration(`${CONFIG_SECTION}.${id}`);
			if (affects(SERVERS_SETTING_KEY)) {
				// The sync alone cannot re-attach models for an entry whose
				// models records, headers, discovery block, or budget changed: those
				// fields stay out of the group args and the sync fingerprint, so the
				// debounced notify is what makes the host re-resolve the groups.
				syncEngine.requestSync();
				notifyModelsChanged.schedule();
				// Entry budgets and connections ride the same setting; the poller
				// prunes removed servers and re-probes availability.
				usagePoller.applyServersChange();
			}
			if (affects(USAGE_POLL_INTERVAL_SETTING_ID) || affects(USAGE_ALERT_THRESHOLDS_SETTING_KEY)) {
				usagePoller.applyConfiguration();
			}
			if (
				affects(USAGE_POLL_INTERVAL_SETTING_ID) ||
				affects(USAGE_ALERT_THRESHOLDS_SETTING_KEY) ||
				affects(USAGE_STATUS_BAR_SETTING_KEY)
			) {
				// The item re-reads mode, thresholds, and the freshness window at
				// render time; a re-render is the whole reaction.
				usageStatusBar?.applyConfiguration();
			}
			if (affects(MODEL_CAPABILITIES_SETTING_KEY)) {
				// Capability overrides are applied where models attach, outside the
				// discovery cache, so a notify alone suffices: no cache clear, no
				// network.
				notifyModelsChanged.schedule();
			}
			if (affects(OPENROUTER_CATALOG_SETTING_ID)) {
				// Opting out cancels the pending refresh (all catalog network) and
				// opting back in reschedules it; the registration effect - the
				// implicit lookup turning on or off - is the notify.
				catalogStore.applyEnabledSetting();
				notifyModelsChanged.schedule();
			}
		})
	);
	// A palette-stored secret can fix a key the proxy had rejected, so the
	// usage poller re-probes availability when one changes.
	registerSetServerSecretCommand(context, syncEngine, logger, () => usagePoller.applyServersChange());
	// Refresh Usage Now: the poller's explicit refresh, availability re-probed,
	// working whether or not polling is on. The first scheduled pass runs off
	// the activation path.
	registerRefreshUsageCommand(context, () => usagePoller.refreshNow());
	usagePoller.start();
	// Also registers litellm.showDiagnostics: the command deep-links to the
	// dashboard's Diagnostics tab, and the dashboard states the legacy
	// registry's leftovers, which is why it takes the registry.
	const dashboard = registerDashboardCommand(
		context,
		provider,
		logger,
		syncEngine,
		registry,
		groupRemovals,
		catalogStore,
		usagePoller,
		getEntryModelCapabilities
	);
	syncEngine.onDidSync = () => dashboard.refresh();
	// The usage surfaces over the poller's store: the status bar item beside
	// the connection item, the budget alert toasts, and the deep link both
	// click through to the dashboard's Usage section. Constructed here because
	// the click target needs the dashboard.
	usageStatusBar = new UsageStatusBar({
		store: usagePoller.store,
		item: new StatusItem({
			slot: "usage",
			alignment: vscode.StatusBarAlignment.Right,
			priority: 99,
			command: INTERNAL_CMD.openUsage,
			log: (message) => logger.log(message),
		}),
		getMode: getUsageStatusBarMode,
		getThresholds: () => getUsageAlertThresholds(),
		getPollIntervalMs: () => getUsagePollIntervalMs(),
	});
	context.subscriptions.push(
		usageStatusBar,
		new UsageAlerts(usagePoller.store),
		vscode.commands.registerCommand(INTERNAL_CMD.openUsage, () => dashboard.open("usage")),
		// The coarse "pass done" push: the dashboard's usage section re-renders
		// after every completed poll pass (the poller isolates its listeners).
		usagePoller.onDidRefresh(() => dashboard.refresh())
	);
	// A refreshed catalog snapshot must become visible without waiting for an
	// unrelated refresh: the debounced notify re-attaches models (catalog
	// levels re-resolve at attach) and the dashboard re-push re-renders the
	// inspector's catalog rows.
	context.subscriptions.push(
		catalogStore.onDidUpdate(() => {
			notifyModelsChanged.schedule();
			try {
				dashboard.refresh();
			} catch (error) {
				logger.error("Dashboard refresh failed", error);
			}
		})
	);
	// Load the cached or bundled snapshot off the activation path (never
	// throws), then notify exactly when something was installed: models the
	// host resolved before the load must not keep the empty catalog until an
	// unrelated refresh, while a dev build without the artifact changes
	// nothing and must not fire a spurious re-resolve.
	void catalogStore.initialize().then(() => {
		if (catalogStore.snapshot().models.length > 0) {
			notifyModelsChanged.schedule();
		}
	});
	// A tombstone change must reach the picker and the dashboard at once: the
	// model-change event makes the host re-resolve every group (a hidden group
	// then answers empty; an unhidden one serves again), and the refresh
	// re-renders the hidden-groups line.
	groupRemovals.onDidChange = () => {
		// Isolated like the status callback's consumers below: one consumer
		// throwing must not starve the other, and a throw escaping into the
		// store would make its callers report a mutation that DID apply as
		// failed.
		try {
			provider.notifyModelInformationChanged();
		} catch (error) {
			logger.error("Group-removal change notification failed", error);
		}
		try {
			dashboard.refresh();
		} catch (error) {
			logger.error("Dashboard refresh failed", error);
		}
	};
	// The store's persists are best-effort (the in-memory view is the truth
	// and the next mutation rewrites the whole blob); failures are log-only.
	groupRemovals.onPersistError = (error) => {
		logger.error("Persisting group-removal bookkeeping failed", error);
	};
	// Test-only commands; registered after the sync engine and the dashboard
	// exist because the docker-serversync suite reads the engine's declared
	// views through them and the monkey fuzzer injects dashboard messages.
	if (testEntrySeams !== undefined && sessionLogTee !== undefined) {
		registerTestCommands(
			context,
			registry,
			provider,
			issueReporter,
			syncEngine,
			dashboard,
			testEntrySeams,
			sessionLogTee
		);
	}
	// The docker-resolution suite's deterministic catalog seeding (inert in
	// production, like the commands above).
	registerOpenRouterCatalogTestSeam(context, catalogStore);
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
		showActionableMessage("info", vscode.l10n.t("Welcome to LiteLLM! Connect to 100+ LLMs in VS Code."), [
			reconfigureAction(configureNowLabel()),
			{
				label: vscode.l10n.t("Documentation"),
				run: () => void vscode.env.openExternal(vscode.Uri.parse(GITHUB_DOCS_URL)),
			},
		]).catch((error) => {
			logger.error("Welcome message failed", error);
		});
	}
	if (!hasShownWelcome) {
		await context.globalState.update(HAS_SHOWN_WELCOME_KEY, true);
	}

	// Server management command: the hub's server entry routes by the UI mode
	// (see getManagementUiMode above).
	registerManageCommand(context, registry, logger, getManagementUiMode);

	// Test connection command
	registerTestConnectionCommand(context, provider, statusBar, outputChannel, logger);

	// Sync Models Now command: a forced server sync first (reconciling groups
	// edited natively), then a discovery-cache-skipping refetch of every group.
	registerSyncModelsCommand(context, provider, statusBar, outputChannel, logger, () => syncEngine.syncNow(true));

	// Help & Feedback command
	registerHelpAndFeedbackCommand(context);

	// Groups-file deep link: notices about leftover provider groups open the
	// host's chatLanguageModels.json directly, the one place a group can be
	// deleted (no editor UI for it is sanctioned).
	registerOpenGroupsFileCommand(context, logger);

	// Settings.json deep link: the dashboard's per-setting jump (revealSetting).
	registerOpenSettingKeyCommand(context, logger);

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
