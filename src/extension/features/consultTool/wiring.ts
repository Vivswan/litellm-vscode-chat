import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import { CONSULT_TOOL_READY_CONTEXT_KEY, TOOL_NAME } from "../../../shared/config/commandIds";
import type { BooleanSettingId, FeatureModelRef } from "../../../shared/config/settingSpec";
import { CONFIG_SECTION, FEATURE_MODEL_SETTING_KEYS } from "../../../shared/config/settingSpec";
import { getFeatureModelRef, getRequestTimeout, isFeatureEnabled } from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { localizedError } from "../../../shared/mirroredError";
import { entryConnectionFor } from "../../servers/entryConnection";
import { noEntryForConfiguredServer } from "../modelSettingError";
import type { ConsultTokenizationOptions, ConsultToolInput } from "./invocation";
import {
	EMPTY_REPLY_TEXT,
	fitConsultPrompt,
	fitConsultReply,
	readConsultInput,
	shapeConsultResult,
} from "./invocation";

/**
 * Consult tool wiring: the language-model tool a chat agent calls to ask a
 * second, independently configured LiteLLM model. Opt-in by construction and
 * fail-closed on BOTH halves - the tool registers only while
 * consultTool.enabled is on AND consultTool.model names a pair, so an agent is
 * never offered a tool whose every call could only answer "nothing is
 * configured" - and a configuration watcher disposes and re-registers as those
 * two change. `oneShot` is the activation-shared client, so OAuth tokens cache
 * across consultations and across features and invalidate on 401 like the chat
 * and usage paths.
 *
 * This module is the feature's single logging boundary (the one-shot caller
 * convention): the transport throws classified errors without logging, the
 * invoke boundary logs once, and the error itself travels on to the chat view
 * that invoked the tool. Cancellation is never logged.
 */

type LogFn = (message: string, data?: unknown) => void;

/**
 * The enable key, typed so a rename in BOOLEAN_SETTING_SPECS breaks this
 * compile instead of leaving the advice pointing at a dead setting.
 */
const ENABLED_SETTING_KEY: BooleanSettingId = "consultTool.enabled";

/** The full setting IDs the tool's advice points at. */
const ENABLED_SETTING_ID = `${CONFIG_SECTION}.${ENABLED_SETTING_KEY}`;
const MODEL_SETTING_ID = `${CONFIG_SECTION}.${FEATURE_MODEL_SETTING_KEYS.consultTool}`;

/**
 * One consultation, from the caller's input to the consulted model's reply
 * text. The tool and the dashboard's probe both go through this, so the probe
 * proves exactly what an agent's call would do - connection resolution, prompt
 * assembly, the outgoing bound, and the wire body included.
 */
export type ConsultSend = (request: {
	readonly modelRef: FeatureModelRef;
	readonly input: ConsultToolInput;
	readonly token: vscode.CancellationToken;
}) => Promise<string>;

/**
 * The outgoing prompt's own bound, in UTF-16 code units, fixed in code like
 * the sibling one-shot features' input limits (commit generation's
 * DIFF_CHAR_LIMIT, inline completions' context window). It exists so a runaway
 * agent cannot POST an unbounded body; it is deliberately NOT the host's
 * `tokenBudget`, which governs what the tool RETURNS - see fitConsultReply.
 * Generous enough that a real question with its code context passes untouched.
 */
export const CONSULT_PROMPT_CHAR_LIMIT = 60_000;

/**
 * The prompt bound as the core's fitting machinery consumes it: one "token"
 * per code unit, so the same measured bisection that fits a token budget fits
 * this character budget, with no second truncation pipeline.
 */
const PROMPT_BUDGET: ConsultTokenizationOptions = {
	tokenBudget: CONSULT_PROMPT_CHAR_LIMIT,
	countTokens: (text) => Promise.resolve(text.length),
};

/**
 * The host's tokenization options as the core consumes them, with the call's
 * cancellation token bound into the counter: the core awaits one count at a
 * time, so cancelling mid-fit rejects out of the counter instead of running
 * the whole bisection first. Undefined when the caller advertised no budget -
 * an unknown budget must not become a guessed one, so the reply then travels
 * whole.
 */
function boundTokenization(
	options: vscode.LanguageModelToolTokenizationOptions | undefined,
	token: vscode.CancellationToken
): ConsultTokenizationOptions | undefined {
	return options === undefined
		? undefined
		: { tokenBudget: options.tokenBudget, countTokens: (text) => options.countTokens(text, token) };
}

