import * as vscode from "vscode";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import { INTERNAL_CMD } from "../../../shared/config/commandIds";
import type { FeatureModelRef } from "../../../shared/config/settingSpec";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import { isFeatureEnabled } from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { withProbeToken } from "../probeToken";
import { createQuickFixActionsProvider, QUICK_FIX_METADATA } from "./actionsProvider";
import { runQuickFixChat, sendFallbackPrompt } from "./openChat";
import { buildFallbackPrompt } from "./query";

/**
 * A command that silently does nothing is worse than one that says why, so only the provider is gated.
 *
 *   code-action provider -> exists ONLY while enabled, so no LiteLLM entry appears in a lightbulb while it is off
 *   keybindings and executeCommand ignore the enable setting -> command registered unconditionally
 */

/**
 * `file` alone, deliberately, because an action that quietly sends no code is worse than no action.
 *
 *   `pattern: "**"` -> a diagnostic can sit on documents this feature cannot act on, a git diff, an output pane
 *   `untitled` -> the chat view attaches only files that exist, so the model would be asked to fix code it cannot see
 */
const QUICK_FIX_SELECTOR: vscode.DocumentSelector = [{ scheme: "file" }];

/**
 * English by policy, like every model-facing string, and fixed - the probe never sends anything of the user's.
 *
 *   run through the SAME prompt builder the fallback uses -> the Test button proves the whole pipeline
 */
function probePrompt(): string {
	return buildFallbackPrompt({
		mode: "fix",
		path: "sample.ts",
		languageId: "typescript",
		excerpt: "function sum(values: number[]) {\n\treturn total;\n}\n",
		diagnostics: [
			{
				message: "Cannot find name 'total'.",
				range: { start: { line: 1, character: 8 }, end: { line: 1, character: 13 } },
				severity: 0,
				source: "ts",
				code: 2304,
			},
		],
	});
}

export function createQuickFixProbe(
	secrets: vscode.SecretStorage,
	oneShot: OneShotClient,
	log: (message: string, data?: unknown) => void
): (model: FeatureModelRef) => Promise<string | undefined> {
	return (model) => withProbeToken((token) => sendFallbackPrompt(oneShot, secrets, model, probePrompt(), token, log));
}

export function wireQuickFix(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: {
		readonly oneShot: OneShotClient;
		readonly outputChannel: vscode.OutputChannel;
		/** The participant wiring's own readiness predicate; the chat path is only taken while it says yes. */
		readonly isParticipantAvailable: () => boolean;
	}
): void {
	const provider = createQuickFixActionsProvider();

	let registration: vscode.Disposable | undefined;
	const applyEnablement = (): void => {
		const enabled = isFeatureEnabled("quickFix");
		if (enabled && registration === undefined) {
			registration = vscode.languages.registerCodeActionsProvider(QUICK_FIX_SELECTOR, provider, QUICK_FIX_METADATA);
		} else if (!enabled && registration !== undefined) {
			registration.dispose();
			registration = undefined;
		}
	};
	applyEnablement();

	context.subscriptions.push(
		vscode.commands.registerCommand(INTERNAL_CMD.quickFixChat, (args: unknown) =>
			runQuickFixChat(
				deps.oneShot,
				{
					secrets: context.secrets,
					logger,
					outputChannel: deps.outputChannel,
					isParticipantAvailable: deps.isParticipantAvailable,
				},
				args
			)
		),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				applyEnablement();
			}
		}),
		new vscode.Disposable(() => {
			registration?.dispose();
			registration = undefined;
		})
	);
}
