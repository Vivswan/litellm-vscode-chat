/**
 * A record row's chips: the inherits summary, the chip-row layout and its field
 * addresses, and the field and add-field popovers a chip opens.
 */
import * as l10n from "@vscode/l10n";
import { cva } from "class-variance-authority";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FieldDirective, ParamRow, PrefixGroup } from "../../dashboard/recordDraft";
import {
	directiveEligible,
	directiveMarkedFields,
	directiveRowAbsorbed,
	inheritFromChoice,
	newParamRow,
	parseCapabilityGroups,
	parseGroups,
	resolvedFieldName,
	toggleDirectiveField,
} from "../../dashboard/recordDraft";
import {
	FALLBACK_DIRECTIVE,
	FORCE_DIRECTIVE,
	INHERIT_FROM_DIRECTIVE,
	INHERITABLE_DIRECTIVE,
} from "../../shared/config/recordResolution";
import { Help } from "./help";
import { helpFallbackFlag, helpForceFlag, helpForceFlagDisabled, helpInheritableFlag } from "./helpText";
import { IconAdd, IconTrash } from "./icons";
import { fallbackWord, flagDirectivesFor, forceWord, inheritableWord } from "./recordFlags";
import {
	CatalogPicker,
	capabilityControlKind,
	capabilityValueKind,
	InheritableFlag,
	numberInputProps,
	SuggestInput,
} from "./recordGroupFields";
import type { RecordEditorKind, RowIssueView } from "./recordIssues";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { cn } from "./ui/cn";
import { Input } from "./ui/input";
import { watchPopoverFlip } from "./ui/popoverFlip";

export function openFieldAddress(
	groups: readonly PrefixGroup[],
	popover: ChipPopoverTarget | undefined
): string | undefined {
	if (popover?.kind !== "field") {
		return undefined;
	}
	const groupIndex = groups.findIndex(
		(group, index) =>
			group.prefix === popover.groupKey &&
			groups.slice(0, index).filter((earlier) => earlier.prefix === popover.groupKey).length === popover.groupOrdinal
	);
	const group = groups[groupIndex];
	if (group === undefined) {
		return undefined;
	}
	let seen = 0;
	for (const [rowIndex, row] of group.params.entries()) {
		if (row.key === popover.fieldKey) {
			if (seen === popover.ordinal) {
				return `${groupIndex}:${rowIndex}`;
			}
			seen += 1;
		}
	}
	return undefined;
}

const INHERIT_CELL = "inherit-cell shrink-0 text-[11px] text-muted-foreground";

/**
 * A row's short reading of its `_inherit_from` state; nothing where the group takes the
 * default - the mark appears exactly where a choice was made.
 */
export function InheritsSummary({ kind, group }: { kind: RecordEditorKind; group: PrefixGroup }) {
	const choice = inheritFromChoice(kind, group);
	switch (choice.kind) {
		case "default":
			return null;
		case "all":
			return <span className={INHERIT_CELL}>{l10n.t("inherits everything")}</span>;
		case "none":
			return <span className={INHERIT_CELL}>{l10n.t("inherits nothing")}</span>;
		case "keys":
			return (
				<span className={INHERIT_CELL}>
					{l10n.t("inherits")} <code>{choice.keysText}</code>
				</span>
			);
		case "unreadable":
			return <span className={INHERIT_CELL}>{l10n.t("inherits custom")}</span>;
	}
}

/** The force mark's word, shared by the row checkboxes and the chip badges so translations stay single-sourced. */

/**
 * The row indices a group renders as chips: everything except directive rows the table's
 * own surfaces fully represent (directiveRowAbsorbed; a directive the controls cannot
 * fully show keeps a raw chip). A row the open popover edits stays pinned, so absorption
 * can never unmount the popover mid-keystroke. Omission hides no problem: absorbed
 * implies valid, so every problem row has a chip to carry its mark.
 */
export function chipRowIndices(
	kind: RecordEditorKind,
	group: PrefixGroup,
	issueRows: readonly RowIssueView[],
	pinnedKey: string | undefined
): number[] {
	return group.params
		.map((_, index) => index)
		.filter((index) => {
			const key = resolvedFieldName(kind, group.params[index]?.key ?? "");
			// The pin compares RAW, like the popover identity it serves.
			if (pinnedKey !== undefined && group.params[index]?.key === pinnedKey) {
				return true;
			}
			const absorbed =
				directiveRowAbsorbed(kind, group, index, flagDirectivesFor(kind)) &&
				(key === INHERIT_FROM_DIRECTIVE || issueRows[index]?.hint === undefined);
			return !absorbed;
		});
}

