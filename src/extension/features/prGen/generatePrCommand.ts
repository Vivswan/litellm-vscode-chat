import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { statusErrorTexts } from "../../../provider/transport/errorMapping";
import type { BooleanSettingId, FeatureModelRef } from "../../../shared/config/settingSpec";
import { CONFIG_SECTION, FEATURE_MODEL_SETTING_KEYS } from "../../../shared/config/settingSpec";
import { getFeatureModelRef, isFeatureEnabled } from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { truncateKeepingHead } from "../../../shared/util/text";
import { commandErrorActions, openSettingsAction, showActionableMessage } from "../../ui/notifier";
import { pickRepository, resolveGitApi } from "../gitAccess";
import type { API } from "../gitApi";
import { collectBranchContext } from "./branchContext";
import { createTitleAndDescriptionProvider } from "./provider";

/**
 * The generate-pull-request-description command surface: repository selection,
 * the local branch walk, progress, and the mapping of the flow's typed
 * outcomes to localized notifications. It is the entry point that does NOT
 * depend on the GitHub Pull Requests extension - the registered provider fills
 * that extension's create view, and this command answers everywhere else by
 * putting the draft on the clipboard.
 *
 * The prompt assembly, the send, and the lenient parse are the same pipeline
 * the registered provider runs (provider.ts); only the context's origin and
 * the delivery differ.
 */

export interface GeneratePrDeps {
	readonly logger: Logger;
	readonly outputChannel: vscode.OutputChannel;
	/**
	 * Where the draft is delivered. Defaults to the system clipboard; injected
	 * because vscode.env.clipboard is read-only and a test cannot replace it.
	 */
	readonly copy?: (text: string) => Thenable<void>;
}

/**
 * The enable key, typed so a rename in BOOLEAN_SETTING_SPECS breaks this
 * compile instead of leaving the hint pointing at a dead setting.
 */
const ENABLED_SETTING_KEY: BooleanSettingId = "prGeneration.enabled";

/** The full setting IDs the command's hints point at. */
const ENABLED_SETTING_ID = `${CONFIG_SECTION}.${ENABLED_SETTING_KEY}`;
const MODEL_SETTING_ID = `${CONFIG_SECTION}.${FEATURE_MODEL_SETTING_KEYS.prGeneration}`;

/**
 * How much of a title the notification renders. The clipboard always receives
 * the whole thing; this only stops a model that ignored the one-line
 * instruction from filling the screen with a toast.
 */
const NOTIFIED_TITLE_LIMIT = 120;

/** The title as a notification renders it: one line, bounded, with the cut marked. */
function notifiedTitle(title: string): string {
	const line = title.split("\n", 1)[0] ?? "";
	return line.length > NOTIFIED_TITLE_LIMIT ? `${truncateKeepingHead(line, NOTIFIED_TITLE_LIMIT)}...` : line;
}

/** What the clipboard receives: the title, then the description under a blank line when there is one. */
export function clipboardText(title: string, description: string | undefined): string {
	return description === undefined ? title : `${title}\n\n${description}`;
}

/**
 * The command handler. Registered unconditionally (the palette hides behind
 * the enable when-clause, but keybindings and executeCommand do not), so a
 * disabled invocation answers with the enable hint instead of doing nothing.
 * `resolveGit` defaults to the live vscode.git extension; tests inject a fake.
 */
