/**
 * The parser-based reading of a configured URL without its userinfo, for the provider-group identities: a stable key
 * for a configured URL (groupModels.ts, statusWindow.ts, the planner's compare), never shown. Userinfo (user:pass@) is
 * found wherever the WHATWG URL parser reads a URL with it, so every spelling the transport would request is caught by
 * the parser the transport uses. Text that leaves the extension masks userinfo by its shape instead (secretMask.ts).
 */

const SPECIAL_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp", "file"]);
/**
 * A host with its userinfo never runs this long, so a span stops growing when its authority does; a long path never
 * refuses a cut, and a run of credential-shaped words never grows without bound.
 */
const MAX_AUTHORITY_LENGTH = 8192;
/** What a refused URL with an "@" and nothing after its last "@" is shown as. */
const UNPARSEABLE = "[unparseable URL]";
/** Punctuation that may follow a URL in text without belonging to it; dropped as a second end for each candidate. */
const CLOSERS = new Set([")", ",", ".", ";", ":", ">", "]"]);
/** Brackets that may precede a URL in text; skipped as a second start for each candidate. */
const OPENERS = new Set(["(", "[", "<", "{"]);

/** The parser drops these wherever they sit in a URL. */
const IGNORED = /[\t\n\r]/g;

function parsedUrl(text: string): URL | undefined {
	try {
		return new URL(text.startsWith("//") ? `http:${text}` : text);
	} catch {
		return undefined;
	}
}

function isQuote(ch: string | undefined): boolean {
	return ch === '"' || ch === "'";
}

