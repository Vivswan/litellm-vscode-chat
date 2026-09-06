/**
 * The full editor's field groups: the parameter and capability field lists with
 * their suggestion inputs, the inherit-from control and inheritable flag, and
 * the catalog picker.
 */
import * as l10n from "@vscode/l10n";
import type { FocusEvent, KeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { CapabilityGroupIssues, GroupHints, GroupProblems, PrefixGroup } from "../../dashboard/recordDraft";
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
import { CONSUMED_CAPABILITY_FIELDS } from "../../shared/config/capabilityResolution";
import {
	FALLBACK_DIRECTIVE,
	FORCE_DIRECTIVE,
	INHERIT_FROM_DIRECTIVE,
	INHERITABLE_DIRECTIVE,
	OPENROUTER_MODEL_DIRECTIVE,
	RECORD_TYPE_DIRECTIVES,
} from "../../shared/config/recordResolution";
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
import { CAPABILITY_FLAG_DIRECTIVES, PARAM_FLAG_DIRECTIVES, WrongTypeFlagCell } from "./recordFlags";
import type { RecordEditorKind } from "./recordIssues";
import { matcherKindLabel } from "./recordIssues";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { cn } from "./ui/cn";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

/**
 * The group-level `_inherit_from` control, the directive's single representation (a
 * readable row is absorbed out of the grid), so it also carries the row's hint. It goes
 * hands-off while the row holds text the strict parse rejects: the select must not
 * silently rewrite the user's text.
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
	/** The absorbed `_inherit_from` row's non-blocking note (an unknown record key), rendered beside the control. */
	hint?: string | undefined;
	onChange: (next: PrefixGroup) => void;
}) {
	const choice = inheritFromChoice(kind, group);
	const id = useId();
	// Keys mode held open locally: defined means the select shows "keys" even
	// while no row exists (picking keys writes nothing until a key is typed -
	// setInheritFromChoice's keys arm cannot write an empty list, so the
	// stored barrier stays "none" / Edit as JSON). The text is the input's
	// value while no row backs it.
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
		choice.kind === "keys" ? "keys" : pending !== undefined && choice.kind === "default" ? "keys" : choice.kind;
	const keysText = choice.kind === "keys" ? choice.keysText : (pending?.text ?? "");
	const writeKeys = (text: string) => {
		const keys = parseInheritKeysText(text);
		if (keys !== undefined) {
			setPending((current) => (current === undefined ? current : { text }));
			onChange(setInheritFromChoice(kind, group, { keys }));
		} else if (choice.kind === "keys") {
			// Emptied: drop the row; the pending mode keeps the input on screen
			// for the next key - a stored keys row entered edit without local
			// mode, and dropping the row bare would unmount the input mid-edit
			// and steal focus.
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
					// Compact: the control sits inline in a dense editor row.
					className="px-1 py-0.5"
					disabled={disabled}
					value={shownKind}
					onChange={(event) => {
						const selected = event.currentTarget.value;
						if (selected === "default" || selected === "all" || selected === "none") {
							setPending(undefined);
							onChange(setInheritFromChoice(kind, group, selected));
						} else {
							// Enter keys mode without writing; see the comment above.
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
				{hint !== undefined ? <span className="hint">{hint}</span> : null}
			</span>
		</span>
	);
}

/**
 * The per-row `_inheritable` mark, rendered by both editors beside the
 * force/fallback mark: broader records mark fields here so more specific
 * matches inherit them.
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
	/** The row's key in the resolver's reading (resolvedFieldName). */
	fieldKey: string;
	disabled: boolean;
	onChange: (next: PrefixGroup) => void;
}) {
	const marked = directiveMarkedFields(kind, group, INHERITABLE_DIRECTIVE);
	if (!directiveEligible(INHERITABLE_DIRECTIVE, fieldKey)) {
		return null;
	}
	// A bare label-plus-help fragment: the caller owns the row's one
	// directive-flag cell, so two marks never fight over the grid column.
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
 * Which row's text inputs own focus, so absorbing a directive row cannot unmount the
 * input mid-keystroke and steal focus; rows absorb on blur. The hold names the row's
 * stable id: removing a focused row fires no focusout, but the stranded hold then names
 * an id no row carries, so the row that shifts into its place is never pinned. Only
 * text inputs arm it.
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

/**
 * The model-parameter group rows: one row per parameter, values as JSON, problems
 * row-aligned from parseGroups. Renders ONE group, inside the matcher editor overlay
 * only. Prefix placeholder and help are required props because the two surfaces differ
 * (global keys may lead with a base URL; entry keys are already scoped).
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
	group: PrefixGroup;
	problems: GroupProblems | undefined;
	/** Row-aligned non-blocking notes from the same parse (the _force semantic warnings). */
	hints?: GroupHints | undefined;
	disabled?: boolean | undefined;
	prefixPlaceholder: string;
	prefixHelp: string;
	/** Suggestions for the prefix and parameter-name inputs' listboxes; absent, the inputs stay plain. */
	prefixSuggestions?: readonly string[] | undefined;
	paramNameSuggestions?: readonly string[] | undefined;
	onChange: (next: PrefixGroup) => void;
	/** Enter in a row input; the editors apply the draft when it parses clean. */
	onEnter?: (() => void) | undefined;
}) {
	const inert = disabled === true;
	// The suggestion inputs guard their own Enter (a highlighted suggestion is
	// accepted, never applied); this handler serves the plain value inputs.
	const onKeyDown =
		onEnter === undefined
			? undefined
			: (event: KeyboardEvent) => {
					if (event.key === "Enter") {
						onEnter();
					}
				};
	const patchGroup = (patch: Partial<PrefixGroup>) => {
		onChange({ ...group, ...patch });
	};
	const focusHold = useFocusedRow();
	// The group's `_force` marks, derived once per render from the same
	// rows the checkboxes rewrite, so box state and row text cannot drift.
	const forcedFields = directiveMarkedFields("params", group, FORCE_DIRECTIVE);
	// The wrong-record-type rows' description ids, one namespace per editor.
	const wrongTypeIdBase = useId();
	// The control-backed directive rows the grid absorbs: the Inherits
	// select and the per-row checkboxes are their single representation.
	// A row those controls cannot fully display - an unreadable value, a
	// duplicate key, or a hinted stranded entry - stays visible and
	// editable, and a row being typed in absorbs only on blur. Row keys read
	// RAW throughout this editor: parseParameterRecord trims nothing, so a
	// padded " _inherit_from" is a live field, not the directive.
	const rowAbsorbed = (index: number): boolean =>
		!focusHold.focused(group.params[index]?.id ?? "") &&
		directiveRowAbsorbed("params", group, index, PARAM_FLAG_DIRECTIVES) &&
		(group.params[index]?.key === INHERIT_FROM_DIRECTIVE || hints?.params[index] === undefined);
	const inheritFromIndex = group.params.findIndex((param) => param.key === INHERIT_FROM_DIRECTIVE);
	// The grid's column heads label rendered rows; an empty group keeps
	// just the add action instead of heads over nothing.
	const anyRowVisible = group.params.some((_, index) => !rowAbsorbed(index));
	return (
		<div className="group">
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
						invalid={problems?.prefix !== undefined}
						placeholder={prefixPlaceholder}
						ariaLabel={l10n.t("Matcher")}
						disabled={inert}
						onValue={(next) => patchGroup({ prefix: next })}
						onEnter={onEnter}
					/>
				</div>
				{/* The matcher's reserved status line (dashboard.css .matcher-status): grammar at rest,
				    verdict in the same one-size slot - two spans changed heights and moved the sections
				    below under the typing hand. */}
				<span className={cn("matcher-status", problems?.prefix !== undefined && "error")}>
					{problems?.prefix ?? (group.prefix.trim().length > 0 ? matcherKindLabel(matcherKind(group.prefix)) : null)}
				</span>
			</div>
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
					{anyRowVisible ? (
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
					) : null}
					{group.params.map((param, paramIndex) => {
						if (rowAbsorbed(paramIndex)) {
							return null;
						}
						// The label names the field as the record stores it (verbatim
						// here); emptiness is the one judgment made trimmed, matching
						// the parse's own refusal of a whitespace-only name.
						const removeLabel = param.key.trim().length > 0 ? l10n.t('Remove "{0}"', param.key) : l10n.t("Remove");
						const rowProblem = problems?.params[paramIndex]?.message;
						const rowHint = hints?.params[paramIndex];
						// The wrong-record-type badge in the row's flag cell, its sentence
						// wired to the key input: the same fact the table's chips badge.
						// RAW key, like every classification in this editor - a padded
						// sibling-directive spelling is a live field, not an ignored row.
						const wrongType = wrongRecordTypeHint("params", param.key);
						const wrongTypeId = wrongType === undefined ? undefined : `${wrongTypeIdBase}-${param.id}`;
						return (
							<div className="row" key={param.id} {...focusHold.rowFocusProps(param.id)}>
								{/* The stacked tier's per-cell labels (dashboard.css .cell-label): once the rows stack
								    there are no tracks left for the column heads to label. aria-hidden - the input
								    already carries the word as its accessible name; the help button stays exposed. */}
								<span className="cell-label">
									<span aria-hidden="true">{l10n.t("Parameter")}</span>
									<Help text={helpModelParameterName()} />
								</span>
								<span className="cell key">
									<SuggestInput
										value={param.key}
										suggestions={paramNameSuggestions ?? []}
										inputClass="key"
										invalid={problems?.params[paramIndex]?.field === "name"}
										placeholder={l10n.t("Parameter, e.g. temperature")}
										ariaLabel={l10n.t("Parameter")}
										describedBy={wrongTypeId}
										disabled={inert}
										onValue={(next) =>
											patchGroup({
												params: group.params.map((p, i) => (i === paramIndex ? { ...p, key: next } : p)),
											})
										}
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
										onChange={(event) =>
											patchGroup({
												params: group.params.map((p, i) =>
													i === paramIndex ? { ...p, valueText: event.currentTarget.value } : p
												),
											})
										}
										onKeyDown={onKeyDown}
									/>
								</span>
								{/* The per-row force/inheritable marks in their own fixed column so the boxes align.
								    Directive rows carry no flag checkboxes (a directive cannot be forced or inherited);
								    unforceable keys keep the box visible but disabled, the help naming why. A sibling
								    record type's directive fills the cell with the "ignored" badge instead. */}
								{param.key.startsWith("_") || param.key.trim().length === 0 ? (
									wrongType === undefined || wrongTypeId === undefined ? null : (
										<WrongTypeFlagCell note={wrongType} id={wrongTypeId} />
									)
								) : (
									<span className="cell directive-flag">
										<label>
											<Checkbox
												aria-label={l10n.t('Force "{0}"', param.key)}
												checked={forcedFields.has(param.key)}
												disabled={inert || !directiveEligible(FORCE_DIRECTIVE, param.key)}
												onChange={(event) =>
													onChange(
														toggleDirectiveField(
															"params",
															group,
															FORCE_DIRECTIVE,
															param.key,
															event.currentTarget.checked
														)
													)
												}
											/>
											{l10n.t({
												message: "force",
												comment: ["Checkbox label on a parameter row; marks the value as forced over runtime options."],
											})}
										</label>
										<Help
											text={directiveEligible(FORCE_DIRECTIVE, param.key) ? helpForceFlag() : helpForceFlagDisabled()}
										/>
										<InheritableFlag
											kind="params"
											group={group}
											fieldKey={param.key}
											disabled={inert}
											onChange={onChange}
										/>
									</span>
								)}
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
								{/* Reserved whether or not it speaks (dashboard.css
							    .row .row-status): the verdict lands per keystroke, and a
							    line mounted only when it speaks moves the rows below.
							    Worst first - a problem outranks a hint. */}
								<span
									className={cn("row-status", rowProblem !== undefined ? "error" : rowHint !== undefined && "hint")}
								>
									{rowProblem ?? rowHint}
								</span>
							</div>
						);
					})}
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

/**
 * Discovery caps the observed set at 512 keys per server; the cross-server union gets
 * the same ceiling here - the list is RENDERED per keystroke.
 */
const OBSERVED_SUGGESTION_LIMIT = 512;

/**
 * The key suggestions the capability rows offer: consumed vocabulary first, then the
 * server-observed /model/info names, directives last. Suggestions only - the vocabulary
 * is open. Observed names are server-derived strings: they render as suggestion TEXT
 * only, never become object keys (the Set dedup), and `_`-led names are dropped - a
 * capability record reads such a key as a directive, so it cannot be suggested
 * (a server-reported `__proto__` falls out here too).
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

/**
 * A text input with its own suggestion listbox, replacing the native datalist (the
 * webview host renders it all-bold and unstylable); the catalog picker's combobox
 * pattern. Enter WITHOUT a highlighted suggestion falls through to `onEnter`, so
 * accepting a suggestion can never double as Apply on a half-typed row.
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
	value: string;
	suggestions: readonly string[];
	/** The input's base class ("key"); invalid appends the shared error class. */
	inputClass: string;
	invalid: boolean;
	placeholder?: string | undefined;
	/** The input's accessible name where the visible label is a column head, not a wired <label>. */
	ariaLabel?: string | undefined;
	/** An aria-describedby target (the wrong-record-type sentence beside a directive key). */
	describedBy?: string | undefined;
	disabled?: boolean | undefined;
	onValue: (next: string) => void;
	/** Enter with no highlighted suggestion; the editors apply the draft when it parses clean. */
	onEnter?: (() => void) | undefined;
}) {
	const [open, setOpen] = useState(false);
	// The keyboard cursor over the suggestion list; -1 means nothing highlighted.
	const [active, setActive] = useState(-1);
	const listId = useId();
	const listRef = useRef<HTMLDivElement>(null);
	const needle = value.trim().toLowerCase();
	const matches =
		needle.length === 0 ? suggestions : suggestions.filter((candidate) => candidate.toLowerCase().includes(needle));
	const expanded = open && disabled !== true && matches.length > 0;
	// Typing reshapes the match list under the cursor, so input resets it; the
	// render-time clamp covers the same list shrinking for any other reason.
	const highlighted = active >= 0 && active < matches.length ? active : -1;
	// Focus stays on the input (the aria-activedescendant pattern), so the
	// browser never scrolls the highlight into the popup's view on its own.
	useEffect(() => {
		if (highlighted >= 0) {
			listRef.current?.querySelector(`[aria-selected="true"]`)?.scrollIntoView({ block: "nearest" });
		}
	}, [highlighted]);
	const pick = (suggestion: string) => {
		onValue(suggestion);
		setOpen(false);
		setActive(-1);
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter") {
			const match = highlighted >= 0 ? matches[highlighted] : undefined;
			if (expanded && match !== undefined) {
				pick(match);
				event.preventDefault();
				return;
			}
			onEnter?.();
			return;
		}
		if (!expanded) {
			// Reopen after an Escape (or blur) with the arrow landing straight on
			// an option, per the combobox pattern: an unhighlighted reopen would
			// send the very next Enter to Apply instead of accepting.
			if (event.key === "ArrowDown" && matches.length > 0 && disabled !== true) {
				setOpen(true);
				setActive(0);
				event.preventDefault();
			} else if (event.key === "ArrowUp" && matches.length > 0 && disabled !== true) {
				setOpen(true);
				setActive(matches.length - 1);
				event.preventDefault();
			}
			return;
		}
		if (event.key === "ArrowDown") {
			setActive((highlighted + 1) % matches.length);
		} else if (event.key === "ArrowUp") {
			setActive(highlighted <= 0 ? matches.length - 1 : highlighted - 1);
		} else if (event.key === "Escape") {
			setOpen(false);
			setActive(-1);
			// The listbox consumes this Escape: inside a slide-over form it must
			// close only the suggestions, not request the form's close.
			event.stopPropagation();
		} else {
			return;
		}
		event.preventDefault();
	};
	// With nothing to suggest (the read-only scope grids, entry editors without
	// model data) the input stays a plain text field: combobox aria naming a
	// listbox that can never exist would be a lie to assistive tech. A separate
	// element, not conditional attributes: the a11y lint checks role/aria pairs
	// statically.
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
				onBlur={() => {
					setOpen(false);
					setActive(-1);
				}}
				onKeyDown={onKeyDown}
			/>
			{expanded ? (
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
							// mousedown, not click: the input's blur closes the list
							// before a click could land. The click handler still picks
							// for activations that never send a mousedown (assistive
							// tech's synthesized clicks); pick is idempotent.
							onMouseDown={(event) => {
								event.preventDefault();
								pick(suggestion);
							}}
							onClick={() => pick(suggestion)}
						>
							{suggestion}
						</button>
					))}
				</div>
			) : null}
		</span>
	);
}

