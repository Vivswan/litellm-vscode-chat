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
import { fixedHeaderValue, type HeaderValue } from "./shared/util/headers";

/** The versions activation stamps and the one User-Agent every request carries. */
interface ActivationIdentity {
	readonly extVersion: string;
	readonly vscodeVersion: string;
	readonly ua: HeaderValue;
}

/** The extension's version off `context` ("unknown" when packageJSON has none), the host's own, and the User-Agent built from both. */
function activationIdentity(context: vscode.ExtensionContext): ActivationIdentity {
	const extVersion: string = context.extension.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	return {
		extVersion,
		vscodeVersion,
		ua: fixedHeaderValue(`litellm-vscode-chat/${extVersion} VSCode/${vscodeVersion}`),
	};
}

/** The output channel, the logger, its issue-report recorder, and the lossless tee the suites read in non-production mode. */
interface ActivationLogging {
	readonly outputChannel: vscode.OutputChannel;
	readonly logger: Logger;
	readonly issueReporter: IssueReporter;
	readonly sessionLogTee: SessionLogTee | undefined;
}

/**
 * The reporter reads the Logger's history and the Logger records errors into the reporter, so the reader binds late:
 * the history is read at report time, after both exist.
 */
function createActivationLogging(context: vscode.ExtensionContext, extVersion: string): ActivationLogging {
	const outputChannel = vscode.window.createOutputChannel("LiteLLM", { log: true });
	context.subscriptions.push(outputChannel);
	let logger: Logger;
	const issueReporter = new IssueReporter(createIssueReporterEnv(context.globalStorageUri), () => logger.reportLines());
	const testMode = context.extensionMode !== vscode.ExtensionMode.Production;
	const sessionLogTee = testMode ? new SessionLogTee(issueReporter) : undefined;
	logger = new Logger(outputChannel, sessionLogTee ?? issueReporter, isLogRedactionEnabled);
	logger.log(`LiteLLM Extension activated (v${extVersion})`);
	return { outputChannel, logger, issueReporter, sessionLogTee };
}

/** What the provider wiring hands the surfaces: the stores, the provider, and the gates every surface reads. */
interface ActivationCore {
	readonly storage: Awaited<ReturnType<typeof wireStorage>>;
	readonly provider: ReturnType<typeof wireProvider>;
}

/** The surfaces wired over the provider, in the order their dependencies demand. */
interface WiredSurfaces {
	readonly servers: ReturnType<typeof wireServers>;
	readonly status: ReturnType<typeof wireStatusSurfaces>;
	readonly dashboard: ReturnType<typeof wireDashboard>;
	readonly devSeed: DevSeed | undefined;
}

/**
 * The server sync, the status surfaces, the features, and the dashboard, each wired after what it reads. Returns
 * the surfaces the activation tail hands to the fan-out and the palette commands.
 */
