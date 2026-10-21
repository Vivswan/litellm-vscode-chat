import type * as vscode from "vscode";
import type { OneShotChatMessage, OneShotClient } from "../../provider/transport/oneShotClient";
import { featureSessionFingerprintHeader } from "../../provider/transport/sessionFingerprint";
import { FEATURE_ERROR_SURFACE } from "../../provider/transport/transportErrors";
import type { FeatureModelId, FeatureModelRef } from "../../shared/config/settingSpec";
import { getRequestTimeout } from "../../shared/config/settings";
import { Logger } from "../../shared/logger";
import { entryConnectionFor } from "../servers/entryConnection";
import { configuredServerUnavailable } from "./modelSettingError";

/**
 * The features on this pipeline, derived by exclusion: inline completions are the one model-picking feature NOT here
 * - they send /completions (FIM) through their own wiring - and the type makes that unrepresentable rather than
 * commented.
 */
export type OneShotChatFeature = Exclude<FeatureModelId, "inlineCompletions">;

/**
 * The one-shot chat features' one send composition, at the features/ root because features may not import each
 * other. models.parameters records deliberately do NOT apply on this send composition, and no max_tokens rides
 * along, so the model's own default bounds the answer.
 *
 * The reply enters the extension here, so this is where it passes the door: every feature on this pipeline (the
 * quick-fix editor, the SCM input box, persisted review comments, the PR fields, the consult result) receives it
 * masked and masks again only where its own parse may respell a value.
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
	if (resolved.kind !== "resolved") {
		throw configuredServerUnavailable(feature, ref.server, resolved);
	}
	return Logger.redact(
		await deps.oneShot.completeChatOnce(
			resolved.connection,
			{ model: ref.model, messages },
			FEATURE_ERROR_SURFACE[feature],
			{
				// Minted where the number is read: this whole-call bound is the chat request timeout, so timeout advice
				// names chat.timeout.
				timeout: { ms: getRequestTimeout(log), setting: "chat.timeout" },
				token,
				// The feature's own fingerprint, read through the knob that names it: this call is the one place that
				// knows which feature it is sending for.
				sessionIdHeader: featureSessionFingerprintHeader(feature),
			}
		)
	);
}