/**
 * What input a capability row's value takes: token counts get number inputs, costs
 * decimal ones (0 is "free"), support flags checkboxes, everything else JSON text
 * (the vocabulary is open, so unknown keys stay free-form).
 */
export function capabilityValueKind(key: string): "number" | "boolean" | "cost" | "catalog-id" | "json" {
	if (key === OPENROUTER_MODEL_DIRECTIVE) {
		return "catalog-id";
	}
	const kind = Object.hasOwn(CONSUMED_CAPABILITY_FIELDS, key) ? CONSUMED_CAPABILITY_FIELDS[key] : undefined;
	return kind === undefined || kind === "string-array" ? "json" : kind;
}

/** The number-family value inputs' shared attributes; costs allow 0 and decimals, token counts do not. */
export function numberInputProps(kind: "number" | "cost"): { min: number; step: number | "any"; placeholder: string } {
	return kind === "cost"
		? { min: 0, step: "any", placeholder: l10n.t("Cost per token, e.g. 0.000002") }
		: { min: 1, step: 1, placeholder: l10n.t("Tokens, e.g. 128000") };
}

/**
 * What an HTML number input can DISPLAY (the spec's "valid floating-point number"
 * grammar); anything else is sanitized to a blank control, so it must keep the raw text
 * input. Tested against the UNTRIMMED text: the control renders the text as it is.
 */
