import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import type { FeatureModelRef } from "../../../shared/config/settingSpec";
import { getFeatureModelRef, isFeatureEnabled } from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { errorLabel } from "../../../shared/util/errorLabel";
import type { MessageAction } from "../../ui/notifier";
import { openSettingsAction, showActionableMessage } from "../../ui/notifier";
import { reportCommandFailure } from "../commandFailure";
import { featureChatSend } from "../featureChatSend";
import { featureDisabledMessage, featureEnableSettingId, featureModelSettingId } from "../featureGate";
import { documentLabel } from "../gitAccess";
import type { QuickFixChatArgs } from "./actionsProvider";
import type { QuickFixMode } from "./query";
import { buildChatQuery, buildFallbackPrompt, selectDiagnostics } from "./query";

/**
 * What an invoked Fix or Explain action does. The primary path is the chat
 * view: the action opens it and SUBMITS "@litellm /fix ..." with the claimed
 * lines attached, so the answer streams into the conversation the user already
 * knows, under the model their picker says, with the whole participant
 * (history, followups, further questions) around it.
 *
 * The fallback exists because that path is not ours: chat.open is another
 * extension's command, and Copilot Chat can be absent, disabled, or refusing.
 * When it fails, the same question goes to the quickFix.model setting as one
 * non-streaming request and the answer opens as an untitled markdown editor.
 * That is a deliberately lesser experience for a case that should be rare - it
 * costs the user nothing to close, and it is the difference between a broken
 * lightbulb and a working one.
 *
 * This module is the quick-fix feature's SINGLE logging boundary (the one-shot
 * caller convention): the transport throws classified and unlogged, and every
 * failure is recorded exactly once here.
 */

/** The full setting IDs the dual-reason advice names, derived by the shared gate; sentences stay this feature's own. */
const MODEL_SETTING_ID = featureModelSettingId("quickFix");
const PARTICIPANT_SETTING_ID = featureEnableSettingId("chatParticipant");

export interface QuickFixChatDeps {
	readonly secrets: vscode.SecretStorage;
	readonly logger: Logger;
	readonly outputChannel: vscode.OutputChannel;
	/**
	 * Whether the @litellm participant can actually answer a turn right now.
	 * The chat path submits a turn addressed to it, so this is the difference
	 * between asking our participant and shouting our prefix at whoever is
	 * listening; the participant's wiring owns the answer (setting AND accepted
	 * registration), and this reads it per invocation.
	 */
	readonly isParticipantAvailable: () => boolean;
	/**
	 * Opens the chat view and submits the query. Injected so the tests can drive
	 * the failure the fallback exists for; defaults to the host command, which
	 * is contributed by whichever chat extension is installed.
	 */
	readonly openChat?: (query: string, uri: vscode.Uri, range: vscode.Range) => Thenable<unknown>;
}

/**
 * The host command the primary path runs, with the claimed lines riding as an
 * attachment. The payload shape is the host's `IChatViewOpenOptions`:
 * `attachFiles` takes `URI | { uri, range }`, and the extension-host command
 * bridge converts the `vscode.Range` to the internal 1-based shape on the way
 * across - so a `vscode.Location` or a bare Uri here would NOT be equivalent.
 * The command is another extension's and experimental; every failure mode it
 * has is what the fallback below exists for.
 */
function openChatView(query: string, uri: vscode.Uri, range: vscode.Range): Thenable<unknown> {
	return vscode.commands.executeCommand("workbench.action.chat.open", {
		query,
		attachFiles: [{ uri, range }],
	});
}

function isMode(value: unknown): value is QuickFixMode {
	return value === "fix" || value === "explain";
}

/**
 * One diagnostic, structurally: every field the query and prompt builders read,
 * `source` and `code` included. Checked element by element rather than trusted
 * as an array, so a forged `{ diagnostics: [null] }` - or a plausible-looking
 * one carrying `source: 5` - is refused at the boundary instead of throwing
 * inside a builder. The builders take a typed precondition; this is what keeps
 * it. Shape-gating, not just crash-prevention: a value outside the host's own
 * vocabulary came from something other than a lightbulb, and refusing it costs
 * a real diagnostic nothing.
 */
