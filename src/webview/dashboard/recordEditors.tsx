import * as l10n from "@vscode/l10n";
import { useEffect, useRef, useState } from "react";
import { settingScopeLabel } from "../../dashboard/presenters";
import type { PrefixGroup } from "../../dashboard/recordDraft";
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
import { DOCS_LINK_MODEL_CAPABILITIES, DOCS_LINK_MODEL_PARAMETERS } from "./docsLinks";
import { DocsLink, Help } from "./help";
import { helpModelCapabilitiesSection, helpModelParameterPrefix, helpModelParametersSection } from "./helpText";
import type { IntentOutcome } from "./hooks";
import { useIntentOutcome } from "./hooks";
import { IconAdd, IconBraces } from "./icons";
import { capabilityKeySuggestions } from "./recordGroupFields";
import type { GroupIssueView } from "./recordIssues";
import { capabilityIssueViews, paramIssueViews } from "./recordIssues";
import { RecordMatcherEditorOverlay, RecordMatcherTable, useMatcherEditing } from "./recordMatcherTable";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { Reveal } from "./ui/reveal";
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
