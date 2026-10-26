import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import type {
	CapabilityGroupIssues,
	GroupHints,
	GroupProblems,
	ParamRow,
	PrefixGroup,
} from "../../dashboard/recordDraft";
import { matcherKind, resolvedFieldName, sortedGroupOrder } from "../../dashboard/recordDraft";
import { OPENROUTER_MODEL_DIRECTIVE } from "../../shared/config/recordResolution";
import { trimHttpWhitespace } from "../../shared/util/headers";
import { HoverTip } from "./help";
import { helpModelParameterPrefix } from "./helpText";
import { IconAdd, IconEdit, IconTrash } from "./icons";
import { tupleKey } from "./keys";
import type { ChipPopoverTarget } from "./recordChipPopovers";
import {
	AddFieldPopover,
	chipRowIndices,
	chipVariants,
	FieldChipPopover,
	InheritsSummary,
	openFieldAddress,
	popoverAlign,
} from "./recordChipPopovers";
import { ChipFlagWord, chipFlags } from "./recordFlags";
import { CAPABILITY_KEY_SUGGESTIONS, CapabilityGroupsFields, ParamGroupsFields } from "./recordGroupFields";
import type { GroupIssueView, RecordEditorKind, RowIssueView } from "./recordIssues";
import { matcherKindLabel, recordListLabel } from "./recordIssues";
import { SlideOver } from "./slideOver";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";

/**
 * The table's two shapes as one discriminated union, not an optional `onChange`: a writer written only to satisfy a
 * type is indistinguishable from a real handler someone forgot to wire. Every key appears in both halves for
 * destructuring.
 *
 *   readOnly: true    -> a static display: plain chips, no popovers, no add or edit actions (the other-scope records,
 *                        the server drawer's entry records)
 *   onOpenFieldChange -> reports the open field popover as "groupIndex:rowIndex", so the card's verdict can skip the
 *                        problem it states
 */
type RecordMatcherTableProps = {
	kind: RecordEditorKind;
	groups: readonly PrefixGroup[];
	issues: readonly GroupIssueView[];
} & (
	| {
			readOnly: true;
			disabled?: undefined;
			keySuggestions?: undefined;
			onChange?: undefined;
			onOpenEditor?: undefined;
			onOpenFieldChange?: undefined;
	  }
	| {
			readOnly?: false | undefined;
			disabled?: boolean | undefined;
			keySuggestions?: readonly string[] | undefined;
			onChange: (next: PrefixGroup[]) => void;
			onOpenEditor?: ((groupIndex: number) => void) | undefined;
			onOpenFieldChange?: ((openField: string | undefined) => void) | undefined;
	  }
);

/** The table's edit affordance, present on an editable table and absent on a read-only one, so a chip asks once. */
interface RowEdit {
	readonly disabled: boolean | undefined;
	readonly onChange: (next: PrefixGroup[]) => void;
}

/** One matcher row as every chip in it sees it: the group, its identity, its issues, the open popover, the edit. */
interface RowContext {
	readonly kind: RecordEditorKind;
	readonly groups: readonly PrefixGroup[];
	readonly group: PrefixGroup;
	readonly groupIndex: number;
	readonly groupKey: string;
	readonly groupOrdinal: number;
	readonly issueView: GroupIssueView | undefined;
	readonly tableId: string;
	readonly popover: ChipPopoverTarget | undefined;
	readonly setPopover: (next: ChipPopoverTarget | undefined) => void;
	readonly edit: RowEdit | undefined;
}

interface ChipPopoverState {
	readonly target: ChipPopoverTarget | undefined;
	readonly set: (next: ChipPopoverTarget | undefined) => void;
}

interface ChipBodyProps {
	readonly catalog: boolean;
	readonly fieldKey: string;
	readonly valueText: string;
	readonly flags: ReturnType<typeof chipFlags>;
}

/** One field chip's identity among exact duplicates, the marks it wears, and the ids its spoken descriptions take. */
interface FieldChipMarks {
	readonly key: string;
	readonly issue: RowIssueView | undefined;
	readonly catalog: boolean;
	readonly ordinal: number;
	readonly openHere: boolean;
	readonly invalid: boolean;
	readonly hintId: string | undefined;
	readonly problemId: string | undefined;
	readonly describedBy: string | undefined;
	readonly chipClass: string;
	readonly flags: ReturnType<typeof chipFlags>;
	readonly flagNote: string | undefined;
}

