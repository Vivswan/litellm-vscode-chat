/**
 * The shared settings-row primitives behind the Settings and Features pages:
 * one row anatomy (SettingRow and its mark/reveal/reset gestures), the scalar
 * field components, the shared comma-list editor, the group frame, and the one
 * filter pipeline plus write-failure placement both pages consume. The pages
 * own their content; everything here is the row language they share.
 */

import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useId, useState } from "react";
import type { SettingWriteMethod } from "../../dashboard/endpoints";
import { SETTING_WRITE_METHODS } from "../../dashboard/endpoints";
import {
	booleanSettingPresentation,
	defaultDisplay,
	draftSyncKey,
	equivalence,
	isBoundViolation,
	numberSettingPresentation,
	parseNumberDraft,
	settingScopeLabel,
	unitBehavior,
} from "../../dashboard/presenters";
import type { SettingRowId, SettingRowPageId, SettingScope } from "../../dashboard/viewModels";
import { settingRowPage } from "../../dashboard/viewModels";
import type { BooleanSettingId, NumberSettingId } from "../../shared/config/settingSpec";
import { BOOLEAN_SETTING_SPECS, NUMBER_SETTING_SPECS } from "../../shared/config/settingSpec";
import { statusErrorHeadline } from "../../shared/util/errorText";
import { useAlertOnce } from "./announceOnce";
import { FailureText } from "./failureText";
import { Help, NoBreakTail } from "./help";
import { settingRowHelp } from "./helpText";
import { IconBraces } from "./icons";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { cn } from "./ui/cn";
import { Input } from "./ui/input";
import { Reveal } from "./ui/reveal";
import { Select } from "./ui/select";
import { sendRequest } from "./vscodeApi";

/**
 * One standing write failure as a page places it; App projects its store entry into
 * this shape. `row` rides the fail envelope itself (extension-derived from the refused
 * request), so placement needs no correlation state on this side.
 */
export interface SettingWriteFailure {
	/** Distinguishes repeated failures with the same text; keys the notice so role="alert" re-announces. */
	readonly seq: number;
	/** The owning settings row, absent for a failure whose payload never parsed. */
	readonly row?: SettingRowId | undefined;
	readonly message: string;
}

/** Each row's standing write failure, keyed by the owning row; SettingRow reads its own. */
export const SettingFailuresContext = createContext<Partial<Record<SettingRowId, SettingWriteFailure>>>({});

/** The one frame every misplaced-write notice wears, row-level and fallback alike. */
export function writeFailureText(failure: SettingWriteFailure): ReactNode {
	return (
		<FailureText
			message={failure.message}
			frame={(headline) => l10n.t("The last change did not apply: {0}", headline)}
		/>
	);
}

/**
 * The page a failure belongs to: the fail envelope's row through the owner
 * map, and a row-less failure (a payload that never parsed) to the Settings
 * page - the fallback surface, so nothing is silently lost.
 */
export function failurePage(failure: SettingWriteFailure): SettingRowPageId {
	return failure.row === undefined ? "settings" : settingRowPage(failure.row);
}

/**
 * Place one page's standing write failures: each lands under the row its fail
 * envelope names when that row is visible on this page (latest seq wins when
 * two share a row); a failure this page owns whose row the filter hid (or that
 * carries no row at all) falls back to the page's always-visible top line.
 * Failures owned by the OTHER page are not placed here at all - the shell's
 * away line covers cross-page visibility. `rowVisible` must be total and
 * fail-open: an unknown id renders visible, never crashes (settingRowPage's
 * contract).
 */
export function placeWriteFailures(
	writeFailures: Partial<Record<SettingWriteMethod, SettingWriteFailure>> | undefined,
	page: SettingRowPageId,
	rowVisible: (row: SettingRowId) => boolean
): {
	rowFailures: Partial<Record<SettingRowId, SettingWriteFailure>>;
	unclaimed: SettingWriteFailure | undefined;
} {
	const rowFailures: Partial<Record<SettingRowId, SettingWriteFailure>> = {};
	let unclaimed: SettingWriteFailure | undefined;
	for (const method of SETTING_WRITE_METHODS) {
		const failure = writeFailures?.[method];
		if (failure === undefined || failurePage(failure) !== page) {
			continue;
		}
		const row = failure.row;
		if (row !== undefined && rowVisible(row)) {
			const standing = rowFailures[row];
			if (standing === undefined || failure.seq > standing.seq) {
				rowFailures[row] = failure;
			}
		} else if (unclaimed === undefined || failure.seq > unclaimed.seq) {
			unclaimed = failure;
		}
	}
	return { rowFailures, unclaimed };
}

