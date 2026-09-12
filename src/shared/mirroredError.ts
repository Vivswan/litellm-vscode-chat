import * as l10n from "@vscode/l10n";

/**
 * Compose a two-part error message for surfaces that flatten newlines
 * (GitHub Copilot Chat's error block, VS Code notifications): headline,
 * paragraph break, localized "Details:" lead-in, detail - the lead-in is the
 * visible boundary once the newlines are gone. Discovery-surface messages
 * keep the plain "\n" join, which the dashboard and tooltips split on.
 */
export function chatErrorMessage(headline: string, detail: string): string {
	return `${headline}\n\n${l10n.t("Details: {0}", detail)}`;
}

/** English mirror of chatErrorMessage: the same shape with the literal English lead-in, whatever the display locale. */
export function englishChatErrorMessage(headline: string, detail: string): string {
	return `${headline}\n\nDetails: ${detail}`;
}

/**
 * The English channel a boundary error must carry; the union makes omitting both a compile error.
 *
 *   englishMessage    -> the full mirror of the localized message; the output channel renders it in the message's place
 *   logClassification -> the terse text PUBLIC surfaces (shared/logger.ts) record; required where the message embeds
 *                        response-derived text, and distinct per site so failure modes stay apart without it
 */
export type EnglishRendering =
	| { readonly englishMessage: string; readonly logClassification?: string }
	| { readonly englishMessage?: string; readonly logClassification: string };

/**
 * Base class for every error whose display message may be localized and that
 * can cross into the status or provider-boundary log path. The constructor
 * requires an EnglishRendering, so the localization invariant - no translated
 * text in the output channel or public issue reports - holds by construction.
 * shared/logger.ts still reads both fields duck-typed, since a logging
 * boundary can be handed anything.
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