interface ChipDescriptionsProps {
	readonly problemId: string | undefined;
	readonly hintId: string | undefined;
	readonly issue: RowIssueView | undefined;
}

interface FieldChipProps {
	readonly row: RowContext;
	readonly rowIndex: number;
}

interface AddFieldChipProps {
	readonly row: RowContext;
	readonly matcherName: string;
	readonly keySuggestions: readonly string[] | undefined;
}

interface MatcherRowProps {
	readonly row: RowContext;
	readonly keySuggestions: readonly string[] | undefined;
	readonly onOpenEditor: ((groupIndex: number) => void) | undefined;
}

/**
 * The open chip popover, reported to the owner as a field address and closed when its group or field leaves the draft
 * (editing a stale row would be worse than closing). The report is cleared on unmount: a stale address would silence a
 * real problem.
 */
function useChipPopover(
	groups: readonly PrefixGroup[],
	onOpenFieldChange: ((openField: string | undefined) => void) | undefined
): ChipPopoverState {
	const [target, setTarget] = useState<ChipPopoverTarget | undefined>(undefined);
	const openField = openFieldAddress(groups, target);
	useEffect(() => {
		onOpenFieldChange?.(openField);
		return () => onOpenFieldChange?.(undefined);
	}, [openField, onOpenFieldChange]);
	useEffect(() => {
		setTarget((current) => {
			if (current === undefined) {
				return current;
			}
			const group = groups.filter((candidate) => candidate.prefix === current.groupKey)[current.groupOrdinal];
			if (group === undefined) {
				return undefined;
			}
			if (
				current.kind === "field" &&
				group.params.filter((param) => param.key === current.fieldKey).length <= current.ordinal
			) {
				return undefined;
			}
			return current;
		});
	}, [groups]);
	return { target, set: setTarget };
}

/** Whether a popover target addresses this row's group. */
function groupHere(target: ChipPopoverTarget | undefined, row: RowContext): boolean {
	return target !== undefined && target.groupKey === row.groupKey && target.groupOrdinal === row.groupOrdinal;
}

/** How many earlier rows share this row's key: exact duplicates block the parse but stay representable. */
function occurrenceOrdinal(params: readonly ParamRow[], rowIndex: number): number {
	const key = params[rowIndex]?.key;
	return params.slice(0, rowIndex).filter((candidate) => candidate.key === key).length;
}

/** Worst mark first, so the exclusivity between the two marks is the variant's shape rather than merge order. */
function chipMark(issue: RowIssueView | undefined): "none" | "hint" | "invalid" {
	if (issue?.problem !== undefined) {
		return "invalid";
	}
	return issue?.hint === undefined ? "none" : "hint";
}

function ChipBody({ catalog, fieldKey, valueText, flags }: ChipBodyProps) {
	return (
		<>
			{catalog ? (
				<span className="chip-key text-muted-foreground">{l10n.t("catalog")}</span>
			) : (
				<code className="chip-key text-muted-foreground">{fieldKey.length > 0 ? fieldKey : l10n.t("(unnamed)")}</code>
			)}
			<span className="chip-value max-w-[14em] truncate text-foreground">{valueText}</span>
			{flags.map((flag) => (
				<ChipFlagWord flag={flag} key={flag.id} />
			))}
		</>
	);
}

/** The chip's marks from the row's issue view and open popover; its states resolve through chipVariants, the module's one table. */
function fieldChipMarks(row: RowContext, rowIndex: number, param: ParamRow): FieldChipMarks {
	const { kind, group, groupIndex, popover, tableId } = row;
	const key = resolvedFieldName(kind, param.key);
	const issue = row.issueView?.rows[rowIndex];
	const catalog = kind === "caps" && key === OPENROUTER_MODEL_DIRECTIVE;
	const ordinal = occurrenceOrdinal(group.params, rowIndex);
	const openHere =
		popover?.kind === "field" &&
		groupHere(popover, row) &&
		popover.fieldKey === param.key &&
		popover.ordinal === ordinal;
	const hintId = issue?.hint === undefined ? undefined : `${tableId}-hint-${groupIndex}-${rowIndex}`;
	const problemId = issue?.problem === undefined ? undefined : `${tableId}-problem-${groupIndex}-${rowIndex}`;
	const flags = chipFlags(kind, group, key);
	return {
		key,
		issue,
		catalog,
		ordinal,
		openHere,
		invalid: issue?.problem !== undefined,
		hintId,
		problemId,
		describedBy: [problemId, hintId].filter((id) => id !== undefined).join(" ") || undefined,
		chipClass: cn(chipVariants({ editable: row.edit !== undefined, catalog, open: openHere, mark: chipMark(issue) })),
		flags,
		flagNote: flags.find((flag) => flag.note !== undefined)?.note,
	};
}