const NUMBER_INPUT_TEXT = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * The key's typed control only while the current text fits it, raw JSON text otherwise:
 * invalid values are deliberately preserved, and a typed control would misrepresent
 * them (a number input displays a stored `"free"` as blank).
 */
export function capabilityControlKind(key: string, valueText: string): ReturnType<typeof capabilityValueKind> {
	const kind = capabilityValueKind(key);
	if (kind === "boolean") {
		// The checkbox reads trimmed text ("true " still shows checked), so
		// fitting is judged trimmed too.
		const trimmed = valueText.trim();
		return trimmed === "" || trimmed === "true" || trimmed === "false" ? kind : "json";
	}
	if (kind === "number" || kind === "cost") {
		return valueText === "" || NUMBER_INPUT_TEXT.test(valueText) ? kind : "json";
	}
	return kind;
}

/** How long a picker waits after the last keystroke before searching the catalog. */
const CATALOG_SEARCH_DEBOUNCE_MS = 300;

/**
 * The `_openrouter_model` value input with its debounced catalog search. Only summaries
 * cross the boundary - the catalog itself never enters the webview.
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
	/** The search debounce; a prop only so tests need not wait out the real value. */
	debounceMs?: number;
}) {
	const [open, setOpen] = useState(false);
	// The picker's own search round trip; a closed or too-short query orphans
	// any in-flight request, exactly like the fresh-requestId reset it replaces.
	const catalog = useRpc("searchCatalog");
	// The keyboard cursor over the result list; -1 means nothing highlighted.
	const [active, setActive] = useState(-1);
	const listId = useId();
	const query = value.trim();

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
	const pick = (id: string) => {
		onValue(id);
		setOpen(false);
		setActive(-1);
	};
	// The list is keyboard-operable from the input itself (a combobox, not a
	// pointer-only popup): arrows move the highlight, Enter picks it, Escape
	// closes without picking.
	const onKeyDown = (event: KeyboardEvent) => {
		if (!open || matches === undefined || matches.length === 0) {
			return;
		}
		if (event.key === "ArrowDown") {
			setActive((current) => (current + 1) % matches.length);
		} else if (event.key === "ArrowUp") {
			setActive((current) => (current <= 0 ? matches.length - 1 : current - 1));
		} else if (event.key === "Enter" && active >= 0) {
			const match = matches[active];
			if (match !== undefined) {
				pick(match.id);
			}
		} else if (event.key === "Escape") {
			setOpen(false);
			setActive(-1);
			// The result list consumes this Escape: inside a chip popover or a
			// slide-over it must close only the results, not the surface above.
			event.stopPropagation();
		} else {
			return;
		}
		event.preventDefault();
	};
	return (
		<span className="cell value catalog-picker">
			<Input
				type="text"
				className="value"
				role="combobox"
				aria-invalid={invalid}
				aria-expanded={open && matches !== undefined && matches.length > 0}
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
				onBlur={() => {
					setOpen(false);
					setActive(-1);
				}}
				onKeyDown={onKeyDown}
			/>
			<Help text={helpCatalogPicker()} />
			{open && matches !== undefined && matches.length > 0 ? (
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
							// mousedown, not click: the input's blur closes the list
							// before a click could land.
							onMouseDown={(event) => {
								event.preventDefault();
								pick(match.id);
							}}
						>
							<span className="catalog-id">{match.id}</span> <span className="hint">{match.name}</span>
						</button>
					))}
				</div>
			) : null}
		</span>
	);
}