/**
 * A never-persisted simulation row (the add popover's candidate, the parse
 * probes): the fixed id is safe because probe rows are appended to a COPY of
 * the group for one computation and never rendered or stored.
 */
function probeRow(key: string, valueText: string): ParamRow {
	return { id: "probe", key, valueText };
}

/**
 * The add popover's live verdict on its candidate row: append it to the
 * group and read the same parse that will judge it after the commit, so the
 * popover can never accept a row the editor then flags as blocking.
 */
function candidateProblem(
	kind: RecordEditorKind,
	groups: readonly PrefixGroup[],
	groupIndex: number,
	row: { readonly key: string; readonly valueText: string }
): string | undefined {
	const withRow = groups.map((group, index) =>
		index === groupIndex ? { ...group, params: [...group.params, probeRow(row.key, row.valueText)] } : group
	);
	if (kind === "params") {
		const parse = parseGroups(withRow);
		return parse.ok ? undefined : parse.problems[groupIndex]?.params.at(-1)?.message;
	}
	const parse = parseCapabilityGroups(withRow);
	return parse.issues[groupIndex]?.rows.at(-1)?.problem?.message;
}

/** The offset `.chip-popover` leaves between itself and its anchor, on whichever side it hangs from (dashboard.css). */

const POPOVER_GAP_PX = 4;

/**
 * The field chip's states as one variant table (ui/button.tsx's idiom), so the
 * precedence between them is declaration order rather than call-site prose:
 * cn resolves conflicts last-wins, and `mark` is declared after `open` because
 * reversed, the open chip's border-border swallowed the invalid border. No
 * forced-colors border suppression, deliberately: a FILLED chip's fill is
 * exactly what forced colours flatten into the page, so the repainted
 * transparent border is the only thing keeping "two chips" from reading as one
 * run of words.
 */
export const chipVariants = cva(
	"chip-field inline-flex flex-wrap items-baseline gap-1.5 rounded-(--radius-chip) border border-transparent bg-chip px-1 font-mono text-[12px] text-muted-foreground",
	{
		variants: {
			// Filled at rest - the frame makes these a bounded region and the fill
			// is what says "these are the fields"; the hairline and the input fill
			// still arrive with the pointer or with focus, which is the moment the
			// row has to prove it is editable.
			editable: {
				true: [
					"cursor-pointer group-hover/row:border-border group-hover/row:bg-input-background",
					"group-focus-within/row:border-border group-focus-within/row:bg-input-background",
					"hover:text-foreground focus-visible:outline-(length:--ring-w)",
					"focus-visible:outline-offset-(--ring-offset) focus-visible:outline-ring focus-visible:outline-solid",
				],
				false: "",
			},
			catalog: {
				true: "chip-catalog",
				false: "",
			},
			open: {
				true: "border-border bg-input-background text-foreground",
				false: "",
			},
			// One mark at a time, worst first (a row may carry a problem AND a
			// hint; the problem wins this variant's shape). The mark restates the row's
			// hover/focus-within reveal variants - separate merge groups the plain
			// utility cannot beat, which repainted the mark grey when the pointer
			// arrived. The border IS the whole mark - the child spans re-colour
			// every glyph, so no text tint would paint. Invalid takes the fill
			// tier, not --input-invalid: a 1px hairline is a graphical mark needing
			// 3:1, and the host's validation border measures 1.33:1 on the dark
			// chip fill.
			mark: {
				none: "",
				hint: "hinted border-warn group-hover/row:border-warn group-focus-within/row:border-warn",
				invalid: "invalid border-err-fill group-hover/row:border-err-fill group-focus-within/row:border-err-fill",
			},
		},
	}
);

/**
 * The chip popovers' shared shell: anchored under its chip, focus moved in on open and
 * returned on close, Escape and outside presses closing. Escape stops propagating so a
 * popover inside an overlay closes only itself; it flips above rather than hang past
 * the viewport's bottom edge.
 */