/**
 * The one filter pipeline both pages run: a trimmed lowercase needle plus the
 * haystack test every row-visibility verdict goes through, so a needle cannot
 * match one page's rows by a different rule than the other's.
 */
export function filterMatcher(filter: string): {
	readonly needle: string;
	readonly matches: (...haystack: string[]) => boolean;
} {
	const needle = filter.trim().toLowerCase();
	return {
		needle,
		matches: (...haystack: string[]): boolean =>
			needle.length === 0 || haystack.some((text) => text.toLowerCase().includes(needle)),
	};
}

/** Whether a row id names a spec'd scalar (the ids scalarText can present); the fail-open guard reads it. */
export function isScalarRowId(row: string): row is NumberSettingId | BooleanSettingId {
	return Object.hasOwn(NUMBER_SETTING_SPECS, row) || Object.hasOwn(BOOLEAN_SETTING_SPECS, row);
}

/**
 * The one row template every row obeys. The geometry lives in dashboard.css (.setting-row
 * and its band rules, beside .settings-groups); this name is the pointer.
 */
const SETTING_ROW_GRID = "setting-row";

/**
 * The wide tier's shared tracks, owned by dashboard.css .settings-groups (rows adopt them
 * through subgrid); this name is the pointer.
 */
export const SETTING_GRID_TRACKS = "settings-groups";

/**
 * The label cell. Its alignment, growth cap, and corner reserves live in dashboard.css
 * .setting-title; a constant because the row renders the label as `label` or `span`.
 */
const SETTING_TITLE = "setting-title font-semibold";

/**
 * The settings.json jump every row carries, in the trailing actions slot with Reset,
 * hover- and focus-revealed (the shared Reveal idiom), so a resting row is label,
 * control, and explanation and nothing else. hit-24 gives the {} glyph the pointer
 * target its icon-sized box does not, without enlarging the glyph or the slot.
 */
function RevealButton({ title, settingId }: { title: string; settingId: SettingRowId }) {
	return (
		<Reveal within="setting">
			<Button
				variant="secondary"
				size="compact"
				className="reveal-json hit-24 [--btn-mx:-0.25rem] px-1 py-0"
				aria-label={l10n.t("Open {0} in settings.json", title)}
				onClick={() => sendRequest("revealSetting", { setting: settingId })}
			>
				<IconBraces />
			</Button>
		</Reveal>
	);
}

/**
 * Reset removes the value from the highest-precedence scope that sets it, so the
 * accessible name says which scope's value goes, never "reset to default" - and names
 * the setting, because six bare "Reset"s are indistinguishable to a screen reader.
 */
function ResetButton({ title, scope, settingId }: { title: string; scope: SettingScope; settingId: SettingRowId }) {
	const action = l10n.t("Remove the {0} value of {1}", settingScopeLabel(scope), title);
	return (
		<Reveal within="setting">
			<Button
				variant="secondary"
				size="compact"
				className="reset"
				aria-label={action}
				onClick={() => sendRequest("resetSetting", { setting: settingId })}
			>
				{l10n.t("Reset")}
			</Button>
		</Reveal>
	);
}

/**
 * A configured row's annotation. The at-rest signal is the SHAPE (the gutter accent), so
 * words appear only where they add: User scope reveals the default on hover/focus, while
 * a workspace value names its scope at rest - the one case the bar cannot disambiguate.
 * A null scope renders the note's SPACING TWIN (same text, permanent opacity-0,
 * aria-hidden): the reveal idiom holds its box at rest, so without the twin a modified
 * row could be one line taller than its clean self (+15px measured). It skips the Reveal
 * primitive so none of the bordered modes' at-rest reveals apply (those key on
 * data-slot="reveal").
 */
function ModifiedNote({ scope, defaultText }: { scope: SettingScope | null; defaultText?: string | undefined }) {
	if (defaultText !== undefined && scope === null) {
		return (
			<span className="setting-modified-note inline-flex opacity-0" aria-hidden="true">
				{l10n.t("default: {0}", defaultText)}
			</span>
		);
	}
	if (scope === null) {
		return null;
	}
	if (scope === "global") {
		return defaultText === undefined ? null : (
			<Reveal within="setting" className="setting-modified-note">
				{l10n.t("default: {0}", defaultText)}
			</Reveal>
		);
	}
	return (
		<span className="setting-modified-note text-muted-foreground">
			{defaultText === undefined
				? l10n.t("Modified in {0} settings", settingScopeLabel(scope))
				: l10n.t("Modified in {0} settings (default: {1})", settingScopeLabel(scope), defaultText)}
		</span>
	);
}

