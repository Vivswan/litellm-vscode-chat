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
