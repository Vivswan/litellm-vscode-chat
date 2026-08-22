import * as l10n from "@vscode/l10n";
import { cva } from "class-variance-authority";
import type { FocusEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { settingScopeLabel } from "../../dashboard/presenters";
import type {
	CapabilityGroupIssues,
	FieldDirective,
	GroupHints,
	GroupProblems,
	MatcherKind,
	ParamRow,
	PrefixGroup,
} from "../../dashboard/recordDraft";
import {
	capabilityGroupsFromJsonText,
	directiveEligible,
	directiveMarkedFields,
	directiveRowAbsorbed,
	draftRowsKey,
	groupsFromJsonText,
	inheritFromChoice,
	matcherKind,
	newParamRow,
	parseCapabilityGroups,
	parseGroups,
	parseInheritKeysText,
	resolvedFieldName,
	setInheritFromChoice,
	sortedGroupOrder,
	toCapabilityGroups,
	toGroups,
	toggleDirectiveField,
	wrongRecordTypeHint,
} from "../../dashboard/recordDraft";
import type { DashboardModel, ScopedRecordSetting, SettingScope } from "../../dashboard/viewModels";
import { CONSUMED_CAPABILITY_FIELDS } from "../../shared/config/capabilityResolution";
import {
	FALLBACK_DIRECTIVE,
	FORCE_DIRECTIVE,
	INHERIT_FROM_DIRECTIVE,
	INHERITABLE_DIRECTIVE,
	OPENROUTER_MODEL_DIRECTIVE,
	RECORD_TYPE_DIRECTIVES,
} from "../../shared/config/recordResolution";
import { statusErrorDetail, statusErrorHeadline } from "../../shared/util/errorText";
import { DOCS_LINK_MODEL_CAPABILITIES, DOCS_LINK_MODEL_PARAMETERS } from "./docsLinks";
import { DocsLink, Help, HoverTip } from "./help";
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
	helpModelCapabilitiesSection,
	helpModelParameterName,
	helpModelParameterPrefix,
	helpModelParametersSection,
	helpModelParameterValue,
} from "./helpText";
import type { IntentOutcome } from "./hooks";
import { useIntentOutcome, useRpc } from "./hooks";
import { IconAdd, IconBraces, IconEdit, IconTrash } from "./icons";
import { SlideOver } from "./slideOver";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { cn } from "./ui/cn";
import { Input } from "./ui/input";
import { watchPopoverFlip } from "./ui/popoverFlip";
import { Reveal } from "./ui/reveal";
import { Select } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { sendRequest } from "./vscodeApi";

/**
 * The editor's heading, exported so the settings form's filter matches the editor by
 * exactly the title it renders. Zero-arg so the localized text resolves at call time.
 */
export function modelParametersTitle(): string {
	return l10n.t("Model parameters");
}

/** The capabilities editor's heading, modelParametersTitle's twin for the settings filter. */
export function modelCapabilitiesTitle(): string {
	return l10n.t("Model capabilities");
}

/**
 * The record editors' settings.json jump, directly after the heading it opens. The
 * heading LINE is the hover band, not the h3 (a button inside a heading folds into its
 * accessible name); the jump reveals through the shared Reveal idiom (ui/reveal.tsx),
 * stays in the Tab order via opacity, and stays painted below 560px where hover does
 * not exist.
 */
function HeadingRevealButton({
	title,
	settingId,
}: {
	title: string;
	settingId: "models.parameters" | "models.capabilities";
}) {
	return (
		<Reveal within="head">
			<Button
				variant="secondary"
				size="compact"
				className="reveal-json [--btn-mx:-0.25rem] px-1 py-0"
				aria-label={l10n.t("Open {0} in settings.json", title)}
				onClick={() => sendRequest("revealSetting", { setting: settingId })}
			>
				<IconBraces />
			</Button>
		</Reveal>
	);
}

/** How long the "Saved" note lingers after the ack; toast-scale, and any new edit clears it early. */
const SAVED_NOTICE_MS = 4000;

/**
 * Where a draft is in its apply lifecycle. "applying" is the window between
 * Apply and its correlated ack; "saved" is the transient confirmation the
 * ack starts.
 */
type DraftPhase = "idle" | "dirty" | "applying" | "saved";

/** The local draft's states: edited rows, an in-flight write, or an acked write awaiting the reflecting push. */
type DraftState<T> =
	| { readonly kind: "dirty"; readonly rows: T }
	| { readonly kind: "applying"; readonly rows: T; readonly requestId: string }
	| { readonly kind: "acked"; readonly rows: T; readonly externalAtAck: string };

/**
 * Both editors follow one draft-and-apply model: rows edited locally, validated per
 * keystroke, written back only through Apply, so the object settings never pass through
 * an invalid shape. Apply waits for its own correlated outcome (ok resolves, fail
 * returns the draft dirty). An acked draft keeps rendering until the store push arrives
 * - dropping it at the ack would flash the pre-apply value for one frame.
 */