/**
 * The row's help glyph at the visible sentence's tail, glued to the word before it by the
 * NoBreakTail glue. ONE live mount for every state of the row: the covered and resting
 * texts swap around it, so keyboard focus on the "?" survives an overlay landing or
 * clearing. The height twin renders an inert COPY of this trail (aria-hidden and
 * visibility-hidden, so out of the Tab order and the accessibility tree) purely to hold
 * the resting box.
 */
function glyphTrail(title: string, help: string | undefined) {
	if (help === undefined) {
		return null;
	}
	return (
		<NoBreakTail>
			<Help text={help} name={l10n.t("Help: {0}", title)} />
		</NoBreakTail>
	);
}

/**
 * Covered text longer than this gets the Details disclosure: the covered slot
 * renders ONE truncated line (so a long failure, label, or translation can
 * never overrun the reserved description height into the next row), and the
 * full selectable text opens as a deliberate detail block below the row -
 * user-initiated, so the height change is intended (check-geometry registers
 * the pair). A length threshold rather than measurement: deterministic under
 * tests with no layout engine.
 */
const COVER_DETAILS_THRESHOLD = 80;

/**
 * A covered-slot tenant. The bare string is the ordinary case, where the line
 * the cover renders IS the whole message; the pair is for a tenant that
 * deliberately says LESS on the row than it has to say - the row keeps a short
 * scannable line and Details reveals the consequence-first sentence in full.
 * One shape for both, so the slot has one notion of "what it shows" and one of
 * "what it has", never a second truncation rule per tenant.
 */
export type CoveredMessage = string | { readonly headline: string; readonly detail: string };

function coveredLine(message: CoveredMessage | undefined): string | undefined {
	return typeof message === "string" ? message : message?.headline;
}

function coveredDetail(message: CoveredMessage | undefined): string | undefined {
	return typeof message === "string" ? message : message?.detail;
}

/**
 * One settings row: a configured row wears the modified accent in the gutter (the border
 * is always there, transparent when clean, so marking never shifts it) and offers the
 * Reset for exactly that scope. The filter hides rows via the hidden attribute, never by
 * unmounting: a half-typed draft must survive being filtered away and back.
 */
