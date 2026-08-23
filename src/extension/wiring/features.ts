import type * as vscode from "vscode";
import { OneShotClient } from "../../provider/transport/oneShotClient";
import type { Logger } from "../../shared/logger";
import type { FeatureProbes } from "../dashboard/intents";
import { wireCommitGeneration } from "../features/commitGen/wiring";
import { createConsultProbe, wireConsultTool } from "../features/consultTool/wiring";
import { createFimProbe, wireInlineCompletions } from "../features/inline/wiring";
import { wireMcpServers } from "../features/mcp/wiring";
import type { SnapshotSource } from "../features/participant/snapshots";
import type { ChatParticipantWiring } from "../features/participant/wiring";
import { wireChatParticipant } from "../features/participant/wiring";
import { createPrProbe, wirePrGeneration } from "../features/prGen/wiring";
import { createQuickFixProbe, wireQuickFix } from "../features/quickFix/wiring";
import { registerQuickFixSlashCommands } from "../features/quickFixChatCommands";
import { createReviewProbe, wireReviewComments } from "../features/reviewComments/wiring";

/**
 * The features' composition point: constructs the ONE shared OneShotClient
 * (OAuth tokens cache across features and invalidate on 401 like the chat and
 * usage paths) and calls each feature's own wiring seam. A new feature adds
 * its features/<feature>/wiring.ts call here and nothing else at this level.
 */
export function wireFeatures(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: {
		readonly ua: string;
		readonly outputChannel: vscode.OutputChannel;
		/** The provider's per-group snapshots, for the participant's zero-network /models answer. */
		readonly getSnapshots: () => readonly SnapshotSource[];
	}
): { readonly featureProbes: FeatureProbes; readonly chatParticipant: ChatParticipantWiring } {
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
	const chatParticipant = wireChatParticipant(context, logger, { getSnapshots: deps.getSnapshots });
	wireQuickFix(context, logger, {
		oneShot,
		outputChannel: deps.outputChannel,
		// Read per invocation, never captured: the participant comes and goes with
		// its setting and with what the host accepted.
		isParticipantAvailable: () => chatParticipant.isRegistered(),
	});
	// The wave's one declared cross-feature edit: quick fixes teach the
	// participant /fix and /explain, because the lightbulb's primary path opens
	// chat with them already submitted. Registration happens here rather than inside
	// either feature - features may not import each other, and composing them is
	// exactly this module's job. Once, at activation: registration is not a
	// runtime toggle, and it deliberately outlives the quickFix enable setting,
	// which gates the lightbulb rather than what @litellm can be asked.
	registerQuickFixSlashCommands(chatParticipant.slashCommands);
	return {
		featureProbes: {
			inlineCompletions: createFimProbe(inline.fimSend),
			consultTool: createConsultProbe(consult.consultSend),
			prGeneration: createPrProbe(prGen.prSend),
			quickFix: createQuickFixProbe(context.secrets, oneShot, log),
			reviewComments: createReviewProbe(review.reviewSend),
		},
		chatParticipant,
	};
}
