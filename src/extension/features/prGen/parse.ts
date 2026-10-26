import { closesFence, fenceLine, unwrapWholeReplyFence } from "../../../shared/util/text";

/**
 * The empty variant carries nothing, so no response-derived text can ride a failure into logs or issue reports.
 * Only a fence wrapping the WHOLE reply is unwrapped as a pair (the shared predicate); any other leading fence is
 * judged line by line below, because a description that merely ends with a code block would otherwise lose that
 * block's closer. A title label beyond the first counts only when the line before it reads as a preamble (ends with a
 * colon) or carries the description label, so a label-looking body line cannot hijack the title.
 */

/** A parsed one-shot answer; `empty` means no usable title could be read. */
export type TitleAndDescriptionParse =
	| { readonly kind: "parsed"; readonly title: string; readonly description: string | undefined }
	| { readonly kind: "empty" };

/** "Title:" with any markdown furniture before it and emphasis around the word; case-insensitive. */
const TITLE_LABEL = /^[\s#>*_`-]*title[\s*_`]*:\s*(.*)$/i;

/** "Description:" in the same tolerant shape as TITLE_LABEL. */
const DESCRIPTION_LABEL = /^[\s#>*_`-]*description[\s*_`]*:\s*(.*)$/i;

/** A line of pure markdown furniture (rules, heading marks, emphasis runs) - the labels' noise vocabulary, alone. */
const NOISE_ONLY = /^[\s#>*_`-]+$/;

/** Content lines the title label may sit on; a later label counts only after a preamble or the description label. */
const TITLE_SCAN_LINES = 2;

/** Wrappers stripped from a title when a pair encloses the whole of it and the opener does not recur inside. */
const WRAPPING_PAIRS: readonly (readonly [string, string])[] = [
	["**", "**"],
	["*", "*"],
	["`", "`"],
	['"', '"'],
	["'", "'"],
	["_", "_"],
];

/**
 * Iteratively unwrap symmetric emphasis/quote pairs around the whole text, but only when the delimiter does not recur
 * inside - "`--only` runs `labels`" starts and ends with a backtick without being wrapped in one.
 */
function stripWrappingPairs(text: string): string {
	let unwrapped = text;
	let changed = true;
	while (changed) {
		changed = false;
		for (const [open, close] of WRAPPING_PAIRS) {
			if (unwrapped.length <= open.length + close.length) {
				continue;
			}
			const interior = unwrapped.slice(open.length, unwrapped.length - close.length);
			if (
				unwrapped.startsWith(open) &&
				unwrapped.endsWith(close) &&
				!interior.includes(open) &&
				!interior.includes(close)
			) {
				unwrapped = interior.trim();
				changed = true;
			}
		}
	}
	return unwrapped;
}

/**
 * Strip the emphasis leftover a label capture keeps when the emphasis closed after the colon ("**Title:** X" captures
 * "** X"): a leading emphasis run counts as noise only when whitespace (or nothing) follows, so the opening backtick
 * of "`--flag` does X" survives.
 */
function stripLabelNoise(text: string): string {
	return text.replace(/^[*_`]+(?=\s|$)/, "").trim();
}

function cleanTitle(line: string): string {
	const unwrapped = stripWrappingPairs(line.trim());
	return stripWrappingPairs(stripLabelNoise(unwrapped.replace(/^[#>\s]+/, "")));
}

/** The indexes of the first TITLE_SCAN_LINES lines that carry content: not blank, not markdown furniture alone. */
function contentLineIndexes(lines: readonly string[]): number[] {
	const leading: number[] = [];
	for (let i = 0; i < lines.length && leading.length < TITLE_SCAN_LINES; i++) {
		const line = lines[i] ?? "";
		if (line.trim() !== "" && !NOISE_ONLY.test(line)) {
			leading.push(i);
		}
	}
	return leading;
}

/**
 * The index of the content line carrying the title label, or -1. The first content line always qualifies; a later one
 * only when the first reads as a preamble (ends with a colon) or carries the description label.
 */
function titleLabelIndex(lines: readonly string[], leading: readonly number[], first: string): number {
	for (const [position, index] of leading.entries()) {
		if (!TITLE_LABEL.test(lines[index] ?? "")) {
			continue;
		}
		if (position === 0 || DESCRIPTION_LABEL.test(first) || first.endsWith(":")) {
			return index;
		}
	}
	return -1;
}

/** The lines cut around the title: what came before a labeled title, the title text, and what follows it. */
interface TitleSplit {
	readonly title: string;
	readonly pre: readonly string[];
	readonly rest: readonly string[];
}

/**
 * The lines cut at the title. `titleIndex` is the labelled title's content line, or -1 without a label; `firstContent`
 * is the first content line's index and `first` its trimmed text. Returns the title text with the lines before and
 * after it: a labelled title that came out blank takes the following content line, and an unlabelled reply opening
 * with the description label has no title yet.
 */
function splitAtTitle(lines: readonly string[], titleIndex: number, firstContent: number, first: string): TitleSplit {
	if (titleIndex >= 0) {
		let title = cleanTitle(lines[titleIndex]?.match(TITLE_LABEL)?.[1] ?? "");
		let rest = lines.slice(titleIndex + 1);
		while (title === "" && rest.length > 0 && rest[0] !== undefined && !DESCRIPTION_LABEL.test(rest[0])) {
			title = NOISE_ONLY.test(rest[0]) ? "" : cleanTitle(rest[0]);
			rest = rest.slice(1);
		}
		return { title, pre: lines.slice(0, titleIndex), rest };
	}
	if (DESCRIPTION_LABEL.test(first)) {
		return { title: "", pre: [], rest: lines.slice(firstContent) };
	}
	return { title: cleanTitle(first), pre: [], rest: lines.slice(firstContent + 1) };
}

/**
 * The description's lines: a description labeled before the title comes first, then what follows the title with a
 * description label stripped only when it is the remainder's first content line.
 */
function descriptionLines(pre: readonly string[], rest: readonly string[]): string[] {
	const preDescIndex = pre.findIndex((line) => DESCRIPTION_LABEL.test(line));
	const preLines =
		preDescIndex >= 0
			? [stripLabelNoise(pre[preDescIndex]?.match(DESCRIPTION_LABEL)?.[1] ?? ""), ...pre.slice(preDescIndex + 1)]
			: [];
	const firstRest = rest.findIndex((line) => line.trim() !== "" && !NOISE_ONLY.test(line));
	const restLines =
		firstRest >= 0 && DESCRIPTION_LABEL.test(rest[firstRest] ?? "")
			? [stripLabelNoise(rest[firstRest]?.match(DESCRIPTION_LABEL)?.[1] ?? ""), ...rest.slice(firstRest + 1)]
			: rest;
	return [...preLines, ...restLines];
}

export function parseTitleAndDescription(reply: string): TitleAndDescriptionParse {
	const normalized = reply.replace(/\r\n?/g, "\n").trim();
	const unwrapped = unwrapWholeReplyFence(normalized);
	const all = (unwrapped ?? normalized).split("\n");
	// A leading opener the whole-reply rule did not take (tagged or bare): drop the line alone. Leaving it in would
	// make "```markdown" the title, and removing a trailing fence instead would be the closer-eating this rule exists
	// to avoid.
	const leadingOpener = unwrapped === undefined ? fenceLine(all[0] ?? "") : undefined;
	const closesTitleBlock = (line: string | undefined) =>
		leadingOpener !== undefined && closesFence(line ?? "", leadingOpener);
	const lines = leadingOpener === undefined ? all : all.slice(1);
	const leading = contentLineIndexes(lines);
	const firstContent = leading[0];
	if (firstContent === undefined) {
		return { kind: "empty" };
	}
	const first = (lines[firstContent] ?? "").trim();
	const split = splitAtTitle(lines, titleLabelIndex(lines, leading, first), firstContent, first);
	let title = split.title;
	const closerFollowsTitle = closesTitleBlock(split.rest[0]);
	let description = descriptionLines(split.pre, split.rest).join("\n").trim();
	// Two conditions keep a real code block safe: only a fence CLOSING the leading opener qualifies ("```ts" is an
	// opener and stays, a shorter bare fence is a nested block's own), and it must be the line immediately AFTER the
	// title - a fence arriving later belongs to the description's own first block, with its own prose or label in
	// between.
	if (closerFollowsTitle && closesTitleBlock(description.split("\n", 1)[0])) {
		description = description.split("\n").slice(1).join("\n").trim();
	}
	if (title === "") {
		const promoted = description.split("\n");
		title = cleanTitle(promoted[0] ?? "");
		description = promoted.slice(1).join("\n").trim();
	}
	if (title === "") {
		return { kind: "empty" };
	}
	return { kind: "parsed", title, description: description === "" ? undefined : description };
}
