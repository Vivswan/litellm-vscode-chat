import * as l10n from "@vscode/l10n";
import { useEffect, useRef, useState } from "react";
import { settingScopeLabel } from "../../dashboard/presenters";
import type { PrefixGroup, RecordJsonParse } from "../../dashboard/recordDraft";
import {
	capabilityGroupsFromJsonText,
	draftRowsKey,
	groupsFromJsonText,
	parseCapabilityGroups,
	parseGroups,
	toCapabilityGroups,
	toGroups,
} from "../../dashboard/recordDraft";
import type { DashboardModel, ScopedRecordSetting, SettingScope } from "../../dashboard/viewModels";
import { statusErrorDetail, statusErrorHeadline } from "../../shared/util/errorText";
import { trimHttpWhitespace } from "../../shared/util/headers";
import type { DocsUrl } from "./docsLinks";
import { DOCS_LINK_MODEL_CAPABILITIES, DOCS_LINK_MODEL_PARAMETERS } from "./docsLinks";
import { DocsLink, Help } from "./help";
import { helpModelCapabilitiesSection, helpModelParameterPrefix, helpModelParametersSection } from "./helpText";
import type { IntentOutcome } from "./hooks";
import { useIntentOutcome } from "./hooks";
import { IconAdd, IconBraces } from "./icons";
import { capabilityKeySuggestions } from "./recordGroupFields";
import type { GroupIssueView, RecordEditorKind } from "./recordIssues";
import { capabilityIssueViews, paramIssueViews } from "./recordIssues";
import { RecordMatcherEditorOverlay, RecordMatcherTable, useMatcherEditing } from "./recordMatcherTable";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { Reveal } from "./ui/reveal";
import { Textarea } from "./ui/textarea";
import { sendRequest } from "./vscodeApi";

/** The editor's heading, exported so the settings form's filter matches the editor by exactly the title it renders. */
export function modelParametersTitle(): string {
	return l10n.t("Model parameters");
}

/** The capabilities editor's heading, modelParametersTitle's twin for the settings filter. */
export function modelCapabilitiesTitle(): string {
	return l10n.t("Model capabilities");
}

/**
 * The heading LINE is the hover band, not the h3 (a button inside a heading folds into its accessible name); the jump
 * reveals through the shared Reveal idiom (ui/reveal.tsx), stays in the Tab order via opacity, and stays painted below
 * 560px where hover does not exist.
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
 *   "saved" -> is the transient confirmation the ack starts
 */
type DraftPhase = "idle" | "dirty" | "applying" | "saved";

/** The local draft's states: edited rows, an in-flight write, or an acked write awaiting the reflecting push. */
type DraftState<T> =
	| { readonly kind: "dirty"; readonly rows: T }
	| { readonly kind: "applying"; readonly rows: T; readonly requestId: string }
	| { readonly kind: "acked"; readonly rows: T; readonly externalAtAck: string };

/** An acked write is no longer a draft phase: the saved notice's window decides between "saved" and "idle". */
function draftPhase<T>(draft: DraftState<T> | undefined, saved: boolean): DraftPhase {
	if (draft === undefined || draft.kind === "acked") {
		return saved ? "saved" : "idle";
	}
	return draft.kind;
}

/** The draft-and-apply state both editors share; the Apply bar and the matcher overlay read it. */
interface DraftRows<T> {
	/** The draft's rows while one is live, else the store's; row ids stay stable until the store value itself changes. */
	rows: T;

	/** Edited away from the store value; unchanged rows post nothing (the scalar rows' rule, in draft form). */
	dirty: boolean;

	/** The phase the Apply bar shows; "saved" holds for SAVED_NOTICE_MS after the ack. */
	phase: DraftPhase;

	/** Whether a draft of any kind is live (dirty, in flight, or acked awaiting the reflecting push). */
	pinned: boolean;

	/** The reported failure of THIS draft's own write; a leftover notice from a discarded draft never resurfaces. */
	failure: IntentFailureOutcome | undefined;

	/** Replace the rows; editing exactly back onto the store value drops the draft and its correlation id with it. */
	update: (next: T) => void;

	/** Mark the dirty draft as in flight under the request id its write was posted with. */
	apply: (requestId: string) => void;

	/** Discard: drops the draft, the saved notice, and the correlation id. */
	reset: () => void;
}

/**
 * Both editors follow one draft-and-apply model: rows edited locally, validated per keystroke, written back only
 * through Apply, so the object settings never pass through an invalid shape.
 *
 * An acked draft keeps rendering until the store push arrives - dropping it at the ack would flash the pre-apply value
 * for one frame.
 */
