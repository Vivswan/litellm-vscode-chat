/**
 * The consult tool's pure core: the input shape, model-facing prompt assembly,
 * token-budget truncation, and result shaping. No vscode imports, no UI, no
 * logging: the tool registration that consumes this adapts the host's
 * tokenization options and owns every host surface.
 */

import { appendTruncationMarker, truncateKeepingHead } from "../../../shared/util/text";

/** The tool's input as the calling model provides it (the contribution's JSON schema mirrors this). */
export interface ConsultToolInput {
	readonly question: string;
	readonly context?: string | undefined;
}

/**
 * VS Code 1.134 forwards an input missing a `required` property as-is, so the contributed schema binds nothing
 * and this parse is what keeps a literal "undefined" out of the prompt the consulted model sees. A non-string
 * context reads as absent rather than failing the call, because the question alone is still worth asking.
 */
export function readConsultInput(raw: unknown): ConsultToolInput | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const { question, context } = raw as { question?: unknown; context?: unknown };
	if (typeof question !== "string" || question.trim() === "") {
		return undefined;
	}
	return typeof context === "string" ? { question, context } : { question };
}

/**
 * The host-provided budget and counter, structurally vscode's
 * LanguageModelToolTokenizationOptions - which arrives optional at invoke
 * time, so the registration owns the no-options fallback. countTokens returns
 * a Thenable and every count is awaited, one at a time.
 */
export interface ConsultTokenizationOptions {
	readonly tokenBudget: number;
	readonly countTokens: (text: string) => PromiseLike<number>;
}

/**
 * The built-in instruction framing the consultation. Model-facing text, so it
 * stays English by policy.
 */
export const CONSULT_INSTRUCTION = [
	"Another AI assistant is consulting you for a second opinion.",
	"Answer the question directly and concisely. When you are not sure, say so rather than guessing.",
].join("\n");

/** Rides where cut context ends, so the consulted model knows material is missing. */
export const CONTEXT_TRUNCATION_MARKER = "[context truncated to fit the token budget]";

/** Rides where a cut question ends; the question is only cut once the context is already gone. */
export const QUESTION_TRUNCATION_MARKER = "[question truncated to fit the token budget]";

/**
 * Bisection step cap per truncated field. 16 steps resolve a field of up to
 * 65,536 UTF-16 code units to the exact boundary; a longer field lands within
 * length/2^16 code units below it, always on the fitting side.
 */
export const TRUNCATION_BISECTION_STEPS = 16;

/** Blank context reads as absent - one rule, shared by assembly and fitting. */
function presentContext(context: string | undefined): string | undefined {
	return context !== undefined && context.trim() !== "" ? context : undefined;
}

/**
 * Assemble the model prompt: the instruction, the caller's context when there
 * is one, and the question, as labeled sections.
 */
export function assembleConsultPrompt(question: string, context: string | undefined): string {
	const sections = [CONSULT_INSTRUCTION];
	const present = presentContext(context);
	if (present !== undefined) {
		sections.push(`Context supplied by the caller:\n${present}`);
	}
	sections.push(`Question:\n${question}`);
	return sections.join("\n\n");
}

type PrefixSearch =
	| { readonly fits: true; readonly prompt: string }
	| { readonly fits: false; readonly floorPrompt: string; readonly floorTokens: number };

/**
 * Bisect the field's code-unit count for the largest measured-fitting
 * candidate. A fit is evidence, never assumption - only measured candidates
 * are returned - while the search direction does assume longer prefixes count
 * higher; a locally non-monotone counter can cost prefix length, never a fit.
 * Everything gates on the positive fit test, so a NaN budget fails closed to
 * overflow. Overflow reports the floor candidate (the empty prefix) with its
 * measured count, so the caller can weigh best-effort options without
 * recounting.
 */
async function largestFittingCandidate(
	text: string,
	candidate: (chars: number) => string,
	options: ConsultTokenizationOptions
): Promise<PrefixSearch> {
	let best = candidate(0);
	const floorTokens = await options.countTokens(best);
	if (floorTokens <= options.tokenBudget) {
		let fitting = 0;
		let overflowing = text.length;
		for (let step = 0; step < TRUNCATION_BISECTION_STEPS && overflowing - fitting > 1; step += 1) {
			const mid = fitting + Math.floor((overflowing - fitting) / 2);
			const attempt = candidate(mid);
			if ((await options.countTokens(attempt)) <= options.tokenBudget) {
				fitting = mid;
				best = attempt;
			} else {
				overflowing = mid;
			}
		}
		return { fits: true, prompt: best };
	}
	return { fits: false, floorPrompt: best, floorTokens };
}

