/**
 * The matching algorithm behind the one output door (Logger.redact): every spelling of every known value is found
 * on the ORIGINAL text, the spans are merged, and the Logger replaces each merged span once, so overlapping values
 * leave no tail. Nothing parses a URL and nothing protects a host, so a value that is also a word blanks that word.
 * Known values are the only rule (a configured URL's password is one: serverSync/setting.ts); a URL-userinfo shape
 * rule rewrote spaceless code holding an address.
 *
 * Masking is idempotent: a span CONTAINED in an existing marker (REDACTED_MARKER, or the reveal of a registered long
 * value, its first REVEALED_CHARS and "...") is never a match, so text masked where it entered the extension masks to
 * itself again at every exit, and no exit can write "[[redacted]]" or re-mask a reveal once a shorter value joins the
 * set. A span that merely overlaps a marker is still a match (a long value whose own head reads like its reveal), so
 * the mask cannot be defeated by text shaped like a marker.
 *
 * MIN_SECRET_LENGTH is the floor the known-value collector and the masker share: a shorter value would blank most of
 * every line ("a" in "chat"). A masked span becomes REDACTED_MARKER unless the value is REVEAL_FROM_LENGTH or longer,
 * when its first REVEALED_CHARS show (revealOf) so the user can tell which key a message is about.
 */

export const MIN_SECRET_LENGTH = 4;
export const REDACTED_MARKER = "[redacted]";
const REVEAL_FROM_LENGTH = 20;
const REVEALED_CHARS = 6;

/** The reveal marker of a long value ("sk-liv..."), or undefined for a value too short to reveal. */
export function revealOf(value: string): string | undefined {
	return value.length >= REVEAL_FROM_LENGTH ? `${value.slice(0, REVEALED_CHARS)}...` : undefined;
}
type Span = readonly [from: number, to: number];

/** A found span carrying the raw configured value when it is exactly one raw occurrence of it. */
type ValueSpan = Span & { readonly value?: string };

/** One merged span to replace; `value` is the raw configured value when the span is exactly one raw occurrence of it. */
export interface SecretSpan {
	readonly from: number;
	readonly to: number;
	readonly value: string | undefined;
}

/**
 * One way a line can carry a value. `raw` is the value as typed, the one spelling whose head the Logger may reveal (a
 * head of an escaped spelling would leave a broken escape behind). `folds` marks the spellings whose escape hex
 * matches in either case: the encoded ones, and every spelling of a value holding a complete percent escape (a URL
 * password written encoded).
 */
interface Spelling {
	readonly text: string;
	readonly raw: boolean;
	readonly folds: boolean;
}

/** A complete percent escape, the only "%" whose following hex digits fold: "100%off" and "100%oFf" differ. */
const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;

/** The percent and form encodings; the form one spells a space as "+". */
const ENCODINGS: readonly ((value: string) => string)[] = [
	encodeURIComponent,
	(value) => new URLSearchParams({ v: value }).toString().slice("v=".length),
];

/**
 * The spellings a line can carry a value in: raw, JSON-escaped, percent-encoded, and form-encoded (a "+" per space).
 * Each encoding stands alone: encodeURIComponent throws on a lone surrogate where the form encoding substitutes
 * U+FFFD, and the one must not cost the other.
 */
function spellingsOf(value: string): Spelling[] {
	const holdsEscape = PERCENT_ESCAPE.test(value);
	const spellings: Spelling[] = [{ text: value, raw: true, folds: holdsEscape }];
	const add = (text: string, folds: boolean): void => {
		if (!spellings.some((spelling) => spelling.text === text)) {
			spellings.push({ text, raw: false, folds });
		}
	};
	add(JSON.stringify(value).slice(1, -1), holdsEscape);
	for (const encode of ENCODINGS) {
		try {
			add(encode(value), true);
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
			longest = Math.max(longest, spelling.text.length);
		}
	}
	return longest;
}

function isHexDigit(ch: string): boolean {
	return /[0-9a-fA-F]/.test(ch);
}

/** Whether `spelling[i]` is a hex digit of a complete percent escape ("%HH") in `spelling`. */
function inEscape(spelling: string, i: number): boolean {
	if (spelling.charAt(i - 1) === "%") {
		return isHexDigit(spelling.charAt(i)) && isHexDigit(spelling.charAt(i + 1));
	}

	if (spelling.charAt(i - 2) === "%") {
		return isHexDigit(spelling.charAt(i - 1)) && isHexDigit(spelling.charAt(i));
	}

	return false;
}

/** Whether `spelling` sits at `at` in `text`; the two hex digits of a complete percent escape match in either case. */
function matchesAt(text: string, at: number, spelling: string): boolean {
	for (let i = 0; i < spelling.length; i++) {
		const want = spelling.charAt(i);
		const have = text.charAt(at + i);
		if (want !== have && !(inEscape(spelling, i) && want.toLowerCase() === have.toLowerCase())) {
			return false;
		}
	}
	return true;
}

/** Every occurrence of `spelling` in `text`, overlapping ones included; literal unless the spelling folds its escapes. */
function occurrences(text: string, spelling: string, folds: boolean): Span[] {
	const spans: Span[] = [];
	if (!folds || !PERCENT_ESCAPE.test(spelling)) {
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
function mergedSpans(spans: readonly ValueSpan[]): SecretSpan[] {
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

function markerSpans(text: string, values: readonly string[]): Span[] {
	const markers = occurrences(text, REDACTED_MARKER, false);
	for (const value of values) {
		const reveal = revealOf(value);
		if (reveal !== undefined) {
			markers.push(...occurrences(text, reveal, false));
		}
	}

	return markers;
}

function collectValueSpans(searched: string, value: string, markers: readonly Span[], spans: ValueSpan[]): void {
	const insideMarker = (from: number, to: number): boolean =>
		markers.some(([markerFrom, markerTo]) => markerFrom <= from && to <= markerTo);
	for (const spelling of spellingsOf(value)) {
		for (const [from, to] of occurrences(searched, spelling.text, spelling.folds)) {
			if (insideMarker(from, to)) {
				continue;
			}
			spans.push(Object.assign([from, to] as [number, number], spelling.raw ? { value } : {}));
		}
	}
}

/**
 * Every span of `text` the door replaces: each spelling of each known value, merged, minus any span contained in an
 * existing marker (the idempotence rule). Occurrences are searched up to `upTo` only: a cut needs nothing past it.
 */
export function secretSpans(text: string, values: readonly string[], upTo = text.length): SecretSpan[] {
	const markers = markerSpans(text, values);
	const searched = upTo < text.length ? text.slice(0, upTo) : text;

	const spans: ValueSpan[] = [];
	for (const value of values) {
		if (value.length < MIN_SECRET_LENGTH) {
			continue;
		}
		collectValueSpans(searched, value, markers, spans);
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
