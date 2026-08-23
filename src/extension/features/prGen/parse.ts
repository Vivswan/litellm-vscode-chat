import { stripMarkdownFences } from "../../../shared/util/text";

/**
 * The lenient parse of the one-shot PR answer. The prompt asks for a
 * Title:/Description: pair; models approximate it with label case drift,
 * markdown emphasis, labels on their own line, a missing Description label,
 * no labels at all, a short preamble, or a fence around the whole reply.
 * Total: every reply maps to a value, and the no-usable-answer variant
 * carries nothing, so no response-derived text can ride a failure into logs
 * or issue reports.
 *
 * Fence handling uses the shared stripMarkdownFences only where that helper's
 * documented precondition literally holds - a reply that IS a single fenced
 * block, which means exactly TWO fence lines, the first and the last. Testing
 * only the first and last lines is not that test: a reply whose description
 * merely ends with a code block passes it, and the helper then removes that
 * block's closer, leaving the rest of the PR body rendering as code. The
 * prompt asks for markdown, so multi-block answers are an expected shape here,
 * not an edge case.
 *
 * Every other leading fence costs its own LINE and nothing else. No closing
 * fence anywhere in the reply is removed outside the single-block case, so a
 * wrong guess about the reply's structure can leave a stray line but can never
 * unterminate a block.
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
 * Parse a reply into title and description. Noise-only lines never hold or
 * block the title. The title label may sit on any of the first
 * TITLE_SCAN_LINES content lines (preamble before it is dropped unless it
 * carries the description); a blank labeled title takes the following content
 * line. Without a title label, the first content line is the title.
 * Everything after the title is the description, with a description label
 * stripped only when it is the remainder's first content line - later
 * label-looking lines are content and are kept. A title that still came out
 * blank takes the description's first line. A blank description is
 * `undefined`; no usable title at all is the empty variant.
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
