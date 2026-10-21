import * as vscode from "vscode";
import {
	resolveSessionFingerprintHeader,
	type SessionFingerprintContext,
	type SessionFingerprintMessage,
} from "../../shared/config/sessionFingerprint";
import type { FeatureModelId } from "../../shared/config/settingSpec";
import {
	getChatSessionFingerprint,
	getChatSessionFingerprintStrategy,
	getFeatureSessionFingerprint,
} from "../../shared/config/settings";
import type { HeaderValue } from "../../shared/util/headers";

/**
 * The session fingerprint of a request: the LiteLLM session id it carries, so the proxy's session view groups the
 * requests of one chat, one folder, or one editor session together.
 *
 *   The two surfaces read different sources: the chat path derives a chat's own fingerprint from the conversation it is
 *     about to send, and a one-shot feature's fingerprint from its own knob, which the feature's send composition
 *     already knows the name of.
 */

/** The editor identity the workspace and window fingerprints are derived from. */
function fingerprintContext(): SessionFingerprintContext {
	return {
		windowSessionId: vscode.env.sessionId,
		// The first open folder, so a multi-root workspace still resolves to one folder's fingerprint.
		workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
	};
}

function messageRole(message: vscode.LanguageModelChatRequestMessage): SessionFingerprintMessage["role"] {
	if (message.role === vscode.LanguageModelChatMessageRole.User) {
		return "user";
	}
	if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
		return "assistant";
	}
	// VS Code sends role 3 for system messages via a proposed API; the stable enum has no System member.
	return "system";
}

/**
 * The conversation, reduced to what the fingerprint rules read.
 *
 *   Taken before the wire conversion, so the conversion's own synthetic turn - the one it writes ahead of a real
 *     question when a tool result carries an image - can never be the fingerprint.
 */
function fingerprintMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): SessionFingerprintMessage[] {
	return messages.map((message) => {
		let text = "";
		const data: Uint8Array[] = [];
		for (const part of message.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
			} else if (part instanceof vscode.LanguageModelDataPart) {
				data.push(part.data);
			}
		}
		return { role: messageRole(message), text, data };
	});
}

/**
 * The session id header for a chat request: the chat's own fingerprint, or nothing when the chat knob is off.
 */
export function chatSessionFingerprintHeader(
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): HeaderValue | undefined {
	const value = getChatSessionFingerprint();
	if (value === "off") {
		return undefined;
	}
	return resolveSessionFingerprintHeader({
		value,
		strategy: getChatSessionFingerprintStrategy(),
		context: fingerprintContext(),
		messages: fingerprintMessages(messages),
	});
}

/**
 * The session id header for a one-shot feature's request: the feature's own fingerprint, or nothing when its knob is
 * off.
 */
export function featureSessionFingerprintHeader(feature: FeatureModelId): HeaderValue | undefined {
	const value = getFeatureSessionFingerprint(feature);
	if (value === "off") {
		return undefined;
	}
	return resolveSessionFingerprintHeader({ value, context: fingerprintContext() });
}