function isDiagnosticLike(value: unknown): value is vscode.Diagnostic {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const { message, range, severity, source, code } = value as Partial<vscode.Diagnostic>;
	if (typeof message !== "string" || !(range instanceof vscode.Range) || typeof severity !== "number") {
		return false;
	}
	if (source !== undefined && typeof source !== "string") {
		return false;
	}
	return isDiagnosticCode(code);
}

/** The host's `code` vocabulary, plus the null third-party providers ship despite the typing. */
function isDiagnosticCode(code: unknown): boolean {
	if (code === undefined || code === null || typeof code === "string" || typeof code === "number") {
		return true;
	}
	if (typeof code !== "object") {
		return false;
	}
	const { value } = code as { value?: unknown };
	return typeof value === "string" || typeof value === "number";
}

/**
 * The command's payload, validated rather than trusted: the lightbulb is the
 * only surface that builds one, but executeCommand is callable by anything and
 * a malformed payload must be a no-op with a log line, never a crash inside a
 * command handler.
 */
function parseArgs(raw: unknown): QuickFixChatArgs | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const { uri, range, diagnostics, mode } = raw as Partial<QuickFixChatArgs>;
	if (!(uri instanceof vscode.Uri) || !(range instanceof vscode.Range) || !isMode(mode)) {
		return undefined;
	}
	if (!Array.isArray(diagnostics) || !diagnostics.every(isDiagnosticLike)) {
		return undefined;
	}
	// An invocation claiming nothing usable has no question to ask: the chat
	// path would submit a bare "@litellm /fix", and the fallback would spend the
	// user's budget on an empty one. Selection is the same decision the
	// lightbulb made, so this is unreachable from an action.
	return selectDiagnostics(diagnostics).length === 0 ? undefined : { uri, range, diagnostics, mode };
}

/**
 * Send the prompt as one non-streaming request through the features' shared
 * send composition (featureChatSend: connection resolution, the quickFix error
 * surface, the chat timeout). Exported because the dashboard's test probe
 * sends through it too, so the probe proves exactly what the fallback would do
 * - connection, credentials, surface, and bound included.
 */
export async function sendFallbackPrompt(
	oneShot: OneShotClient,
	secrets: vscode.SecretStorage,
	ref: FeatureModelRef,
	prompt: string,
	token: vscode.CancellationToken,
	log: (message: string, data?: unknown) => void
): Promise<string> {
	return featureChatSend("quickFix", { oneShot, secrets }, ref, [{ role: "user", content: prompt }], token, log);
}

/**
 * The fallback prompt for one invocation: the claimed lines read from the
 * document (the workspace read serves the dirty buffer, so the model sees what
 * the user is looking at rather than what is on disk) around the diagnostics
 * the action claimed.
 */
async function fallbackPromptFor(args: QuickFixChatArgs): Promise<string> {
	const document = await vscode.workspace.openTextDocument(args.uri);
	return buildFallbackPrompt({
		mode: args.mode,
		// The shared label pipeline (gitAccess.documentLabel): the raw host API
		// would ship the absolute path - home directory and user name - for any
		// file outside the workspace.
		path: documentLabel(args.uri),
		languageId: document.languageId,
		excerpt: document.getText(args.range),
		diagnostics: args.diagnostics,
	});
}

/** The answer as its own untitled markdown editor: nothing is written to the user's file, ever. */
async function showAnswer(answer: string): Promise<void> {
	const document = await vscode.workspace.openTextDocument({ content: answer, language: "markdown" });
	await vscode.window.showTextDocument(document, { preview: false });
}

/**
 * Why the fallback is running. It decides only the no-model advice, but that
 * advice is the difference between sending the user to a setting that is
 * already fine and telling them the thing they turned off is the thing that
 * would have answered.
 */
type FallbackReason = "participant-unavailable" | "chat-open-failed";

/**
 * The no-model message and its actions, per reason. The participant branch does
 * not claim WHICH half is missing: the readiness predicate answers one
 * question - can @litellm answer - and a message asserting the setting is off
 * would be wrong for the user whose registration was refused with the setting
 * on. It names both places instead, and buttons to both, in the order they are
 * worth trying.
 */
