/**
 * The LiteLLM session id of a chat request, read off the editor: the window, the open folder, and the conversation the
 * provider is about to send.
 */
import * as vscode from "vscode";
import { resolveSessionIdHeader, type SessionIdContext, type SessionIdMessage } from "../../shared/config/sessionId";
import { getChatSessionIdMode } from "../../shared/config/settings";
import { mapRole } from "../../shared/conversion/messages";
import type { HeaderValue } from "../../shared/util/headers";

/** The editor identity the folder and window session ids are derived from. */
function sessionIdContext(): SessionIdContext {
	return {
		windowSessionId: vscode.env.sessionId,
		// The first open folder, so a multi-root workspace still resolves to one folder's session.
		folderPath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
	};
}

/**
 * The conversation, reduced to what the chat rule reads.
 *
 *   Taken before the wire conversion, so the conversion's own synthetic turn - the one it writes ahead of a real
 *     question when a tool result carries an image - can never be the session's source.
 */
function sessionIdMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): SessionIdMessage[] {
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
		return { role: mapRole(message), text, data };
	});
}

/** The session id header for a chat request, or nothing when the setting is off. */
export function chatSessionIdHeader(
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): HeaderValue | undefined {
	const mode = getChatSessionIdMode();
	if (mode === "off") {
		return undefined;
	}
	return resolveSessionIdHeader({ mode, context: sessionIdContext(), messages: sessionIdMessages(messages) });
}
