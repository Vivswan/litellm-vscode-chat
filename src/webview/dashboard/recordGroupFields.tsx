import * as l10n from "@vscode/l10n";
import type { FocusEvent, KeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type {
	CapabilityGroupIssues,
	GroupHints,
	GroupProblems,
	ParamRow,
	PrefixGroup,
} from "../../dashboard/recordDraft";
import {
	directiveEligible,
	directiveMarkedFields,
	directiveRowAbsorbed,
	inheritFromChoice,
	matcherKind,
	newParamRow,
	parseInheritKeysText,
	resolvedFieldName,
	setInheritFromChoice,
	toggleDirectiveField,
	wrongRecordTypeHint,
} from "../../dashboard/recordDraft";
import { CONSUMED_CAPABILITY_FIELDS, consumedFieldKind } from "../../shared/config/capabilityResolution";
import {
	FALLBACK_DIRECTIVE,
	FORCE_DIRECTIVE,
	INHERIT_FROM_DIRECTIVE,
	INHERITABLE_DIRECTIVE,
	OPENROUTER_MODEL_DIRECTIVE,
	RECORD_TYPE_DIRECTIVES,
} from "../../shared/config/recordResolution";
import { trimHttpWhitespace } from "../../shared/util/headers";
import { Help } from "./help";
import {
	helpCapabilityName,
	helpCapabilityPrefix,
	helpCapabilityValue,
	helpCatalogPicker,
	helpFallbackFlag,
	helpForceFlag,
	helpForceFlagDisabled,
	helpInheritableFlag,
	helpInheritFromControl,
	helpModelParameterName,
	helpModelParameterValue,
} from "./helpText";
import { useRpc } from "./hooks";
import { IconAdd, IconTrash } from "./icons";
import {
	CAPABILITY_FLAG_DIRECTIVES,
	fallbackWord,
	forceWord,
	PARAM_FLAG_DIRECTIVES,
	WrongTypeFlagCell,
} from "./recordFlags";
import type { RecordEditorKind } from "./recordIssues";
import { matcherKindLabel } from "./recordIssues";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { cn } from "./ui/cn";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

/**
 * It goes hands-off while the row holds text the strict parse rejects: the select must not silently rewrite the
 * user's text.
 *
 *   hint -> the absorbed `_inherit_from` row's non-blocking note (an unknown record key), rendered beside the control
 */
function InheritFromControl({
	kind,
	group,
	disabled,
	hint,
	onChange,
}: {
	kind: RecordEditorKind;
	group: PrefixGroup;
	disabled: boolean;
	hint?: string | undefined;
	onChange: (next: PrefixGroup) => void;
}) {
	const choice = inheritFromChoice(kind, group);
	const id = useId();
	// The text is the input's value while no row backs it.
	//
	//   Keys mode held open locally     -> defined means the select shows "keys" even while no row exists
	//   setInheritFromChoice's keys arm -> cannot write an empty list
	const [pending, setPending] = useState<{ readonly text: string } | undefined>(undefined);
	if (choice.kind === "unreadable") {
		return (
			<span className="inherit-from">
				<span className="editor-label">{l10n.t("Inherits")}</span>
				<span className="hint">{l10n.t("Inheritance: edit the _inherit_from row below")}</span>
			</span>
		);
	}
	const shownKind =
		choice.kind === "keys" || (pending !== undefined && choice.kind === "default") ? "keys" : choice.kind;
	const keysText = choice.kind === "keys" ? choice.keysText : (pending?.text ?? "");
	const writeKeys = (text: string) => {
		const keys = parseInheritKeysText(text);
		if (keys !== undefined) {
			setPending((current) => (current === undefined ? current : { text }));
			onChange(setInheritFromChoice(kind, group, { keys }));
		} else if (choice.kind === "keys") {
			// Emptied: drop the row; the pending mode keeps the input on screen for the next key - a stored keys row
			// entered edit without local mode, and dropping the row bare would unmount the input mid-edit and steal
			// focus.
			setPending({ text });
			onChange(setInheritFromChoice(kind, group, "default"));
		} else {
			setPending((current) => (current === undefined ? current : { text }));
		}
	};
	return (
		<span className="inherit-from">
			<span className="editor-label">
				<label htmlFor={id}>{l10n.t("Inherits")}</label>
				<Help text={helpInheritFromControl()} />
			</span>
			<span className="inherit-controls">
				<Select
					id={id}
					className="px-1 py-0.5"
					disabled={disabled}
					value={shownKind}
					onChange={(event) => {
						const selected = event.currentTarget.value;
						if (selected === "default" || selected === "all" || selected === "none") {
							setPending(undefined);
							onChange(setInheritFromChoice(kind, group, selected));
						} else {
							setPending({ text: choice.kind === "keys" ? choice.keysText : "" });
							if (choice.kind !== "keys" && choice.kind !== "default") {
								onChange(setInheritFromChoice(kind, group, "default"));
							}
						}
					}}
				>
					<option value="default">{l10n.t("inheritable fields (default)")}</option>
					<option value="all">{l10n.t("everything that reaches it")}</option>
					<option value="none">{l10n.t("nothing - barrier")}</option>
					<option value="keys">{l10n.t("only listed records")}</option>
				</Select>
				{shownKind === "keys" ? (
					<Input
						type="text"
						className="inherit-keys"
						aria-label={l10n.t("Record keys to inherit from, comma-separated")}
						placeholder={l10n.t("e.g. gpt-5*, *")}
						value={keysText}
						disabled={disabled}
						onChange={(event) => writeKeys(event.currentTarget.value)}
					/>
				) : null}
				{hint === undefined ? null : <span className="hint">{hint}</span>}
			</span>
		</span>
	);
}

/**
 * The row's "inheritable" checkbox; nothing renders for a key the directive cannot mark (directiveEligible).
 *
 *   fieldKey -> the row's key in the resolver's reading (resolvedFieldName)
 */
export function InheritableFlag({
	kind,
	group,
	fieldKey,
	disabled,
	onChange,
}: {
	kind: RecordEditorKind;
	group: PrefixGroup;
	fieldKey: string;
	disabled: boolean;
	onChange: (next: PrefixGroup) => void;
}) {
	const marked = directiveMarkedFields(kind, group, INHERITABLE_DIRECTIVE);
	if (!directiveEligible(INHERITABLE_DIRECTIVE, fieldKey)) {
		return null;
	}
	// A bare label-plus-help fragment: the caller owns the row's one directive-flag cell, so two marks never fight over
	// the grid column.
	return (
		<>
			<label>
				<Checkbox
					aria-label={l10n.t('Mark "{0}" inheritable', fieldKey)}
					checked={marked.has(fieldKey)}
					disabled={disabled}
					onChange={(event) =>
						onChange(toggleDirectiveField(kind, group, INHERITABLE_DIRECTIVE, fieldKey, event.currentTarget.checked))
					}
				/>
				{l10n.t({
					message: "inheritable",
					comment: ["Checkbox label on a record row; marks the field as inheritable by more specific records."],
				})}
			</label>
			<Help text={helpInheritableFlag()} />
		</>
	);
}

/**
 * Which row's text inputs own focus, so absorbing a directive row cannot unmount the input mid-keystroke and steal
 * focus; rows absorb on blur. The hold names the row's stable id: removing a focused row fires no focusout, but the
 * stranded hold then names an id no row carries, so the row that shifts into its place is never pinned.
 */
function useFocusedRow(): {
	focused: (rowId: string) => boolean;
	rowFocusProps: (rowId: string) => {
		onFocusCapture: (event: FocusEvent) => void;
		onBlurCapture: (event: FocusEvent) => void;
	};
} {
	const [hold, setHold] = useState<string | undefined>(undefined);
	return {
		focused: (rowId) => hold === rowId,
		rowFocusProps: (rowId) => ({
			onFocusCapture: (event: FocusEvent) => {
				if (event.target instanceof HTMLInputElement && event.target.type !== "checkbox") {
					setHold(rowId);
				}
			},
			onBlurCapture: (event: FocusEvent) => {
				const next = event.relatedTarget;
				if (next instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(next)) {
					return;
				}
				setHold((current) => (current === rowId ? undefined : current));
			},
		}),
	};
}

/** What every parameter row reads: the group, its verdicts, the shared inputs, and the group's edit moves. */
interface ParamRowContext {
	readonly group: PrefixGroup;
	readonly inert: boolean;
	readonly disabled: boolean | undefined;
	readonly problems: GroupProblems | undefined;
	readonly hints: GroupHints | undefined;
	readonly paramNameSuggestions: readonly string[] | undefined;
	readonly forcedFields: ReadonlySet<string>;
	readonly wrongTypeIdBase: string;
	readonly focusHold: ReturnType<typeof useFocusedRow>;
	readonly onChange: (next: PrefixGroup) => void;
	readonly patchGroup: (patch: Partial<PrefixGroup>) => void;
	readonly onEnter: (() => void) | undefined;
	readonly onKeyDown: ((event: KeyboardEvent) => void) | undefined;
}

interface ParamRowProps {
	readonly row: ParamRowContext;
	readonly param: ParamRow;
	readonly paramIndex: number;
}

interface ParamFlagCellProps {
	readonly row: ParamRowContext;
	readonly param: ParamRow;
	readonly wrongType: WrongTypeNote | undefined;
}

interface MatcherSectionProps {
	readonly group: PrefixGroup;
	readonly prefixProblem: string | undefined;
	readonly inert: boolean;
	readonly prefixPlaceholder: string;
	readonly prefixHelp: string;
	readonly prefixSuggestions: readonly string[] | undefined;
	readonly onPrefix: (next: string) => void;
	readonly onEnter: (() => void) | undefined;
}

/**
 * The plain value inputs' Enter handler; the suggestion inputs guard their own Enter (a highlighted suggestion is
 * accepted, never applied).
 */
function enterHandler(onEnter: (() => void) | undefined): ((event: KeyboardEvent) => void) | undefined {
	if (onEnter === undefined) {
		return undefined;
	}
	return (event) => {
		if (event.key === "Enter") {
			onEnter();
		}
	};
}

/**
 * The matcher input with its reserved status line (dashboard.css .matcher-status): grammar at rest, verdict in the
 * same one-size slot - two spans changed heights and moved the sections below under the typing hand.
 */
function MatcherSection(props: MatcherSectionProps) {
	const { group, prefixProblem, inert, prefixPlaceholder, prefixHelp, prefixSuggestions, onPrefix, onEnter } = props;
	return (
		<div className="editor-section">
			<span className="editor-label">
				{l10n.t("Matcher")}
				<Help text={prefixHelp} />
			</span>
			<div className="matcher-line">
				<SuggestInput
					value={group.prefix}
					suggestions={prefixSuggestions ?? []}
					inputClass="key"
					invalid={prefixProblem !== undefined}
					placeholder={prefixPlaceholder}
					ariaLabel={l10n.t("Matcher")}
					disabled={inert}
					onValue={onPrefix}
					onEnter={onEnter}
				/>
			</div>
			<span className={cn("matcher-status", prefixProblem !== undefined && "error")}>
				{prefixProblem ??
					(trimHttpWhitespace(group.prefix).length > 0 ? matcherKindLabel(matcherKind(group.prefix)) : null)}
			</span>
		</div>
	);
}

/** The wrong-record-type note a row's key earns, with the id its key input's aria-describedby points at. */
interface WrongTypeNote {
	readonly note: string;
	readonly id: string;
}

function wrongTypeNote(kind: RecordEditorKind, key: string, id: string): WrongTypeNote | undefined {
	const note = wrongRecordTypeHint(kind, key);
	return note === undefined ? undefined : { note, id };
}

function ParamRowsHead() {
	return (
		<div className="rows-head">
			<span className="col-head">
				{l10n.t("Parameter")}
				<Help text={helpModelParameterName()} />
			</span>
			<span className="col-head">
				{l10n.t("Value")}
				<Help text={helpModelParameterValue()} />
			</span>
		</div>
	);
}

/**
 * The per-row force/inheritable marks in their own fixed column so the boxes align. Directive rows carry no flag
 * checkboxes (a directive cannot be forced or inherited); unforceable keys keep the box visible but disabled, the help
 * naming why. A directive key of the other record type gets the wrong-type note in the cell instead.
 */
function ParamFlagCell({ row, param, wrongType }: ParamFlagCellProps) {
	const { group, inert, forcedFields, onChange } = row;
	if (param.key.startsWith("_") || trimHttpWhitespace(param.key).length === 0) {
		return wrongType === undefined ? null : <WrongTypeFlagCell note={wrongType.note} id={wrongType.id} />;
	}
	return (
		<span className="cell directive-flag">
			<label>
				<Checkbox
					aria-label={l10n.t('Force "{0}"', param.key)}
					checked={forcedFields.has(param.key)}
					disabled={inert || !directiveEligible(FORCE_DIRECTIVE, param.key)}
					onChange={(event) =>
						onChange(toggleDirectiveField("params", group, FORCE_DIRECTIVE, param.key, event.currentTarget.checked))
					}
				/>
				{forceWord()}
			</label>
			<Help text={directiveEligible(FORCE_DIRECTIVE, param.key) ? helpForceFlag() : helpForceFlagDisabled()} />
			<InheritableFlag kind="params" group={group} fieldKey={param.key} disabled={inert} onChange={onChange} />
		</span>
	);
}

/**
 * One parameter row. The stacked tier's per-cell labels (dashboard.css .cell-label) exist because stacked rows leave
 * no tracks for the column heads to label; they are aria-hidden, since the input already carries the word as its
 * accessible name and the help button stays exposed.
 *
 * The Remove label names the field as the record stores it (verbatim); emptiness is the one judgment made trimmed,
 * matching the parse's own refusal of a whitespace-only name. The status slot is reserved whether or not it speaks
 * (dashboard.css .row .row-status): the verdict lands per keystroke, and a line mounted only when it speaks moves the
 * rows below; worst first, a problem outranks a hint.
 */
function ParamRowFields({ row, param, paramIndex }: ParamRowProps) {
	const { group, inert, disabled, problems, hints, patchGroup, onEnter, onKeyDown } = row;
	const removeLabel = trimHttpWhitespace(param.key).length > 0 ? l10n.t('Remove "{0}"', param.key) : l10n.t("Remove");
	const rowProblem = problems?.params[paramIndex]?.message;
	const rowHint = hints?.params[paramIndex];
	const wrongType = wrongTypeNote("params", param.key, `${row.wrongTypeIdBase}-${param.id}`);
	const patchParam = (patch: Partial<ParamRow>) =>
		patchGroup({ params: group.params.map((p, i) => (i === paramIndex ? { ...p, ...patch } : p)) });
	return (
		<div className="row" {...row.focusHold.rowFocusProps(param.id)}>
			<span className="cell-label">
				<span aria-hidden="true">{l10n.t("Parameter")}</span>
				<Help text={helpModelParameterName()} />
			</span>
			<span className="cell key">
				<SuggestInput
					value={param.key}
					suggestions={row.paramNameSuggestions ?? []}
					inputClass="key"
					invalid={problems?.params[paramIndex]?.field === "name"}
					placeholder={l10n.t("Parameter, e.g. temperature")}
					ariaLabel={l10n.t("Parameter")}
					describedBy={wrongType?.id}
					disabled={inert}
					onValue={(next) => patchParam({ key: next })}
					onEnter={onEnter}
				/>
			</span>
			<span className="cell-label">
				<span aria-hidden="true">{l10n.t("Value")}</span>
				<Help text={helpModelParameterValue()} />
			</span>
			<span className="cell value">
				<Input
					type="text"
					className="value"
					aria-invalid={problems?.params[paramIndex]?.field === "value"}
					aria-label={l10n.t("Value")}
					placeholder={l10n.t("JSON value, e.g. 0.2")}
					value={param.valueText}
					disabled={inert}
					onChange={(event) => patchParam({ valueText: event.currentTarget.value })}
					onKeyDown={onKeyDown}
				/>
			</span>
			<ParamFlagCell row={row} param={param} wrongType={wrongType} />
			<Button
				variant="danger"
				size="compact"
				aria-label={removeLabel}
				title={removeLabel}
				disabled={disabled}
				onClick={() => patchGroup({ params: group.params.filter((_, i) => i !== paramIndex) })}
			>
				<IconTrash />
			</Button>
			<span className={cn("row-status", rowProblem === undefined ? rowHint !== undefined && "hint" : "error")}>
				{rowProblem ?? rowHint}
			</span>
		</div>
	);
}

/**
 * Prefix placeholder and help are required props because the two surfaces differ (global keys may lead with a base
 * URL; entry keys are already scoped). Row keys read RAW throughout this editor: parseParameterRecord trims nothing,
 * so a padded " _inherit_from" is a live field, not the directive. The grid's column heads label rendered rows; an
 * empty group keeps just the add action instead of heads over nothing.
 */
export function ParamGroupsFields({
	group,
	problems,
	hints,
	disabled,
	prefixPlaceholder,
	prefixHelp,
	prefixSuggestions,
	paramNameSuggestions,
	onChange,
	onEnter,
}: {
	/** The matcher group under edit. */
	group: PrefixGroup;

	/** The parse's blocking problems for this group, row-aligned. */
	problems: GroupProblems | undefined;

	/** Row-aligned non-blocking notes from the same parse (the _force semantic warnings). */
	hints?: GroupHints | undefined;

	/** True while the owner refuses edits (a save or apply in flight). */
	disabled?: boolean | undefined;

	/** The prefix input's placeholder, by surface. */
	prefixPlaceholder: string;

	/** The prefix input's help text, by surface. */
	prefixHelp: string;

	/** The prefix input's listbox; absent, the input stays plain. */
	prefixSuggestions?: readonly string[] | undefined;

	/** The parameter-name inputs' listbox; absent, they stay plain. */
	paramNameSuggestions?: readonly string[] | undefined;

	/** The group after an edit. */
	onChange: (next: PrefixGroup) => void;

	/** Enter in a row input; the editors apply the draft when it parses clean. */
	onEnter?: (() => void) | undefined;
}) {
	const inert = disabled === true;
	const patchGroup = (patch: Partial<PrefixGroup>) => {
		onChange({ ...group, ...patch });
	};
	const focusHold = useFocusedRow();
	const wrongTypeIdBase = useId();
	const rowAbsorbed = (index: number): boolean =>
		!focusHold.focused(group.params[index]?.id ?? "") &&
		directiveRowAbsorbed("params", group, index, PARAM_FLAG_DIRECTIVES) &&
		(group.params[index]?.key === INHERIT_FROM_DIRECTIVE || hints?.params[index] === undefined);
	const inheritFromIndex = group.params.findIndex((param) => param.key === INHERIT_FROM_DIRECTIVE);
	const anyRowVisible = group.params.some((_, index) => !rowAbsorbed(index));
	const row: ParamRowContext = {
		group,
		inert,
		disabled,
		problems,
		hints,
		paramNameSuggestions,
		forcedFields: directiveMarkedFields("params", group, FORCE_DIRECTIVE),
		wrongTypeIdBase,
		focusHold,
		onChange,
		patchGroup,
		onEnter,
		onKeyDown: enterHandler(onEnter),
	};
	return (
		<div className="group">
			<MatcherSection
				group={group}
				prefixProblem={problems?.prefix}
				inert={inert}
				prefixPlaceholder={prefixPlaceholder}
				prefixHelp={prefixHelp}
				prefixSuggestions={prefixSuggestions}
				onPrefix={(next) => patchGroup({ prefix: next })}
				onEnter={onEnter}
			/>
			<div className="editor-section">
				<InheritFromControl
					kind="params"
					group={group}
					disabled={inert}
					hint={inheritFromIndex >= 0 && rowAbsorbed(inheritFromIndex) ? hints?.params[inheritFromIndex] : undefined}
					onChange={onChange}
				/>
			</div>
			<div className="editor-section">
				<span className="editor-label">{l10n.t("Fields")}</span>
				<div className="rows">
					{anyRowVisible ? <ParamRowsHead /> : null}
					{group.params.map((param, paramIndex) =>
						rowAbsorbed(paramIndex) ? null : (
							<ParamRowFields key={param.id} row={row} param={param} paramIndex={paramIndex} />
						)
					)}
				</div>
				<Button
					variant="secondary"
					disabled={disabled}
					onClick={() => patchGroup({ params: [...group.params, newParamRow("", "")] })}
				>
					<IconAdd /> {l10n.t("Add parameter")}
				</Button>
			</div>
		</div>
	);
}

/** Discovery's 512-key cap per server, applied again to the cross-server union: the list is RENDERED per keystroke. */
const OBSERVED_SUGGESTION_LIMIT = 512;

/**
 * Suggestions only - the vocabulary is open.
 *
 *   a capability record reads such a key as a directive -> `_`-led names are dropped
 *   a server-reported `__proto__`                       -> falls out here too
 */
export function capabilityKeySuggestions(observedKeys?: readonly string[]): readonly string[] {
	const consumed = Object.keys(CONSUMED_CAPABILITY_FIELDS);
	const known = new Set(consumed);
	const observed = [...new Set(observedKeys ?? [])]
		.filter((key) => key.length > 0 && !key.startsWith("_") && !known.has(key))
		.sort()
		.slice(0, OBSERVED_SUGGESTION_LIMIT);
	return [...consumed, ...observed, ...RECORD_TYPE_DIRECTIVES.capabilities];
}

/** The no-evidence list (consumed fields plus directives), the fallback wherever no observed set is known. */
export const CAPABILITY_KEY_SUGGESTIONS: readonly string[] = capabilityKeySuggestions();

/** The listbox cursor as the key handler drives it: what is open, what it can land on, and how to move. */
interface SuggestNavigation {
	readonly expanded: boolean;
	readonly matches: readonly string[];
	readonly highlighted: number;
	readonly disabled: boolean;
	readonly pick: (suggestion: string) => void;
	readonly openAt: (index: number) => void;
	readonly moveTo: (index: number) => void;
	readonly close: () => void;
	readonly onEnter: (() => void) | undefined;
}

interface SuggestionListProps {
	readonly listId: string;
	readonly listRef: React.RefObject<HTMLDivElement | null>;
	readonly matches: readonly string[];
	readonly highlighted: number;
	readonly onPick: (suggestion: string) => void;
}

/**
 * Reopen a closed list after an Escape (or blur) with the arrow landing straight on an option, per the combobox
 * pattern: an unhighlighted reopen would send the very next Enter to Apply instead of accepting.
 */
function closedListKey(event: KeyboardEvent, nav: SuggestNavigation): void {
	if (nav.matches.length === 0 || nav.disabled) {
		return;
	}
	if (event.key === "ArrowDown") {
		nav.openAt(0);
		event.preventDefault();
	} else if (event.key === "ArrowUp") {
		nav.openAt(nav.matches.length - 1);
		event.preventDefault();
	}
}

/**
 * The open list's arrows wrap; Escape closes it and consumes the key, because inside a slide-over form it must close
 * only the suggestions, not request the form's close.
 */
function openListKey(event: KeyboardEvent, nav: SuggestNavigation): void {
	const count = nav.matches.length;
	if (event.key === "ArrowDown") {
		nav.moveTo((nav.highlighted + 1) % count);
	} else if (event.key === "ArrowUp") {
		nav.moveTo(nav.highlighted <= 0 ? count - 1 : nav.highlighted - 1);
	} else if (event.key === "Escape") {
		nav.close();
		event.stopPropagation();
	} else {
		return;
	}
	event.preventDefault();
}

/** Enter accepts a highlighted suggestion and nothing else; otherwise it falls through to the owner's Enter. */
function suggestKeyDown(event: KeyboardEvent, nav: SuggestNavigation): void {
	if (event.key === "Enter") {
		const match = nav.highlighted >= 0 ? nav.matches[nav.highlighted] : undefined;
		if (nav.expanded && match !== undefined) {
			nav.pick(match);
			event.preventDefault();
			return;
		}
		nav.onEnter?.();
		return;
	}
	if (nav.expanded) {
		openListKey(event, nav);
	} else {
		closedListKey(event, nav);
	}
}

/**
 * The suggestion listbox. mousedown, not click: the input's blur closes the list before a click could land. The click
 * handler still picks for activations that never send a mousedown (assistive tech's synthesized clicks); pick is
 * idempotent.
 */
function SuggestionList({ listId, listRef, matches, highlighted, onPick }: SuggestionListProps) {
	return (
		<div
			className="catalog-results suggest-results"
			role="listbox"
			id={listId}
			ref={listRef}
			aria-label={l10n.t("Suggestions")}
		>
			{matches.map((suggestion, index) => (
				<button
					key={suggestion}
					type="button"
					role="option"
					id={`${listId}-${index}`}
					aria-selected={index === highlighted}
					tabIndex={-1}
					className={index === highlighted ? "active" : undefined}
					onMouseDown={(event) => {
						event.preventDefault();
						onPick(suggestion);
					}}
					onClick={() => onPick(suggestion)}
				>
					{suggestion}
				</button>
			))}
		</div>
	);
}

/**
 * A text input with its own suggestion listbox, replacing the native datalist (the webview host renders it all-bold
 * and unstylable); the catalog picker's combobox pattern. Enter WITHOUT a highlighted suggestion falls through to
 * `onEnter`, so accepting a suggestion can never double as Apply on a half-typed row.
 *
 * With nothing to suggest (the read-only scope grids, entry editors without model data) the input stays a plain text
 * field: combobox aria naming a listbox that can never exist would be a lie to assistive tech. A separate element, not
 * conditional attributes: the a11y lint checks role/aria pairs statically.
 */
export function SuggestInput({
	value,
	suggestions,
	inputClass,
	invalid,
	placeholder,
	ariaLabel,
	describedBy,
	disabled,
	onValue,
	onEnter,
}: {
	/** The text as typed. */
	value: string;

	/** The listbox's candidates; none keeps the input a plain text field. */
	suggestions: readonly string[];

	/** The input's base class ("key"). */
	inputClass: string;

	/** Sets aria-invalid; the input primitive paints it. */
	invalid: boolean;

	/** The input's placeholder. */
	placeholder?: string | undefined;

	/** The accessible name where the visible label is a column head, not a wired <label>. */
	ariaLabel?: string | undefined;

	/** An aria-describedby target (the wrong-record-type sentence beside a directive key). */
	describedBy?: string | undefined;

	/** True while the owner refuses edits. */
	disabled?: boolean | undefined;

	/** Every keystroke and every accepted suggestion. */
	onValue: (next: string) => void;

	/** Enter with no highlighted suggestion; the editors apply the draft when it parses clean. */
	onEnter?: (() => void) | undefined;
}) {
	const [open, setOpen] = useState(false);
	// The keyboard cursor over the suggestion list; -1 means nothing highlighted.
	const [active, setActive] = useState(-1);
	const listId = useId();
	const listRef = useRef<HTMLDivElement>(null);
	const needle = trimHttpWhitespace(value).toLowerCase();
	const matches =
		needle.length === 0 ? suggestions : suggestions.filter((candidate) => candidate.toLowerCase().includes(needle));
	const expanded = open && disabled !== true && matches.length > 0;
	// Typing reshapes the match list under the cursor, so input resets it; the render-time clamp covers the same list
	// shrinking for any other reason.
	const highlighted = active >= 0 && active < matches.length ? active : -1;
	// Focus stays on the input (the aria-activedescendant pattern), so the browser never scrolls the highlight into the
	// popup's view on its own.
	useEffect(() => {
		if (highlighted >= 0) {
			listRef.current?.querySelector(`[aria-selected="true"]`)?.scrollIntoView({ block: "nearest" });
		}
	}, [highlighted]);
	const close = () => {
		setOpen(false);
		setActive(-1);
	};
	const pick = (suggestion: string) => {
		onValue(suggestion);
		close();
	};
	const onKeyDown = (event: KeyboardEvent) =>
		suggestKeyDown(event, {
			expanded,
			matches,
			highlighted,
			disabled: disabled === true,
			pick,
			openAt: (index) => {
				setOpen(true);
				setActive(index);
			},
			moveTo: setActive,
			close,
			onEnter,
		});
	if (suggestions.length === 0) {
		return (
			<span className="suggest-input">
				<Input
					type="text"
					className={inputClass}
					aria-invalid={invalid}
					aria-label={ariaLabel}
					aria-describedby={describedBy}
					placeholder={placeholder}
					value={value}
					disabled={disabled}
					onChange={(event) => onValue(event.currentTarget.value)}
					onKeyDown={onKeyDown}
				/>
			</span>
		);
	}
	return (
		<span className="suggest-input">
			<Input
				type="text"
				className={inputClass}
				role="combobox"
				aria-invalid={invalid}
				aria-label={ariaLabel}
				aria-describedby={describedBy}
				aria-expanded={expanded}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={highlighted >= 0 ? `${listId}-${highlighted}` : undefined}
				placeholder={placeholder}
				value={value}
				disabled={disabled}
				onChange={(event) => {
					setOpen(true);
					setActive(-1);
					onValue(event.currentTarget.value);
				}}
				onFocus={() => setOpen(true)}
				onBlur={close}
				onKeyDown={onKeyDown}
			/>
			{expanded ? (
				<SuggestionList listId={listId} listRef={listRef} matches={matches} highlighted={highlighted} onPick={pick} />
			) : null}
		</span>
	);
}

/**
 *   the vocabulary is open -> unknown keys stay free-form
 */
export function capabilityValueKind(key: string): "number" | "boolean" | "cost" | "catalog-id" | "json" {
	if (key === OPENROUTER_MODEL_DIRECTIVE) {
		return "catalog-id";
	}
	const kind = consumedFieldKind(key);
	return kind === undefined || kind === "string-array" ? "json" : kind;
}

/** The number-family value inputs' shared attributes; costs allow 0 and decimals, token counts do not. */
function numberInputProps(kind: "number" | "cost"): { min: number; step: number | "any"; placeholder: string } {
	return kind === "cost"
		? { min: 0, step: "any", placeholder: l10n.t("Cost per token, e.g. 0.000002") }
		: { min: 1, step: 1, placeholder: l10n.t("Tokens, e.g. 128000") };
}

/** What an HTML number input can DISPLAY (the spec's "valid floating-point number"); anything else blanks it. */
const NUMBER_INPUT_TEXT = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * The key's typed control only while the current text fits it, raw JSON text otherwise: invalid values are deliberately
 * preserved, and a typed control would misrepresent them (a number input displays a stored `"free"` as blank). The
 * number grammar is tested against the UNTRIMMED text, because the control renders the text as it is.
 */
export function capabilityControlKind(key: string, valueText: string): ReturnType<typeof capabilityValueKind> {
	const kind = capabilityValueKind(key);
	if (kind === "boolean") {
		// The checkbox reads trimmed text ("true " still shows checked), so fitting is judged trimmed too.
		const trimmed = trimHttpWhitespace(valueText);
		return trimmed === "" || trimmed === "true" || trimmed === "false" ? kind : "json";
	}
	if (kind === "number" || kind === "cost") {
		return valueText === "" || NUMBER_INPUT_TEXT.test(valueText) ? kind : "json";
	}
	return kind;
}

const CATALOG_SEARCH_DEBOUNCE_MS = 300;

/** One catalog hit the picker lists. */
interface CatalogMatch {
	readonly id: string;
	readonly name: string;
}

interface CatalogResultsProps {
	readonly listId: string;
	readonly matches: readonly CatalogMatch[];
	readonly active: number;
	readonly onPick: (id: string) => void;
}

/**
 * The open result list's keys: the arrows wrap, Enter picks the highlighted hit, Escape closes and consumes the key,
 * because inside a chip popover or a slide-over it must close only the results, not the surface above.
 */
function catalogKeyDown(
	event: KeyboardEvent,
	matches: readonly CatalogMatch[],
	active: number,
	moves: {
		readonly setActive: (update: (current: number) => number) => void;
		readonly pick: (id: string) => void;
		readonly close: () => void;
	}
): void {
	if (event.key === "ArrowDown") {
		moves.setActive((current) => (current + 1) % matches.length);
	} else if (event.key === "ArrowUp") {
		moves.setActive((current) => (current <= 0 ? matches.length - 1 : current - 1));
	} else if (event.key === "Enter" && active >= 0) {
		const match = matches[active];
		if (match !== undefined) {
			moves.pick(match.id);
		}
	} else if (event.key === "Escape") {
		moves.close();
		event.stopPropagation();
	} else {
		return;
	}
	event.preventDefault();
}

/** The catalog hits; mousedown, not click, because the input's blur closes the list before a click could land. */
function CatalogResults({ listId, matches, active, onPick }: CatalogResultsProps) {
	return (
		<div className="catalog-results" role="listbox" id={listId} aria-label={l10n.t("Catalog matches")}>
			{matches.map((match, index) => (
				<button
					key={match.id}
					type="button"
					role="option"
					id={`${listId}-${index}`}
					aria-selected={index === active}
					tabIndex={-1}
					className={index === active ? "active" : undefined}
					onMouseDown={(event) => {
						event.preventDefault();
						onPick(match.id);
					}}
				>
					<span className="catalog-id">{match.id}</span> <span className="hint">{match.name}</span>
				</button>
			))}
		</div>
	);
}

/**
 * Only summaries cross the boundary - the catalog itself never enters the webview.
 *
 *   debounceMs -> the search debounce; a prop only so tests need not wait out the real value
 */
export function CatalogPicker({
	value,
	disabled,
	invalid,
	onValue,
	debounceMs = CATALOG_SEARCH_DEBOUNCE_MS,
}: {
	value: string;
	disabled: boolean;
	invalid: boolean;
	onValue: (next: string) => void;
	debounceMs?: number;
}) {
	const [open, setOpen] = useState(false);
	const catalog = useRpc("searchCatalog");
	// The keyboard cursor over the result list; -1 means nothing highlighted.
	const [active, setActive] = useState(-1);
	const listId = useId();
	const query = trimHttpWhitespace(value);

	const { send: searchCatalog, reset: resetCatalog } = catalog;
	useEffect(() => {
		if (!open || query.length < 2) {
			resetCatalog();
			return undefined;
		}
		const timer = setTimeout(() => {
			searchCatalog({ query });
		}, debounceMs);
		return () => clearTimeout(timer);
	}, [open, query, debounceMs, searchCatalog, resetCatalog]);

	const matches = catalog.data?.results;
	const listed = open && matches !== undefined && matches.length > 0;
	const close = () => {
		setOpen(false);
		setActive(-1);
	};
	const pick = (id: string) => {
		onValue(id);
		close();
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (!listed) {
			return;
		}
		catalogKeyDown(event, matches, active, { setActive, pick, close });
	};
	return (
		<span className="cell value catalog-picker">
			<Input
				type="text"
				className="value"
				role="combobox"
				aria-invalid={invalid}
				aria-expanded={listed}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
				aria-label={l10n.t("Value")}
				placeholder={l10n.t("OpenRouter ID, e.g. openai/gpt-4o")}
				value={value}
				disabled={disabled}
				onChange={(event) => {
					setOpen(true);
					setActive(-1);
					onValue(event.currentTarget.value);
				}}
				onFocus={() => setOpen(true)}
				onBlur={close}
				onKeyDown={onKeyDown}
			/>
			<Help text={helpCatalogPicker()} />
			{listed ? <CatalogResults listId={listId} matches={matches} active={active} onPick={pick} /> : null}
		</span>
	);
}

/** What every capability row reads: the group, its issues, the shared inputs, and the group's edit moves. */
interface CapabilityRowContext {
	readonly group: PrefixGroup;
	readonly inert: boolean;
	readonly issues: CapabilityGroupIssues | undefined;
	readonly keySuggestions: readonly string[] | undefined;
	readonly fallbackFields: ReadonlySet<string>;
	readonly wrongTypeIdBase: string;
	readonly focusHold: ReturnType<typeof useFocusedRow>;
	readonly onChange: (next: PrefixGroup) => void;
	readonly patchGroup: (patch: Partial<PrefixGroup>) => void;
	readonly onEnter: (() => void) | undefined;
	readonly onKeyDown: ((event: KeyboardEvent) => void) | undefined;
}

interface CapabilityRowProps {
	readonly row: CapabilityRowContext;
	readonly param: ParamRow;
	readonly paramIndex: number;
}

interface CapabilityValueCellProps {
	readonly kind: ReturnType<typeof capabilityControlKind>;
	readonly valueText: string;
	readonly inert: boolean;
	readonly invalid: boolean;
	readonly onValue: (next: string) => void;
	readonly onKeyDown: ((event: KeyboardEvent) => void) | undefined;
}

interface CapabilityFlagCellProps {
	readonly row: CapabilityRowContext;
	readonly fieldKey: string;
	readonly wrongType: WrongTypeNote | undefined;
}

/** The words and keys the bare input takes from its caller. */
interface CapabilityInputAttributes {
	readonly ariaLabel: string;
	readonly describedBy?: string | undefined;
	readonly placeholder: string;
	readonly onKeyDown?: ((event: KeyboardEvent<HTMLInputElement>) => void) | undefined;
}

/**
 * What the shared capability control takes. The callers own the words and the boxes: the flag label's class differs by
 * grid, and only the row grid boxes the bare input (the picker and the flag label are boxes of their own).
 */
interface CapabilityControlProps {
	readonly kind: ReturnType<typeof capabilityControlKind>;
	readonly valueText: string;
	readonly disabled: boolean;
	readonly invalid: boolean | undefined;
	readonly flagClassName: string;
	readonly inputClassName?: string | undefined;
	readonly input: CapabilityInputAttributes;
	readonly onValue: (next: string) => void;
}

function CapabilityRowsHead() {
	return (
		<div className="rows-head">
			<span className="col-head">
				{l10n.t("Capability")}
				<Help text={helpCapabilityName()} />
			</span>
			<span className="col-head">
				{l10n.t("Value")}
				<Help text={helpCapabilityValue()} />
			</span>
		</div>
	);
}

/**
 * The value control every capability editor shares, by the key's kind: a checkbox for a boolean capability, the catalog
 * picker for the OpenRouter model directive, a number or text input otherwise.
 */
export function CapabilityControl(props: CapabilityControlProps) {
	const { kind, valueText, disabled, invalid, flagClassName, inputClassName, input, onValue } = props;
	if (kind === "boolean") {
		return (
			<label className={flagClassName}>
				<Checkbox
					checked={trimHttpWhitespace(valueText) === "true"}
					disabled={disabled}
					onChange={(event) => onValue(event.currentTarget.checked ? "true" : "false")}
				/>
				{l10n.t("supported")}
			</label>
		);
	}
	if (kind === "catalog-id") {
		return <CatalogPicker value={valueText} disabled={disabled} invalid={invalid === true} onValue={onValue} />;
	}
	const numberProps = kind === "number" || kind === "cost" ? numberInputProps(kind) : undefined;
	const control = (
		<Input
			type={numberProps === undefined ? "text" : "number"}
			min={numberProps?.min}
			step={numberProps?.step}
			className="value"
			aria-invalid={invalid}
			aria-describedby={input.describedBy}
			aria-label={input.ariaLabel}
			placeholder={numberProps?.placeholder ?? input.placeholder}
			value={valueText}
			disabled={disabled}
			onChange={(event) => onValue(event.currentTarget.value)}
			onKeyDown={input.onKeyDown}
		/>
	);
	return inputClassName === undefined ? control : <span className={inputClassName}>{control}</span>;
}

/** The value cell by the key's kind, in the row grid's boxes. */
function CapabilityValueCell({ kind, valueText, inert, invalid, onValue, onKeyDown }: CapabilityValueCellProps) {
	return (
		<CapabilityControl
			kind={kind}
			valueText={valueText}
			disabled={inert}
			invalid={invalid}
			flagClassName="cell value capability-flag"
			inputClassName="cell value"
			input={{ ariaLabel: l10n.t("Value"), placeholder: l10n.t("JSON value"), onKeyDown }}
			onValue={onValue}
		/>
	);
}

/**
 * The row's flag cell. The vocabulary is open, so every non-directive field carries the fallback box - the resolver's
 * `_fallback` accepts any field the record sets; a directive key of the other record type gets the wrong-type note.
 */
function CapabilityFlagCell({ row, fieldKey, wrongType }: CapabilityFlagCellProps) {
	const { group, inert, fallbackFields, onChange } = row;
	if (directiveEligible(FALLBACK_DIRECTIVE, fieldKey)) {
		return (
			<span className="cell directive-flag">
				<label>
					<Checkbox
						aria-label={l10n.t('Fall back for "{0}"', fieldKey)}
						checked={fallbackFields.has(fieldKey)}
						disabled={inert}
						onChange={(event) =>
							onChange(toggleDirectiveField("caps", group, FALLBACK_DIRECTIVE, fieldKey, event.currentTarget.checked))
						}
					/>
					{fallbackWord()}
				</label>
				<Help text={helpFallbackFlag()} />
				<InheritableFlag kind="caps" group={group} fieldKey={fieldKey} disabled={inert} onChange={onChange} />
			</span>
		);
	}
	return wrongType === undefined ? null : <WrongTypeFlagCell note={wrongType.note} id={wrongType.id} />;
}

/**
 * One capability row, the parameters row's twin: the stacked tier's per-cell labels (dashboard.css .cell-label, words
 * aria-hidden since the inputs carry the same accessible names), the reserved status line with its worst-first pick
 * between the row's problem and its non-blocking hint. A key whose kind is boolean seeds an empty value to "true".
 */
function CapabilityRowFields({ row, param, paramIndex }: CapabilityRowProps) {
	const { group, inert, issues, patchGroup, onEnter, onKeyDown } = row;
	const issue = issues?.rows[paramIndex];
	const key = resolvedFieldName("caps", param.key);
	const kind = capabilityControlKind(key, param.valueText);
	const removeLabel = key.length > 0 ? l10n.t('Remove "{0}"', key) : l10n.t("Remove");
	const wrongType = wrongTypeNote("caps", key, `${row.wrongTypeIdBase}-${param.id}`);
	const patchRow = (patch: Partial<{ key: string; valueText: string }>) =>
		patchGroup({
			params: group.params.map((p, i) => (i === paramIndex ? { ...p, ...patch } : p)),
		});
	return (
		<div className="row" {...row.focusHold.rowFocusProps(param.id)}>
			<span className="cell-label">
				<span aria-hidden="true">{l10n.t("Capability")}</span>
				<Help text={helpCapabilityName()} />
			</span>
			<span className="cell key">
				<SuggestInput
					value={param.key}
					suggestions={row.keySuggestions ?? CAPABILITY_KEY_SUGGESTIONS}
					inputClass="key"
					invalid={issue?.problem?.field === "name"}
					placeholder={l10n.t("Capability, e.g. context_length")}
					ariaLabel={l10n.t("Capability")}
					describedBy={wrongType?.id}
					disabled={inert}
					onValue={(nextKey) => {
						const seedsTrue =
							capabilityValueKind(resolvedFieldName("caps", nextKey)) === "boolean" &&
							trimHttpWhitespace(param.valueText).length === 0;
						patchRow({ key: nextKey, ...(seedsTrue ? { valueText: "true" } : {}) });
					}}
					onEnter={onEnter}
				/>
			</span>
			<span className="cell-label">
				<span aria-hidden="true">{l10n.t("Value")}</span>
				<Help text={helpCapabilityValue()} />
			</span>
			<CapabilityValueCell
				kind={kind}
				valueText={param.valueText}
				inert={inert}
				invalid={issue?.problem?.field === "value"}
				onValue={(next) => patchRow({ valueText: next })}
				onKeyDown={onKeyDown}
			/>
			<CapabilityFlagCell row={row} fieldKey={key} wrongType={wrongType} />
			<Button
				variant="danger"
				size="compact"
				aria-label={removeLabel}
				title={removeLabel}
				disabled={inert}
				onClick={() => patchGroup({ params: group.params.filter((_, i) => i !== paramIndex) })}
			>
				<IconTrash />
			</Button>
			<span className={cn("row-status", issue?.problem === undefined ? issue?.hint !== undefined && "hint" : "error")}>
				{issue?.problem?.message ?? issue?.hint}
			</span>
		</div>
	);
}

/**
 * The capabilities twin of ParamGroupsFields: one matcher group's rows, with the fallback and inheritable flags. The
 * grid's column heads label rendered rows; an empty group keeps just the add action instead of heads over nothing.
 *
 *   prefixSuggestions -> the matcher input's listbox; absent, the input stays plain
 *   keySuggestions    -> the capability-name suggestions (capabilityKeySuggestions); absent, the no-evidence static
 *                        list serves
 *   onEnter           -> Enter in a row input; the editors apply the draft when it parses clean
 */
export function CapabilityGroupsFields({
	group,
	issues,
	disabled,
	prefixSuggestions,
	keySuggestions,
	onChange,
	onEnter,
}: {
	group: PrefixGroup;
	issues: CapabilityGroupIssues | undefined;
	disabled?: boolean | undefined;
	prefixSuggestions?: readonly string[] | undefined;
	keySuggestions?: readonly string[] | undefined;
	onChange: (next: PrefixGroup) => void;
	onEnter?: (() => void) | undefined;
}) {
	const inert = disabled === true;
	const patchGroup = (patch: Partial<PrefixGroup>) => {
		onChange({ ...group, ...patch });
	};
	const focusHold = useFocusedRow();
	const wrongTypeIdBase = useId();
	const rowAbsorbed = (index: number): boolean =>
		!focusHold.focused(group.params[index]?.id ?? "") &&
		directiveRowAbsorbed("caps", group, index, CAPABILITY_FLAG_DIRECTIVES) &&
		(resolvedFieldName("caps", group.params[index]?.key ?? "") === INHERIT_FROM_DIRECTIVE ||
			issues?.rows[index]?.hint === undefined);
	const inheritFromIndex = group.params.findIndex(
		(param) => resolvedFieldName("caps", param.key) === INHERIT_FROM_DIRECTIVE
	);
	const anyRowVisible = group.params.some((_, index) => !rowAbsorbed(index));
	const row: CapabilityRowContext = {
		group,
		inert,
		issues,
		keySuggestions,
		fallbackFields: directiveMarkedFields("caps", group, FALLBACK_DIRECTIVE),
		wrongTypeIdBase,
		focusHold,
		onChange,
		patchGroup,
		onEnter,
		onKeyDown: enterHandler(onEnter),
	};
	return (
		<div className="group">
			<MatcherSection
				group={group}
				prefixProblem={issues?.prefix}
				inert={inert}
				prefixPlaceholder={l10n.t("Model ID or matcher, e.g. gpt-4 or gpt-4*")}
				prefixHelp={helpCapabilityPrefix()}
				prefixSuggestions={prefixSuggestions}
				onPrefix={(next) => patchGroup({ prefix: next })}
				onEnter={onEnter}
			/>
			<div className="editor-section">
				<InheritFromControl
					kind="caps"
					group={group}
					disabled={inert}
					hint={
						inheritFromIndex >= 0 && rowAbsorbed(inheritFromIndex) ? issues?.rows[inheritFromIndex]?.hint : undefined
					}
					onChange={onChange}
				/>
			</div>
			<div className="editor-section">
				<span className="editor-label">{l10n.t("Fields")}</span>
				<div className="rows">
					{anyRowVisible ? <CapabilityRowsHead /> : null}
					{group.params.map((param, paramIndex) =>
						rowAbsorbed(paramIndex) ? null : (
							<CapabilityRowFields key={param.id} row={row} param={param} paramIndex={paramIndex} />
						)
					)}
				</div>
				<Button
					variant="secondary"
					disabled={inert}
					onClick={() => patchGroup({ params: [...group.params, newParamRow("", "")] })}
				>
					<IconAdd /> {l10n.t("Add capability")}
				</Button>
			</div>
		</div>
	);
}