async function wireSurfaces(
	context: vscode.ExtensionContext,
	logging: ActivationLogging,
	identity: ActivationIdentity,
	core: ActivationCore
): Promise<WiredSurfaces> {
	const { logger, outputChannel, issueReporter } = logging;
	const { storage } = core;
	const { catalogStore, provider, notifyModelsChanged, hasConfiguredServers } = core.provider;
	// The forced server sync pass later turns the seeded entry into the provider group.
	let devSeed: DevSeed | undefined;
	if (logging.sessionLogTee !== undefined) {
		try {
			devSeed = await consumeDevSeed(context.extensionUri, createDevSeedEnv(context.secrets), logger);
		} catch (error) {
			logger.error("Dev seed failed", error);
		}
	}

	const servers = wireServers(context, logger, identity.ua, {
		fingerprintSalt: storage.fingerprintSalt,
		groupRemovals: storage.groupRemovals,
		catalogStore,
		notifyModelsChanged,
		observedGroupBaseUrls: (label) => provider.observedGroupBaseUrls(label),
		observedSnapshots: () => provider.getServerSnapshots(),
		onDidObserveGroup: provider.onDidObserveGroup,
	});
	// After wireServers: both surfaces classify the verdict owner's rows and read its declared set.
	const status = wireStatusSurfaces(context, logger, hasConfiguredServers, servers.verdict);
	// Before the dashboard so its test probes reuse the features' exact send pipelines.
	const features = wireFeatures(context, logger, {
		ua: identity.ua,
		outputChannel,
		getSnapshots: () => provider.getServerSnapshots(),
	});
	const dashboard = wireDashboard(context, logger, {
		provider,
		syncEngine: servers.syncEngine,
		groupRemovals: storage.groupRemovals,
		catalogStore,
		usagePoller: servers.usagePoller,
		ua: identity.ua,
		featureProbes: features.featureProbes,
		verdict: servers.verdict,
	});
	// The agent tools are a client of the dashboard controller, so they wire after it; every write they make joins the
	// controller's serialized chain, and their diagnostics judge the owner's declared set like every other surface.
	wireDashboardClientFeatures(context, logger, {
		dashboard,
		getConnectionStatus: () => status.statusBar.connectionStatus,
		getDeclared: () => servers.verdict.declared().views,
		issueReporter,
		extVersion: identity.extVersion,
		vscodeVersion: identity.vscodeVersion,
	});
	wireUsageSurfaces(context, logger, { usagePoller: servers.usagePoller, dashboard });
	wireCatalogRefresh(context, logger, { catalogStore, notifyModelsChanged, dashboard });
	wireGroupRemovalReactions(logger, { groupRemovals: storage.groupRemovals, notifyModelsChanged, dashboard });

	return { servers, status, dashboard, devSeed };
}

/** The suites' seams: the test-only commands in non-production mode, and the catalog seeding seam, inert in production. */
function registerTestSeams(
	context: vscode.ExtensionContext,
	logging: ActivationLogging,
	core: ActivationCore,
	wired: WiredSurfaces
): void {
	const { issueReporter, sessionLogTee } = logging;
	// Test-only commands; registered after the sync engine and the dashboard exist because the suites read the engine's
	// declared views through them and the monkey fuzzer injects dashboard messages.
	if (sessionLogTee !== undefined) {
		registerTestCommands(
			context,
			core.provider.provider,
			issueReporter,
			wired.servers.syncEngine,
			wired.dashboard,
			sessionLogTee
		);
	}
	// The docker-resolution suite's deterministic catalog seeding (inert in production).
	registerOpenRouterCatalogTestSeam(context, core.provider.catalogStore);
}

function openSeededDashboard(devSeed: DevSeed | undefined, logger: Logger): void {
	if (!devSeed?.openDashboard) {
		return;
	}
	void vscode.commands.executeCommand(CMD.openDashboard).then(undefined, (error: unknown) => {
		logger.error("Dev seed dashboard open failed", error);
	});
}

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

	const identity = activationIdentity(context);
	const logging = createActivationLogging(context, identity.extVersion);
	const { logger, outputChannel } = logging;
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
	const core: ActivationCore = { storage, provider: wireProvider(context, logger, identity.ua, storage) };
	const { provider, hasDeclaredServers, hasConfiguredServers } = core.provider;

	await storage.runMigrations();

	vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider);

	const wired = await wireSurfaces(context, logging, identity, core);
	const { servers, dashboard } = wired;
	const { statusBar, notifier } = wired.status;
	registerTestSeams(context, logging, core, wired);
	// Wired before the first sync pass so its completion re-judges the status surfaces (the pass's sync failures reach
	// the bar with no provider report).
	wireStatusFanout(context, logger, { provider, syncEngine: servers.syncEngine, statusBar, notifier, dashboard });
	// The first pass runs off the activation path: it may hit the host command (which validates groups against the
	// provider) and the network.
	void servers.syncEngine.syncNow(true);
	openSeededDashboard(wired.devSeed, logger);
	await maybeShowWelcome(context, logger, { hasDeclaredServers });
	wireUiCommands(context, logger, {
		provider,
		statusBar,
		outputChannel,
		syncEngine: servers.syncEngine,
		getDeclared: () => servers.verdict.declared().views,
		issueReporter: logging.issueReporter,
		extVersion: identity.extVersion,
		vscodeVersion: identity.vscodeVersion,
		hasConfiguredServers,
	});
}

export function deactivate() {}
