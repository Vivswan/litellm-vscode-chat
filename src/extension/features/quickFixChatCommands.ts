/**
 * The quick-fix feature's two chat commands, /fix and /explain, and their
 * registration into the participant's live table.
 *
 * This is the declared cross-feature overlap of the wave: the quick-fix
 * lightbulb's primary path opens the chat view and submits "@litellm /fix
 * ...", which only works if the participant answers those names. The
 * sibling-import ban is per-feature-directory, so a bridge between two features
 * can live in neither of them; the features/ root is where such shared code
 * goes (the gitApi.d.ts and errorLabel.ts precedent), and the composition root
 * (wiring/features.ts) is what calls the registration.
 *
 * Registration is unconditional, unlike the code actions: the commands cost
 * nothing until typed, and a user who turned the lightbulb off has not asked
 * for @litellm to forget how to fix things. What the two commands do is
 * prompt-shaping and nothing more - the same helper the built-in /tests and
 * /docs are built from - so the answer streams from the REQUEST's own model,
 * never the quickFix.model setting, which backs only the fallback path.
 */

import * as l10n from "@vscode/l10n";
import type { SlashCommand, SlashCommandRegistry } from "./participant/slashCommands";
import { promptCommand } from "./participant/slashCommands";

/**
 * The model-facing instructions the two commands prepend, English by policy
 * like every other prompt text. Both ask for markdown rather than a patch: the
 * answer lands in the chat view, where a fenced block is what the user can
 * read, compare, and copy - the participant applies no edits.
 */
export const FIX_INSTRUCTION = [
	"Fix the problem described below in the attached code.",
	"Reply in markdown: name the cause in a sentence, then show the corrected code in a fenced block.",
	"If the diagnostics do not explain the failure, say what else you would need to see.",
].join("\n");

export const EXPLAIN_INSTRUCTION = [
	"Explain the problem described below in the attached code.",
	"Reply in markdown: what the diagnostic means, why it is firing on this code, and how it is usually resolved.",
	"Explain rather than rewrite - show code only where it makes the explanation concrete.",
].join("\n");

/**
 * The two commands, freshly built per call (the built-in table's contract:
 * descriptions resolve through the l10n bundle at call time, and no caller can
 * mutate another's view). The contribution test pins these names and
 * descriptions against package.json, so the "/" picker and the in-chat help
 * listing cannot describe them two ways.
 */
export function quickFixSlashCommands(): SlashCommand[] {
	return [
		promptCommand("fix", l10n.t("Fix the problem in the code you attach or select"), FIX_INSTRUCTION),
		promptCommand("explain", l10n.t("Explain a diagnostic on the code you attach or select"), EXPLAIN_INSTRUCTION),
	];
}

/** Register both into the participant's live table; a duplicate name throws, as it does for any registration. */
export function registerQuickFixSlashCommands(registry: SlashCommandRegistry): void {
	for (const command of quickFixSlashCommands()) {
		registry.register(command);
	}
}
