/**
 * Splitting the two-part discovery-surface error messages (headline, "\n",
 * detail) for surfaces that cannot render the raw newline: toasts carry the
 * headline only, and the dashboard renders the parts as separate elements.
 * Chat-surface messages join their parts with the "Details:" lead-in instead.
 * Total on junk input - a message with no content line passes through
 * unchanged.
 */

/**
 * Runs of whitespace collapsed to single spaces, trimmed, keeping a composed
 * detail segment on one physical line. Callers own their own truncation: the
 * caps differ per surface.
 */
export function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The first content line, trimmed: the human headline of a two-part message. */
export function statusErrorHeadline(error: string): string {
	const firstContentLine = error.split("\n").find((line) => line.trim().length > 0);
	return firstContentLine?.trim() ?? error;
}

/**
 * Everything after the headline line, trimmed, or undefined for a single-part
 * message. Inner newlines are kept - a multi-line detail renders line-per-line
 * under pre-line styling.
 */
export function statusErrorDetail(error: string): string | undefined {
	const lines = error.split("\n");
	const headlineIndex = lines.findIndex((line) => line.trim().length > 0);
	if (headlineIndex === -1) {
		return undefined;
	}
	const rest = lines
		.slice(headlineIndex + 1)
		.join("\n")
		.trim();
	return rest.length > 0 ? rest : undefined;
}