export function SettingRow({
	settingId,
	title,
	titleFor,
	description,
	help,
	control,
	error,
	errorId,
	notice,
	defaultText,
	configuredScope,
	hidden,
	hintClassName,
	compactControl,
	companion,
}: {
	settingId: SettingRowId;
	title: string;
	/** The id of the control the label points at; omitted where clicking the title must not write a setting. */
	titleFor?: string | undefined;
	description: ReactNode;
	help?: string | undefined;
	control: ReactNode;
	/**
	 * Replaces the description while it stands, so the row's height never changes as you
	 * type. A CoveredMessage pair keeps the row's line short while Details carries the
	 * full sentence; a bare string shows the same text in both places.
	 */
	error?: CoveredMessage | undefined;
	errorId?: string;
	/**
	 * The lowest-precedence covered-slot tenant: a transient tone-styled status
	 * (a model probe's outcome) that rides the same height-keeping overlay as
	 * the errors, so landing one moves nothing. Tones are the app-wide tone
	 * text classes (state-ok / state-warn / error), one vocabulary with the
	 * server form's test result.
	 */
	notice?: { readonly text: string; readonly tone: "ok" | "warning" | "error" } | undefined;
	/** The built-in default, named in the modified note (number rows only). */
	defaultText?: string | undefined;
	configuredScope: SettingScope | null;
	hidden: boolean;
	/** Extra placement on the description cell - the catalog row widens its status cluster's track with this. */
	hintClassName?: string | undefined;
	/**
	 * A checkbox is compact enough to share the title's line at EVERY stacked width (the
	 * sub-560 one-column fallback exists for the wide controls). tailwind-merge resolves
	 * these against the base template's own sub-560 classes (same variant, later input wins).
	 */
	compactControl?: boolean;
	/**
	 * A secondary row of a setting that spans several rows (the language
	 * filter's mode row): the setting's primary row carries the actions and the
	 * standing write failure, so a companion renders neither - a shared failure
	 * would otherwise show and announce once per row.
	 */
	companion?: boolean;
}) {
	// The standing failure of this row's last write, rendered in the covered-description slot
	// like the parse errors (an inserted block used to move every row below). HEADLINE only:
	// the detail line is arbitrary-length and the covering contract keeps the cell's height.
	// A live parse error outranks it (it describes the draft under the user's fingers);
	// the failure resurfaces when the draft parses clean again.
	const settingFailures = useContext(SettingFailuresContext);
	const writeFailure = companion === true ? undefined : settingFailures[settingId];
	// The error's two faces: the line the cover renders and the text Details
	// reveals. Identical for every tenant that has nothing more to say.
	const errorLine = coveredLine(error);
	const errorDetail = coveredDetail(error);
	// Announced once per failure seq. The seq reaches the hook only while this branch
	// actually renders: fed unconditionally, a failure landing behind a parse error was
	// marked spoken with no visible line having spoken it, and surfaced silent later.
	const writeFailureRole = useAlertOnce(errorLine === undefined ? writeFailure?.seq : undefined);
	const failureText =
		writeFailure === undefined
			? undefined
			: l10n.t("The last change did not apply: {0}", statusErrorHeadline(writeFailure.message));
	const covered = errorLine !== undefined || failureText !== undefined || notice !== undefined;
	// The visible tenant's line, its full text, and its tone (precedence:
	// error > write failure > notice).
	const coverText = errorLine ?? (failureText !== undefined && writeFailure !== undefined ? failureText : notice?.text);
	const detailText =
		errorDetail ?? (failureText !== undefined && writeFailure !== undefined ? failureText : notice?.text);
	const coverToneClass =
		errorLine !== undefined || failureText !== undefined
			? "error"
			: notice?.tone === "error"
				? "error"
				: notice?.tone === "warning"
					? "state-warn"
					: "state-ok";
	const [detailsOpen, setDetailsOpen] = useState(false);
	const detailId = useId();
	// A new tenant closes a stale disclosure: the detail block must never show
	// yesterday's text under today's headline.
	// biome-ignore lint/correctness/useExhaustiveDependencies: coverText IS the reset trigger.
	useEffect(() => {
		setDetailsOpen(false);
	}, [coverText]);
	// Details opens either because the line was truncated to fit, or because the
	// tenant deliberately holds text the line never showed.
	const needsDetails =
		detailText !== undefined && (detailText !== coverText || detailText.length > COVER_DETAILS_THRESHOLD);
	const detailsButton = needsDetails ? (
		<Button
			size="compact"
			variant="secondary"
			className="shrink-0"
			aria-expanded={detailsOpen}
			aria-controls={detailId}
			onClick={() => setDetailsOpen((open) => !open)}
		>
			{detailsOpen ? l10n.t("Hide details") : l10n.t("Details")}
		</Button>
	) : null;
	// The resting flow. While covered it renders once more inside the height twin -
	// visibility-hidden AND aria-hidden, so its copies (notes, the catalog row's controls)
	// are inert: out of the Tab order, hit-testing, and the accessibility tree. An AT-REST
	// note precedes the glyph, so the "?" stays the resting description's last element;
	// the hover-only User-scope note (or its spacing twin) trails it.
	const restingFlow = (
		<>
			<span className="setting-desc">{description}</span>
			{configuredScope !== null && configuredScope !== "global" ? (
				<>
					{" "}
					<ModifiedNote scope={configuredScope} defaultText={defaultText} />
				</>
			) : null}
		</>
	);
	const trailingNote =
		configuredScope === "global" || (configuredScope === null && defaultText !== undefined) ? (
			<>
				{" "}
				<ModifiedNote scope={configuredScope} defaultText={defaultText} />
			</>
		) : null;
	return (
		<div
			className={cn(
				SETTING_ROW_GRID,
				"group/setting -ml-3 relative items-baseline gap-y-1 rounded-xs border-l-2 py-2 pl-2.5 hover:bg-accent",
				// The right edge mirrors the record rows' (-mx-2 with px-2): the hover tint overhangs
				// the pane's cap by 8px while the CONTENT stops exactly at it.
				"-mr-2 pr-2",
				// The modified mark is the ACCENT, not the host's amber modifiedItemIndicator: "you set
				// this" is selection semantics, amber means "needs attention". The var-shorthand form
				// reads the RUNTIME --accent-hue chain directly: a named utility needs a @theme alias,
				// and the last one was deleted as orphaned - the bar silently fell back to grey.
				configuredScope !== null ? "modified border-l-(--accent-hue)" : "border-l-transparent",
				// A compact control keeps the two-column line at every stacked width
				// (dashboard.css .setting-row.setting-compact).
				compactControl === true && "setting-compact",
				// The structural mark of a multi-row setting's secondary row; tests
				// pin that exactly the companions leave their actions slot empty.
				companion === true && "setting-companion"
			)}
			hidden={hidden}
		>
			{titleFor === undefined ? (
				<span className={SETTING_TITLE}>{title}</span>
			) : (
				<label className={SETTING_TITLE} htmlFor={titleFor}>
					{title}
				</label>
			)}
			{/* The stacked bands' corner reserves under the pinned actions ride the band rules in
			    dashboard.css: the control cell on the two-column tiers, the title below 560px. */}
			{/* min-w-0: a grid item's min-width:auto would let one wide control (a
			    select with a long dangling option) inflate the track past a narrow
			    pane; controls shrink instead, clipping their own text natively. */}
			<div className="setting-control flex min-w-0 flex-wrap items-center gap-2">{control}</div>
			{/* The error COVERS the description: while one stands, the live flow leaves the flow
			    and overlays the resting text's invisible aria-hidden twin (dashboard.css
			    .setting-hint), so the cell keeps its height and no row moves while you type. The
			    covering text joins the SAME inline flow as the row's ONE help glyph, which trails
			    whichever sentence is visible - the glyph element never remounts across the swap,
			    so keyboard focus on it survives structurally. The cell owns breaking because it
			    owns wrapping; the 72ch cap is a READING cap inside the growing track, not a
			    second edge. */}
			<div
				className={cn(
					"setting-hint relative min-w-0 max-w-[72ch] break-words text-[0.95em] text-muted-foreground",
					covered && "setting-covered",
					hintClassName
				)}
			>
				<span className={cn("setting-live", covered && "flex min-w-0 items-start gap-2")}>
					{/* The slot's visible tenant. The .error span holds ONLY the message and keeps the
					    id: aria-describedby reads the referenced subtree, and a glyph inside it would
					    ride every announcement of the field's problem. The write-failure cover is
					    keyed on the seq so a repeat re-mounts and announces afresh (useAlertOnce
					    dedupes to one announcement per seq); the glyph is its sibling and outlives
					    the remount. */}
					{errorLine !== undefined ? (
						<span className="setting-cover flex min-w-0 flex-1 items-center gap-2">
							<span className="error min-w-0 truncate" id={errorId}>
								{errorLine}
							</span>
							{detailsButton}
						</span>
					) : failureText !== undefined && writeFailure !== undefined ? (
						<span key={writeFailure.seq} className="setting-cover flex min-w-0 flex-1 items-center gap-2">
							<span className="error min-w-0 truncate" role={writeFailureRole}>
								{failureText}
							</span>
							{detailsButton}
						</span>
					) : notice !== undefined ? (
						<span className="setting-cover flex min-w-0 flex-1 items-center gap-2">
							<span className={cn("min-w-0 truncate", coverToneClass)} role="status">
								{notice.text}
							</span>
							{detailsButton}
						</span>
					) : (
						<span className="setting-rest contents">{restingFlow}</span>
					)}
					{glyphTrail(title, help)}
					{covered ? null : trailingNote}
				</span>
				{covered ? (
					<span className="setting-twin" aria-hidden="true">
						<span className="setting-rest contents">{restingFlow}</span>
						{glyphTrail(title, help)}
						{trailingNote}
					</span>
				) : null}
				{covered && detailsOpen && detailText !== undefined ? (
					// The full selectable text, revealed on request: a deliberate
					// user-initiated height change (never automatic), so no covered
					// line has to carry an unreadable tail.
					<div
						id={detailId}
						// overflow-wrap:anywhere, not break-words: min-content sizing
						// counts anywhere-breaks, so an unbroken URL cannot inflate the
						// description track past a narrow pane.
						className={cn(
							"setting-detail mt-1 min-w-0 select-text whitespace-pre-wrap [overflow-wrap:anywhere]",
							coverToneClass
						)}
					>
						{detailText}
					</div>
				) : null}
			</div>
			{/* The row's one actions slot: Reset then the settings.json jump, always last (the
			    anatomy's fourth track; placement per band in dashboard.css .setting-actions).
			    gap-4.5 is ink-to-ink (compact buttons hand their padding back). A companion row
			    keeps the empty track so its grid lines up with its primary's. */}
			<div className="setting-actions flex items-center justify-end gap-4.5 self-start justify-self-end">
				{companion === true ? null : (
					<>
						{configuredScope !== null ? (
							<ResetButton title={title} scope={configuredScope} settingId={settingId} />
						) : null}
						<RevealButton title={title} settingId={settingId} />
					</>
				)}
			</div>
		</div>
	);
}