/**
 * Both marks said in words: a border is invisible to a screen reader, and the card's verdict names the matcher, not
 * this field. Descriptions rather than name parts, so the chip still announces as its key and value first.
 */
function ChipDescriptions({ problemId, hintId, issue }: ChipDescriptionsProps) {
	return (
		<>
			{problemId !== undefined && issue?.problem !== undefined ? (
				<span id={problemId} className="visually-hidden">
					{issue.problem.message}
				</span>
			) : null}
			{hintId !== undefined && issue?.hint !== undefined ? (
				<span id={hintId} className="visually-hidden">
					{issue.hint}
				</span>
			) : null}
		</>
	);
}

/**
 * One field chip with its popover. Chip identity mirrors the group's: the RAW key plus the occurrence ordinal among
 * exact duplicates, so each duplicate answers its OWN popover and Remove field can never aim at a sibling row.
 *
 * On an editable row the chip is a control whose action rides a hidden prefix, so the accessible name keeps the chip's
 * visible content - key, value, and flag badges - instead of masking it. A read-only chip cannot open the popover and
 * a native title never reliably renders in the webview host, so the flag's sentence rides the tip primitive: hover,
 * keyboard focus, and aria-describedby all reach it.
 */
function FieldChip({ row, rowIndex }: FieldChipProps) {
	const param = row.group.params[rowIndex];
	if (param === undefined) {
		return null;
	}
	const { kind, groupKey, groupOrdinal, popover } = row;
	const chip = fieldChipMarks(row, rowIndex, param);
	const body = <ChipBody catalog={chip.catalog} fieldKey={chip.key} valueText={param.valueText} flags={chip.flags} />;
	let face: ReactNode;
	if (row.edit !== undefined) {
		face = (
			<button
				type="button"
				className={chip.chipClass}
				aria-expanded={chip.openHere}
				aria-describedby={chip.describedBy}
				aria-invalid={chip.invalid || undefined}
				disabled={row.edit.disabled}
				onClick={(event) =>
					row.setPopover(
						chip.openHere
							? undefined
							: {
									kind: "field",
									groupKey,
									groupOrdinal,
									fieldKey: param.key,
									ordinal: chip.ordinal,
									align: popoverAlign(event.currentTarget),
								}
					)
				}
			>
				<span className="visually-hidden">{l10n.t("Edit field")}</span>
				{body}
			</button>
		);
	} else if (chip.flagNote === undefined) {
		face = <span className={chip.chipClass}>{body}</span>;
	} else {
		face = (
			<HoverTip tip={chip.flagNote}>
				<span className={chip.chipClass}>{body}</span>
			</HoverTip>
		);
	}
	return (
		<span className="chip-anchor">
			{face}
			<ChipDescriptions problemId={chip.problemId} hintId={chip.hintId} issue={chip.issue} />
			{chip.openHere && popover !== undefined && row.edit !== undefined ? (
				<FieldChipPopover
					kind={kind}
					groups={row.groups}
					groupIndex={row.groupIndex}
					rowIndex={rowIndex}
					issue={chip.issue}
					disabled={row.edit.disabled === true}
					align={popover.align}
					onChange={row.edit.onChange}
					onClose={() => row.setPopover(undefined)}
				/>
			) : null}
		</span>
	);
}

