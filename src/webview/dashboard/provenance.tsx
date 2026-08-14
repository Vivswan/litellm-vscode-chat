/**
 * The inspector's provenance vocabulary: the one badge that says WHERE a
 * resolved value came from, and the quiet mark that says which directive did
 * the work.
 *
 * A badge is a monospace outline token - "settings gpt-5*", "server",
 * "built-in default" - and it is deliberately colorless. Provenance is not
 * severity: a value from a fallback record is not a warning, and painting the
 * source column in the palette the rest of the dashboard uses for trouble
 * would teach the reader to read calm configuration as a problem.
 *
 * A mark is one accent word, the same word the record editors write on the
 * record side (force, fallback, inheritable), so a directive looks the same
 * from either end. Where the word alone cannot carry the rule, the sentence
 * rides a focusable tip - text that exists nowhere else has to be reachable
 * without a pointer.
 *
 * Both live here rather than in modelInspector.tsx because the record-path
 * figure names layers too, and one vocabulary with two renderings is how the
 * old panel drifted in the first place.
 */

import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { HoverTip } from "./help";

/**
 * One provenance badge's content: the scope word naming where a value came
 * from, the record key or catalog id that carried it, and - for the scopes a
 * reader cannot infer from the word alone - the sentence behind a focusable
 * tip.
 */
export interface ProvenanceView {
	readonly scope: string;
	readonly recordKey?: string | undefined;
	readonly tip?: string | undefined;
}

/**
 * An approximate rendered width in ch: code points beyond Latin-1 (CJK, emoji)
 * count double, erring toward MORE tips - a wide-glyph string clips well before
 * its code-unit length reaches the box, and clipped text with no tip is
 * unreachable without a pointer. Shared by the badge and the value cells, which
 * clip the same way.
 */
export function approxWidthCh(text: string): number {
	let width = 0;
	for (const ch of text) {
		width += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
	}
	return width;
}

/**
 * Where the badge's own ellipsis can start biting: the source column is the
 * widest of the three, so only a genuinely long key - an unbroken regex
 * matcher, not a catalog ID - reaches it. Set to the width of the longest
 * badge the panel renders unclipped, because a tip that repeats text already
 * on screen is a Tab stop bought for nothing.
 */
const BADGE_CLIP_CH = 36;

/** One directive mark: the record editors' chip word, with its rule one tip away. */
export interface MarkView {
	readonly word: string;
	readonly detail?: string | undefined;
	/** The word IS a directive key (`_openrouter_model`), so it keeps the monospace register. */
	readonly mono?: boolean | undefined;
}

/**
 * The scope words, resolved at call time (no module-level localized
 * constants). They are badge text, so they are short and lower case: a badge
 * is read as one token beside the value it explains, never as a sentence.
 */
export function settingsScope(): string {
	// Bare t(), like the server form's own "settings": one message is one key,
	// and l10n:check fails the build if the same word is minted twice.
	return l10n.t("settings");
}

export function entryScope(): string {
	return l10n.t({
		message: "entry",
		comment: ["Provenance badge: the value comes from this server entry's own record"],
	});
}

export function serverScope(): string {
	return l10n.t({ message: "server", comment: ["Provenance badge: the value is what the LiteLLM server reported"] });
}

/**
 * The force and fallback marks: the SAME directive words the record editors'
 * chips write on the record side, which is the point - one directive, one word,
 * wherever it is seen. The t() forms below are therefore identical to the
 * editors', comment included: a message minted under two keys is a build
 * failure (l10n:check), and translators must not be asked to translate the
 * same word twice.
 */
export function forceWord(): string {
	return l10n.t({
		message: "force",
		comment: ["Checkbox label on a parameter row; marks the value as forced over runtime options."],
	});
}

export function fallbackWord(): string {
	return l10n.t({
		message: "fallback",
		comment: ["Checkbox label on a capability row; applies the value only where the server reports none."],
	});
}

/** The inherited mark's word; the key it inherited from renders beside it, in the monospace register. */
export function inheritedWord(): string {
	return l10n.t({
		message: "inherited from",
		comment: ["Directive mark on a resolved value: the winning record inherited it from the record named next"],
	});
}

/**
 * One provenance badge: neutral outline, monospace, never a severity color.
 *
 * The tip covers two different failures of a compact token: a scope word whose
 * meaning a reader cannot infer (`derived`), and a record key too long for the
 * column, which the stylesheet ellipsizes. Either way the full text has to be
 * reachable from the keyboard, so the badge joins the Tab order only when it is
 * hiding something.
 */
export function Provenance({ source }: { source: ProvenanceView }) {
	const full = source.recordKey === undefined ? source.scope : `${source.scope} ${source.recordKey}`;
	const tip = source.tip ?? (approxWidthCh(full) > BADGE_CLIP_CH ? full : undefined);
	const badge = (
		<span className="prov">
			<span className="prov-scope">{source.scope}</span>
			{source.recordKey !== undefined ? (
				<>
					{" "}
					<span className="prov-key">{source.recordKey}</span>
				</>
			) : null}
		</span>
	);
	return tip === undefined ? badge : <HoverTip tip={tip}>{badge}</HoverTip>;
}

/**
 * One directive mark. A mark whose meaning is a rule rather than a word
 * carries that rule in a focusable tip; `children` is for the key a mark
 * points at (the record it inherited from), which stays outside the tip
 * because it is data, not explanation.
 */
export function Mark({ mark, children }: { mark: MarkView; children?: ReactNode }) {
	const body = (
		<span className="mark">
			{mark.mono === true ? <code>{mark.word}</code> : mark.word}
			{children}
		</span>
	);
	return mark.detail === undefined ? body : <HoverTip tip={mark.detail}>{body}</HoverTip>;
}
