/**
 * Every secret VALUE the extension knows, replaced wherever it appears, in one pass with the URL-credential cuts of
 * displayUrl.ts. Response-derived text (a 403 body quoting the key) and a URL spelling the parser refuses have no shape
 * to scrub by, so the configured values themselves are the handle; the Logger redacts with one KnownSecrets, built so
 * a model-facing exit boundary can share it. Collected over-inclusively from every raw record by one reader
 * (collectableEntries): every string at every secret position, the one the parser selects and the ones it passes
 * over, in an entry accepted or rejected.
 *   inline secret values     -> every flat secret field and every nested position of SECRET_FIELD_NESTED_PATHS
 *   credential header values -> every raw header isCredentialHeader names, the entry's carrier among them
 *   URL userinfo             -> every configured URL (base, token, mcp) through configuredUserinfo, the same finder
 *                               and parser the cut uses
 *   SecretStorage blobs      -> every stored value under every declared label
 * Runtime-minted values join them in a second, separately owned set (mint/retire): an OAuth access token the
 * identity provider issued (auth.ts OAuthTokenSource) and a dashboard draft's credentials for the length of its probe
 * (testDraftConnection.ts). Neither set's refresh disturbs the other; the matcher treats both alike.
 * Every value is then matched in every spelling a line can carry (spellingsOf): raw, JSON-escaped, percent-encoded,
 * decoded, and the bare token of a scheme-prefixed value, whatever position the value came from; every percent escape
 * in any spelling matches in either hex case.
 */

import { isCredentialHeader, SECRET_FIELD_IDS, SECRET_FIELD_NESTED_PATHS } from "../serverEntry";
import { type Cut, configuredUserinfo, MAX_AUTHORITY_LENGTH, REDACTED, urlCuts } from "./displayUrl";
import { collapseWhitespace } from "./errorText";
import { isHeaderScalar, usableHttpText } from "./headers";
import { isRecord, valueAt } from "./json";

/**
 * The whole-log floor: a one- or two-character value would blank most of every line ("a" in "chat"), and the URL cut
 * still covers it there. A caller whose text is one short detail takes every value through `redactShort`.
 */
const MIN_VALUE_LENGTH = 3;
/**
 * Whole-text passes run in order until one changes nothing, at most this many. A value whose raw or derived spelling
 * contains the literal marker can surface only after the pass that wrote the marker, so such a configuration may
 * need more passes than this and is the recorded residue; no real credential is spelled that way.
 */
const MAX_PASSES = 3;

/** The surface a runtime owner of secret values holds; it must be the Logger's instance, never one of its own. */
export type KnownSecretCustody = Pick<KnownSecrets, "mint" | "retire" | "redact" | "redactShort">;

/** What the collector reads of one raw record: every string at its URL, secret, header, and carrier positions. */
export interface CollectableEntry {
	readonly urls: readonly string[];
	readonly secrets: readonly string[];
	readonly headers: Readonly<Record<string, string>>;
	readonly carriers: readonly string[];
}

/**
 * The collectable view of EVERY raw record, over-inclusive by design: every string at every secret position is a
 * value, the one the parser selects and the ones it passes over, in an entry it accepts or rejects (an auth conflict,
 * a bad URL), since a line can quote any of them. SECRET_FIELD_NESTED_PATHS stays the one table of the positions.
 *   URL fields    -> baseUrl, the flat and the nested token URL, mcp.url
 *   secret values -> every flat secret field and every nested position of the table
 *   headers       -> every raw header entry with a scalar value, the normalizer's rejections included
 *   carriers      -> the flat virtualKeyHeader and the header beside each nested virtual-key value
 */
export function collectableEntries(raw: unknown): CollectableEntry[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const strings = (values: readonly unknown[]): string[] =>
		values.map(usableHttpText).filter((value): value is string => value !== undefined);
	return raw.filter(isRecord).map((record) => {
		// A null prototype: a raw header named "__proto__" must become an own entry, not reach the inherited setter.
		const headers: Record<string, string> = Object.create(null);
		if (isRecord(record.headers)) {
			for (const [name, value] of Object.entries(record.headers)) {
				if (isHeaderScalar(value)) {
					headers[name] = String(value);
				}
			}
		}
		return {
			urls: strings([
				record.baseUrl,
				record.oauthTokenUrl,
				valueAt(record, ["auth", "oauth", "tokenUrl"]),
				valueAt(record, ["mcp", "url"]),
			]),
			secrets: strings(
				SECRET_FIELD_IDS.flatMap((id) => [
					record[id],
					...SECRET_FIELD_NESTED_PATHS[id].map((path) => valueAt(record, path)),
				])
			),
			headers,
			carriers: strings([
				record.virtualKeyHeader,
				...SECRET_FIELD_NESTED_PATHS.virtualKeyValue.map((path) => valueAt(record, [...path.slice(0, -1), "header"])),
			]),
		};
	});
}

