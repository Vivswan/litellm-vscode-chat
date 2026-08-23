import type * as vscode from "vscode";
import { FEATURE_ERROR_SURFACE } from "../../provider/transport/errorMapping";
import type { OneShotChatMessage, OneShotClient } from "../../provider/transport/oneShotClient";
import type { FeatureModelId, FeatureModelRef } from "../../shared/config/settingSpec";
import { getRequestTimeout } from "../../shared/config/settings";
import { entryConnectionFor } from "../servers/entryConnection";
import { noEntryForConfiguredServer } from "./modelSettingError";

/**
 * The features on this pipeline, derived by exclusion: inline completions are
 * the one model-picking feature NOT here - they send /completions (FIM)
 * through their own wiring - and the type makes that unrepresentable rather
 * than commented.
 */
export type OneShotChatFeature = Exclude<FeatureModelId, "inlineCompletions">;

/**
 * The one-shot chat features' ONE send composition, at the features/ root
 * because features may not import each other: label-to-connection through the
 * shared entryConnectionFor, the shared no-such-label error naming the
 * feature's own model setting, and one non-streaming /chat/completions call
 * under the feature's error surface (FEATURE_ERROR_SURFACE) bounded by the
 * chat request timeout. Each feature keeps its own prompt assembly and its own
 * error handling around this; only the send composition is shared. The body is
 * exactly what OneShotChatRequest declares - models.parameters records
 * deliberately do NOT apply on this path, and no max_tokens rides along, so
 * the model's own default bounds the answer.
 */
export async function featureChatSend(
	feature: OneShotChatFeature,
	deps: { readonly oneShot: Pick<OneShotClient, "completeChatOnce">; readonly secrets: vscode.SecretStorage },
	ref: FeatureModelRef,
	messages: readonly OneShotChatMessage[],
	token: vscode.CancellationToken,
	log: (message: string, data?: unknown) => void
): Promise<string> {
	const resolved = await entryConnectionFor(deps.secrets, ref.server);
	if (resolved === undefined) {
		throw noEntryForConfiguredServer(feature, ref.server);
	}
	return deps.oneShot.completeChatOnce(
		resolved.connection,
		{ model: ref.model, messages },
		FEATURE_ERROR_SURFACE[feature],
		{
			// Minted where the number is read: this whole-call bound is the chat
			// request timeout, so timeout advice names chat.timeout.
			timeout: { ms: getRequestTimeout(log), setting: "chat.timeout" },
			token,
		}
	);
}
