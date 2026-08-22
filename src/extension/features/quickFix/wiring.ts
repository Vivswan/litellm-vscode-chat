import * as vscode from "vscode";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import { INTERNAL_CMD } from "../../../shared/config/commandIds";
import type { FeatureModelRef } from "../../../shared/config/settingSpec";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import { isFeatureEnabled } from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { createQuickFixActionsProvider, QUICK_FIX_METADATA } from "./actionsProvider";
import { runQuickFixChat, sendFallbackPrompt } from "./openChat";
import { buildFallbackPrompt } from "./query";

/**
 * Quick-fix wiring. The code-action provider exists ONLY while the feature is
 * enabled (opt-in by construction: disabled means no provider, so no LiteLLM
 * entry ever appears in a lightbulb), toggled by a configuration watcher. The
 * command behind the actions is registered unconditionally, because keybindings
 * and executeCommand ignore the enable setting and a command that silently
 * does nothing is worse than one that says why.
 *
 * `oneShot` is the activation-shared client, so OAuth tokens cache across
 * features and invalidate on 401 like the chat and usage paths.
 */

/**
 * Where the provider offers actions. `file` alone, deliberately. Not
 * `pattern: "**"`, because a diagnostic can be attached to documents this
 * feature cannot usefully act on (a read-only git diff, an output pane, a
 * settings editor). And not `untitled` either: the chat view's attachment
 * handling gates each file on its existence before attaching it, so on an
 * unsaved buffer the code would be dropped and the model asked to fix
 * diagnostics it cannot see. An action that quietly sends no code is worse
 * than no action, so the lightbulb stays out of unsaved buffers until they are
 * saved.
 */
const QUICK_FIX_SELECTOR: vscode.DocumentSelector = [{ scheme: "file" }];

/**
 * The probe's fixed sample: a two-line snippet with one unmistakable
 * diagnostic on it, run through the SAME prompt builder the fallback uses, so
 * the Test button proves the whole pipeline and not just connectivity. English
 * by policy, like every model-facing string, and fixed - the probe never sends
 * anything of the user's.
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

/**
 * The dashboard's test-model probe for this feature: the fallback's own send
 * over the fixed sample above. One pipeline, one truth - a green probe means
 * the fallback path works, credentials and surface included.
 */
export function createQuickFixProbe(
	secrets: vscode.SecretStorage,
	oneShot: OneShotClient,
	log: (message: string, data?: unknown) => void
): (model: FeatureModelRef) => Promise<string | undefined> {
	return async (model) => {
		// The source exists only to satisfy the send's token seam (the chat
		// timeout bounds the call); disposed deterministically so probes cannot
		// accumulate live sources across dashboard sessions.
		const source = new vscode.CancellationTokenSource();
		try {
			return await sendFallbackPrompt(oneShot, secrets, model, probePrompt(), source.token, log);
		} finally {
			source.dispose();
		}
	};
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
