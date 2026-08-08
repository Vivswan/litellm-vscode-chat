/**
 * The model-matcher grammar shared by every model-keyed record (parameters
 * and capabilities, global and per-entry alike). Pure (no vscode, no DOM, no
 * Node) so both the request path and the dashboard consume the one
 * implementation.
 *
 * A key matches exactly unless it says otherwise:
 *
 * - `"gpt-5"` matches only the ID `gpt-5` (character for character, nothing
 *   trimmed, case-sensitive).
 * - `"gpt-5*"` is a trailing glob: every ID starting with `gpt-5`. The `*`
 *   must be last; a `*` anywhere else makes the key invalid.
 * - `"/re/"` or `"/re/i"` is a regular expression matched against the whole
 *   ID; `i` is the only supported flag. An invalid pattern or another flag is
 *   a diagnostic and the key is ignored.
 * - `"*"` is the catch-all: it matches every model.
 * - `""` is invalid (diagnostic, ignored).
 *
 * Specificity orders matching keys: exact > glob (longer literal prefix
 * wins) > regex (later in the record wins) > `"*"`. The tiers are strict -
 * any glob outranks any regex, and a match-everything regex (dot-star) still
 * outranks `"*"`: it ranks as a regex.
 */

/** A model-keyed record map: matcher key to one record object. The shape both settings and entry fields share. */
export type ModelRecordMap = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The catch-all key: matches every model at the lowest specificity tier. */
export const CATCH_ALL_KEY = "*";

export type MatcherInvalidReason = "empty-key" | "misplaced-star" | "invalid-regex" | "unsupported-regex-flag";

export type ParsedMatcher =
	| { readonly kind: "exact"; readonly key: string }
	| { readonly kind: "glob"; readonly key: string; readonly literalPrefix: string }
	| { readonly kind: "regex"; readonly key: string; readonly pattern: RegExp }
	| { readonly kind: "catch-all"; readonly key: string };

export type MatcherParse =
	| { readonly ok: true; readonly matcher: ParsedMatcher }
	| { readonly ok: false; readonly reason: MatcherInvalidReason };

/**
 * A key is regex-shaped when it starts with `/` and ends with `/` followed by
 * nothing but ASCII letters (the flags position). Everything else that starts
 * with `/` stays a literal key, so an exact ID with slashes inside
 * (`anthropic/claude-4`) still matches by plain equality.
 */
const REGEX_SHAPED = /^\/(.+)\/([a-zA-Z]*)$/;

/**
 * Parse one record key into its matcher. Total: every string answers either
 * a matcher or the reason it is invalid; invalid keys never match anything.
 */
export function parseMatcherKey(key: string): MatcherParse {
	if (key === "") {
		return { ok: false, reason: "empty-key" };
	}
	if (key === CATCH_ALL_KEY) {
		return { ok: true, matcher: { kind: "catch-all", key } };
	}
	const shaped = REGEX_SHAPED.exec(key);
	if (shaped !== null) {
		const [, body = "", flags = ""] = shaped;
		if (flags !== "" && flags !== "i") {
			return { ok: false, reason: "unsupported-regex-flag" };
		}
		try {
			// Anchored to the whole ID: a regex key matches the ID, never a substring.
			return { ok: true, matcher: { kind: "regex", key, pattern: new RegExp(`^(?:${body})$`, flags) } };
		} catch {
			return { ok: false, reason: "invalid-regex" };
		}
	}
	const star = key.indexOf("*");
	if (star !== -1) {
		// A single trailing star is the glob form; a star anywhere earlier
		// (which also covers multiple stars) invalidates the key.
		if (star !== key.length - 1) {
			return { ok: false, reason: "misplaced-star" };
		}
		return { ok: true, matcher: { kind: "glob", key, literalPrefix: key.slice(0, -1) } };
	}
	return { ok: true, matcher: { kind: "exact", key } };
}

export function matcherMatches(matcher: ParsedMatcher, id: string): boolean {
	switch (matcher.kind) {
		case "exact":
			return id === matcher.key;
		case "glob":
			return id.startsWith(matcher.literalPrefix);
		case "regex":
			return matcher.pattern.test(id);
		case "catch-all":
			return true;
	}
}

/** One malformed record key; the record under it never matches anything. */
export interface MatcherDiagnostic {
	readonly kind: "invalid-matcher";
	/** The offending record key. */
	readonly key: string;
	readonly reason: MatcherInvalidReason;
}

/** One record whose key matches the model, with the key's position in the record (the regex tie-breaker). */
export interface RecordMatch<T> {
	readonly key: string;
	readonly matcher: ParsedMatcher;
	/** The key's position in the record's own order; later regexes are more specific. */
	readonly position: number;
	readonly record: T;
}

const TIER = { "catch-all": 0, regex: 1, glob: 2, exact: 3 } as const;

/**
 * The strict specificity order between two matchers that both match one
 * model: negative when `a` is broader than `b`. Exact beats glob beats regex
 * beats the catch-all; between globs the longer literal prefix wins; between
 * regexes the one later in the record wins. Two distinct keys can never tie:
 * equal-prefix globs are the same key, and record positions differ.
 */
export function compareSpecificity(
	a: Pick<RecordMatch<unknown>, "matcher" | "position">,
	b: Pick<RecordMatch<unknown>, "matcher" | "position">
): number {
	const tierDiff = TIER[a.matcher.kind] - TIER[b.matcher.kind];
	if (tierDiff !== 0) {
		return tierDiff;
	}
	if (a.matcher.kind === "glob" && b.matcher.kind === "glob") {
		return a.matcher.literalPrefix.length - b.matcher.literalPrefix.length;
	}
	if (a.matcher.kind === "regex" && b.matcher.kind === "regex") {
		return a.position - b.position;
	}
	return 0;
}

export interface MatchChain<T> {
	/** Every record whose key matches the ID, broadest first, most specific last. */
	readonly chain: readonly RecordMatch<T>[];
	/** The invalid keys found in the record map (matching or not); each is inert. */
	readonly diagnostics: readonly MatcherDiagnostic[];
}

/**
 * All records matching one model ID, ordered broadest to most specific - the
 * resolution chain inheritance walks. Invalid keys are diagnosed and never
 * match; the most specific matching record is the chain's last element.
 */
export function matchChain<T>(id: string, records: Readonly<Record<string, T>>): MatchChain<T> {
	const chain: RecordMatch<T>[] = [];
	const diagnostics: MatcherDiagnostic[] = [];
	let position = 0;
	for (const [key, record] of Object.entries(records)) {
		const parsed = parseMatcherKey(key);
		const keyPosition = position;
		position += 1;
		if (!parsed.ok) {
			diagnostics.push({ kind: "invalid-matcher", key, reason: parsed.reason });
			continue;
		}
		if (matcherMatches(parsed.matcher, id)) {
			chain.push({ key, matcher: parsed.matcher, position: keyPosition, record });
		}
	}
	chain.sort(compareSpecificity);
	return { chain, diagnostics };
}

/** The invalid keys of a record map, for record-level linting independent of any model. */
export function lintMatcherKeys(records: Readonly<Record<string, unknown>>): readonly MatcherDiagnostic[] {
	const diagnostics: MatcherDiagnostic[] = [];
	for (const key of Object.keys(records)) {
		const parsed = parseMatcherKey(key);
		if (!parsed.ok) {
			diagnostics.push({ kind: "invalid-matcher", key, reason: parsed.reason });
		}
	}
	return diagnostics;
}
