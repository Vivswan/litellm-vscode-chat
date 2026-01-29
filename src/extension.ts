import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "./provider";

/**
 * Check if the current VS Code version meets the minimum required version.
 * @param current The current VS Code version (e.g., "1.108.0")
 * @param required The minimum required version (e.g., "1.108.0")
 * @returns true if current version is compatible, false otherwise
 */
function isVersionCompatible(current: string, required: string): boolean {
	const parse = (v: string) =>
		v
			.split(".")
			.slice(0, 3)
			.map((n) => parseInt(n.replace(/[^0-9]/g, ""), 10));
	const [cMaj, cMin, cPat] = parse(current);
	const [rMaj, rMin, rPat] = parse(required);
	if (cMaj !== rMaj) return cMaj > rMaj;
	if (cMin !== rMin) return cMin > rMin;
	return cPat >= rPat;
}

export function activate(context: vscode.ExtensionContext) {
	// Check VS Code version compatibility
	const minVersion = "1.108.0";
	if (!isVersionCompatible(vscode.version, minVersion)) {
		vscode.window
			.showErrorMessage(
				`LiteLLM requires VS Code ${minVersion} or higher. You have ${vscode.version}. Please update VS Code.`,
				"Download Update"
			)
			.then((sel) => {
				if (sel) {
					vscode.env.openExternal(vscode.Uri.parse("https://code.visualstudio.com/"));
				}
			});
		return; // Don't register provider
	}
	// Build a descriptive User-Agent to help quantify API usage
	const ext = vscode.extensions.getExtension("vivswan.litellm-vscode-chat");
	const extVersion = ext?.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	// Keep UA minimal: only extension version and VS Code version
	const ua = `litellm-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

	const provider = new LiteLLMChatModelProvider(context.secrets, ua);
	// Register the LiteLLM provider under the vendor id used in package.json
	vscode.lm.registerLanguageModelChatProvider("litellm", provider);

	// Create status bar indicator
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = "litellm.manage";
	context.subscriptions.push(statusBarItem);

	// Function to update status bar based on configuration state
	async function updateStatusBar() {
		const baseUrl = await context.secrets.get("litellm.baseUrl");
		if (baseUrl) {
			statusBarItem.text = "$(check) LiteLLM";
			statusBarItem.tooltip = `Connected to ${baseUrl}\nClick to manage`;
			statusBarItem.backgroundColor = undefined;
		} else {
			statusBarItem.text = "$(warning) LiteLLM";
			statusBarItem.tooltip = "Not configured - click to set up";
			statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
		}
		statusBarItem.show();
	}

	// Initial status bar update
	updateStatusBar();

	// Update when secrets change
	context.secrets.onDidChange((e) => {
		if (e.key === "litellm.baseUrl") {
			updateStatusBar();
		}
	});

	// Show welcome message on first run for unconfigured users
	const hasShownWelcome = context.globalState.get<boolean>("litellm.hasShownWelcome", false);
	if (!hasShownWelcome) {
		context.secrets.get("litellm.baseUrl").then((baseUrl) => {
			if (!baseUrl) {
				vscode.window
					.showInformationMessage(
						"Welcome to LiteLLM! Connect to 100+ LLMs in VS Code.",
						"Configure Now",
						"Documentation"
					)
					.then((choice) => {
						if (choice === "Configure Now") {
							vscode.commands.executeCommand("litellm.manage");
						} else if (choice === "Documentation") {
							vscode.env.openExternal(vscode.Uri.parse("https://github.com/Vivswan/litellm-vscode-chat#quick-start"));
						}
					});
			}
		});
		context.globalState.update("litellm.hasShownWelcome", true);
	}

	// Management command to configure base URL and API key
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.manage", async () => {
			// First, prompt for base URL
			const existingBaseUrl = await context.secrets.get("litellm.baseUrl");
			const baseUrl = await vscode.window.showInputBox({
				title: "LiteLLM Base URL",
				prompt: existingBaseUrl
					? "Update your LiteLLM base URL"
					: "Enter your LiteLLM base URL (e.g., http://localhost:4000 or https://api.litellm.ai)",
				ignoreFocusOut: true,
				value: existingBaseUrl ?? "",
				placeHolder: "http://localhost:4000",
				validateInput: (value) => {
					if (!value.trim()) {
						return "Base URL is required";
					}
					if (!value.startsWith("http://") && !value.startsWith("https://")) {
						return "URL must start with http:// or https://";
					}
					return null;
				},
			});
			if (baseUrl === undefined) {
				return; // user canceled
			}

			// Then, prompt for API key
			const existingApiKey = await context.secrets.get("litellm.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "LiteLLM API Key",
				prompt: existingApiKey
					? "Update your LiteLLM API key"
					: "Enter your LiteLLM API key (leave empty if not required)",
				ignoreFocusOut: true,
				password: false,
				value: existingApiKey ?? "",
			});
			if (apiKey === undefined) {
				return; // user canceled
			}

			// Save or clear the values
			if (!baseUrl.trim()) {
				await context.secrets.delete("litellm.baseUrl");
			} else {
				await context.secrets.store("litellm.baseUrl", baseUrl.trim());
			}

			if (!apiKey.trim()) {
				await context.secrets.delete("litellm.apiKey");
			} else {
				await context.secrets.store("litellm.apiKey", apiKey.trim());
			}

			// Update status bar to reflect new configuration
			await updateStatusBar();

			// Show success message with option to open chat
			vscode.window.showInformationMessage("LiteLLM configuration saved successfully!", "Open Chat").then((choice) => {
				if (choice === "Open Chat") {
					vscode.commands.executeCommand("workbench.action.chat.open");
				}
			});
		})
	);
}

export function deactivate() {}
