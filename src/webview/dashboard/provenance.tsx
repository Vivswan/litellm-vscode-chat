/**
 * The inspector's provenance vocabulary: the badge that says WHERE a value came from, and
 * the quiet mark that says which directive did the work. Badges are deliberately
 * colorless - provenance is not severity, and painting the source column in the trouble
 * palette would teach the reader to read calm configuration as a problem. Marks use the
 * SAME directive words the record editors write. Both live here rather than in
 * modelInspector.tsx because the record-path figure names layers too: one vocabulary.
 */

import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { HoverTip } from "./help";

/**
 * One provenance badge's content: the scope word, the record key or catalog id, and -
 * for scopes a reader cannot infer from the word - the sentence behind a focusable tip.
 */
export interface ProvenanceView {
	readonly scope: string;
	readonly recordKey?: string | undefined;
	readonly tip?: string | undefined;
}

/**
 * An approximate rendered width in ch: code points beyond Latin-1 count double, erring
 * toward MORE tips - clipped text with no tip is unreachable without a pointer. Shared
 * by the badge and the value cells, which clip the same way.
 */
export function approxWidthCh(text: string): number {
	let width = 0;
	for (const ch of text) {
		width += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
	}
	return width;
}

/**
 * Where the badge's own ellipsis can start biting: the width of the longest badge the
 * panel renders unclipped, because a tip repeating on-screen text is a Tab stop bought
 * for nothing.
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
 * The scope words, resolved at call time. Badge text: short and lower case, read as one
 * token beside the value it explains.
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
 * The force and fallback marks: the SAME directive words the record editors' chips write.
 * The t() forms below are therefore identical to the editors', comment included: a
 * message minted under two keys is a build failure (l10n:check), and translators must
 * not be asked to translate the same word twice.
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
 * One provenance badge: neutral outline, never a severity color. The tip covers two
 * failures of a compact token - an uninferable scope word (`derived`) and an ellipsized
 * key - so the badge joins the Tab order only when it is hiding something.
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
 * One directive mark; a rule-carrying mark gets a focusable tip. `children` is the key a
 * mark points at, outside the tip because it is data, not explanation.
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
