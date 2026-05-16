import * as vscode from "vscode";
import type { ServerRegistry } from "./serverRegistry";

const GITHUB_REPO = "https://github.com/Vivswan/litellm-vscode-chat";
const GITHUB_NEW_ISSUE_FEATURE = `${GITHUB_REPO}/issues/new?labels=enhancement&title=%5BFeature%5D+`;
const GITHUB_DOCS = `${GITHUB_REPO}#quick-start`;

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
	provider: {
		prepareLanguageModelChatInformation: (
			options: { silent: boolean },
			token: vscode.CancellationToken
		) => Promise<vscode.LanguageModelChatInformation[]>;
	}
): void {
	if (context.extensionMode !== vscode.ExtensionMode.Production) {
		context.subscriptions.push(
			vscode.commands.registerCommand("litellm._test.setSecrets", async (baseUrl: string, apiKey: string) => {
				await context.secrets.store("litellm.baseUrl", baseUrl);
				await context.secrets.store("litellm.apiKey", apiKey || "");
			}),
			vscode.commands.registerCommand("litellm._test.refreshModels", async () => {
				const infos = await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);
				return infos.length;
			}),
			vscode.commands.registerCommand("litellm._test.refreshModelIds", async () => {
				const infos = await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);
				return infos.map((info) => info.id);
			}),
			vscode.commands.registerCommand(
				"litellm._test.addServer",
				async (label: string, baseUrl: string, apiKey: string) => {
					return registry.addServer(label, baseUrl, apiKey || "");
				}
			),
			vscode.commands.registerCommand("litellm._test.removeServer", async (serverId: string) => {
				await registry.removeServer(serverId);
			}),
			vscode.commands.registerCommand("litellm._test.clearServers", async () => {
				for (const s of registry.getServers()) {
					await registry.removeServer(s.id);
				}
				await context.secrets.delete("litellm.baseUrl");
				await context.secrets.delete("litellm.apiKey");
			}),
			vscode.commands.registerCommand("litellm._test.getServers", () => {
				return registry.getServers();
			})
		);
	}
}
