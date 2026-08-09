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
 * A plain Error whose display message may be localized: `english` rides as
 * the englishMessage mirror, so the output channel, the issue-report buffer,
 * and the latest-error prefill (see shared/logger.ts) keep the English
 * rendering whatever the display locale. `logClassification`, when a site
 * passes one, replaces even the English mirror on the public surfaces - for
 * messages that embed response-derived text (see publicErrorText). Lives in
 * shared so shared modules (validation.ts) can construct mirrored errors
 * without importing the provider layer.
 */
export function localizedError(display: string, english: string, logClassification?: string): Error {
	return Object.assign(new Error(display), {
		englishMessage: english,
		...(logClassification !== undefined ? { logClassification } : {}),
	});
}
