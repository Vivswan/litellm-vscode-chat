/**
 * The one URL-credential scrub for every surface that echoes a configured URL: userinfo (user:pass@) is cut from the
 * original text wherever the WHATWG URL parser reads a URL with userinfo, so every spelling the transport would
 * request is caught by the parser the transport uses.
 *   toasts, chat errors, the dashboard, English mirrors -> credentialFreeText (errorMapping.ts): the cuts, then the
 *                                                            known values outside every URL span's scheme, host, and
 *                                                            path (urlSpans)
 *   the OAuth token-endpoint texts (auth.ts)             -> displayUrl where the message is built
 *   every log line and log data field                   -> KnownSecrets.redact (knownSecrets.ts), which takes the
 *                                                            cuts from urlCuts and the known values in one pass
 *   agent-tool results                                   -> urlScrubbingReplacer with its default, the cuts alone
 *   the issue report                                     -> redactSecrets, which starts from redactUrlCredentials
 *   the known-value collector                            -> configuredUserinfo, the same finder and parser
 */

import { URL_FIELD_KEYS } from "../serverEntry";

const SPECIAL_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp", "file"]);
/**
 * A host with its userinfo never runs this long, so a span stops growing when its authority does; a long path never
 * refuses a cut, and a run of credential-shaped words never grows without bound.
 */
export const MAX_AUTHORITY_LENGTH = 8192;
/** The known-value redaction's marker (knownSecrets.ts). */
export const REDACTED = "[redacted]";
/** What a refused URL with an "@" and nothing after its last "@" is shown as. */
const UNPARSEABLE = "[unparseable URL]";
/** A refused URL yields at most this many userinfo candidates (one per "@"); a configured value never has more. */
const MAX_USERINFO_CANDIDATES = 64;
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

/** A userinfo text whole, and its user and password split at the first ":"; empty parts are no values. */
function userinfoCandidates(userinfo: string): string[] {
	const colon = userinfo.indexOf(":");
	const split = colon === -1 ? [] : [userinfo.slice(0, colon), userinfo.slice(colon + 1)];
	return [userinfo, ...split].filter((part) => part !== "");
}

/**
 * The userinfo of one configured URL as a line may echo it (the spellings are the matcher's). Read by the parser,
 * with the leading and trailing whitespace and the tabs and newlines it drops: the user and the password as it reads
 * them, plus as written in the setting. Refused by the parser ("http://user:pa?ss/extra@host"), no request carries
 * the text, but a message quoting the setting does: the text from the scheme separator up to EACH "@" before the end
 * of the value is a candidate, whole and split (whitespace and quotes are part of a typed value), deduplicated and
 * capped at MAX_USERINFO_CANDIDATES. An opaque URL ("mailto:admin@example.test") has no userinfo to the parser and
 * yields nothing.
 */
