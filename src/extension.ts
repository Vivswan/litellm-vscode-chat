import * as vscode from "vscode";
import { registerDashboardCommand } from "./extension/dashboard/panel";
import { consumeDevSeed, createDevSeedEnv } from "./extension/devSeed";
import { loadFingerprintSalt } from "./extension/fingerprintSalt";
import { configureSharedL10n } from "./extension/l10nConfig";
import type { MigrationContext } from "./extension/migrations";
import { runMigrations } from "./extension/migrations";
import { isGroupMigrationComplete } from "./extension/migrations/registryToProviderGroups";
import { createOpenRouterCatalogStore } from "./extension/openRouterCatalog";
import { GroupRemovalStore } from "./extension/servers/groupRemovals";
import {
	type ManagementUiMode,
	REGISTRY_SERVED_IN_MODE,
	registerManageCommand,
} from "./extension/servers/serverManagement";
import { ServerRegistry } from "./extension/servers/serverRegistry";
import {
	createServerSyncEnv,
	parseServersSetting,
	readEntryExpectedFailures,
	readEntryModelCapabilities,
	readEntryModelParameters,
	registerSetServerSecretCommand,
	ServerSyncEngine,
} from "./extension/servers/serverSync";
import {
	registerHelpAndFeedbackCommand,
	registerOpenGroupsFileCommand,
	registerReportIssueCommand,
	registerSyncModelsCommand,
	registerTestCommands,
	registerTestConnectionCommand,
	testEntryModelCapabilitiesOverride,
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
import { StatusBarManager } from "./extension/ui/status";
import type { DiscoveredGroupModels } from "./provider";
import { LiteLLMChatModelProvider } from "./provider";
import { DiscoveryCache } from "./provider/catalog/discoveryCache";
import { CMD, VENDOR_ID } from "./shared/config/commandIds";
import type { BooleanSettingId, NumberSettingId } from "./shared/config/settingSpec";
import { CONFIG_SECTION } from "./shared/config/settingSpec";
import {
	isOpenRouterCatalogEnabled,
	MODEL_CAPABILITIES_SETTING_KEY,
	SERVERS_SETTING_KEY,
} from "./shared/config/settings";
import { HAS_SHOWN_WELCOME_KEY } from "./shared/config/storageKeys";
import type { DevSeed } from "./shared/devSeed";
import { Logger } from "./shared/logger";
import type { AggregatedStatus } from "./shared/servers";
import { debounced } from "./shared/util/debounce";
import { GITHUB_DOCS_URL } from "./shared/util/links";

/**
 * The deprecated default* trio: their values are baked into cached discovery
 * results, so an edit must drop the discovery cache before models re-resolve
 * (see the configuration listener in activate).
 */
const TOKEN_DEFAULT_SETTING_IDS = [
	"defaultMaxOutputTokens",
	"defaultContextLength",
	"defaultMaxInputTokens",
] as const satisfies readonly NumberSettingId[];

const OPENROUTER_CATALOG_SETTING_ID = "openRouterCatalog.enabled" satisfies BooleanSettingId;

/** How long configuration-change bursts (settings.json keystrokes) coalesce before models re-resolve. */
const CONFIG_CHANGE_DEBOUNCE_MS = 400;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// Before anything renders a string: shared modules localize through
	// @vscode/l10n and need the host bundle (see extension/l10nConfig.ts).
	configureSharedL10n();

	const extVersion: string = context.extension.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	const ua = `litellm-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

	const outputChannel = vscode.window.createOutputChannel("LiteLLM", { log: true });
	context.subscriptions.push(outputChannel);

	const issueReporter = new IssueReporter(createIssueReporterEnv(context.globalStorageUri));
	const logger = new Logger(outputChannel, issueReporter);
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
	const testMode = context.extensionMode !== vscode.ExtensionMode.Production;
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
	// Groups the user explicitly removed (the host command is add-only, so
	// removal works by tombstoning): the provider consults the store on every
	// group refresh, and tombstone changes fire the model-change event below.
	const groupRemovals = new GroupRemovalStore(context.globalState);
	// Owned here rather than defaulted inside the provider so the
	// configuration listener below can drop it when the deprecated default*
	// token settings change (their values are baked into cached results).
	const discoveryCache = new DiscoveryCache<DiscoveredGroupModels>();
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
	const provider = new LiteLLMChatModelProvider({
		userAgent: ua,
		logger,
		getServers: () => registry.getServersWithKeys(),
		getEntryModelParameters: readEntryModelParameters,
		// The test seam answers first (inert in production; see commands.ts),
		// so the host-fidelity suite can exercise entry-level declarations on
		// the registry path without the servers-setting sync machinery.
		getEntryModelCapabilities: (label, baseUrl) =>
			testEntryModelCapabilitiesOverride(label) ?? readEntryModelCapabilities(label, baseUrl),
		getExpectedFailures: readEntryExpectedFailures,
		getCatalogLookup: () => catalogStore.lookup,
		grouplessRegistryEnabled: () => REGISTRY_SERVED_IN_MODE[getManagementUiMode()],
		isGroupSuppressed: (label, baseUrl) => groupRemovals.isTombstoned(label, baseUrl),
		discoveryCache,
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
	const statusBar = new StatusBarManager(context, logger, hasConfiguredServers);
	const notifier = new Notifier(hasConfiguredServers);
	// The declarative server sync: litellm-vscode-chat.servers entries become
	// provider groups. Created before the dashboard, which edits the setting
	// and reads the engine's declared-server view.
	const syncEngine = new ServerSyncEngine(createServerSyncEnv(context, logger, fingerprintSalt, groupRemovals));
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
		notifyModelsChanged,
		vscode.workspace.onDidChangeConfiguration((event) => {
			const affects = (id: string) => event.affectsConfiguration(`${CONFIG_SECTION}.${id}`);
			if (affects(SERVERS_SETTING_KEY)) {
				// The sync alone cannot re-attach models for an entry whose
				// modelCapabilities or expectedFailures changed: those fields stay
				// out of the group args and the sync fingerprint, so the debounced
				// notify is what makes the host re-resolve the groups.
				syncEngine.requestSync();
				notifyModelsChanged.schedule();
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
			if (TOKEN_DEFAULT_SETTING_IDS.some(affects)) {
				// The trio's values are baked into cached discovery results, so the
				// re-resolve must read through an empty cache. Cleared immediately
				// (idempotent; the epoch guard covers in-flight loads), notify
				// debounced with the rest.
				discoveryCache.clear();
				notifyModelsChanged.schedule();
			}
		})
	);
	registerSetServerSecretCommand(context, syncEngine, logger);
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
		catalogStore
	);
	syncEngine.onDidSync = () => dashboard.refresh();
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
	// The store's persists are best-effort (the session journal is the truth
	// and rewrites the whole view on the next mutation); failures are log-only.
	groupRemovals.onPersistError = (error) => {
		logger.error("Persisting group-removal bookkeeping failed", error);
	};
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
