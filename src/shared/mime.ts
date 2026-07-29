/** True for MIME types whose payloads can be decoded and forwarded as text (plain text or JSON). */
export function isTextMimeType(mime: string): boolean {
	const lower = mime.toLowerCase();
	return lower.startsWith("text/") || lower === "application/json" || lower.endsWith("+json");
}

export function isImageMimeType(mime: string): boolean {
	return mime.toLowerCase().startsWith("image/");
}

/** True for PDF payloads, which convert to file content blocks and carry a fixed token estimate. */
export function isPdfMimeType(mime: string): boolean {
	return mime.toLowerCase() === "application/pdf";
}

/**
 * True when a MIME string is shaped like type/subtype over a conservative
 * character set, with a sane length cap. Model-supplied MIME values must pass
 * this before they are logged or attached to a host part: logs feed the
 * issue-report buffer, and an arbitrary string here is response-derived text.
 */
export function isSafeMimeType(mime: string): boolean {
	return mime.length <= 100 && /^[\w.+-]+\/[\w.+-]+$/.test(mime);
}
