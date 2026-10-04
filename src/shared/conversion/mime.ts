export function isTextMimeType(mime: string): boolean {
	const lower = mime.toLowerCase();
	return lower.startsWith("text/") || lower === "application/json" || lower.endsWith("+json");
}

export function isImageMimeType(mime: string): boolean {
	return mime.toLowerCase().startsWith("image/");
}

export function isPdfMimeType(mime: string): boolean {
	return mime.toLowerCase() === "application/pdf";
}

/**
 * The input_audio wire format for an audio MIME type, or undefined for audio the wire shape does not name (the OpenAI
 * input_audio block takes only wav and mp3).
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
 * Model-supplied MIME values must pass this before they are logged or attached to a host part: logs feed the
 * issue-report buffer, and an arbitrary string here is response-derived text.
 */
export function isSafeMimeType(mime: string): boolean {
	return mime.length <= 100 && /^[\w.+-]+\/[\w.+-]+$/.test(mime);
}
