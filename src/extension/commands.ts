import * as vscode from "vscode";
import type { IssueReporter } from "../issueReporter";
import { CMD, MANAGE_COMMAND_TITLE } from "../shared/commandIds";
import { GITHUB_DOCS_URL, GITHUB_REPO_URL } from "../shared/links";
import type { Logger } from "../shared/logger";
import { openUrl } from "../shared/openUrl";
import type { SecretFieldId } from "../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../shared/serverEntry";
import type { ServerConfig } from "../shared/servers";
import { isErrorServerStatus } from "../shared/servers";
import { buildDiagnosticsSnapshot } from "./diagnostics";
import {
	CONFIGURE_NOW_LABEL,
	openChatAction,
	reconfigureAction,
	reportIssueAction,
	showActionableMessage,
	viewOutputAction,
} from "./notifier";
import type { ServerRegistry } from "./serverRegistry";
import type { ServerSyncEngine } from "./serverSync";
import { updateServerSecret } from "./serverSync";
import type { ConnectionStatus } from "./status";

const GITHUB_NEW_ISSUE_FEATURE = `${GITHUB_REPO_URL}/issues/new?labels=enhancement&title=%5BFeature%5D+`;

interface ModelInfoProvider {
	provideLanguageModelChatInformation(
		options: { silent: boolean },
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]>;
}

/**
 * The provider slice the explicit-refresh commands consume. refreshViaHost
 * drops the provider's discovery cache before asking the host to re-resolve,
 * so every group is fetched over the network.
 */
interface HostRefreshableProvider {
	refreshViaHost(): Promise<void>;
}

interface ConnectionTestableProvider extends ModelInfoProvider, HostRefreshableProvider {}

interface StatusBarLike {
	readonly connectionStatus: ConnectionStatus;
	updateStatusBar(status?: ConnectionStatus): Promise<void>;
}

// A second invocation while one test is mid-flight would capture "loading" as
// the pre-test status and misreport; it is refused instead.
let connectionTestRunning = false;
let modelSyncRunning = false;

/**
 * Trigger a non-silent refresh, ask the host to re-resolve every provider
 * group, and report from the connection status all of that left behind. The
 * status, not any returned model list, is the source of truth: the direct
 * refresh covers the registry era, the host round trip covers groups.
 */
export async function runConnectionTest(
	provider: ConnectionTestableProvider,
	statusBar: StatusBarLike,
	outputChannel: vscode.OutputChannel,
	logger: Logger
): Promise<void> {
	if (connectionTestRunning) {
		logger.log("A connection test is already running");
		return;
	}
	connectionTestRunning = true;
	try {
		logger.log("Testing connection to all servers...");
		outputChannel.show(true);

		const previous = statusBar.connectionStatus;
		try {
			await statusBar.updateStatusBar({ state: "loading" });
			await provider.provideLanguageModelChatInformation({ silent: false }, new vscode.CancellationTokenSource().token);
		} catch (error) {
			// The failing refresh already reported an error status; the toast below reads it.
			logger.error("Connection test failed", error);
		}
		try {
			await provider.refreshViaHost();
		} catch (error) {
			logger.error("Provider-group connection test failed", error);
		}

		let status = statusBar.connectionStatus;
		if (status.state === "loading") {
			await statusBar.updateStatusBar(previous);
			status = previous;
		}

		switch (status.state) {
			case "connected": {
				const count = status.totalModels;
				logger.log(`SUCCESS: ${count} models available`);
				void showActionableMessage(
					"info",
					`LiteLLM: Connection successful! Found ${count} model${count === 1 ? "" : "s"}.`,
					[viewOutputAction(outputChannel, "View Models"), openChatAction()]
				);
				break;
			}
			case "degraded": {
				const failed = status.serverStatuses.filter(isErrorServerStatus).length;
				logger.log(`WARNING: ${failed} server(s) unreachable`);
				void showActionableMessage(
					"warning",
					`LiteLLM: Connected with issues - ${status.totalModels} model${status.totalModels === 1 ? "" : "s"} available, ${failed} server${failed === 1 ? "" : "s"} unreachable.`,
					[viewOutputAction(outputChannel), reconfigureAction(), reportIssueAction()]
				);
				break;
			}
			case "error":
				void showActionableMessage("error", `LiteLLM: Connection failed - ${status.error}`, [
					viewOutputAction(outputChannel),
					reconfigureAction(),
					reportIssueAction(),
				]);
				break;
			case "not-configured":
				void showActionableMessage(
					"error",
					`LiteLLM: No servers configured. Please run '${MANAGE_COMMAND_TITLE}' first.`,
					[reconfigureAction(CONFIGURE_NOW_LABEL)]
				);
				break;
			default:
				void showActionableMessage("warning", "LiteLLM: Connection status is unavailable; try again in a moment.", [
					viewOutputAction(outputChannel),
				]);
		}
	} finally {
		connectionTestRunning = false;
	}
}