/**
 * A number setting edited as draft text, committed on blur or Enter. One parse per
 * keystroke feeds display, commit, and equivalence hint alike - never latched at commit
 * time. One display exception: a minimum-bound rejection stays quiet until first blur,
 * because typing the 5 of 5000 honestly passes below the bound; the parse itself is
 * unchanged and the blurred latch re-arms on every external resync.
 */
function NumberField({
	id,
	value,
	configuredScope,
	hidden,
}: {
	id: NumberSettingId;
	value: number | null;
	configuredScope: SettingScope | null;
	hidden: boolean;
}) {
	const presentation = numberSettingPresentation(id);
	const [text, setText] = useState(value === null ? "" : String(value));
	const [blurred, setBlurred] = useState(false);
	// Suffix-grammar units (ms durations: "90s", "5m") need type="text": a
	// number input silently swallows the suffix letters. Plain-number units
	// keep type="number".
	const freeText = unitBehavior(id).freeTextInput;

	// Keyed on draftSyncKey, not on the value alone: a successful reset of a
	// value pinned to exactly its default changes only the configured scope,
	// and a stale rejected draft must resync on that push too.
	const syncKey = draftSyncKey(value, configuredScope);
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on syncKey alone (see above); the values are read at sync time, not watched
	useEffect(() => {
		setText(value === null ? "" : String(value));
		setBlurred(false);
	}, [syncKey]);

	const parse = parseNumberDraft(id, text);
	const suppressed = parse.kind === "invalid" && !blurred && isBoundViolation(id, text);
	const error = parse.kind === "invalid" && !suppressed ? parse.problem : undefined;
	const commit = () => {
		if (parse.kind === "invalid") {
			return;
		}
		if (parse.kind === "clear") {
			if (value !== null) {
				sendRequest("setNumberSetting", { setting: id, value: null });
			}
			return;
		}
		if (parse.value !== value) {
			sendRequest("setNumberSetting", { setting: id, value: parse.value });
		}
	};
	// Blur and Enter both mean "done typing": commit a valid draft, and let a
	// held-back bound error show from here on.
	const settle = () => {
		setBlurred(true);
		commit();
	};

	const inputId = `setting-${id}`;
	const unitId = `${inputId}-unit`;
	const errorId = `${inputId}-error`;
	const equiv = parse.kind === "value" ? equivalence(id, parse.value) : undefined;
	return (
		<SettingRow
			settingId={id}
			title={presentation.label}
			titleFor={inputId}
			description={presentation.description}
			help={settingRowHelp(id)}
			error={error}
			errorId={errorId}
			defaultText={defaultDisplay(id)}
			configuredScope={configuredScope}
			hidden={hidden}
			control={
				<>
					<Input
						id={inputId}
						className="w-[9rem] tabular-nums"
						type={freeText ? "text" : "number"}
						// The default text inputmode, stated on purpose: a numeric one
						// would hide the s/m/h suffix keys the duration grammar needs.
						inputMode={freeText ? "text" : undefined}
						spellCheck={freeText ? false : undefined}
						min={freeText ? undefined : NUMBER_SETTING_SPECS[id].minimum}
						aria-invalid={error !== undefined}
						aria-describedby={error === undefined ? unitId : `${unitId} ${errorId}`}
						value={text}
						onChange={(event) => setText(event.currentTarget.value)}
						onBlur={settle}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								settle();
							}
						}}
					/>
					<span className="setting-unit whitespace-nowrap text-muted-foreground tabular-nums" id={unitId}>
						{presentation.unit}
					</span>
					{equiv !== undefined ? (
						<span className="setting-equiv whitespace-nowrap text-muted-foreground tabular-nums">{equiv}</span>
					) : null}
				</>
			}
		/>
	);
}