export async function runGeneratePrDescription(
	send: (model: FeatureModelRef, prompt: string, token: vscode.CancellationToken) => Promise<string>,
	deps: GeneratePrDeps,
	commandArg: unknown,
	resolveGit: () => Promise<API | undefined> = resolveGitApi
): Promise<void> {
	if (!isFeatureEnabled("prGeneration")) {
		await showActionableMessage(
			"info",
			l10n.t('Pull request description generation is off. Enable "{0}" in settings to use it.', ENABLED_SETTING_ID),
			[openSettingsAction(ENABLED_SETTING_ID)]
		);
		return;
	}
	const log = (message: string, data?: unknown): void => {
		deps.logger.log(message, data);
	};
	try {
		// Inside the boundary: activating another extension can reject, and that
		// failure belongs in this command's one logging boundary like any other.
		const git = await resolveGit();
		if (git === undefined) {
			await showActionableMessage(
				"warning",
				l10n.t("The built-in Git extension is unavailable, so there is no branch to describe."),
				[]
			);
			return;
		}
		const repo = await pickRepository(git, commandArg, {
			title: l10n.t("Generate Pull Request Description"),
			placeHolder: l10n.t("Pick the repository whose branch to describe"),
		});
		if (repo === "dismissed") {
			return;
		}
		if (repo === undefined) {
			await showActionableMessage(
				"info",
				l10n.t("Open a folder with a Git repository to generate a pull request description."),
				[]
			);
			return;
		}
		const modelRef = getFeatureModelRef("prGeneration", log);
		if (modelRef === undefined) {
			await showActionableMessage(
				"warning",
				l10n.t(
					'No model is configured for pull request description generation. Pick one via the "{0}" setting or the LiteLLM dashboard.',
					MODEL_SETTING_ID
				),
				[openSettingsAction(MODEL_SETTING_ID)]
			);
			return;
		}
		const outcome = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: l10n.t("Generating pull request description..."),
				cancellable: true,
			},
			async (_progress, token) => {
				const collected = await collectBranchContext(repo, token);
				if (collected.kind !== "collected") {
					return collected;
				}
				// The same provider the GitHub extension calls, so both entry
				// points share one prompt, one send, and one parse.
				const provider = createTitleAndDescriptionProvider((prompt, cancellation) =>
					send(modelRef, prompt, cancellation)
				);
				const result = await provider.provideTitleAndDescription(collected.context, token);
				return result === undefined ? ({ kind: "noAnswer" } as const) : ({ kind: "generated", result } as const);
			}
		);
		switch (outcome.kind) {
			case "generated": {
				const copy = deps.copy ?? ((text: string) => vscode.env.clipboard.writeText(text));
				await copy(clipboardText(outcome.result.title, outcome.result.description));
				await showActionableMessage(
					"info",
					outcome.result.description === undefined
						? l10n.t('Copied "{0}" to the clipboard.', notifiedTitle(outcome.result.title))
						: l10n.t('Copied "{0}" and its description to the clipboard.', notifiedTitle(outcome.result.title)),
					[]
				);
				return;
			}
			case "noBranch":
				await showActionableMessage(
					"info",
					l10n.t("This repository has no checked-out branch, so there is nothing to describe."),
					[]
				);
				return;
			case "noBase":
				await showActionableMessage(
					"info",
					l10n.t(
						"No base branch could be resolved for this branch. Set its upstream (or push it) so VS Code can tell which branch it would be merged into."
					),
					[]
				);
				return;
			case "noChanges":
				await showActionableMessage(
					"info",
					l10n.t("This branch has no commits or file changes over its base branch."),
					[]
				);
				return;
			case "selfCompare":
				await showActionableMessage(
					"info",
					l10n.t(
						"This branch is compared against itself, so there is nothing to describe. Check out the branch whose pull request you want written."
					),
					[]
				);
				return;
			case "cancelled":
				// The walk stopped on the user's cancel; nothing was sent and
				// nothing is worth saying.
				return;
			case "noAnswer":
				await showActionableMessage(
					"warning",
					l10n.t("The model did not return a usable pull request title. Try again, or pick a different model."),
					[]
				);
				return;
			default: {
				// Exhaustive by construction: a new outcome must bring its advice
				// here rather than silently showing the user nothing. Only the
				// DISCRIMINANT is named - this throw lands in the catch below, which
				// logs, and an outcome's payload carries branch names, commit
				// messages and patches that must never reach a public issue report.
				const unhandled: never = outcome;
				throw new Error(`unhandled PR generation outcome: ${(unhandled as { kind: string }).kind}`);
			}
		}
	} catch (error) {
		if (error instanceof vscode.CancellationError) {
			// User cancellation: never logged, nothing to show.
			return;
		}
		// The single logging boundary for this command; the logger records the
		// English mirror or classification the thrown error carries.
		deps.logger.error("Pull request description generation failed", error);
		const texts = statusErrorTexts(error);
		await showActionableMessage("error", texts.error, commandErrorActions(texts.classification, deps.outputChannel));
	}
}
