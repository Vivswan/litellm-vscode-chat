import * as vscode from "vscode";
import { consumeDevSeed, createDevSeedEnv } from "./extension/devSeed";
import { configureSharedL10n } from "./extension/l10nConfig";
import { registerOpenRouterCatalogTestSeam } from "./extension/openRouterCatalogTestSeam";
import { registerTestCommands, SessionLogTee } from "./extension/ui/commands";
import { createIssueReporterEnv, IssueReporter } from "./extension/ui/issueReporter";
import { wireDashboard, wireGroupRemovalReactions, wireUsageSurfaces } from "./extension/wiring/dashboard";
import { wireCatalogRefresh, wireProvider, wireTokenCounting } from "./extension/wiring/provider";
import { wireServers } from "./extension/wiring/servers";
import { wireStorage } from "./extension/wiring/storage";
import { maybeShowWelcome, wireStatusFanout, wireStatusSurfaces, wireUiCommands } from "./extension/wiring/ui";
import { CMD, VENDOR_ID } from "./shared/config/commandIds";
import type { DevSeed } from "./shared/devSeed";
import { Logger } from "./shared/logger";

/**
 * The composition root: activate() only constructs and orders the wiring
 * modules under src/extension/wiring/; each module owns its subscriptions and
 * reactions. The ordering constraints activate() owns are commented at their
 * call sites: l10n configuration first, pre-registration migrations awaited
 * before registerLanguageModelChatProvider, post-registration migrations
 * fire-and-forget after it, test seams gated on non-production mode.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// The activation-production harness calls this compiled function itself with
	// a fake Production-mode context, while the real extension loaded into its
	// host must stay inert: onStartupFinished would otherwise activate it first
	// and every command registration would collide. The mode check keeps the
	// harness's own Production-mode call running.
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
	// Non-production only: litellm._test.getSessionLogs reads the session's log
	// lines losslessly through this tee (the production buffer behind it is a
	// small rolling window a leak scan could race).
	const sessionLogTee = testMode ? new SessionLogTee(issueReporter) : undefined;
	const logger = new Logger(outputChannel, sessionLogTee ?? issueReporter);
	logger.log(`LiteLLM Extension activated (v${extVersion})`);

	const storage = await wireStorage(context, logger);
	// Token estimation serves the request path from the first request: mode
	// applied now, tokenizer loads settle off the activation path.
	wireTokenCounting(context, logger);
	const { catalogStore, provider, notifyModelsChanged, hasDeclaredServers, hasConfiguredServers } = wireProvider(
		context,
		logger,
		ua,
		storage
	);

	// The provider must not see a half-migrated registry, so pre-registration
	// migrations complete before registration.
	await storage.runPreRegistrationMigrations();

	vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider);

	// One-shot seed dropped by `bun run dev`; development-mode only. The forced
	// server sync pass below turns the seeded entry into the provider group.
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
	});
	// After wireServers: both surfaces read the sync engine's declared views for
	// the sync-failure overlay.
	const { statusBar, notifier } = wireStatusSurfaces(context, logger, hasConfiguredServers, () =>
		servers.syncEngine.getDeclared()
	);
	const dashboard = wireDashboard(context, logger, {
		provider,
		syncEngine: servers.syncEngine,
		registry: storage.registry,
		groupRemovals: storage.groupRemovals,
		catalogStore,
		usagePoller: servers.usagePoller,
	});
	wireUsageSurfaces(context, logger, { usagePoller: servers.usagePoller, dashboard });
	wireCatalogRefresh(context, logger, { catalogStore, notifyModelsChanged, dashboard });
	wireGroupRemovalReactions(logger, { groupRemovals: storage.groupRemovals, provider, dashboard });

	// Test-only commands; registered after the sync engine and the dashboard
	// exist because the suites read the engine's declared views through them
	// and the monkey fuzzer injects dashboard messages.
	if (sessionLogTee !== undefined) {
		registerTestCommands(context, provider, issueReporter, servers.syncEngine, dashboard, sessionLogTee);
	}
	// The docker-resolution suite's deterministic catalog seeding (inert in
	// production).
	registerOpenRouterCatalogTestSeam(context, catalogStore);
	// Wired before the first sync pass so its completion re-judges the status
	// surfaces (the pass's sync failures reach the bar with no provider report).
	wireStatusFanout(context, logger, { provider, syncEngine: servers.syncEngine, statusBar, notifier, dashboard });
	// The first pass runs off the activation path: it may hit the host command
	// (which validates groups against the provider) and the network. Forced,
	// so groups edited or deleted natively since the last session reconcile.
	void servers.syncEngine.syncNow(true);

	// Hands registry servers to VS Code as provider groups. The host validates
	// each group by calling the registered provider, so this phase runs after
	// registration, and off the activation path because it hits the network.
	void storage.runPostRegistrationMigrations();

	if (devSeed?.openDashboard) {
		void vscode.commands.executeCommand(CMD.openDashboard).then(undefined, (error: unknown) => {
			logger.error("Dev seed dashboard open failed", error);
		});
	}

	await maybeShowWelcome(context, logger, { registry: storage.registry, hasDeclaredServers });

	wireUiCommands(context, logger, {
		registry: storage.registry,
		getManagementUiMode: storage.getManagementUiMode,
		provider,
		statusBar,
		outputChannel,
		syncEngine: servers.syncEngine,
		issueReporter,
		extVersion,
		vscodeVersion,
	});
}

export function deactivate() {}
