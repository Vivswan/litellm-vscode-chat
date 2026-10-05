import type * as vscode from "vscode";
import { OneShotClient } from "../../provider/transport/oneShotClient";
import type { Logger } from "../../shared/logger";
import type { KnownSecretCustody } from "../../shared/util/knownSecrets";
import type { FeatureProbes } from "../dashboard/intents";
import type { DashboardController } from "../dashboard/panel";
import type { AgentToolsDeps } from "../features/agentTools/wiring";
import { wireAgentTools } from "../features/agentTools/wiring";
import { createCommitProbe, wireCommitGeneration } from "../features/commitGen/wiring";
import { createConsultProbe, wireConsultTool } from "../features/consultTool/wiring";
import { createFimProbe, wireInlineCompletions } from "../features/inline/wiring";
import { wireMcpServers } from "../features/mcp/wiring";
import type { ChatParticipantWiring, SnapshotSource } from "../features/participant/wiring";
import { wireChatParticipant } from "../features/participant/wiring";
import { createPrProbe, wirePrGeneration } from "../features/prGen/wiring";
import { createQuickFixProbe, wireQuickFix } from "../features/quickFix/wiring";
import { registerQuickFixSlashCommands } from "../features/quickFixChatCommands";
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
		readonly ua: string;
		readonly outputChannel: vscode.OutputChannel;
		readonly getSnapshots: () => readonly SnapshotSource[];
		readonly knownSecrets: KnownSecretCustody;
	}
): { readonly featureProbes: FeatureProbes; readonly chatParticipant: ChatParticipantWiring } {
	const oneShot = new OneShotClient({ userAgent: deps.ua, knownSecrets: deps.knownSecrets });
	const log = (message: string, data?: unknown): void => {
		logger.log(message, data);
	};
	const inline = wireInlineCompletions(context, logger, { oneShot });
	wireCommitGeneration(context, logger, { oneShot, outputChannel: deps.outputChannel });
	const consult = wireConsultTool(context, logger, { oneShot });
	wireMcpServers(context, logger, { oneShot });
	const prGen = wirePrGeneration(context, logger, { oneShot, outputChannel: deps.outputChannel });
	const review = wireReviewComments(context, logger, { oneShot, outputChannel: deps.outputChannel });
	const chatParticipant = wireChatParticipant(context, logger, { getSnapshots: deps.getSnapshots });
	wireQuickFix(context, logger, {
		oneShot,
		outputChannel: deps.outputChannel,
		// Read per invocation, never captured: the participant comes and goes with its setting and with what the host
		// accepted.
		isParticipantAvailable: () => chatParticipant.isRegistered(),
	});
	// Registration happens here rather than inside either feature - features may not import each other, and composing
	// them is exactly this module's job. Once, at activation: registration is not a runtime toggle, and it deliberately
	// outlives the quickFix enable setting, which gates the lightbulb rather than what @litellm can be asked.
	//
	//   quick fixes teach the participant /fix and /explain -> the lightbulb's primary path opens chat with them
	//                                                          already submitted
	registerQuickFixSlashCommands(chatParticipant.slashCommands);
	return {
		featureProbes: {
			inlineCompletions: createFimProbe(inline.fimSend),
			commitGeneration: createCommitProbe(context.secrets, oneShot, log),
			consultTool: createConsultProbe(consult.consultSend),
			prGeneration: createPrProbe(prGen.prSend),
			quickFix: createQuickFixProbe(context.secrets, oneShot, log),
			reviewComments: createReviewProbe(review.reviewSend),
		},
		chatParticipant,
	};
}

/**
 * The agent tools submit their writes to the controller exactly as the webview does, so they join its serialized chain
 * and its state pushes.
 */
export function wireDashboardClientFeatures(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: Omit<AgentToolsDeps, "settings" | "dashboard" | "secretStore"> & { readonly dashboard: DashboardController }
): void {
	wireAgentTools(context, logger, { ...deps, settings: createSettingsAccess(), secretStore: context.secrets });
}
