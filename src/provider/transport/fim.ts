/**
 * Pure fill-in-the-middle helpers for the inline-completions transport: the
 * prompt/suffix construction (context budgets and the `_fim_template`
 * directive) and the lenient non-streaming /completions response parse. No
 * network, no vscode - the request path composes these around its send.
 */

import { isFimTemplateValue } from "../../shared/config/recordResolution";
import { isRecord } from "../../shared/util/json";
import { truncateKeepingHead, truncateKeepingTail } from "../../shared/util/text";

/** Document context ahead of the cursor, in UTF-16 code units; the tail is kept (truncated from the left). */
export const FIM_PREFIX_BUDGET = 8000;

/** Document context after the cursor, in UTF-16 code units; the head is kept (truncated from the right). */
export const FIM_SUFFIX_BUDGET = 4000;

/** Fixed completion budget of every FIM request; deliberately not a setting. */
export const FIM_MAX_TOKENS = 256;

/** Hard whole-call bound of every FIM request; deliberately not a setting, so timeout wording can stay truthful. */
export const FIM_TIMEOUT_MS = 15000;

export interface FimPromptInput {
	/** Document text before the cursor; only the last FIM_PREFIX_BUDGET units are used. */
	readonly prefix: string;
	/** Document text after the cursor; only the first FIM_SUFFIX_BUDGET units are used. */
	readonly suffix: string;
	/**
	 * The resolved parameter record's `_fim_template` directive value
	 * (ResolvedModelParameters.fimTemplate), untyped for totality: only a
	 * string with both placeholders applies, and a malformed value degrades to
	 * the native path.
	 */
	readonly fimTemplate?: unknown;
}

export interface FimPrompt {
	readonly prompt: string;
	/** The wire `suffix` field; absent exactly when a template owns the whole prompt. */
	readonly suffix?: string;
}

const TEMPLATE_PLACEHOLDER = /\{(prefix|suffix)\}/g;

/**
 * The prefix's budgeted tail: shared/util/text's surrogate-safe tail rule
 * bound to FIM_PREFIX_BUDGET. Exported as the one truncation pipeline: the
 * inline provider windows its document reads through this, so its cache key
 * IS the wire prefix.
 */
export function truncateFimPrefix(prefix: string): string {
	return truncateKeepingTail(prefix, FIM_PREFIX_BUDGET);
}

/** The suffix's budgeted head; the shared mirror rule bound to FIM_SUFFIX_BUDGET. */
export function truncateFimSuffix(suffix: string): string {
	return truncateKeepingHead(suffix, FIM_SUFFIX_BUDGET);
}

/**
 * Build the /completions prompt from the cursor's surrounding context. The
 * prefix keeps its tail and the suffix its head, so the text nearest the
 * cursor always survives the budgets. With a valid `_fim_template` the prompt
 * is the template with every `{prefix}`/`{suffix}` occurrence substituted in
 * one pass (a placeholder spelled inside document text is never re-scanned),
 * and the wire `suffix` field is omitted - the template placed it already.
 */
export function buildFimPrompt(input: FimPromptInput): FimPrompt {
	const prefix = truncateFimPrefix(input.prefix);
	const suffix = truncateFimSuffix(input.suffix);
	if (isFimTemplateValue(input.fimTemplate)) {
		const prompt = input.fimTemplate.replace(TEMPLATE_PLACEHOLDER, (_, name: string) =>
			name === "prefix" ? prefix : suffix
		);
		return { prompt };
	}
	return { prompt: prefix, suffix };
}

/**
 * The completion text of a non-streaming /completions response body: the
 * first choice carrying a string `text`, so junk choices drop instead of
 * failing the response (the transport's log-and-skip leniency). Total over
 * any input; malformed shapes read as undefined, and nothing here throws or
 * quotes response text.
 */
export function parseCompletionText(payload: unknown): string | undefined {
	if (!isRecord(payload) || !Array.isArray(payload.choices)) {
		return undefined;
	}
	for (const choice of payload.choices) {
		if (isRecord(choice) && typeof choice.text === "string") {
			return choice.text;
		}
	}
	return undefined;
}
