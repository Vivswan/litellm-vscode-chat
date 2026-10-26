import * as l10n from "@vscode/l10n";
import { cva } from "class-variance-authority";
import type { ReactNode } from "react";
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
import { trimHttpWhitespace } from "../../shared/util/headers";
import { Help } from "./help";
import { helpFallbackFlag, helpForceFlag, helpForceFlagDisabled, helpInheritableFlag } from "./helpText";
import { IconAdd, IconTrash } from "./icons";
import { fallbackWord, flagDirectivesFor, forceWord, inheritableWord } from "./recordFlags";
import {
	CapabilityControl,
	capabilityControlKind,
	capabilityValueKind,
	InheritableFlag,
	SuggestInput,
} from "./recordGroupFields";
import type { RecordEditorKind, RowIssueView } from "./recordIssues";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { cn } from "./ui/cn";
import { watchPopoverFlip } from "./ui/popoverFlip";

/** The open field popover's row as "groupIndex:rowIndex"; chip identity is the raw key plus its duplicate ordinal. */
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
 * A row's short reading of its `_inherit_from` state; nothing where the group takes the default - the mark appears
 * exactly where a choice was made.
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

/**
 * A row the open popover edits stays pinned, so absorption can never unmount the popover mid-keystroke. Omission hides
 * no problem: absorbed implies valid, so every problem row has a chip to carry its mark.
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
 * A never-persisted simulation row (the add popover's candidate, the parse probes): the fixed id is safe because probe
 * rows are appended to a COPY of the group for one computation and never rendered or stored.
 */
function probeRow(key: string, valueText: string): ParamRow {
	return { id: "probe", key, valueText };
}

/**
 * The add popover's live verdict on its candidate row: append it to the group and read the same parse that will judge
 * it after the commit, so the popover can never accept a row the editor then flags as blocking.
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

/** The field chip's states as one variant table (ui/button.tsx's idiom): precedence is declaration order, last wins. */
export const chipVariants = cva(
	"chip-field inline-flex flex-wrap items-baseline gap-1.5 rounded-(--radius-chip) border border-transparent bg-chip px-1 font-mono text-[12px] text-muted-foreground",
	{
		// `mark` is declared after `open` because reversed, the open chip's border-border swallowed the invalid border.
		// No forced-colors border suppression, deliberately: a FILLED chip's fill is exactly what forced colours flatten
		// into the page, so the repainted transparent border is the only thing keeping "two chips" from reading as one
		// run of words.
		variants: {
			// Filled at rest - the frame makes these a bounded region and the fill is what says "these are the fields";
			// the hairline and the input fill still arrive with the pointer or with focus, which is the moment the row
			// has to prove it is editable.
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
			// The mark restates the row's hover/focus-within reveal variants - separate merge groups the plain utility
			// cannot beat, which repainted the mark grey when the pointer arrived. Invalid takes the fill tier, not
			// --input-invalid: a 1px hairline is a graphical mark needing 3:1, and the host's validation border
			// measures 1.33:1 on the dark chip fill.
			//
			//   the child spans re-colour every glyph, so no text tint would paint -> The border IS the whole mark
			mark: {
				none: "",
				hint: "hinted border-warn group-hover/row:border-warn group-focus-within/row:border-warn",
				invalid: "invalid border-err-fill group-hover/row:border-err-fill group-focus-within/row:border-err-fill",
			},
		},
	}
);

/**
 *   Escape stops propagating -> a popover inside an overlay closes only itself
 */
