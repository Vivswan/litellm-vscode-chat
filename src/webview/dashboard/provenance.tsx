/**
 * THE provenance vocabulary: every resolution level and layer maps to its words here, in
 * two registers - the inspectors' badge-plus-mark, and the diagnostics table's compact
 * phrase, derived from the badge register so the two panels cannot drift. Badges are
 * deliberately colorless - provenance is not severity, and painting the source column in
 * the trouble palette would teach the reader to read calm configuration as a problem.
 * Marks use the SAME directive words the record editors write.
 */

import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import type { CapabilityLevel } from "../../shared/config/capabilityResolution";
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

function serverScope(): string {
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

/** The `_inheritable` mark's word, same contract as forceWord: the record editors' own chip word. */
export function inheritableWord(): string {
	return l10n.t({
		message: "inheritable",
		comment: ["Checkbox label on a record row; marks the field as inheritable by more specific records."],
	});
}

/** The parameter layers as a badge: the scope that set the value plus its winning record key. */
export function parameterProvenance(source: {
	readonly layer: "entry" | "global";
	readonly key: string;
}): ProvenanceView {
	return { scope: source.layer === "entry" ? entryScope() : settingsScope(), recordKey: source.key };
}

/**
 * The capability walk's levels as a badge plus, where a directive did the work, its
 * mark: a `_fallback` fill is a record wearing a directive, not a level of its own, so
 * the badge names the source and the mark names the directive.
 */
export function capabilityProvenance(
	level: CapabilityLevel,
	key: string | undefined
): { readonly source: ProvenanceView; readonly mark?: MarkView } {
	switch (level) {
		case "entry":
			return { source: { scope: entryScope(), recordKey: key } };
		case "global":
			return { source: { scope: settingsScope(), recordKey: key } };
		// The one mark that INVERTS the badge: an ordinary entry or settings
		// record beats the server's report, a `_fallback` fill loses to it. The
		// word cannot carry that, so the sentence rides its tip.
		case "entry-fallback":
			return { source: { scope: entryScope(), recordKey: key }, mark: fallbackMark() };
		case "global-fallback":
			return { source: { scope: settingsScope(), recordKey: key }, mark: fallbackMark() };
		case "server":
			return { source: { scope: serverScope() } };
		// The two catalog marks say exactly how the level was chosen, so neither carries a tip:
		// a tip here would be one Tab stop per row repeating identical text, and every field of
		// a server that reports nothing can land on these levels at once.
		case "directive":
			return {
				source: { scope: "OpenRouter", recordKey: key },
				mark: { word: "_openrouter_model", mono: true },
			};
		case "catalog":
			return {
				source: { scope: "OpenRouter", recordKey: key },
				mark: {
					word: l10n.t({ message: "matched", comment: ["Directive mark: the catalog entry was matched, not named"] }),
				},
			};
		case "derived":
			return {
				source: {
					// Bare t(), matching the Diagnostics tree's own "derived".
					scope: l10n.t("derived"),
					tip: l10n.t("Context length minus max output tokens: nothing declared this field directly."),
				},
			};
		case "floor":
			return {
				source: {
					scope: l10n.t({
						message: "built-in default",
						comment: ["Provenance badge: nothing declared the field, so the extension's own floor applies"],
					}),
				},
			};
	}
}

/** The `_fallback` mark and the precedence rule the word alone cannot state. */
function fallbackMark(): MarkView {
	return {
		word: fallbackWord(),
		detail: l10n.t(
			"Fills the field only where the server reported nothing; the server's own value wins when it has one."
		),
	};
}

/** A provenance in the compact-phrase register: "scope key; mark, mark". */
function provenancePhrase(source: ProvenanceView, marks: readonly string[]): string {
	const base = source.recordKey === undefined ? source.scope : `${source.scope} ${source.recordKey}`;
	return marks.length > 0 ? `${base}; ${marks.join(", ")}` : base;
}

/** The inherited mark's phrase words; a value a record holds itself is already named by the base phrase. */
function inheritedMarkWords(key: string | undefined, inheritedFrom: string | undefined): readonly string[] {
	return inheritedFrom !== undefined && inheritedFrom !== key ? [`${inheritedWord()} ${inheritedFrom}`] : [];
}

/** A parameter cell's provenance in the compact-phrase register (the diagnostics table's chips). */
export function parameterProvenancePhrase(cell: {
	readonly layer: "entry" | "global";
	readonly key: string;
	readonly forced?: true | undefined;
	readonly inheritedFrom?: string | undefined;
}): string {
	const marks = [...(cell.forced === true ? [forceWord()] : []), ...inheritedMarkWords(cell.key, cell.inheritedFrom)];
	return provenancePhrase(parameterProvenance(cell), marks);
}

/** A capability cell's provenance in the compact-phrase register, from the same map as the badge. */
export function capabilityProvenancePhrase(cell: {
	readonly level: CapabilityLevel;
	readonly key?: string | undefined;
	readonly inheritedFrom?: string | undefined;
}): string {
	const { source, mark } = capabilityProvenance(cell.level, cell.key);
	return provenancePhrase(source, [
		...(mark === undefined ? [] : [mark.word]),
		...inheritedMarkWords(cell.key, cell.inheritedFrom),
	]);
}

/**
 * One provenance badge: neutral outline, never a severity color. The tip covers two
 * failures of a compact token - an uninferable scope word (`derived`) and an ellipsized
 * key - so the badge joins the Tab order only when it is hiding something.
 */
export function Provenance({ source }: { source: ProvenanceView }) {
	const full = provenancePhrase(source, []);
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
