/**
 * The matcher table: one row per record with its chips, and the full-editor
 * overlay a row opens.
 */
import * as l10n from "@vscode/l10n";
import { useEffect, useId, useState } from "react";
import type { CapabilityGroupIssues, GroupHints, GroupProblems, PrefixGroup } from "../../dashboard/recordDraft";
import { matcherKind, resolvedFieldName, sortedGroupOrder } from "../../dashboard/recordDraft";
import { OPENROUTER_MODEL_DIRECTIVE } from "../../shared/config/recordResolution";
import { HoverTip } from "./help";
import { helpModelParameterPrefix } from "./helpText";
import { IconAdd, IconEdit, IconTrash } from "./icons";
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
import type { GroupIssueView, RecordEditorKind } from "./recordIssues";
import { matcherKindLabel, recordListLabel } from "./recordIssues";
import { SlideOver } from "./slideOver";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";

/**
 * The table's two shapes as one discriminated union, not an optional `onChange`: a
 * writer written only to satisfy a type is indistinguishable from a real handler
 * someone forgot to wire. Every key appears in both halves for destructuring.
 */
type RecordMatcherTableProps = {
	kind: RecordEditorKind;
	groups: readonly PrefixGroup[];
	issues: readonly GroupIssueView[];
} & (
	| {
			/** Render as a static display: plain chips, no popovers, no add or edit actions (the other-scope records, the server drawer's entry records). */
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
			/** The add popover's field-name suggestions; the capability vocabulary fills in for the caps kind. */
			keySuggestions?: readonly string[] | undefined;
			onChange: (next: PrefixGroup[]) => void;
			/** The pencil action; the owner opens the full matcher editor overlay on this draft index. */
			onOpenEditor?: ((groupIndex: number) => void) | undefined;
			/** Reports the open field popover as "groupIndex:rowIndex", so the card's verdict can skip the problem it states. */
			onOpenFieldChange?: ((openField: string | undefined) => void) | undefined;
	  }
);