/**
 * A boolean setting. The title is plain text on purpose: a click on the label gutter
 * must not silently write settings.json. `meta` fills the description slot for a row
 * whose status IS its description, and is never label-wrapped - a click on a Refresh
 * button must not also toggle the checkbox.
 */
function BooleanField({
	id,
	value,
	configuredScope,
	hidden,
	meta,
}: {
	id: BooleanSettingId;
	value: boolean;
	configuredScope: SettingScope | null;
	hidden: boolean;
	meta?: ReactNode;
}) {
	const presentation = booleanSettingPresentation(id);
	const inputId = `setting-${id}`;
	return (
		<SettingRow
			settingId={id}
			title={presentation.label}
			description={
				meta ?? (
					<label className="cursor-pointer" htmlFor={inputId}>
						{presentation.description}
					</label>
				)
			}
			help={settingRowHelp(id)}
			configuredScope={configuredScope}
			hidden={hidden}
			// A checkbox shares the title's line at every width (compactControl).
			compactControl
			// A status cluster is not prose, so it sheds the hint's 72ch measure. Below the models
			// list's 1136px columnar tier (reused, not minted) the fixed tracks eat too much pane,
			// so the cluster takes the idle control track too and starts on a line of its own.
			hintClassName={
				meta === undefined
					? undefined
					: "max-w-none @min-[910px]/pane:@max-[1136px]/pane:col-start-2 @min-[910px]/pane:@max-[1136px]/pane:col-span-2"
			}
			control={
				<Checkbox
					id={inputId}
					checked={value}
					// A meta row has no description <label> to name the checkbox, so
					// the title names it directly; label-named rows must not carry a
					// second, competing name.
					aria-label={meta !== undefined ? presentation.label : undefined}
					onChange={(event) => sendRequest("setBooleanSetting", { setting: id, value: event.currentTarget.checked })}
				/>
			}
		/>
	);
}

