/** True for MIME types whose payloads can be decoded and forwarded as text (plain text or JSON). */
export function isTextMimeType(mime: string): boolean {
	const lower = mime.toLowerCase();
	return lower.startsWith("text/") || lower === "application/json" || lower.endsWith("+json");
}

export function isImageMimeType(mime: string): boolean {
	return mime.toLowerCase().startsWith("image/");
}
