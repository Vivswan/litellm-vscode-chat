/**
 * The SDK-error mapper without a vscode value, so its pins run under bun (src/test/bun/preload.ts admits no module whose
 * imports reach vscode). The host's cancellation class is the one vscode value the mapping needs, so callers inject it as
 * the isCancellation predicate (cancellation.ts). The LanguageModelError wrap sits at the provider boundary
 * (src/provider/index.ts).
 */
import * as l10n from "@vscode/l10n";
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { manageCommandTitle } from "../../shared/config/commandIds";
import { errorMessageText } from "../../shared/logger";
import { MirroredError } from "../../shared/mirroredError";
import {
	causeChain,
	chainDetail,
	chatHttpDetail,
	classifyEnvelope,
	compactText,
	discoveryHttpDetail,
	errorEnvelopeOf,
	httpHeadline,
	type LocalizedText,
	type MapErrorContext,
	RequestError,
	socketFailureRequestError,
	surfaceCopy,
	timeoutRequestError,
	twoPartTexts,
} from "./transportErrors";

/**
 * Lazy so the l10n bundle lookup and the interpolated manage-command title both resolve at 401 time, not module load.
 *
 *   The paired *_ENGLISH constant -> the English mirror the log surfaces record
 */
function authMessage(): string {
	return l10n.t(
		'Authentication failed: Your LiteLLM server requires an API key. Please run the "{0}" command to configure your API key.',
		manageCommandTitle()
	);
}

/** English mirror of authMessage; "Manage LiteLLM Provider" is the palette title package.json contributes. */
const AUTH_MESSAGE_ENGLISH =
	'Authentication failed: Your LiteLLM server requires an API key. Please run the "Manage LiteLLM Provider" command to configure your API key.';

/** Lazy for the same reason as authMessage: the display string resolves through the l10n bundle at 401 time. */
function upstreamAuthMessage(): string {
	return l10n.t(
		"Authentication failed upstream: the LiteLLM server accepted your key but could not authenticate to the model's upstream provider. Fix that provider's credentials on the LiteLLM server."
	);
}

const UPSTREAM_AUTH_MESSAGE_ENGLISH =
	"Authentication failed upstream: the LiteLLM server accepted your key but could not authenticate to the model's upstream provider. Fix that provider's credentials on the LiteLLM server.";

/**
 * LiteLLM wraps upstream failures in its exception names ("litellm.AuthenticationError: ..."); its own gate answers
 * with an auth_error envelope. The envelope type outranks the message text: an exception name quoted inside an
 * auth_error body is still the proxy rejecting this client's key.
 *
 *   the proxy message tells the user to fix the extension's key, the wrong credential entirely for an upstream failure
 *     -> Telling them apart matters
 *   Classification only -> the body text itself is never echoed anywhere
 */
function isUpstreamAuthFailure(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const { message, type } = error as { message?: unknown; type?: unknown };
	if (type === "auth_error") {
		return false;
	}
	return typeof message === "string" && /litellm\.[\w.]*AuthenticationError/i.test(message);
}

/**
 * The SDK adds a wrapper level over the socket/TLS error that carries the actionable string. An error `isCancellation`
 * recognises passes through untouched: cancellation is never wrapped, so the provider boundary can keep it unlogged.
 */
