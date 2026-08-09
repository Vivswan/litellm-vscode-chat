/**
 * Splitting the redesigned two-part error messages (human headline, "\n",
 * technical detail) for surfaces that cannot render the raw newline: toasts
 * carry the headline only (VS Code notifications render newlines poorly), and
 * the dashboard renders the parts as separate elements. Pure string helpers,
 * shared so the host notifier and the webview extract the same parts; total
 * on junk input - a message with no content line passes through unchanged.
 */

/**
 * Runs of whitespace (newlines included) collapsed to single spaces, trimmed:
 * the shared core that keeps a composed detail segment one physical line.
 * Callers own their own truncation - the caps (and whether they mark the cut)
 * differ per surface.
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
 * Everything after the headline line, trimmed: the technical detail of a
 * two-part message, or undefined for a single-part one. Inner newlines are
 * kept - a multi-line detail renders line-per-line under pre-line styling.
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