/**
 * Any closed-vocabulary setting as a select. One component rather than one per enum:
 * near-copies drift, and a third enum setting should cost a call, not a component.
 */
export function EnumSettingRow<T extends string>({
	settingId,
	title,
	description,
	help,
	value,
	options,
	optionLabel,
	onPick,
	configuredScope,
	hidden,
}: {
	settingId: SettingRowId;
	title: string;
	description: string;
	help?: string | undefined;
	value: T;
	options: readonly T[];
	optionLabel: (option: T) => string;
	onPick: (option: T) => void;
	configuredScope: SettingScope | null;
	hidden: boolean;
}) {
	const inputId = `setting-${settingId}`;
	return (
		<SettingRow
			settingId={settingId}
			title={title}
			titleFor={inputId}
			description={description}
			help={help}
			configuredScope={configuredScope}
			hidden={hidden}
			control={
				<Select
					id={inputId}
					className="max-w-full"
					value={value}
					onChange={(event) => onPick(event.currentTarget.value as T)}
				>
					{options.map((candidate) => (
						<option key={candidate} value={candidate}>
							{optionLabel(candidate)}
						</option>
					))}
				</Select>
			}
		/>
	);
}

/**
 * Whether a stored comma-list value can only be edited in settings.json: the
 * box cannot round-trip an entry that holds a comma or edge whitespace, and
 * the lossy flag covers what the normalized push cannot show at all. THE ONE
 * predicate for the class - CommaListRow's read-only fallback and the
 * language filter's mode row (which patches the setting the list lives in, so
 * it freezes alongside it) must never disagree.
 */
export function commaListCustom(values: readonly string[], lossy: boolean): boolean {
	return lossy || values.some((entry) => entry.includes(",") || entry !== entry.trim());
}

/**
 * The intent schema's list bounds are WIRE_LIMITS entries (both sides of the
 * wire read the same numbers), so a paste the host would reject is refused
 * here with a reason instead of surfacing as a generic envelope failure.
 *
 * The ONE comma-separated list editor behind the keywords and language-filter list rows:
 * one draft (trimmed, empties dropped, deduplicated in order), committed on blur or Enter
 * when it differs from the stored list; a draft past the wire bounds shows the bound and
 * never commits; and a stored list the box cannot round-trip (commaListCustom) renders
 * read-only with the reveal button, so the dashboard never destroys it.
 */