/** The known values of the parsed entries plus the stored values read for them; empty ones out, deduplicated. */
export function collectKnownSecretValues(
	entries: readonly CollectableEntry[],
	stored: Iterable<string | undefined>
): readonly string[] {
	const values = new Set<string>();
	const add = (value: string | undefined): void => {
		if (value !== undefined && value.length > 0) {
			values.add(value);
		}
	};
	for (const entry of entries) {
		for (const secret of entry.secrets) {
			add(secret);
		}
		for (const url of entry.urls) {
			for (const part of configuredUserinfo(url)) {
				add(part);
			}
		}
		for (const [name, value] of Object.entries(entry.headers)) {
			if (isCredentialHeader(name, entry.carriers)) {
				add(value);
			}
		}
	}
	for (const value of stored) {
		add(value);
	}
	return [...values];
}

function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The token after an authentication scheme: a server echoes "marker" from "Bearer marker" without the scheme. */
const SCHEME_PREFIXED = /^(?:Bearer|Basic|Token)\s+(\S+)$/i;

/**
 * Every spelling of one value, whatever position it came from: raw, inside a serialized card, percent-encoded, decoded
 * (a stored "pa%3Fss" echoed as "pa?ss"), the bare token of a scheme-prefixed value with its own spellings, and the
 * spellings the transport or a server makes of the value, each with its own: trimmed (a header " Bearer token-Q7 " is
 * sent as "Bearer token-Q7"), without the tab, CR, and LF a URL drops ("tok-\t1234" inside a host reads "tok-1234"),
 * and with its whitespace collapsed (an identity provider describes "alpha  beta" as "alpha beta").
 */
function spellingsOf(value: string): string[] {
	const spellings = [value, JSON.stringify(value).slice(1, -1)];
	try {
		spellings.push(encodeURIComponent(value));
	} catch {
		// A lone surrogate has no percent form; the other spellings still count.
	}
	try {
		const decoded = decodeURIComponent(value);
		if (decoded !== value) {
			spellings.push(decoded, JSON.stringify(decoded).slice(1, -1));
		}
	} catch {
		// Not percent-encoded text; nothing to decode.
	}
	const token = SCHEME_PREFIXED.exec(value)?.[1];
	if (token !== undefined) {
		spellings.push(...spellingsOf(token));
	}
	for (const sent of new Set([value.trim(), value.replace(/[\t\n\r]/g, ""), collapseWhitespace(value)])) {
		if (sent !== value && sent !== "") {
			spellings.push(...spellingsOf(sent));
		}
	}
	return spellings;
}

/** A hex digit as a class matching either case ("[fF]"); a decimal digit stays itself. */
function eitherCase(hex: string): string {
	const lower = hex.toLowerCase();
	const upper = hex.toUpperCase();
	return lower === upper ? lower : `[${lower}${upper}]`;
}

/**
 * The pattern of one form: a literal, with each percent escape in it ("%3F", from encodeURIComponent or from a
 * pre-encoded configured value) matched in either hex case.
 */
function formPattern(form: string): string {
	return escapeRegExp(form).replace(
		/%([0-9A-Fa-f])([0-9A-Fa-f])/g,
		(_, a: string, b: string) => `%${eitherCase(a)}${eitherCase(b)}`
	);
}

type Span = [number, number];

interface Matcher {
	readonly pattern: RegExp | undefined;
	readonly longestForm: number;
}

const NO_MATCHER: Matcher = { pattern: undefined, longestForm: 0 };

