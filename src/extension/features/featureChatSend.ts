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
 * This is the one-shot chat features' one send composition.
 * It lives at the features/ root because features may not import each other.
 * Each feature keeps its own prompt assembly and error handling.
 * Only the send is shared.
 * The body is exactly what OneShotChatRequest declares.
 * models.parameters records do NOT apply on this path.
 * No max_tokens rides along, so the model's own default bounds the answer.
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