export function mapSdkError(
	err: unknown,
	ctx: MapErrorContext,
	isCancellation: (error: unknown) => error is Error
): Error {
	if (err instanceof APIError && typeof err.status === "number") {
		if (err.status === 401) {
			return isUpstreamAuthFailure(err.error)
				? new RequestError(upstreamAuthMessage(), "auth", {
						status: 401,
						cause: err,
						englishMessage: UPSTREAM_AUTH_MESSAGE_ENGLISH,
					})
				: new RequestError(authMessage(), "auth", {
						status: 401,
						cause: err,
						englishMessage: AUTH_MESSAGE_ENGLISH,
						// The upstream variant above gets none (updating the extension's key cannot fix the proxy's
						// provider credentials).
						setupHint: "configure-api-key",
					});
		}
		const envelope = errorEnvelopeOf(err.error);
		if (err.status === 404) {
			const copy = surfaceCopy(ctx.surface).notFound;
			const texts = twoPartTexts(ctx.surface, copy.headline(ctx.baseUrl), copy.detail(err, envelope));
			return new RequestError(texts.message, "http", {
				status: 404,
				cause: err,
				logClassification: `RequestError(http, status 404, ${ctx.surface})`,
				englishMessage: texts.englishMessage,
				...(copy.setupHint !== undefined ? { setupHint: copy.setupHint } : {}),
			});
		}
		const cls = classifyEnvelope(envelope, err.status);
		const headline = httpHeadline(ctx.surface, cls);
		const detail =
			surfaceCopy(ctx.surface).httpVocabulary === "modelList"
				? discoveryHttpDetail(err.status, err, envelope)
				: chatHttpDetail(err.status, err, envelope);
		// The classifier's own closed-set token may ride the classification (classify FROM the body, never quote it);
		// the response text itself rides only in message/englishMessage.
		const token = cls === "budget_exceeded" || cls === "context_window_exceeded" ? `, ${cls}` : "";
		const texts = twoPartTexts(ctx.surface, headline, detail);
		return new RequestError(texts.message, "http", {
			status: err.status,
			cause: err,
			logClassification: `RequestError(http, status ${err.status}${token})`,
			englishMessage: texts.englishMessage,
		});
	}

	if (err instanceof APIConnectionTimeoutError) {
		// The SDK also files any failure whose text matches /timed? ?out/ here (a TCP ETIMEDOUT, undici's connect
		// or headers clocks), none of which is this call's budget. Only an abort proves the budget fired: the
		// SDK's own timer (armed with the same ms) aborts without a reason, so its cause is an AbortError.
		const chain = causeChain(err.cause);
		const abortDriven =
			chain.length === 0 || chain.some((link) => link.name === "AbortError" || link.name === "TimeoutError");
		if (abortDriven) {
			return timeoutRequestError(ctx, err);
		}
		return socketFailureRequestError(
			err.cause,
			err,
			{ endpoint: ctx.surface, surface: ctx.surface, url: ctx.baseUrl },
			() => timeoutRequestError(ctx, err)
		);
	}

	if (err instanceof APIUserAbortError) {
		return new RequestError(l10n.t("Request was aborted."), "aborted", {
			cause: err,
			englishMessage: "Request was aborted.",
		});
	}

	if (err instanceof APIConnectionError) {
		return socketFailureRequestError(
			err.cause,
			err,
			{ endpoint: ctx.surface, surface: ctx.surface, url: ctx.baseUrl },
			() => timeoutRequestError(ctx, err)
		);
	}

	if (err instanceof RequestError || err instanceof MirroredError || isCancellation(err)) {
		return err;
	}
	// Errors shaped elsewhere but carrying the English mirror duck-typed already carry their display/English pair;
	// re-headlining them would double-wrap, and a socket term quoted in their text must not reclassify them, so this
	// pass-through sits before the socket branch. The property read is guarded: a hostile getter must not escape
	// mapSdkError.
	if (err instanceof Error) {
		let mirrored = false;
		try {
			mirrored = typeof (err as { englishMessage?: unknown }).englishMessage === "string";
		} catch {
			mirrored = false;
		}
		if (mirrored) {
			return err;
		}
	}

	// A socket that dies AFTER headers surfaces from the body reader, not from the SDK transport: the SDK already
	// returned the Response, so undici's bare TypeError arrives here wrapped in no SDK error class, and the user would
	// otherwise see the raw "terminated". The match requires a socket-level signature (or undici's exact top-level
	// TypeError): a mere "terminated" inside some other error's message must not reclassify it.
	if (err instanceof Error) {
		const chain = causeChain(err);
		const haystack = chain.map((link) => `${link.name} ${link.message} ${link.code ?? ""}`).join(" ");
		const socketSignature = /other side closed|ECONNRESET|UND_ERR_SOCKET/.test(haystack);
		// The top link is causeChain's guarded read of err.message: arbitrary errors reach this branch from the body
		// reader, so err.message is never read directly here (a hostile getter must not escape).
		const topMessage = chain[0]?.message ?? "";
		const undiciTermination = err instanceof TypeError && topMessage === "terminated";
		if (socketSignature || undiciTermination) {
			const chainText = chainDetail(chain, topMessage);
			const copy = surfaceCopy(ctx.surface).dropped;
			const url = ctx.baseUrl;
			const texts = twoPartTexts(ctx.surface, copy.headline(url), copy.detail(url, chainText));
			return new RequestError(texts.message, "network", {
				cause: err,
				englishMessage: texts.englishMessage,
			});
		}
	}

	let name: string;
	if (err instanceof Error) {
		try {
			name = typeof err.name === "string" && /^[\w$.]{1,64}$/.test(err.name) ? err.name : "Error";
		} catch {
			name = "Error";
		}
	} else {
		name = typeof err;
	}
	const rawText = errorMessageText(err);
	const text = compactText(typeof rawText === "string" ? rawText : "", 300);
	const detail = `Unexpected ${name} during the ${surfaceCopy(ctx.surface).phrase} request to ${ctx.baseUrl}${text !== "" ? `: ${text}` : ""}`;
	const tailHeadline: LocalizedText = {
		display: l10n.t(
			"The request failed unexpectedly. Try again; if it keeps happening, report an issue so we can look at it."
		),
		english: "The request failed unexpectedly. Try again; if it keeps happening, report an issue so we can look at it.",
	};
	const texts = twoPartTexts(ctx.surface, tailHeadline, detail);
	return new MirroredError(texts.message, {
		cause: err,
		englishMessage: texts.englishMessage,
		logClassification:
			err instanceof Error
				? `unhandled Error in transport (${name}, ${ctx.surface})`
				: `non-Error throw in transport (${name}, ${ctx.surface})`,
	});
}