function PopoverShell({
	label,
	align,
	onClose,
	children,
}: {
	/** The dialog's accessible name (role="dialog" with aria-label); the popover renders no heading of its own. */
	label: string;

	/** Which chip edge the popover hangs from; "end" keeps it on-panel for chips near the right edge. */
	align: "start" | "end";

	/** Posted by Escape and by a press outside the chip anchor; a press on the open chip itself is its toggle, not a close. */
	onClose: () => void;

	/** The popover's body; its first input, select, textarea, or button takes focus on open. */
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	// Flip decided by measurement (ui/popoverFlip.ts), not at click time: the height is unknown until render, and both
	// it and the room under it change while open - a popover that opened on-screen can end up over the edge.
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
		// Captured now for the close path: Remove field deletes the opening chip, and focus must land on a neighbor
		// (the row's [+] chip) instead of falling back to the document.
		const chipList = opener?.closest(".chip-list") ?? undefined;
		const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button");
		first?.focus();
		const onPress = (event: MouseEvent) => {
			// Containment is checked against the chip anchor (the popover's parent), not the popover alone: a press on
			// the open chip itself is the chip's own toggle, and closing here first would reopen it.
			const anchor = ref.current?.parentElement;
			if (anchor !== null && anchor !== undefined && event.target instanceof Node && !anchor.contains(event.target)) {
				closeRef.current();
			}
		};
		document.addEventListener("mousedown", onPress);
		return () => {
			document.removeEventListener("mousedown", onPress);
			// Deferred past the commit that unmounted the popover: Remove field deletes the opening chip in the SAME
			// commit, and a synchronous restore would land on it a beat before its removal drops focus to the body.
			setTimeout(() => {
				// Something else already owns focus (say, the popover a click on ANOTHER chip opened): restoring now
				// would steal it.
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

interface ValueControlProps {
	readonly valueKind: ReturnType<typeof capabilityControlKind>;
	readonly valueText: string;
	readonly disabled: boolean;
	readonly ariaInvalid: boolean | undefined;
	readonly describedBy: string | undefined;
	readonly ariaLabel: string;
	readonly onValue: (next: string) => void;
	readonly onEnter: () => void;
}

interface FlagCheckboxProps {
	readonly ariaLabel: string;
	readonly word: string;
	readonly checked: boolean;
	readonly disabled: boolean;
	readonly help: string;
	readonly onChange: (checked: boolean) => void;
}

interface FieldFlagsProps {
	readonly kind: RecordEditorKind;
	readonly groups: readonly PrefixGroup[];
	readonly groupIndex: number;
	readonly group: PrefixGroup;
	readonly fieldKey: string;
	readonly disabled: boolean;
	readonly onChange: (next: PrefixGroup[]) => void;
}

interface CandidateFlagsProps {
	readonly kind: RecordEditorKind;
	readonly name: string;
	readonly keyTyped: boolean;
	readonly disabled: boolean;
	readonly flagChecked: (flag: FieldDirective) => boolean;
	readonly onToggle: (flag: FieldDirective, enabled: boolean) => void;
}

/** The add popover's local state and the group it lands in, as candidateField reads them. */
interface CandidateInput {
	readonly kind: RecordEditorKind;
	readonly groups: readonly PrefixGroup[];
	readonly groupIndex: number;
	readonly group: PrefixGroup;
	readonly key: string;
	readonly valueText: string;
	readonly flagOverrides: Partial<Record<FieldDirective, boolean>>;
	readonly setKey: (next: string) => void;
	readonly setValueText: (next: string) => void;
	readonly setFlagOverrides: (
		update: (current: Partial<Record<FieldDirective, boolean>>) => Partial<Record<FieldDirective, boolean>>
	) => void;
	readonly onChange: (next: PrefixGroup[]) => void;
	readonly onClose: () => void;
}

/** The candidate field's one reading: its resolved name, its verdict, and the moves that type, flag, and commit it. */
interface Candidate {
	readonly name: string;
	readonly problem: string | undefined;
	readonly canAdd: boolean;
	readonly valueKind: ReturnType<typeof capabilityControlKind>;
	readonly setKeyAndSeed: (nextKey: string) => void;
	readonly flagChecked: (flag: FieldDirective) => boolean;
	readonly toggleFlag: (flag: FieldDirective, enabled: boolean) => void;
	readonly commit: () => void;
}

interface IssueStatusProps {
	readonly id: string;
	readonly issue: RowIssueView | undefined;
}

/**
 * The popover's value control: the shared capability control with the popover's label and placeholder, and Enter
 * running `onEnter`, since the draft already holds every keystroke.
 */
function ValueControl(props: ValueControlProps) {
	const { valueKind, valueText, disabled, ariaInvalid, describedBy, ariaLabel, onValue, onEnter } = props;
	return (
		<CapabilityControl
			kind={valueKind}
			valueText={valueText}
			disabled={disabled}
			invalid={ariaInvalid}
			flagClassName="capability-flag"
			input={{
				ariaLabel,
				describedBy,
				placeholder: l10n.t("JSON value, e.g. 0.2"),
				onKeyDown: (event) => {
					if (event.key === "Enter") {
						onEnter();
					}
				},
			}}
			onValue={onValue}
		/>
	);
}

/** One directive flag: its checkbox with the chip word as the label, and the help glyph beside it. */
function FlagCheckbox({ ariaLabel, word, checked, disabled, help, onChange }: FlagCheckboxProps) {
	return (
		<>
			<label>
				<Checkbox
					aria-label={ariaLabel}
					checked={checked}
					disabled={disabled}
					onChange={(event) => onChange(event.currentTarget.checked)}
				/>
				{word}
			</label>
			<Help text={help} />
		</>
	);
}

/**
 * The edit popover's flag row for a live field; a directive key has none. Any non-directive key takes the fallback
 * mark: the vocabulary is open and the resolver's `_fallback` accepts any set field.
 */
function FieldFlags({ kind, groups, groupIndex, group, fieldKey, disabled, onChange }: FieldFlagsProps) {
	if (fieldKey.length === 0 || fieldKey.startsWith("_")) {
		return null;
	}
	const forcedFields = directiveMarkedFields(kind, group, FORCE_DIRECTIVE);
	const fallbackFields = directiveMarkedFields(kind, group, FALLBACK_DIRECTIVE);
	const toggle = (flag: FieldDirective, enabled: boolean) =>
		onChange(groups.map((g, i) => (i === groupIndex ? toggleDirectiveField(kind, g, flag, fieldKey, enabled) : g)));
	return (
		<div className="chip-popover-flags">
			{kind === "params" ? (
				<FlagCheckbox
					ariaLabel={l10n.t('Force "{0}"', fieldKey)}
					word={forceWord()}
					checked={forcedFields.has(fieldKey)}
					disabled={disabled || !directiveEligible(FORCE_DIRECTIVE, fieldKey)}
					help={directiveEligible(FORCE_DIRECTIVE, fieldKey) ? helpForceFlag() : helpForceFlagDisabled()}
					onChange={(enabled) => toggle(FORCE_DIRECTIVE, enabled)}
				/>
			) : null}
			{kind === "caps" && directiveEligible(FALLBACK_DIRECTIVE, fieldKey) ? (
				<FlagCheckbox
					ariaLabel={l10n.t('Fall back for "{0}"', fieldKey)}
					word={fallbackWord()}
					checked={fallbackFields.has(fieldKey)}
					disabled={disabled}
					help={helpFallbackFlag()}
					onChange={(enabled) => toggle(FALLBACK_DIRECTIVE, enabled)}
				/>
			) : null}
			<InheritableFlag
				kind={kind}
				group={group}
				fieldKey={fieldKey}
				disabled={disabled}
				onChange={(next) => onChange(groups.map((g, i) => (i === groupIndex ? next : g)))}
			/>
		</div>
	);
}

/** The add popover's flag row for the typed candidate; the fallback mark follows the edit popover's open-vocabulary rule. */
function CandidateFlags({ kind, name, keyTyped, disabled, flagChecked, onToggle }: CandidateFlagsProps) {
	if (!keyTyped || name.startsWith("_")) {
		return null;
	}
	return (
		<div className="chip-popover-flags">
			{kind === "params" ? (
				<FlagCheckbox
					ariaLabel={l10n.t('Force "{0}"', name)}
					word={forceWord()}
					checked={flagChecked(FORCE_DIRECTIVE)}
					disabled={disabled || !directiveEligible(FORCE_DIRECTIVE, name)}
					help={directiveEligible(FORCE_DIRECTIVE, name) ? helpForceFlag() : helpForceFlagDisabled()}
					onChange={(enabled) => onToggle(FORCE_DIRECTIVE, enabled)}
				/>
			) : null}
			{kind === "caps" && directiveEligible(FALLBACK_DIRECTIVE, name) ? (
				<FlagCheckbox
					ariaLabel={l10n.t('Fall back for "{0}"', name)}
					word={fallbackWord()}
					checked={flagChecked(FALLBACK_DIRECTIVE)}
					disabled={disabled}
					help={helpFallbackFlag()}
					onChange={(enabled) => onToggle(FALLBACK_DIRECTIVE, enabled)}
				/>
			) : null}
			<FlagCheckbox
				ariaLabel={l10n.t('Mark "{0}" inheritable', name)}
				word={inheritableWord()}
				checked={flagChecked(INHERITABLE_DIRECTIVE)}
				disabled={disabled}
				help={helpInheritableFlag()}
				onChange={(enabled) => onToggle(INHERITABLE_DIRECTIVE, enabled)}
			/>
		</div>
	);
}

/**
 * The one status line, in reserved space AFTER the actions: the verdict re-renders per keystroke and must not move
 * Remove field under the pointer (the charter's transients clause). Worst first, one message at a time
 * (chip-popover-status is one line).
 */
function IssueStatus({ id, issue }: IssueStatusProps) {
	let line: ReactNode = null;
	if (issue?.problem !== undefined) {
		line = <p className="error">{issue.problem.message}</p>;
	} else if (issue?.hint !== undefined) {
		line = <p className="hint">{issue.hint}</p>;
	}
	return (
		<div className="chip-popover-status" id={id}>
			{line}
		</div>
	);
}

/**
 * ONE reading of the typed key - the resolver's - shared by the validation probe, the flag simulation, and the commit,
 * so the popover can never judge one row and land another: for a parameters record the key commits verbatim (a padded
 * " _fallback" stays the live field the probe judged).
 *
 * The group's directive rows are simulated with a probe row appended, so a literal true's expansion sees the new key;
 * the commit mints the real row.
 *
 * Only explicit flag choices touch the directive rows, and only when they change what the rows already say: an
 * untouched box over a literal `true` must never explode it into a list.
 */
function candidateField(input: CandidateInput): Candidate {
	const { kind, groups, groupIndex, group, key, valueText, flagOverrides } = input;
	const name = resolvedFieldName(kind, key);
	const keyTyped = trimHttpWhitespace(key).length > 0;
	const problem = keyTyped ? candidateProblem(kind, groups, groupIndex, { key: name, valueText }) : undefined;
	const canAdd = keyTyped && problem === undefined;
	const withCandidate: PrefixGroup = { ...group, params: [...group.params, probeRow(name, valueText)] };
	const impliedFlag = (flag: FieldDirective): boolean => directiveMarkedFields(kind, withCandidate, flag).has(name);
	return {
		name,
		problem,
		canAdd,
		valueKind: kind === "caps" ? capabilityControlKind(name, valueText) : "json",
		setKeyAndSeed: (nextKey) => {
			input.setKey(nextKey);
			if (
				kind === "caps" &&
				capabilityValueKind(resolvedFieldName(kind, nextKey)) === "boolean" &&
				trimHttpWhitespace(valueText).length === 0
			) {
				input.setValueText("true");
			}
		},
		flagChecked: (flag) => flagOverrides[flag] ?? impliedFlag(flag),
		toggleFlag: (flag, enabled) => input.setFlagOverrides((current) => ({ ...current, [flag]: enabled })),
		commit: () => {
			if (!canAdd) {
				return;
			}
			let next: PrefixGroup = { ...group, params: [...group.params, newParamRow(name, valueText)] };
			for (const flag of [FORCE_DIRECTIVE, FALLBACK_DIRECTIVE, INHERITABLE_DIRECTIVE] as const) {
				const desired = flagOverrides[flag];
				if (desired === undefined || !directiveEligible(flag, name)) {
					continue;
				}
				if (directiveMarkedFields(kind, next, flag).has(name) !== desired) {
					next = toggleDirectiveField(kind, next, flag, name, desired);
				}
			}
			input.onChange(groups.map((g, i) => (i === groupIndex ? next : g)));
			input.onClose();
		},
	};
}

/**
 * The field chip's popover: the value control, the flag row, Remove field, and the status line.
 *
 * The status slot's id lets the value input point at the verdict (aria-describedby): the slot renders after the
 * actions for layout, and the association keeps DOM order irrelevant to assistive tech. Enter closes the popover once
 * the value is typed - the draft already holds every keystroke, so there is nothing else to commit here.
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
	const statusId = useId();
	if (group === undefined || row === undefined) {
		return null;
	}
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
	const valueInvalid = issue?.problem?.field === "value";
	return (
		<PopoverShell label={l10n.t('Edit field "{0}"', key)} align={align} onClose={onClose}>
			<span className="popover-label">{l10n.t("Value")}</span>
			<ValueControl
				valueKind={kind === "caps" ? capabilityControlKind(key, row.valueText) : "json"}
				valueText={row.valueText}
				disabled={disabled}
				ariaInvalid={valueInvalid}
				describedBy={issue?.problem !== undefined || issue?.hint !== undefined ? statusId : undefined}
				ariaLabel={l10n.t('Value for "{0}"', key)}
				onValue={patchValue}
				onEnter={onClose}
			/>
			<FieldFlags
				kind={kind}
				groups={groups}
				groupIndex={groupIndex}
				group={group}
				fieldKey={key}
				disabled={disabled}
				onChange={onChange}
			/>
			<div className="chip-popover-actions">
				<Button variant="danger" size="compact" disabled={disabled} onClick={removeRow}>
					<IconTrash /> {l10n.t("Remove field")}
				</Button>
			</div>
			<IssueStatus id={statusId} issue={issue} />
		</PopoverShell>
	);
}

/**
 * The [+] chip's popover: a complete field assembled locally and landed as ONE commit, so half-typed rows never leak
 * into the table. The status line sits in the edit popover's after-the-actions slot: the candidate verdict also
 * re-renders per keystroke, and Add field must not walk away from the pointer while the row is typed.
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
	// The user's explicit flag choices only; unset means "whatever the group's directive rows already say about this
	// key" (a literal `_force: true` covers the new field the moment it lands, and the box must show that).
	const [flagOverrides, setFlagOverrides] = useState<Partial<Record<FieldDirective, boolean>>>({});
	const statusId = useId();
	const group = groups[groupIndex];
	if (group === undefined) {
		return null;
	}
	const candidate = candidateField({
		kind,
		groups,
		groupIndex,
		group,
		key,
		valueText,
		flagOverrides,
		setKey,
		setValueText,
		setFlagOverrides,
		onChange,
		onClose,
	});
	const noun = kind === "params" ? l10n.t("Parameter") : l10n.t("Capability");
	return (
		<PopoverShell label={l10n.t("Add field")} align={align} onClose={onClose}>
			<span className="popover-label">{noun}</span>
			<SuggestInput
				value={key}
				suggestions={keySuggestions}
				inputClass="key"
				invalid={false}
				placeholder={
					kind === "params" ? l10n.t("Parameter, e.g. temperature") : l10n.t("Capability, e.g. context_length")
				}
				ariaLabel={noun}
				disabled={disabled}
				onValue={candidate.setKeyAndSeed}
				onEnter={candidate.commit}
			/>
			<span className="popover-label">{l10n.t("Value")}</span>
			<ValueControl
				valueKind={candidate.valueKind}
				valueText={valueText}
				disabled={disabled}
				ariaInvalid={undefined}
				describedBy={candidate.problem === undefined ? undefined : statusId}
				ariaLabel={l10n.t("New field value")}
				onValue={setValueText}
				onEnter={candidate.commit}
			/>
			<CandidateFlags
				kind={kind}
				name={candidate.name}
				keyTyped={trimHttpWhitespace(key).length > 0}
				disabled={disabled}
				flagChecked={candidate.flagChecked}
				onToggle={candidate.toggleFlag}
			/>
			<div className="chip-popover-actions">
				<Button disabled={disabled || !candidate.canAdd} onClick={candidate.commit}>
					<IconAdd /> {l10n.t("Add field")}
				</Button>
			</div>
			<div className="chip-popover-status" id={statusId}>
				{candidate.problem === undefined ? null : <p className="error">{candidate.problem}</p>}
			</div>
		</PopoverShell>
	);
}

/**
 * The open chip popover, addressed by the group's MATCHER KEY and the row's FIELD KEY, never by index - a push or flag
 * toggle may reorder the arrays under it. Keys compare RAW (the resolver's grammar trims nothing, and trimmed identity
 * would transfer between "gpt-4" and "gpt-4 "); ordinals disambiguate exact duplicates.
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
