import type * as vscode from "vscode";
import { OneShotClient } from "../../provider/transport/oneShotClient";
import type { Logger } from "../../shared/logger";
import type { HeaderValue } from "../../shared/util/headers";
import type { FeatureProbes } from "../dashboard/intents";
import type { DashboardController } from "../dashboard/panel";
import type { AgentToolsDeps } from "../features/agentTools/wiring";
import { wireAgentTools } from "../features/agentTools/wiring";
import { createCommitProbe, wireCommitGeneration } from "../features/commitGen/wiring";
import { createConsultProbe, wireConsultTool } from "../features/consultTool/wiring";
import { createFimProbe, wireInlineCompletions } from "../features/inline/wiring";
import { wireMcpServers } from "../features/mcp/wiring";
import { createPrProbe, wirePrGeneration } from "../features/prGen/wiring";
import { createReviewProbe, wireReviewComments } from "../features/reviewComments/wiring";
import { createSettingsAccess } from "../settingsAccess";

/**
 * The agent tools are the one feature wired AFTER the dashboard (wireDashboardClientFeatures): they are a client of its
 * controller, and the controller needs the probes this function returns.
 *
 *   The features' composition point -> constructs the ONE shared OneShotClient (OAuth tokens cache across features)
 *   A new feature adds its features/<feature>/wiring.ts call here -> nothing else at this level
 */
export function wireFeatures(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: {
		readonly ua: HeaderValue;
		readonly outputChannel: vscode.OutputChannel;
	}
): { readonly featureProbes: FeatureProbes } {
	const oneShot = new OneShotClient({ userAgent: deps.ua });
	const log = (message: string, data?: unknown): void => {
		logger.log(message, data);
	};
	const inline = wireInlineCompletions(context, logger, { oneShot });
	wireCommitGeneration(context, logger, { oneShot, outputChannel: deps.outputChannel });
	const consult = wireConsultTool(context, logger, { oneShot });
	wireMcpServers(context, logger, { oneShot });
	const prGen = wirePrGeneration(context, logger, { oneShot, outputChannel: deps.outputChannel });
	const review = wireReviewComments(context, logger, { oneShot, outputChannel: deps.outputChannel });
	return {
		featureProbes: {
			inlineCompletions: createFimProbe(inline.fimSend),
			commitGeneration: createCommitProbe(context.secrets, oneShot, log),
			consultTool: createConsultProbe(consult.consultSend),
			prGeneration: createPrProbe(prGen.prSend),
			reviewComments: createReviewProbe(review.reviewSend),
		},
	};
}

/**
 * The agent tools submit their writes to the controller exactly as the webview does, so they join its serialized chain
 * and its state pushes.
 */
export function wireDashboardClientFeatures(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: Omit<AgentToolsDeps, "settings" | "dashboard"> & { readonly dashboard: DashboardController }
): void {
	wireAgentTools(context, logger, { ...deps, settings: createSettingsAccess() });
}