export function CommaListRow({
	settingId,
	title,
	description,
	help,
	placeholder,
	values,
	lossy,
	maxLength,
	maxCount,
	countProblem,
	lengthProblem,
	configuredScope,
	hidden,
	onCommit,
}: {
	settingId: SettingRowId;
	title: string;
	description: string;
	help: string;
	placeholder: string;
	values: readonly string[];
	/** Whether normalization dropped or rewrote raw entries the push cannot carry; forces the read-only fallback. */
	lossy: boolean;
	maxLength: number;
	maxCount: number;
	countProblem: (max: number) => string;
	lengthProblem: (max: number) => string;
	configuredScope: SettingScope | null;
	hidden: boolean;
	onCommit: (values: readonly string[]) => void;
}) {
	const externalText = values.join(", ");
	const [text, setText] = useState(externalText);
	const syncKey = `${values.join(",")}@${configuredScope ?? "default"}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on syncKey alone; the external text is read at sync time, not watched
	useEffect(() => {
		setText(externalText);
	}, [syncKey]);

	const parsed = [
		...new Set(
			text
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0)
		),
	];
	const error =
		parsed.length > maxCount
			? countProblem(maxCount)
			: parsed.some((entry) => entry.length > maxLength)
				? lengthProblem(maxLength)
				: undefined;
	const commit = () => {
		if (error !== undefined) {
			return;
		}
		if (parsed.join(",") !== values.join(",")) {
			onCommit(parsed);
		}
	};

	const inputId = `setting-${settingId}`;
	const errorId = `${inputId}-error`;
	const custom = commaListCustom(values, lossy);
	return (
		<SettingRow
			settingId={settingId}
			title={title}
			titleFor={custom ? undefined : inputId}
			description={description}
			help={help}
			error={custom ? undefined : error}
			errorId={errorId}
			configuredScope={configuredScope}
			hidden={hidden}
			control={
				custom ? (
					<>
						<span className="font-mono">{values.join(", ")}</span>
						<span className="hint">{l10n.t("Custom list - edit in settings.json.")}</span>
					</>
				) : (
					<Input
						id={inputId}
						type="text"
						spellCheck={false}
						// Full control-column width: lists grow sideways. The 20rem cap IS the control
						// column, stated on the input so the stacked tier keeps the same width policy (one
						// track there means max-w-full is the whole pane).
						className="w-full max-w-[20rem]"
						aria-invalid={error !== undefined}
						aria-describedby={error === undefined ? undefined : errorId}
						placeholder={placeholder}
						value={text}
						onChange={(event) => setText(event.currentTarget.value)}
						onBlur={() => commit()}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								commit();
							}
						}}
					/>
				)
			}
		/>
	);
}

export function SettingGroup({
	title,
	help,
	note,
	numbers,
	booleans,
	settings,
	isVisible,
	booleanMeta,
	tail,
	tailVisible,
}: {
	title: () => string;
	help?: (() => string) | undefined;
	/**
	 * A standing annotation seated on the heading line, after the help glyph (the
	 * Features page's Coming soon badge). The frame only SEATS it; which mark the
	 * annotation wears is the page's own decision, so this file mints no second
	 * badge or pill vocabulary.
	 */
	note?: (() => ReactNode) | undefined;
	numbers: readonly NumberSettingId[];
	booleans: readonly BooleanSettingId[];
	settings: SettingsSlice;
	/** The filter's verdict per row; a group whose rows are all hidden collapses whole (heading included). */
	isVisible: (id: NumberSettingId | BooleanSettingId) => boolean;
	/** Status content replacing specific boolean rows' descriptions (the catalog row's cluster). */
	booleanMeta?: Partial<Record<BooleanSettingId, ReactNode>>;
	/** Rows appended after the scalar rows (the Usage group's enum and list rows). */
	tail?: ReactNode;
	/** Whether anything beyond the scalar rows survives the filter (tail rows); keeps the heading alive for it. */
	tailVisible?: boolean;
}) {
	const empty = numbers.every((id) => !isVisible(id)) && booleans.every((id) => !isVisible(id)) && tailVisible !== true;
	return (
		// The middle subgrid layer: the group hands .settings-groups' tracks down
		// to its rows and spans them itself (dashboard.css .settings-group).
		<div className="settings-group mt-6" hidden={empty}>
			{/* Sentence case, not an all-caps eyebrow: the group heading separates by weight, space,
			    and the hairline. Full-strength foreground - the nested record editors head themselves
			    at muted 600, and a parent that matches its children ranks nothing. */}
			{/* The glyph is the heading's sibling, not its child: a button nested inside a heading
			    folds its accessible name into the heading's. The rule and spacing belong to the
			    line, so they sit on the wrapper. */}
			<div className="settings-group-head mt-0 mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-border border-b pb-1">
				<h3 className="settings-group-title m-0 font-semibold text-[0.95em]">{title()}</h3>
				{/* Behind the glyph, not above the rows: a group's explanation is read once, and a
				    standing paragraph costs every later visit space while telling a returning reader
				    nothing. */}
				{help !== undefined ? <Help text={help()} name={l10n.t("Help: {0}", title())} /> : null}
				{note !== undefined ? note() : null}
			</div>
			{numbers.map((id) => (
				<NumberField
					key={id}
					id={id}
					value={settings.numbers[id]}
					configuredScope={settings.configuredScopes.numbers[id]}
					hidden={!isVisible(id)}
				/>
			))}
			{booleans.map((id) => (
				<BooleanField
					key={id}
					id={id}
					value={settings.booleans[id]}
					configuredScope={settings.configuredScopes.booleans[id]}
					hidden={!isVisible(id)}
					meta={booleanMeta?.[id]}
				/>
			))}
			{tail}
		</div>
	);
}

/** The slice of DashboardSettings the group frame reads; both pages' settings satisfy it. */
interface SettingsSlice {
	readonly numbers: Readonly<Record<NumberSettingId, number | null>>;
	readonly booleans: Readonly<Record<BooleanSettingId, boolean>>;
	readonly configuredScopes: {
		readonly numbers: Readonly<Record<NumberSettingId, SettingScope | null>>;
		readonly booleans: Readonly<Record<BooleanSettingId, SettingScope | null>>;
	};
}

/**
 * One scalar row's searchable text: the two lines the row shows - except the catalog
 * row, whose slot shows the status cluster; the settings page matches it on live status
 * and tip.
 */
export function scalarText(id: NumberSettingId | BooleanSettingId): { label: string; description: string } {
	return Object.hasOwn(NUMBER_SETTING_SPECS, id)
		? numberSettingPresentation(id as NumberSettingId)
		: booleanSettingPresentation(id as BooleanSettingId);
}