export interface ConsultPromptFit {
	readonly prompt: string;
	/** True when the context was cut or dropped entirely. */
	readonly contextTruncated: boolean;
	readonly questionTruncated: boolean;
	/** False only when even the minimal candidates overflowed (the prompt is still the best effort). */
	readonly withinBudget: boolean;
}

/**
 * Context gives way before the question, because the question is the thing being asked, and the tool answers
 * best-effort rather than ever throwing over its budget.
 */
export async function fitConsultPrompt(
	input: ConsultToolInput,
	options: ConsultTokenizationOptions
): Promise<ConsultPromptFit> {
	const question = input.question;
	const context = presentContext(input.context);
	const full = assembleConsultPrompt(question, context);
	const fullTokens = await options.countTokens(full);
	if (fullTokens <= options.tokenBudget) {
		return { prompt: full, contextTruncated: false, questionTruncated: false, withinBudget: true };
	}
	// The intact-question fallback should nothing below fit: the full prompt,
	// or the measured dropped-context prompt once context is in play.
	let intact = { prompt: full, tokens: fullTokens };
	if (context !== undefined) {
		const cutContext = await largestFittingCandidate(
			context,
			(chars) =>
				assembleConsultPrompt(
					question,
					appendTruncationMarker(truncateKeepingHead(context, chars), CONTEXT_TRUNCATION_MARKER)
				),
			options
		);
		if (cutContext.fits) {
			return { prompt: cutContext.prompt, contextTruncated: true, questionTruncated: false, withinBudget: true };
		}
		const dropped = assembleConsultPrompt(question, undefined);
		const droppedTokens = await options.countTokens(dropped);
		if (droppedTokens <= options.tokenBudget) {
			return { prompt: dropped, contextTruncated: true, questionTruncated: false, withinBudget: true };
		}
		intact = { prompt: dropped, tokens: droppedTokens };
	}
	const cutQuestion = await largestFittingCandidate(
		question,
		(chars) =>
			assembleConsultPrompt(
				appendTruncationMarker(truncateKeepingHead(question, chars), QUESTION_TRUNCATION_MARKER),
				undefined
			),
		options
	);
	if (cutQuestion.fits) {
		return {
			prompt: cutQuestion.prompt,
			contextTruncated: context !== undefined,
			questionTruncated: true,
			withinBudget: true,
		};
	}
	return cutQuestion.floorTokens < intact.tokens
		? {
				prompt: cutQuestion.floorPrompt,
				contextTruncated: context !== undefined,
				questionTruncated: true,
				withinBudget: false,
			}
		: {
				prompt: intact.prompt,
				contextTruncated: context !== undefined,
				questionTruncated: false,
				withinBudget: false,
			};
}

/**
 * What the tool returns when the consulted model answers with no text.
 * It lands in the calling model's context, so it stays English by policy.
 */
export const EMPTY_REPLY_TEXT = "The consulted model returned an empty reply.";

/** Rides where a cut reply ends, so the CALLING model knows the answer is incomplete. */
export const REPLY_TRUNCATION_MARKER = "[reply truncated to fit the caller's token budget]";

export interface ConsultReplyFit {
	readonly text: string;
	/** True when anything was cut, the nothing-fits case included. */
	readonly truncated: boolean;
}

/**
 * `tokenBudget` governs the RESULT, the only thing this tool adds to the calling model's context, so the outgoing
 * prompt is bounded separately by CONSULT_PROMPT_CHAR_LIMIT in wiring.ts. The reply is cut from the END because
 * an answer's substance is in its opening, and the empty string is the one result that cannot break the maximum
 * when not even the bare marker fits.
 */
export async function fitConsultReply(reply: string, options: ConsultTokenizationOptions): Promise<ConsultReplyFit> {
	const replyTokens = await options.countTokens(reply);
	if (replyTokens <= options.tokenBudget) {
		return { text: reply, truncated: false };
	}
	const cut = await largestFittingCandidate(
		reply,
		(chars) => appendTruncationMarker(truncateKeepingHead(reply, chars), REPLY_TRUNCATION_MARKER),
		options
	);
	return { text: cut.fits ? cut.prompt : "", truncated: true };
}

/** A plain text part, structurally vscode's LanguageModelTextPart data; the registration wraps it. */
export interface ConsultTextPart {
	readonly value: string;
}

/** The model's reply as the tool's one text part: trimmed, with a stated stand-in for an empty reply. */
export function shapeConsultResult(reply: string): ConsultTextPart {
	const text = reply.trim();
	return { value: text === "" ? EMPTY_REPLY_TEXT : text };
}