/** The row's trailing [+] chip and the add popover it opens. */
function AddFieldChip({ row, matcherName, keySuggestions }: AddFieldChipProps) {
	const { kind, groupKey, groupOrdinal, popover } = row;
	const addOpen = popover?.kind === "add" && groupHere(popover, row);
	return (
		<span className="chip-anchor">
			<button
				type="button"
				className={cn(
					"chip-field chip-add rounded-(--radius-chip) border border-transparent px-1 text-muted-foreground",
					"group-hover/row:border-border group-focus-within/row:border-border hover:text-foreground",
					"focus-visible:outline-(length:--ring-w) focus-visible:outline-offset-(--ring-offset)",
					"focus-visible:outline-ring focus-visible:outline-solid"
				)}
				aria-expanded={addOpen}
				disabled={row.edit?.disabled}
				aria-label={l10n.t('Add a field to "{0}"', matcherName)}
				onClick={(event) =>
					row.setPopover(
						addOpen ? undefined : { kind: "add", groupKey, groupOrdinal, align: popoverAlign(event.currentTarget) }
					)
				}
			>
				<IconAdd />
			</button>
			{addOpen && popover !== undefined && row.edit !== undefined ? (
				<AddFieldPopover
					kind={kind}
					groups={row.groups}
					groupIndex={row.groupIndex}
					disabled={row.edit.disabled === true}
					keySuggestions={keySuggestions ?? (kind === "caps" ? CAPABILITY_KEY_SUGGESTIONS : [])}
					align={popover.align}
					onChange={row.edit.onChange}
					onClose={() => row.setPopover(undefined)}
				/>
			) : null}
		</span>
	);
}

/**
 * One matcher row. The wash is the row's edit affordance, so only editable rows wear it: on a read-only row it
 * promises an editor that never comes, and its tint under the non-repainting read-only chips took their flag words
 * under AA (3.38:1 in the server drawer, violet). The visible cell's fallback doubles as the accessible name for the
 * row's actions: a fresh matcher must not announce as "".
 */
function MatcherRow({ row, keySuggestions, onOpenEditor }: MatcherRowProps) {
	const { kind, group, groupIndex, popover } = row;
	const editable = row.edit !== undefined;
	const pinnedKey = popover?.kind === "field" && groupHere(popover, row) ? popover.fieldKey : undefined;
	const chips = chipRowIndices(kind, group, row.issueView?.rows ?? [], pinnedKey);
	const matcherName = trimHttpWhitespace(group.prefix).length > 0 ? group.prefix : l10n.t("(no matcher)");
	return (
		<li
			className={cn(
				"record-row group/row -mx-2 rounded-md px-2 py-1",
				editable && "hover:bg-accent-soft focus-within:bg-accent-soft"
			)}
		>
			{/* Shrinkable on purpose: the wide tier's grid ignores flex-shrink, and in
			    the sub-700px flex rows a max-content cell would carry a long regex key
			    past the pane; min-w-[104px] still floors the collapse. */}
			<span className="matcher-cell flex min-w-[104px] flex-wrap items-baseline gap-2">
				{/* The matcher wears the chip chrome OUTLINED where the field
				    chips are FILLED: one radius system, two fills - identity
				    reads as a container, data as contents. */}
				<code className="matcher-key rounded-(--radius-chip) border border-border px-1 font-mono text-[12px] text-foreground [overflow-wrap:anywhere]">
					{matcherName}
				</code>
				<span className="matcher-kind text-[11px] text-muted-foreground">
					{matcherKindLabel(matcherKind(group.prefix))}
				</span>
			</span>
			{/* min-w-min, not min-w-0: a zero floor let the chips overflow the inherit summary; the
			    floor is a chip's longest UNBREAKABLE piece (check-overflow holds it). No flex-item
			    utilities: a utility would beat the 700px stylesheet fallback. */}
			<span className="chip-list flex min-w-min flex-wrap items-baseline gap-x-2 gap-y-1">
				{/* Chips are keyed by their FIELD KEY so a directive row inserted or removed by a
				    flag toggle cannot remount an open popover mid-interaction. */}
				{chips.map((rowIndex) => {
					const param = group.params[rowIndex];
					if (param === undefined) {
						return null;
					}
					return (
						<FieldChip
							key={tupleKey(param.key, occurrenceOrdinal(group.params, rowIndex))}
							row={row}
							rowIndex={rowIndex}
						/>
					);
				})}
				{editable ? <AddFieldChip row={row} matcherName={matcherName} keySuggestions={keySuggestions} /> : null}
			</span>
			<InheritsSummary kind={kind} group={group} />
			{editable ? (
				/**
				 * Pushed to the row's end only in the wrapping tier (the wide grid has no free space). A
				 * utility, because the button primitive's own mx- would outrank a stylesheet rule; it
				 * survives the bordered modes only because their hand-back zeroes a custom property, not
				 * the margin itself (ui/button.tsx).
				 */
				<Button
					variant="secondary"
					size="compact"
					className="edit-cell shrink-0 @max-[700px]/pane:ms-auto"
					aria-label={l10n.t('Open the full editor for "{0}"', matcherName)}
					disabled={row.edit?.disabled}
					onClick={() => onOpenEditor?.(groupIndex)}
				>
					<IconEdit />
				</Button>
			) : null}
		</li>
	);
}