function useDraftRows<T>(
	external: T,
	outcome: IntentOutcome | undefined
): {
	rows: T;
	dirty: boolean;
	phase: DraftPhase;
	/** Whether a draft of any kind is live (dirty, in flight, or acked awaiting the reflecting push). */
	pinned: boolean;
	/** The reported failure of THIS draft's own write; a leftover notice from a discarded draft never resurfaces. */
	failure: IntentFailureOutcome | undefined;
	update: (next: T) => void;
	apply: (requestId: string) => void;
	reset: () => void;
} {
	// Value identity, id-stripped: the caller re-derives `external` per render
	// and each derivation mints fresh row ids, so the LAST value-distinct
	// external is the one that renders - stable row ids at rest, new ids only
	// when the store value actually changed.
	const externalKey = draftRowsKey(external);
	const externalRef = useRef({ key: externalKey, rows: external });
	if (externalRef.current.key !== externalKey) {
		externalRef.current = { key: externalKey, rows: external };
	}
	const [draft, setDraft] = useState<DraftState<T> | undefined>(undefined);
	const [saved, setSaved] = useState(false);
	// The last Apply's correlation ID, kept past the failure transition (the
	// failure note must name the write the still-open draft came from) and
	// dropped with the draft on Discard.
	const [appliedRequestId, setAppliedRequestId] = useState<string | undefined>(undefined);

	// This draft's own ack: the write landed, so the phase resolves. The rows
	// keep rendering until the store visibly reflects the write, unless they
	// already match it.
	const ackedId = outcome?.result === "ok" ? outcome.id : undefined;
	useEffect(() => {
		if (draft?.kind !== "applying" || draft.requestId !== ackedId) {
			return;
		}
		setSaved(true);
		setDraft(
			draftRowsKey(draft.rows) === externalKey
				? undefined
				: { kind: "acked", rows: draft.rows, externalAtAck: externalKey }
		);
	}, [draft, ackedId, externalKey]);

	// The reflecting push: the store moved past its at-ack value, so the fresh
	// store rows take over from the acked draft.
	useEffect(() => {
		setDraft((current) => (current?.kind === "acked" && externalKey !== current.externalAtAck ? undefined : current));
	}, [externalKey]);

	useEffect(() => {
		if (!saved) {
			return undefined;
		}
		const timer = setTimeout(() => setSaved(false), SAVED_NOTICE_MS);
		return () => clearTimeout(timer);
	}, [saved]);

	// This draft's own reported write failure re-opens it for editing.
	const failure = outcome?.result === "fail" ? outcome : undefined;
	const failureId = failure?.id;
	const failureSeq = failure?.seq;
	useEffect(() => {
		if (failureSeq === undefined || draft?.kind !== "applying" || draft.requestId !== failureId) {
			return;
		}
		setSaved(false);
		setDraft({ kind: "dirty", rows: draft.rows });
	}, [failureSeq, failureId, draft]);

	const phase: DraftPhase = draft === undefined || draft.kind === "acked" ? (saved ? "saved" : "idle") : draft.kind;
	return {
		rows: draft?.rows ?? externalRef.current.rows,
		// Unchanged rows post nothing (the scalar rows' rule, in draft form).
		dirty: draft?.kind === "dirty" && draftRowsKey(draft.rows) !== externalKey,
		phase,
		pinned: draft !== undefined,
		failure: failure !== undefined && failure.id === appliedRequestId ? failure : undefined,
		update: (next) => {
			setSaved(false);
			// Rows edited exactly back onto the store value drop the draft: a pinned value-equal
			// draft would swallow every later store push with Discard disabled. Textual equality
			// only; the correlation ID goes with it, so an old failure cannot haunt the NEXT draft.
			if (draftRowsKey(next) === externalKey) {
				setAppliedRequestId(undefined);
				setDraft(undefined);
			} else {
				setDraft({ kind: "dirty", rows: next });
			}
		},
		apply: (requestId) => {
			setAppliedRequestId(requestId);
			setDraft((current) =>
				current?.kind === "dirty" ? { kind: "applying", rows: current.rows, requestId } : current
			);
		},
		reset: () => {
			setSaved(false);
			setAppliedRequestId(undefined);
			setDraft(undefined);
		},
	};
}

/**
 * The inspectors' configure-jump into an editor: focus the record carrying `key`, or
 * with `create` append a fresh draft group (drafts only land on Apply). `seq` keys
 * re-delivery so repeating the same jump re-focuses.
 */
export interface ExternalRecordEdit {
	readonly seq: number;
	readonly key: string;
	readonly create: boolean;
}

/** The fail arm of a hook outcome: what the editors' failure surfaces render. */
export type IntentFailureOutcome = Extract<IntentOutcome, { result: "fail" }>;

function FailureNote({ failure, dirty }: { failure: IntentFailureOutcome | undefined; dirty: boolean }) {
	// Always mounted, speaking or not (dashboard.css .editor-status): the refusal lands
	// async and must not move the action bar. Headline only, full message in title and a
	// visually-hidden span; role="alert" needs the element to pre-exist. Text stays webview-only.
	const spoken = dirty ? failure : undefined;
	const detail = spoken !== undefined ? statusErrorDetail(spoken.message) : undefined;
	return (
		<p
			className={cn("failure-note", spoken !== undefined && "error")}
			role="alert"
			{...(spoken !== undefined ? { title: spoken.message } : {})}
		>
			{spoken !== undefined
				? l10n.t("Saving failed - your edits are kept: {0}", statusErrorHeadline(spoken.message))
				: ""}
			{detail !== undefined ? <span className="visually-hidden"> {detail}</span> : null}
		</p>
	);
}

/**
 * The Apply outcome beside the commit pair it reports on. The status element
 * is always mounted (empty between phases) so the live region exists before
 * the announcement lands in it.
 */
function ApplyStatus({ phase }: { phase: DraftPhase }) {
	return (
		<span className={cn("apply-status", phase === "saved" && "saved")} role="status">
			{phase === "applying" ? l10n.t("Applying...") : phase === "saved" ? l10n.t("Saved") : ""}
		</span>
	);
}

