import * as l10n from "@vscode/l10n";
import type { CSSProperties, FocusEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { settingScopeLabel } from "../../dashboard/presenters";
import type {
	CapabilityGroupIssues,
	FieldDirective,
	GroupHints,
	GroupProblems,
	MatcherKind,
	PrefixGroup,
} from "../../dashboard/recordDraft";
import {
	capabilityGroupsFromJsonText,
	directiveEligible,
	directiveMarkedFields,
	directiveRowAbsorbed,
	groupsFromJsonText,
	inheritFromChoice,
	matcherKind,
	parseCapabilityGroups,
	parseGroups,
	setInheritFromChoice,
	sortedGroupOrder,
	toCapabilityGroups,
	toGroups,
	toggleDirectiveField,
} from "../../dashboard/recordDraft";
import type { DashboardModel, ScopedRecordSetting, SettingScope } from "../../dashboard/viewModels";
import {
	CONSUMED_CAPABILITY_FIELDS,
	FALLBACK_DIRECTIVE,
	OPENROUTER_MODEL_DIRECTIVE,
} from "../../shared/config/capabilityResolution";
import { FORCE_DIRECTIVE } from "../../shared/config/parameterResolution";
import { INHERIT_FROM_DIRECTIVE, INHERITABLE_DIRECTIVE } from "../../shared/config/recordResolution";
import { statusErrorDetail, statusErrorHeadline } from "../../shared/util/errorText";
import { DOCS_LINK_MODEL_CAPABILITIES, DOCS_LINK_MODEL_PARAMETERS } from "./docsLinks";
import { DocsLink, Help } from "./help";
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
import { Reveal } from "./ui/reveal";
import { Select } from "./ui/select";
import { sendRequest } from "./vscodeApi";

/**
 * The editor's heading, exported so the settings form's filter matches the
 * editor by exactly the title it renders (the scalar rows' label rule).
 * A zero-arg function so the localized text resolves at call time, not at
 * module load.
 */
export function modelParametersTitle(): string {
	return l10n.t("Model parameters");
}

/** The capabilities editor's heading, modelParametersTitle's twin for the settings filter. */
export function modelCapabilitiesTitle(): string {
	return l10n.t("Model capabilities");
}

/**
 * The record editors' settings.json jump, the settings form's RevealButton
 * on an editor heading. It sits directly after the heading it opens - one
 * position, with its label - rather than floating after the docs link, where
 * a bare pair of braces belonged to nothing in particular. The heading LINE
 * is the hover band (the head itself, not the h3: a button inside the
 * heading folds into its accessible name, and the heading would announce
 * as "Model parameters, Open Model parameters in settings.json"), so the
 * jump rests hidden and reveals on hover or focus through the shared Reveal
 * idiom (ui/reveal.tsx): opacity keeps it in the Tab order so its own focus
 * can reveal it, the @max-[560px]/pane clause keeps it painted where hover
 * does not exist, and the transition stands down under reduced motion.
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
 * Both editors here follow one draft-and-apply model: rows are edited
 * locally, validated on every keystroke, and written back to configuration
 * only through Apply, so the object settings never pass through an invalid
 * intermediate shape. With no draft the store value renders directly; a
 * dirty draft wins until Apply or Discard. Apply posts an intent through the
 * editor's useIntentOutcome hook and waits for its own correlated outcome:
 * an ok resolves the phase (the Saved note), a fail returns the draft to a
 * dirty, retryable state. An acked draft keeps rendering until the store
 * push that reflects the write arrives (dropping it at the ack would flash
 * the pre-apply value for the one frame before that push); should that push
 * outrun the ack, the acked draft simply holds its value-equal rows until
 * the next store change.
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
	const externalKey = JSON.stringify(external);
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
			JSON.stringify(draft.rows) === externalKey
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
		rows: draft?.rows ?? external,
		// Unchanged rows post nothing (the scalar rows' rule, in draft form).
		dirty: draft?.kind === "dirty" && JSON.stringify(draft.rows) !== externalKey,
		phase,
		pinned: draft !== undefined,
		failure: failure !== undefined && failure.id === appliedRequestId ? failure : undefined,
		update: (next) => {
			setSaved(false);
			// Rows edited exactly back onto the store value drop the draft
			// entirely: a pinned value-equal draft would swallow every later
			// store push with Discard disabled (nothing looks dirty). Textual
			// equality only - a different spelling of the same value ("1e1")
			// stays a live draft. The correlation ID goes with it, so an old
			// write's failure notice cannot resurface on the NEXT draft.
			if (JSON.stringify(next) === externalKey) {
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
 * The inspectors' configure-jump into an editor: focus the record carrying
 * `key`, or - when `create` is set and no group carries it - append a fresh
 * draft group keyed by it (not yet applied; drafts only land on Apply, per
 * the editors' contract). `seq` keys re-delivery so repeating the same jump
 * re-focuses.
 */
export interface ExternalRecordEdit {
	readonly seq: number;
	readonly key: string;
	readonly create: boolean;
}

/** The fail arm of a hook outcome: what the editors' failure surfaces render. */
export type IntentFailureOutcome = Extract<IntentOutcome, { result: "fail" }>;

function FailureNote({ failure, dirty }: { failure: IntentFailureOutcome | undefined; dirty: boolean }) {
	// One line, reserved whether or not it speaks (dashboard.css .failure-note):
	// the refusal lands async under the rows, and as an inserted block it pushed
	// the action bar and everything below it 36px down. The frame keeps the
	// edits-kept fact and the extension's HEADLINE only - the covered slots'
	// rule: an arbitrary-length technical detail never rides a reserved line
	// (statusErrorHeadline is the same extraction the host notifier's toasts
	// use). The detail is not lost: this surface is the failure's only home
	// (no toast backs it up), so the full message rides the title for pointer
	// readers and an sr-only span for assistive tech, both costing zero
	// geometry. No direction word - the note renders under the rows, so
	// "below" pointed away from the failing row it meant. The message stays
	// webview-only (the panel boundary logs classification tokens, never this
	// text). role="alert" on the ALWAYS-MOUNTED slot: the refusal arrives
	// async, and a live region only announces changes to an element that
	// already exists - one announcement per failure, none on the empty rest
	// state.
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
			{detail !== undefined ? <span className="sr-only"> {detail}</span> : null}
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
 * The group-level `_inherit_from` control: a compact select over the
 * directive's four shapes plus a keys input for the named-records form. It is
 * the directive's single representation - a readable `_inherit_from` row is
 * absorbed out of the grid - so it also carries the row's non-blocking hint.
 * It goes hands-off while the row holds text the strict parse rejects: that
 * row stays visible with its own error, and the select must not silently
 * rewrite the user's text.
 */
function InheritFromControl({
	group,
	disabled,
	hint,
	onChange,
}: {
	group: PrefixGroup;
	disabled: boolean;
	/** The absorbed `_inherit_from` row's non-blocking note (an unknown record key), rendered beside the control. */
	hint?: string | undefined;
	onChange: (next: PrefixGroup) => void;
}) {
	const choice = inheritFromChoice(group);
	const id = useId();
	// The keys mode must be enterable from scratch: picking it writes NOTHING
	// until a key is typed (an empty `_inherit_from` list IS the barrier by
	// the docs' edge-case rules, so auto-writing [] on a mode switch would
	// snap the select straight to "nothing - barrier"). The pending flag holds
	// the UI in keys mode while the row itself stays absent; typing the first
	// key writes the list, and emptying the input removes the row again while
	// the mode persists locally. [] stays expressible only through Edit as
	// JSON (it means the same barrier as false).
	const [keysPending, setKeysPending] = useState(false);
	const [pendingText, setPendingText] = useState("");
	if (choice.kind === "unreadable") {
		return (
			<span className="inherit-from">
				<span className="editor-label">{l10n.t("Inherits")}</span>
				<span className="hint">{l10n.t("Inheritance: edit the _inherit_from row below")}</span>
			</span>
		);
	}
	const shownKind = choice.kind === "keys" ? "keys" : keysPending && choice.kind === "default" ? "keys" : choice.kind;
	const keysText = choice.kind === "keys" ? choice.keysText : pendingText;
	const writeKeys = (text: string) => {
		setPendingText(text);
		const hasKey = text.split(",").some((key) => key.trim().length > 0);
		if (hasKey) {
			onChange(setInheritFromChoice(group, { keysText: text }));
		} else if (choice.kind === "keys") {
			// Emptied: drop the row (never write []); the local mode keeps the
			// input on screen for the next key. The flag must be set here too -
			// a stored keys row entered edit with it false, and dropping the row
			// without it would unmount the input mid-edit and steal focus.
			setKeysPending(true);
			onChange(setInheritFromChoice(group, "default"));
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
						const kind = event.currentTarget.value;
						if (kind === "default" || kind === "all" || kind === "none") {
							setKeysPending(false);
							setPendingText("");
							onChange(setInheritFromChoice(group, kind));
						} else {
							// Enter keys mode without writing; see the comment above.
							setKeysPending(true);
							setPendingText(choice.kind === "keys" ? choice.keysText : "");
							if (choice.kind !== "keys" && choice.kind !== "default") {
								onChange(setInheritFromChoice(group, "default"));
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
	group,
	groupIndex,
	groups,
	fieldKey,
	disabled,
	onChange,
}: {
	group: PrefixGroup;
	groupIndex: number;
	groups: readonly PrefixGroup[];
	fieldKey: string;
	disabled: boolean;
	onChange: (next: PrefixGroup[]) => void;
}) {
	const marked = directiveMarkedFields(group, INHERITABLE_DIRECTIVE);
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
						onChange(
							groups.map((g, i) =>
								i === groupIndex
									? toggleDirectiveField(g, INHERITABLE_DIRECTIVE, fieldKey, event.currentTarget.checked)
									: g
							)
						)
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
 * Which row's inputs own focus, so the editors hold off absorbing a directive
 * row the user is typing in: unmounting the input on the exact keystroke that
 * makes the value readable would steal focus (the InheritFromControl
 * keysPending hazard, in row form). The row absorbs on blur instead; focus
 * moving between the row's own inputs is not a blur.
 *
 * The hold is positional, and rows are positional too, so it must not outlive
 * the index space it was armed in: a hold surviving a row removal would pin
 * whatever row shifts into the slot (removing the focused element fires no
 * focusout). Each hold is therefore stamped with the structural epoch - a
 * counter that advances whenever any group's row count changes - and honored
 * only in the epoch it was armed in, so a structural change voids it in the
 * same render for good (a shape stamp alone would resurrect it once a later
 * change happened to restore the same row counts). Only text-entry inputs arm
 * the hold; a row's checkboxes and buttons trigger exactly those structural
 * changes, which must land immediately.
 */
function useFocusedRow(groups: readonly PrefixGroup[]): {
	focused: (groupIndex: number, rowIndex: number) => boolean;
	rowFocusProps: (
		groupIndex: number,
		rowIndex: number
	) => {
		onFocusCapture: (event: FocusEvent) => void;
		onBlurCapture: (event: FocusEvent) => void;
	};
} {
	const shape = groups.map((group) => group.params.length).join(",");
	const epochRef = useRef({ shape, epoch: 0 });
	if (epochRef.current.shape !== shape) {
		epochRef.current = { shape, epoch: epochRef.current.epoch + 1 };
	}
	const epoch = epochRef.current.epoch;
	const [hold, setHold] = useState<
		{ readonly group: number; readonly row: number; readonly epoch: number } | undefined
	>(undefined);
	return {
		focused: (groupIndex, rowIndex) =>
			hold !== undefined && hold.epoch === epoch && hold.group === groupIndex && hold.row === rowIndex,
		rowFocusProps: (groupIndex, rowIndex) => ({
			onFocusCapture: (event: FocusEvent) => {
				if (event.target instanceof HTMLInputElement && event.target.type !== "checkbox") {
					setHold((current) =>
						current !== undefined && current.group === groupIndex && current.row === rowIndex && current.epoch === epoch
							? current
							: { group: groupIndex, row: rowIndex, epoch }
					);
				}
			},
			onBlurCapture: (event: FocusEvent) => {
				const next = event.relatedTarget;
				if (next instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(next)) {
					return;
				}
				setHold((current) =>
					current !== undefined && current.group === groupIndex && current.row === rowIndex ? undefined : current
				);
			},
		}),
	};
}

/**
 * The key track's typing freeze. The field grid's key column is content-sized
 * (dashboard.css .rows: fit-content fed by field-sizing), so the tracks
 * re-solve on every keystroke and typing a name visibly shoved the value
 * column sideways, letter by letter. While focus is anywhere in the grid
 * (armed by a key input taking it), the track is pinned at the width it had
 * when the key input was focused (the --key-track custom property the
 * stylesheet's template reads first); leaving the grid commits the names and
 * the track refits once, after the editing is done. The pin holds across
 * focus moving WITHIN the grid - key to key, and key to the same row's value
 * input, because releasing on that move re-solved the track at the exact
 * moment focus landed on the input the reflow would displace. Two things do
 * drop it: a structural change (a row added or removed re-solves the tracks
 * anyway and fires no blur when it removes the focused input - the
 * useFocusedRow epoch reasoning, without the per-row addressing), and a
 * window resize (a pinned px track measured in a wide pane has no cap, so
 * surviving a narrowing it would push the grid past the panel's edge).
 */
function useKeyTrackFreeze(groups: readonly PrefixGroup[]): {
	style: CSSProperties | undefined;
	onFocusCapture: (event: FocusEvent) => void;
	onBlurCapture: (event: FocusEvent) => void;
} {
	const [frozen, setFrozen] = useState<number | undefined>(undefined);
	const shape = groups.map((group) => group.params.length).join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on the row-count shape alone; any structural change drops the pin
	useEffect(() => {
		setFrozen(undefined);
	}, [shape]);
	useEffect(() => {
		if (frozen === undefined) {
			return undefined;
		}
		const release = () => setFrozen(undefined);
		window.addEventListener("resize", release, { passive: true });
		return () => window.removeEventListener("resize", release);
	}, [frozen]);
	return {
		style: frozen === undefined ? undefined : ({ "--key-track": `${frozen}px` } as CSSProperties),
		onFocusCapture: (event: FocusEvent) => {
			if (!(event.target instanceof HTMLInputElement) || !event.target.classList.contains("key")) {
				return;
			}
			// The cell spans the key track exactly, so its width IS the track's.
			// Guarded above zero: an unlaid-out environment (happy-dom) measures
			// nothing, and a 0px pin would collapse the column instead of holding
			// it still.
			const cell = event.target.closest(".cell.key");
			const width = cell instanceof HTMLElement ? cell.getBoundingClientRect().width : 0;
			if (width > 0) {
				setFrozen((current) => current ?? width);
			}
		},
		onBlurCapture: (event: FocusEvent) => {
			const next = event.relatedTarget;
			if (next instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(next)) {
				return;
			}
			setFrozen(undefined);
		},
	};
}

/**
 * The model-parameter group rows themselves: one group per model prefix, one
 * row per request parameter, values entered as JSON, problems row-aligned
 * from parseGroups. Purely presentational (edits go through onChange). Since
 * the table redesign this renders inside the matcher editor overlay only,
 * one group at a time (the enclosing draft still owns the full group list).
 * The prefix placeholder and help are required props because the two
 * surfaces genuinely differ: global keys may lead with a base URL to scope
 * to one server, entry keys are already scoped and match model IDs only, so
 * a URL prefix there would never match. The parameter-name and value help
 * stay shared; they are scope-agnostic.
 */
function ParamGroupsFields({
	groups,
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
	groups: readonly PrefixGroup[];
	problems: readonly GroupProblems[];
	/** Row-aligned non-blocking notes from the same parse (the _force semantic warnings). */
	hints?: readonly GroupHints[] | undefined;
	disabled?: boolean | undefined;
	prefixPlaceholder: string;
	prefixHelp: string;
	/** Suggestions for the prefix and parameter-name inputs' listboxes; absent, the inputs stay plain. */
	prefixSuggestions?: readonly string[] | undefined;
	paramNameSuggestions?: readonly string[] | undefined;
	onChange: (next: PrefixGroup[]) => void;
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
	const patchGroup = (index: number, patch: Partial<PrefixGroup>) => {
		onChange(groups.map((group, i) => (i === index ? { ...group, ...patch } : group)));
	};
	const focusHold = useFocusedRow(groups);
	const keyFreeze = useKeyTrackFreeze(groups);
	return (
		<>
			{groups.map((group, groupIndex) => {
				// The group's `_force` marks, derived once per render from the same
				// rows the checkboxes rewrite, so box state and row text cannot drift.
				const forcedFields = directiveMarkedFields(group, FORCE_DIRECTIVE);
				// The control-backed directive rows the grid absorbs: the Inherits
				// select and the per-row checkboxes are their single representation.
				// A row those controls cannot fully display - an unreadable value, a
				// duplicate key, or a hinted stranded entry - stays visible and
				// editable, and a row being typed in absorbs only on blur.
				const rowAbsorbed = (index: number): boolean =>
					!focusHold.focused(groupIndex, index) &&
					directiveRowAbsorbed(group, index, PARAM_FLAG_DIRECTIVES) &&
					(group.params[index]?.key.trim() === INHERIT_FROM_DIRECTIVE ||
						hints?.[groupIndex]?.params[index] === undefined);
				const inheritFromIndex = group.params.findIndex((param) => param.key.trim() === INHERIT_FROM_DIRECTIVE);
				// The grid's column heads label rendered rows; an empty group keeps
				// just the add action instead of heads over nothing.
				const anyRowVisible = group.params.some((_, index) => !rowAbsorbed(index));
				// Rows are positional while being edited; the index is the identity.
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: groups are positional while being edited; the index is the identity
					<div className="group" key={groupIndex}>
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
									invalid={problems[groupIndex]?.prefix !== undefined}
									placeholder={prefixPlaceholder}
									ariaLabel={l10n.t("Matcher")}
									disabled={inert}
									onValue={(next) => patchGroup(groupIndex, { prefix: next })}
									onEnter={onEnter}
								/>
							</div>
							{group.prefix.trim().length > 0 ? (
								<span className="matcher-kind">{matcherKindLabel(matcherKind(group.prefix))}</span>
							) : null}
							{problems[groupIndex]?.prefix !== undefined ? (
								<span className="error">{problems[groupIndex]?.prefix}</span>
							) : null}
						</div>
						<div className="editor-section">
							<InheritFromControl
								group={group}
								disabled={disabled === true}
								hint={
									inheritFromIndex >= 0 && rowAbsorbed(inheritFromIndex)
										? hints?.[groupIndex]?.params[inheritFromIndex]
										: undefined
								}
								onChange={(next) => onChange(groups.map((g, i) => (i === groupIndex ? next : g)))}
							/>
						</div>
						<div className="editor-section">
							<span className="editor-label">{l10n.t("Fields")}</span>
							<div
								className="rows"
								style={keyFreeze.style}
								onFocusCapture={keyFreeze.onFocusCapture}
								onBlurCapture={keyFreeze.onBlurCapture}
							>
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
									const removeLabel =
										param.key.trim().length > 0 ? l10n.t('Remove "{0}"', param.key.trim()) : l10n.t("Remove");
									const rowProblem = problems[groupIndex]?.params[paramIndex]?.message;
									const rowHint = hints?.[groupIndex]?.params[paramIndex];
									return (
										// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional while being edited (see useFocusedRow); the index is the identity
										<div className="row" key={paramIndex} {...focusHold.rowFocusProps(groupIndex, paramIndex)}>
											{/* The stacked tier's per-cell labels (painted only there;
											    dashboard.css .cell-label): the column heads above label
											    TRACKS, and once the rows stack there are no tracks left
											    to label - each field names itself instead, keeping the
											    column help reachable per cell. The word is aria-hidden
											    (the input already carries it as its accessible name, so
											    AT would hear it twice); the help button stays exposed. */}
											<span className="cell-label">
												<span aria-hidden="true">{l10n.t("Parameter")}</span>
												<Help text={helpModelParameterName()} />
											</span>
											<span className="cell key">
												<SuggestInput
													value={param.key}
													suggestions={paramNameSuggestions ?? []}
													inputClass="key"
													invalid={problems[groupIndex]?.params[paramIndex]?.field === "name"}
													placeholder={l10n.t("Parameter, e.g. temperature")}
													ariaLabel={l10n.t("Parameter")}
													disabled={inert}
													onValue={(next) =>
														patchGroup(groupIndex, {
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
													aria-invalid={problems[groupIndex]?.params[paramIndex]?.field === "value"}
													aria-label={l10n.t("Value")}
													placeholder={l10n.t("JSON value, e.g. 0.2")}
													value={param.valueText}
													disabled={inert}
													onChange={(event) =>
														patchGroup(groupIndex, {
															params: group.params.map((p, i) =>
																i === paramIndex ? { ...p, valueText: event.currentTarget.value } : p
															),
														})
													}
													onKeyDown={onKeyDown}
												/>
											</span>
											{/* The per-row force/inheritable marks in their own fixed grid
										    column, before the row action, so the boxes align down the
										    card. Directive rows (_force, _inheritable, ...) carry no
										    flag checkboxes - a directive cannot be forced or inherited
										    - and unnamed rows have no key to mark yet; unforceable keys
										    keep the box visible but disabled, with the help naming
										    why. */}
											{param.key.trim().startsWith("_") || param.key.trim().length === 0 ? null : (
												<span className="cell directive-flag">
													<label>
														<Checkbox
															aria-label={l10n.t('Force "{0}"', param.key.trim())}
															checked={forcedFields.has(param.key.trim())}
															disabled={inert || !directiveEligible(FORCE_DIRECTIVE, param.key.trim())}
															onChange={(event) =>
																onChange(
																	groups.map((g, i) =>
																		i === groupIndex
																			? toggleDirectiveField(
																					g,
																					FORCE_DIRECTIVE,
																					param.key.trim(),
																					event.currentTarget.checked
																				)
																			: g
																	)
																)
															}
														/>
														{l10n.t({
															message: "force",
															comment: [
																"Checkbox label on a parameter row; marks the value as forced over runtime options.",
															],
														})}
													</label>
													<Help
														text={
															directiveEligible(FORCE_DIRECTIVE, param.key.trim())
																? helpForceFlag()
																: helpForceFlagDisabled()
														}
													/>
													<InheritableFlag
														group={group}
														groupIndex={groupIndex}
														groups={groups}
														fieldKey={param.key.trim()}
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
												onClick={() =>
													patchGroup(groupIndex, { params: group.params.filter((_, i) => i !== paramIndex) })
												}
											>
												<IconTrash />
											</Button>
											{/* The row's one status line, reserved whether or not it
										    speaks (dashboard.css .row .row-status; the record rows'
										    .record-status idiom): the verdict lands per keystroke,
										    and mounted only alongside a problem it pushed the rows
										    below down 17px on the first bad character. Worst first,
										    one message at a time - a problem outranks a hint. */}
											<span
												className={cn(
													"row-status",
													rowProblem !== undefined ? "error" : rowHint !== undefined && "hint"
												)}
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
								onClick={() => patchGroup(groupIndex, { params: [...group.params, { key: "", valueText: "" }] })}
							>
								<IconAdd /> {l10n.t("Add parameter")}
							</Button>
						</div>
					</div>
				);
			})}
		</>
	);
}

/**
 * How many server-observed names the suggestion list carries: discovery
 * already caps the observed set at 512 keys per server so a hostile payload
 * cannot balloon what rides on it, and the cross-server union gets the same
 * ceiling here - the list is RENDERED per keystroke, and the catalog
 * dropdown's host-side cap sets the posture.
 */
const OBSERVED_SUGGESTION_LIMIT = 512;

/**
 * The key suggestions the capability rows offer: the consumed vocabulary (the
 * registration-typed core first, then the advisory-typed cost/caching/params
 * keys in their curated order), then the server-observed /model/info key
 * names (deduped, code-unit sorted - wire identifiers), with the directives
 * at the end. Suggestions only - the vocabulary is open, and any other key
 * applies as-is. The observed names are server-derived strings: they render
 * as suggestion TEXT only (SuggestInput), never become object keys (the Set
 * dedup), and `_`-led names are dropped - a capability record reads such a
 * key as a directive, never as an override, so suggesting one would suggest
 * a key the record cannot carry (a server-reported `__proto__` falls out
 * here too).
 */
export function capabilityKeySuggestions(observedKeys?: readonly string[]): readonly string[] {
	const consumed = Object.keys(CONSUMED_CAPABILITY_FIELDS);
	const known = new Set(consumed);
	const observed = [...new Set(observedKeys ?? [])]
		.filter((key) => key.length > 0 && !key.startsWith("_") && !known.has(key))
		.sort()
		.slice(0, OBSERVED_SUGGESTION_LIMIT);
	return [...consumed, ...observed, FALLBACK_DIRECTIVE, OPENROUTER_MODEL_DIRECTIVE];
}

/** The no-evidence list (consumed fields plus directives), the fallback wherever no observed set is known. */
const CAPABILITY_KEY_SUGGESTIONS: readonly string[] = capabilityKeySuggestions();

/**
 * A text input with its own suggestion listbox, replacing the native datalist
 * (which the webview host renders all-bold and unstylable). The combobox
 * pattern the catalog picker set: typing filters the suggestions
 * (case-insensitive substring), arrows move the highlight, Enter accepts it,
 * Escape closes, blur closes, mousedown picks. Enter WITHOUT a highlighted
 * suggestion falls through to `onEnter` (the editors' Enter-apply), so
 * accepting a suggestion can never double as Apply on a half-typed row.
 */
function SuggestInput({
	value,
	suggestions,
	inputClass,
	invalid,
	placeholder,
	ariaLabel,
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
 * What input a capability row's value takes, keyed off the consumed
 * vocabulary and the directives: token counts get number inputs, costs get
 * decimal number inputs (0 is "free"), support flags get checkboxes, and
 * everything else - string-array consumed fields included - falls back to
 * JSON text (the vocabulary is open, so unknown keys stay free-form).
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
 * What an HTML number input can DISPLAY, the spec's "valid floating-point
 * number" grammar: an optional minus, digits with an optional dot-and-digits
 * fraction (or a bare .5 fraction), an optional exponent. Anything else -
 * hex, whitespace, a trailing dot - is sanitized to a blank control, so it
 * must keep the raw text input instead. Tested against the UNTRIMMED text:
 * the control renders the text exactly as it is.
 */
const NUMBER_INPUT_TEXT = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * The control a capability row actually renders: the key's typed control only
 * while the current text fits it, raw JSON text otherwise. Invalid values are
 * deliberately preserved (the parse hints, the resolver diagnoses at
 * resolution), and a typed control would misrepresent them - a number input
 * displays a stored `"free"` as blank, a checkbox reads a stored `1` as
 * unchecked - so the row falls back to the free-form input that shows the
 * text as it is.
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
 * The `_openrouter_model` value input with its catalog search: typing posts a
 * debounced searchCatalog request, and the bounded result list renders under
 * the input; picking an entry writes its ID into the row. Only summaries
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
 * The model-capability group rows, ParamGroupsFields' typed sibling: one
 * group per model prefix, one row per capability field or directive. The
 * value control follows the key - token counts get number inputs, support
 * flags get checkboxes, `_openrouter_model` gets the catalog
 * picker, and anything else falls back to JSON text with the unknown-key
 * hint parseCapabilityGroups computed. Purely presentational, over the
 * issues from the same parse that judges the enclosing form.
 */
function CapabilityGroupsFields({
	groups,
	issues,
	disabled,
	prefixSuggestions,
	keySuggestions,
	onChange,
	onEnter,
}: {
	groups: readonly PrefixGroup[];
	issues: readonly CapabilityGroupIssues[];
	disabled?: boolean | undefined;
	/** Suggestions for the matcher input's listbox; absent, the input stays plain. */
	prefixSuggestions?: readonly string[] | undefined;
	/** The capability-name suggestions (capabilityKeySuggestions); absent, the no-evidence static list serves. */
	keySuggestions?: readonly string[] | undefined;
	onChange: (next: PrefixGroup[]) => void;
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
	const patchGroup = (index: number, patch: Partial<PrefixGroup>) => {
		onChange(groups.map((group, i) => (i === index ? { ...group, ...patch } : group)));
	};
	const focusHold = useFocusedRow(groups);
	const keyFreeze = useKeyTrackFreeze(groups);
	return (
		<>
			{groups.map((group, groupIndex) => {
				// The group's `_fallback` marks, derived once per render from the
				// rows the checkboxes rewrite.
				const fallbackFields = directiveMarkedFields(group, FALLBACK_DIRECTIVE);
				// The control-backed directive rows the grid absorbs, the parameters
				// editor's rule with this editor's own flag set. What keeps a
				// directive row visible is structural - directiveRowAbsorbed's
				// eligible-row check: a `_fallback`/`_inheritable` list entry naming
				// no field row has no checkbox to display it, so the row stays. The
				// hint clause is only a backstop on top (a hinted row must stay to
				// show its hint); with the open vocabulary every hinted list entry
				// already fails the eligible check, so no row's visibility rides on
				// a hint that evidence could suppress.
				const rowAbsorbed = (index: number): boolean =>
					!focusHold.focused(groupIndex, index) &&
					directiveRowAbsorbed(group, index, CAPABILITY_FLAG_DIRECTIVES) &&
					(group.params[index]?.key.trim() === INHERIT_FROM_DIRECTIVE ||
						issues[groupIndex]?.rows[index]?.hint === undefined);
				const inheritFromIndex = group.params.findIndex((param) => param.key.trim() === INHERIT_FROM_DIRECTIVE);
				// The grid's column heads label rendered rows; an empty group keeps
				// just the add action instead of heads over nothing.
				const anyRowVisible = group.params.some((_, index) => !rowAbsorbed(index));
				// Rows are positional while being edited; the index is the identity.
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: groups are positional while being edited; the index is the identity
					<div className="group" key={groupIndex}>
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
									invalid={issues[groupIndex]?.prefix !== undefined}
									placeholder={l10n.t("Model ID or matcher, e.g. gpt-4 or gpt-4*")}
									ariaLabel={l10n.t("Matcher")}
									disabled={inert}
									onValue={(next) => patchGroup(groupIndex, { prefix: next })}
									onEnter={onEnter}
								/>
							</div>
							{group.prefix.trim().length > 0 ? (
								<span className="matcher-kind">{matcherKindLabel(matcherKind(group.prefix))}</span>
							) : null}
							{issues[groupIndex]?.prefix !== undefined ? (
								<span className="error">{issues[groupIndex]?.prefix}</span>
							) : null}
						</div>
						<div className="editor-section">
							<InheritFromControl
								group={group}
								disabled={disabled === true}
								hint={
									inheritFromIndex >= 0 && rowAbsorbed(inheritFromIndex)
										? issues[groupIndex]?.rows[inheritFromIndex]?.hint
										: undefined
								}
								onChange={(next) => onChange(groups.map((g, i) => (i === groupIndex ? next : g)))}
							/>
						</div>
						<div className="editor-section">
							<span className="editor-label">{l10n.t("Fields")}</span>
							<div
								className="rows"
								style={keyFreeze.style}
								onFocusCapture={keyFreeze.onFocusCapture}
								onBlurCapture={keyFreeze.onBlurCapture}
							>
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
									const issue = issues[groupIndex]?.rows[paramIndex];
									const key = param.key.trim();
									const kind = capabilityControlKind(key, param.valueText);
									const numberProps = kind === "number" || kind === "cost" ? numberInputProps(kind) : undefined;
									const removeLabel = key.length > 0 ? l10n.t('Remove "{0}"', key) : l10n.t("Remove");
									const patchRow = (patch: Partial<{ key: string; valueText: string }>) =>
										patchGroup(groupIndex, {
											params: group.params.map((p, i) => (i === paramIndex ? { ...p, ...patch } : p)),
										});
									return (
										// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional while being edited (see useFocusedRow); the index is the identity
										<div className="row" key={paramIndex} {...focusHold.rowFocusProps(groupIndex, paramIndex)}>
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
													disabled={inert}
													onValue={(nextKey) => {
														// A row just switched onto a support flag means "turn it
														// on"; seeding true keeps the checkbox and the parse in
														// agreement without an extra click.
														const seedsTrue =
															capabilityValueKind(nextKey.trim()) === "boolean" && param.valueText.trim().length === 0;
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
														onChange={(event) =>
															patchRow({ valueText: event.currentTarget.checked ? "true" : "false" })
														}
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
											{/* The per-row fallback/inheritable marks in the shared fixed
										    flag column, before the row action like the parameter
										    editor's force mark. The vocabulary is open, so every
										    non-directive field carries the fallback box - the
										    resolver's `_fallback` accepts any field the record sets,
										    known or not. */}
											{directiveEligible(FALLBACK_DIRECTIVE, key) ? (
												<span className="cell directive-flag">
													<label>
														<Checkbox
															aria-label={l10n.t('Fall back for "{0}"', key)}
															checked={fallbackFields.has(key)}
															disabled={inert}
															onChange={(event) =>
																patchGroup(
																	groupIndex,
																	toggleDirectiveField(group, FALLBACK_DIRECTIVE, key, event.currentTarget.checked)
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
													<InheritableFlag
														group={group}
														groupIndex={groupIndex}
														groups={groups}
														fieldKey={key}
														disabled={inert}
														onChange={onChange}
													/>
												</span>
											) : null}
											<Button
												variant="danger"
												size="compact"
												aria-label={removeLabel}
												title={removeLabel}
												disabled={inert}
												onClick={() =>
													patchGroup(groupIndex, { params: group.params.filter((_, i) => i !== paramIndex) })
												}
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
								onClick={() => patchGroup(groupIndex, { params: [...group.params, { key: "", valueText: "" }] })}
							>
								<IconAdd /> {l10n.t("Add capability")}
							</Button>
						</div>
					</div>
				);
			})}
		</>
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
 * Hand-curated, mirroring the "Common parameters" list in
 * docs/models.md#where-parameters-come-from: the extension has no canonical
 * parameter inventory (pass-through by design; only reasoning_effort is
 * schema-declared), so these are suggestions, never a restriction.
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
 * A row's short reading of its `_inherit_from` state, or nothing at all where
 * the group takes the default. The default is what a record does when nobody
 * said otherwise, so printing it on every row would be one noisy word per
 * line saying "nothing to see"; the mark appears exactly where a choice was
 * made.
 */
function InheritsSummary({ group }: { group: PrefixGroup }) {
	const choice = inheritFromChoice(group);
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

/** The flag badges one field chip carries, derived from the same rows the toggles rewrite. */
function chipFlags(kind: RecordEditorKind, group: PrefixGroup, key: string): string[] {
	const flags: string[] = [];
	if (kind === "params" && directiveMarkedFields(group, FORCE_DIRECTIVE).has(key)) {
		flags.push(forceWord());
	}
	if (kind === "caps" && directiveMarkedFields(group, FALLBACK_DIRECTIVE).has(key)) {
		flags.push(fallbackWord());
	}
	if (directiveMarkedFields(group, INHERITABLE_DIRECTIVE).has(key)) {
		flags.push(inheritableWord());
	}
	return flags;
}

/** The flag directives each editor's chips may absorb; the checkbox sets, unchanged. */
function flagDirectivesFor(kind: RecordEditorKind): readonly FieldDirective[] {
	return kind === "params" ? PARAM_FLAG_DIRECTIVES : CAPABILITY_FLAG_DIRECTIVES;
}

/**
 * The row indices a group renders as chips: everything except the directive
 * rows the table's own surfaces fully represent (the Inherits column for
 * `_inherit_from`, the chips' flag badges for the checkbox directives), per
 * the same directiveRowAbsorbed contract the row grid uses - a directive the
 * controls cannot fully show keeps a raw chip. A row the open popover is
 * editing stays pinned visible, so absorption can never unmount the popover
 * mid-keystroke (the focused-row hold, in table form).
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
			const key = group.params[index]?.key.trim() ?? "";
			// The pin compares RAW, like the popover identity it serves.
			if (pinnedKey !== undefined && group.params[index]?.key === pinnedKey) {
				return true;
			}
			const absorbed =
				directiveRowAbsorbed(group, index, flagDirectivesFor(kind)) &&
				(key === INHERIT_FROM_DIRECTIVE || issueRows[index]?.hint === undefined);
			return !absorbed;
		});
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
		index === groupIndex ? { ...group, params: [...group.params, row] } : group
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
 * The chip popovers' shared shell: hover-widget chrome anchored under its
 * chip, focus moved to the first control on open and returned to the opener
 * on close, Escape and any press outside the chip's anchor closing. Escape
 * stops propagating so a popover inside the matcher editor overlay (or the
 * server form's slide-over) closes only itself. It flips above its anchor
 * rather than hang past the viewport's bottom edge.
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
	// Whether the popover hangs above its anchor instead of below it. Decided
	// by measurement, not at click time: its height is not known until it
	// renders, and both it and the room under it change while open - a flag
	// row appears, an invalid value adds an error line, the reader scrolls -
	// so a popover that opened on-screen can end up over the edge with
	// nothing to scroll it back.
	const [above, setAbove] = useState(false);
	useLayoutEffect(() => {
		const popover = ref.current;
		if (popover === null) {
			return;
		}
		const measure = () => {
			// The box the CSS positions against (the chip anchor, or the row's
			// field list inside a slide-over): flipping moves the popover to
			// exactly this box's top edge, so the room above and below is its
			// own. Read per measurement rather than once: under happy-dom
			// there is no offsetParent and no layout to reason about, which is
			// a reason to measure nothing, not to stop watching.
			const host = popover.offsetParent;
			if (!(host instanceof HTMLElement)) {
				return;
			}
			const hostRect = host.getBoundingClientRect();
			const rect = popover.getBoundingClientRect();
			// Where it WOULD end up hanging below, not where it sits now: a
			// flipped popover no longer overflows, so measuring its current
			// bottom would clear the flip the instant it worked and leave the
			// popover flicking over the edge and back on every change.
			const bottomIfBelow = hostRect.bottom + POPOVER_GAP_PX + rect.height;
			// And only when there is more room the other way: flipping
			// something that overflows both edges just moves the clipped part.
			setAbove(bottomIfBelow > window.innerHeight && hostRect.top > window.innerHeight - hostRect.bottom);
		};
		measure();
		// Three things move the popover relative to the edge and none of them
		// implies the others: its own content resizing, the reader scrolling
		// it down there (capture, because the server form's panel is its own
		// scrollport and its scroll does not bubble), and the window resizing
		// under all of it.
		const observer = new ResizeObserver(measure);
		observer.observe(popover);
		window.addEventListener("scroll", measure, { capture: true, passive: true });
		window.addEventListener("resize", measure, { passive: true });
		return () => {
			observer.disconnect();
			window.removeEventListener("scroll", measure, { capture: true });
			window.removeEventListener("resize", measure);
		};
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
 * The small anchored editor behind a field chip: the value control, the
 * row's flag toggles, and Remove field. Edits write straight into the draft
 * (the chip and table stay live; the owner's Apply/Save remains the only
 * write path). The popover is addressed by the row's KEY, so a flag toggle
 * that inserts or removes a directive row can never shift it onto another
 * field.
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
	const key = row.key.trim();
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
	const forcedFields = directiveMarkedFields(group, FORCE_DIRECTIVE);
	const fallbackFields = directiveMarkedFields(group, FALLBACK_DIRECTIVE);
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
													? toggleDirectiveField(g, FORCE_DIRECTIVE, key, event.currentTarget.checked)
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
													? toggleDirectiveField(g, FALLBACK_DIRECTIVE, key, event.currentTarget.checked)
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
						group={group}
						groupIndex={groupIndex}
						groups={groups}
						fieldKey={key}
						disabled={disabled}
						onChange={onChange}
					/>
				</div>
			) : null}
			{/* The one status line, in reserved space AFTER the actions: the verdict
			    re-renders per keystroke, and mounted between the flags and the
			    actions it shoved Remove field 19px down under the pointer on the
			    first bad character (the charter's transients-never-move-anything
			    clause). Worst first, one message at a time - a problem outranks a
			    hint, and the slot is sized for one line (chip-popover-status). */}
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
 * The [+] chip's popover: a complete field is assembled locally (key, value,
 * flags) and lands in the draft as ONE commit, so half-typed rows never leak
 * into the table. Validation runs the target parser over the candidate row
 * on every keystroke - the popover cannot accept what the editor would then
 * block.
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
	const trimmed = key.trim();
	const problem = trimmed.length === 0 ? undefined : candidateProblem(kind, groups, groupIndex, { key, valueText });
	const canAdd = trimmed.length > 0 && problem === undefined;
	const valueKind = kind === "caps" ? capabilityControlKind(trimmed, valueText) : "json";
	const numberProps = valueKind === "number" || valueKind === "cost" ? numberInputProps(valueKind) : undefined;
	const setKeyAndSeed = (nextKey: string) => {
		setKey(nextKey);
		// A key switched onto a support flag means "turn it on" (the row grid's
		// seeding rule, so the checkbox and the parse agree without a click).
		if (kind === "caps" && capabilityValueKind(nextKey.trim()) === "boolean" && valueText.trim().length === 0) {
			setValueText("true");
		}
	};
	// What the group's directive rows would already mark on the candidate once
	// its row lands (simulated with the row appended, so a literal true's
	// expansion sees the new key).
	const candidateRow = { key: trimmed, valueText };
	const withCandidate: PrefixGroup = { ...group, params: [...group.params, candidateRow] };
	const impliedFlag = (flag: FieldDirective): boolean => directiveMarkedFields(withCandidate, flag).has(trimmed);
	const flagChecked = (flag: FieldDirective): boolean => flagOverrides[flag] ?? impliedFlag(flag);
	const toggleLocalFlag = (flag: FieldDirective, enabled: boolean) =>
		setFlagOverrides((current) => ({ ...current, [flag]: enabled }));
	const commit = () => {
		if (!canAdd) {
			return;
		}
		let next = withCandidate;
		// Only explicit choices touch the directive rows, and only when they
		// change what the rows already say: an untouched box over a literal
		// `true` must never explode it into a list.
		for (const flag of [FORCE_DIRECTIVE, FALLBACK_DIRECTIVE, INHERITABLE_DIRECTIVE] as const) {
			const desired = flagOverrides[flag];
			if (desired === undefined || !directiveEligible(flag, trimmed)) {
				continue;
			}
			if (directiveMarkedFields(next, flag).has(trimmed) !== desired) {
				next = toggleDirectiveField(next, flag, trimmed, desired);
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
			{trimmed.length > 0 && !trimmed.startsWith("_") ? (
				<div className="chip-popover-flags">
					{kind === "params" ? (
						<>
							<label>
								<Checkbox
									aria-label={l10n.t('Force "{0}"', trimmed)}
									checked={flagChecked(FORCE_DIRECTIVE)}
									disabled={disabled || !directiveEligible(FORCE_DIRECTIVE, trimmed)}
									onChange={(event) => toggleLocalFlag(FORCE_DIRECTIVE, event.currentTarget.checked)}
								/>
								{forceWord()}
							</label>
							<Help text={directiveEligible(FORCE_DIRECTIVE, trimmed) ? helpForceFlag() : helpForceFlagDisabled()} />
						</>
					) : null}
					{/* Same open-vocabulary rule as the edit popover's fallback mark. */}
					{kind === "caps" && directiveEligible(FALLBACK_DIRECTIVE, trimmed) ? (
						<>
							<label>
								<Checkbox
									aria-label={l10n.t('Fall back for "{0}"', trimmed)}
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
							aria-label={l10n.t('Mark "{0}" inheritable', trimmed)}
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
 * The open chip popover: one per table, addressed by the group's MATCHER KEY
 * and the row's FIELD KEY, never by index - a state push (no draft pinned)
 * or a flag toggle may reorder or reshape the arrays under an open popover,
 * and index identity would silently retarget it onto another record. Keys
 * compare RAW (the resolver's grammar trims nothing, and trimmed identity
 * would transfer between "gpt-4" and "gpt-4 " on a reorder); the ordinals
 * disambiguate exact duplicates, which the parse blocks but the rows can
 * still represent.
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
 * The row index an open field popover is editing in `group`, resolved the way
 * chip identity is minted: the RAW key plus the occurrence ordinal among exact
 * duplicates. Undefined when no field popover is open on this group.
 */
function openFieldRowIndex(
	group: PrefixGroup,
	popover: ChipPopoverTarget | undefined,
	groupHere: (target: ChipPopoverTarget | undefined) => boolean
): number | undefined {
	if (popover?.kind !== "field" || !groupHere(popover)) {
		return undefined;
	}
	let seen = 0;
	for (let index = 0; index < group.params.length; index += 1) {
		if (group.params[index]?.key === popover.fieldKey) {
			if (seen === popover.ordinal) {
				return index;
			}
			seen += 1;
		}
	}
	return undefined;
}

/**
 * The compact matcher table both record editors and the server form render:
 * one row per matcher - the key, its inheritance, the fields as combined
 * chips, and the full-editor pencil. Rows display in precedence order,
 * lowest first (sortedGroupOrder; a VIEW order - the draft's storage order
 * is never rewritten). Chips open the small anchored popover; the pencil
 * asks the owner to open the full matcher editor overlay. With readOnly the
 * same table renders as a static display: plain chips, no edit affordances
 * (the other-scope records).
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
}: {
	kind: RecordEditorKind;
	groups: readonly PrefixGroup[];
	issues: readonly GroupIssueView[];
	/** Render as a static display: plain chips, no popovers, no add or edit actions (the other-scope records). */
	readOnly?: boolean;
	disabled?: boolean;
	/** The add popover's field-name suggestions; the capability vocabulary fills in for the caps kind. */
	keySuggestions?: readonly string[];
	onChange: (next: PrefixGroup[]) => void;
	/** The pencil action; the owner opens the full matcher editor overlay on this draft index. */
	onOpenEditor?: ((groupIndex: number) => void) | undefined;
}) {
	const [popover, setPopover] = useState<ChipPopoverTarget | undefined>(undefined);
	const tableId = useId();
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
		// A list whose rows share ONE internal grid: [matcher | field chips |
		// inherits | action], columns sized by the list so every row's cells
		// land at the same x - the rows inherit the tracks through subgrid, the
		// same construction the models list uses. The STRUCTURE (display, the
		// tracks, the cells' columns, and the sub-620px flex fallback) lives in
		// dashboard.css rather than in utilities here: dashboard.css sits in the
		// components layer UNDER utilities, so a `grid` utility on this element
		// would beat the stylesheet's narrow fallback no matter the query - one
		// layer, source order settles it.
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
				const openRowIndex = openFieldRowIndex(group, popover, groupHere);
				const rowProblem = (issueView?.rows ?? []).find(
					// Closed chips only: the open chip's popover already states its
					// own problem beside the input being fixed, and the same
					// sentence in two places at once reads as two problems.
					(row, rowIndex) => rowIndex !== openRowIndex && row?.problem !== undefined
				)?.problem?.message;
				return (
					// Rows are keyed by their MATCHER KEY plus occurrence (index
					// only for the empty edge): an index key would remount the row
					// when a state push reorders the record, dropping an open add
					// popover's half-typed field with it.
					<li
						className="record-row group/row -mx-2 rounded-md px-2 py-1.5 hover:bg-accent-soft focus-within:bg-accent-soft"
						key={`${groupKey}#${groupOrdinal}`}
					>
						{/* Shrinkable on purpose: the wide tier's grid ignores flex-shrink, and in
						    the sub-620px flex rows a max-content cell would carry a long regex key
						    past the pane; min-w-[104px] still floors the collapse. */}
						<span className="matcher-cell flex min-w-[104px] flex-wrap items-baseline gap-2">
							{/* The matcher wears the chip chrome OUTLINED where the field
							    chips are FILLED: one radius system, two fills - identity
							    reads as a container, data as contents. */}
							<code className="matcher-key rounded-sm border border-border px-1 font-mono text-[12px] text-foreground [overflow-wrap:anywhere]">
								{matcherName}
							</code>
							<span className="matcher-kind text-[11px] text-muted-foreground">
								{matcherKindLabel(matcherKind(group.prefix))}
							</span>
						</span>
						{/* min-w-min, not min-w-0: a zero floor let this box be squeezed
						    narrower than a single chip, and a chip cannot shrink to
						    match, so the chips overflowed and painted over the inherit
						    summary and the pencil after them - "force" and "inherits
						    nothing" ran together into one unreadable word. The floor is
						    one chip's own minimum; a chip wraps its own parts and its
						    key may break anywhere, so the floor is a chip's longest
						    UNBREAKABLE piece rather than its whole line, and `bun run
						    check-overflow` holds that.

						    No flex-item utilities (flex-1 and friends) on purpose: in
						    the grid the tracks own this cell's size, and under the 620px
						    fallback dashboard.css gives it a full line - a `flex-1`
						    utility here would sit in the utilities layer and beat that
						    stylesheet rule no matter what its query says.

						    One dormant consequence: dashboard.css used to carry a slide-over
						    adaptation for this list (a relative `.chip-list` as the chip
						    popover's containing block, so the popover could not clip past a
						    panel's left edge - clipped there it is unreachable, overflow
						    only scrolls rightward). It was deleted as dead during the layer
						    merge: nothing renders this table inside a slide-over. If a panel
						    ever hosts it again, the adaptation must be REBUILT, not
						    un-deleted, and it has two hazards to answer: the row's floor lets the
						    popover's containing block outgrow the panel and re-opens the
						    clipping, and a static anchor with no relatively positioned
						    ancestor resolves the popover against the FIXED panel itself, so
						    `top: 100%` drops it past the panel's bottom edge. */}
						<span className="chip-list flex min-w-min flex-wrap items-baseline gap-x-2 gap-y-1">
							{chips.map((rowIndex) => {
								const row = group.params[rowIndex];
								if (row === undefined) {
									return null;
								}
								const key = row.key.trim();
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
								// The hint said in words, before the popover opens: the amber
								// border is the only resting mark, and a border is invisible
								// to a screen reader - unlike a problem, whose message the
								// row prints as visible text below. A description rather
								// than part of the name, so the chip still announces as its
								// key and value first. The id only has to be unique on the
								// page and stable within a render; the indices do that.
								const hintId = issue?.hint !== undefined ? `${tableId}-hint-${groupIndex}-${rowIndex}` : undefined;
								// No forced-colors border suppression any more, deliberately:
								// when chips were quiet-at-rest the repainted transparent border
								// put an unearned hairline on every chip, but a FILLED chip's
								// fill is exactly what forced colours flatten into the page, so
								// the repainted border is now the only thing keeping "two chips"
								// from reading as one run of words. The transparent border
								// repaints to a visible system colour there and that is correct.
								const chipClass = cn(
									"chip-field inline-flex flex-wrap items-baseline gap-1.5 rounded-sm border border-transparent bg-chip px-1 font-mono text-[12px] text-muted-foreground",
									// Filled at rest - the frame makes these a bounded region
									// and the fill is what says "these are the fields"; the
									// hairline and the input fill still arrive with the
									// pointer or with focus, which is the moment the row has
									// to prove it is editable.
									editable &&
										"cursor-pointer group-hover/row:border-border group-hover/row:bg-input-background group-focus-within/row:border-border group-focus-within/row:bg-input-background hover:text-foreground focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
									catalog && "chip-catalog",
									openHere && "border-border bg-input-background text-foreground",
									// The marks come AFTER the open state on purpose: cn resolves
									// conflicting utilities last-wins, and with the order reversed
									// the open chip's border-border swallowed the invalid border -
									// the one chip being edited was the one without its mark. The
									// marks also restate the editable string's hover/focus-within
									// reveal variants, which are separate merge groups the plain
									// utility cannot beat: without them the row's hairline reveal
									// repainted the mark grey the moment the pointer arrived or
									// the popover took focus.
									issue?.hint !== undefined &&
										"hinted border-warn group-hover/row:border-warn group-focus-within/row:border-warn",
									// The border IS the whole mark - the child spans re-colour
									// every glyph, so no text tint would paint. The fill tier,
									// not --input-invalid: a 1px hairline is a graphical mark
									// needing 3:1, and the host's validation border measures
									// 1.33:1 on the dark chip fill.
									issue?.problem !== undefined &&
										"invalid border-err-fill group-hover/row:border-err-fill group-focus-within/row:border-err-fill"
								);
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
										{chipFlags(kind, group, key).map((flag) => (
											// The accent's readable label tier: a directive mark is
											// a permanent word at 11px on the chip fill, where the
											// raw hue measures 2.83:1.
											<span className="chip-flag text-[11px] text-accent-text" key={flag}>
												{flag}
											</span>
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
												aria-describedby={hintId}
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
										) : (
											<span className={chipClass}>{body}</span>
										)}
										{hintId !== undefined && issue?.hint !== undefined ? (
											<span id={hintId} className="visually-hidden">
												{issue.hint}
											</span>
										) : null}
										{openHere && popover !== undefined ? (
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
										className="chip-field chip-add rounded-sm border border-transparent px-1 text-muted-foreground group-hover/row:border-border group-focus-within/row:border-border hover:text-foreground focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
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
									{addOpen && popover !== undefined ? (
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
						<InheritsSummary group={group} />
						{editable ? (
							/* An auto inline-start margin keeps the pencil at the row's end
							   once the row wraps. It reads like an unconditional alignment
							   change and is not one: at wide widths the row is a subgrid of
							   .record-table, where the pencil sits in its own max-content
							   track (justify-self: end) and the chip list's minmax(0, 1fr)
							   track consumes the free space, so there is no free space for
							   the margin to take and the pencil lands wherever the track
							   puts it, with or without this. It acts only under the
							   sub-620px flex fallback, where the row wraps and without it
							   the pencil lands mid-line: measured 161px and 255px in from
							   the end on two rows while their unwrapped siblings sat at the
							   row's end.

							   The vocabulary it states: a row's action sits at the row's END,
							   at the same distance, whatever the content does. This is the
							   only row that wraps, so it is the only one that needs saying in
							   a margin - the model and server rows hold their actions in a
							   reserved final track and cannot wrap at all.

							   ms- rather than ml-: the row is a flex line, so the margin
							   belongs to the main axis, and a physical left margin points the
							   wrong way the moment the document is RTL. No RTL bundle ships
							   today, which is exactly why it is worth spelling correctly now
							   rather than discovering it later.

							   It survives the bordered modes only because their hand-back
							   reset zeroes a custom property rather than the margin itself
							   (ui/button.tsx); a blanket margin-inline: 0 flattened this
							   push in exactly the modes that draw the box it aligns. */
							<Button
								variant="secondary"
								size="compact"
								className="edit-cell ms-auto shrink-0"
								aria-label={l10n.t('Open the full editor for "{0}"', matcherName)}
								disabled={disabled}
								onClick={() => onOpenEditor?.(groupIndex)}
							>
								<IconEdit />
							</Button>
						) : null}
						{/* The row's one status line, reserved whether or not it speaks
						    (dashboard.css .record-status): the verdict lands per keystroke
						    from the open popover, and a line mounted only alongside a
						    problem grew the page 17px on the first bad character. Worst
						    first, one message at a time - the matcher's own problem
						    outranks a field's, and the chip's red border still says
						    WHERE while this line says what. */}
						<span
							className={cn(
								"record-status basis-full text-[11.5px]",
								(issueView?.prefix ?? rowProblem) !== undefined && "error"
							)}
						>
							{issueView?.prefix ?? rowProblem}
						</span>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * The full matcher editor, an in-place overlay on the same slide-over
 * machinery the model inspectors use: matcher input, the Inherits control,
 * every field row with its flags, Add parameter/capability, and Remove
 * matcher. It edits the same draft the table renders - closing commits
 * nothing and loses nothing; the owner's Apply/Save remains the only write
 * path. Focus returns to the opening pencil on close (the slide-over's own
 * restore), with `fallbackFocusId` covering a pencil the removal deleted.
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
	// The editors render exactly one group and every change carries it; group
	// removal goes through the footer's onRemove, never an emptied list.
	const onGroupsChange = (next: PrefixGroup[]) => {
		const first = next[0];
		if (first !== undefined) {
			onChange(first);
		}
	};
	return (
		<SlideOver labelledBy={titleId} fallbackFocusId={fallbackFocusId} onRequestClose={onClose}>
			<div className="matcher-editor">
				<h3 id={titleId}>{kind === "params" ? l10n.t("Edit parameter matcher") : l10n.t("Edit capability matcher")}</h3>
				<p className="hint">{note}</p>
				{kind === "params" ? (
					<ParamGroupsFields
						groups={[group]}
						problems={groupProblems !== undefined ? [groupProblems] : []}
						hints={groupHints !== undefined ? [groupHints] : undefined}
						disabled={disabled}
						prefixPlaceholder={prefixPlaceholder ?? l10n.t("Model ID or matcher, e.g. gpt-4 or gpt-4*")}
						prefixHelp={prefixHelp ?? helpModelParameterPrefix()}
						prefixSuggestions={prefixSuggestions}
						paramNameSuggestions={keySuggestions}
						onChange={onGroupsChange}
						onEnter={onEnter}
					/>
				) : (
					<CapabilityGroupsFields
						groups={[group]}
						issues={groupIssues !== undefined ? [groupIssues] : []}
						disabled={disabled}
						prefixSuggestions={prefixSuggestions}
						keySuggestions={keySuggestions}
						onChange={onGroupsChange}
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
 * The settings editors' overlay target, resolved to a draft index
 * SYNCHRONOUSLY on every render: a pristine state push may reorder or remove
 * groups under an open overlay, and a stored index would hand the render
 * between the push and any effect a stale target - one keystroke there would
 * edit the wrong record. Identity is the RAW matcher key (never trimmed,
 * matching the resolver's grammar) plus an occurrence ordinal for exact
 * duplicates; a rename typed inside the overlay refreshes the captured key
 * through trackRename. The effect below only clears the state once the
 * target is unresolvable, so a key that later REAPPEARS cannot resurrect a
 * long-closed overlay.
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
 * Structured editor for litellm-vscode-chat.models.parameters, the
 * object-of-objects the native Settings GUI cannot edit: one group per model
 * prefix, one row per request parameter, values entered as JSON. Edits apply
 * to one configuration scope; other scopes render read-only below.
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
	// opens directly, a create request appends the draft group first. Inert
	// while the JSON view is open (rewriting a JSON draft would lose text).
	// Keyed on the request's seq so repeating the same jump re-opens.
	const externalSeq = external?.seq;
	const jsonOpen = json !== undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on the request seq alone so repeating the jump re-opens; the draft, groups, and editor are read at fire time
	useEffect(() => {
		if (external === undefined || externalSeq === undefined || jsonOpen) {
			return;
		}
		const index = groups.findIndex((group) => group.prefix.trim() === external.key);
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
						<textarea
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
						{jsonParse !== undefined && !jsonParse.ok ? <p className="error">{jsonParse.problem}</p> : null}
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
							/>
						) : null}
					</>
				)}
				<FailureNote failure={draft.failure} dirty={draft.dirty} />
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
				return (
					<div className="other-scope" key={other.scope}>
						<OtherScopeNote scope={other.scope} />
						<div className="record-frame">
							<RecordMatcherTable
								kind="params"
								groups={otherGroups}
								issues={paramIssueViews(otherGroups, otherParse.ok ? [] : otherParse.problems, otherParse.hints)}
								readOnly
								onChange={() => undefined}
							/>
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
 * Structured editor for litellm-vscode-chat.models.capabilities, the
 * parameters editor's typed sibling (two-management-paths parity: everything
 * the server form's per-entry section can edit, editable globally too). Same
 * draft-and-apply model over the capability parse; edits land through the
 * setModelCapabilities intent.
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
	 * The cross-server union of observed /model/info keys
	 * (DashboardState.observedModelInfoKeys), serving two roles: the
	 * unknown-key hints' evidence, and the server half of the key
	 * autocomplete (capabilityKeySuggestions). The global records scope over
	 * every server, so the union is the right set for both. Absent or empty
	 * means no evidence - every such hint stays suppressed (the host's
	 * advisory filter, run live as the user types) and the suggestions fall
	 * back to the static vocabulary.
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
		const index = groups.findIndex((group) => group.prefix.trim() === external.key);
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
						<textarea
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
						{jsonParse !== undefined && !jsonParse.ok ? <p className="error">{jsonParse.problem}</p> : null}
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
							/>
						) : null}
					</>
				)}
				<FailureNote failure={draft.failure} dirty={draft.dirty} />
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
				return (
					<div className="other-scope" key={other.scope}>
						<OtherScopeNote scope={other.scope} />
						<div className="record-frame">
							<RecordMatcherTable
								kind="caps"
								groups={otherGroups}
								issues={capabilityIssueViews(otherGroups, otherParse.issues)}
								readOnly
								onChange={() => undefined}
							/>
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