export function configuredUserinfo(url: string): string[] {
	const text = url.trim();
	const whole = parsedUrl(text.replace(IGNORED, ""));
	const { scheme, start, at } = authorityOf(text);
	if (whole !== undefined) {
		if (whole.username === "" && whole.password === "") {
			return [];
		}
		const read = [whole.username, whole.password].filter((part) => part !== "");
		return [...read, ...(at === -1 ? [] : userinfoCandidates(text.slice(start, at)))];
	}
	if (scheme === 0 && !text.startsWith("//")) {
		return [];
	}
	const parts = new Set<string>();
	let mark = text.indexOf("@", start);
	for (let candidates = 0; mark !== -1 && candidates < MAX_USERINFO_CANDIDATES; candidates++) {
		for (const part of userinfoCandidates(text.slice(start, mark))) {
			parts.add(part);
		}
		mark = text.indexOf("@", mark + 1);
	}
	return [...parts];
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
export interface Cut {
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
export function urlCuts(text: string): Cut[] {
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

/** One URL in a text, from its scheme to the end of its run, less the closers the parser refuses. */
export interface UrlSpan {
	readonly from: number;
	readonly to: number;
}

/**
 * A scheme at the regex's lastIndex, a tab allowed anywhere since the parser drops it ("h\tttp:" is a scheme to it);
 * sticky and capped at 64 characters, so every word start in a long token costs one bounded probe.
 */
const SCHEME_AT = /[A-Za-z][A-Za-z0-9+.\t-]{0,63}:/y;
/**
 * A character a credential is spelled with (base64 and its URL-safe variant, a JWT's dots): a scheme right after one
 * sits inside a token ("YWJj/https:Q7") and opens no URL, while "URL:https://x" opens one after its colon.
 */
const TOKEN_CHAR = /[A-Za-z0-9+/._~-]/;
/** A run of this many "word:" candidates is prose, not a URL; every candidate costs a parse of the rest of the run. */
const MAX_SPAN_CANDIDATES = 16;
/** Each closer peeled costs a parse of the run, so the peeling stops here; a URL in prose rarely carries more. */
const MAX_SPAN_CLOSERS = 8;

/**
 * The first scheme in one run the parser reads with a host ("http:" with any slashes the parser takes, backslashes and
 * none included), at a word start: the run's start, a tab, or a character no credential is spelled with. A bare "//"
 * opens nothing, since a base64 value can begin with one. The closers prose hangs on a URL come off one at a time from
 * the whole run, so "[2001:db8::1])" keeps its host's "]" and loses the ")". An opaque "word:" read has no host and is
 * prose.
 */
function spanInRun(run: string): UrlSpan | undefined {
	let candidates = 0;
	for (let from = 0; from < run.length && candidates < MAX_SPAN_CANDIDATES; from++) {
		const before = run[from - 1];
		const atWordStart = before === undefined || before === "\t" || !TOKEN_CHAR.test(before);
		if (!atWordStart) {
			continue;
		}
		SCHEME_AT.lastIndex = from;
		if (!SCHEME_AT.test(run)) {
			continue;
		}
		candidates++;
		for (let to = run.length; to > from && to > run.length - MAX_SPAN_CLOSERS - 1; to--) {
			const read = parsedUrl(run.slice(from, to));
			if (read !== undefined && read.host !== "") {
				return { from, to };
			}
			if (!CLOSERS.has(run[to - 1] as string)) {
				break;
			}
		}
	}
	return undefined;
}

/**
 * Every run the parser reads as a URL with a host from a scheme at a word start, ascending, for a seam that treats URL
 * text apart from prose. The same boundaries as the userinfo cuts: a run ends at a space, a line break, or a delimiting
 * quote. Not read: a bare "//" (a base64 value can begin with one), a scheme past 64 characters, and a run's 17th
 * "word:" candidate on.
 *   "at (https://[2001:db8::1]). and key=https://y.test/b"  -> "https://[2001:db8::1]", "https://y.test/b"
 *   "http:proxy.test/v1 and admin@mail.test"   -> "http:proxy.test/v1"
 */
export function urlSpans(text: string): UrlSpan[] {
	const spans: UrlSpan[] = [];
	const push = (start: number, stop: number): void => {
		// The parser trims C0 controls and spaces at both ends of a URL; the span ends where the URL does.
		let from = start;
		let to = stop;
		while (to > from && text.charCodeAt(to - 1) <= 0x20) {
			to--;
		}
		while (from < to && text.charCodeAt(from) <= 0x20) {
			from++;
		}
		spans.push({ from, to });
	};
	for (let i = 0; i < text.length; ) {
		while (i < text.length && isBoundaryAt(text, i)) {
			i++;
		}
		const end = runEndOf(text, i, text.length);
		const span = spanInRun(text.slice(i, end));
		if (span !== undefined) {
			push(i + span.from, i + span.to);
		}
		i = end;
	}
	// Every URL the userinfo cuts read is a span too (a password may hold spaces, so such a URL crosses runs): the
	// finder yields everything displayUrl would cut, and the run holding the authority's end carries the URL to its end.
	for (const cut of urlCuts(text)) {
		if (!spans.some((span) => span.from <= cut.from && cut.from < span.to)) {
			push(cut.from, runEndOf(text, Math.max(cut.from, cut.resumeAt - 1), text.length));
		}
	}
	spans.sort((a, b) => a.from - b.from);
	return spans;
}

/** Strip URL-embedded credentials from a text: the cuts of urlCuts applied, nothing else. */
export function redactUrlCredentials(text: string): string {
	let out = "";
	let cursor = 0;
	for (const cut of urlCuts(text)) {
		out += text.slice(cursor, cut.from) + cut.replacement;
		cursor = cut.resumeAt;
	}
	return out + text.slice(cursor);
}

/** A configured URL field fails closed (displayUrl); any other string is free text under the parser-based scrub. */
function scrubByKey(key: string, value: string): string {
	return URL_FIELD_KEYS.has(key) ? displayUrl(value) : redactUrlCredentials(value);
}

/**
 * A JSON.stringify replacer under which every serialized string is scrubbed: by default a URL field fails closed and
 * any other string takes the free-text scrub (scrubByKey); the Logger passes its one-pass redaction for every string.
 * A replacer rather than a scrubbed copy of the tree: a Date or a URL value still serializes through its own toJSON,
 * and the scrub runs per string, never over the text, where a pass would run from one field's "//" to the next
 * field's "@".
 */
export function urlScrubbingReplacer(scrub?: (text: string) => string): (key: string, value: unknown) => unknown {
	return (key, value) =>
		typeof value === "string" ? (scrub === undefined ? scrubByKey(key, value) : scrub(value)) : value;
}

/**
 * The display form of one CONFIGURED value (a URL field, a card's string). A URL without userinfo passes through
 * byte-identical, so pinned message texts never change for the common case; tabs and newlines go first, since the
 * parser ignores them wherever they sit. A value the parser refuses that holds an "@" anywhere fails closed: only what
 * follows its last "@" is shown. Free text (a log line) takes redactUrlCredentials instead, where an "@" is prose
 * until the parser reads a URL around it.
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
