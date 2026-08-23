/**
 * The followups offered under a finished turn: two at most, never the command
 * the turn just ran, and none at all after a failure - a turn that could not
 * reach the model should not invite two more attempts at the same thing.
 *
 * Pure and vscode-free (the wiring maps these onto vscode.ChatFollowup), so
 * the table and its rules pin in the bun tree. Every `command` here must be
 * one the manifest contributes, or the host routes the click to nothing;
 * followups.test.ts pins that against the contribution rather than trusting
 * this comment.
 */

import * as l10n from "@vscode/l10n";

/** One suggestion, in vscode.ChatFollowup's shape minus the participant field (followups stay with @litellm). */
export interface ParticipantFollowup {
	/** The button's text. */
	readonly label: string;
	/** What lands in the chat input when the user clicks it. */
	readonly prompt: string;
	/** The slash command the followup runs; always a contributed name. */
	readonly command: string;
}

/** How many suggestions a turn may end with: two fit the chat view without crowding the answer. */
const MAX_FOLLOWUPS = 2;

/**
 * The full table, in offer order. Resolved at call time, never as a module
 * constant, because the l10n bundle is configured after module load.
 */
function followupTable(): ParticipantFollowup[] {
	return [
		{ command: "tests", label: l10n.t("Write tests"), prompt: l10n.t("Write tests for the code above.") },
		{ command: "docs", label: l10n.t("Document this"), prompt: l10n.t("Write documentation for the code above.") },
		{
			command: "models",
			label: l10n.t("List my models"),
			prompt: l10n.t("Which models do my LiteLLM servers offer?"),
		},
	];
}

/**
 * The followups for a finished turn. A failed turn offers none; otherwise the
 * table minus the command that just ran, capped at MAX_FOLLOWUPS.
 */
export function participantFollowups(turn: {
	readonly command?: string | undefined;
	readonly failed?: boolean | undefined;
}): ParticipantFollowup[] {
	if (turn.failed === true) {
		return [];
	}
	return followupTable()
		.filter((followup) => followup.command !== turn.command)
		.slice(0, MAX_FOLLOWUPS);
}