export function registerTestConnectionCommand(
	context: vscode.ExtensionContext,
	provider: ConnectionTestableProvider,
	statusBar: StatusBarLike,
	outputChannel: vscode.OutputChannel,
	logger: Logger
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.testConnection, () =>
			runConnectionTest(provider, statusBar, outputChannel, logger)
		)
	);
}

/**
 * Force-refresh every model list: discovery results are normally cached (see
 * the discoveryCacheTtl setting), and this is the user's way to skip the
 * cache after changing models on a LiteLLM server. The outcome is read from
 * the connection status the refresh left behind, like the connection test.
 */
export async function runModelSync(
	provider: HostRefreshableProvider,
	statusBar: StatusBarLike,
	outputChannel: vscode.OutputChannel,
	logger: Logger
): Promise<void> {
	// A second invocation mid-run would clear the provider's discovery cache
	// under the refresh already in flight and report a half-settled status; it
	// is refused instead.
	if (modelSyncRunning) {
		logger.log("A model sync is already running");
		return;
	}
	modelSyncRunning = true;
	try {
		logger.log("Syncing models: refreshing every provider group over the network");
		try {
			await provider.refreshViaHost();
		} catch (error) {
			// The failing refresh already reported an error status; the toast below reads it.
			logger.error("Model sync failed", error);
		}

		const status = statusBar.connectionStatus;
		switch (status.state) {
			case "connected": {
				const count = status.totalModels;
				logger.log(`Model sync finished: ${count} models available`);
				void showActionableMessage("info", `LiteLLM: Models synced - found ${count} model${count === 1 ? "" : "s"}.`, [
					viewOutputAction(outputChannel, "View Models"),
					openChatAction(),
				]);
				break;
			}
			case "degraded": {
				const failed = status.serverStatuses.filter(isErrorServerStatus).length;
				logger.log(`Model sync finished with issues: ${failed} server(s) unreachable`);
				void showActionableMessage(
					"warning",
					`LiteLLM: Models synced with issues - ${status.totalModels} model${status.totalModels === 1 ? "" : "s"} available, ${failed} server${failed === 1 ? "" : "s"} unreachable.`,
					[viewOutputAction(outputChannel), reconfigureAction(), reportIssueAction()]
				);
				break;
			}
			case "error":
				logger.log(`Model sync failed: ${status.error}`);
				void showActionableMessage("error", `LiteLLM: Model sync failed - ${status.error}`, [
					viewOutputAction(outputChannel),
					reconfigureAction(),
					reportIssueAction(),
				]);
				break;
			case "not-configured":
				logger.log("Model sync found no configured servers");
				void showActionableMessage(
					"error",
					`LiteLLM: No servers configured. Please run '${MANAGE_COMMAND_TITLE}' first.`,
					[reconfigureAction(CONFIGURE_NOW_LABEL)]
				);
				break;
			default:
				logger.log("Model sync finished without a settled connection status");
				void showActionableMessage("warning", "LiteLLM: Connection status is unavailable; try again in a moment.", [
					viewOutputAction(outputChannel),
				]);
		}
	} finally {
		modelSyncRunning = false;
	}
}

export function registerSyncModelsCommand(
	context: vscode.ExtensionContext,
	provider: HostRefreshableProvider,
	statusBar: StatusBarLike,
	outputChannel: vscode.OutputChannel,
	logger: Logger,
	/** Runs before the model refresh; the server sync engine reconciles provider groups here. */
	beforeSync?: () => Promise<void>
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.syncModels, async () => {
			await beforeSync?.();
			return runModelSync(provider, statusBar, outputChannel, logger);
		})
	);
}

export function registerReportIssueCommand(
	context: vscode.ExtensionContext,
	registry: ServerRegistry,
	getConnectionStatus: () => ConnectionStatus,
	extVersion: string,
	vscodeVersion: string,
	issueReporter: IssueReporter
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.reportIssue, async () => {
			const snapshot = await buildDiagnosticsSnapshot(
				registry,
				getConnectionStatus(),
				extVersion,
				vscodeVersion,
				issueReporter
			);
			await issueReporter.openIssue(snapshot);
		})
	);
}

export function registerHelpAndFeedbackCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.helpAndFeedback, async () => {
			// Each entry carries its own action, so a new entry cannot be added
			// without saying what it does.
			const choice = await vscode.window.showQuickPick(
				[
					{ label: "$(bug) Report Bug", run: () => vscode.commands.executeCommand(CMD.reportIssue) },
					{ label: "$(lightbulb) Request Feature", run: () => openUrl(GITHUB_NEW_ISSUE_FEATURE) },
					{ label: "$(book) Documentation", run: () => openUrl(GITHUB_DOCS_URL) },
				],
				{ title: "LiteLLM: Help & Feedback", placeHolder: "What would you like to do?" }
			);
			await choice?.run();
		})
	);
}

export function registerTestCommands(
	context: vscode.ExtensionContext,
	registry: ServerRegistry,
	provider: ModelInfoProvider,
	issueReporter: Pick<IssueReporter, "getRecentLogs">,
	syncEngine: Pick<ServerSyncEngine, "getDeclared">
): void {
	if (context.extensionMode === vscode.ExtensionMode.Production) {
		return;
	}

	const refreshModelIds = async (): Promise<string[]> => {
		return (await refreshModelInfos()).map((info) => info.id);
	};

	const refreshModelInfos = async (): Promise<vscode.LanguageModelChatInformation[]> => {
		return provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);
	};

	// Mutations run serialized so a straggler's refresh can never overwrite the
	// provider state a newer mutation just established. The generation counter
	// marks a superseded mutation's result as null so its caller (typically a
	// timed-out test) knows its view is stale.
	let generation = 0;
	let queue: Promise<unknown> = Promise.resolve();
	const mutateAndRefresh = (mutate: () => Promise<void>): Promise<string[] | null> => {
		const gen = ++generation;
		const run = async () => {
			await mutate();
			const modelIds = await refreshModelIds();
			return gen === generation ? modelIds : null;
		};
		const result = queue.then(run, run);
		queue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm._test.refreshModels", async () => {
			return (await refreshModelIds()).length;
		}),
		vscode.commands.registerCommand("litellm._test.refreshModelIds", refreshModelIds),
		// The full prepared infos, for suites asserting registration metadata
		// (e.g. configurationSchema) that vscode.lm.selectChatModels never
		// exposes. In-process command dispatch returns the objects as-is.
		vscode.commands.registerCommand("litellm._test.refreshModelInfos", refreshModelInfos),
		vscode.commands.registerCommand(
			"litellm._test.addServer",
			async (label: string, baseUrl: string, apiKey: string) => {
				let server: ServerConfig | undefined;
				const modelIds = await mutateAndRefresh(async () => {
					server = await registry.addServer(label, baseUrl, apiKey || "");
				});
				return { server, modelIds };
			}
		),
		vscode.commands.registerCommand("litellm._test.removeServer", async (serverId: string) => {
			return mutateAndRefresh(() => registry.removeServer(serverId));
		}),
		vscode.commands.registerCommand("litellm._test.clearServers", async () => {
			return mutateAndRefresh(async () => {
				for (const s of registry.getServers()) {
					await registry.removeServer(s.id);
				}
			});
		}),
		vscode.commands.registerCommand("litellm._test.getServers", () => {
			return registry.getServers();
		}),
		// The docker-serversync suite's observability trio. getRecentLogs is the
		// same classification-only buffer that feeds public issue reports, so a
		// suite can assert secrets never reach it. setServerSecret writes a
		// label's SecretStorage blob exactly as the dashboard and palette do.
		// getDeclaredServers returns the sync engine's views, which carry secret
		// locations but no secret values by construction.
		vscode.commands.registerCommand("litellm._test.getRecentLogs", () => issueReporter.getRecentLogs()),
		vscode.commands.registerCommand(
			"litellm._test.setServerSecret",
			(label: string, field: string, value: string | undefined) => {
				// Loud on junk: a typoed field silently no-oping would let a suite
				// pass while testing nothing.
				if (!(SECRET_FIELD_IDS as readonly string[]).includes(field)) {
					throw new Error(`Unknown secret field: ${field}`);
				}
				return updateServerSecret(context.secrets, label, field as SecretFieldId, value);
			}
		),
		vscode.commands.registerCommand("litellm._test.getDeclaredServers", () => syncEngine.getDeclared())
	);
}