/** The other-scope records, rendered as the same disabled grid the edit scope uses, never as prose. */
function OtherScopeNote({ scope }: { scope: SettingScope }) {
	return <p className="hint">{l10n.t("Set in {0} settings - edit there.", settingScopeLabel(scope))}</p>;
}

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
function InheritableFlag({
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
 * The checkbox directives each editor renders per row, which is also the set
 * directiveRowAbsorbed may absorb for it: `_force` marks belong to the
 * parameters editor, `_fallback` marks to the capabilities editor,
 * `_inheritable` to both.
 */
const PARAM_FLAG_DIRECTIVES: readonly FieldDirective[] = [FORCE_DIRECTIVE, INHERITABLE_DIRECTIVE];
const CAPABILITY_FLAG_DIRECTIVES: readonly FieldDirective[] = [FALLBACK_DIRECTIVE, INHERITABLE_DIRECTIVE];

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
function ParamGroupsFields({
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
const CAPABILITY_KEY_SUGGESTIONS: readonly string[] = capabilityKeySuggestions();

/**
 * A text input with its own suggestion listbox, replacing the native datalist (the
 * webview host renders it all-bold and unstylable); the catalog picker's combobox
 * pattern. Enter WITHOUT a highlighted suggestion falls through to `onEnter`, so
 * accepting a suggestion can never double as Apply on a half-typed row.
 */
function SuggestInput({
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
function capabilityValueKind(key: string): "number" | "boolean" | "cost" | "catalog-id" | "json" {
	if (key === OPENROUTER_MODEL_DIRECTIVE) {
		return "catalog-id";
	}
	const kind = Object.hasOwn(CONSUMED_CAPABILITY_FIELDS, key) ? CONSUMED_CAPABILITY_FIELDS[key] : undefined;
	return kind === undefined || kind === "string-array" ? "json" : kind;
}

/** The number-family value inputs' shared attributes; costs allow 0 and decimals, token counts do not. */
function numberInputProps(kind: "number" | "cost"): { min: number; step: number | "any"; placeholder: string } {
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
function capabilityControlKind(key: string, valueText: string): ReturnType<typeof capabilityValueKind> {
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
function CapabilityGroupsFields({
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

/**
 * The Edit-as-JSON side door's textarea state: the text being edited plus the
 * snapshot it started from, so "changed at all" needs no re-parse.
 */
interface JsonDraft {
	readonly text: string;
	readonly base: string;
}

function seededJson(value: unknown): JsonDraft {
	const text = JSON.stringify(value, null, 2) ?? "{}";
	return { text, base: text };
}

/**
 * JSON.stringify with object keys sorted at every level (by code unit - a
 * total order, unlike locale collation), so records that differ only in key
 * order compare equal. Gates Apply on a real value change.
 */
function canonicalKey(value: unknown): string {
	return (
		JSON.stringify(value, (_key, inner: unknown) =>
			inner !== null && typeof inner === "object" && !Array.isArray(inner)
				? Object.fromEntries(
						Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					)
				: inner
		) ?? ""
	);
}

/**
 * Hand-curated, mirroring docs/models.md#where-parameters-come-from: the extension has
 * no canonical parameter inventory (pass-through by design), so these are suggestions,
 * never a restriction.
 */
const COMMON_PARAMETER_NAMES = [
	"max_tokens",
	"temperature",
	"top_p",
	"frequency_penalty",
	"presence_penalty",
	"stop",
	"response_format",
	"reasoning_effort",
	"seed",
] as const;

/** Which record editor a shared table serves; picks the flag set, value controls, and key suggestions. */
export type RecordEditorKind = "params" | "caps";

/**
 * One row's issue view - the two parsers' problem/hint shapes normalized so
 * the shared matcher table renders either editor's verdicts. Field-level
 * problems keep their input alignment ("name" or "value") for the popover.
 */
interface RowIssueView {
	readonly problem?: { readonly field: "name" | "value"; readonly message: string } | undefined;
	readonly hint?: string | undefined;
}

/** Row-aligned issue views for one group: the matcher's own problem plus one slot per field row. */
export interface GroupIssueView {
	readonly prefix: string | undefined;
	readonly rows: readonly RowIssueView[];
}

/** parseGroups' problems and hints folded into the table's issue views. */
export function paramIssueViews(
	groups: readonly PrefixGroup[],
	problems: readonly GroupProblems[],
	hints: readonly GroupHints[] | undefined
): GroupIssueView[] {
	return groups.map((group, index) => ({
		prefix: problems[index]?.prefix,
		rows: group.params.map((_, rowIndex) => ({
			problem: problems[index]?.params[rowIndex],
			hint: hints?.[index]?.params[rowIndex],
		})),
	}));
}

/** parseCapabilityGroups' issues folded into the table's issue views. */
export function capabilityIssueViews(
	groups: readonly PrefixGroup[],
	issues: readonly CapabilityGroupIssues[]
): GroupIssueView[] {
	return groups.map((group, index) => ({
		prefix: issues[index]?.prefix,
		rows: group.params.map((_, rowIndex) => ({
			problem: issues[index]?.rows[rowIndex]?.problem,
			hint: issues[index]?.rows[rowIndex]?.hint,
		})),
	}));
}

/** The open field popover's row as "groupIndex:rowIndex"; chip identity is the raw key plus its duplicate ordinal. */
function openFieldAddress(groups: readonly PrefixGroup[], popover: ChipPopoverTarget | undefined): string | undefined {
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

/**
 * The card's one validation verdict: the worst problem in draft order, named by its
 * matcher, skipping the field an open popover already states. Card-scoped because a row
 * cannot hold this line - see dashboard.css .editor-status.
 */
function recordVerdict(
	groups: readonly PrefixGroup[],
	issues: readonly GroupIssueView[],
	openField: string | undefined
): { readonly matcher: string; readonly message: string; readonly others: number } | undefined {
	// Every standing problem in draft order, minus the one an open popover is
	// already stating: the first is the line, the rest are its count.
	const standing: { matcher: string; message: string }[] = [];
	for (const [index, group] of groups.entries()) {
		const issue = issues[index];
		const matcher = group.prefix.trim().length > 0 ? group.prefix : l10n.t("(no matcher)");
		if (issue?.prefix !== undefined) {
			standing.push({ matcher, message: issue.prefix });
		}
		issue?.rows.forEach((row, rowIndex) => {
			if (row?.problem !== undefined && `${index}:${rowIndex}` !== openField) {
				standing.push({ matcher, message: row.problem.message });
			}
		});
	}
	const worst = standing[0];
	return worst === undefined ? undefined : { ...worst, others: standing.length - 1 };
}

/** The verdict as the status slot's message line; it yields the slot to the refusal while one stands. */
function RecordVerdictLine({
	groups,
	issues,
	openField,
}: {
	groups: readonly PrefixGroup[];
	issues: readonly GroupIssueView[];
	openField: string | undefined;
}) {
	const verdict = recordVerdict(groups, issues, openField);
	if (verdict === undefined) {
		return null;
	}
	// The count keeps the others from being dropped silently; fixing the worst
	// promotes the next into the line.
	const more =
		verdict.others === 0 ? "" : verdict.others === 1 ? l10n.t("(+1 more)") : l10n.t("(+{0} more)", verdict.others);
	const spoken = `${verdict.matcher}: ${verdict.message}${more === "" ? "" : ` ${more}`}`;
	// The line clips visually where the slot runs short; the text stays whole
	// in the DOM (and in the title for pointer readers), so nothing is lost.
	return (
		<p className="record-verdict error" title={spoken}>
			<code className="font-mono">{verdict.matcher}</code>
			{`: ${verdict.message}`}
			{more === "" ? null : <span className="record-verdict-more">{` ${more}`}</span>}
		</p>
	);
}

/**
 * The record frames' one message slot: an always-mounted flex item over the footer row's
 * free space (dashboard.css .editor-status), so a message mounting never changes wrap
 * points or moves the buttons. Two voices, one cell: the async write refusal
 * (role="alert", mounted before it speaks) outranks the validation verdict.
 */
export function RecordStatusSlot({
	groups,
	issues,
	openField,
	refusal,
}: {
	groups: readonly PrefixGroup[];
	issues: readonly GroupIssueView[];
	/** The open field popover's "groupIndex:rowIndex"; the verdict skips the one problem stated there. */
	openField?: string | undefined;
	/** The owning draft's write-refusal channel; absent on surfaces with no write path (the read-only frames). */
	refusal?: { readonly failure: IntentFailureOutcome | undefined; readonly dirty: boolean } | undefined;
}) {
	const refusing = refusal !== undefined && refusal.failure !== undefined && refusal.dirty;
	return (
		<span className="editor-status">
			{refusal !== undefined ? <FailureNote failure={refusal.failure} dirty={refusal.dirty} /> : null}
			{refusing ? null : <RecordVerdictLine groups={groups} issues={issues} openField={openField} />}
		</span>
	);
}

/**
 * Whether any standing problem would give the verdict a voice. The read-only frames
 * mount their message row only then: their problems are static per push, so a
 * conditional row cannot shift geometry under a live edit.
 */
export function anyRecordProblem(issues: readonly GroupIssueView[]): boolean {
	return issues.some((issue) => issue.prefix !== undefined || issue.rows.some((row) => row.problem !== undefined));
}

/** The row list's accessible name; the rows carry no header row to name them any more. */
function recordListLabel(kind: RecordEditorKind): string {
	return kind === "params" ? l10n.t("Model parameter matchers") : l10n.t("Model capability matchers");
}

/** The matcher kind annotation beside each row's key, resolved at render time. */
function matcherKindLabel(kind: MatcherKind): string {
	switch (kind) {
		case "catch-all":
			return l10n.t("matches all models");
		case "regex":
			return l10n.t("regex");
		case "glob":
			return l10n.t("prefix match");
		case "exact":
			return l10n.t("exact ID");
		case "invalid":
			return l10n.t("invalid matcher");
	}
}

/** The inherits column's cell chrome, one spelling for every branch below. */
const INHERIT_CELL = "inherit-cell shrink-0 text-[11px] text-muted-foreground";

/**
 * A row's short reading of its `_inherit_from` state; nothing where the group takes the
 * default - the mark appears exactly where a choice was made.
 */
function InheritsSummary({ kind, group }: { kind: RecordEditorKind; group: PrefixGroup }) {
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
function forceWord(): string {
	return l10n.t({
		message: "force",
		comment: ["Checkbox label on a parameter row; marks the value as forced over runtime options."],
	});
}

function fallbackWord(): string {
	return l10n.t({
		message: "fallback",
		comment: ["Checkbox label on a capability row; applies the value only where the server reports none."],
	});
}

function inheritableWord(): string {
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
 * One directive mark word, on a chip or in a row's flag cell. The user-set
 * marks wear the accent's readable label tier - a permanent word at 11px on
 * the chip fill, where the raw hue measures 2.83:1. The wrong-record-type
 * "ignored" badge wears the warn text tier instead; the chip's dashed border
 * stays the tone's mark, so the word only names it. The sentence itself is the
 * carrier's job - the editable chip describes it through aria-describedby plus
 * the card's status line, the read-only chip through a HoverTip - because a
 * native title neither renders reliably in the webview host nor shows on
 * keyboard focus (see help.tsx).
 */
function ChipFlagWord({ flag }: { flag: ChipFlag }) {
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
function WrongTypeFlagCell({ note, id }: { note: string; id: string }) {
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
function chipFlags(kind: RecordEditorKind, group: PrefixGroup, key: string): ChipFlag[] {
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
function flagDirectivesFor(kind: RecordEditorKind): readonly FieldDirective[] {
	return kind === "params" ? PARAM_FLAG_DIRECTIVES : CAPABILITY_FLAG_DIRECTIVES;
}

/**
 * The row indices a group renders as chips: everything except directive rows the table's
 * own surfaces fully represent (directiveRowAbsorbed; a directive the controls cannot
 * fully show keeps a raw chip). A row the open popover edits stays pinned, so absorption
 * can never unmount the popover mid-keystroke. Omission hides no problem: absorbed
 * implies valid, so every problem row has a chip to carry its mark.
 */
function chipRowIndices(
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
const chipVariants = cva(
	"chip-field inline-flex flex-wrap items-baseline gap-1.5 rounded-(--radius-chip) border border-transparent bg-chip px-1 font-mono text-[12px] text-muted-foreground",
	{
		variants: {
			// Filled at rest - the frame makes these a bounded region and the fill
			// is what says "these are the fields"; the hairline and the input fill
			// still arrive with the pointer or with focus, which is the moment the
			// row has to prove it is editable.
			editable: {
				true: "cursor-pointer group-hover/row:border-border group-hover/row:bg-input-background group-focus-within/row:border-border group-focus-within/row:bg-input-background hover:text-foreground focus-visible:outline-(length:--ring-w) focus-visible:outline-offset-(--ring-offset) focus-visible:outline-ring focus-visible:outline-solid",
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
function FieldChipPopover({
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
function AddFieldPopover({
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
type ChipPopoverTarget =
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
function popoverAlign(target: EventTarget | null): "start" | "end" {
	if (!(target instanceof HTMLElement)) {
		return "start";
	}
	const rect = target.getBoundingClientRect();
	return rect.left > window.innerWidth / 2 ? "end" : "start";
}

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
										className="chip-field chip-add rounded-(--radius-chip) border border-transparent px-1 text-muted-foreground group-hover/row:border-border group-focus-within/row:border-border hover:text-foreground focus-visible:outline-(length:--ring-w) focus-visible:outline-offset-(--ring-offset) focus-visible:outline-ring focus-visible:outline-solid"
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
function useMatcherEditing(groups: readonly PrefixGroup[]): {
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

/**
 * Structured editor for litellm-vscode-chat.models.parameters, the object-of-objects the
 * native Settings GUI cannot edit. Edits apply to one scope; others render read-only.
 */
export function ModelParametersEditor({
	scoped,
	models,
	hidden,
	external,
}: {
	scoped: ScopedRecordSetting<Readonly<Record<string, unknown>>>;
	/** The discovered models, feeding the prefix input's suggestions. */
	models: readonly DashboardModel[];
	/** The settings filter's verdict; hides the section without unmounting it, so a dirty draft survives. */
	hidden?: boolean;
	/** The inspectors' configure-jump; see ExternalRecordEdit. */
	external?: ExternalRecordEdit | undefined;
}) {
	const intent = useIntentOutcome("setModelParameters");
	const draft = useDraftRows(toGroups(scoped.value), intent.outcome);
	const groups = draft.rows;
	// One parse per keystroke: the row problems, the Apply gate, and the
	// assembled record are the same verdict, so a draft that renders clean can
	// never assemble differently.
	const parse = parseGroups(groups);
	const problems = parse.ok ? [] : parse.problems;
	const [json, setJson] = useState<JsonDraft | undefined>(undefined);
	// The table reports its open field so the card's verdict skips the one problem it already states.
	const [openField, setOpenField] = useState<string | undefined>(undefined);
	const jsonParse = json === undefined ? undefined : groupsFromJsonText(json.text);
	const jsonBlocked = jsonParse !== undefined && !jsonParse.ok;

	// A JSON view without a live draft follows the store like the rows do.
	// Any draft - dirty, in flight, or acked - pins it: a dirty one because
	// the text is (or seeded) the user's, the others because resyncing before
	// the reflecting push would flash the pre-apply value back into the
	// textarea.
	const externalJsonText = JSON.stringify(scoped.value, null, 2) ?? "{}";
	const draftPinned = draft.pinned;
	useEffect(() => {
		if (draftPinned) {
			return;
		}
		setJson((current) =>
			current !== undefined && current.text === current.base && current.text !== externalJsonText
				? { text: externalJsonText, base: externalJsonText }
				: current
		);
	}, [externalJsonText, draftPinned]);

	// Apply needs a real value change on top of a dirty draft: rows can differ
	// in spelling ("1e1" vs "10") while assembling to the record already stored
	// (the scalar rows' unchanged-posts-nothing rule).
	const changed = parse.ok && canonicalKey(parse.value) !== canonicalKey(scoped.value);
	const canApply = draft.dirty && changed && !jsonBlocked;
	const apply = () => {
		if (!parse.ok || !canApply) {
			return;
		}
		const requestId = intent.send({ value: parse.value });
		draft.apply(requestId);
		// The applied text becomes the JSON baseline; only edits after it count as discardable again.
		setJson((current) => (current === undefined ? current : { ...current, base: current.text }));
	};
	const discard = () => {
		draft.reset();
		if (json !== undefined) {
			setJson(seededJson(scoped.value));
		}
	};

	const modelIds = Array.from(new Set(models.map((model) => model.id)));
	const issueViews = paramIssueViews(groups, problems, parse.hints);
	// The full matcher editor overlay, re-anchored by matcher key on pushes.
	const { editingIndex, openEditor, trackRename, closeEditing } = useMatcherEditing(groups);
	// A removal that lands the rows back on the store value resets the draft
	// inside useDraftRows.update itself; every path below simply updates.
	// Closing the overlay sweeps up a still-pristine new matcher (no key, no
	// fields): keeping it would strand an invalid empty row in the table.
	const closeEditor = () => {
		if (editingIndex !== undefined) {
			const group = groups[editingIndex];
			if (group !== undefined && group.prefix.trim().length === 0 && group.params.length === 0) {
				draft.update(groups.filter((_, index) => index !== editingIndex));
			}
		}
		closeEditing();
	};
	// The inspectors' configure-jump lands in the overlay: the existing record
	// opens directly, a create request appends the draft group first. Matcher
	// keys compare RAW on both sides - the request carries the stored record key
	// and the draft holds the stored prefix, and the grammar trims neither. Inert
	// while the JSON view is open (rewriting a JSON draft would lose text).
	// Keyed on the request's seq so repeating the same jump re-opens.
	const externalSeq = external?.seq;
	const jsonOpen = json !== undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on the request seq alone so repeating the jump re-opens; the draft, groups, and editor are read at fire time
	useEffect(() => {
		if (external === undefined || externalSeq === undefined || jsonOpen) {
			return;
		}
		const index = groups.findIndex((group) => group.prefix === external.key);
		if (index >= 0) {
			openEditor(index);
			return;
		}
		if (!external.create) {
			return;
		}
		draft.update([...groups, { prefix: external.key, params: [] }]);
		openEditor(groups.length, external.key);
	}, [externalSeq]);
	return (
		<section hidden={hidden}>
			{/* A contained heading sits a step quieter than the group heading
			    above it: same muted tone, one size down, and no rule of its own.
			    At the surrounding group's weight and the page's foreground it
			    out-shouted its own container. */}
			<div className="section-head group/head mb-1">
				<h3 className="m-0 font-semibold text-[0.9em] text-muted-foreground">{modelParametersTitle()}</h3>
				<HeadingRevealButton title={modelParametersTitle()} settingId="models.parameters" />
				<Help text={helpModelParametersSection()} name={l10n.t("Help: {0}", modelParametersTitle())} />
				<DocsLink href={DOCS_LINK_MODEL_PARAMETERS} label={l10n.t("Open the model parameters guide")} />
			</div>
			{/* The frame bounds the draft: the matcher rows (or the JSON side
			    door), the failure note, and the action bar that commits them are
			    one region, so "what does Apply apply" has a visible answer. */}
			<div className="record-frame">
				{/* Where Apply writes, said only when it is news: the write-scope
				    rule sends edits to a scope that already sets the record, and
				    "not your User settings" is the one case worth a line. */}
				{scoped.editScope !== "global" ? (
					<p className="hint editor-scope-note">
						{l10n.t(
							"Apply writes {0} settings - that scope already sets this record.",
							settingScopeLabel(scoped.editScope)
						)}
					</p>
				) : null}
				{json !== undefined ? (
					<div className="record-json">
						<Textarea
							className="w-full px-2 py-1"
							rows={10}
							aria-label={l10n.t("Model parameters as JSON")}
							aria-invalid={jsonBlocked}
							value={json.text}
							onChange={(event) => {
								const text = event.currentTarget.value;
								setJson((current) => (current === undefined ? current : { ...current, text }));
								const parsed = groupsFromJsonText(text);
								if (parsed.ok) {
									draft.update(parsed.rows);
								}
							}}
						/>
						{/* The side door's reserved status line (dashboard.css
						    .json-status): the parse verdict lands per keystroke, and
						    mounted only alongside a problem it pushed the mode buttons
						    and the commit bar down on the first bad character. */}
						<p className={cn("json-status", jsonParse !== undefined && !jsonParse.ok && "error")}>
							{jsonParse !== undefined && !jsonParse.ok ? jsonParse.problem : null}
						</p>
					</div>
				) : (
					<>
						{groups.length === 0 ? (
							<p className="empty">{l10n.t("No model parameters configured in this scope.")}</p>
						) : null}
						{groups.length > 0 ? (
							<RecordMatcherTable
								kind="params"
								groups={groups}
								issues={issueViews}
								keySuggestions={COMMON_PARAMETER_NAMES}
								onChange={(next) => draft.update(next)}
								onOpenEditor={openEditor}
								onOpenFieldChange={setOpenField}
							/>
						) : null}
					</>
				)}
				<div className="toolbar editor-actions">
					{json === undefined ? (
						<Button
							variant="secondary"
							id="params-add-matcher"
							onClick={() => {
								draft.update([...groups, { prefix: "", params: [] }]);
								openEditor(groups.length, "");
							}}
						>
							<IconAdd /> {l10n.t("Add model matcher")}
						</Button>
					) : null}
					{json === undefined ? (
						<Button
							variant="secondary"
							size="compact"
							disabled={!parse.ok}
							onClick={() => {
								if (parse.ok) {
									setJson(seededJson(parse.value));
								}
							}}
						>
							{l10n.t("Edit as JSON")}
						</Button>
					) : (
						<Button variant="secondary" size="compact" disabled={jsonBlocked} onClick={() => setJson(undefined)}>
							{l10n.t("Edit as rows")}
						</Button>
					)}
					{/* The bar's one message slot rides its free space, between the mode
					    actions and the commit trio: the refusal and the validation
					    verdict speak here, one at a time, without moving either group. */}
					<RecordStatusSlot
						groups={groups}
						issues={issueViews}
						openField={openField}
						refusal={{ failure: draft.failure, dirty: draft.dirty }}
					/>
					{/* The commit trio is ONE flex group so a narrow pane wraps it as a
				    unit - a bare ms-auto on the status once let Apply wrap onto a
				    line of its own, left-aligned under the mode actions. */}
					<span className="editor-commit ms-auto flex flex-wrap items-center gap-2">
						<ApplyStatus phase={draft.phase} />
						{/* Discard stays available while a write is in flight: a lost ack
					    must not wedge the editor until a reload. */}
						<Button
							variant="danger"
							disabled={!draft.dirty && draft.phase !== "applying" && !(json !== undefined && json.text !== json.base)}
							aria-label={l10n.t("Discard the unapplied model parameter edits")}
							onClick={discard}
						>
							{l10n.t("Discard")}
						</Button>
						{/* Last in the bar, first in rank: the accent `default` rank is
					    the dashboard's primary, and the trailing slot is where a
					    region's commit lives. */}
						<Button disabled={!canApply} onClick={apply}>
							{l10n.t("Apply")}
						</Button>
					</span>
				</div>
			</div>
			{scoped.otherScopes.map((other) => {
				// The static table judges its rows with the same parse as the edit
				// scope: absorption reads the hints, and a directive the badges
				// cannot faithfully summarize must keep its raw chip here too.
				const otherGroups = toGroups(other.value);
				const otherParse = parseGroups(otherGroups);
				const otherIssues = paramIssueViews(otherGroups, otherParse.ok ? [] : otherParse.problems, otherParse.hints);
				return (
					<div className="other-scope" key={other.scope}>
						<OtherScopeNote scope={other.scope} />
						<div className="record-frame">
							<RecordMatcherTable kind="params" groups={otherGroups} issues={otherIssues} readOnly />
							{/* A read-only chip's mark is a border with no popover behind
							    it, so the frame's own message row says what stands - the
							    footer-position line, message alone (no write path, no
							    buttons), mounted only while a problem does. */}
							{anyRecordProblem(otherIssues) ? (
								<div className="toolbar editor-actions">
									<RecordStatusSlot groups={otherGroups} issues={otherIssues} />
								</div>
							) : null}
						</div>
					</div>
				);
			})}
			{editingIndex !== undefined && groups[editingIndex] !== undefined ? (
				<RecordMatcherEditorOverlay
					kind="params"
					group={groups[editingIndex] as PrefixGroup}
					groupProblems={problems[editingIndex]}
					groupHints={parse.hints[editingIndex]}
					prefixPlaceholder={l10n.t("Model ID or matcher, e.g. gpt-4 or gpt-4*")}
					prefixHelp={helpModelParameterPrefix()}
					prefixSuggestions={modelIds}
					keySuggestions={COMMON_PARAMETER_NAMES}
					fallbackFocusId="params-add-matcher"
					note={l10n.t("Changes here edit the draft; Apply in the editor saves them.")}
					onChange={(next) => {
						const remapped = groups.map((group, index) => (index === editingIndex ? next : group));
						draft.update(remapped);
						trackRename(next, remapped, editingIndex);
					}}
					onRemove={() => {
						draft.update(groups.filter((_, index) => index !== editingIndex));
						closeEditing();
					}}
					onClose={closeEditor}
					onEnter={apply}
				/>
			) : null}
		</section>
	);
}

/**
 * Structured editor for litellm-vscode-chat.models.capabilities, the parameters editor's
 * typed sibling (two-management-paths parity). Same draft-and-apply model; edits land
 * through the setModelCapabilities intent.
 */
export function ModelCapabilitiesEditor({
	scoped,
	models,
	observedKeys,
	hidden,
	external,
}: {
	scoped: ScopedRecordSetting<Readonly<Record<string, unknown>>>;
	/** The discovered models, feeding the matcher input's suggestions. */
	models: readonly DashboardModel[];
	/**
	 * The cross-server union of observed /model/info keys: the unknown-key hints' evidence
	 * AND the server half of the key autocomplete (the global records scope over every
	 * server, so the union fits both). Absent or empty means no evidence - hints suppressed,
	 * suggestions fall back to the static vocabulary.
	 */
	observedKeys?: readonly string[] | undefined;
	/** The settings filter's verdict; hides the section without unmounting it, so a dirty draft survives. */
	hidden?: boolean;
	/** The inspectors' configure-jump; see ExternalRecordEdit. */
	external?: ExternalRecordEdit | undefined;
}) {
	const intent = useIntentOutcome("setModelCapabilities");
	const draft = useDraftRows(toCapabilityGroups(scoped.value), intent.outcome);
	const groups = draft.rows;
	const recognizedKeys = observedKeys === undefined ? undefined : new Set(observedKeys);
	// The key autocomplete over the same evidence: the consumed vocabulary
	// extended by what THIS scope's servers actually report.
	const keySuggestions = capabilityKeySuggestions(observedKeys);
	// One parse per keystroke, like the parameters editor: the row issues, the
	// Apply gate, and the assembled record are the same verdict.
	const parse = parseCapabilityGroups(groups, recognizedKeys);
	const issues = parse.issues;
	const [json, setJson] = useState<JsonDraft | undefined>(undefined);
	// The table reports its open field so the card's verdict skips the one problem it already states.
	const [openField, setOpenField] = useState<string | undefined>(undefined);
	const jsonParse = json === undefined ? undefined : capabilityGroupsFromJsonText(json.text);
	const jsonBlocked = jsonParse !== undefined && !jsonParse.ok;

	const externalJsonText = JSON.stringify(scoped.value, null, 2) ?? "{}";
	const draftPinned = draft.pinned;
	useEffect(() => {
		if (draftPinned) {
			return;
		}
		setJson((current) =>
			current !== undefined && current.text === current.base && current.text !== externalJsonText
				? { text: externalJsonText, base: externalJsonText }
				: current
		);
	}, [externalJsonText, draftPinned]);

	const changed = parse.ok && canonicalKey(parse.value) !== canonicalKey(scoped.value);
	const canApply = draft.dirty && changed && !jsonBlocked;
	const apply = () => {
		if (!parse.ok || !canApply) {
			return;
		}
		const requestId = intent.send({ value: parse.value });
		draft.apply(requestId);
		setJson((current) => (current === undefined ? current : { ...current, base: current.text }));
	};
	const discard = () => {
		draft.reset();
		if (json !== undefined) {
			setJson(seededJson(scoped.value));
		}
	};

	const modelIds = Array.from(new Set(models.map((model) => model.id)));
	const issueViews = capabilityIssueViews(groups, issues);
	// The full matcher editor overlay, re-anchored by matcher key on pushes;
	// see the parameters editor's twin block for the close-sweep and
	// external-jump contracts.
	const { editingIndex, openEditor, trackRename, closeEditing } = useMatcherEditing(groups);
	const closeEditor = () => {
		if (editingIndex !== undefined) {
			const group = groups[editingIndex];
			if (group !== undefined && group.prefix.trim().length === 0 && group.params.length === 0) {
				draft.update(groups.filter((_, index) => index !== editingIndex));
			}
		}
		closeEditing();
	};
	// Keyed on the request's seq so repeating the same jump re-opens.
	const externalSeq = external?.seq;
	const jsonOpen = json !== undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on the request seq alone so repeating the jump re-opens; the draft, groups, and editor are read at fire time
	useEffect(() => {
		if (external === undefined || externalSeq === undefined || jsonOpen) {
			return;
		}
		const index = groups.findIndex((group) => group.prefix === external.key);
		if (index >= 0) {
			openEditor(index);
			return;
		}
		if (!external.create) {
			return;
		}
		draft.update([...groups, { prefix: external.key, params: [] }]);
		openEditor(groups.length, external.key);
	}, [externalSeq]);
	return (
		<section hidden={hidden}>
			{/* Quieter than its container, like the parameters twin above. */}
			<div className="section-head group/head mb-1">
				<h3 className="m-0 font-semibold text-[0.9em] text-muted-foreground">{modelCapabilitiesTitle()}</h3>
				<HeadingRevealButton title={modelCapabilitiesTitle()} settingId="models.capabilities" />
				<Help text={helpModelCapabilitiesSection()} name={l10n.t("Help: {0}", modelCapabilitiesTitle())} />
				<DocsLink href={DOCS_LINK_MODEL_CAPABILITIES} label={l10n.t("Open the model capabilities guide")} />
			</div>
			{/* The parameters editor's frame, on this editor's own parse. */}
			<div className="record-frame">
				{/* The write scope, said only when it is news (the parameters
				    editor's rule). */}
				{scoped.editScope !== "global" ? (
					<p className="hint editor-scope-note">
						{l10n.t(
							"Apply writes {0} settings - that scope already sets this record.",
							settingScopeLabel(scoped.editScope)
						)}
					</p>
				) : null}
				{json !== undefined ? (
					<div className="record-json">
						<Textarea
							className="w-full px-2 py-1"
							rows={10}
							aria-label={l10n.t("Model capabilities as JSON")}
							aria-invalid={jsonBlocked}
							value={json.text}
							onChange={(event) => {
								const text = event.currentTarget.value;
								setJson((current) => (current === undefined ? current : { ...current, text }));
								const parsed = capabilityGroupsFromJsonText(text);
								if (parsed.ok) {
									draft.update(parsed.rows);
								}
							}}
						/>
						{/* The reserved status line, the parameters door's rule (see the
						    twin above dashboard.css .json-status). */}
						<p className={cn("json-status", jsonParse !== undefined && !jsonParse.ok && "error")}>
							{jsonParse !== undefined && !jsonParse.ok ? jsonParse.problem : null}
						</p>
					</div>
				) : (
					<>
						{groups.length === 0 ? (
							<p className="empty">{l10n.t("No model capabilities configured in this scope.")}</p>
						) : null}
						{groups.length > 0 ? (
							<RecordMatcherTable
								kind="caps"
								groups={groups}
								issues={issueViews}
								keySuggestions={keySuggestions}
								onChange={(next) => draft.update(next)}
								onOpenEditor={openEditor}
								onOpenFieldChange={setOpenField}
							/>
						) : null}
					</>
				)}
				<div className="toolbar editor-actions">
					{json === undefined ? (
						<Button
							variant="secondary"
							id="caps-add-matcher"
							onClick={() => {
								draft.update([...groups, { prefix: "", params: [] }]);
								openEditor(groups.length, "");
							}}
						>
							<IconAdd /> {l10n.t("Add capability matcher")}
						</Button>
					) : null}
					{json === undefined ? (
						<Button
							variant="secondary"
							size="compact"
							disabled={!parse.ok}
							onClick={() => {
								if (parse.ok) {
									setJson(seededJson(parse.value));
								}
							}}
						>
							{l10n.t("Edit as JSON")}
						</Button>
					) : (
						<Button variant="secondary" size="compact" disabled={jsonBlocked} onClick={() => setJson(undefined)}>
							{l10n.t("Edit as rows")}
						</Button>
					)}
					{/* The bar's one message slot in its free space; the params editor
					    above states the two-speaker rule. */}
					<RecordStatusSlot
						groups={groups}
						issues={issueViews}
						openField={openField}
						refusal={{ failure: draft.failure, dirty: draft.dirty }}
					/>
					{/* The commit trio wraps as a unit; the parameters editor's twin. */}
					<span className="editor-commit ms-auto flex flex-wrap items-center gap-2">
						<ApplyStatus phase={draft.phase} />
						{/* Discard stays available while a write is in flight: a lost ack
					    must not wedge the editor until a reload. */}
						<Button
							variant="danger"
							disabled={!draft.dirty && draft.phase !== "applying" && !(json !== undefined && json.text !== json.base)}
							aria-label={l10n.t("Discard the unapplied model capability edits")}
							onClick={discard}
						>
							{l10n.t("Discard")}
						</Button>
						<Button disabled={!canApply} onClick={apply}>
							{l10n.t("Apply")}
						</Button>
					</span>
				</div>
			</div>
			{scoped.otherScopes.map((other) => {
				// The same-parse rule as the parameters editor's static tables,
				// with the same evidence: other scopes still hold global records.
				const otherGroups = toCapabilityGroups(other.value);
				const otherParse = parseCapabilityGroups(otherGroups, recognizedKeys);
				const otherIssues = capabilityIssueViews(otherGroups, otherParse.issues);
				return (
					<div className="other-scope" key={other.scope}>
						<OtherScopeNote scope={other.scope} />
						<div className="record-frame">
							<RecordMatcherTable kind="caps" groups={otherGroups} issues={otherIssues} readOnly />
							{/* The params frames' rule above: a standing problem gets the
							    frame's own message row, and a quiet frame closes flush. */}
							{anyRecordProblem(otherIssues) ? (
								<div className="toolbar editor-actions">
									<RecordStatusSlot groups={otherGroups} issues={otherIssues} />
								</div>
							) : null}
						</div>
					</div>
				);
			})}
			{editingIndex !== undefined && groups[editingIndex] !== undefined ? (
				<RecordMatcherEditorOverlay
					kind="caps"
					group={groups[editingIndex] as PrefixGroup}
					groupIssues={issues[editingIndex]}
					prefixSuggestions={modelIds}
					keySuggestions={keySuggestions}
					fallbackFocusId="caps-add-matcher"
					note={l10n.t("Changes here edit the draft; Apply in the editor saves them.")}
					onChange={(next) => {
						const remapped = groups.map((group, index) => (index === editingIndex ? next : group));
						draft.update(remapped);
						trackRename(next, remapped, editingIndex);
					}}
					onRemove={() => {
						draft.update(groups.filter((_, index) => index !== editingIndex));
						closeEditing();
					}}
					onClose={closeEditor}
					onEnter={apply}
				/>
			) : null}
		</section>
	);
}