function isSpace(ch: string | undefined): boolean {
	return ch === undefined || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** A space or a line end bounds a run; a tab does not, since the parser drops it ("ht\ttp:" is a scheme to it). */
function isRunBreak(ch: string | undefined): boolean {
	return ch === undefined || ch === " " || ch === "\n" || ch === "\r";
}

/**
 * A quote at the edge of a run delimits a string (a JSON key, its value, a quoted URL); one inside a run is a
 * character of the URL, which the parser accepts in a password ("https://u:pa'ss@host"). After a ":" only a double
 * quote delimits: that is compact JSON ('"a":"b"'), while a single quote there opens a password ("https://u:'a@host").
 */
function isDelimitingQuote(text: string, index: number): boolean {
	const quote = text[index];
	if (!isQuote(quote)) {
		return false;
	}
	const before = text[index - 1];
	const after = text[index + 1];
	const opens = isSpace(before) || ",{[(".includes(before as string) || (before === ":" && quote === '"');
	return opens || isSpace(after) || ":,}])".includes(after as string);
}

function isBoundaryAt(text: string, index: number): boolean {
	return isRunBreak(text[index]) || isDelimitingQuote(text, index);
}

function runStartOf(text: string, index: number, floor: number): number {
	let i = index;
	while (i > floor && !isBoundaryAt(text, i - 1)) {
		i--;
	}
	return i;
}

function runEndOf(text: string, index: number, ceiling: number): number {
	let i = index;
	while (i < ceiling && !isBoundaryAt(text, i)) {
		i++;
	}
	return i;
}

/**
 * Where the authority of a URL sits in its ORIGINAL text: the scheme ends at the first ":" (the parser drops tabs and
 * newlines, never scheme characters), slashes follow it (backslashes too under a special scheme only), the authority
 * ends at the first path, query, or fragment delimiter, and the userinfo at the authority's last "@" (-1 when none).
 */
function authorityOf(span: string): { scheme: number; start: number; end: number; at: number } {
	const scheme = span.startsWith("//") ? 0 : span.indexOf(":") + 1;
	const schemeName = span
		.slice(0, Math.max(scheme - 1, 0))
		.replace(IGNORED, "")
		.trim()
		.toLowerCase();
	const special = scheme === 0 || SPECIAL_SCHEMES.has(schemeName);
	const slashes = special ? "/\\\t\n\r" : "/\t\n\r";
	const delimiters = special ? "/\\?#" : "/?#";
	let start = scheme;
	while (start < span.length && slashes.includes(span[start] as string)) {
		start++;
	}
	let end = span.length;
	for (let i = start; i < span.length; i++) {
		if (delimiters.includes(span[i] as string)) {
			end = i;
			break;
		}
	}
	const at = span.lastIndexOf("@", end - 1);
	return { scheme, start, end, at: at < start ? -1 : at };
}

/**
 * The span with its userinfo cut out of the original text, the slashes normalized to "//" and the characters the
 * parser drops dropped. Cutting the original keeps anything the parser folded into the path, such as a second URL.
 */
function cutUserinfo(span: string): { replacement: string; authorityEnd: number } | undefined {
	const { scheme, end, at } = authorityOf(span);
	if (at === -1) {
		return undefined;
	}
	const replacement = `${span.slice(0, scheme)}//${span.slice(at + 1, end)}`.replace(IGNORED, "");
	return { replacement, authorityEnd: end };
}

/** One cut: the text from `from` to `resumeAt` of the original is shown as `replacement`. */
interface Cut {
	readonly from: number;
	readonly replacement: string;
	readonly resumeAt: number;
}

/** The first index whose value is at least `minimum` in an ascending list. */
function lowerBound(values: readonly number[], minimum: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((values[mid] as number) < minimum) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

/** What one pass over the text yields for every "@" in it, so a text of many URLs or quotes stays linear. */
interface TextScan {
	/** The starts and ends of every run holding an "@", ascending. */
	readonly atRunStarts: readonly number[];
	readonly atRunEnds: readonly number[];
	/** Every delimiting quote and line break, ascending: a URL never crosses one (two lines are two URLs). */
	readonly delimiters: readonly number[];
}

function scanText(text: string): TextScan {
	const atRunStarts: number[] = [];
	const atRunEnds: number[] = [];
	const delimiters: number[] = [];
	for (let i = 0; i < text.length; ) {
		while (i < text.length && isBoundaryAt(text, i)) {
			if (isQuote(text[i]) || text[i] === "\n" || text[i] === "\r") {
				delimiters.push(i);
			}
			i++;
		}
		const end = runEndOf(text, i, text.length);
		if (text.slice(i, end).includes("@")) {
			atRunStarts.push(i);
			atRunEnds.push(end);
		}
		i = end;
	}
	return { atRunStarts, atRunEnds, delimiters };
}

/**
 * The widest candidate around the "@" at `at` that the parser reads as a URL with userinfo, inside the delimiting
 * quotes and line breaks that enclose it (a JSON key and its value are two strings, never one URL). Starts, nearest
 * first: each "//"
 * inside the "@"-run (nearest the "@" first), the run's start, then every run start to its left (down to `floor`)
 * whose run holds a ":" or opens with "//". A start's span grows one "@"-bearing run at a time while the parser reads
 * it as a URL WITH userinfo (a password may hold spaces and a second "@": "http://u:pa@ss word@host"); the first start
 * the parser gives a host settles the "@".
 */
function cutAround(text: string, at: number, floor: number, scan: TextScan): Cut | undefined {
	const { atRunStarts, atRunEnds, delimiters } = scan;
	const delimiterIndex = lowerBound(delimiters, at);
	const segmentStart = Math.max(floor, delimiterIndex === 0 ? 0 : (delimiters[delimiterIndex - 1] as number) + 1);
	const segmentEnd = delimiterIndex < delimiters.length ? (delimiters[delimiterIndex] as number) : text.length;
	const runStart = Math.max(atRunStarts[lowerBound(atRunEnds, at + 1)] as number, segmentStart);
	const starts: number[] = [];
	for (let i = at - 1; i > runStart; i--) {
		if (text[i] === "/" && text[i - 1] === "/") {
			starts.push(i - 1);
			i--;
		}
	}
	starts.push(runStart);
	for (let i = runStart; i > segmentStart; ) {
		let j = i - 1;
		while (j > segmentStart && isBoundaryAt(text, j - 1)) {
			j--;
		}
		const start = runStartOf(text, j, segmentStart);
		const run = text.slice(start, j + 1);
		if (run.includes(":") || run.startsWith("//")) {
			starts.push(start);
		}
		i = start;
	}
	for (const start of starts) {
		for (const candidateStart of OPENERS.has(text[start] as string) ? [start, start + 1] : [start]) {
			let accepted = false;
			let best: Cut | undefined;
			for (let index = lowerBound(atRunEnds, candidateStart + 1); index < atRunEnds.length; index++) {
				const end = atRunEnds[index] as number;
				// Runs never cross a delimiter, so a run ending past the segment lies outside it.
				if (end > segmentEnd) {
					break;
				}
				let trimmed = end;
				while (trimmed > candidateStart && CLOSERS.has(text[trimmed - 1] as string)) {
					trimmed--;
				}
				let parsed: URL | undefined;
				let closedHere = false;
				// Without its closing punctuation first: a span the parser reads either way ends before it ("host:" is a
				// host with an empty port to the parser, and the colon would open the rest of the line as userinfo).
				for (const candidateEnd of trimmed === end ? [end] : [trimmed, end]) {
					const span = text.slice(candidateStart, candidateEnd);
					const read = parsedUrl(span);
					// An opaque "word:" read (no host) is no URL around this "@"; a span with a host is.
					if (read === undefined || read.host === "") {
						continue;
					}
					parsed = read;
					// The parser took the span without its closing punctuation: the URL ends there.
					closedHere = candidateEnd !== end;
					if (read.username !== "" || read.password !== "") {
						const cut = cutUserinfo(span);
						if (cut !== undefined) {
							best = {
								from: candidateStart,
								replacement: cut.replacement,
								resumeAt: candidateStart + cut.authorityEnd,
							};
							// A path, query, or fragment closes the authority: a longer span only grows the path.
							closedHere ||= cut.authorityEnd < span.length || cut.authorityEnd > MAX_AUTHORITY_LENGTH;
						}
					}
					break;
				}
				if (parsed === undefined) {
					break;
				}
				accepted = true;
				// Without userinfo the authority is settled too.
				if (closedHere || (parsed.username === "" && parsed.password === "") || end === segmentEnd) {
					break;
				}
			}
			if (accepted) {
				return best;
			}
		}
	}
	return undefined;
}

function scanCuts(text: string, floor: number, cuts: Cut[]): void {
	const scan = scanText(text);
	let cursor = floor;
	// The next "//" at or after the last search, so the searches over a text of many failed "@" add up to one pass.
	let slashes = -2;
	for (let at = text.indexOf("@", cursor); at !== -1; at = text.indexOf("@", cursor)) {
		const cut = cutAround(text, at, cursor, scan);
		if (cut === undefined) {
			// A later "@" in this run can open a URL only from a "//" between the two: every other start was just judged.
			const end = scan.atRunEnds[lowerBound(scan.atRunEnds, at + 1)] as number;
			if (slashes !== -1 && slashes < at + 1) {
				slashes = text.indexOf("//", at + 1);
			}
			cursor = slashes !== -1 && slashes < end ? slashes : end;
			continue;
		}
		cuts.push(cut);
		cursor = cut.resumeAt;
	}
}

/**
 * Every userinfo cut in a text, ascending and disjoint. A single-line text is tried whole first, as the parser reads
 * a value (a tab counts for nothing, a scheme word inside the password opens no second URL); then every "@" is a
 * candidate and the parser decides how far the URL around it reaches, never across a line break (two lines are two
 * URLs; a password split by one is left to its as-written known value). Prose the parser also reads as a URL is cut
 * too: "Visit https://x.test and email u@x.test" is a spelling the transport would request, with the words as the
 * username.
 *   "Failed at http:user:pass@host:4000: failed"      -> "Failed at http://host:4000: failed"
 *   "at http://user:pass a b c d e@host now"          -> "at http://host now"
 *   "https://u:p@one.test/a https://x:s@two.test/b"   -> "https://one.test/a https://two.test/b"
 *   "Note: contact admin@example.test"                -> unchanged, an opaque "note:" URL has no userinfo
 */
function urlCuts(text: string): Cut[] {
	const cuts: Cut[] = [];
	if (!text.includes("@")) {
		return cuts;
	}
	const whole = /[\n\r]/.test(text) ? undefined : parsedUrl(text.replace(IGNORED, ""));
	const cut = whole !== undefined && (whole.username !== "" || whole.password !== "") ? cutUserinfo(text) : undefined;
	if (cut !== undefined) {
		cuts.push({ from: 0, replacement: cut.replacement, resumeAt: cut.authorityEnd });
	}
	scanCuts(text, cut?.authorityEnd ?? 0, cuts);
	return cuts;
}

/** A text with the cuts of urlCuts applied, nothing else; displayUrl's step for a URL the parser reads. */
function redactUrlCredentials(text: string): string {
	let out = "";
	let cursor = 0;
	for (const cut of urlCuts(text)) {
		out += text.slice(cursor, cut.from) + cut.replacement;
		cursor = cut.resumeAt;
	}
	return out + text.slice(cursor);
}

/**
 * The identity form of one CONFIGURED URL (a provider-group key). A URL without userinfo passes through byte-identical;
 * tabs and newlines go first, since the parser ignores them wherever they sit. A value the parser refuses that holds
 * an "@" anywhere fails closed: only what follows its last "@" is kept.
 *   "http://user:pass@host:bad"  -> "host:bad"
 *   "//user:pass@"               -> "[unparseable URL]"
 */
export function displayUrl(url: string): string {
	const text = url.replace(IGNORED, "");
	if (text.includes("@") && parsedUrl(text) === undefined) {
		const tail = text.slice(text.lastIndexOf("@") + 1);
		return tail.length > 0 ? tail : UNPARSEABLE;
	}
	return redactUrlCredentials(text);
}
