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
	const inline = wireInlineCompletions(context, logger, { oneShot });
	wireCommitGeneration(context, logger, { oneShot, outputChannel: deps.outputChannel });
	const consult = wireConsultTool(context, logger, { oneShot });
	wireMcpServers(context, logger, { oneShot });
	const prGen = wirePrGeneration(context, logger, { oneShot, outputChannel: deps.outputChannel });
	// Surfaced rather than consumed here: the quick-fix feature registers /fix
	// and /explain through this seam when it lands (a declared cross-feature
	// edit; features may not import each other, so the seam is the only route).
	const chatParticipant = wireChatParticipant(context, logger, { getSnapshots: deps.getSnapshots });
	return {
		featureProbes: {
			inlineCompletions: createFimProbe(inline.fimSend),
			consultTool: createConsultProbe(consult.consultSend),
			prGeneration: createPrProbe(prGen.prSend),
		},
		chatParticipant,
	};
}