/**
 * The model-capability group rows, ParamGroupsFields' typed sibling: one group, one row
 * per capability. The value control follows the key; purely presentational, over the
 * issues from the same parse that judges the enclosing form.
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
	/** Suggestions for the matcher input's listbox; absent, the input stays plain. */
	prefixSuggestions?: readonly string[] | undefined;
	/** The capability-name suggestions (capabilityKeySuggestions); absent, the no-evidence static list serves. */
	keySuggestions?: readonly string[] | undefined;
	onChange: (next: PrefixGroup) => void;
	/** Enter in a row input; the editors apply the draft when it parses clean. */
	onEnter?: (() => void) | undefined;
}) {
	const inert = disabled === true;
	// The suggestion inputs guard their own Enter (a highlighted suggestion is
	// accepted, never applied); this handler serves the plain value inputs.
	const onKeyDown =
		onEnter === undefined
			? undefined
			: (event: KeyboardEvent) => {
					if (event.key === "Enter") {
						onEnter();
					}
				};
	const patchGroup = (patch: Partial<PrefixGroup>) => {
		onChange({ ...group, ...patch });
	};
	const focusHold = useFocusedRow();
	// The group's `_fallback` marks, derived once per render from the
	// rows the checkboxes rewrite.
	const fallbackFields = directiveMarkedFields("caps", group, FALLBACK_DIRECTIVE);
	// The wrong-record-type rows' description ids, one namespace per editor.
	const wrongTypeIdBase = useId();
	// The control-backed directive rows the grid absorbs, with this editor's flag set. What
	// keeps a directive row visible is structural (directiveRowAbsorbed's eligible-row
	// check); the hint clause is only a backstop, so no row's visibility rides on a hint
	// that evidence could suppress.
	const rowAbsorbed = (index: number): boolean =>
		!focusHold.focused(group.params[index]?.id ?? "") &&
		directiveRowAbsorbed("caps", group, index, CAPABILITY_FLAG_DIRECTIVES) &&
		(resolvedFieldName("caps", group.params[index]?.key ?? "") === INHERIT_FROM_DIRECTIVE ||
			issues?.rows[index]?.hint === undefined);
	const inheritFromIndex = group.params.findIndex(
		(param) => resolvedFieldName("caps", param.key) === INHERIT_FROM_DIRECTIVE
	);
	// The grid's column heads label rendered rows; an empty group keeps
	// just the add action instead of heads over nothing.
	const anyRowVisible = group.params.some((_, index) => !rowAbsorbed(index));
	return (
		<div className="group">
			<div className="editor-section">
				<span className="editor-label">
					{l10n.t("Matcher")}
					<Help text={helpCapabilityPrefix()} />
				</span>
				<div className="matcher-line">
					<SuggestInput
						value={group.prefix}
						suggestions={prefixSuggestions ?? []}
						inputClass="key"
						invalid={issues?.prefix !== undefined}
						placeholder={l10n.t("Model ID or matcher, e.g. gpt-4 or gpt-4*")}
						ariaLabel={l10n.t("Matcher")}
						disabled={inert}
						onValue={(next) => patchGroup({ prefix: next })}
						onEnter={onEnter}
					/>
				</div>
				{/* The reserved status line, the parameters editor's rule (see
				    the twin above dashboard.css .matcher-status). */}
				<span className={cn("matcher-status", issues?.prefix !== undefined && "error")}>
					{issues?.prefix ?? (group.prefix.trim().length > 0 ? matcherKindLabel(matcherKind(group.prefix)) : null)}
				</span>
			</div>
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
					{anyRowVisible ? (
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
					) : null}
					{group.params.map((param, paramIndex) => {
						if (rowAbsorbed(paramIndex)) {
							return null;
						}
						const issue = issues?.rows[paramIndex];
						const key = resolvedFieldName("caps", param.key);
						const kind = capabilityControlKind(key, param.valueText);
						const numberProps = kind === "number" || kind === "cost" ? numberInputProps(kind) : undefined;
						const removeLabel = key.length > 0 ? l10n.t('Remove "{0}"', key) : l10n.t("Remove");
						// The wrong-record-type badge in the row's flag cell, its sentence
						// wired to the key input: the same fact the table's chips badge.
						const wrongType = wrongRecordTypeHint("caps", key);
						const wrongTypeId = wrongType === undefined ? undefined : `${wrongTypeIdBase}-${param.id}`;
						const patchRow = (patch: Partial<{ key: string; valueText: string }>) =>
							patchGroup({
								params: group.params.map((p, i) => (i === paramIndex ? { ...p, ...patch } : p)),
							});
						return (
							<div className="row" key={param.id} {...focusHold.rowFocusProps(param.id)}>
								{/* The stacked tier's per-cell labels, the parameters
								    editor's rule (dashboard.css .cell-label; words aria-hidden
								    there too - the inputs carry the same accessible names). */}
								<span className="cell-label">
									<span aria-hidden="true">{l10n.t("Capability")}</span>
									<Help text={helpCapabilityName()} />
								</span>
								<span className="cell key">
									<SuggestInput
										value={param.key}
										suggestions={keySuggestions ?? CAPABILITY_KEY_SUGGESTIONS}
										inputClass="key"
										invalid={issue?.problem?.field === "name"}
										placeholder={l10n.t("Capability, e.g. context_length")}
										ariaLabel={l10n.t("Capability")}
										describedBy={wrongTypeId}
										disabled={inert}
										onValue={(nextKey) => {
											// A row just switched onto a support flag means "turn it
											// on"; seeding true keeps the checkbox and the parse in
											// agreement without an extra click.
											const seedsTrue =
												capabilityValueKind(resolvedFieldName("caps", nextKey)) === "boolean" &&
												param.valueText.trim().length === 0;
											patchRow({ key: nextKey, ...(seedsTrue ? { valueText: "true" } : {}) });
										}}
										onEnter={onEnter}
									/>
								</span>
								<span className="cell-label">
									<span aria-hidden="true">{l10n.t("Value")}</span>
									<Help text={helpCapabilityValue()} />
								</span>
								{kind === "boolean" ? (
									<label className="cell value capability-flag">
										<Checkbox
											checked={param.valueText.trim() === "true"}
											disabled={inert}
											onChange={(event) => patchRow({ valueText: event.currentTarget.checked ? "true" : "false" })}
										/>
										{l10n.t("supported")}
									</label>
								) : kind === "catalog-id" ? (
									<CatalogPicker
										value={param.valueText}
										disabled={inert}
										invalid={issue?.problem?.field === "value"}
										onValue={(next) => patchRow({ valueText: next })}
									/>
								) : (
									<span className="cell value">
										<Input
											type={numberProps !== undefined ? "number" : "text"}
											min={numberProps?.min}
											step={numberProps?.step}
											className="value"
											aria-invalid={issue?.problem?.field === "value"}
											aria-label={l10n.t("Value")}
											placeholder={numberProps?.placeholder ?? l10n.t("JSON value")}
											value={param.valueText}
											disabled={inert}
											onChange={(event) => patchRow({ valueText: event.currentTarget.value })}
											onKeyDown={onKeyDown}
										/>
									</span>
								)}
								{/* The per-row fallback/inheritable marks in the shared flag column. The vocabulary is
								    open, so every non-directive field carries the fallback box - the resolver's
								    `_fallback` accepts any field the record sets. A sibling record type's directive
								    fills the cell with the "ignored" badge instead. */}
								{directiveEligible(FALLBACK_DIRECTIVE, key) ? (
									<span className="cell directive-flag">
										<label>
											<Checkbox
												aria-label={l10n.t('Fall back for "{0}"', key)}
												checked={fallbackFields.has(key)}
												disabled={inert}
												onChange={(event) =>
													onChange(
														toggleDirectiveField("caps", group, FALLBACK_DIRECTIVE, key, event.currentTarget.checked)
													)
												}
											/>
											{l10n.t({
												message: "fallback",
												comment: [
													"Checkbox label on a capability row; applies the value only where the server reports none.",
												],
											})}
										</label>
										<Help text={helpFallbackFlag()} />
										<InheritableFlag kind="caps" group={group} fieldKey={key} disabled={inert} onChange={onChange} />
									</span>
								) : wrongType !== undefined && wrongTypeId !== undefined ? (
									<WrongTypeFlagCell note={wrongType} id={wrongTypeId} />
								) : null}
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
								{/* The parameters editor's reserved status line, same idiom,
							    same worst-first pick between the row's problem and its
							    non-blocking hint. */}
								<span
									className={cn(
										"row-status",
										issue?.problem !== undefined ? "error" : issue?.hint !== undefined && "hint"
									)}
								>
									{issue?.problem?.message ?? issue?.hint}
								</span>
							</div>
						);
					})}
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