/**
 * Rows display in precedence order, lowest first (sortedGroupOrder - a VIEW order; the draft's storage order is never
 * rewritten).
 *
 * Rows are keyed by their MATCHER KEY plus occurrence: an index key would remount the row when a state push reorders
 * the record, dropping an open add popover's half-typed field with it. Identity is the RAW key (reorder-stable where
 * trimmed identity is not) plus the occurrence ordinal for exact duplicates, which block the parse but stay
 * representable.
 */
export function RecordMatcherTable({
	kind,
	groups,
	issues,
	readOnly,
	disabled,
	keySuggestions,
	onChange,
	onOpenEditor,
	onOpenFieldChange,
}: RecordMatcherTableProps) {
	const popover = useChipPopover(groups, onOpenFieldChange);
	const tableId = useId();
	const edit = readOnly === true ? undefined : { disabled, onChange };
	const order = sortedGroupOrder(groups);
	return (
		// Rows share ONE internal grid through subgrid (the models list's construction). The STRUCTURE lives in
		// dashboard.css, not utilities: dashboard.css sits in the components layer UNDER utilities, so a `grid`
		// utility here would beat the stylesheet's sub-700px fallback no matter the query.
		<ul className="record-table" aria-label={recordListLabel(kind)}>
			{order.map((groupIndex) => {
				const group = groups[groupIndex];
				if (group === undefined) {
					return null;
				}
				const groupKey = group.prefix;
				const groupOrdinal = groups.slice(0, groupIndex).filter((candidate) => candidate.prefix === groupKey).length;
				const row: RowContext = {
					kind,
					groups,
					group,
					groupIndex,
					groupKey,
					groupOrdinal,
					issueView: issues[groupIndex],
					tableId,
					popover: popover.target,
					setPopover: popover.set,
					edit,
				};
				return (
					<MatcherRow
						key={tupleKey(groupKey, groupOrdinal)}
						row={row}
						keySuggestions={keySuggestions}
						onOpenEditor={onOpenEditor}
					/>
				);
			})}
		</ul>
	);
}

/**
 *   It edits the same draft the table renders -> closing commits nothing
 *
 *   fallbackFocusId -> where focus lands on close when the opening pencil is gone (a removed matcher); the owner's
 *                      stable control
 *   note            -> one line naming where these edits land (the draft's Apply, the form's Save)
 *   onRemove        -> Remove matcher inside the editor; the owner drops the group and closes
 *   onEnter         -> Enter in a row input, where the owner supports Enter-to-apply
 */
