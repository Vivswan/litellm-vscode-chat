import * as vscode from "vscode";
import type { IssueReporter } from "../issueReporter";
import { buildDiagnosticsSnapshot } from "./diagnostics";
import {
	openChatAction,
	reconfigureAction,
	reportIssueAction,
	showActionableMessage,
	viewOutputAction,
} from "./notifier";
import type { ServerConfig, ServerRegistry } from "./serverRegistry";
import type { ConnectionStatus } from "./status";

const GITHUB_REPO = "https://github.com/Vivswan/litellm-vscode-chat";
const GITHUB_NEW_ISSUE_FEATURE = `${GITHUB_REPO}/issues/new?labels=enhancement&title=%5BFeature%5D+`;
const GITHUB_DOCS = `${GITHUB_REPO}#quick-start`;

interface ModelInfoProvider {
	prepareLanguageModelChatInformation(
		options: { silent: boolean },
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]>;
}

export function registerTestConnectionCommand(
	context: vscode.ExtensionContext,
	registry: ServerRegistry,
	provider: ModelInfoProvider,
	statusBar: { updateStatusBar(status: ConnectionStatus): Promise<void> },
	outputChannel: vscode.OutputChannel
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.testConnection", async () => {
			if (registry.getServers().length === 0) {
				void showActionableMessage(
					"error",
					"LiteLLM: No servers configured. Please run 'Manage LiteLLM Provider' first.",
					[]
				);
				return;
			}

			outputChannel.appendLine(`\n[${new Date().toISOString()}] Testing connection to all servers...`);
			outputChannel.show(true);

			try {
				await statusBar.updateStatusBar({ state: "loading" });

				const models = await provider.prepareLanguageModelChatInformation(
					{ silent: false },
					new vscode.CancellationTokenSource().token
				);

				if (models.length === 0) {
					outputChannel.appendLine(`[${new Date().toISOString()}] WARNING: No models returned`);
					void showActionableMessage(
						"warning",
						"LiteLLM: Connected but no models returned. Check your LiteLLM proxy configuration.",
						[viewOutputAction(outputChannel), reconfigureAction(), reportIssueAction()]
					);
				} else {
					outputChannel.appendLine(`[${new Date().toISOString()}] SUCCESS: Found ${models.length} models`);
					void showActionableMessage(
						"info",
						`LiteLLM: Connection successful! Found ${models.length} model${models.length === 1 ? "" : "s"}.`,
						[viewOutputAction(outputChannel, "View Models"), openChatAction()]
					);
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				outputChannel.appendLine(`[${new Date().toISOString()}] ERROR: ${errorMsg}`);
				void showActionableMessage("error", `LiteLLM: Connection failed - ${errorMsg}`, [
					viewOutputAction(outputChannel),
					reconfigureAction(),
					reportIssueAction(),
				]);
			}
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
		vscode.commands.registerCommand("litellm.reportIssue", async () => {
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
		vscode.commands.registerCommand("litellm.helpAndFeedback", async () => {
			const choice = await vscode.window.showQuickPick(
				[
					{ label: "$(bug) Report Bug", id: "bug" },
					{ label: "$(lightbulb) Request Feature", id: "feature" },
					{ label: "$(book) Documentation", id: "docs" },
				],
				{ title: "LiteLLM: Help & Feedback", placeHolder: "What would you like to do?" }
			);
			if (!choice) {
				return;
			}
			if (choice.id === "bug") {
				await vscode.commands.executeCommand("litellm.reportIssue");
				return;
			}
			const urls: Record<string, string> = {
				feature: GITHUB_NEW_ISSUE_FEATURE,
				docs: GITHUB_DOCS,
			};
			vscode.env.openExternal(vscode.Uri.parse(urls[choice.id]));
		})
	);
}

export function registerTestCommands(
	context: vscode.ExtensionContext,
	registry: ServerRegistry,
	provider: ModelInfoProvider
): void {
	if (context.extensionMode === vscode.ExtensionMode.Production) {
		return;
	}

	const refreshModelIds = async (): Promise<string[]> => {
		const infos = await provider.prepareLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);
		return infos.map((info) => info.id);
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
		})
	);
}
