import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import { getCommitGenerationPrompt, getFeatureModelRef, isFeatureEnabled } from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { openSettingsAction, showActionableMessage } from "../../ui/notifier";
import { reportCommandFailure } from "../commandFailure";
import { featureChatSend } from "../featureChatSend";
import {
	featureDisabledMessage,
	featureEnableSettingId,
	featureModelSettingId,
	featureNoModelMessage,
} from "../featureGate";
import { pickRepository, resolveGitApi } from "../gitAccess";
import type { API } from "../gitApi";
import type { CommitModelRef } from "./commitMessage";
import { generateCommitMessage } from "./commitMessage";

export interface GenerateCommitDeps {
	readonly secrets: vscode.SecretStorage;
	readonly logger: Logger;
	readonly outputChannel: vscode.OutputChannel;
}

/**
 * Exported because the dashboard's test probe sends through it too, so the probe proves exactly what a generation
 * would do - connection, credentials, surface, and bound included.
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
 * Registered unconditionally (the menus hide behind the enable when-clause, but keybindings and executeCommand do
 * not), so a disabled invocation answers with the enable hint instead of doing nothing.
 */
export async function runGenerateCommitMessage(
	oneShot: OneShotClient,
	deps: GenerateCommitDeps,
	commandArg: unknown,
	resolveGit: () => Promise<API | undefined> = resolveGitApi
): Promise<void> {
	if (!isFeatureEnabled("commitGeneration")) {
		await showActionableMessage("info", featureDisabledMessage("commitGeneration"), [
			openSettingsAction(featureEnableSettingId("commitGeneration")),
		]);
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
				await showActionableMessage("warning", featureNoModelMessage("commitGeneration"), [
					openSettingsAction(featureModelSettingId("commitGeneration")),
				]);
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