function PopoverShell({
	label,
	align,
	onClose,
	children,
}: {
	label: string;
	/** Which chip edge the popover hangs from; "end" keeps it on-panel for chips near the right edge. */
	align: "start" | "end";
	onClose: () => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	// Flip decided by measurement (ui/popoverFlip.ts), not at click time: the height is
	// unknown until render, and both it and the room under it change while open - a
	// popover that opened on-screen can end up over the edge.
	const [above, setAbove] = useState(false);
	useLayoutEffect(() => {
		const popover = ref.current;
		if (popover === null) {
			return;
		}
		return watchPopoverFlip(popover, POPOVER_GAP_PX, setAbove);
	}, []);
	useEffect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		// Captured now for the close path: Remove field deletes the opening
		// chip, and focus must land on a neighbor (the row's [+] chip) instead
		// of falling back to the document.
		const chipList = opener?.closest(".chip-list") ?? undefined;
		const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button");
		first?.focus();
		const onPress = (event: MouseEvent) => {
			// Containment is checked against the chip anchor (the popover's
			// parent), not the popover alone: a press on the open chip itself is
			// the chip's own toggle, and closing here first would reopen it.
			const anchor = ref.current?.parentElement;
			if (anchor !== null && anchor !== undefined && event.target instanceof Node && !anchor.contains(event.target)) {
				closeRef.current();
			}
		};
		document.addEventListener("mousedown", onPress);
		return () => {
			document.removeEventListener("mousedown", onPress);
			// Deferred past the commit that unmounted the popover: Remove field
			// deletes the opening chip in the SAME commit, and a synchronous
			// restore would land on it a beat before its removal drops focus to
			// the body.
			setTimeout(() => {
				// Something else already owns focus (say, the popover a click on
				// ANOTHER chip opened): restoring now would steal it. Only a
				// focus that fell to the body - the closed popover's input going
				// away - is ours to restore.
				const active = document.activeElement;
				if (active instanceof HTMLElement && active !== document.body && active.isConnected) {
					return;
				}
				if (opener?.isConnected === true) {
					opener.focus();
					return;
				}
				const fallback =
					chipList?.querySelector<HTMLElement>("button.chip-add") ?? chipList?.querySelector<HTMLElement>("button");
				fallback?.focus();
			}, 0);
		};
	}, []);
	return (
		<div
			className={cn("chip-popover", align === "end" && "align-end", above && "align-above")}
			role="dialog"
			aria-label={label}
			ref={ref}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					onClose();
				}
			}}
		>
			{children}
		</div>
	);
}

/**
 * The small anchored editor behind a field chip; edits write straight into the draft
 * (the owner's Apply/Save remains the only write path). Addressed by the row's KEY, so
 * a flag toggle that inserts or removes a directive row can never shift it onto
 * another field.
 */
