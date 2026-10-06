import * as vscode from "vscode";
import { consumeDevSeed, createDevSeedEnv } from "./extension/devSeed";
import { configureSharedL10n } from "./extension/l10nConfig";
import { registerOpenRouterCatalogTestSeam } from "./extension/openRouterCatalogTestSeam";
import { registerTestCommands, SessionLogTee } from "./extension/ui/commands";
import { createIssueReporterEnv, IssueReporter } from "./extension/ui/issueReporter";
import { wireDashboard, wireGroupRemovalReactions, wireUsageSurfaces } from "./extension/wiring/dashboard";
import { wireDashboardClientFeatures, wireFeatures } from "./extension/wiring/features";
import { onLogRedactionToggled, wireKnownSecrets } from "./extension/wiring/knownSecrets";
import { wireCatalogRefresh, wireProvider, wireTokenCounting } from "./extension/wiring/provider";
import { wireServers } from "./extension/wiring/servers";
import { wireStorage } from "./extension/wiring/storage";
import { maybeShowWelcome, wireStatusFanout, wireStatusSurfaces, wireUiCommands } from "./extension/wiring/ui";
import { CMD, VENDOR_ID } from "./shared/config/commandIds";
import { isLogRedactionEnabled } from "./shared/config/settings";
import type { DevSeed } from "./shared/devSeed";
import { Logger } from "./shared/logger";
import { fixedHeaderValue } from "./shared/util/headers";

/**
 * The ordering constraints activate() owns are commented at their call sites: l10n configuration first, the state
 * migrations awaited before registerLanguageModelChatProvider, test seams gated on non-production mode.
 *
 *   each module -> owns its subscriptions and reactions
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// The activation-production harness calls this compiled function itself with a fake Production-mode context, while
	// the real extension loaded into its host must stay inert: onStartupFinished would otherwise activate it first and
	// every command registration would collide. The mode check keeps the harness's own Production-mode call running.
	if (
		context.extensionMode !== vscode.ExtensionMode.Production &&
		process.env.LITELLM_SUPPRESS_STARTUP_ACTIVATION === "1"
	) {
		return;
	}

	// Before anything renders a string: shared modules localize through @vscode/l10n and need the host bundle (see
	// extension/l10nConfig.ts).
	configureSharedL10n();

	const extVersion: string = context.extension.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	const ua = fixedHeaderValue(`litellm-vscode-chat/${extVersion} VSCode/${vscodeVersion}`);

	const outputChannel = vscode.window.createOutputChannel("LiteLLM", { log: true });
	context.subscriptions.push(outputChannel);

	// The reporter reads the Logger's history and the Logger records errors into the reporter, so the reader binds
	// late: the history is read at report time, after both exist.
	let logger: Logger;
	const issueReporter = new IssueReporter(createIssueReporterEnv(context.globalStorageUri), () => logger.reportLines());
	const testMode = context.extensionMode !== vscode.ExtensionMode.Production;
	const sessionLogTee = testMode ? new SessionLogTee(issueReporter) : undefined;
	logger = new Logger(outputChannel, sessionLogTee ?? issueReporter, isLogRedactionEnabled);
	logger.log(`LiteLLM Extension activated (v${extVersion})`);
	// Awaited so no server work logs before the configured secret values are known.
	await wireKnownSecrets(context, logger, (values) => Logger.registerSecrets(values));
	onLogRedactionToggled(context, () => {
		outputChannel.clear();
		logger.replay();
	});

	const storage = await wireStorage(context, logger);
	// Token estimation serves the request path from the first request: mode applied now, tokenizer loads settle off the
	// activation path.
	wireTokenCounting(context, logger);
	const { catalogStore, provider, notifyModelsChanged, hasDeclaredServers, hasConfiguredServers } = wireProvider(
		context,
		logger,
		ua,
		storage
	);

	await storage.runMigrations();

	vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider);

	// The forced server sync pass below turns the seeded entry into the provider group.
	let devSeed: DevSeed | undefined;
	if (testMode) {
		try {
			devSeed = await consumeDevSeed(context.extensionUri, createDevSeedEnv(context.secrets), logger);
		} catch (error) {
			logger.error("Dev seed failed", error);
		}
	}

	const servers = wireServers(context, logger, ua, {
		fingerprintSalt: storage.fingerprintSalt,
		groupRemovals: storage.groupRemovals,
		catalogStore,
		notifyModelsChanged,
		observedGroupBaseUrls: (label) => provider.observedGroupBaseUrls(label),
		observedSnapshots: () => provider.getServerSnapshots(),
		onDidObserveGroup: provider.onDidObserveGroup,
	});
	// After wireServers: both surfaces classify the verdict owner's rows and read its declared set.
	const { statusBar, notifier } = wireStatusSurfaces(context, logger, hasConfiguredServers, servers.verdict);
	// Before the dashboard so its test probes reuse the features' exact send pipelines.
	const features = wireFeatures(context, logger, {
		ua,
		outputChannel,
		getSnapshots: () => provider.getServerSnapshots(),
	});
	const dashboard = wireDashboard(context, logger, {
		provider,
		syncEngine: servers.syncEngine,
		groupRemovals: storage.groupRemovals,
		catalogStore,
		usagePoller: servers.usagePoller,
		ua,
		featureProbes: features.featureProbes,
		verdict: servers.verdict,
	});
	// The agent tools are a client of the dashboard controller, so they wire after it; every write they make joins the
	// controller's serialized chain, and their diagnostics judge the owner's declared set like every other surface.
	wireDashboardClientFeatures(context, logger, {
		dashboard,
		getConnectionStatus: () => statusBar.connectionStatus,
		getDeclared: () => servers.verdict.declared().views,
		issueReporter,
		extVersion,
		vscodeVersion,
	});
	wireUsageSurfaces(context, logger, { usagePoller: servers.usagePoller, dashboard });
	wireCatalogRefresh(context, logger, { catalogStore, notifyModelsChanged, dashboard });
	wireGroupRemovalReactions(logger, { groupRemovals: storage.groupRemovals, provider, dashboard });

	// Test-only commands; registered after the sync engine and the dashboard exist because the suites read the engine's
	// declared views through them and the monkey fuzzer injects dashboard messages.
	if (sessionLogTee !== undefined) {
		registerTestCommands(context, provider, issueReporter, servers.syncEngine, dashboard, sessionLogTee);
	}
	// The docker-resolution suite's deterministic catalog seeding (inert in production).
	registerOpenRouterCatalogTestSeam(context, catalogStore);
	// Wired before the first sync pass so its completion re-judges the status surfaces (the pass's sync failures reach
	// the bar with no provider report).
	wireStatusFanout(context, logger, { provider, syncEngine: servers.syncEngine, statusBar, notifier, dashboard });
	// The first pass runs off the activation path: it may hit the host command (which validates groups against the
	// provider) and the network.
	void servers.syncEngine.syncNow(true);

	if (devSeed?.openDashboard) {
		void vscode.commands.executeCommand(CMD.openDashboard).then(undefined, (error: unknown) => {
			logger.error("Dev seed dashboard open failed", error);
		});
	}

	await maybeShowWelcome(context, logger, { hasDeclaredServers });

	wireUiCommands(context, logger, {
		provider,
		statusBar,
		outputChannel,
		syncEngine: servers.syncEngine,
		getDeclared: () => servers.verdict.declared().views,
		issueReporter,
		extVersion,
		vscodeVersion,
		hasConfiguredServers,
	});
}

export function deactivate() {}