/** A value under the floor is left out before its spellings: "/" has the three-character spelling "%2F". */
function compileMatcher(values: Iterable<string>, floor: number): Matcher {
	const forms = new Set<string>();
	for (const value of values) {
		if (value.length < floor) {
			continue;
		}
		for (const spelling of spellingsOf(value)) {
			if (spelling.length >= floor) {
				forms.add(spelling);
			}
		}
	}
	const alternatives = [...forms].sort((a, b) => b.length - a.length);
	return alternatives.length === 0
		? NO_MATCHER
		: {
				pattern: new RegExp(alternatives.map(formPattern).join("|"), "g"),
				longestForm: alternatives[0]?.length ?? 0,
			};
}

/** Overlapping or adjacent spans merged into disjoint ascending ones, so each is replaced once and no tail survives. */
function mergedSpans(spans: Span[]): Span[] {
	spans.sort((a, b) => a[0] - b[0]);
	const merged: Span[] = [];
	for (const [from, to] of spans) {
		const last = merged[merged.length - 1];
		if (last !== undefined && from <= last[1]) {
			last[1] = Math.max(last[1], to);
		} else {
			merged.push([from, to]);
		}
	}
	return merged;
}

/** Whether [from, to) lies inside one of the disjoint ascending `spans`. */
function insideAny(spans: readonly Span[], from: number, to: number): boolean {
	let low = 0;
	let high = spans.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((spans[mid] as Span)[0] <= from) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low > 0 && (spans[low - 1] as Span)[1] >= to;
}

/** `text` from `from` to `to`, the parts of `spans` inside it replaced by the marker. */
function redactedSlice(text: string, from: number, to: number, spans: readonly Span[]): string {
	let out = "";
	let cursor = from;
	for (const [spanFrom, spanTo] of spans) {
		if (spanTo <= from) {
			continue;
		}
		if (spanFrom >= to) {
			break;
		}
		const pieceFrom = Math.max(spanFrom, cursor);
		const pieceTo = Math.min(spanTo, to);
		// A span the cuts consumed entirely leaves no piece here, and no marker.
		if (pieceTo > pieceFrom) {
			out += `${text.slice(cursor, pieceFrom)}${REDACTED}`;
			cursor = pieceTo;
		}
	}
	return out + text.slice(cursor, to);
}

/**
 * The live known-value set and its matchers, compiled once per change with the longest form first so it wins where
 * two start together; `redact` is one pass over the ORIGINAL text: the
 * URL cuts the parser judges on it, and every known-value occurrence found on it, so neither can hide the other's
 * input, and overlapping or adjacent occurrences merge into one marker so no tail survives. The pass repeats while it
 * changes the text, at most MAX_PASSES times; a configuration free of the literal marker in any spelling settles
 * within them, so a string redacted as a field and again as a line reads the same.
 *   ["abc123", "123xyz"] on "abc123xyz"                     -> "[redacted]", never "[redacted]xyz"
 *   ["@host.test"] on "https://alice:pw-Q7@host.test"       -> "https://host.test"
 *   ["dev"] on "https://u:pw@proxy.dev"                     -> "https://proxy.[redacted]"
 *   ["user", "pa?ss"] on "http://user:pa?ss@host:4000"      -> "http://host:4000": the parser refuses the original,
 *                                                              reads the redacted spelling, and the cut lands
 * A `keep` marker: an occurrence lying inside one of its occurrences is left alone (a value equal to the marker is
 * never replaced); a value that contains the marker is replaced with it ("pre<P>post" goes, a bare "<P>" elsewhere
 * stays). The redaction marker itself is always kept, so a value inside it ("red") never nests another. A `budget`
 * cuts a long text (a 1 MB stack) before the pass; a value or URL straddling the cut is redacted whole, never split.
 *
 * `set` replaces the configured values; `mint` and `retire` keep the runtime ones, counted per value so two owners
 * minting the same token (the live client and a draft probe's throwaway one) each retire only their own hold. Both
 * sets feed two matchers over the same values: `redact` at the whole-log floor, `redactShort` with none.
 */
export class KnownSecrets {
	private whole: Matcher = NO_MATCHER;
	private short: Matcher = NO_MATCHER;
	private configured: readonly string[] = [];
	private readonly minted = new Map<string, number>();

	/** The values in force, configured and minted, for a caller that redacts over a union of them and its own. */
	values(): readonly string[] {
		return [...new Set([...this.configured, ...this.minted.keys()])];
	}

	set(values: readonly string[]): void {
		this.configured = values.filter((value) => value.length > 0);
		this.compile();
	}

