import type * as vscode from "vscode";
import { OneShotClient } from "../../provider/transport/oneShotClient";
import type { Logger } from "../../shared/logger";
import type { FeatureProbes } from "../dashboard/intents";
import { wireCommitGeneration } from "../features/commitGen/wiring";
import { createFimProbe, wireInlineCompletions } from "../features/inline/wiring";

/**
 * The features' composition point: constructs the ONE shared OneShotClient
 * (OAuth tokens cache across features and invalidate on 401 like the chat and
 * usage paths) and calls each feature's own wiring seam. A new feature adds
 * its features/<feature>/wiring.ts call here and nothing else at this level.
 */
export function wireFeatures(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: { readonly ua: string; readonly outputChannel: vscode.OutputChannel }
): { readonly featureProbes: FeatureProbes } {
	const oneShot = new OneShotClient({ userAgent: deps.ua });
	const inline = wireInlineCompletions(context, logger, { oneShot });
	wireCommitGeneration(context, logger, { oneShot, outputChannel: deps.outputChannel });
	return { featureProbes: { inlineCompletions: createFimProbe(inline.fimSend) } };
}
