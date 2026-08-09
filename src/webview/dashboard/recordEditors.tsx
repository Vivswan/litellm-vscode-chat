import * as l10n from "@vscode/l10n";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type {
	DashboardModel,
	ExtensionToWebviewMessage,
	ScopedRecordSetting,
	SettingScope,
	TransportErrorClassification,
} from "../../extension/dashboard/protocol";
import {
	CAPABILITY_FIELDS,
	FALLBACK_DIRECTIVE,
	FORCE_DIRECTIVE,
	INHERIT_FROM_DIRECTIVE,
	INHERITABLE_DIRECTIVE,
	OPENROUTER_MODEL_DIRECTIVE,
	settingScopeLabel,
} from "../../extension/dashboard/protocol";
import type {
	CapabilityGroupIssues,
	FieldDirective,
	GroupHints,
	GroupProblems,
	PrefixGroup,
} from "../../extension/dashboard/recordDraft";
import {
	capabilityGroupsFromJsonText,
	directiveEligible,
	directiveMarkedFields,
	directiveRowAbsorbed,
	groupsFromJsonText,
	inheritFromChoice,
	parseCapabilityGroups,
	parseGroups,
	setInheritFromChoice,
	toCapabilityGroups,
	toGroups,
	toggleDirectiveField,
} from "../../extension/dashboard/recordDraft";
import type { IntentAck } from "./app";
import { DOCS_LINK_MODEL_CAPABILITIES, DOCS_LINK_MODEL_PARAMETERS } from "./docsLinks";
import { FailureText } from "./failureText";
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
import { IconAdd, IconBraces, IconTrash } from "./icons";
import { newRequestId, postMessage } from "./vscodeApi";

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
 * on an editor heading: rests visible like the docs link beside it (an h3 has
 * no hover band to reveal from).
 */
