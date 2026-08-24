import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "../../provider";
import { CMD } from "../../shared/config/commandIds";
import { CONFIG_SECTION, TOKEN_ESTIMATION_SETTING_KEY } from "../../shared/config/settingSpec";
import { getTokenEstimationMode, isOpenRouterCatalogEnabled, SERVERS_SETTING_KEY } from "../../shared/config/settings";
import type { Logger } from "../../shared/logger";
import type { DebouncedAction } from "../../shared/util/debounce";
import { debounced } from "../../shared/util/debounce";
import type { DashboardController } from "../dashboard/panel";
import type { OpenRouterCatalogStore } from "../openRouterCatalog";
import { createOpenRouterCatalogStore } from "../openRouterCatalog";
import type { GroupRemovalStore } from "../servers/groupRemovals";
import {
	parseServersSetting,
	readEntryApiVersion,
	readEntryDeclaredModels,
	readEntryExpectedFailures,
	readEntryHeaders,
	readEntryModelCapabilities,
	readEntryModelParameters,
} from "../servers/serverSync";
import { createTokenCountingController } from "../tokenCounting";

/** How long configuration-change bursts (settings.json keystrokes) coalesce before models re-resolve. */
const CONFIG_CHANGE_DEBOUNCE_MS = 400;

export interface ProviderWiring {
	readonly catalogStore: OpenRouterCatalogStore;
	readonly provider: LiteLLMChatModelProvider;
	/**
	 * One debounced notify shared by every configuration-change branch, so a
	 * multi-setting edit re-resolves models once. A throw must not escape into
	 * the timer.
	 */
	readonly notifyModelsChanged: DebouncedAction;
	readonly hasDeclaredServers: () => boolean;
	readonly hasConfiguredServers: () => boolean;
}

/**
 * The provider's wiring: the OpenRouter catalog store, the provider itself
 * with its extension-injected seams, the shared debounced model-change notify,
 * and the configured-servers gates the status surfaces consult. activate()
 * registers the returned provider with the host AFTER awaiting the state
 * migrations.
 */
export function wireProvider(
	context: vscode.ExtensionContext,
	logger: Logger,
	userAgent: string,
	deps: {
		groupRemovals: GroupRemovalStore;
	}
): ProviderWiring {
	// Created before the provider because the provider's catalog seam reads its
	// lookup; the snapshot loads later, and lookups answer not-found until it
	// lands.
	const catalogStore = createOpenRouterCatalogStore({
		extensionUri: context.extensionUri,
		globalStorageUri: context.globalStorageUri,
		globalState: context.globalState,
		logger,
		isEnabled: isOpenRouterCatalogEnabled,
	});
	context.subscriptions.push(catalogStore);
	// The palette twin of the dashboard row's Refresh button; outcomes report in
	// the row status, never as a toast.
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.refreshOpenRouterCatalog, () => catalogStore.refreshNow())
	);
	const provider = new LiteLLMChatModelProvider({
		userAgent,
		logger,
		getEntryModelParameters: readEntryModelParameters,
		getEntryModelCapabilities: readEntryModelCapabilities,
		getEntryHeaders: readEntryHeaders,
		getEntryApiVersion: readEntryApiVersion,
		getEntryDeclaredModels: readEntryDeclaredModels,
		getExpectedFailures: readEntryExpectedFailures,
		getCatalogLookup: () => catalogStore.lookup,
		isGroupSuppressed: (label, baseUrl) => deps.groupRemovals.isTombstoned(label, baseUrl),
	});

	const notifyModelsChanged = debounced(() => {
		try {
			provider.notifyModelInformationChanged();
		} catch (error) {
			logger.error("Configuration-change model notification failed", error);
		}
	}, CONFIG_CHANGE_DEBOUNCE_MS);
	context.subscriptions.push(notifyModelsChanged);

	// The setting itself is the truth here, not the sync engine's view: the
	// welcome toast can run before the first sync pass finishes.
	const hasDeclaredServers = () =>
		parseServersSetting(vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY)).entries.length > 0;
	// The shared not-configured gate: declared servers-setting entries and live
	// provider groups both mean "configured" before anything toasts.
	// hasSeenGroupConfiguration is the cold-start-honest signal: the host's
	// groupless refresh reports an empty window before it re-resolves each
	// group, so the live snapshot count alone would wrongly read as empty.
	const hasConfiguredServers = () =>
		provider.getServerSnapshots().length > 0 || provider.hasSeenGroupConfiguration() || hasDeclaredServers();

	return { catalogStore, provider, notifyModelsChanged, hasDeclaredServers, hasConfiguredServers };
}

/**
 * Applies chat.tokenEstimation to the shared text-token counter at activation
 * and on configuration change. The controller owns the load policy; this only
 * feeds it the setting, so the mode is read once per change, never per count.
 */
export function wireTokenCounting(context: vscode.ExtensionContext, logger: Logger): void {
	const controller = createTokenCountingController({
		log: (message, data) => logger.log(message, data),
		logError: (message, error) => logger.error(message, error),
		uiLanguage: vscode.env.language,
	});
	controller.applyMode(getTokenEstimationMode());
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(`${CONFIG_SECTION}.${TOKEN_ESTIMATION_SETTING_KEY}`)) {
				controller.applyMode(getTokenEstimationMode());
			}
		})
	);
}

/** The catalog snapshot's freshness wiring, called once the dashboard exists (its inspector re-renders on updates). */
export function wireCatalogRefresh(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: {
		catalogStore: OpenRouterCatalogStore;
		notifyModelsChanged: DebouncedAction;
		dashboard: Pick<DashboardController, "refresh">;
	}
): void {
	const { catalogStore, notifyModelsChanged, dashboard } = deps;
	// A refreshed snapshot must become visible without waiting for an unrelated
	// refresh: the notify re-attaches models (catalog levels re-resolve at
	// attach) and the re-push re-renders the inspector's catalog rows.
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
	// Load the cached or bundled snapshot off the activation path (never throws),
	// then notify only when something was installed: a dev build without the
	// artifact must not fire a spurious re-resolve.
	void catalogStore.initialize().then(() => {
		if (catalogStore.snapshot().models.length > 0) {
			notifyModelsChanged.schedule();
		}
	});
}