/**
 * The one consultation pipeline: label-to-connection through the shared
 * entryConnectionFor, the core's prompt assembly under the fixed outgoing
 * bound, and one non-streaming /chat/completions call under the consultTool
 * error surface. models.parameters records deliberately do NOT apply here -
 * like the other one-shot feature paths, the body is exactly what
 * OneShotChatRequest declares, and no max_tokens rides along, so the consulted
 * model's own default bounds the answer.
 */
function createConsultSend(secrets: vscode.SecretStorage, oneShot: OneShotClient, log: LogFn): ConsultSend {
	return async ({ modelRef, input, token }) => {
		const resolved = await entryConnectionFor(secrets, modelRef.server);
		if (resolved === undefined) {
			throw noEntryForConfiguredServer("consultTool", modelRef.server);
		}
		const fit = await fitConsultPrompt(input, PROMPT_BUDGET);
		if (fit.contextTruncated || fit.questionTruncated) {
			// A classification, never the question or the context text.
			log("Consult tool: the question and context exceeded the outgoing prompt limit and were cut");
		}
		return oneShot.completeChatOnce(
			resolved.connection,
			{ model: modelRef.model, messages: [{ role: "user", content: fit.prompt }] },
			"consultTool",
			{ timeoutMs: getRequestTimeout(log), token }
		);
	};
}

/**
 * The dashboard's test-model probe question. Model-facing text, so it stays
 * English by policy, and it carries nothing of the user's - no file, no
 * selection, no chat history.
 */
export const PROBE_QUESTION = "Reply with one short sentence confirming that you received this question.";

/**
 * The probe: the shared send over that fixed question, so it proves exactly
 * what an agent's consultation would do. Unbudgeted, like any caller that
 * supplies no tokenization options, and it applies the tool's own emptiness
 * rule so the dashboard's "answered with no text" copy fires on exactly the
 * replies the tool would call empty.
 */
export function createConsultProbe(send: ConsultSend): (model: FeatureModelRef) => Promise<string | undefined> {
	return async (model) => {
		// The source exists only to satisfy the send's token seam (the chat
		// timeout bounds the call); dispose it deterministically so probes cannot
		// accumulate live sources across dashboard sessions.
		const source = new vscode.CancellationTokenSource();
		try {
			const shaped = shapeConsultResult(
				await send({ modelRef: model, input: { question: PROBE_QUESTION }, token: source.token })
			);
			return shaped.value === EMPTY_REPLY_TEXT ? "" : shaped.value;
		} finally {
			source.dispose();
		}
	};
}

/**
 * The tool itself. Read-only by contract - it asks a model a question and
 * returns text - so prepareInvocation contributes a progress message and NO
 * confirmationMessages: confirmation is for tools with side effects, and one
 * here would interrupt every agent turn for nothing.
 */
class ConsultTool implements vscode.LanguageModelTool<ConsultToolInput> {
	constructor(
		private readonly send: ConsultSend,
		private readonly logger: Logger
	) {}

	private log: LogFn = (message, data) => {
		this.logger.log(message, data);
	};