/**
 * The compact matcher table both record editors and the server form render: one row per
 * matcher. Rows display in precedence order, lowest first (sortedGroupOrder - a VIEW
 * order; the draft's storage order is never rewritten). readOnly renders the same table
 * as a static display.
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
	const [popover, setPopover] = useState<ChipPopoverTarget | undefined>(undefined);
	const tableId = useId();
	// Said once: the open popover states its own field's problem beside the
	// input, so the card's verdict skips THAT problem and no other.
	const openField = openFieldAddress(groups, popover);
	useEffect(() => {
		onOpenFieldChange?.(openField);
		// Cleared on unmount: a stale address would silence a real problem.
		return () => onOpenFieldChange?.(undefined);
	}, [openField, onOpenFieldChange]);
	// A popover whose group or field left the draft (a state push with no
	// draft pinned, a removal elsewhere) closes instead of editing a stale
	// row; one with live edits is never dropped - its edits sit in the draft,
	// which pins across pushes.
	useEffect(() => {
		setPopover((current) => {
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
	const editable = readOnly !== true;
	const order = sortedGroupOrder(groups);
	return (
		// Rows share ONE internal grid through subgrid (the models list's construction). The
		// STRUCTURE lives in dashboard.css, not utilities: dashboard.css sits in the components
		// layer UNDER utilities, so a `grid` utility here would beat the stylesheet's sub-700px
		// fallback no matter the query.
		<ul className="record-table" aria-label={recordListLabel(kind)}>
			{order.map((groupIndex) => {
				const group = groups[groupIndex];
				if (group === undefined) {
					return null;
				}
				const issueView = issues[groupIndex];
				// Identity is the RAW key (reorder-stable where trimmed identity
				// is not) plus the occurrence ordinal for exact duplicates, which
				// block the parse but stay representable.
				const groupKey = group.prefix;
				const groupOrdinal = groups.slice(0, groupIndex).filter((candidate) => candidate.prefix === groupKey).length;
				const groupHere = (target: ChipPopoverTarget | undefined): boolean =>
					target !== undefined && target.groupKey === groupKey && target.groupOrdinal === groupOrdinal;
				const pinnedKey = popover?.kind === "field" && groupHere(popover) ? popover.fieldKey : undefined;
				const chips = chipRowIndices(kind, group, issueView?.rows ?? [], pinnedKey);
				const addOpen = popover?.kind === "add" && groupHere(popover);
				// The visible cell's fallback doubles as the accessible name for
				// the row's actions: a fresh matcher must not announce as "".
				const matcherName = group.prefix.trim().length > 0 ? group.prefix : l10n.t("(no matcher)");
				return (
					// Rows are keyed by their MATCHER KEY plus occurrence (index
					// only for the empty edge): an index key would remount the row
					// when a state push reorders the record, dropping an open add
					// popover's half-typed field with it.
					<li
						// The wash is the row's edit affordance, so only editable rows wear
						// it: on a read-only row it promises an editor that never comes, and
						// its tint under the non-repainting read-only chips took their flag
						// words under AA (3.38:1 in the server drawer, violet).
						className={cn(
							"record-row group/row -mx-2 rounded-md px-2 py-1",
							editable && "hover:bg-accent-soft focus-within:bg-accent-soft"
						)}
						key={`${groupKey}#${groupOrdinal}`}
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
							{chips.map((rowIndex) => {
								const row = group.params[rowIndex];
								if (row === undefined) {
									return null;
								}
								const key = resolvedFieldName(kind, row.key);
								const issue = issueView?.rows[rowIndex];
								const catalog = kind === "caps" && key === OPENROUTER_MODEL_DIRECTIVE;
								// Chip identity mirrors the group's: the RAW key plus the
								// occurrence ordinal among exact duplicates, so each
								// duplicate answers its OWN popover and Remove field can
								// never aim at a sibling row.
								const ordinal = group.params.slice(0, rowIndex).filter((param) => param.key === row.key).length;
								const openHere =
									popover?.kind === "field" &&
									groupHere(popover) &&
									popover.fieldKey === row.key &&
									popover.ordinal === ordinal;
								// Both marks said in words: a border is invisible to a screen reader, and the card's
								// verdict names the matcher, not this field. Descriptions rather than name parts, so
								// the chip still announces as its key and value first.
								const hintId = issue?.hint !== undefined ? `${tableId}-hint-${groupIndex}-${rowIndex}` : undefined;
								const problemId =
									issue?.problem !== undefined ? `${tableId}-problem-${groupIndex}-${rowIndex}` : undefined;
								const describedBy = [problemId, hintId].filter((id) => id !== undefined).join(" ") || undefined;
								// The chip's states resolve through chipVariants (the module's one
								// table); worst mark first, so the exclusivity between the two marks
								// is the variant's shape rather than merge order.
								const chipClass = cn(
									chipVariants({
										editable,
										catalog,
										open: openHere,
										mark: issue?.problem !== undefined ? "invalid" : issue?.hint !== undefined ? "hint" : "none",
									})
								);
								const flags = chipFlags(kind, group, key);
								// The wrong-record-type sentence, when a flag carries one: the
								// read-only chip's HoverTip below is its only reachable carrier
								// (the editable chip describes it through aria-describedby).
								const flagNote = flags.find((flag) => flag.note !== undefined)?.note;
								const body = (
									<>
										{catalog ? (
											<span className="chip-key text-muted-foreground">{l10n.t("catalog")}</span>
										) : (
											<code className="chip-key text-muted-foreground">
												{key.length > 0 ? key : l10n.t("(unnamed)")}
											</code>
										)}
										<span className="chip-value max-w-[14em] truncate text-foreground">{row.valueText}</span>
										{flags.map((flag) => (
											<ChipFlagWord flag={flag} key={flag.id} />
										))}
									</>
								);
								return (
									// Chips are keyed by their FIELD KEY so a directive row
									// inserted or removed by a flag toggle cannot remount an
									// open popover mid-interaction.
									<span className="chip-anchor" key={`${row.key}#${ordinal}`}>
										{editable ? (
											<button
												type="button"
												className={chipClass}
												aria-expanded={openHere}
												aria-describedby={describedBy}
												aria-invalid={issue?.problem !== undefined || undefined}
												disabled={disabled}
												onClick={(event) =>
													setPopover(
														openHere
															? undefined
															: {
																	kind: "field",
																	groupKey,
																	groupOrdinal,
																	fieldKey: row.key,
																	ordinal,
																	align: popoverAlign(event.currentTarget),
																}
													)
												}
											>
												{/* The action rides a hidden prefix so the accessible
												    name keeps the chip's visible content - key, value,
												    and flag badges - instead of masking it. */}
												<span className="visually-hidden">{l10n.t("Edit field")}</span>
												{body}
											</button>
										) : flagNote !== undefined ? (
											// A read-only chip cannot open the popover and a native
											// title never reliably renders in the webview host, so
											// the flag's sentence rides the tip primitive: hover,
											// keyboard focus, and aria-describedby all reach it.
											<HoverTip tip={flagNote}>
												<span className={chipClass}>{body}</span>
											</HoverTip>
										) : (
											<span className={chipClass}>{body}</span>
										)}
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
										{openHere && popover !== undefined && onChange !== undefined ? (
											<FieldChipPopover
												kind={kind}
												groups={groups}
												groupIndex={groupIndex}
												rowIndex={rowIndex}
												issue={issue}
												disabled={disabled === true}
												align={popover.align}
												onChange={onChange}
												onClose={() => setPopover(undefined)}
											/>
										) : null}
									</span>
								);
							})}
							{editable ? (
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
										disabled={disabled}
										aria-label={l10n.t('Add a field to "{0}"', matcherName)}
										onClick={(event) =>
											setPopover(
												addOpen
													? undefined
													: { kind: "add", groupKey, groupOrdinal, align: popoverAlign(event.currentTarget) }
											)
										}
									>
										<IconAdd />
									</button>
									{addOpen && popover !== undefined && onChange !== undefined ? (
										<AddFieldPopover
											kind={kind}
											groups={groups}
											groupIndex={groupIndex}
											disabled={disabled === true}
											keySuggestions={keySuggestions ?? (kind === "caps" ? CAPABILITY_KEY_SUGGESTIONS : [])}
											align={popover.align}
											onChange={onChange}
											onClose={() => setPopover(undefined)}
										/>
									) : null}
								</span>
							) : null}
						</span>
						<InheritsSummary kind={kind} group={group} />
						{editable ? (
							/**
							 * Pushed to the row's end only in the wrapping tier (the wide grid has no free space).
							 * A utility, because the button primitive's own mx- would outrank a stylesheet rule; it
							 * survives the bordered modes only because their hand-back zeroes a custom property,
							 * not the margin itself (ui/button.tsx).
							 */
							<Button
								variant="secondary"
								size="compact"
								className="edit-cell shrink-0 @max-[700px]/pane:ms-auto"
								aria-label={l10n.t('Open the full editor for "{0}"', matcherName)}
								disabled={disabled}
								onClick={() => onOpenEditor?.(groupIndex)}
							>
								<IconEdit />
							</Button>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * The full matcher editor, an overlay on the model inspectors' slide-over machinery. It
 * edits the same draft the table renders - closing commits nothing and loses nothing.
 * Focus returns to the opening pencil on close, `fallbackFocusId` covering a pencil the
 * removal deleted.
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
	/** The group's slice of parseGroups' problems (params kind). */
	groupProblems?: GroupProblems | undefined;
	/** The group's slice of parseGroups' hints (params kind). */
	groupHints?: GroupHints | undefined;
	/** The group's slice of parseCapabilityGroups' issues (caps kind). */
	groupIssues?: CapabilityGroupIssues | undefined;
	prefixPlaceholder?: string | undefined;
	prefixHelp?: string | undefined;
	prefixSuggestions?: readonly string[];
	/** The field-name suggestions: parameter names (params kind) or capability keys (caps kind). */
	keySuggestions?: readonly string[];
	disabled?: boolean;
	/** Where focus lands on close when the opening pencil is gone (a removed matcher); the owner's stable control. */
	fallbackFocusId: string;
	/** One line naming where these edits land (the draft's Apply, the form's Save). */
	note: string;
	onChange: (next: PrefixGroup) => void;
	/** Remove matcher inside the editor; the owner drops the group and closes. */
	onRemove: () => void;
	onClose: () => void;
	/** Enter in a row input, where the owner supports Enter-to-apply. */
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
	/** Occurrence among groups with the SAME raw key (the exact-duplicate edge). */
	readonly ordinal: number;
}

/** The draft index the target currently resolves to; undefined once the group left the rows. */

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
 * The overlay target, resolved to a draft index SYNCHRONOUSLY per render: a pristine
 * push may reorder groups under an open overlay, and a stored index would edit the
 * wrong record for one keystroke. Identity is the RAW matcher key plus an occurrence
 * ordinal; trackRename follows a rename typed inside. The effect clears only once the
 * target is unresolvable, so a key that REAPPEARS cannot resurrect a closed overlay.
 */
export function useMatcherEditing(groups: readonly PrefixGroup[]): {
	/** The open overlay's draft index this render, or undefined when closed. */
	editingIndex: number | undefined;
	/** Open on a draft index; `key` overrides the capture when the group is appended in the same tick. */
	openEditor: (index: number, key?: string) => void;
	/** Follow the matcher key through the overlay's own edits, with the next rows and the group's index in them. */
	trackRename: (next: PrefixGroup, nextGroups: readonly PrefixGroup[], index: number) => void;
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