function HeadingRevealButton({
	title,
	settingId,
}: {
	title: string;
	settingId: "models.parameters" | "models.capabilities";
}) {
	return (
		<button
			type="button"
			class="quiet reveal-json"
			aria-label={l10n.t("Open {0} in settings.json", title)}
			onClick={() => postMessage({ type: "revealSetting", setting: settingId })}
		>
			<IconBraces />
		</button>
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
 * dirty draft wins until Apply or Discard. Apply posts an intent tagged with
 * a requestId and waits for its own correlated ack: intentSucceeded resolves
 * the phase (the Saved note), intentFailed returns the draft to a dirty,
 * retryable state. An acked draft keeps rendering until the store push that
 * reflects the write arrives (dropping it at the ack would flash the
 * pre-apply value for the one frame before that push); should that push
 * outrun the ack, the acked draft simply holds its value-equal rows until
 * the next store change.
 */
function useDraftRows<T>(
	external: T,
	ack: IntentAck | undefined,
	failure: IntentFailure | undefined
): {
	rows: T;
	dirty: boolean;
	phase: DraftPhase;
	/** Whether a draft of any kind is live (dirty, in flight, or acked awaiting the reflecting push). */
	pinned: boolean;
	/** The reported failure of THIS draft's own write; a leftover notice from a discarded draft never resurfaces. */
	failure: IntentFailure | undefined;
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
	const ackRequestId = ack?.requestId;
	useEffect(() => {
		if (draft?.kind !== "applying" || draft.requestId !== ackRequestId) {
			return;
		}
		setSaved(true);
		setDraft(
			JSON.stringify(draft.rows) === externalKey
				? undefined
				: { kind: "acked", rows: draft.rows, externalAtAck: externalKey }
		);
	}, [draft, ackRequestId, externalKey]);

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
	const failureRequestId = failure?.requestId;
	const failureSeq = failure?.seq;
	useEffect(() => {
		if (failureSeq === undefined || draft?.kind !== "applying" || draft.requestId !== failureRequestId) {
			return;
		}
		setSaved(false);
		setDraft({ kind: "dirty", rows: draft.rows });
	}, [failureSeq, failureRequestId, draft]);

	const phase: DraftPhase = draft === undefined || draft.kind === "acked" ? (saved ? "saved" : "idle") : draft.kind;
	return {
		rows: draft?.rows ?? external,
		// Unchanged rows post nothing (the scalar rows' rule, in draft form).
		dirty: draft?.kind === "dirty" && JSON.stringify(draft.rows) !== externalKey,
		phase,
		pinned: draft !== undefined,
		failure: failure !== undefined && failure.requestId === appliedRequestId ? failure : undefined,
		update: (next) => {
			setSaved(false);
			setDraft({ kind: "dirty", rows: next });
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

/**
 * Apply an ExternalRecordEdit to an editor: reuse the existing group when one
 * carries the key, append a draft group otherwise, then scroll to it and
 * focus - the new group's first field-name input (key prefilled, ready to
 * type), an existing group's matcher input. Inert while the JSON view is
 * open: rewriting a JSON draft under the user would lose their text.
 */
function useExternalRecordEdit(
	external: ExternalRecordEdit | undefined,
	sectionRef: { readonly current: HTMLElement | null },
	rows: readonly PrefixGroup[],
	update: (next: PrefixGroup[]) => void,
	jsonOpen: boolean
): void {
	const seq = external?.seq;
	useEffect(() => {
		if (external === undefined || jsonOpen) {
			return;
		}
		const key = external.key;
		let index = rows.findIndex((group) => group.prefix.trim() === key);
		const created = index < 0 && external.create;
		if (index < 0) {
			if (!external.create) {
				return;
			}
			update([...rows, { prefix: key, params: [{ key: "", valueText: "" }] }]);
			index = rows.length;
		}
		const groupIndex = index;
		// Focus after the render that mounts the (possibly new) group.
		setTimeout(() => {
			const groupEl = sectionRef.current?.querySelectorAll<HTMLElement>("div.group")[groupIndex];
			if (groupEl === undefined) {
				return;
			}
			groupEl.scrollIntoView({ block: "center" });
			const input = created
				? (groupEl.querySelector<HTMLInputElement>(".rows input.key") ??
					groupEl.querySelector<HTMLInputElement>("input.key"))
				: groupEl.querySelector<HTMLInputElement>("input.key");
			input?.focus({ preventScroll: true });
		}, 0);
		// Keyed on the request's seq so repeating the same jump re-focuses.
	}, [seq]);
}

/** One reported intent failure; `seq` distinguishes repeated failures with the same text. */
export interface IntentFailure {
	readonly seq: number;
	readonly message: string;
	/** Whether the intent's durable write committed before the failure; see the protocol's intentFailed notice. */
	readonly kind: "validation" | "operation";
	/** The failed intent's correlation ID, when the intent carried one. */
	readonly requestId?: string | undefined;
	/** The transport classification behind a failed probe, when the notice carried one; enum ids only, never text. */
	readonly classification?: TransportErrorClassification | undefined;
}

/**
 * Names the scope this editor writes and the seam between the tab's two save
 * models: the scalar rows above commit each change on its own (numbers on
 * blur or Enter, checkboxes on toggle), these rows only via Apply.
 */
function ScopeNote({ scoped }: { scoped: ScopedRecordSetting<unknown> }) {
	return (
		<p class="hint">
			{l10n.t(
				"Editing {0} settings. Rows here apply together via the Apply button; the plain settings above save each change on its own.",
				settingScopeLabel(scoped.editScope)
			)}
		</p>
	);
}

function FailureNote({ failure, dirty }: { failure: IntentFailure | undefined; dirty: boolean }) {
	if (failure === undefined || !dirty) {
		return null;
	}
	// Headline first, the extension's own message verbatim as its own line:
	// interpolating it into the sentence produced run-ons whenever the inner
	// message lacked a trailing period. The message stays webview-only (the
	// panel boundary logs classification tokens, never this text).
	return (
		<div class="error failure-note">
			<p>{l10n.t("Saving failed - your edits are kept. Fix the problem below and Apply again.")}</p>
			<p>
				<FailureText message={failure.message} />
			</p>
		</div>
	);
}

/**
 * The Apply outcome next to the button it reports on. The status element is
 * always mounted (empty between phases) so the live region exists before the
 * announcement lands in it.
 */
function ApplyStatus({ phase }: { phase: DraftPhase }) {
	return (
		<span class={phase === "saved" ? "apply-status saved" : "apply-status"} role="status">
			{phase === "applying" ? l10n.t("Applying...") : phase === "saved" ? l10n.t("Saved") : ""}
		</span>
	);
}

/** The other-scope records, rendered as the same disabled grid the edit scope uses, never as prose. */
function OtherScopeNote({ scope }: { scope: SettingScope }) {
	return <p class="hint">{l10n.t("Set in {0} settings - edit there.", settingScopeLabel(scope))}</p>;
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
			<span class="inherit-from">
				<span class="hint">{l10n.t("Inheritance: edit the _inherit_from row below")}</span>
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
		<span class="inherit-from">
			<label class="hint" for={id}>
				{l10n.t("Inherits")}
			</label>
			<Help text={helpInheritFromControl()} />
			<select
				id={id}
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
			</select>
			{shownKind === "keys" ? (
				<input
					type="text"
					class="inherit-keys"
					aria-label={l10n.t("Record keys to inherit from, comma-separated")}
					placeholder={l10n.t("e.g. gpt-5*, *")}
					value={keysText}
					disabled={disabled}
					onInput={(event) => writeKeys(event.currentTarget.value)}
				/>
			) : null}
			{hint !== undefined ? <span class="hint">{hint}</span> : null}
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
				<input
					type="checkbox"
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
		onFocusInCapture: (event: FocusEvent) => void;
		onFocusOutCapture: (event: FocusEvent) => void;
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
			onFocusInCapture: (event: FocusEvent) => {
				if (event.target instanceof HTMLInputElement && event.target.type !== "checkbox") {
					setHold((current) =>
						current !== undefined && current.group === groupIndex && current.row === rowIndex && current.epoch === epoch
							? current
							: { group: groupIndex, row: rowIndex, epoch }
					);
				}
			},
			onFocusOutCapture: (event: FocusEvent) => {
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
 * The model-parameter group rows themselves: one group per model prefix, one
 * row per request parameter, values entered as JSON, problems row-aligned
 * from parseGroups. Purely presentational (edits go through onChange), so the
 * global settings editor below and the server form's per-entry section render
 * the identical rows over their own drafts. The prefix placeholder and help
 * are required props because the two surfaces genuinely differ: global keys
 * may lead with a base URL to scope to one server, entry keys are already
 * scoped and match model IDs only, so a URL prefix there would never match.
 * The parameter-name and value help stay shared; they are scope-agnostic.
 */
export function ParamGroupsFields({
	groups,
	problems,
	hints,
	disabled,
	readOnly,
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
	hints?: readonly GroupHints[];
	disabled?: boolean;
	/** Render as a static display: inputs disabled, add/remove actions gone (the other-scope records). */
	readOnly?: boolean;
	prefixPlaceholder: string;
	prefixHelp: string;
	/** Suggestions for the prefix and parameter-name inputs' listboxes; absent, the inputs stay plain. */
	prefixSuggestions?: readonly string[];
	paramNameSuggestions?: readonly string[];
	onChange: (next: PrefixGroup[]) => void;
	/** Enter in a row input; the editors apply the draft when it parses clean. */
	onEnter?: () => void;
}) {
	const inert = disabled === true || readOnly === true;
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
					readOnly !== true &&
					!focusHold.focused(groupIndex, index) &&
					directiveRowAbsorbed(group, index, PARAM_FLAG_DIRECTIVES) &&
					(group.params[index]?.key.trim() === INHERIT_FROM_DIRECTIVE ||
						hints?.[groupIndex]?.params[index] === undefined);
				const inheritFromIndex = group.params.findIndex((param) => param.key.trim() === INHERIT_FROM_DIRECTIVE);
				// Rows are positional while being edited; the index is the identity.
				return (
					<div class="group" key={groupIndex}>
						<div class="row">
							<span class="cell key">
								<SuggestInput
									value={group.prefix}
									suggestions={prefixSuggestions ?? []}
									inputClass="key"
									invalid={problems[groupIndex]?.prefix !== undefined}
									placeholder={prefixPlaceholder}
									disabled={inert}
									onValue={(next) => patchGroup(groupIndex, { prefix: next })}
									onEnter={onEnter}
								/>
								<Help text={prefixHelp} />
							</span>
							{readOnly === true ? null : (
								<button
									type="button"
									class="quiet"
									disabled={disabled}
									onClick={() => onChange(groups.filter((_, i) => i !== groupIndex))}
								>
									<IconTrash /> {l10n.t("Remove matcher")}
								</button>
							)}
							{problems[groupIndex]?.prefix !== undefined ? (
								<span class="error">{problems[groupIndex]?.prefix}</span>
							) : null}
						</div>
						{readOnly === true ? null : (
							<div class="inherit-line">
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
						)}
						<div class="rows">
							{group.params.map((param, paramIndex) =>
								rowAbsorbed(paramIndex) ? null : (
									<div class="row" key={paramIndex} {...focusHold.rowFocusProps(groupIndex, paramIndex)}>
										<span class="cell key">
											<SuggestInput
												value={param.key}
												suggestions={paramNameSuggestions ?? []}
												inputClass="key"
												invalid={problems[groupIndex]?.params[paramIndex]?.field === "name"}
												placeholder={l10n.t("Parameter, e.g. temperature")}
												disabled={inert}
												onValue={(next) =>
													patchGroup(groupIndex, {
														params: group.params.map((p, i) => (i === paramIndex ? { ...p, key: next } : p)),
													})
												}
												onEnter={onEnter}
											/>
											<Help text={helpModelParameterName()} />
										</span>
										<span class="cell value">
											<input
												type="text"
												class={`value${problems[groupIndex]?.params[paramIndex]?.field === "value" ? " invalid" : ""}`}
												aria-invalid={problems[groupIndex]?.params[paramIndex]?.field === "value"}
												placeholder={l10n.t("JSON value, e.g. 0.2")}
												value={param.valueText}
												disabled={inert}
												onInput={(event) =>
													patchGroup(groupIndex, {
														params: group.params.map((p, i) =>
															i === paramIndex ? { ...p, valueText: event.currentTarget.value } : p
														),
													})
												}
												onKeyDown={onKeyDown}
											/>
											<Help text={helpModelParameterValue()} />
										</span>
										{/* The per-row force/inheritable marks in their own fixed grid
										    column, before the row action, so the boxes align down the
										    card. Directive rows (_force, _inheritable, ...) carry no
										    flag checkboxes - a directive cannot be forced or inherited
										    - and unnamed rows have no key to mark yet; unforceable keys
										    keep the box visible but disabled, with the help naming
										    why. */}
										{param.key.trim().startsWith("_") || param.key.trim().length === 0 ? null : (
											<span class="cell directive-flag">
												<label>
													<input
														type="checkbox"
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
												{readOnly === true ? null : (
													<InheritableFlag
														group={group}
														groupIndex={groupIndex}
														groups={groups}
														fieldKey={param.key.trim()}
														disabled={inert}
														onChange={onChange}
													/>
												)}
											</span>
										)}
										{readOnly === true ? null : (
											<button
												type="button"
												class="quiet"
												disabled={disabled}
												onClick={() =>
													patchGroup(groupIndex, { params: group.params.filter((_, i) => i !== paramIndex) })
												}
											>
												<IconTrash /> {l10n.t("Remove")}
											</button>
										)}
										{problems[groupIndex]?.params[paramIndex] !== undefined ? (
											<span class="error">{problems[groupIndex]?.params[paramIndex]?.message}</span>
										) : null}
										{hints?.[groupIndex]?.params[paramIndex] !== undefined ? (
											<span class="hint">{hints[groupIndex]?.params[paramIndex]}</span>
										) : null}
									</div>
								)
							)}
						</div>
						{readOnly === true ? null : (
							<button
								type="button"
								class="secondary"
								disabled={disabled}
								onClick={() => patchGroup(groupIndex, { params: [...group.params, { key: "", valueText: "" }] })}
							>
								<IconAdd /> {l10n.t("Add parameter")}
							</button>
						)}
					</div>
				);
			})}
		</>
	);
}

/** The latest catalogSearchResults response; pickers match it against their own request ID. */
export type CatalogSearchResponse = Extract<ExtensionToWebviewMessage, { type: "catalogSearchResults" }>;

/** The key suggestions the capability rows offer: the closed vocabulary plus the directives. */
const CAPABILITY_KEY_SUGGESTIONS: readonly string[] = [
	...Object.keys(CAPABILITY_FIELDS),
	FALLBACK_DIRECTIVE,
	OPENROUTER_MODEL_DIRECTIVE,
];

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
			<span class="suggest-input">
				<input
					type="text"
					class={invalid ? `${inputClass} invalid` : inputClass}
					aria-invalid={invalid}
					placeholder={placeholder}
					value={value}
					disabled={disabled}
					onInput={(event) => onValue(event.currentTarget.value)}
					onKeyDown={onKeyDown}
				/>
			</span>
		);
	}
	return (
		<span class="suggest-input">
			<input
				type="text"
				class={invalid ? `${inputClass} invalid` : inputClass}
				role="combobox"
				aria-invalid={invalid}
				aria-expanded={expanded}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={highlighted >= 0 ? `${listId}-${highlighted}` : undefined}
				placeholder={placeholder}
				value={value}
				disabled={disabled}
				onInput={(event) => {
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
					class="catalog-results suggest-results"
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
							class={index === highlighted ? "quiet active" : "quiet"}
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

/** What input a capability row's value takes, keyed off the closed vocabulary and the directives. */
function capabilityValueKind(key: string): "number" | "boolean" | "catalog-id" | "json" {
	if (key === OPENROUTER_MODEL_DIRECTIVE) {
		return "catalog-id";
	}
	if (Object.hasOwn(CAPABILITY_FIELDS, key)) {
		return CAPABILITY_FIELDS[key as keyof typeof CAPABILITY_FIELDS];
	}
	return "json";
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
	results,
	onValue,
	debounceMs = CATALOG_SEARCH_DEBOUNCE_MS,
}: {
	value: string;
	disabled: boolean;
	invalid: boolean;
	/** The latest catalogSearchResults response App holds; matched against this picker's own requestId. */
	results: CatalogSearchResponse | undefined;
	onValue: (next: string) => void;
	/** The search debounce; a prop only so tests need not wait out the real value. */
	debounceMs?: number;
}) {
	const [open, setOpen] = useState(false);
	const [requestId, setRequestId] = useState<string | undefined>(undefined);
	// The keyboard cursor over the result list; -1 means nothing highlighted.
	const [active, setActive] = useState(-1);
	const listId = useId();
	const query = value.trim();

	useEffect(() => {
		if (!open || query.length < 2) {
			setRequestId(undefined);
			return undefined;
		}
		const timer = setTimeout(() => {
			const id = newRequestId();
			setRequestId(id);
			postMessage({ type: "searchCatalog", query, requestId: id });
		}, debounceMs);
		return () => clearTimeout(timer);
	}, [open, query, debounceMs]);

	const matches = requestId !== undefined && results?.requestId === requestId ? results.results : undefined;
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
		} else {
			return;
		}
		event.preventDefault();
	};
	return (
		<span class="cell value catalog-picker">
			<input
				type="text"
				class={invalid ? "value invalid" : "value"}
				role="combobox"
				aria-invalid={invalid}
				aria-expanded={open && matches !== undefined && matches.length > 0}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
				placeholder={l10n.t("OpenRouter ID, e.g. openai/gpt-4o")}
				value={value}
				disabled={disabled}
				onInput={(event) => {
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
				<div class="catalog-results" role="listbox" id={listId} aria-label={l10n.t("Catalog matches")}>
					{matches.map((match, index) => (
						<button
							key={match.id}
							type="button"
							role="option"
							id={`${listId}-${index}`}
							aria-selected={index === active}
							tabIndex={-1}
							class={index === active ? "quiet active" : "quiet"}
							// mousedown, not click: the input's blur closes the list
							// before a click could land.
							onMouseDown={(event) => {
								event.preventDefault();
								pick(match.id);
							}}
						>
							<span class="catalog-id">{match.id}</span> <span class="hint">{match.name}</span>
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
export function CapabilityGroupsFields({
	groups,
	issues,
	disabled,
	readOnly,
	catalogResults,
	prefixSuggestions,
	onChange,
	onEnter,
}: {
	groups: readonly PrefixGroup[];
	issues: readonly CapabilityGroupIssues[];
	disabled?: boolean;
	/** Render as a static display: inputs disabled, add/remove actions gone (the other-scope records). */
	readOnly?: boolean;
	catalogResults: CatalogSearchResponse | undefined;
	/** Suggestions for the matcher input's listbox; absent, the input stays plain. */
	prefixSuggestions?: readonly string[];
	onChange: (next: PrefixGroup[]) => void;
	/** Enter in a row input; the editors apply the draft when it parses clean. */
	onEnter?: () => void;
}) {
	const inert = disabled === true || readOnly === true;
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
	return (
		<>
			{groups.map((group, groupIndex) => {
				// The group's `_fallback` marks, derived once per render from the
				// rows the checkboxes rewrite.
				const fallbackFields = directiveMarkedFields(group, FALLBACK_DIRECTIVE);
				// The control-backed directive rows the grid absorbs, the parameters
				// editor's rule with this editor's own flag set. The hint clause is
				// load-bearing here: an `_inheritable` list may name a row key
				// outside the closed capability vocabulary - eligible for a checkbox
				// yet hinted as ignored - and only the hint keeps that row visible.
				const rowAbsorbed = (index: number): boolean =>
					readOnly !== true &&
					!focusHold.focused(groupIndex, index) &&
					directiveRowAbsorbed(group, index, CAPABILITY_FLAG_DIRECTIVES) &&
					(group.params[index]?.key.trim() === INHERIT_FROM_DIRECTIVE ||
						issues[groupIndex]?.rows[index]?.hint === undefined);
				const inheritFromIndex = group.params.findIndex((param) => param.key.trim() === INHERIT_FROM_DIRECTIVE);
				// Rows are positional while being edited; the index is the identity.
				return (
					<div class="group" key={groupIndex}>
						<div class="row">
							<span class="cell key">
								<SuggestInput
									value={group.prefix}
									suggestions={prefixSuggestions ?? []}
									inputClass="key"
									invalid={issues[groupIndex]?.prefix !== undefined}
									placeholder={l10n.t("Model ID or matcher, e.g. gpt-4 or gpt-4*")}
									disabled={inert}
									onValue={(next) => patchGroup(groupIndex, { prefix: next })}
									onEnter={onEnter}
								/>
								<Help text={helpCapabilityPrefix()} />
							</span>
							{readOnly === true ? null : (
								<button
									type="button"
									class="quiet"
									disabled={inert}
									onClick={() => onChange(groups.filter((_, i) => i !== groupIndex))}
								>
									<IconTrash /> {l10n.t("Remove matcher")}
								</button>
							)}
							{issues[groupIndex]?.prefix !== undefined ? (
								<span class="error">{issues[groupIndex]?.prefix}</span>
							) : null}
						</div>
						{readOnly === true ? null : (
							<div class="inherit-line">
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
						)}
						<div class="rows">
							{group.params.map((param, paramIndex) => {
								if (rowAbsorbed(paramIndex)) {
									return null;
								}
								const issue = issues[groupIndex]?.rows[paramIndex];
								const key = param.key.trim();
								const kind = capabilityValueKind(key);
								const patchRow = (patch: Partial<{ key: string; valueText: string }>) =>
									patchGroup(groupIndex, {
										params: group.params.map((p, i) => (i === paramIndex ? { ...p, ...patch } : p)),
									});
								return (
									<div class="row" key={paramIndex} {...focusHold.rowFocusProps(groupIndex, paramIndex)}>
										<span class="cell key">
											<SuggestInput
												value={param.key}
												suggestions={CAPABILITY_KEY_SUGGESTIONS}
												inputClass="key"
												invalid={issue?.problem?.field === "name"}
												placeholder={l10n.t("Capability, e.g. context_length")}
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
											<Help text={helpCapabilityName()} />
										</span>
										{kind === "boolean" ? (
											<label class="cell value capability-flag">
												<input
													type="checkbox"
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
												results={catalogResults}
												onValue={(next) => patchRow({ valueText: next })}
											/>
										) : (
											<span class="cell value">
												<input
													type={kind === "number" ? "number" : "text"}
													min={kind === "number" ? 1 : undefined}
													class={`value${issue?.problem?.field === "value" ? " invalid" : ""}`}
													aria-invalid={issue?.problem?.field === "value"}
													placeholder={kind === "number" ? l10n.t("Tokens, e.g. 128000") : l10n.t("JSON value")}
													value={param.valueText}
													disabled={inert}
													onInput={(event) => patchRow({ valueText: event.currentTarget.value })}
													onKeyDown={onKeyDown}
												/>
												<Help text={helpCapabilityValue()} />
											</span>
										)}
										{/* The per-row fallback/inheritable marks in the shared fixed
										    flag column, before the row action like the parameter
										    editor's force mark; only the closed vocabulary's fields
										    carry a fallback box (directives and unknown keys have no
										    server value to fall under). */}
										{Object.hasOwn(CAPABILITY_FIELDS, key) ||
										(readOnly !== true && key.length > 0 && !key.startsWith("_")) ? (
											<span class="cell directive-flag">
												{Object.hasOwn(CAPABILITY_FIELDS, key) ? (
													<>
														<label>
															<input
																type="checkbox"
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
													</>
												) : null}
												{readOnly === true ? null : (
													<InheritableFlag
														group={group}
														groupIndex={groupIndex}
														groups={groups}
														fieldKey={key}
														disabled={inert}
														onChange={onChange}
													/>
												)}
											</span>
										) : null}
										{readOnly === true ? null : (
											<button
												type="button"
												class="quiet"
												disabled={inert}
												onClick={() =>
													patchGroup(groupIndex, { params: group.params.filter((_, i) => i !== paramIndex) })
												}
											>
												<IconTrash /> {l10n.t("Remove")}
											</button>
										)}
										{issue?.problem !== undefined ? <span class="error">{issue.problem.message}</span> : null}
										{issue?.hint !== undefined ? <span class="hint">{issue.hint}</span> : null}
									</div>
								);
							})}
						</div>
						{readOnly === true ? null : (
							<button
								type="button"
								class="secondary"
								disabled={inert}
								onClick={() => patchGroup(groupIndex, { params: [...group.params, { key: "", valueText: "" }] })}
							>
								<IconAdd /> {l10n.t("Add capability")}
							</button>
						)}
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

/**
 * Structured editor for litellm-vscode-chat.models.parameters, the
 * object-of-objects the native Settings GUI cannot edit: one group per model
 * prefix, one row per request parameter, values entered as JSON. Edits apply
 * to one configuration scope; other scopes render read-only below.
 */
export function ModelParametersEditor({
	scoped,
	models,
	ack,
	failure,
	hidden,
	external,
}: {
	scoped: ScopedRecordSetting<Readonly<Record<string, unknown>>>;
	/** The discovered models, feeding the prefix input's suggestions. */
	models: readonly DashboardModel[];
	/** The latest intentSucceeded notice; the draft matches it against its own requestId. */
	ack: IntentAck | undefined;
	failure: IntentFailure | undefined;
	/** The settings filter's verdict; hides the section without unmounting it, so a dirty draft survives. */
	hidden?: boolean;
	/** The inspectors' configure-jump; see ExternalRecordEdit. */
	external?: ExternalRecordEdit | undefined;
}) {
	const draft = useDraftRows(toGroups(scoped.value), ack, failure);
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
		const requestId = newRequestId();
		postMessage({ type: "setModelParameters", value: parse.value, requestId });
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
	const sectionRef = useRef<HTMLElement>(null);
	useExternalRecordEdit(external, sectionRef, groups, (next) => draft.update(next), json !== undefined);
	return (
		<section hidden={hidden} ref={sectionRef}>
			<h3 class="head-with-icons">
				{modelParametersTitle()} <Help text={helpModelParametersSection()} />
				<DocsLink href={DOCS_LINK_MODEL_PARAMETERS} label={l10n.t("Open the model parameters guide")} />
				<HeadingRevealButton title={modelParametersTitle()} settingId="models.parameters" />
			</h3>
			<p class="hint">
				{l10n.t(
					'Request parameters sent per matching model (most specific matcher wins). Values are JSON: 0.2, true, "text", ["stop"].'
				)}
			</p>
			<ScopeNote scoped={scoped} />
			{json !== undefined ? (
				<div class="record-json">
					<textarea
						rows={10}
						aria-label={l10n.t("Model parameters as JSON")}
						aria-invalid={jsonBlocked}
						value={json.text}
						onInput={(event) => {
							const text = event.currentTarget.value;
							setJson((current) => (current === undefined ? current : { ...current, text }));
							const parsed = groupsFromJsonText(text);
							if (parsed.ok) {
								draft.update(parsed.rows);
							}
						}}
					/>
					{jsonParse !== undefined && !jsonParse.ok ? <p class="error">{jsonParse.problem}</p> : null}
				</div>
			) : (
				<>
					{groups.length === 0 ? <p class="empty">{l10n.t("No model parameters configured in this scope.")}</p> : null}
					<ParamGroupsFields
						groups={groups}
						problems={problems}
						hints={parse.hints}
						prefixPlaceholder={l10n.t("Model ID or matcher, e.g. gpt-4 or gpt-4*")}
						prefixHelp={helpModelParameterPrefix()}
						prefixSuggestions={modelIds}
						paramNameSuggestions={COMMON_PARAMETER_NAMES}
						onChange={(next) => draft.update(next)}
						onEnter={apply}
					/>
				</>
			)}
			<FailureNote failure={draft.failure} dirty={draft.dirty} />
			<div class="toolbar">
				{json === undefined ? (
					<button
						type="button"
						class="secondary"
						onClick={() => draft.update([...groups, { prefix: "", params: [{ key: "", valueText: "" }] }])}
					>
						<IconAdd /> {l10n.t("Add model matcher")}
					</button>
				) : null}
				<button type="button" disabled={!canApply} onClick={apply}>
					{l10n.t("Apply")}
				</button>
				{/* Discard stays available while a write is in flight: a lost ack
				    must not wedge the editor until a reload. */}
				<button
					type="button"
					class="secondary"
					disabled={!draft.dirty && draft.phase !== "applying" && !(json !== undefined && json.text !== json.base)}
					aria-label={l10n.t("Discard the unapplied model parameter edits")}
					onClick={discard}
				>
					{l10n.t("Discard")}
				</button>
				{json === undefined ? (
					<button
						type="button"
						class="quiet"
						disabled={!parse.ok}
						onClick={() => {
							if (parse.ok) {
								setJson(seededJson(parse.value));
							}
						}}
					>
						{l10n.t("Edit as JSON")}
					</button>
				) : (
					<button type="button" class="quiet" disabled={jsonBlocked} onClick={() => setJson(undefined)}>
						{l10n.t("Edit as rows")}
					</button>
				)}
				<ApplyStatus phase={draft.phase} />
			</div>
			{scoped.otherScopes.map((other) => (
				<div class="other-scope" key={other.scope}>
					<OtherScopeNote scope={other.scope} />
					<ParamGroupsFields
						groups={toGroups(other.value)}
						problems={[]}
						readOnly
						prefixPlaceholder=""
						prefixHelp={helpModelParameterPrefix()}
						onChange={() => undefined}
					/>
				</div>
			))}
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
	ack,
	failure,
	catalogResults,
	hidden,
	external,
}: {
	scoped: ScopedRecordSetting<Readonly<Record<string, unknown>>>;
	/** The discovered models, feeding the matcher input's suggestions. */
	models: readonly DashboardModel[];
	/** The latest intentSucceeded notice; the draft matches it against its own requestId. */
	ack: IntentAck | undefined;
	failure: IntentFailure | undefined;
	/** The latest catalogSearchResults response, for the `_openrouter_model` picker. */
	catalogResults: CatalogSearchResponse | undefined;
	/** The settings filter's verdict; hides the section without unmounting it, so a dirty draft survives. */
	hidden?: boolean;
	/** The inspectors' configure-jump; see ExternalRecordEdit. */
	external?: ExternalRecordEdit | undefined;
}) {
	const draft = useDraftRows(toCapabilityGroups(scoped.value), ack, failure);
	const groups = draft.rows;
	// One parse per keystroke, like the parameters editor: the row issues, the
	// Apply gate, and the assembled record are the same verdict.
	const parse = parseCapabilityGroups(groups);
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
		const requestId = newRequestId();
		postMessage({ type: "setModelCapabilities", value: parse.value, requestId });
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
	const sectionRef = useRef<HTMLElement>(null);
	useExternalRecordEdit(external, sectionRef, groups, (next) => draft.update(next), json !== undefined);
	return (
		<section hidden={hidden} ref={sectionRef}>
			<h3 class="head-with-icons">
				{modelCapabilitiesTitle()} <Help text={helpModelCapabilitiesSection()} />
				<DocsLink href={DOCS_LINK_MODEL_CAPABILITIES} label={l10n.t("Open the model capabilities guide")} />
				<HeadingRevealButton title={modelCapabilitiesTitle()} settingId="models.capabilities" />
			</h3>
			<p class="hint">
				{l10n.t(
					"Capability overrides per matching model, e.g. context_length 128000. Fallback rows fill only what the server leaves unset."
				)}
			</p>
			<ScopeNote scoped={scoped} />
			{json !== undefined ? (
				<div class="record-json">
					<textarea
						rows={10}
						aria-label={l10n.t("Model capabilities as JSON")}
						aria-invalid={jsonBlocked}
						value={json.text}
						onInput={(event) => {
							const text = event.currentTarget.value;
							setJson((current) => (current === undefined ? current : { ...current, text }));
							const parsed = capabilityGroupsFromJsonText(text);
							if (parsed.ok) {
								draft.update(parsed.rows);
							}
						}}
					/>
					{jsonParse !== undefined && !jsonParse.ok ? <p class="error">{jsonParse.problem}</p> : null}
				</div>
			) : (
				<>
					{groups.length === 0 ? (
						<p class="empty">{l10n.t("No model capabilities configured in this scope.")}</p>
					) : null}
					<CapabilityGroupsFields
						groups={groups}
						issues={issues}
						catalogResults={catalogResults}
						prefixSuggestions={modelIds}
						onChange={(next) => draft.update(next)}
						onEnter={apply}
					/>
				</>
			)}
			<FailureNote failure={draft.failure} dirty={draft.dirty} />
			<div class="toolbar">
				{json === undefined ? (
					<button
						type="button"
						class="secondary"
						onClick={() => draft.update([...groups, { prefix: "", params: [{ key: "", valueText: "" }] }])}
					>
						<IconAdd /> {l10n.t("Add capability matcher")}
					</button>
				) : null}
				<button type="button" disabled={!canApply} onClick={apply}>
					{l10n.t("Apply")}
				</button>
				{/* Discard stays available while a write is in flight: a lost ack
				    must not wedge the editor until a reload. */}
				<button
					type="button"
					class="secondary"
					disabled={!draft.dirty && draft.phase !== "applying" && !(json !== undefined && json.text !== json.base)}
					aria-label={l10n.t("Discard the unapplied model capability edits")}
					onClick={discard}
				>
					{l10n.t("Discard")}
				</button>
				{json === undefined ? (
					<button
						type="button"
						class="quiet"
						disabled={!parse.ok}
						onClick={() => {
							if (parse.ok) {
								setJson(seededJson(parse.value));
							}
						}}
					>
						{l10n.t("Edit as JSON")}
					</button>
				) : (
					<button type="button" class="quiet" disabled={jsonBlocked} onClick={() => setJson(undefined)}>
						{l10n.t("Edit as rows")}
					</button>
				)}
				<ApplyStatus phase={draft.phase} />
			</div>
			{scoped.otherScopes.map((other) => (
				<div class="other-scope" key={other.scope}>
					<OtherScopeNote scope={other.scope} />
					<CapabilityGroupsFields
						groups={toCapabilityGroups(other.value)}
						issues={[]}
						readOnly
						catalogResults={undefined}
						onChange={() => undefined}
					/>
				</div>
			))}
		</section>
	);
}