	/**
	 * Free of side effects and not necessarily followed by an invoke: it only
	 * reads the configured model to name it. The model ID is user
	 * configuration, safe to render; the caller's question is not, since a
	 * progress line is no place for an agent-written prompt.
	 */
	prepareInvocation(): vscode.PreparedToolInvocation {
		const ref = getFeatureModelRef("consultTool");
		return {
			invocationMessage:
				ref === undefined ? l10n.t("Consulting another model...") : l10n.t('Consulting "{0}"...', ref.model),
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ConsultToolInput>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		// Registration already gates on both halves, but a configuration change
		// races an in-flight agent turn: the tool answers the live settings, not
		// the ones it happened to be registered under.
		if (!isFeatureEnabled("consultTool")) {
			throw localizedError(
				l10n.t('The consult tool is off. Enable "{0}" in settings to use it.', ENABLED_SETTING_ID),
				`The consult tool is off. Enable "${ENABLED_SETTING_ID}" in settings to use it.`,
				"ConsultTool(disabled)"
			);
		}
		const ref = getFeatureModelRef("consultTool", this.log);
		if (ref === undefined) {
			throw localizedError(
				l10n.t('No model is configured for the consult tool. Pick one via the "{0}" setting.', MODEL_SETTING_ID),
				`No model is configured for the consult tool. Pick one via the "${MODEL_SETTING_ID}" setting.`,
				"ConsultTool(no model configured)"
			);
		}
		// The contributed schema does not bind the host: an input missing the
		// required question arrives here as-is, so the parse is what stops a
		// literal "undefined" from reaching the consulted model. The refusal goes
		// back to the CALLING model, which can fix the call and retry, so it says
		// what was wrong rather than just failing.
		const input = readConsultInput(options.input);
		if (input === undefined) {
			throw localizedError(
				l10n.t("The consult tool needs a question. Call it again with a non-empty question."),
				"The consult tool needs a question. Call it again with a non-empty question.",
				"ConsultTool(input carried no question)"
			);
		}
		let reply: string;
		try {
			reply = await this.send({ modelRef: ref, input, token });
		} catch (error) {
			if (error instanceof vscode.CancellationError) {
				// User cancellation: never logged, and the host owns the surfacing.
				throw error;
			}
			// The feature's single logging boundary; the logger records the
			// English mirror or classification the thrown error carries, so
			// neither the agent's question nor the server's response text reaches
			// the issue-report buffer through this line. The classified error
			// itself travels on to the chat view that invoked the tool.
			this.logger.error("Consult tool consultation failed", error);
			throw error;
		}
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(await this.fitReply(reply, options.tokenizationOptions, token)),
		]);
	}

	/**
	 * The reply shaped and cut to the budget the caller advertised, which is
	 * what `tokenizationOptions.tokenBudget` governs. No options means no known
	 * budget, so the reply travels whole rather than under a guessed bound.
	 *
	 * A counting failure must not fail the consultation: the answer is already
	 * in hand, so an unbudgeted best effort beats losing it. Cancellation still
	 * propagates (the token is bridged into the counter), and the degradation
	 * logs a fixed classification - never the counter's own message, which is
	 * the one error on this path that could quote the text it was counting.
	 */
	private async fitReply(
		reply: string,
		options: vscode.LanguageModelToolTokenizationOptions | undefined,
		token: vscode.CancellationToken
	): Promise<string> {
		const shaped = shapeConsultResult(reply).value;
		const tokenization = boundTokenization(options, token);
		if (tokenization === undefined) {
			return shaped;
		}
		try {
			const fit = await fitConsultReply(shaped, tokenization);
			if (fit.truncated) {
				// A classification, never the reply text.
				this.log("Consult tool: the reply exceeded the caller's token budget and was cut");
			}
			return fit.text;
		} catch (error) {
			if (token.isCancellationRequested || error instanceof vscode.CancellationError) {
				throw new vscode.CancellationError();
			}
			this.log("Consult tool: counting the reply failed, returning it unbudgeted");
			return shaped;
		}
	}
}

/**
 * Wire the feature. Returns the send so the dashboard's test-model probe runs
 * the exact pipeline an agent's consultation runs (one pipeline, one truth).
 */
export function wireConsultTool(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: { readonly oneShot: OneShotClient }
): { readonly consultSend: ConsultSend } {
	const log: LogFn = (message, data) => {
		logger.log(message, data);
	};
	const consultSend = createConsultSend(context.secrets, deps.oneShot, log);
	const tool = new ConsultTool(consultSend, logger);

	let registration: vscode.Disposable | undefined;
	const applyEnablement = (): void => {
		const active = isFeatureEnabled("consultTool") && getFeatureModelRef("consultTool", log) !== undefined;
		if (active && registration === undefined) {
			registration = vscode.lm.registerTool(TOOL_NAME, tool);
		} else if (!active && registration !== undefined) {
			registration.dispose();
			registration = undefined;
		}
		// The manifest's when-clause reads this key, so the entry in the agent's
		// tool picker appears exactly when the tool is REGISTERED. Gating the
		// contribution on the enable boolean alone would advertise the tool
		// through the half-configured state (enabled, no model yet), where every
		// call could only fail.
		void vscode.commands.executeCommand("setContext", CONSULT_TOOL_READY_CONTEXT_KEY, active);
	};
	applyEnablement();

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				applyEnablement();
			}
		}),
		new vscode.Disposable(() => {
			registration?.dispose();
			registration = undefined;
			void vscode.commands.executeCommand("setContext", CONSULT_TOOL_READY_CONTEXT_KEY, false);
		})
	);
	return { consultSend };
}
