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
 * The input_audio wire format for an audio MIME type, or undefined for audio
 * the wire shape does not name (the OpenAI input_audio block takes only wav
 * and mp3). Common aliases map to their canonical format.
 */
export function audioInputFormatForMime(mime: string): "wav" | "mp3" | undefined {
	switch (mime.toLowerCase()) {
		case "audio/wav":
		case "audio/x-wav":
		case "audio/wave":
		case "audio/vnd.wave":
			return "wav";
		case "audio/mp3":
		case "audio/mpeg":
			return "mp3";
		default:
			return undefined;
	}
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
