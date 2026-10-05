/**
 * Provider transport (fim.ts) and the extension features (commitGen, prGen) both consume these, so they live in
 * src/shared/util - the one tree both may import under the Biome layering. Pure string logic: no vscode, no
 * localization, nothing here throws.
 */

/** A fence line's backtick count and whether an info string follows: a closing fence never carries one. */
export interface FenceLine {
	readonly run: number;
	readonly bare: boolean;
}

const FENCE_LINE = /^\s*(`{3,})([^`]*)$/;

export function fenceLine(line: string): FenceLine | undefined {
	const match = FENCE_LINE.exec(line);
	return match === null ? undefined : { run: (match[1] ?? "").length, bare: (match[2] ?? "").trim() === "" };
}

export function closesFence(line: string, opener: FenceLine): boolean {
	const fence = fenceLine(line);
	return fence?.bare === true && fence.run >= opener.run;
}

/**
 * CommonMark would take the first bare fence as the closer; here a same-length fence carrying an info string ends the
 * search instead, read as a nested block whose outer wrapper lost its closer, so that inner block keeps both of its
 * fences. Shorter fences are content (three-backtick blocks inside a four-backtick wrapper).
 */
function closerOf(lines: readonly string[], opener: FenceLine): number | undefined {
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (closesFence(line, opener)) {
			return i;
		}
		if ((fenceLine(line)?.run ?? 0) >= opener.run) {
			return undefined;
		}
	}
	return undefined;
}

/**
 * The content of a reply that is ONE fenced block end to end, else undefined. prGen unwraps only this shape as a pair:
 * a description that merely ENDS with its own code block fails the predicate and keeps that block's closer.
 */
export function unwrapWholeReplyFence(text: string): string | undefined {
	const lines = text.trim().split("\n");
	const opener = fenceLine(lines[0] ?? "");
	if (opener === undefined || closerOf(lines, opener) !== lines.length - 1) {
		return undefined;
	}
	return lines.slice(1, -1).join("\n").trim();
}

/**
 * Models sometimes fence only the subject and go on in prose: both of that block's fences are furniture, and an
 * opener nothing closes costs its own line alone.
 */
export function stripMarkdownFences(text: string): string {
	const lines = text.trim().split("\n");
	const opener = fenceLine(lines[0] ?? "");
	if (opener === undefined) {
		return lines.join("\n");
	}
	const closer = closerOf(lines, opener);
	const kept = closer === undefined ? lines.slice(1) : [...lines.slice(1, closer), ...lines.slice(closer + 1)];
	return kept.join("\n").trim();
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
