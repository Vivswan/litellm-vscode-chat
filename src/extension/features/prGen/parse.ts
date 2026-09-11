import { stripMarkdownFences } from "../../../shared/util/text";

/**
 * Parse the one-shot PR answer leniently, since models only approximate the label pair asked for.
 * The parse is total, and the empty variant carries nothing, so no response text reaches logs.
 * stripMarkdownFences runs only when its precondition literally holds, exactly TWO fence lines.
 * A description that only ends with a code block would otherwise lose that block's closer.
 * The prompt asks for markdown, so multi-block answers are an expected shape, not an edge case.
 * Any other leading fence costs its own LINE.
 * The one other closer removed is the bare fence right after a title that sat in its own block.
 * A tagged fence, or one arriving later, belongs to the description and stays.
 */

/** A parsed one-shot answer; `empty` means no usable title could be read. */
export type TitleAndDescriptionParse =
	| { readonly kind: "parsed"; readonly title: string; readonly description: string | undefined }
	| { readonly kind: "empty" };

/** A line reading as the title label: optional list/heading/emphasis noise, "title", optional emphasis, a colon. */
const TITLE_LABEL = /^[\s#>*_`-]*title[\s*_`]*:\s*(.*)$/i;

/** The description label, same leniency as the title label. */
const DESCRIPTION_LABEL = /^[\s#>*_`-]*description[\s*_`]*:\s*(.*)$/i;

/** A line of pure markdown furniture (rules, heading marks, emphasis runs) - the labels' noise vocabulary, alone. */
const NOISE_ONLY = /^[\s#>*_`-]+$/;

/** A bare fence line - no language tag. A leading one in the description is the closer of a block the title came out of. */
const BARE_FENCE = /^\s*```\s*$/;

/**
 * How many leading non-empty, non-noise lines may hold the title label. A
 * label beyond the first counts only when the line before it reads as a
 * preamble (ends with a colon) or carries the description label, so a
 * label-looking body line cannot hijack the title.
 */
const TITLE_SCAN_LINES = 2;

const WRAPPING_PAIRS: readonly (readonly [string, string])[] = [
	["**", "**"],
	["*", "*"],
	["`", "`"],
	['"', '"'],
	["'", "'"],
	["_", "_"],
];

/**
 * Iteratively unwrap symmetric emphasis/quote pairs around the whole text,
 * but only when the delimiter does not recur inside - "`--only` runs `labels`"
 * starts and ends with a backtick without being wrapped in one.
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
 * Strip the emphasis leftover a label capture keeps when the emphasis closed
 * after the colon ("**Title:** X" captures "** X"): a leading emphasis run
 * counts as noise only when whitespace (or nothing) follows, so the opening
 * backtick of "`--flag` does X" survives.
 */
function stripLabelNoise(text: string): string {
	return text.replace(/^[*_`]+(?=\s|$)/, "").trim();
}

/** One title line, cleaned of the markdown noise models wrap it in. */
function cleanTitle(line: string): string {
	const unwrapped = stripWrappingPairs(line.trim());
	return stripWrappingPairs(stripLabelNoise(unwrapped.replace(/^[#>\s]+/, "")));
}

/**
 * Parse a reply into title and description.
 * Noise-only lines never hold or block the title.
 * The title label may sit on any of the first TITLE_SCAN_LINES content lines.
 * Preamble before the title label is dropped unless it carries the description.
 * Without a title label, the first content line is the title.
 * A description label is stripped only as the remainder's first content line.
 * A title that still came out blank takes the description's first line.
 * A blank description is `undefined`.
 */
export function parseTitleAndDescription(reply: string): TitleAndDescriptionParse {
	const normalized = reply.replace(/\r\n?/g, "\n").trim();
	// Both ends, never a lone opener: see the module comment.
	// Exactly two fence lines, opening and closing: the helper's precondition
	// stated as itself rather than as a proxy for itself.
	const fenceLines = normalized.split("\n").filter((line) => /^\s*```/.test(line)).length;
	const wholeReplyFenced = normalized.startsWith("```") && /\n```\s*$/.test(normalized) && fenceLines === 2;
	const all = (wholeReplyFenced ? stripMarkdownFences(normalized) : normalized).split("\n");
	// A leading opener the helper did not take (tagged or bare): drop the line
	// alone. Leaving it in would make "```markdown" the title, and removing a
	// trailing fence instead would be the closer-eating this rule exists to
	// avoid.
	const titleFromFencedBlock = !wholeReplyFenced && /^\s*```/.test(all[0] ?? "");
	const lines = titleFromFencedBlock ? all.slice(1) : all;
	const leading: number[] = [];
	for (let i = 0; i < lines.length && leading.length < TITLE_SCAN_LINES; i++) {
		const line = lines[i] ?? "";
		if (line.trim() !== "" && !NOISE_ONLY.test(line)) {
			leading.push(i);
		}
	}
	const firstContent = leading[0];
	if (firstContent === undefined) {
		return { kind: "empty" };
	}
	const first = (lines[firstContent] ?? "").trim();
	const titleIndex =
		leading.find((i, position) => {
			if (!TITLE_LABEL.test(lines[i] ?? "")) {
				return false;
			}
			return position === 0 || DESCRIPTION_LABEL.test(first) || first.endsWith(":");
		}) ?? -1;
	let title = "";
	let pre: string[] = [];
	let rest: string[];
	if (titleIndex >= 0) {
		pre = lines.slice(0, titleIndex);
		title = cleanTitle(lines[titleIndex]?.match(TITLE_LABEL)?.[1] ?? "");
		rest = lines.slice(titleIndex + 1);
		while (title === "" && rest.length > 0 && rest[0] !== undefined && !DESCRIPTION_LABEL.test(rest[0])) {
			title = NOISE_ONLY.test(rest[0]) ? "" : cleanTitle(rest[0]);
			rest = rest.slice(1);
		}
	} else if (DESCRIPTION_LABEL.test(first)) {
		rest = lines.slice(firstContent);
	} else {
		title = cleanTitle(first);
		rest = lines.slice(firstContent + 1);
	}
	// Whether the title's own block closes on the very next line. Anything else
	// between them - a Description: label, prose - means a leading fence in the
	// description belongs to the description.
	const closerFollowsTitle = BARE_FENCE.test(rest[0] ?? "");
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
	let description = [...preLines, ...restLines].join("\n").trim();
	// A reply whose title sat inside a code block leaves that block's closer at
	// the head of the description; it is furniture, not content. Two conditions
	// keep a real code block safe: only a BARE fence qualifies ("```ts" is an
	// opener and stays), and it must be the line immediately AFTER the title -
	// a fence arriving later belongs to the description's own first block, with
	// its own prose or label in between.
	if (titleFromFencedBlock && closerFollowsTitle && BARE_FENCE.test(description.split("\n", 1)[0] ?? "")) {
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