export function FieldChipPopover({
	kind,
	groups,
	groupIndex,
	rowIndex,
	issue,
	disabled,
	align,
	onChange,
	onClose,
}: {
	kind: RecordEditorKind;
	groups: readonly PrefixGroup[];
	groupIndex: number;
	rowIndex: number;
	issue: RowIssueView | undefined;
	disabled: boolean;
	align: "start" | "end";
	onChange: (next: PrefixGroup[]) => void;
	onClose: () => void;
}) {
	const group = groups[groupIndex];
	const row = group?.params[rowIndex];
	// The status slot's id, so the value input can point at the verdict
	// (aria-describedby): the slot renders after the actions for layout, and
	// the association keeps DOM order irrelevant to assistive tech.
	const statusId = useId();
	if (group === undefined || row === undefined) {
		return null;
	}
	// The key in the resolver's reading: trimmed for capability records,
	// verbatim for parameters records (a padded key is its own live field).
	const key = resolvedFieldName(kind, row.key);
	const patchValue = (valueText: string) =>
		onChange(
			groups.map((g, i) =>
				i === groupIndex ? { ...g, params: g.params.map((p, r) => (r === rowIndex ? { ...p, valueText } : p)) } : g
			)
		);
	const removeRow = () => {
		onChange(
			groups.map((g, i) => (i === groupIndex ? { ...g, params: g.params.filter((_, r) => r !== rowIndex) } : g))
		);
		onClose();
	};
	const valueKind = kind === "caps" ? capabilityControlKind(key, row.valueText) : "json";
	const numberProps = valueKind === "number" || valueKind === "cost" ? numberInputProps(valueKind) : undefined;
	const valueInvalid = issue?.problem?.field === "value";
	// Enter closes the popover once the value is typed - the draft already
	// holds every keystroke, so there is nothing else to commit here.
	const onValueKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter") {
			onClose();
		}
	};
	const forcedFields = directiveMarkedFields(kind, group, FORCE_DIRECTIVE);
	const fallbackFields = directiveMarkedFields(kind, group, FALLBACK_DIRECTIVE);
	return (
		<PopoverShell label={l10n.t('Edit field "{0}"', key)} align={align} onClose={onClose}>
			<span className="popover-label">{l10n.t("Value")}</span>
			{valueKind === "boolean" ? (
				<label className="capability-flag">
					<Checkbox
						checked={row.valueText.trim() === "true"}
						disabled={disabled}
						onChange={(event) => patchValue(event.currentTarget.checked ? "true" : "false")}
					/>
					{l10n.t("supported")}
				</label>
			) : valueKind === "catalog-id" ? (
				<CatalogPicker value={row.valueText} disabled={disabled} invalid={valueInvalid} onValue={patchValue} />
			) : (
				<Input
					type={numberProps !== undefined ? "number" : "text"}
					min={numberProps?.min}
					step={numberProps?.step}
					className="value"
					aria-invalid={valueInvalid}
					aria-describedby={issue?.problem !== undefined || issue?.hint !== undefined ? statusId : undefined}
					aria-label={l10n.t('Value for "{0}"', key)}
					placeholder={numberProps?.placeholder ?? l10n.t("JSON value, e.g. 0.2")}
					value={row.valueText}
					disabled={disabled}
					onChange={(event) => patchValue(event.currentTarget.value)}
					onKeyDown={onValueKeyDown}
				/>
			)}
			{key.length > 0 && !key.startsWith("_") ? (
				<div className="chip-popover-flags">
					{kind === "params" ? (
						<>
							<label>
								<Checkbox
									aria-label={l10n.t('Force "{0}"', key)}
									checked={forcedFields.has(key)}
									disabled={disabled || !directiveEligible(FORCE_DIRECTIVE, key)}
									onChange={(event) =>
										onChange(
											groups.map((g, i) =>
												i === groupIndex
													? toggleDirectiveField(kind, g, FORCE_DIRECTIVE, key, event.currentTarget.checked)
													: g
											)
										)
									}
								/>
								{forceWord()}
							</label>
							<Help text={directiveEligible(FORCE_DIRECTIVE, key) ? helpForceFlag() : helpForceFlagDisabled()} />
						</>
					) : null}
					{/* Any non-directive key takes the fallback mark: the vocabulary is
					    open and the resolver's `_fallback` accepts any set field. */}
					{kind === "caps" && directiveEligible(FALLBACK_DIRECTIVE, key) ? (
						<>
							<label>
								<Checkbox
									aria-label={l10n.t('Fall back for "{0}"', key)}
									checked={fallbackFields.has(key)}
									disabled={disabled}
									onChange={(event) =>
										onChange(
											groups.map((g, i) =>
												i === groupIndex
													? toggleDirectiveField(kind, g, FALLBACK_DIRECTIVE, key, event.currentTarget.checked)
													: g
											)
										)
									}
								/>
								{fallbackWord()}
							</label>
							<Help text={helpFallbackFlag()} />
						</>
					) : null}
					<InheritableFlag
						kind={kind}
						group={group}
						fieldKey={key}
						disabled={disabled}
						onChange={(next) => onChange(groups.map((g, i) => (i === groupIndex ? next : g)))}
					/>
				</div>
			) : null}
			{/* The one status line, in reserved space AFTER the actions: the verdict re-renders per
			    keystroke and must not move Remove field under the pointer (the charter's transients
			    clause). Worst first, one message at a time (chip-popover-status is one line). */}
			<div className="chip-popover-actions">
				<Button variant="danger" size="compact" disabled={disabled} onClick={removeRow}>
					<IconTrash /> {l10n.t("Remove field")}
				</Button>
			</div>
			<div className="chip-popover-status" id={statusId}>
				{issue?.problem !== undefined ? (
					<p className="error">{issue.problem.message}</p>
				) : issue?.hint !== undefined ? (
					<p className="hint">{issue.hint}</p>
				) : null}
			</div>
		</PopoverShell>
	);
}

/**
 * The [+] chip's popover: a complete field assembled locally and landed as ONE commit,
 * so half-typed rows never leak into the table. The target parser runs over the
 * candidate per keystroke - the popover cannot accept what the editor would block.
 */
