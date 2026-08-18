import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { isToolResultPart, pairToolCallIds, wireIdKey } from "./conversion/toolCallIds";
import { chatErrorMessage, englishChatErrorMessage, localizedError } from "./mirroredError";

/**
 * English mirror of the tool-pairing headline. The call IDs in the detail are
 * response-derived, so the thrown error also carries a count-only
 * logClassification; the full mirror rides only as englishMessage.
 */
const TOOL_PAIRING_HEADLINE_ENGLISH =
	"This conversation is missing a tool result, so the request can't be sent. Start a new chat to continue; if it keeps happening, the extension driving this conversation is dropping tool results when it rebuilds history.";

/** Lazy so the display string resolves through the l10n bundle at throw time, not module load. */
function toolPairingHeadline(): string {
	return l10n.t(
		"This conversation is missing a tool result, so the request can't be sent. Start a new chat to continue; if it keeps happening, the extension driving this conversation is dropping tool results when it rebuilds history."
	);
}

/** English mirror of the broader mismatch headline, for defects beyond a missing result. */
const TOOL_MISMATCH_HEADLINE_ENGLISH =
	"This conversation's tool calls and tool results don't pair up, so the request can't be sent. Start a new chat to continue; if it keeps happening, the extension driving this conversation is rebuilding tool history incorrectly.";

/** Lazy so the display string resolves through the l10n bundle at throw time, not module load. */
function toolMismatchHeadline(): string {
	return l10n.t(
		"This conversation's tool calls and tool results don't pair up, so the request can't be sent. Start a new chat to continue; if it keeps happening, the extension driving this conversation is rebuilding tool history incorrectly."
	);
}

/**
 * Validate the request message sequence for correct tool call/result pairing.
 * Pairing verdicts come from the same pairToolCallIds analysis conversion
 * ships, so a passing request is wire-paired by construction. Diagnostic
 * detail travels in the thrown error, never logged here.
 */
export function validateRequest(messages: readonly vscode.LanguageModelChatRequestMessage[]): void {
	const lastMessage = messages[messages.length - 1];
	if (!lastMessage) {
		throw localizedError(
			chatErrorMessage(
				l10n.t("Nothing to send - this chat request contained no messages, so nothing was sent to the server."),
				l10n.t(
					"Request rejected before send: the message list was empty. No request left the extension; sending again without a message will fail the same way."
				)
			),
			englishChatErrorMessage(
				"Nothing to send - this chat request contained no messages, so nothing was sent to the server.",
				"Request rejected before send: the message list was empty. No request left the extension; sending again without a message will fail the same way."
			)
		);
	}

	const pairing = pairToolCallIds(messages);
	const wireId = (messageIndex: number, partIndex: number, raw: string): string =>
		pairing.wireIds.get(wireIdKey(messageIndex, partIndex)) ?? raw;

	messages.forEach((message, i) => {
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const toolCallIds = new Set<string>();
			message.content.forEach((part, partIndex) => {
				if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCallIds.add(wireId(i, partIndex, part.callId));
				}
			});
			if (toolCallIds.size === 0) {
				return;
			}

			let nextMessageIdx = i + 1;
			while (toolCallIds.size > 0) {
				const nextMessage = messages[nextMessageIdx++];
				if (!nextMessage || nextMessage.role !== vscode.LanguageModelChatMessageRole.User) {
					const ids = Array.from(toolCallIds).join(", ");
					throw localizedError(
						chatErrorMessage(toolPairingHeadline(), l10n.t("Unpaired tool call IDs: {0}.", ids)),
						englishChatErrorMessage(TOOL_PAIRING_HEADLINE_ENGLISH, `Unpaired tool call IDs: ${ids}.`),
						`ValidationError(unpaired tool calls: ${toolCallIds.size})`
					);
				}

				nextMessage.content.forEach((part, partIndex) => {
					if (!isToolResultPart(part)) {
						const ctorName =
							(Object.getPrototypeOf(part as object) as { constructor?: { name?: string } } | undefined)?.constructor
								?.name ?? typeof part;
						// The constructor name is caller-controlled text, so it stays out
						// of the classification.
						throw localizedError(
							chatErrorMessage(
								toolPairingHeadline(),
								l10n.t("Expected a tool result after a tool call, got {0}.", ctorName)
							),
							englishChatErrorMessage(
								TOOL_PAIRING_HEADLINE_ENGLISH,
								`Expected a tool result after a tool call, got ${ctorName}.`
							),
							"ValidationError(non-tool-result part after tool call)"
						);
					}
					toolCallIds.delete(wireId(nextMessageIdx - 1, partIndex, part.callId));
				});
			}
		}
	});

	// The positional walk above gives the sharper errors; these catch what it
	// cannot see (calls outside assistant messages, stray or double results,
	// an id reused while still awaiting its result).
	if (
		pairing.unpairedCallIds.length > 0 ||
		pairing.strayResultIds.length > 0 ||
		pairing.duplicateLiveCallIds.length > 0
	) {
		const details: string[] = [];
		const englishDetails: string[] = [];
		if (pairing.unpairedCallIds.length > 0) {
			const ids = pairing.unpairedCallIds.join(", ");
			details.push(l10n.t("Unpaired tool call IDs: {0}.", ids));
			englishDetails.push(`Unpaired tool call IDs: ${ids}.`);
		}
		if (pairing.strayResultIds.length > 0) {
			const ids = pairing.strayResultIds.join(", ");
			details.push(l10n.t("Tool results with no matching tool call: {0}.", ids));
			englishDetails.push(`Tool results with no matching tool call: ${ids}.`);
		}
		if (pairing.duplicateLiveCallIds.length > 0) {
			const ids = pairing.duplicateLiveCallIds.join(", ");
			details.push(l10n.t("Tool call IDs reused while still awaiting a result: {0}.", ids));
			englishDetails.push(`Tool call IDs reused while still awaiting a result: ${ids}.`);
		}
		throw localizedError(
			chatErrorMessage(toolMismatchHeadline(), details.join(" ")),
			englishChatErrorMessage(TOOL_MISMATCH_HEADLINE_ENGLISH, englishDetails.join(" ")),
			`ValidationError(tool pairing: ${pairing.unpairedCallIds.length} unpaired, ${pairing.strayResultIds.length} stray, ${pairing.duplicateLiveCallIds.length} duplicate)`
		);
	}
}
