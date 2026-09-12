/**
 * The record directives as chip flags: which directives each editor kind
 * surfaces, the flag words and badges, and the wrong-type cell.
 */
import * as l10n from "@vscode/l10n";
import type { FieldDirective, PrefixGroup } from "../../dashboard/recordDraft";
import { directiveMarkedFields, wrongRecordTypeHint } from "../../dashboard/recordDraft";
import { FALLBACK_DIRECTIVE, FORCE_DIRECTIVE, INHERITABLE_DIRECTIVE } from "../../shared/config/recordResolution";
import type { RecordEditorKind } from "./recordIssues";

/**
 * The checkbox directives each editor renders per row, which is also the set
 * directiveRowAbsorbed may absorb for it: `_force` marks belong to the
 * parameters editor, `_fallback` marks to the capabilities editor,
 * `_inheritable` to both.
 */
export const PARAM_FLAG_DIRECTIVES: readonly FieldDirective[] = [FORCE_DIRECTIVE, INHERITABLE_DIRECTIVE];

export const CAPABILITY_FLAG_DIRECTIVES: readonly FieldDirective[] = [FALLBACK_DIRECTIVE, INHERITABLE_DIRECTIVE];

/** The force mark's word, shared by the row checkboxes and the chip badges so translations stay single-sourced. */
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

export function inheritableWord(): string {
	return l10n.t({
		message: "inheritable",
		comment: ["Checkbox label on a record row; marks the field as inheritable by more specific records."],
	});
}

/** The wrong-record-type badge's word; the full sentence rides the badge as its tooltip and description. */
function ignoredWord(): string {
	return l10n.t({
		message: "ignored",
		comment: ["Badge word on a record field whose directive key belongs to the other record type."],
	});
}

/** One flag badge on a field chip: a stable id for React keys, the localized word, and the full sentence where the word alone is not the story. */
interface ChipFlag {
	/** Locale-independent identity; translated words could collide as list keys. */
	readonly id: "force" | "fallback" | "inheritable" | "ignored";
	readonly word: string;
	/** The wrong-record-type sentence; its presence is also what selects the warn tier. */
	readonly note?: string | undefined;
}

/**
 * The user-set word wears the accent's readable label tier because at 11px on the chip fill the raw hue measures
 * 2.83:1; the "ignored" badge wears the warn text tier. The sentence itself is the carrier's job, because a native
 * title neither renders reliably in the webview host nor shows on keyboard focus (help.tsx).
 *
 *   editable chip  -> aria-describedby plus the card's status line
 *   read-only chip -> a HoverTip
 */
export function ChipFlagWord({ flag }: { flag: ChipFlag }) {
	return flag.note === undefined ? (
		<span className="chip-flag text-[11px] text-accent-text">{flag.word}</span>
	) : (
		<span className="chip-flag chip-flag-ignored text-[11px] text-warn">{flag.word}</span>
	);
}

/**
 * The overlay flag cell's wrong-record-type badge, one embodiment for both
 * editors: the visible word plus the hidden sentence the row's key input
 * names through aria-describedby - stable whichever tenant the worst-first
 * status line is showing.
 */
export function WrongTypeFlagCell({ note, id }: { note: string; id: string }) {
	return (
		<span className="cell directive-flag">
			<ChipFlagWord flag={{ id: "ignored", word: ignoredWord(), note }} />
			<span id={id} className="visually-hidden">
				{note}
			</span>
		</span>
	);
}

/** The flag badges one field chip carries, derived from the same rows the toggles rewrite; `key` in the resolver's reading. */
export function chipFlags(kind: RecordEditorKind, group: PrefixGroup, key: string): ChipFlag[] {
	const flags: ChipFlag[] = [];
	if (kind === "params" && directiveMarkedFields(kind, group, FORCE_DIRECTIVE).has(key)) {
		flags.push({ id: "force", word: forceWord() });
	}
	if (kind === "caps" && directiveMarkedFields(kind, group, FALLBACK_DIRECTIVE).has(key)) {
		flags.push({ id: "fallback", word: fallbackWord() });
	}
	if (directiveMarkedFields(kind, group, INHERITABLE_DIRECTIVE).has(key)) {
		flags.push({ id: "inheritable", word: inheritableWord() });
	}
	const note = wrongRecordTypeHint(kind, key);
	if (note !== undefined) {
		flags.push({ id: "ignored", word: ignoredWord(), note });
	}
	return flags;
}

/** The flag directives each editor's chips may absorb; the checkbox sets, unchanged. */
export function flagDirectivesFor(kind: RecordEditorKind): readonly FieldDirective[] {
	return kind === "params" ? PARAM_FLAG_DIRECTIVES : CAPABILITY_FLAG_DIRECTIVES;
}