function useDraftRows<T>(external: T, outcome: IntentOutcome | undefined): DraftRows<T> {
	// Value identity, id-stripped: the caller re-derives `external` per render and each derivation mints fresh row
	// ids, so the LAST value-distinct external is the one that renders - stable row ids at rest, new ids only when the
	// store value actually changed.
	const externalKey = draftRowsKey(external);
	const externalRef = useRef({ key: externalKey, rows: external });
	if (externalRef.current.key !== externalKey) {
		externalRef.current = { key: externalKey, rows: external };
	}
	const [draft, setDraft] = useState<DraftState<T> | undefined>(undefined);
	const [saved, setSaved] = useState(false);
	// The last Apply's correlation ID, kept past the failure transition (the failure note must name the write the
	// still-open draft came from) and dropped with the draft on Discard.
	const [appliedRequestId, setAppliedRequestId] = useState<string | undefined>(undefined);

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

	const phase = draftPhase(draft, saved);
	return {
		rows: draft?.rows ?? externalRef.current.rows,
		// Unchanged rows post nothing (the scalar rows' rule, in draft form).
		dirty: draft?.kind === "dirty" && draftRowsKey(draft.rows) !== externalKey,
		phase,
		pinned: draft !== undefined,
		failure: failure !== undefined && failure.id === appliedRequestId ? failure : undefined,
		update: (next) => {
			setSaved(false);
			// Rows edited exactly back onto the store value drop the draft: a pinned value-equal draft would swallow
			// every later store push with Discard disabled. Textual equality only; the correlation ID goes with it, so
			// an old failure cannot haunt the NEXT draft.
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
 * The inspectors' configure-jump into an editor: focus the record carrying `key`, or with `create` append a fresh
 * draft group (drafts only land on Apply). `seq` keys re-delivery so repeating the same jump re-focuses.
 */
export interface ExternalRecordEdit {
	readonly seq: number;
	readonly key: string;
	readonly create: boolean;
}

export type IntentFailureOutcome = Extract<IntentOutcome, { result: "fail" }>;

function FailureNote({ failure, dirty }: { failure: IntentFailureOutcome | undefined; dirty: boolean }) {
	// Always mounted, speaking or not (dashboard.css .editor-status): the refusal lands async and must not move the
	// action bar.
	//
	//   Text         -> stays webview-only
	//   role="alert" -> needs the element to pre-exist
	const spoken = dirty ? failure : undefined;
	const detail = spoken === undefined ? undefined : statusErrorDetail(spoken.message);
	return (
		<p
			className={cn("failure-note", spoken !== undefined && "error")}
			role="alert"
			{...(spoken === undefined ? {} : { title: spoken.message })}
		>
			{spoken === undefined
				? ""
				: l10n.t("Saving failed - your edits are kept: {0}", statusErrorHeadline(spoken.message))}
			{detail === undefined ? null : <span className="visually-hidden"> {detail}</span>}
		</p>
	);
}

/**
 * The status element is always mounted (empty between phases) so the live region exists before the announcement lands
 * in it.
 */
function ApplyStatus({ phase }: { phase: DraftPhase }) {
	let text = "";
	if (phase === "applying") {
		text = l10n.t("Applying...");
	} else if (phase === "saved") {
		text = l10n.t("Saved");
	}
	return (
		<span className={cn("apply-status", phase === "saved" && "saved")} role="status">
			{text}
		</span>
	);
}

function OtherScopeNote({ scope }: { scope: SettingScope }) {
	return <p className="hint">{l10n.t("Set in {0} settings - edit there.", settingScopeLabel(scope))}</p>;
}

/**
 * The Edit-as-JSON side door's textarea state: the text being edited plus the snapshot it started from, so "changed at
 * all" needs no re-parse.
 */
interface JsonDraft {
	readonly text: string;
	readonly base: string;
}

function seededJson(value: unknown): JsonDraft {
	const text = JSON.stringify(value, null, 2) ?? "{}";
	return { text, base: text };
}

/** Code-unit order, a total order unlike locale collation, so a canonical form is stable across locales. */
function compareKeys(a: string, b: string): number {
	if (a < b) {
		return -1;
	}
	return a > b ? 1 : 0;
}

/**
 * Field order inside a record is no change, so those keys sort (by code unit - a total order, unlike locale
 * collation); the matcher map keeps its order, because a later regex key beats an earlier one
 * (src/shared/config/modelMatcher.ts compareSpecificity). The root is told by identity: a nested field may be named "".
 */
function canonicalKey(value: unknown): string {
	const sortNestedKeys = (_key: string, inner: unknown): unknown => {
		if (inner === value || inner === null || typeof inner !== "object" || Array.isArray(inner)) {
			return inner;
		}
		return Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => compareKeys(a, b)));
	};
	return JSON.stringify(value, sortNestedKeys) ?? "";
}

/** Hand-curated (docs/models.md#where-parameters-come-from): no canonical inventory, pass-through; suggestions only. */
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
 * The card's one validation verdict: the worst problem in draft order, named by its matcher, skipping the field an open
 * popover already states. Card-scoped because a row cannot hold this line - see dashboard.css .editor-status.
 */
function recordVerdict(
	groups: readonly PrefixGroup[],
	issues: readonly GroupIssueView[],
	openField: string | undefined
): { readonly matcher: string; readonly message: string; readonly others: number } | undefined {
	const standing: { matcher: string; message: string }[] = [];
	for (const [index, group] of groups.entries()) {
		const issue = issues[index];
		const matcher = trimHttpWhitespace(group.prefix).length > 0 ? group.prefix : l10n.t("(no matcher)");
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
	// The count keeps the others from being dropped silently; fixing the worst promotes the next into the line.
	let more = "";
	if (verdict.others === 1) {
		more = l10n.t("(+1 more)");
	} else if (verdict.others !== 0) {
		more = l10n.t("(+{0} more)", verdict.others);
	}
	const spoken = `${verdict.matcher}: ${verdict.message}${more === "" ? "" : ` ${more}`}`;
	// The line clips visually where the slot runs short; the text stays whole in the DOM (and in the title for pointer
	// readers), so nothing is lost.
	return (
		<p className="record-verdict error" title={spoken}>
			<code className="font-mono">{verdict.matcher}</code>
			{`: ${verdict.message}`}
			{more === "" ? null : <span className="record-verdict-more">{` ${more}`}</span>}
		</p>
	);
}

/**
 * Two voices, one cell: the async write refusal (role="alert", mounted before it speaks) outranks the validation
 * verdict.
 */
export function RecordStatusSlot({
	groups,
	issues,
	openField,
	refusal,
}: {
	/** The draft's groups in draft order; the verdict names the worst problem by its group's matcher (recordVerdict). */
	groups: readonly PrefixGroup[];

	/** Row-aligned with groups: the parse's problems per group, which the verdict reads. */
	issues: readonly GroupIssueView[];

	/** The open field popover's "groupIndex:rowIndex"; the verdict skips the one problem stated there. */
	openField?: string | undefined;

	/** The owning draft's write-refusal channel; absent on surfaces with no write path (the read-only frames). */
	refusal?: { readonly failure: IntentFailureOutcome | undefined; readonly dirty: boolean } | undefined;
}) {
	const refusing = refusal !== undefined && refusal.failure !== undefined && refusal.dirty;
	return (
		<span className="editor-status">
			{refusal === undefined ? null : <FailureNote failure={refusal.failure} dirty={refusal.dirty} />}
			{refusing ? null : <RecordVerdictLine groups={groups} issues={issues} openField={openField} />}
		</span>
	);
}

/**
 * Whether any standing problem would give the verdict a voice. The read-only frames mount their message row only then:
 * their problems are static per push, so a conditional row cannot shift geometry under a live edit.
 */
export function anyRecordProblem(issues: readonly GroupIssueView[]): boolean {
	return issues.some((issue) => issue.prefix !== undefined || issue.rows.some((row) => row.problem !== undefined));
}

/** The Edit-as-JSON side door's state and moves; `parse` is the per-keystroke verdict while the door is open. */
interface JsonSideDoor {
	readonly json: JsonDraft | undefined;
	readonly parse: RecordJsonParse<PrefixGroup[]> | undefined;
	readonly blocked: boolean;
	readonly edited: boolean;
	readonly open: (value: unknown) => void;
	readonly close: () => void;
	readonly edit: (text: string) => void;
	readonly markApplied: () => void;
	readonly reseed: (value: unknown) => void;
}

interface RecordCommit {
	readonly canApply: boolean;
	readonly apply: () => void;
	readonly discard: () => void;
}

/** The matcher overlay's target and the draft edits it makes through the editor. */
interface MatcherOverlayState {
	readonly editingIndex: number | undefined;
	readonly openEditor: (index: number, key?: string) => void;
	readonly change: (next: PrefixGroup) => void;
	readonly remove: () => void;
	readonly close: () => void;
}

interface ExternalJumpInput {
	readonly external: ExternalRecordEdit | undefined;
	readonly groups: readonly PrefixGroup[];
	readonly draft: DraftRows<PrefixGroup[]>;
	readonly openEditor: (index: number, key?: string) => void;
	readonly jsonOpen: boolean;
}

/** The record the edit scope holds, the type both editors edit. */
type RecordValue = Readonly<Record<string, unknown>>;

/** What a clean parse assembles: the record Apply writes. */
type AssembledRecord = Record<string, Record<string, unknown>>;

interface EditorHeadingProps {
	readonly title: string;
	readonly settingId: "models.parameters" | "models.capabilities";
	readonly help: string;
	readonly docsHref: DocsUrl;
	readonly docsLabel: string;
}

interface RowsOrEmptyProps {
	readonly kind: RecordEditorKind;
	readonly groups: readonly PrefixGroup[];
	readonly issues: readonly GroupIssueView[];
	readonly keySuggestions: readonly string[];
	readonly emptyText: string;
	readonly onChange: (next: PrefixGroup[]) => void;
	readonly onOpenEditor: (groupIndex: number) => void;
	readonly onOpenField: (openField: string | undefined) => void;
}

interface JsonDoorProps {
	readonly door: JsonSideDoor;
	readonly json: JsonDraft;
	readonly ariaLabel: string;
}

interface ModeButtonsProps {
	readonly door: JsonSideDoor;
	readonly addId: string;
	readonly addLabel: string;
	readonly assembled: AssembledRecord | undefined;
	readonly onAdd: () => void;
}

interface CommitTrioProps {
	readonly draft: DraftRows<PrefixGroup[]>;
	readonly door: JsonSideDoor;
	readonly commit: RecordCommit;
	readonly discardLabel: string;
}

interface OtherScopeFrameProps {
	readonly kind: RecordEditorKind;
	readonly scope: SettingScope;
	readonly groups: readonly PrefixGroup[];
	readonly issues: readonly GroupIssueView[];
}

interface EditScopeNoteProps {
	readonly editScope: SettingScope;
}

interface OtherParamScopesProps {
	readonly scopes: ScopedRecordSetting<RecordValue>["otherScopes"];
}

interface OtherCapabilityScopesProps {
	readonly scopes: ScopedRecordSetting<RecordValue>["otherScopes"];
	readonly recognizedKeys: ReadonlySet<string> | undefined;
}

/**
 * The Edit-as-JSON side door. A JSON view without a live draft follows the store like the rows do. Any draft - dirty,
 * in flight, or acked - pins it: a dirty one because the text is (or seeded) the user's, the others because resyncing
 * before the reflecting push would flash the pre-apply value back into the textarea. A keystroke that parses clean
 * lands in the rows through `onRows`.
 */
function useJsonSideDoor(
	storedValue: RecordValue,
	pinned: boolean,
	parseText: (text: string) => RecordJsonParse<PrefixGroup[]>,
	onRows: (rows: PrefixGroup[]) => void
): JsonSideDoor {
	const [json, setJson] = useState<JsonDraft | undefined>(undefined);
	const externalJsonText = JSON.stringify(storedValue, null, 2) ?? "{}";
	useEffect(() => {
		if (pinned) {
			return;
		}
		setJson((current) =>
			current !== undefined && current.text === current.base && current.text !== externalJsonText
				? { text: externalJsonText, base: externalJsonText }
				: current
		);
	}, [externalJsonText, pinned]);
	const parse = json === undefined ? undefined : parseText(json.text);
	return {
		json,
		parse,
		blocked: parse !== undefined && !parse.ok,
		edited: json !== undefined && json.text !== json.base,
		open: (value) => setJson(seededJson(value)),
		close: () => setJson(undefined),
		edit: (text) => {
			setJson((current) => (current === undefined ? current : { ...current, text }));
			const parsed = parseText(text);
			if (parsed.ok) {
				onRows(parsed.rows);
			}
		},
		// The applied text becomes the JSON baseline; only edits after it count as discardable again.
		markApplied: () => setJson((current) => (current === undefined ? current : { ...current, base: current.text })),
		reseed: (value) => {
			if (json !== undefined) {
				setJson(seededJson(value));
			}
		},
	};
}

/**
 * Apply needs a real value change on top of a dirty draft: rows can differ in spelling ("1e1" vs "10") while
 * assembling to the record already stored (the scalar rows' unchanged-posts-nothing rule). Discard drops the draft and
 * reseeds an open JSON door from the store.
 */
function recordCommit(
	draft: DraftRows<PrefixGroup[]>,
	assembled: AssembledRecord | undefined,
	stored: RecordValue,
	door: JsonSideDoor,
	send: (value: AssembledRecord) => string
): RecordCommit {
	const changed = assembled !== undefined && canonicalKey(assembled) !== canonicalKey(stored);
	const canApply = draft.dirty && changed && !door.blocked;
	return {
		canApply,
		apply: () => {
			if (assembled === undefined || !canApply) {
				return;
			}
			draft.apply(send(assembled));
			door.markApplied();
		},
		discard: () => {
			draft.reset();
			door.reseed(stored);
		},
	};
}

/**
 * The overlay's target with the draft edits it makes. A removal that lands the rows back on the store value resets the
 * draft inside useDraftRows.update itself; every path below simply updates. Closing the overlay sweeps up a
 * still-pristine new matcher (no key, no fields): keeping it would strand an invalid empty row in the table.
 */
function useMatcherOverlay(groups: readonly PrefixGroup[], draft: DraftRows<PrefixGroup[]>): MatcherOverlayState {
	const { editingIndex, openEditor, trackRename, closeEditing } = useMatcherEditing(groups);
	const without = (index: number | undefined): PrefixGroup[] => groups.filter((_, at) => at !== index);
	return {
		editingIndex,
		openEditor,
		change: (next) => {
			if (editingIndex === undefined) {
				return;
			}
			const remapped = groups.map((group, index) => (index === editingIndex ? next : group));
			draft.update(remapped);
			trackRename(next, remapped, editingIndex);
		},
		remove: () => {
			draft.update(without(editingIndex));
			closeEditing();
		},
		close: () => {
			const group = editingIndex === undefined ? undefined : groups[editingIndex];
			if (group !== undefined && trimHttpWhitespace(group.prefix).length === 0 && group.params.length === 0) {
				draft.update(without(editingIndex));
			}
			closeEditing();
		},
	};
}

/**
 * The inspectors' configure-jump. Matcher keys compare RAW on both sides - the request carries the stored record key
 * and the draft holds the stored prefix, and the grammar trims neither. Inert while the JSON view is open (rewriting a
 * JSON draft would lose text). Keyed on the request's seq, so repeating the same jump re-opens; the draft, groups, and
 * editor are read at fire time, not watched.
 */
function useExternalJump({ external, groups, draft, openEditor, jsonOpen }: ExternalJumpInput): void {
	const externalSeq = external?.seq;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the request seq alone (see above)
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
}

/**
 * A contained heading sits a step quieter than the group heading above it: same muted tone, one size down, and no
 * rule of its own. At the surrounding group's weight and the page's foreground it out-shouted its own container.
 */
function EditorHeading({ title, settingId, help, docsHref, docsLabel }: EditorHeadingProps) {
	return (
		<div className="section-head group/head mb-1">
			<h3 className="m-0 font-semibold text-[0.9em] text-muted-foreground">{title}</h3>
			<HeadingRevealButton title={title} settingId={settingId} />
			<Help text={help} name={l10n.t("Help: {0}", title)} />
			<DocsLink href={docsHref} label={docsLabel} />
		</div>
	);
}

/**
 * Where Apply writes, said only when it is news: the write-scope rule sends edits to a scope that already sets the
 * record, and "not your User settings" is the one case worth a line.
 */
function EditScopeNote({ editScope }: EditScopeNoteProps) {
	if (editScope === "global") {
		return null;
	}
	return (
		<p className="hint editor-scope-note">
			{l10n.t("Apply writes {0} settings - that scope already sets this record.", settingScopeLabel(editScope))}
		</p>
	);
}

/** The matcher rows while the JSON door is closed, or the one empty line while there are none. */
function RowsOrEmpty({
	kind,
	groups,
	issues,
	keySuggestions,
	emptyText,
	onChange,
	onOpenEditor,
	onOpenField,
}: RowsOrEmptyProps) {
	return (
		<>
			{groups.length === 0 ? <p className="empty">{emptyText}</p> : null}
			{groups.length > 0 ? (
				<RecordMatcherTable
					kind={kind}
					groups={groups}
					issues={issues}
					keySuggestions={keySuggestions}
					onChange={onChange}
					onOpenEditor={onOpenEditor}
					onOpenFieldChange={onOpenField}
				/>
			) : null}
		</>
	);
}

/**
 * The side door's textarea with its reserved status line (dashboard.css .json-status): the parse verdict lands per
 * keystroke, and mounted only alongside a problem it pushed the mode buttons and the commit bar down on the first bad
 * character.
 */
function JsonDoor({ door, json, ariaLabel }: JsonDoorProps) {
	return (
		<div className="record-json">
			<Textarea
				className="w-full px-2 py-1"
				rows={10}
				aria-label={ariaLabel}
				aria-invalid={door.blocked}
				value={json.text}
				onChange={(event) => door.edit(event.currentTarget.value)}
			/>
			<p className={cn("json-status", door.blocked && "error")}>
				{door.parse !== undefined && !door.parse.ok ? door.parse.problem : null}
			</p>
		</div>
	);
}

/**
 * The bar's mode actions: Add matcher and Edit as JSON while rows show, Edit as rows while the door is open. Two
 * slots, the mode button always in the second: it is one element across the switch, so the focus that activated it
 * stays on it instead of dropping to the body.
 */
function ModeButtons({ door, addId, addLabel, assembled, onAdd }: ModeButtonsProps) {
	const rows = door.json === undefined;
	return (
		<>
			{rows ? (
				<Button variant="secondary" id={addId} onClick={onAdd}>
					<IconAdd /> {addLabel}
				</Button>
			) : null}
			{rows ? (
				<Button
					variant="secondary"
					size="compact"
					disabled={assembled === undefined}
					onClick={() => {
						if (assembled !== undefined) {
							door.open(assembled);
						}
					}}
				>
					{l10n.t("Edit as JSON")}
				</Button>
			) : (
				<Button variant="secondary" size="compact" disabled={door.blocked} onClick={door.close}>
					{l10n.t("Edit as rows")}
				</Button>
			)}
		</>
	);
}

/**
 * The commit trio is ONE flex group so a narrow pane wraps it as a unit - a bare ms-auto on the status once let Apply
 * wrap onto a line of its own, left-aligned under the mode actions.
 *
 * Discard stays available while a write is in flight: a lost ack must not wedge the editor until a reload. Apply is
 * last in the bar, first in rank: the accent `default` rank is the dashboard's primary, and the trailing slot is where
 * a region's commit lives.
 */
function CommitTrio({ draft, door, commit, discardLabel }: CommitTrioProps) {
	return (
		<span className="editor-commit ms-auto flex flex-wrap items-center gap-2">
			<ApplyStatus phase={draft.phase} />
			<Button
				variant="danger"
				disabled={!draft.dirty && draft.phase !== "applying" && !door.edited}
				aria-label={discardLabel}
				onClick={commit.discard}
			>
				{l10n.t("Discard")}
			</Button>
			<Button disabled={!commit.canApply} onClick={commit.apply}>
				{l10n.t("Apply")}
			</Button>
		</span>
	);
}

/**
 * Another scope's record as a static table. A read-only chip's mark is a border with no popover behind it, so the
 * frame's own message row says what stands - the footer-position line, message alone (no write path, no buttons),
 * mounted only while a problem does.
 */
function OtherScopeFrame({ kind, scope, groups, issues }: OtherScopeFrameProps) {
	return (
		<div className="other-scope">
			<OtherScopeNote scope={scope} />
			<div className="record-frame">
				<RecordMatcherTable kind={kind} groups={groups} issues={issues} readOnly />
				{anyRecordProblem(issues) ? (
					<div className="toolbar editor-actions">
						<RecordStatusSlot groups={groups} issues={issues} />
					</div>
				) : null}
			</div>
		</div>
	);
}

/**
 * The other scopes' parameter records. The static tables judge their rows with the same parse as the edit scope:
 * absorption reads the hints, and a directive the badges cannot faithfully summarize must keep its raw chip here too.
 */
function OtherParamScopes({ scopes }: OtherParamScopesProps) {
	return (
		<>
			{scopes.map((other) => {
				const groups = toGroups(other.value);
				const parse = parseGroups(groups);
				const issues = paramIssueViews(groups, parse.ok ? [] : parse.problems, parse.hints);
				return <OtherScopeFrame key={other.scope} kind="params" scope={other.scope} groups={groups} issues={issues} />;
			})}
		</>
	);
}

/**
 * The other scopes' capability records, under the same-parse rule as the parameters editor's static tables and with
 * the same evidence: other scopes still hold global records.
 */
function OtherCapabilityScopes({ scopes, recognizedKeys }: OtherCapabilityScopesProps) {
	return (
		<>
			{scopes.map((other) => {
				const groups = toCapabilityGroups(other.value);
				const issues = capabilityIssueViews(groups, parseCapabilityGroups(groups, recognizedKeys).issues);
				return <OtherScopeFrame key={other.scope} kind="caps" scope={other.scope} groups={groups} issues={issues} />;
			})}
		</>
	);
}

/**
 * Structured editor for litellm-vscode-chat.models.parameters, the object-of-objects the native Settings GUI cannot
 * edit. Edits apply to one scope; others render read-only.
 *
 * The frame bounds the draft: the matcher rows (or the JSON side door), the failure note, and the action bar that
 * commits them are one region, so "what does Apply apply" has a visible answer. The row problems, the Apply gate, and
 * the assembled record are the same verdict, so a draft that renders clean can never assemble differently.
 *
 *   scoped   -> the record at every scope; only editScope's value is edited and written back whole, the others render
 *               read-only
 *   models   -> the discovered models, feeding the prefix input's suggestions
 *   hidden   -> the settings filter's verdict; hides the section without unmounting it, so a dirty draft survives
 *   external -> the inspectors' configure-jump; see ExternalRecordEdit
 */
export function ModelParametersEditor({
	scoped,
	models,
	hidden,
	external,
}: {
	scoped: ScopedRecordSetting<RecordValue>;
	models: readonly DashboardModel[];
	hidden?: boolean;
	external?: ExternalRecordEdit | undefined;
}) {
	const intent = useIntentOutcome("setModelParameters");
	const draft = useDraftRows(toGroups(scoped.value), intent.outcome);
	const groups = draft.rows;
	const parse = parseGroups(groups);
	const problems = parse.ok ? [] : parse.problems;
	const assembled = parse.ok ? parse.value : undefined;
	// The table reports its open field so the card's verdict skips the one problem it already states.
	const [openField, setOpenField] = useState<string | undefined>(undefined);
	const door = useJsonSideDoor(scoped.value, draft.pinned, groupsFromJsonText, draft.update);
	const commit = recordCommit(draft, assembled, scoped.value, door, (value) => intent.send({ value }));
	const issueViews = paramIssueViews(groups, problems, parse.hints);
	const overlay = useMatcherOverlay(groups, draft);
	useExternalJump({ external, groups, draft, openEditor: overlay.openEditor, jsonOpen: door.json !== undefined });
	const modelIds = Array.from(new Set(models.map((model) => model.id)));
	const addMatcher = () => {
		draft.update([...groups, { prefix: "", params: [] }]);
		overlay.openEditor(groups.length, "");
	};
	const editing = overlay.editingIndex === undefined ? undefined : groups[overlay.editingIndex];
	return (
		<section hidden={hidden}>
			<EditorHeading
				title={modelParametersTitle()}
				settingId="models.parameters"
				help={helpModelParametersSection()}
				docsHref={DOCS_LINK_MODEL_PARAMETERS}
				docsLabel={l10n.t("Open the model parameters guide")}
			/>
			<div className="record-frame">
				<EditScopeNote editScope={scoped.editScope} />
				{door.json === undefined ? (
					<RowsOrEmpty
						kind="params"
						groups={groups}
						issues={issueViews}
						keySuggestions={COMMON_PARAMETER_NAMES}
						emptyText={l10n.t("No model parameters configured in this scope.")}
						onChange={draft.update}
						onOpenEditor={overlay.openEditor}
						onOpenField={setOpenField}
					/>
				) : (
					<JsonDoor door={door} json={door.json} ariaLabel={l10n.t("Model parameters as JSON")} />
				)}
				{/* The bar's one message slot rides its free space, between the mode actions and the commit trio: the
				    refusal and the validation verdict speak here, one at a time, without moving either group. */}
				<div className="toolbar editor-actions">
					<ModeButtons
						door={door}
						addId="params-add-matcher"
						addLabel={l10n.t("Add model matcher")}
						assembled={assembled}
						onAdd={addMatcher}
					/>
					<RecordStatusSlot
						groups={groups}
						issues={issueViews}
						openField={openField}
						refusal={{ failure: draft.failure, dirty: draft.dirty }}
					/>
					<CommitTrio
						draft={draft}
						door={door}
						commit={commit}
						discardLabel={l10n.t("Discard the unapplied model parameter edits")}
					/>
				</div>
			</div>
			<OtherParamScopes scopes={scoped.otherScopes} />
			{overlay.editingIndex !== undefined && editing !== undefined ? (
				<RecordMatcherEditorOverlay
					kind="params"
					group={editing}
					groupProblems={problems[overlay.editingIndex]}
					groupHints={parse.hints[overlay.editingIndex]}
					prefixPlaceholder={l10n.t("Model ID or matcher, e.g. gpt-4 or gpt-4*")}
					prefixHelp={helpModelParameterPrefix()}
					prefixSuggestions={modelIds}
					keySuggestions={COMMON_PARAMETER_NAMES}
					fallbackFocusId="params-add-matcher"
					note={l10n.t("Changes here edit the draft; Apply in the editor saves them.")}
					onChange={overlay.change}
					onRemove={overlay.remove}
					onClose={overlay.close}
					onEnter={commit.apply}
				/>
			) : null}
		</section>
	);
}

/**
 * Structured editor for litellm-vscode-chat.models.capabilities, the capabilities twin of ModelParametersEditor. The
 * observed-key union is both the hints' evidence and the autocomplete's server half because the global records scope
 * over every server, so one union fits both; absent or empty it is no evidence, and the hints stay quiet while the
 * suggestions fall back to the static vocabulary.
 *
 *   scoped       -> the record at every scope; only editScope's value is edited and written back whole, the others
 *                   render read-only
 *   models       -> the discovered models, feeding the matcher input's suggestions
 *   observedKeys -> the cross-server union of observed /model/info keys: hint evidence and the server half of the key
 *                   autocomplete
 *   hidden       -> the settings filter's verdict; hides the section without unmounting it, so a dirty draft survives
 *   external     -> the inspectors' configure-jump; see ExternalRecordEdit
 */
export function ModelCapabilitiesEditor({
	scoped,
	models,
	observedKeys,
	hidden,
	external,
}: {
	scoped: ScopedRecordSetting<RecordValue>;
	models: readonly DashboardModel[];
	observedKeys?: readonly string[] | undefined;
	hidden?: boolean;
	external?: ExternalRecordEdit | undefined;
}) {
	const intent = useIntentOutcome("setModelCapabilities");
	const draft = useDraftRows(toCapabilityGroups(scoped.value), intent.outcome);
	const groups = draft.rows;
	const recognizedKeys = observedKeys === undefined ? undefined : new Set(observedKeys);
	const keySuggestions = capabilityKeySuggestions(observedKeys);
	const parse = parseCapabilityGroups(groups, recognizedKeys);
	const assembled = parse.ok ? parse.value : undefined;
	// The table reports its open field so the card's verdict skips the one problem it already states.
	const [openField, setOpenField] = useState<string | undefined>(undefined);
	const door = useJsonSideDoor(scoped.value, draft.pinned, capabilityGroupsFromJsonText, draft.update);
	const commit = recordCommit(draft, assembled, scoped.value, door, (value) => intent.send({ value }));
	const issueViews = capabilityIssueViews(groups, parse.issues);
	const overlay = useMatcherOverlay(groups, draft);
	useExternalJump({ external, groups, draft, openEditor: overlay.openEditor, jsonOpen: door.json !== undefined });
	const modelIds = Array.from(new Set(models.map((model) => model.id)));
	const addMatcher = () => {
		draft.update([...groups, { prefix: "", params: [] }]);
		overlay.openEditor(groups.length, "");
	};
	const editing = overlay.editingIndex === undefined ? undefined : groups[overlay.editingIndex];
	return (
		<section hidden={hidden}>
			<EditorHeading
				title={modelCapabilitiesTitle()}
				settingId="models.capabilities"
				help={helpModelCapabilitiesSection()}
				docsHref={DOCS_LINK_MODEL_CAPABILITIES}
				docsLabel={l10n.t("Open the model capabilities guide")}
			/>
			<div className="record-frame">
				<EditScopeNote editScope={scoped.editScope} />
				{door.json === undefined ? (
					<RowsOrEmpty
						kind="caps"
						groups={groups}
						issues={issueViews}
						keySuggestions={keySuggestions}
						emptyText={l10n.t("No model capabilities configured in this scope.")}
						onChange={draft.update}
						onOpenEditor={overlay.openEditor}
						onOpenField={setOpenField}
					/>
				) : (
					<JsonDoor door={door} json={door.json} ariaLabel={l10n.t("Model capabilities as JSON")} />
				)}
				<div className="toolbar editor-actions">
					<ModeButtons
						door={door}
						addId="caps-add-matcher"
						addLabel={l10n.t("Add capability matcher")}
						assembled={assembled}
						onAdd={addMatcher}
					/>
					<RecordStatusSlot
						groups={groups}
						issues={issueViews}
						openField={openField}
						refusal={{ failure: draft.failure, dirty: draft.dirty }}
					/>
					<CommitTrio
						draft={draft}
						door={door}
						commit={commit}
						discardLabel={l10n.t("Discard the unapplied model capability edits")}
					/>
				</div>
			</div>
			<OtherCapabilityScopes scopes={scoped.otherScopes} recognizedKeys={recognizedKeys} />
			{overlay.editingIndex !== undefined && editing !== undefined ? (
				<RecordMatcherEditorOverlay
					kind="caps"
					group={editing}
					groupIssues={parse.issues[overlay.editingIndex]}
					prefixSuggestions={modelIds}
					keySuggestions={keySuggestions}
					fallbackFocusId="caps-add-matcher"
					note={l10n.t("Changes here edit the draft; Apply in the editor saves them.")}
					onChange={overlay.change}
					onRemove={overlay.remove}
					onClose={overlay.close}
					onEnter={commit.apply}
				/>
			) : null}
		</section>
	);
}
