import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import type { BooleanSettingId } from "../../../shared/config/settingSpec";
import { CONFIG_SECTION, FEATURE_MODEL_SETTING_KEYS } from "../../../shared/config/settingSpec";
import { getCommitGenerationPrompt, getFeatureModelRef, isFeatureEnabled } from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { openSettingsAction, showActionableMessage } from "../../ui/notifier";
import { reportCommandFailure } from "../commandFailure";
import { featureChatSend } from "../featureChatSend";
import { pickRepository, resolveGitApi } from "../gitAccess";
import type { API } from "../gitApi";
import type { CommitModelRef } from "./commitMessage";
import { generateCommitMessage } from "./commitMessage";

/**
 * The generate-commit-message command surface: git repo selection, progress,
 * connection resolution, and the mapping of the core flow's typed outcomes to
 * localized notifications. The pure flow itself lives in commitMessage.ts; the
 * one-shot transport in provider/transport/oneShotClient.ts.
 */

export interface GenerateCommitDeps {
	readonly secrets: vscode.SecretStorage;
	readonly logger: Logger;
	readonly outputChannel: vscode.OutputChannel;
}

/**
 * The enable key, typed so a rename in BOOLEAN_SETTING_SPECS breaks this
 * compile instead of leaving the hint pointing at a dead setting.
 */
const ENABLED_SETTING_KEY: BooleanSettingId = "commitGeneration.enabled";

/** The full setting IDs the command's hints point at. */
const ENABLED_SETTING_ID = `${CONFIG_SECTION}.${ENABLED_SETTING_KEY}`;
const MODEL_SETTING_ID = `${CONFIG_SECTION}.${FEATURE_MODEL_SETTING_KEYS.commitGeneration}`;

/**
 * Send the prompt as one non-streaming request through the features' shared
 * send composition (featureChatSend: connection resolution, the
 * commitGeneration error surface, the chat timeout). Exported because the
 * dashboard's test probe sends through it too, so the probe proves exactly
 * what a generation would do - connection, credentials, surface, and bound
 * included.
 */
export async function sendCommitPrompt(
	oneShot: OneShotClient,
	secrets: vscode.SecretStorage,
	ref: CommitModelRef,
	prompt: string,
	token: vscode.CancellationToken,
	log: (message: string, data?: unknown) => void
): Promise<string> {
	return featureChatSend(
		"commitGeneration",
		{ oneShot, secrets },
		ref,
		[{ role: "user", content: prompt }],
		token,
		log
	);
}

/**
 * The command handler. Registered unconditionally (the menus hide behind the
 * enable when-clause, but keybindings and executeCommand do not), so a
 * disabled invocation answers with the enable hint instead of doing nothing.
 * `resolveGit` defaults to the live vscode.git extension; tests inject a fake.
 */
export async function runGenerateCommitMessage(
	oneShot: OneShotClient,
	deps: GenerateCommitDeps,
	commandArg: unknown,
	resolveGit: () => Promise<API | undefined> = resolveGitApi
): Promise<void> {
	if (!isFeatureEnabled("commitGeneration")) {
		await showActionableMessage(
			"info",
			l10n.t('Commit message generation is off. Enable "{0}" in settings to use it.', ENABLED_SETTING_ID),
			[openSettingsAction(ENABLED_SETTING_ID)]
		);
		return;
	}
	const git = await resolveGit();
	if (git === undefined) {
		await showActionableMessage(
			"warning",
			l10n.t("The built-in Git extension is unavailable, so there is no repository to describe."),
			[]
		);
		return;
	}
	const repo = await pickRepository(git, commandArg, {
		title: l10n.t("Generate Commit Message"),
		placeHolder: l10n.t("Pick the repository to describe"),
	});
	if (repo === "dismissed") {
		return;
	}
	if (repo === undefined) {
		await showActionableMessage(
			"info",
			l10n.t("Open a folder with a Git repository to generate a commit message."),
			[]
		);
		return;
	}
	const log = (message: string, data?: unknown): void => {
		deps.logger.log(message, data);
	};
	const reader = {
		modelRef: () => getFeatureModelRef("commitGeneration", log),
		prompt: getCommitGenerationPrompt,
	};
	try {
		const outcome = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: l10n.t("Generating commit message..."),
				cancellable: true,
			},
			(_progress, token) =>
				generateCommitMessage(repo, reader, (ref, prompt) =>
					sendCommitPrompt(oneShot, deps.secrets, ref, prompt, token, log)
				)
		);
		switch (outcome.kind) {
			case "generated":
				repo.inputBox.value = outcome.message;
				await vscode.commands.executeCommand("workbench.view.scm");
				return;
			case "noModel":
				await showActionableMessage(
					"warning",
					l10n.t(
						'No model is configured for commit message generation. Pick one via the "{0}" setting or the LiteLLM dashboard.',
						MODEL_SETTING_ID
					),
					[openSettingsAction(MODEL_SETTING_ID)]
				);
				return;
			case "noChanges":
				await showActionableMessage("info", l10n.t("There are no changes to describe."), []);
				return;
			case "emptyResult":
				await showActionableMessage(
					"warning",
					l10n.t("The model returned an empty commit message. Try again, or adjust the commit prompt setting."),
					[]
				);
				return;
		}
	} catch (error) {
		await reportCommandFailure(deps, error, "Commit message generation failed");
	}
}
