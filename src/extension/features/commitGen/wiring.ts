import * as vscode from "vscode";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import { CMD } from "../../../shared/config/commandIds";
import type { FeatureModelRef } from "../../../shared/config/settingSpec";
import { getCommitGenerationPrompt } from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { stripMarkdownFences } from "../../../shared/util/text";
import { withProbeToken } from "../probeToken";
import { buildCommitPrompt } from "./commitMessage";
import { runGenerateCommitMessage, sendCommitPrompt } from "./generateCommitCommand";

/**
 * Commit-generation wiring: the handler is registered unconditionally (the
 * SCM-title and palette surfaces hide behind the enable when-clause, but
 * executeCommand and keybindings do not), and the run function answers a
 * disabled invocation with the enable hint. `oneShot` is the activation-shared
 * client, so OAuth tokens cache across invocations and across features and
 * invalidate on 401 like the chat and usage paths.
 */
export function wireCommitGeneration(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: { readonly oneShot: OneShotClient; readonly outputChannel: vscode.OutputChannel }
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.generateCommitMessage, (commandArg?: unknown) =>
			runGenerateCommitMessage(
				deps.oneShot,
				{ secrets: context.secrets, logger, outputChannel: deps.outputChannel },
				commandArg
			)
		)
	);
}

/**
 * The probe's canned change: one small patch hunk any model can describe.
 * Nothing here is read from the user's repository - a probe must never send a
 * real diff - and the canned subjects stand in for the style examples a real
 * generation reads from the log.
 */
const PROBE_DIFF = [
	"diff --git a/upload.ts b/upload.ts",
	"--- a/upload.ts",
	"+++ b/upload.ts",
	"@@ -1,3 +1,6 @@",
	" export async function upload(body: string): Promise<void> {",
	"-\tawait send(body);",
	"+\tfor (let attempt = 0; attempt < 3; attempt++) {",
	"+\t\ttry { return await send(body); } catch { /* retry */ }",
	"+\t}",
	" }",
].join("\n");

/** The canned style examples riding the probe prompt, like a real repository's recent subjects would. */
const PROBE_SUBJECTS = ["feat: add the upload path", "test: cover the upload path"] as const;

/**
 * The dashboard's test-model probe for this feature: the real prompt assembly
 * (the user's custom instruction setting included) over the fixed sample
 * above, the shared send the command runs, and the same fence-stripped
 * emptiness rule - so an all-fence reply surfaces as the empty-answer warning
 * instead of a false success. One pipeline, one truth.
 */
export function createCommitProbe(
	secrets: vscode.SecretStorage,
	oneShot: OneShotClient,
	log: (message: string, data?: unknown) => void
): (model: FeatureModelRef) => Promise<string | undefined> {
	return (model) =>
		withProbeToken(async (token) => {
			const prompt = buildCommitPrompt({
				customPrompt: getCommitGenerationPrompt(),
				diff: PROBE_DIFF,
				recentSubjects: [...PROBE_SUBJECTS],
				untrackedPaths: [],
			});
			return stripMarkdownFences(await sendCommitPrompt(oneShot, secrets, model, prompt, token, log));
		});
}