function noModelAdvice(reason: FallbackReason): { message: string; actions: MessageAction[] } {
	if (reason === "participant-unavailable") {
		return {
			message: l10n.t(
				'The @litellm chat participant is not available - it may be turned off, or the editor may have refused to register it - and no model is configured to answer without it. Check "{0}", or pick a model via the "{1}" setting or the LiteLLM dashboard.',
				PARTICIPANT_SETTING_ID,
				MODEL_SETTING_ID
			),
			actions: [
				openSettingsAction(PARTICIPANT_SETTING_ID, l10n.t("Open Participant Setting")),
				openSettingsAction(MODEL_SETTING_ID, l10n.t("Open Model Setting")),
			],
		};
	}
	return {
		message: l10n.t(
			'The chat view could not be opened, and no model is configured to answer without it. Pick one via the "{0}" setting or the LiteLLM dashboard.',
			MODEL_SETTING_ID
		),
		actions: [openSettingsAction(MODEL_SETTING_ID)],
	};
}

/**
 * The fallback path. Both gates are re-read here rather than assumed from the
 * lightbulb: this runs after an await on another extension's command, and a
 * user who turned the feature off while that command was failing has said what
 * they want. Answering nothing is right in that case - they just disabled the
 * thing that would have answered.
 */
async function runFallback(
	oneShot: OneShotClient,
	deps: QuickFixChatDeps,
	args: QuickFixChatArgs,
	reason: FallbackReason,
	log: (message: string, data?: unknown) => void
): Promise<void> {
	if (!isFeatureEnabled("quickFix")) {
		log("quick fix fallback skipped: the feature was disabled while the chat view was failing");
		return;
	}
	const ref = getFeatureModelRef("quickFix", log);
	if (ref === undefined) {
		const advice = noModelAdvice(reason);
		await showActionableMessage("warning", advice.message, advice.actions);
		return;
	}
	const answer = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title:
				args.mode === "fix" ? l10n.t("Asking LiteLLM for a fix...") : l10n.t("Asking LiteLLM for an explanation..."),
			cancellable: true,
		},
		async (_progress, token) => {
			const prompt = await fallbackPromptFor(args);
			return sendFallbackPrompt(oneShot, deps.secrets, ref, prompt, token, log);
		}
	);
	if (answer.trim() === "") {
		await showActionableMessage("warning", l10n.t("The model returned an empty answer. Try again."), []);
		return;
	}
	await showAnswer(answer);
}

/**
 * The command handler behind every Fix and Explain action. Registered
 * unconditionally - the lightbulb hides behind the enable setting, but
 * executeCommand and keybindings do not - so a disabled invocation answers
 * with the enable hint instead of doing nothing.
 */
export async function runQuickFixChat(oneShot: OneShotClient, deps: QuickFixChatDeps, rawArgs: unknown): Promise<void> {
	const log = (message: string, data?: unknown): void => {
		deps.logger.log(message, data);
	};
	const args = parseArgs(rawArgs);
	if (args === undefined) {
		log("quick fix invoked without a usable payload; ignoring");
		return;
	}
	if (!isFeatureEnabled("quickFix")) {
		await showActionableMessage("info", featureDisabledMessage("quickFix"), [
			openSettingsAction(featureEnableSettingId("quickFix")),
		]);
		return;
	}
	// The chat path is only worth taking while @litellm can actually answer.
	// chat.open SUBMITS the query rather than typing it, so with no live
	// participant behind the name the turn - diagnostics and attached code -
	// goes out addressed to something that is not there, and the command
	// RESOLVES either way, which is why no try/catch could notice. The
	// participant's own wiring is the one place that knows both halves (the
	// setting said yes AND the host accepted the registration).
	let reason: FallbackReason = "chat-open-failed";
	if (deps.isParticipantAvailable()) {
		try {
			await (deps.openChat ?? openChatView)(buildChatQuery(args.mode, args.diagnostics), args.uri, args.range);
			return;
		} catch (error) {
			// Classification only: the failure comes from another extension's command
			// and its message is not ours to quote onto a public log surface.
			log(`quick fix could not open the chat view, falling back to the configured model: ${errorLabel(error)}`);
		}
	} else {
		reason = "participant-unavailable";
		log("quick fix took the fallback path: the @litellm participant is unavailable, so the chat view cannot answer");
	}
	try {
		await runFallback(oneShot, deps, args, reason, log);
	} catch (error) {
		await reportCommandFailure(deps, error, "Quick fix fallback failed");
	}
}
