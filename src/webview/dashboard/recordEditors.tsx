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
	INHERITABLE_DIRECTIVE,
	OPENROUTER_MODEL_DIRECTIVE,
	settingScopeLabel,
} from "../../extension/dashboard/protocol";
import type {
	CapabilityGroupIssues,
	GroupHints,
	GroupProblems,
	PrefixGroup,
} from "../../extension/dashboard/recordDraft";
import {
	capabilityGroupsFromJsonText,
	directiveEligible,
	directiveMarkedFields,
	groupsFromJsonText,
	inheritFromChoice,
	parseCapabilityGroups,
	parseGroups,
	setInheritFromChoice,
	toCapabilityGroups,
	toGroups,
	toggleDirectiveField,
} from "../../extension/dashboard/recordDraft";
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

/** How long the "Saved" note lingers after the reflecting push; toast-scale, and any new edit clears it early. */
const SAVED_NOTICE_MS = 4000;

/**
 * Where a draft is in its apply lifecycle. "applying" is the window between
 * Apply and the store push that reflects the write; "saved" is the transient
 * confirmation right after that push drops the draft.
 */
type DraftPhase = "idle" | "dirty" | "applying" | "saved";

/**
 * Both editors here follow one draft-and-apply model: rows are edited
 * locally, validated on every keystroke, and written back to configuration
 * only through Apply, so the object settings never pass through an invalid
 * intermediate shape. With no draft the store value renders directly; a
 * dirty draft wins until Apply or Discard. An applied draft keeps rendering
 * (no flicker back to the pre-apply value) until either the store push that
 * reflects the write arrives (which drops it and shows the transient Saved
 * note) or the extension reports the write failed (which returns it to a
 * dirty, retryable state).
 */
