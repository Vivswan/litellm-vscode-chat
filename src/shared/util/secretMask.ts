/**
 * The matching algorithm behind the one output door (Logger.redact): every spelling of every known value and every
 * URL userinfo is found on the ORIGINAL text, the spans are merged, and the Logger replaces each merged span once,
 * so overlapping values leave no tail. Nothing parses a URL and nothing protects a host, so a value that is also a
 * word blanks that word.
 */

/**
 * The floor the known-value collector and the masker share: a shorter value would blank most of every line ("a" in
 * "chat").
 */
export const MIN_SECRET_LENGTH = 4;
/**
 * URL userinfo by shape alone: everything from the scheme's "//" to the last "@" before the path, query, or fragment,
 * so a user with or without a password goes, a password that itself holds an "@" goes whole, and an address in a
 * query ("?email=admin@example.com") is no userinfo. Found on the original text like the known values, so a value
 * that eats the "@" ("@host") cannot hide the userinfo from this rule.
 */
const URL_USERINFO = /:\/\/([^\s/?#]*)@/g;

type Span = readonly [from: number, to: number];

/** One merged span to replace; `value` is the raw configured value when the span is exactly one occurrence of it. */
export interface SecretSpan {
	readonly from: number;
	readonly to: number;
	readonly value: string | undefined;
}

const ENCODINGS: readonly ((value: string) => string)[] = [
	encodeURIComponent,
	(value) => new URLSearchParams({ v: value }).toString().slice("v=".length),
];

/**
 * The spellings a line can carry a value in: raw, JSON-escaped, percent-encoded, and form-encoded (a "+" per space).
 * Each encoding stands alone: encodeURIComponent throws on a lone surrogate where the form encoding substitutes
 * U+FFFD, and the one must not cost the other.
 */
function spellingsOf(value: string): ReadonlySet<string> {
	const spellings = new Set([value, JSON.stringify(value).slice(1, -1)]);
	for (const encode of ENCODINGS) {
		try {
			spellings.add(encode(value));
		} catch {
			// This encoding has no spelling for the value; a logging call must not throw over it.
		}
	}
	return spellings;
}

function longestSpelling(values: readonly string[]): number {
	let longest = 0;
	for (const value of values) {
		for (const spelling of spellingsOf(value)) {
			longest = Math.max(longest, spelling.length);
		}
	}
	return longest;
}

function isHexDigit(ch: string): boolean {
	return /[0-9a-fA-F]/.test(ch);
}

/** Whether `spelling` sits at `at` in `text`; the two hex digits of a percent escape match in either case. */
function matchesAt(text: string, at: number, spelling: string): boolean {
	for (let i = 0; i < spelling.length; i++) {
		const want = spelling.charAt(i);
		const have = text.charAt(at + i);
		if (want === have) {
			continue;
		}
		const inEscape = spelling.charAt(i - 1) === "%" || (i >= 2 && spelling.charAt(i - 2) === "%");
		if (!(inEscape && isHexDigit(want) && want.toLowerCase() === have.toLowerCase())) {
			return false;
		}
	}
	return true;
}

/** Every occurrence of `spelling` in `text`, overlapping ones included. */
function occurrences(text: string, spelling: string): Span[] {
	const spans: Span[] = [];
	if (!spelling.includes("%")) {
		for (let at = text.indexOf(spelling); at !== -1; at = text.indexOf(spelling, at + 1)) {
			spans.push([at, at + spelling.length]);
		}
		return spans;
	}
	const first = spelling.charAt(0);
	for (
		let at = text.indexOf(first);
		at !== -1 && at + spelling.length <= text.length;
		at = text.indexOf(first, at + 1)
	) {
		if (matchesAt(text, at, spelling)) {
			spans.push([at, at + spelling.length]);
		}
	}
	return spans;
}

/**
 * Overlapping or touching spans merged into disjoint ascending ones, so each is replaced once and no tail survives;
 * a span that absorbed another loses its value, since the reveal of one value must not show a character of the next.
 */
function mergedSpans(spans: readonly (Span & { readonly value?: string })[]): SecretSpan[] {
	const merged: { from: number; to: number; value: string | undefined }[] = [];
	for (const span of [...spans].sort((a, b) => a[0] - b[0])) {
		const [from, to] = span;
		const last = merged[merged.length - 1];
		if (last !== undefined && from <= last.to) {
			last.to = Math.max(last.to, to);
			last.value = undefined;
		} else {
			merged.push({ from, to, value: span.value });
		}
	}
	return merged;
}

/**
 * Every span of `text` the door replaces: each spelling of each known value and each URL userinfo, merged. Value
 * occurrences are searched up to `upTo` only and userinfo runs only where they start before it (a cut needs nothing
 * past it); a run that starts before the cut is still read to its end, since it may cross the cut.
 */
export function secretSpans(text: string, values: readonly string[], upTo = text.length): SecretSpan[] {
	const spans: (Span & { readonly value?: string })[] = [];
	const searched = upTo < text.length ? text.slice(0, upTo) : text;
	for (const value of values) {
		if (value.length >= MIN_SECRET_LENGTH) {
			for (const spelling of spellingsOf(value)) {
				for (const span of occurrences(searched, spelling)) {
					spans.push(Object.assign([span[0], span[1]] as [number, number], { value }));
				}
			}
		}
	}
	for (const userinfo of text.matchAll(URL_USERINFO)) {
		// Lazy: the first run starting past `upTo` ends the walk, so a cut never pays for the discarded suffix; a run
		// that starts before the cut is read to its "@" wherever that is, since it may cross the cut.
		if (userinfo.index >= upTo) {
			break;
		}
		const from = userinfo.index + "://".length;
		spans.push([from, from + (userinfo[1] as string).length]);
	}
	return mergedSpans(spans);
}

/**
 * Where a cut of `text` meant for `at` may land without splitting anything the mask would replace: `at` itself, or
 * the start of the span astride it, so a prefix cut there holds whole values or none and masks the same in either
 * mode.
 */
export function safeCut(text: string, at: number, values: readonly string[]): number {
	// Only occurrences that can reach `at` matter, so the search stops one spelling past it: the work is bounded by
	// the cut, not by the text, and a megabyte line with a repeated value does not build a million spans.
	for (const { from, to } of secretSpans(text, values, at + longestSpelling(values))) {
		if (from < at && at < to) {
			return from;
		}
	}
	return at;
}