export function RecordMatcherEditorOverlay({
	kind,
	group,
	groupProblems,
	groupHints,
	groupIssues,
	prefixPlaceholder,
	prefixHelp,
	prefixSuggestions,
	keySuggestions,
	disabled,
	fallbackFocusId,
	note,
	onChange,
	onRemove,
	onClose,
	onEnter,
}: {
	kind: RecordEditorKind;
	group: PrefixGroup;
	groupProblems?: GroupProblems | undefined;
	groupHints?: GroupHints | undefined;
	groupIssues?: CapabilityGroupIssues | undefined;
	prefixPlaceholder?: string | undefined;
	prefixHelp?: string | undefined;
	prefixSuggestions?: readonly string[];
	keySuggestions?: readonly string[];
	disabled?: boolean;
	fallbackFocusId: string;
	note: string;
	onChange: (next: PrefixGroup) => void;
	onRemove: () => void;
	onClose: () => void;
	onEnter?: (() => void) | undefined;
}) {
	const titleId = useId();
	return (
		<SlideOver labelledBy={titleId} fallbackFocusId={fallbackFocusId} onRequestClose={onClose}>
			<div className="matcher-editor">
				<h3 id={titleId}>{kind === "params" ? l10n.t("Edit parameter matcher") : l10n.t("Edit capability matcher")}</h3>
				<p className="hint">{note}</p>
				{kind === "params" ? (
					<ParamGroupsFields
						group={group}
						problems={groupProblems}
						hints={groupHints}
						disabled={disabled}
						prefixPlaceholder={prefixPlaceholder ?? l10n.t("Model ID or matcher, e.g. gpt-4 or gpt-4*")}
						prefixHelp={prefixHelp ?? helpModelParameterPrefix()}
						prefixSuggestions={prefixSuggestions}
						paramNameSuggestions={keySuggestions}
						onChange={onChange}
						onEnter={onEnter}
					/>
				) : (
					<CapabilityGroupsFields
						group={group}
						issues={groupIssues}
						disabled={disabled}
						prefixSuggestions={prefixSuggestions}
						keySuggestions={keySuggestions}
						onChange={onChange}
						onEnter={onEnter}
					/>
				)}
				<div className="toolbar editor-footer">
					<Button onClick={onClose}>{l10n.t("Done")}</Button>
					<Button variant="danger" disabled={disabled} onClick={onRemove}>
						<IconTrash /> {l10n.t("Remove matcher")}
					</Button>
				</div>
			</div>
		</SlideOver>
	);
}

/** The open overlay's target: the RAW matcher key captured at open, plus its occurrence among exact duplicates. */
interface MatcherEditing {
	/** Identity exactly as stored - the grammar trims nothing, so neither does identity. */
	readonly key: string;

	/** Which of the key's exact duplicates this is, counted in draft order from zero. */
	readonly ordinal: number;
}

function resolveMatcherEditing(
	groups: readonly PrefixGroup[],
	editing: MatcherEditing | undefined
): number | undefined {
	if (editing === undefined) {
		return undefined;
	}
	let seen = 0;
	for (let index = 0; index < groups.length; index += 1) {
		if (groups[index]?.prefix === editing.key) {
			if (seen === editing.ordinal) {
				return index;
			}
			seen += 1;
		}
	}
	return undefined;
}

/**
 * The overlay target, resolved to a draft index SYNCHRONOUSLY per render: a pristine push may reorder groups under an
 * open overlay, and a stored index would edit the wrong record for one keystroke.
 *
 * The effect clears only once the target is unresolvable, so a key that REAPPEARS cannot resurrect a closed overlay.
 */
export function useMatcherEditing(groups: readonly PrefixGroup[]): {
	/** The target's draft index this render; undefined once its key and ordinal no longer resolve. */
	editingIndex: number | undefined;

	/** Open on a draft index; `key` overrides the capture when the group is appended in the same tick. */
	openEditor: (index: number, key?: string) => void;

	/** Follow the matcher key through the overlay's own edits, with the next rows and the group's index in them. */
	trackRename: (next: PrefixGroup, nextGroups: readonly PrefixGroup[], index: number) => void;

	/** Drop the target; the overlay unmounts with it. */
	closeEditing: () => void;
} {
	const [editing, setEditing] = useState<MatcherEditing | undefined>(undefined);
	const editingIndex = resolveMatcherEditing(groups, editing);
	useEffect(() => {
		setEditing((current) =>
			current !== undefined && resolveMatcherEditing(groups, current) === undefined ? undefined : current
		);
	}, [groups]);
	return {
		editingIndex,
		openEditor: (index, key) => {
			const raw = key ?? groups[index]?.prefix ?? "";
			const ordinal = groups.slice(0, Math.min(index, groups.length)).filter((group) => group.prefix === raw).length;
			setEditing({ key: raw, ordinal });
		},
		trackRename: (next, nextGroups, index) =>
			setEditing((current) =>
				current === undefined
					? current
					: {
							key: next.prefix,
							ordinal: nextGroups.slice(0, index).filter((group) => group.prefix === next.prefix).length,
						}
			),
		closeEditing: () => setEditing(undefined),
	};
}