function useDraftRows<T>(
	external: T,
	failure: IntentFailure | undefined
): {
	rows: T;
	dirty: boolean;
	phase: DraftPhase;
	update: (next: T) => void;
	apply: () => void;
	reset: () => void;
} {
	const externalKey = JSON.stringify(external);
	const [draft, setDraft] = useState<{ rows: T; applied: boolean; baseKey: string } | undefined>(undefined);
	const [saved, setSaved] = useState(false);
	const failureSeq = failure?.seq;

	useEffect(() => {
		if (draft?.applied === true && externalKey !== draft.baseKey) {
			setDraft(undefined);
			setSaved(true);
		}
	}, [draft, externalKey]);

	useEffect(() => {
		if (!saved) {
			return undefined;
		}
		const timer = setTimeout(() => setSaved(false), SAVED_NOTICE_MS);
		return () => clearTimeout(timer);
	}, [saved]);

	// A reported write failure re-opens the applied draft for editing.
	useEffect(() => {
		if (failureSeq !== undefined) {
			setSaved(false);
			setDraft((current) => (current?.applied === true ? { ...current, applied: false } : current));
		}
	}, [failureSeq]);

	const phase: DraftPhase = draft === undefined ? (saved ? "saved" : "idle") : draft.applied ? "applying" : "dirty";
	return {
		rows: draft?.rows ?? external,
		// A draft whose rows match the store is not dirty: applying it would
		// write a no-op the store never reflects, stranding the applying phase
		// (the scalar rows' unchanged-posts-nothing rule, in draft form).
		dirty: draft !== undefined && !draft.applied && JSON.stringify(draft.rows) !== externalKey,
		phase,
		update: (next) => {
			setSaved(false);
			setDraft({ rows: next, applied: false, baseKey: externalKey });
		},
		// Applying re-baselines against the external state as of the click:
		// a push that arrived while the draft was dirty must not count as the
		// one reflecting this write, or the draft would drop the moment Apply
		// lands and render the concurrent value as "Saved".
		apply: () =>
			setDraft((current) => (current === undefined ? undefined : { ...current, applied: true, baseKey: externalKey })),
		reset: () => {
			setSaved(false);
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
	return (
		<p class="error">{l10n.t("Saving failed: {0} Your edits are kept; fix them and Apply again.", failure.message)}</p>
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
 * directive's four shapes plus a keys input for the named-records form. It
 * reads and writes the group's `_inherit_from` row (the row stays visible and
 * editable as text, like the other directive rows), and goes hands-off while
 * that row holds text the strict parse rejects - the row's own error tells
 * that story, and the select must not silently rewrite the user's text.
 */
function InheritFromControl({
	group,
	disabled,
	onChange,
}: {
	group: PrefixGroup;
	disabled: boolean;
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
	// the mode persists locally. [] stays expressible only as explicit text
	// in the _inherit_from row itself.
	const [keysPending, setKeysPending] = useState(false);
	const [pendingText, setPendingText] = useState("");
	if (choice.kind === "unreadable") {
		return (
			<span class="inherit-from">
				<span class="hint">{l10n.t("Inheritance: fix the _inherit_from row below")}</span>
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
	prefixListId,
	paramNameListId,
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
	/** Datalist IDs for the prefix and parameter-name inputs; the owning editor renders the lists. */
	prefixListId?: string;
	paramNameListId?: string;
	onChange: (next: PrefixGroup[]) => void;
	/** Enter in a row input; the editors apply the draft when it parses clean. */
	onEnter?: () => void;
}) {
	const inert = disabled === true || readOnly === true;
	// No Enter-apply on an input that carries a datalist: Enter also accepts
	// the highlighted suggestion, and the keydown outruns the input event that
	// commits it, so applying there would post the half-typed value.
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
	return (
		<>
			{groups.map((group, groupIndex) => {
				// The group's `_force` marks, derived once per render from the same
				// rows the checkboxes rewrite, so box state and row text cannot drift.
				const forcedFields = directiveMarkedFields(group, FORCE_DIRECTIVE);
				// Rows are positional while being edited; the index is the identity.
				return (
					<div class="group" key={groupIndex}>
						<div class="row">
							<span class="cell key">
								<input
									type="text"
									class={`key${problems[groupIndex]?.prefix === undefined ? "" : " invalid"}`}
									aria-invalid={problems[groupIndex]?.prefix !== undefined}
									placeholder={prefixPlaceholder}
									value={group.prefix}
									disabled={inert}
									list={prefixListId}
									onInput={(event) => patchGroup(groupIndex, { prefix: event.currentTarget.value })}
									onKeyDown={prefixListId === undefined ? onKeyDown : undefined}
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
									onChange={(next) => onChange(groups.map((g, i) => (i === groupIndex ? next : g)))}
								/>
							</div>
						)}
						<div class="rows">
							{group.params.map((param, paramIndex) => (
								<div class="row" key={paramIndex}>
									<span class="cell key">
										<input
											type="text"
											class={`key${problems[groupIndex]?.params[paramIndex]?.field === "name" ? " invalid" : ""}`}
											aria-invalid={problems[groupIndex]?.params[paramIndex]?.field === "name"}
											placeholder={l10n.t("Parameter, e.g. temperature")}
											value={param.key}
											disabled={inert}
											list={paramNameListId}
											onInput={(event) =>
												patchGroup(groupIndex, {
													params: group.params.map((p, i) =>
														i === paramIndex ? { ...p, key: event.currentTarget.value } : p
													),
												})
											}
											onKeyDown={paramNameListId === undefined ? onKeyDown : undefined}
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
									{/* The per-row force mark, trailing the row action in DOM and on
									    screen alike, so the Remove buttons keep one shared column.
									    Unnamed rows and the directive row itself carry no box;
									    unforceable keys keep it visible but disabled, with the help
									    naming why. */}
									{/* Directive rows (_force, _inheritable, _inherit_from, ...) carry
								    no flag checkboxes: a directive cannot be forced or inherited,
								    and the lints diagnose exactly that. Non-directive unforceable
								    keys keep the disabled box with the reason in its help. */}
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
									{problems[groupIndex]?.params[paramIndex] !== undefined ? (
										<span class="error">{problems[groupIndex]?.params[paramIndex]?.message}</span>
									) : null}
									{hints?.[groupIndex]?.params[paramIndex] !== undefined ? (
										<span class="hint">{hints[groupIndex]?.params[paramIndex]}</span>
									) : null}
								</div>
							))}
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

const CAPABILITY_KEY_LIST_ID = "model-capabilities-key-options";

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
	prefixListId,
	onChange,
}: {
	groups: readonly PrefixGroup[];
	issues: readonly CapabilityGroupIssues[];
	disabled?: boolean;
	/** Render as a static display: inputs disabled, add/remove actions gone (the other-scope records). */
	readOnly?: boolean;
	catalogResults: CatalogSearchResponse | undefined;
	/** Datalist ID for the matcher input; the owning editor renders the list. */
	prefixListId?: string;
	onChange: (next: PrefixGroup[]) => void;
}) {
	const inert = disabled === true || readOnly === true;
	const patchGroup = (index: number, patch: Partial<PrefixGroup>) => {
		onChange(groups.map((group, i) => (i === index ? { ...group, ...patch } : group)));
	};
	return (
		<>
			<datalist id={CAPABILITY_KEY_LIST_ID}>
				{CAPABILITY_KEY_SUGGESTIONS.map((key) => (
					<option key={key} value={key} />
				))}
			</datalist>
			{groups.map((group, groupIndex) => {
				// The group's `_fallback` marks, derived once per render from the
				// rows the checkboxes rewrite.
				const fallbackFields = directiveMarkedFields(group, FALLBACK_DIRECTIVE);
				// Rows are positional while being edited; the index is the identity.
				return (
					<div class="group" key={groupIndex}>
						<div class="row">
							<span class="cell key">
								<input
									type="text"
									class={`key${issues[groupIndex]?.prefix === undefined ? "" : " invalid"}`}
									aria-invalid={issues[groupIndex]?.prefix !== undefined}
									placeholder={l10n.t("Model ID or matcher, e.g. gpt-4 or gpt-4*")}
									value={group.prefix}
									disabled={inert}
									list={prefixListId}
									onInput={(event) => patchGroup(groupIndex, { prefix: event.currentTarget.value })}
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
									onChange={(next) => onChange(groups.map((g, i) => (i === groupIndex ? next : g)))}
								/>
							</div>
						)}
						<div class="rows">
							{group.params.map((param, paramIndex) => {
								const issue = issues[groupIndex]?.rows[paramIndex];
								const key = param.key.trim();
								const kind = capabilityValueKind(key);
								const patchRow = (patch: Partial<{ key: string; valueText: string }>) =>
									patchGroup(groupIndex, {
										params: group.params.map((p, i) => (i === paramIndex ? { ...p, ...patch } : p)),
									});
								return (
									<div class="row" key={paramIndex}>
										<span class="cell key">
											<input
												type="text"
												class={`key${issue?.problem?.field === "name" ? " invalid" : ""}`}
												aria-invalid={issue?.problem?.field === "name"}
												placeholder={l10n.t("Capability, e.g. context_length")}
												value={param.key}
												disabled={inert}
												list={CAPABILITY_KEY_LIST_ID}
												onInput={(event) => {
													const nextKey = event.currentTarget.value;
													// A row just switched onto a support flag means "turn it
													// on"; seeding true keeps the checkbox and the parse in
													// agreement without an extra click.
													const seedsTrue =
														capabilityValueKind(nextKey.trim()) === "boolean" && param.valueText.trim().length === 0;
													patchRow({ key: nextKey, ...(seedsTrue ? { valueText: "true" } : {}) });
												}}
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
												/>
												<Help text={helpCapabilityValue()} />
											</span>
										)}
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
										{/* The per-row fallback mark, trailing the row action like the
									    parameter editor's force mark; only the closed vocabulary's
									    fields carry one (directives and unknown keys have no server
									    value to fall under). */}
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
 * order compare equal. Gates Apply on a real value change: a no-op write
 * produces no store change and would strand the applying phase.
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

const MODEL_PREFIX_LIST_ID = "model-parameters-prefix-options";
const PARAM_NAME_LIST_ID = "model-parameters-name-options";

/**
 * Structured editor for litellm-vscode-chat.models.parameters, the
 * object-of-objects the native Settings GUI cannot edit: one group per model
 * prefix, one row per request parameter, values entered as JSON. Edits apply
 * to one configuration scope; other scopes render read-only below.
 */
export function ModelParametersEditor({
	scoped,
	models,
	failure,
	hidden,
	external,
}: {
	scoped: ScopedRecordSetting<Readonly<Record<string, unknown>>>;
	/** The discovered models, feeding the prefix input's suggestions. */
	models: readonly DashboardModel[];
	failure: IntentFailure | undefined;
	/** The settings filter's verdict; hides the section without unmounting it, so a dirty draft survives. */
	hidden?: boolean;
	/** The inspectors' configure-jump; see ExternalRecordEdit. */
	external?: ExternalRecordEdit | undefined;
}) {
	const draft = useDraftRows(toGroups(scoped.value), failure);
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
	// Any draft - dirty or applied - pins it: a dirty one because the text is
	// (or seeded) the user's, an applied one because resyncing before the
	// reflecting push would flash the pre-apply value back into the textarea.
	const externalJsonText = JSON.stringify(scoped.value, null, 2) ?? "{}";
	const draftPhase = draft.phase;
	useEffect(() => {
		if (draftPhase === "dirty" || draftPhase === "applying") {
			return;
		}
		setJson((current) =>
			current !== undefined && current.text === current.base && current.text !== externalJsonText
				? { text: externalJsonText, base: externalJsonText }
				: current
		);
	}, [externalJsonText, draftPhase]);

	// Apply needs a real value change on top of a dirty draft: rows can differ
	// in spelling ("1e1" vs "10") while assembling to the record already stored,
	// and writing that no-op would strand the applying phase.
	const changed = parse.ok && canonicalKey(parse.value) !== canonicalKey(scoped.value);
	const canApply = draft.dirty && changed && !jsonBlocked;
	const apply = () => {
		if (!parse.ok || !canApply) {
			return;
		}
		postMessage({ type: "setModelParameters", value: parse.value });
		draft.apply();
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
			<datalist id={MODEL_PREFIX_LIST_ID}>
				{modelIds.map((id) => (
					<option key={id} value={id} />
				))}
			</datalist>
			<datalist id={PARAM_NAME_LIST_ID}>
				{COMMON_PARAMETER_NAMES.map((name) => (
					<option key={name} value={name} />
				))}
			</datalist>
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
						prefixListId={MODEL_PREFIX_LIST_ID}
						paramNameListId={PARAM_NAME_LIST_ID}
						onChange={(next) => draft.update(next)}
						onEnter={apply}
					/>
				</>
			)}
			<FailureNote failure={failure} dirty={draft.dirty} />
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
				<button
					type="button"
					class="secondary"
					disabled={!draft.dirty && !(json !== undefined && json.text !== json.base)}
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

const CAPABILITY_PREFIX_LIST_ID = "model-capabilities-prefix-options";

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
	failure,
	catalogResults,
	hidden,
	external,
}: {
	scoped: ScopedRecordSetting<Readonly<Record<string, unknown>>>;
	/** The discovered models, feeding the matcher input's suggestions. */
	models: readonly DashboardModel[];
	failure: IntentFailure | undefined;
	/** The latest catalogSearchResults response, for the `_openrouter_model` picker. */
	catalogResults: CatalogSearchResponse | undefined;
	/** The settings filter's verdict; hides the section without unmounting it, so a dirty draft survives. */
	hidden?: boolean;
	/** The inspectors' configure-jump; see ExternalRecordEdit. */
	external?: ExternalRecordEdit | undefined;
}) {
	const draft = useDraftRows(toCapabilityGroups(scoped.value), failure);
	const groups = draft.rows;
	// One parse per keystroke, like the parameters editor: the row issues, the
	// Apply gate, and the assembled record are the same verdict.
	const parse = parseCapabilityGroups(groups);
	const issues = parse.issues;
	const [json, setJson] = useState<JsonDraft | undefined>(undefined);
	const jsonParse = json === undefined ? undefined : capabilityGroupsFromJsonText(json.text);
	const jsonBlocked = jsonParse !== undefined && !jsonParse.ok;

	const externalJsonText = JSON.stringify(scoped.value, null, 2) ?? "{}";
	const draftPhase = draft.phase;
	useEffect(() => {
		if (draftPhase === "dirty" || draftPhase === "applying") {
			return;
		}
		setJson((current) =>
			current !== undefined && current.text === current.base && current.text !== externalJsonText
				? { text: externalJsonText, base: externalJsonText }
				: current
		);
	}, [externalJsonText, draftPhase]);

	const changed = parse.ok && canonicalKey(parse.value) !== canonicalKey(scoped.value);
	const canApply = draft.dirty && changed && !jsonBlocked;
	const apply = () => {
		if (!parse.ok || !canApply) {
			return;
		}
		postMessage({ type: "setModelCapabilities", value: parse.value });
		draft.apply();
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
			<datalist id={CAPABILITY_PREFIX_LIST_ID}>
				{modelIds.map((id) => (
					<option key={id} value={id} />
				))}
			</datalist>
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
						prefixListId={CAPABILITY_PREFIX_LIST_ID}
						onChange={(next) => draft.update(next)}
					/>
				</>
			)}
			<FailureNote failure={failure} dirty={draft.dirty} />
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
				<button
					type="button"
					class="secondary"
					disabled={!draft.dirty && !(json !== undefined && json.text !== json.base)}
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
