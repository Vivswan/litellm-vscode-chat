/**
 * Provider transport (fim.ts) and the extension features (commitGen) both consume these, so they live in
 * src/shared/util - the one tree both may import under the Biome layering. Pure string logic: no vscode, no
 * localization, nothing here throws.
 */

/** text that legitimately OPENS with a code block -> loses that fence */
export function stripMarkdownFences(text: string): string {
	let message = text.trim();
	if (message.startsWith("```")) {
		message = message.replace(/^```[^\n]*\n?/, "");
		message = message.replace(/\n?```\s*$/, "");
		message = message.trim();
	}
	return message;
}

/**
 * The text's budgeted tail (the last `budget` UTF-16 code units), never starting on the severed low half of a surrogate
 * pair: a cut that splits an astral character drops the lone unit, because an unpaired surrogate in the JSON body is
 * exactly the kind of malformed input a gateway may reject. Untruncated input passes through verbatim - fidelity beats
 * repair for text the user actually wrote.
 *
 *   a budget below one - zero, negative, NaN, or a bare fraction -> keeps nothing
 */
export function truncateKeepingTail(text: string, budget: number): string {
	const units = Math.floor(budget);
	if (text.length <= units) {
		return text;
	}
	if (!(units > 0)) {
		return "";
	}
	const tail = text.slice(-units);
	const first = tail.charCodeAt(0);
	return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/**
 * The text's budgeted head (the first `budget` UTF-16 code units); the mirror rule drops a severed high surrogate at
 * the cut.
 */
export function truncateKeepingHead(text: string, budget: number): string {
	const units = Math.floor(budget);
	if (text.length <= units) {
		return text;
	}
	if (!(units > 0)) {
		return "";
	}
	const head = text.slice(0, units);
	const last = head.charCodeAt(head.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/** Model-facing English by policy, so it never localizes. */
export function truncationMarker(what: string): string {
	return `[${what} truncated]`;
}

/**
 * The seam the measured-fit sites (the consult tool's token bisection) share with the char-budget wrapper below, so a
 * cut is marked the same way everywhere.
 */
export function appendTruncationMarker(prefix: string, marker: string): string {
	return prefix === "" ? marker : `${prefix}\n${marker}`;
}

/**
 * Head-truncate to `budget` with the marker riding INSIDE the budget: text at or under the budget passes verbatim (no
 * marker). The cut itself is truncateKeepingHead, so a severed surrogate pair
 * never reaches a JSON request body; a budget too small to keep any text degrades to the marker, itself head-cut when
 * even it does not fit - the bound wins over the marker.
 */
export function truncateHeadWithMarker(text: string, budget: number, marker: string): string {
	const units = Math.floor(budget);
	if (text.length <= units) {
		return text;
	}
	if (marker.length >= units) {
		// Not even the marker plus a kept character fits.
		return truncateKeepingHead(marker, units);
	}
	return appendTruncationMarker(truncateKeepingHead(text, units - marker.length - 1), marker);
}
