/**
 * The dashboard WebviewPanel wiring. DashboardController holds the panel
 * lifecycle and message dispatch against injected seams (panel factory,
 * snapshot source, settings access), so everything but the last-mile vscode
 * calls is unit-testable. registerDashboardCommand supplies the real vscode
 * implementations.
 *
 * The panel does not retain context when hidden: the webview is a stateless
 * view, so a fresh page asking for state (the "ready" handshake) rebuilds it
 * from the stores, and every store change re-pushes the full state.
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { LiteLLMChatModelProvider, ServerModelsSnapshot } from "../../provider";
import type { Logger } from "../../shared/logger";
import { buildDashboardHtml } from "./html";
import type { ExtensionToWebviewMessage } from "./protocol";
import type { IntentEnvironment, SettingsReader } from "./state";
import { buildDashboardState, executeDashboardIntent, resolveUpdateScope, webviewMessageSchema } from "./state";

/** The slice of vscode.Webview the controller uses. */
interface DashboardWebview {
	html: string;
	postMessage(message: unknown): Thenable<boolean>;
	onDidReceiveMessage: vscode.Event<unknown>;
}

/** The slice of vscode.WebviewPanel the controller uses. */
export interface DashboardPanel {
	readonly webview: DashboardWebview;
	readonly visible: boolean;
	reveal(): void;
	onDidDispose: vscode.Event<void>;
	onDidChangeViewState: vscode.Event<unknown>;
	dispose(): void;
}

/** Everything the controller needs, injected; registerDashboardCommand builds the real one. */
export interface DashboardControllerEnv extends IntentEnvironment {
	/** Create the panel with its HTML already set. */
	createPanel(): DashboardPanel;
	getSnapshots(): readonly ServerModelsSnapshot[];
	settingsReader(): SettingsReader;
	log(message: string, data?: unknown): void;
	logError(message: string, error: unknown): void;
}

export class DashboardController implements vscode.Disposable {
	private _panel: DashboardPanel | undefined;
	private readonly _panelSubscriptions: vscode.Disposable[] = [];

	constructor(private readonly env: DashboardControllerEnv) {}

	/** Open the dashboard, or bring the existing panel to the front. */
	open(): void {
		if (this._panel !== undefined) {
			this._panel.reveal();
			this.pushState();
			return;
		}
		const panel = this.env.createPanel();
		this._panel = panel;
		this._panelSubscriptions.push(
			panel.webview.onDidReceiveMessage((message) => {
				this.handleMessage(message).catch((error) => {
					this.env.logError("Dashboard message handling failed", error);
				});
			}),
			panel.onDidChangeViewState(() => {
				// Context is not retained while hidden, so a re-shown webview needs
				// the current state again (its own "ready" also covers the reload;
				// this push covers hosts that restore the page without reloading).
				if (panel.visible) {
					this.pushState();
				}
			}),
			panel.onDidDispose(() => {
				this.disposePanel();
			})
		);
		this.pushState();
	}

	/** Re-push state after a store change (configuration or provider status); no-op without a visible panel. */
	refresh(): void {
		if (this._panel?.visible === true) {
			this.pushState();
		}
	}

	dispose(): void {
		this._panel?.dispose();
		this.disposePanel();
	}

	private disposePanel(): void {
		for (const subscription of this._panelSubscriptions.splice(0)) {
			subscription.dispose();
		}
		this._panel = undefined;
	}

	private pushState(): void {
		if (this._panel === undefined) {
			return;
		}
		this.postToPanel({
			type: "state",
			state: buildDashboardState(this.env.getSnapshots(), this.env.settingsReader()),
		});
	}

	private async handleMessage(raw: unknown): Promise<void> {
		const parsed = webviewMessageSchema.safeParse(raw);
		if (!parsed.success) {
			this.env.log("Ignoring malformed dashboard message", { issues: parsed.error.issues });
			return;
		}
		if (parsed.data.type === "ready") {
			this.pushState();
			return;
		}
		const intent = parsed.data;
		try {
			await executeDashboardIntent(intent, this.env);
		} catch (error) {
			// The write did not land, so no configuration event and no state push
			// will follow; the failure notice is the webview's only signal to
			// surface the message and return the affected editor to a retryable
			// draft.
			this.env.logError("Dashboard intent failed", error);
			this.postToPanel({
				type: "intentFailed",
				intentType: intent.type,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private postToPanel(message: ExtensionToWebviewMessage): void {
		// A hidden webview drops the message; the visibility push re-sends state.
		this._panel?.webview.postMessage(message).then(undefined, (error: unknown) => {
			this.env.logError("Dashboard message post failed", error);
		});
	}
}

const CONFIG_SECTION = "litellm-vscode-chat";

// resolveUpdateScope never yields workspaceFolder: a WorkspaceFolder update
// through resource-less configuration access would throw in multi-root
// workspaces, so folder-scope values stay read-only in the dashboard.
const TARGET_BY_SCOPE = {
	global: vscode.ConfigurationTarget.Global,
	workspace: vscode.ConfigurationTarget.Workspace,
} as const;

function createNonce(): string {
	return randomBytes(16).toString("hex");
}

function createRealPanel(extensionUri: vscode.Uri): DashboardPanel {
	const distDir = vscode.Uri.joinPath(extensionUri, "dist", "webview");
	const panel = vscode.window.createWebviewPanel("litellm.dashboard", "LiteLLM Dashboard", vscode.ViewColumn.Active, {
		enableScripts: true,
		localResourceRoots: [distDir],
	});
	panel.webview.html = buildDashboardHtml({
		cspSource: panel.webview.cspSource,
		nonce: createNonce(),
		scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(distDir, "dashboard.js")).toString(),
	});
	return panel;
}

/**
 * Register litellm.openDashboard and keep the panel in sync with the stores:
 * configuration changes re-push directly; provider status changes arrive via
 * the returned controller's refresh(), called from the status fan-out in
 * extension.ts.
 */
export function registerDashboardCommand(
	context: vscode.ExtensionContext,
	provider: LiteLLMChatModelProvider,
	logger: Logger
): DashboardController {
	const controller = new DashboardController({
		createPanel: () => createRealPanel(context.extensionUri),
		getSnapshots: () => provider.getServerSnapshots(),
		settingsReader: () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			return {
				get: (key) => config.get<unknown>(key),
				inspect: (key) => config.inspect(key),
			};
		},
		updateSetting: async (key, value) => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const scope = resolveUpdateScope(config.inspect(key));
			await config.update(key, value, TARGET_BY_SCOPE[scope]);
		},
		executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
		log: (message, data) => logger.log(message, data),
		logError: (message, error) => logger.error(message, error),
	});
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.openDashboard", () => controller.open()),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				controller.refresh();
			}
		}),
		controller
	);
	return controller;
}
