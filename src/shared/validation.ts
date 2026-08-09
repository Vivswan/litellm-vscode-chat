import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { isToolResultPart } from "./conversion/messages";
import { localizedError } from "./localizedError";

/**
 * English mirror of the tool-pairing headline. The call IDs in the detail
 * originate from earlier model output (response-derived), so the thrown
 * error also carries a count-only logClassification for the public log
 * surfaces; the full mirror rides only as englishMessage (output channel).
 */
const TOOL_PAIRING_HEADLINE_ENGLISH =
	"This conversation is missing a tool result, so the request can't be sent. Start a new chat to continue; if it keeps happening, the extension driving this conversation is dropping tool results when it rebuilds history.";

/** Lazy so the display string resolves through the l10n bundle at throw time, not module load. */
function toolPairingHeadline(): string {
	return l10n.t(
		"This conversation is missing a tool result, so the request can't be sent. Start a new chat to continue; if it keeps happening, the extension driving this conversation is dropping tool results when it rebuilds history."
	);
}

/**
 * Validate the request message sequence for correct tool call/result pairing.
 * Diagnostic detail travels in the thrown error, following the
 * transport-module error-ownership convention (AGENTS.md, "Error ownership").
 */
export function validateRequest(messages: readonly vscode.LanguageModelChatRequestMessage[]): void {
	const lastMessage = messages[messages.length - 1];
	if (!lastMessage) {
		throw localizedError(
			`${l10n.t("Nothing to send - this chat request contained no messages, so nothing was sent to the server.")}\n${l10n.t(
				"Request rejected before send: the message list was empty. No request left the extension; sending again without a message will fail the same way."
			)}`,
			"Nothing to send - this chat request contained no messages, so nothing was sent to the server.\nRequest rejected before send: the message list was empty. No request left the extension; sending again without a message will fail the same way."
		);
	}

	messages.forEach((message, i) => {
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const toolCallIds = new Set(
				message.content
					.filter((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart)
					.map((part) => part.callId)
			);
			if (toolCallIds.size === 0) {
				return;
			}

			let nextMessageIdx = i + 1;
			while (toolCallIds.size > 0) {
				const nextMessage = messages[nextMessageIdx++];
				if (!nextMessage || nextMessage.role !== vscode.LanguageModelChatMessageRole.User) {
					const ids = Array.from(toolCallIds).join(", ");
					throw localizedError(
						`${toolPairingHeadline()}\n${l10n.t("Unpaired tool call IDs: {0}.", ids)}`,
						`${TOOL_PAIRING_HEADLINE_ENGLISH}\nUnpaired tool call IDs: ${ids}.`,
						`ValidationError(unpaired tool calls: ${toolCallIds.size})`
					);
				}

				nextMessage.content.forEach((part) => {
					if (!isToolResultPart(part)) {
						const ctorName =
							(Object.getPrototypeOf(part as object) as { constructor?: { name?: string } } | undefined)?.constructor
								?.name ?? typeof part;
						// The constructor name is caller-controlled text, so it stays out
						// of the classification.
						throw localizedError(
							`${toolPairingHeadline()}\n${l10n.t("Expected a tool result after a tool call, got {0}.", ctorName)}`,
							`${TOOL_PAIRING_HEADLINE_ENGLISH}\nExpected a tool result after a tool call, got ${ctorName}.`,
							"ValidationError(non-tool-result part after tool call)"
						);
					}
					toolCallIds.delete(part.callId);
				});
			}
		}
	});
}