	mint(value: string): void {
		if (value.length === 0) {
			return;
		}
		const holds = this.minted.get(value) ?? 0;
		this.minted.set(value, holds + 1);
		if (holds === 0) {
			this.compile();
		}
	}

	/** One hold fewer; the last holder's retire ends the minted value, while a configured copy of it stays known. */
	retire(value: string): void {
		const holds = this.minted.get(value);
		if (holds === undefined) {
			return;
		}
		if (holds > 1) {
			this.minted.set(value, holds - 1);
		} else {
			this.minted.delete(value);
			this.compile();
		}
	}

	private compile(): void {
		const values = this.values();
		this.whole = compileMatcher(values, MIN_VALUE_LENGTH);
		this.short = compileMatcher(values, 1);
	}

	/** Every known-value occurrence in `text` outside the keep markers, merged and ascending. */
	private spans(matcher: Matcher, text: string, keep: readonly string[]): Span[] {
		const pattern = matcher.pattern;
		if (pattern === undefined) {
			return [];
		}
		const kept: Span[] = [];
		for (const marker of [REDACTED, ...keep]) {
			for (let at = marker.length === 0 ? -1 : text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
				kept.push([at, at + marker.length]);
			}
		}
		const markers = mergedSpans(kept);
		const found: Span[] = [];
		pattern.lastIndex = 0;
		let match = pattern.exec(text);
		while (match !== null) {
			const from = match.index;
			let to = from + match[0].length;
			if (!insideAny(markers, from, to)) {
				found.push([from, to]);
			}
			// Adjacent occurrences first, so a value repeated back to back costs one step per repeat; then the window
			// from which an occurrence starting inside the region could still reach past its end.
			pattern.lastIndex = to;
			let next = pattern.exec(text);
			while (next !== null && next.index === to) {
				to += next[0].length;
				if (!insideAny(markers, next.index, to)) {
					found.push([next.index, to]);
				}
				pattern.lastIndex = to;
				next = pattern.exec(text);
			}
			pattern.lastIndex = Math.max(from + 1, to - matcher.longestForm + 1);
			match = pattern.exec(text);
		}
		return mergedSpans(found);
	}

	redact(text: string, keep: readonly string[] = [], budget?: number): string {
		return this.redactWith(this.whole, text, keep, budget);
	}

	/**
	 * Every value, the one- and two-character ones included, for a caller whose text is one short detail it cannot
	 * blank: an identity provider's error description echoing a two-character client secret.
	 */
	redactShort(text: string): string {
		return this.redactWith(this.short, text, [], undefined);
	}

	private redactWith(matcher: Matcher, text: string, keep: readonly string[], budget: number | undefined): string {
		let current = this.redactOnce(matcher, text, keep, budget);
		for (let pass = 1; pass < MAX_PASSES && current !== text; pass++) {
			const next = this.redactOnce(matcher, current, keep);
			if (next === current) {
				break;
			}
			current = next;
		}
		return current;
	}

	private redactOnce(matcher: Matcher, text: string, keep: readonly string[], budget?: number): string {
		// The window reaches one form and one URL authority past the budget, so a value or a URL split by the budget is
		// still found whole.
		const cut = budget !== undefined && text.length > budget;
		const cutAt = cut ? budget : text.length;
		const window = cut ? text.slice(0, cutAt + Math.max(matcher.longestForm, MAX_AUTHORITY_LENGTH)) : text;
		const cuts: readonly Cut[] = urlCuts(window);
		const spans = this.spans(matcher, window, keep);
		if (cuts.length === 0 && spans.length === 0 && !cut) {
			return text;
		}
		let out = "";
		let cursor = 0;
		for (const urlCut of cuts) {
			if (urlCut.from >= cutAt) {
				break;
			}
			out += redactedSlice(window, cursor, urlCut.from, spans);
			// The replacement is the scheme and the host of the original: a value inside the host is still a value.
			out += redactedSlice(
				urlCut.replacement,
				0,
				urlCut.replacement.length,
				this.spans(matcher, urlCut.replacement, keep)
			);
			cursor = urlCut.resumeAt;
		}
		let end = Math.max(cursor, cutAt);
		for (const [from, to] of spans) {
			if (from < end && to > end) {
				end = to;
			}
		}
		out += redactedSlice(window, cursor, end, spans);
		return cut ? `${out} [${text.length - end} more characters cut]` : out;
	}
}
