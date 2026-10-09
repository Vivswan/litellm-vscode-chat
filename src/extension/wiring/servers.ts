import * as vscode from "vscode";
import type { ServerModelsSnapshot } from "../../provider/catalog/statusWindow";
import type { BooleanSettingId, NumberSettingId } from "../../shared/config/settingSpec";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import {
	CURRENCY_SYMBOL_SETTING_KEY,
	MODEL_CAPABILITIES_SETTING_KEY,
	SERVERS_SETTING_KEY,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
} from "../../shared/config/settings";
import { isServerSecretsKey } from "../../shared/config/storageKeys";
import type { Logger } from "../../shared/logger";
import type { DebouncedAction } from "../../shared/util/debounce";
import type { HeaderValue } from "../../shared/util/headers";
import { resolveDeclaredServers } from "../dashboard/declaredServers";
import type { FingerprintSaltSession } from "../fingerprintSalt";
import type { OpenRouterCatalogStore } from "../openRouterCatalog";
import type { GroupRemovalStore } from "../servers/groupRemovals";
import {
	createServerSyncEnv,
	registerSetServerSecretCommand,
	ServerSyncEngine,
	serverSettingReports,
} from "../servers/serverSync";
import { ServerVerdict } from "../servers/syncFailureOverlay";
import { UsagePoller } from "../servers/usage/poller";
import { createUsagePollerEnv, registerRefreshUsageCommand } from "../servers/usage/vscodeEnv";
import { createSettingsTransferEnv, registerSettingsTransferCommands } from "../ui/settingsTransferCommands";

const OPENROUTER_CATALOG_SETTING_ID = "models.openRouterCatalog" satisfies BooleanSettingId;

const USAGE_POLL_INTERVAL_SETTING_ID = "usage.pollInterval" satisfies NumberSettingId;

export interface ServersWiring {
	readonly syncEngine: ServerSyncEngine;
	readonly usagePoller: UsagePoller;
	/** The one owner of the declared set and the verdict rows (status bar, notifier, dashboard, issue report). */
	readonly verdict: ServerVerdict;
}

/** (The usage status bar's own configuration reaction lives in wireUsageSurfaces.) */
export function wireServers(
	context: vscode.ExtensionContext,
	logger: Logger,
	userAgent: HeaderValue,
	deps: {
		fingerprintSalt: FingerprintSaltSession;
		groupRemovals: GroupRemovalStore;
		catalogStore: OpenRouterCatalogStore;
		notifyModelsChanged: DebouncedAction;
		/** The engine's live ownership evidence: which base URLs the host is serving each labeled group at. */
		observedGroupBaseUrls: (label: string) => readonly string[];
		/** The groups the host serves now; see ServerSyncEnv.observedSnapshots. */
		observedSnapshots: () => readonly ServerModelsSnapshot[];
		/** Fires when a group enters the provider's status window; a pass re-runs so the evidence is used. */
		onDidObserveGroup: vscode.Event<void>;
	}
): ServersWiring {
	const { catalogStore, notifyModelsChanged } = deps;
	// Created before the dashboard, which edits the setting and reads the engine's declared-server view.
	const syncEngine = new ServerSyncEngine(
		createServerSyncEnv(
			context,
			logger,
			deps.fingerprintSalt,
			deps.groupRemovals,
			deps.observedGroupBaseUrls,
			deps.observedSnapshots
		)
	);
	const usagePoller = new UsagePoller(createUsagePollerEnv(context, logger, userAgent));
	// One state for every headline surface: the provider's window, the engine's views (the setting before the first
	// pass), and the setting's entry reports.
	const readServersSetting = () => vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(SERVERS_SETTING_KEY);
	const verdict = new ServerVerdict({
		statuses: () => deps.observedSnapshots().map((snapshot) => snapshot.status),
		declared: () => resolveDeclaredServers(syncEngine.getDeclared(), readServersSetting()),
		entryReports: () => serverSettingReports(readServersSetting()),
	});
	context.subscriptions.push(
		syncEngine,
		usagePoller,
		// Identity evidence arriving after a pass (cold start: the activation pass runs before the host reports any
		// group) must still reach the engine, or a blocked entry's identity and an untracked removal's tombstone would
		// wait for an unrelated settings edit.
		deps.onDidObserveGroup(() => syncEngine.requestSync()),
		//   keyed on the blob keys themselves -> no writer can be missed (dashboard, palette, settings import, the test
		//       command, and OTHER WINDOWS all land here)
		//   a fixed key can lift a 401/403 -> the usage poller re-probes availability
		//   the sync pass alone never re-attaches models for a credential-only change -> the host re-resolves groups
		//   in-sync entries make no host call, so this never risks an upsert -> a sync pass refreshes the declared
		//       views' secret locations and expected identities
		context.secrets.onDidChange((event) => {
			if (isServerSecretsKey(event.key)) {
				usagePoller.applyServersChange();
				notifyModelsChanged.schedule();
				syncEngine.requestSync();
			}
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			const affects = (id: string) => event.affectsConfiguration(`${CONFIG_SECTION}.${id}`);
			if (affects(SERVERS_SETTING_KEY)) {
				// The sync alone cannot re-attach models for an entry whose models records, headers, discovery block,
				// or budget changed: those fields stay out of the group args and the sync fingerprint.
				syncEngine.requestSync();
				notifyModelsChanged.schedule();
				// Entry budgets and connections ride the same setting; the poller prunes removed servers and re-probes
				// availability.
				usagePoller.applyServersChange();
			}
			if (affects(USAGE_POLL_INTERVAL_SETTING_ID) || affects(USAGE_ALERT_THRESHOLDS_SETTING_KEY)) {
				usagePoller.applyConfiguration();
			}
			if (affects(MODEL_CAPABILITIES_SETTING_KEY)) {
				//   Capability overrides are applied where models attach, outside the discovery cache
				//     -> a notify suffices
				notifyModelsChanged.schedule();
			}
			if (affects(CURRENCY_SYMBOL_SETTING_KEY)) {
				// The picker's pricing labels rebuild where models attach: the verified fast path re-derives a label
				// that no longer matches the new symbol, so a notify alone heals every served model.
				notifyModelsChanged.schedule();
			}
			if (affects(OPENROUTER_CATALOG_SETTING_ID)) {
				// Opting out cancels the pending refresh and opting back in reschedules it; the registration effect -
				// the implicit lookup turning on or off - is the notify.
				catalogStore.applyEnabledSetting();
				notifyModelsChanged.schedule();
			}
		})
	);
	registerSetServerSecretCommand(context, syncEngine, logger);
	registerSettingsTransferCommands(context, createSettingsTransferEnv(context, syncEngine, logger));
	// Refresh Usage Now: the poller's explicit refresh, availability re-probed, working whether or not polling is on.
	registerRefreshUsageCommand(context, () => usagePoller.refreshNow());
	usagePoller.start();
	return { syncEngine, usagePoller, verdict };
}
