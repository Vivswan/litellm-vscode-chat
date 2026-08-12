import * as l10n from "@vscode/l10n";

/**
 * Compose a chat-surface two-part error message: headline, a paragraph break,
 * then a localized "Details:" lead-in before the technical detail. GitHub
 * Copilot Chat's error block flattens newlines, so the lead-in is the visible
 * boundary there; renderers that honor newlines get the paragraph break too.
 * Discovery-surface messages keep the plain "\n" join (the dashboard and
 * tooltips split on it).
 */
export function chatErrorMessage(headline: string, detail: string): string {
	return `${headline}\n\n${l10n.t("Details: {0}", detail)}`;
}

/** English mirror of chatErrorMessage: the same shape with the literal English lead-in, whatever the display locale. */
export function englishChatErrorMessage(headline: string, detail: string): string {
	return `${headline}\n\nDetails: ${detail}`;
}

/**
 * The English rendering a boundary error must carry, at least one of:
 *
 * - `englishMessage`: the full English mirror of a localized display message,
 *   response-derived detail included. The output channel renders it instead
 *   of the message (the channel stays English by policy), and the public
 *   surfaces fall back to it when no classification applies.
 * - `logClassification`: the terse classification-only rendering that PUBLIC
 *   surfaces (the issue-report buffer and the latest-error prefill; see
 *   shared/logger.ts) record instead of the message. A site whose message
 *   embeds response-derived text (an HTTP error body, an IdP's
 *   error_description) must pass one; each site's string should be distinct
 *   enough that maintainers can tell the failure modes apart in an issue
 *   without the body.
 *
 * The union makes omitting both a compile error, which is the whole point:
 * a boundary error cannot be constructed without an English channel.
 */
export type EnglishRendering =
	| { readonly englishMessage: string; readonly logClassification?: string }
	| { readonly englishMessage?: string; readonly logClassification: string };

/**
 * Base class for every error whose display message may be localized and that
 * can cross into the status or provider-boundary log path. The constructor
 * requires an English rendering (EnglishRendering), so the AGENTS.md
 * localization invariant - no translated text in the output channel or public
 * issue reports - holds by construction, not by convention. shared/logger.ts
 * reads both fields duck-typed (a hostile proxy must not break logging), but
 * this class and its subclasses are the canonical producers. Lives in shared
 * so shared modules (validation.ts) can construct mirrored errors without
 * importing the provider layer.
 */
export class MirroredError extends Error {
	readonly englishMessage?: string;
	readonly logClassification?: string;

	constructor(message: string, options: EnglishRendering & { readonly cause?: unknown }) {
		super(message, { cause: options.cause });
		this.name = "MirroredError";
		if (options.englishMessage !== undefined) {
			this.englishMessage = options.englishMessage;
		}
		if (options.logClassification !== undefined) {
			this.logClassification = options.logClassification;
		}
	}
}

/** Thin positional factory over MirroredError for the display/English pair the pre-flight and stream throw sites pass. */
export function localizedError(display: string, english: string, logClassification?: string): MirroredError {
	return new MirroredError(display, {
		englishMessage: english,
		...(logClassification !== undefined ? { logClassification } : {}),
	});
}
