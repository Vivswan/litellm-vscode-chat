/**
 * The consult tool's pure core: the input shape, model-facing prompt assembly,
 * token-budget truncation, and result shaping. No vscode imports, no UI, no
 * logging: the tool registration that consumes this adapts the host's
 * tokenization options and owns every host surface.
 */

import { truncateKeepingHead } from "../../../shared/util/text";

/** The tool's input as the calling model provides it (the contribution's JSON schema mirrors this). */
export interface ConsultToolInput {
	readonly question: string;
	readonly context?: string | undefined;
}

/**
 * Narrow whatever the host hands the tool to the declared input, or undefined
 * when there is no question to ask. The contributed JSON schema is documentation
 * for the calling model, NOT a guarantee: VS Code 1.134 forwards an input
 * missing a `required` property as-is, so an agent that omits the question
 * reaches invoke with `undefined` in its place. Parsing here is what keeps the
 * literal text "undefined" - or a non-string context's TypeError - out of the
 * prompt the consulted model sees. A blank question counts as none; a context
 * that is not a string reads as absent rather than failing the call, since the
 * question alone is still worth asking.
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

function withMarker(prefix: string, marker: string): string {
	return prefix === "" ? marker : `${prefix}\n${marker}`;
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
 * Fit the assembled prompt into the token budget. Strategy, in order: the
 * untruncated prompt (blank context reads as absent); the question intact
 * with the largest context prefix plus marker; the question intact with the
 * context dropped wholesale; the largest question prefix plus marker with no
 * context. When even the floors overflow, the smaller measured candidate
 * ships flagged withinBudget false, a tie keeping the question intact - the
 * tool answers best-effort, it never throws over its budget. A rejecting
 * countTokens propagates unchanged: cancellation rides the injected counter
 * (the registration binds its CancellationToken into the closure).
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
				assembleConsultPrompt(question, withMarker(truncateKeepingHead(context, chars), CONTEXT_TRUNCATION_MARKER)),
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
			assembleConsultPrompt(withMarker(truncateKeepingHead(question, chars), QUESTION_TRUNCATION_MARKER), undefined),
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
 * Fit the consulted model's reply into the budget the CALLER advertised. This
 * is what `tokenBudget` actually governs - vscode documents it as the maximum
 * number of tokens the tool should emit in its RESULT - and the result is the
 * only thing this tool adds to the calling model's context; the question and
 * context came from that model and are already spent there, which is why the
 * outgoing prompt is bounded by its own fixed limit instead (see
 * fitConsultPrompt's caller).
 *
 * The reply is cut from the end, since an answer's opening is where its
 * substance is, and the marker rides along so the caller never mistakes a cut
 * answer for a complete one. Same measured-fit discipline as the prompt
 * search: every non-empty result was measured against the budget. The budget
 * is a MAXIMUM, so when not even the bare marker fits, the tool emits the
 * empty string - the one candidate that cannot exceed any budget - rather than
 * breaking the bound it was given. A NaN budget lands there too, failing
 * closed like every other gate here.
 */
export async function fitConsultReply(reply: string, options: ConsultTokenizationOptions): Promise<ConsultReplyFit> {
	const replyTokens = await options.countTokens(reply);
	if (replyTokens <= options.tokenBudget) {
		return { text: reply, truncated: false };
	}
	const cut = await largestFittingCandidate(
		reply,
		(chars) => withMarker(truncateKeepingHead(reply, chars), REPLY_TRUNCATION_MARKER),
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
