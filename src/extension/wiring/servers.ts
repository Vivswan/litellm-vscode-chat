import * as vscode from "vscode";
import type { BooleanSettingId, NumberSettingId } from "../../shared/config/settingSpec";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import {
	CURRENCY_SYMBOL_SETTING_KEY,
	MODEL_CAPABILITIES_SETTING_KEY,
	SERVERS_SETTING_KEY,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
} from "../../shared/config/settings";
import type { Logger } from "../../shared/logger";
import type { DebouncedAction } from "../../shared/util/debounce";
import type { FingerprintSaltSession } from "../fingerprintSalt";
import type { OpenRouterCatalogStore } from "../openRouterCatalog";
import type { GroupRemovalStore } from "../servers/groupRemovals";
import { createServerSyncEnv, registerSetServerSecretCommand, ServerSyncEngine } from "../servers/serverSync";
import { createUsagePollerEnv, registerRefreshUsageCommand, UsagePoller } from "../servers/usage";
import { createSettingsTransferEnv, registerSettingsTransferCommands } from "../ui/settingsTransferCommands";

const OPENROUTER_CATALOG_SETTING_ID = "models.openRouterCatalog" satisfies BooleanSettingId;

const USAGE_POLL_INTERVAL_SETTING_ID = "usage.pollInterval" satisfies NumberSettingId;

export interface ServersWiring {
	readonly syncEngine: ServerSyncEngine;
	readonly usagePoller: UsagePoller;
}

/**
 * The server-side engines and their reactions: the declarative server sync, the
 * headless usage poller, the configuration-change listener that fans a settings
 * edit out to both, and the palette commands operating on them. (The usage
 * status bar's own configuration reaction lives in wireUsageSurfaces.)
 */
export function wireServers(
	context: vscode.ExtensionContext,
	logger: Logger,
	userAgent: string,
	deps: {
		fingerprintSalt: FingerprintSaltSession;
		groupRemovals: GroupRemovalStore;
		catalogStore: OpenRouterCatalogStore;
		notifyModelsChanged: DebouncedAction;
	}
): ServersWiring {
	const { catalogStore, notifyModelsChanged } = deps;
	// Created before the dashboard, which edits the setting and reads the
	// engine's declared-server view.
	const syncEngine = new ServerSyncEngine(
		createServerSyncEnv(context, logger, deps.fingerprintSalt, deps.groupRemovals)
	);
	// The headless usage poller: per-server spend, budgets, and threshold
	// crossings, on its own cadence (usage.pollInterval; 0 = off) independent of
	// discovery.
	const usagePoller = new UsagePoller(createUsagePollerEnv(context, logger, userAgent));
	context.subscriptions.push(
		syncEngine,
		usagePoller,
		vscode.workspace.onDidChangeConfiguration((event) => {
			const affects = (id: string) => event.affectsConfiguration(`${CONFIG_SECTION}.${id}`);
			if (affects(SERVERS_SETTING_KEY)) {
				// The sync alone cannot re-attach models for an entry whose models
				// records, headers, discovery block, or budget changed: those fields
				// stay out of the group args and the sync fingerprint.
				syncEngine.requestSync();
				notifyModelsChanged.schedule();
				// Entry budgets and connections ride the same setting; the poller
				// prunes removed servers and re-probes availability.
				usagePoller.applyServersChange();
			}
			if (affects(USAGE_POLL_INTERVAL_SETTING_ID) || affects(USAGE_ALERT_THRESHOLDS_SETTING_KEY)) {
				usagePoller.applyConfiguration();
			}
			if (affects(MODEL_CAPABILITIES_SETTING_KEY)) {
				// Capability overrides are applied where models attach, outside the
				// discovery cache, so a notify suffices: no cache clear, no network.
				notifyModelsChanged.schedule();
			}
			if (affects(CURRENCY_SYMBOL_SETTING_KEY)) {
				// The picker's pricing labels rebuild where models attach: the verified
				// fast path re-derives a label that no longer matches the new symbol,
				// so a notify alone heals every served model.
				notifyModelsChanged.schedule();
			}
			if (affects(OPENROUTER_CATALOG_SETTING_ID)) {
				// Opting out cancels the pending refresh and opting back in
				// reschedules it; the registration effect - the implicit lookup
				// turning on or off - is the notify.
				catalogStore.applyEnabledSetting();
				notifyModelsChanged.schedule();
			}
		})
	);
	// A palette-stored secret can fix a key the proxy had rejected, so the
	// usage poller re-probes availability when one changes.
	registerSetServerSecretCommand(context, syncEngine, logger, () => usagePoller.applyServersChange());
	registerSettingsTransferCommands(context, createSettingsTransferEnv(context, syncEngine, logger));
	// Refresh Usage Now: the poller's explicit refresh, availability re-probed,
	// working whether or not polling is on.
	registerRefreshUsageCommand(context, () => usagePoller.refreshNow());
	usagePoller.start();
	return { syncEngine, usagePoller };
}