export function AddFieldPopover({
	kind,
	groups,
	groupIndex,
	disabled,
	keySuggestions,
	align,
	onChange,
	onClose,
}: {
	kind: RecordEditorKind;
	groups: readonly PrefixGroup[];
	groupIndex: number;
	disabled: boolean;
	keySuggestions: readonly string[];
	align: "start" | "end";
	onChange: (next: PrefixGroup[]) => void;
	onClose: () => void;
}) {
	const [key, setKey] = useState("");
	const [valueText, setValueText] = useState("");
	// The user's explicit flag choices only; unset means "whatever the group's
	// directive rows already say about this key" (a literal `_force: true`
	// covers the new field the moment it lands, and the box must show that).
	const [flagOverrides, setFlagOverrides] = useState<Partial<Record<FieldDirective, boolean>>>({});
	// The status slot's id, the edit popover's aria-describedby rule.
	const statusId = useId();
	const group = groups[groupIndex];
	if (group === undefined) {
		return null;
	}
	// ONE reading of the typed key - the resolver's - shared by the validation
	// probe, the flag simulation, and the commit, so the popover can never
	// judge one row and land another: for a parameters record the key commits
	// verbatim (a padded " _fallback" stays the live field the probe judged).
	const name = resolvedFieldName(kind, key);
	const problem =
		key.trim().length === 0 ? undefined : candidateProblem(kind, groups, groupIndex, { key: name, valueText });
	const canAdd = key.trim().length > 0 && problem === undefined;
	const valueKind = kind === "caps" ? capabilityControlKind(name, valueText) : "json";
	const numberProps = valueKind === "number" || valueKind === "cost" ? numberInputProps(valueKind) : undefined;
	const setKeyAndSeed = (nextKey: string) => {
		setKey(nextKey);
		// A key switched onto a support flag means "turn it on" (the row grid's
		// seeding rule, so the checkbox and the parse agree without a click).
		if (
			kind === "caps" &&
			capabilityValueKind(resolvedFieldName(kind, nextKey)) === "boolean" &&
			valueText.trim().length === 0
		) {
			setValueText("true");
		}
	};
	// What the group's directive rows would already mark on the candidate once
	// its row lands (simulated with a probe row appended, so a literal true's
	// expansion sees the new key; the commit mints the real row).
	const withCandidate: PrefixGroup = { ...group, params: [...group.params, probeRow(name, valueText)] };
	const impliedFlag = (flag: FieldDirective): boolean => directiveMarkedFields(kind, withCandidate, flag).has(name);
	const flagChecked = (flag: FieldDirective): boolean => flagOverrides[flag] ?? impliedFlag(flag);
	const toggleLocalFlag = (flag: FieldDirective, enabled: boolean) =>
		setFlagOverrides((current) => ({ ...current, [flag]: enabled }));
	const commit = () => {
		if (!canAdd) {
			return;
		}
		let next: PrefixGroup = { ...group, params: [...group.params, newParamRow(name, valueText)] };
		// Only explicit choices touch the directive rows, and only when they
		// change what the rows already say: an untouched box over a literal
		// `true` must never explode it into a list.
		for (const flag of [FORCE_DIRECTIVE, FALLBACK_DIRECTIVE, INHERITABLE_DIRECTIVE] as const) {
			const desired = flagOverrides[flag];
			if (desired === undefined || !directiveEligible(flag, name)) {
				continue;
			}
			if (directiveMarkedFields(kind, next, flag).has(name) !== desired) {
				next = toggleDirectiveField(kind, next, flag, name, desired);
			}
		}
		onChange(groups.map((g, i) => (i === groupIndex ? next : g)));
		onClose();
	};
	return (
		<PopoverShell label={l10n.t("Add field")} align={align} onClose={onClose}>
			<span className="popover-label">{kind === "params" ? l10n.t("Parameter") : l10n.t("Capability")}</span>
			<SuggestInput
				value={key}
				suggestions={keySuggestions}
				inputClass="key"
				invalid={false}
				placeholder={
					kind === "params" ? l10n.t("Parameter, e.g. temperature") : l10n.t("Capability, e.g. context_length")
				}
				ariaLabel={kind === "params" ? l10n.t("Parameter") : l10n.t("Capability")}
				disabled={disabled}
				onValue={setKeyAndSeed}
				onEnter={commit}
			/>
			<span className="popover-label">{l10n.t("Value")}</span>
			{valueKind === "boolean" ? (
				<label className="capability-flag">
					<Checkbox
						checked={valueText.trim() === "true"}
						disabled={disabled}
						onChange={(event) => setValueText(event.currentTarget.checked ? "true" : "false")}
					/>
					{l10n.t("supported")}
				</label>
			) : valueKind === "catalog-id" ? (
				<CatalogPicker value={valueText} disabled={disabled} invalid={false} onValue={setValueText} />
			) : (
				<Input
					type={numberProps !== undefined ? "number" : "text"}
					min={numberProps?.min}
					step={numberProps?.step}
					className="value"
					aria-describedby={problem !== undefined ? statusId : undefined}
					aria-label={l10n.t("New field value")}
					placeholder={numberProps?.placeholder ?? l10n.t("JSON value, e.g. 0.2")}
					value={valueText}
					disabled={disabled}
					onChange={(event) => setValueText(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							commit();
						}
					}}
				/>
			)}
			{key.trim().length > 0 && !name.startsWith("_") ? (
				<div className="chip-popover-flags">
					{kind === "params" ? (
						<>
							<label>
								<Checkbox
									aria-label={l10n.t('Force "{0}"', name)}
									checked={flagChecked(FORCE_DIRECTIVE)}
									disabled={disabled || !directiveEligible(FORCE_DIRECTIVE, name)}
									onChange={(event) => toggleLocalFlag(FORCE_DIRECTIVE, event.currentTarget.checked)}
								/>
								{forceWord()}
							</label>
							<Help text={directiveEligible(FORCE_DIRECTIVE, name) ? helpForceFlag() : helpForceFlagDisabled()} />
						</>
					) : null}
					{/* Same open-vocabulary rule as the edit popover's fallback mark. */}
					{kind === "caps" && directiveEligible(FALLBACK_DIRECTIVE, name) ? (
						<>
							<label>
								<Checkbox
									aria-label={l10n.t('Fall back for "{0}"', name)}
									checked={flagChecked(FALLBACK_DIRECTIVE)}
									disabled={disabled}
									onChange={(event) => toggleLocalFlag(FALLBACK_DIRECTIVE, event.currentTarget.checked)}
								/>
								{fallbackWord()}
							</label>
							<Help text={helpFallbackFlag()} />
						</>
					) : null}
					<label>
						<Checkbox
							aria-label={l10n.t('Mark "{0}" inheritable', name)}
							checked={flagChecked(INHERITABLE_DIRECTIVE)}
							disabled={disabled}
							onChange={(event) => toggleLocalFlag(INHERITABLE_DIRECTIVE, event.currentTarget.checked)}
						/>
						{inheritableWord()}
					</label>
					<Help text={helpInheritableFlag()} />
				</div>
			) : null}
			{/* The edit popover's reserved status line, in the same after-the-actions
			    slot: the candidate verdict also re-renders per keystroke, and Add
			    field must not walk away from the pointer while the row is typed. */}
			<div className="chip-popover-actions">
				<Button disabled={disabled || !canAdd} onClick={commit}>
					<IconAdd /> {l10n.t("Add field")}
				</Button>
			</div>
			<div className="chip-popover-status" id={statusId}>
				{problem !== undefined ? <p className="error">{problem}</p> : null}
			</div>
		</PopoverShell>
	);
}

/**
 * The open chip popover, addressed by the group's MATCHER KEY and the row's FIELD KEY,
 * never by index - a push or flag toggle may reorder the arrays under it. Keys compare
 * RAW (the resolver's grammar trims nothing, and trimmed identity would transfer
 * between "gpt-4" and "gpt-4 "); ordinals disambiguate exact duplicates.
 */
export type ChipPopoverTarget =
	| {
			readonly kind: "field";
			readonly groupKey: string;
			readonly groupOrdinal: number;
			readonly fieldKey: string;
			readonly ordinal: number;
			readonly align: "start" | "end";
	  }
	| {
			readonly kind: "add";
			readonly groupKey: string;
			readonly groupOrdinal: number;
			readonly align: "start" | "end";
	  };

/** Which chip edge a popover hangs from: chips in the viewport's right half open leftwards to stay on-panel. */

export function popoverAlign(target: EventTarget | null): "start" | "end" {
	if (!(target instanceof HTMLElement)) {
		return "start";
	}
	const rect = target.getBoundingClientRect();
	return rect.left > window.innerWidth / 2 ? "end" : "start";
}
