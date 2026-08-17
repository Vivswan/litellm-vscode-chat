/**
 * The Settings tab: every scalar setting as one row over the same configuration the
 * Settings editor writes - two views of one file, never two stores. Every row shares one
 * full-bleed anatomy; the explanation column is where a row states a problem (the error
 * takes the hint's place, so the form's height never changes while you type), and mark,
 * reveal, and reset are the same three gestures on every kind of row.
 */

import * as l10n from "@vscode/l10n";
import type { FocusEvent, ReactNode } from "react";
import { createContext, useContext, useEffect, useId, useState } from "react";
import type { SettingWriteMethod } from "../../dashboard/endpoints";
import { SETTING_WRITE_METHODS, WIRE_LIMITS } from "../../dashboard/endpoints";
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
import type {
	CatalogStatusView,
	DashboardModel,
	DashboardSettings,
	SettingRowId,
	SettingScope,
	UsageStatusBarModeSetting,
} from "../../dashboard/viewModels";
import { BOOLEAN_SETTING_IDS, NUMBER_SETTING_IDS } from "../../dashboard/viewModels";
import type {
	BooleanSettingId,
	NumberSettingId,
	TokenEstimationMode,
	UiAccent,
	UiTheme,
} from "../../shared/config/settingSpec";
import { NUMBER_SETTING_SPECS, TOKEN_ESTIMATION_MODES, UI_ACCENTS, UI_THEMES } from "../../shared/config/settingSpec";
import { statusErrorHeadline } from "../../shared/util/errorText";
import { useAlertOnce } from "./announceOnce";
import { DOCS_LINK_OPENROUTER_CATALOG, DOCS_LINK_SETTINGS } from "./docsLinks";
import { FailureText } from "./failureText";
import { DocsLink, Help, NoBreakTail } from "./help";
import {
	helpCurrencySymbol,
	helpImportExportGroup,
	helpModelCapabilitiesSection,
	helpModelParametersSection,
	helpSettingsSection,
	helpTokenEstimation,
	helpToolSchemaKeywords,
	helpUiAccent,
	helpUiTheme,
	helpUsageStatusBar,
	helpUsageThresholds,
	settingRowHelp,
} from "./helpText";
import { IconBraces } from "./icons";
import type { ExternalRecordEdit } from "./recordEditors";
import {
	ModelCapabilitiesEditor,
	ModelParametersEditor,
	modelCapabilitiesTitle,
	modelParametersTitle,
} from "./recordEditors";
import { relativeTime } from "./time";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { cn } from "./ui/cn";
import { Input } from "./ui/input";
import { Radio } from "./ui/radio";
import { Reveal } from "./ui/reveal";
import { Section } from "./ui/section";
import { Select } from "./ui/select";
import { sendRequest } from "./vscodeApi";

/**
 * The inspectors' configure-jump into one of this tab's record editors: which editor plus
 * the ExternalRecordEdit it applies. Minted by App; the seq keys re-delivery.
 */
export interface EditRecordRequest extends ExternalRecordEdit {
	readonly kind: "parameters" | "capabilities";
}

/**
 * One standing write failure as this page places it; App projects its store entry into
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
const SettingFailuresContext = createContext<Partial<Record<SettingRowId, SettingWriteFailure>>>({});

/** The one frame every misplaced-write notice wears, row-level and fallback alike. */
function writeFailureText(failure: SettingWriteFailure): ReactNode {
	return (
		<FailureText
			message={failure.message}
			frame={(headline) => l10n.t("The last change did not apply: {0}", headline)}
		/>
	);
}

/**
 * The form's grouping and order, most-touched first. Presentation only: anything not
 * placed here still renders in a trailing "Other" group, so a new setting can never
 * silently vanish. Titles are zero-arg functions so localized text resolves at render.
 */
const SETTING_GROUPS: readonly {
	readonly title: () => string;
	readonly numbers: readonly NumberSettingId[];
	readonly booleans: readonly BooleanSettingId[];
}[] = [
	// The manifest's section order (Servers carries no scalar settings).
	{ title: () => l10n.t("Models"), numbers: [], booleans: ["models.openRouterCatalog"] },
	{
		title: () => l10n.t("Chat"),
		numbers: ["chat.timeout", "chat.maxToolsPerRequest"],
		booleans: ["chat.promptCaching"],
	},
	{
		title: () => l10n.t("Discovery"),
		numbers: ["discovery.timeout", "discovery.cacheTtl", "discovery.staleServeWindow"],
		booleans: [],
	},
	{
		title: () => l10n.t("Usage"),
		numbers: [
			"usage.pollInterval",
			"usage.initialRefreshDelay",
			"usage.serversChangeRefreshDelay",
			"usage.pollingOffFreshnessWindow",
		],
		booleans: [],
	},
	{ title: () => l10n.t("UI"), numbers: [], booleans: ["ui.maskSecretInputs"] },
];

/**
 * The one row template every row obeys. The geometry lives in dashboard.css (.setting-row
 * and its band rules, beside .settings-groups); this name is the pointer.
 */
const SETTING_ROW_GRID = "setting-row";

/**
 * The wide tier's shared tracks, owned by dashboard.css .settings-groups (rows adopt them
 * through subgrid); this name is the pointer.
 */
const SETTING_GRID_TRACKS = "settings-groups";

/**
 * The label cell. Its alignment, growth cap, and corner reserves live in dashboard.css
 * .setting-title; a constant because the row renders the label as `label` or `span`.
 */
const SETTING_TITLE = "setting-title font-semibold";

/**
 * The settings.json jump every row carries, in the trailing actions slot with Reset,
 * hover- and focus-revealed (the shared Reveal idiom), so a resting row is label,
 * control, and explanation and nothing else.
 */
function RevealButton({ title, settingId }: { title: string; settingId: SettingRowId }) {
	return (
		<Reveal within="setting">
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
 * NoBreakTail glue. ONE mount for every state of the row: the covered and resting texts
 * swap around it, so keyboard focus on the "?" survives an overlay landing or clearing.
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
 * One settings row: a configured row wears the modified accent in the gutter (the border
 * is always there, transparent when clean, so marking never shifts it) and offers the
 * Reset for exactly that scope. The filter hides rows via the hidden attribute, never by
 * unmounting: a half-typed draft must survive being filtered away and back.
 */
function SettingRow({
	settingId,
	title,
	titleFor,
	description,
	help,
	control,
	error,
	errorId,
	defaultText,
	configuredScope,
	hidden,
	hintClassName,
	compactControl,
}: {
	settingId: SettingRowId;
	title: string;
	/** The id of the control the label points at; omitted where clicking the title must not write a setting. */
	titleFor?: string | undefined;
	description: ReactNode;
	help?: string | undefined;
	control: ReactNode;
	/** Replaces the description while it stands, so the row's height never changes as you type. */
	error?: string | undefined;
	errorId?: string;
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
}) {
	// The standing failure of this row's last write, rendered in the covered-description slot
	// like the parse errors (an inserted block used to move every row below). HEADLINE only:
	// the detail line is arbitrary-length and the covering contract keeps the cell's height.
	// A live parse error outranks it (it describes the draft under the user's fingers);
	// the failure resurfaces when the draft parses clean again.
	const writeFailure = useContext(SettingFailuresContext)[settingId];
	// Announced once per failure seq. The seq reaches the hook only while this branch
	// actually renders: fed unconditionally, a failure landing behind a parse error was
	// marked spoken with no visible line having spoken it, and surfaced silent later.
	const writeFailureRole = useAlertOnce(error === undefined ? writeFailure?.seq : undefined);
	const failureText =
		writeFailure === undefined
			? undefined
			: l10n.t("The last change did not apply: {0}", statusErrorHeadline(writeFailure.message));
	const covered = error !== undefined || failureText !== undefined;
	// The resting flow, rendered twice while covered: once invisible as the cell's height
	// twin, once nowhere - only the covering error and the row's one glyph paint. An
	// AT-REST note precedes the glyph, so the "?" stays the resting description's last
	// element; the hover-only User-scope note (or its spacing twin) trails it.
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
				compactControl === true && "setting-compact"
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
			<div className="setting-control flex flex-wrap items-center gap-2">{control}</div>
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
				<span className="setting-live">
					{/* The slot's visible tenant. The .error span holds ONLY the message and keeps the
					    id: aria-describedby reads the referenced subtree, and a glyph inside it would
					    ride every announcement of the field's problem. The write-failure cover is
					    keyed on the seq so a repeat re-mounts and announces afresh (useAlertOnce
					    dedupes to one announcement per seq); the glyph is its sibling and outlives
					    the remount. */}
					{error !== undefined ? (
						<span className="setting-cover">
							<span className="error" id={errorId}>
								{error}
							</span>
						</span>
					) : failureText !== undefined && writeFailure !== undefined ? (
						<span key={writeFailure.seq} className="setting-cover">
							<span className="error" role={writeFailureRole}>
								{failureText}
							</span>
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
			</div>
			{/* The row's one actions slot: Reset then the settings.json jump, always last (the
			    anatomy's fourth track; placement per band in dashboard.css .setting-actions).
			    gap-4.5 is ink-to-ink (compact buttons hand their padding back). */}
			<div className="setting-actions flex items-center justify-end gap-4.5 self-start justify-self-end">
				{configuredScope !== null ? <ResetButton title={title} scope={configuredScope} settingId={settingId} /> : null}
				<RevealButton title={title} settingId={settingId} />
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
 * The catalog row's status text, one place for the row AND the filter: the row shows
 * exactly these strings and the filter matches on them, so a needle always finds the
 * row that visibly says it (the non-scalar description functions' no-drift rule).
 */
function catalogStatusParts(
	catalog: CatalogStatusView,
	enabled: boolean,
	now: number
): { readonly off?: string; readonly summary?: string; readonly failure?: string | undefined } {
	if (!enabled) {
		return { off: l10n.t("Catalog off: no refreshes and no implicit ID matching.") };
	}
	const updated =
		catalog.lastSuccessAt !== undefined
			? (relativeTime(new Date(catalog.lastSuccessAt).toISOString(), now) ?? l10n.t("just now"))
			: undefined;
	const count = catalog.modelCount === 1 ? l10n.t("1 catalog model") : l10n.t("{0} catalog models", catalog.modelCount);
	const age = updated !== undefined ? l10n.t("updated {0}", updated) : l10n.t("bundled snapshot");
	return {
		summary: `${count} - ${age}`,
		// The classification is a fixed English vocabulary ("HTTP 503",
		// "network error"), protocol-ish like header names.
		failure:
			catalog.lastFailure !== undefined
				? l10n.t("Last refresh failed ({0}); serving the cached snapshot.", catalog.lastFailure.classification)
				: undefined,
	};
}

/**
 * The OpenRouter catalog row's status cluster (docs/dashboard.md#settings), in the row's
 * description slot: snapshot size and age, Refresh, a standing failure on its own line -
 * never a toast - and a short inert line while off. The prose lives in the row's "?".
 */
function CatalogMeta({ catalog, enabled, now }: { catalog: CatalogStatusView; enabled: boolean; now: number }) {
	const parts = catalogStatusParts(catalog, enabled, now);
	if (parts.off !== undefined) {
		return <span className="catalog-status">{parts.off}</span>;
	}
	return (
		// Plain inline flow, not inline-flex: an atomic inline-flex box takes the whole column
		// the moment it wraps, stranding the trailing "?" alone on the line below.
		<span className="catalog-status">
			<span>{parts.summary}</span>{" "}
			<Button
				variant="secondary"
				size="compact"
				className="mx-2"
				disabled={catalog.refreshing}
				onClick={() => sendRequest("refreshCatalog", null)}
			>
				{catalog.refreshing ? (
					<>
						<span className="spinner" aria-hidden="true" /> {l10n.t("Refreshing...")}
					</>
				) : (
					l10n.t("Refresh")
				)}
			</Button>{" "}
			<DocsLink href={DOCS_LINK_OPENROUTER_CATALOG} label={l10n.t("Open the OpenRouter catalog guide")} />
			{parts.failure !== undefined ? (
				<>
					{/* The break gives the failure a line start of its own without
					    jamming red text beside Refresh, while the error itself stays
					    INLINE: a block box would break after itself too and strand
					    the row's trailing "?" alone on the next line. */}
					<br />
					<span className="error">{parts.failure}</span>
				</>
			) : null}
		</span>
	);
}

/**
 * The non-scalar rows' descriptions, held here because the filter matches on them exactly
 * as it does scalar descriptions: visible text and filter text must not drift.
 */
function usageStatusBarDescription(): string {
	// What the shown number means lives in the row's "?" (helpUsageStatusBar).
	return l10n.t("When the spend status bar item shows.");
}

function tokenEstimationDescription(): string {
	return l10n.t("How prompts are sized for the local token budget.");
}

function toolSchemaKeywordsDescription(): string {
	// The example lives in the input's own placeholder, one column to the left.
	return l10n.t("Extra JSON-Schema keywords kept in tool definitions.");
}

/**
 * The thresholds row's explanation per branch: the read-only custom branch renders no
 * fields, so "clear both fields" would instruct gestures the row cannot take.
 * Branch-keyed because the filter matches the same text the row shows.
 */
function usageThresholdsDescription(custom: boolean): string {
	return custom
		? l10n.t("Alerts fire as spend crosses each value.")
		: l10n.t("The lower value warns, the higher errors.");
}

function currencySymbolDescription(): string {
	return l10n.t('Prefix on every spend and price figure, e.g. "EUR ".');
}

function uiThemeDescription(): string {
	// The Auto option names its own behavior ("Follow the editor"), and the
	// row's "?" (helpUiTheme) states it with the high-contrast exception.
	return l10n.t("Whether the dashboard renders light or dark.");
}

function uiAccentDescription(): string {
	return l10n.t("Marks primary actions, selection, focus and links.");
}

/** The usage.statusBar mode names, resolved at call time (no module-level localized constants). */
function statusBarModeLabel(mode: UsageStatusBarModeSetting): string {
	switch (mode) {
		case "always":
			return l10n.t("Always shown");
		case "alerts-only":
			return l10n.t("Only while a threshold is crossed");
		case "off":
			return l10n.t("Never shown");
	}
}

const USAGE_STATUS_BAR_MODES: readonly UsageStatusBarModeSetting[] = ["always", "alerts-only", "off"];

/** The chat.tokenEstimation mode names, resolved at call time (no module-level localized constants). */
function tokenEstimationLabel(mode: TokenEstimationMode): string {
	switch (mode) {
		case "auto":
			return l10n.t("Auto - tokenizer when text needs it");
		case "heuristic":
			return l10n.t("Heuristic - 4 characters per token");
		// The encoding names are protocol terms and stay untranslated; the
		// parenthetical says which model families they meter.
		case "o200k_base":
			return l10n.t("o200k_base tokenizer (GPT-4o and newer)");
		case "cl100k_base":
			return l10n.t("cl100k_base tokenizer (GPT-4 era)");
	}
}

/** The ui.theme names, resolved at call time (no module-level localized constants). */
function uiThemeLabel(theme: UiTheme): string {
	switch (theme) {
		case "auto":
			return l10n.t("Follow the editor");
		case "light":
			return l10n.t("Always light");
		case "dark":
			return l10n.t("Always dark");
	}
}

/**
 * Any closed-vocabulary setting as a select. One component rather than one per enum:
 * near-copies drift, and a third enum setting should cost a call, not a component.
 */
function EnumSettingRow<T extends string>({
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

/** Every hue's swatch fill, from the tokens theme.css defines the accent itself with. */
const ACCENT_SWATCH_CLASS: Readonly<Record<UiAccent, string>> = {
	blue: "bg-hue-blue",
	violet: "bg-hue-violet",
	teal: "bg-hue-teal",
	amber: "bg-hue-amber",
};

function uiAccentLabel(accent: UiAccent): string {
	switch (accent) {
		case "blue":
			return l10n.t("Blue - your theme's own button color");
		case "violet":
			return l10n.t("Violet");
		case "teal":
			return l10n.t("Teal");
		case "amber":
			return l10n.t("Amber");
	}
}

/**
 * The ui.accent row: four swatches, because the choice IS the color. Native radios carry
 * semantics and keyboard; the visible swatch is their label, ringed when checked and
 * when the hidden input takes focus.
 */
function UiAccentRow({
	accent,
	configuredScope,
	hidden,
}: {
	accent: UiAccent;
	configuredScope: SettingScope | null;
	hidden: boolean;
}) {
	const title = l10n.t("Accent color");
	return (
		<SettingRow
			settingId="ui.accent"
			title={title}
			description={uiAccentDescription()}
			help={helpUiAccent()}
			configuredScope={configuredScope}
			hidden={hidden}
			control={
				<div className="flex gap-2" role="radiogroup" aria-label={title}>
					{UI_ACCENTS.map((candidate) => (
						<label
							key={candidate}
							// The checked ring is the foreground, not the accent: a violet
							// ring around the violet swatch is not a selection marker.
							className="cursor-pointer rounded-full p-0.5 outline-offset-1 has-[:checked]:outline-1 has-[:checked]:outline-foreground has-[:checked]:outline-solid has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-ring has-[:focus-visible]:outline-solid"
						>
							<Radio
								className="sr-only"
								name="ui-accent"
								value={candidate}
								checked={accent === candidate}
								aria-label={uiAccentLabel(candidate)}
								onChange={() => sendRequest("setUiAccent", { value: candidate })}
							/>
							{/* forced-color-adjust: the swatch IS the information, so it keeps
								its own color where the OS would repaint all four identically. */}
							<span
								aria-hidden="true"
								className={cn("block size-4 rounded-full forced-color-adjust-none", ACCENT_SWATCH_CLASS[candidate])}
							/>
						</label>
					))}
				</div>
			}
		/>
	);
}

/** A stored fraction as the percent text the threshold inputs display, float noise trimmed. */
function percentText(value: number): string {
	return `${Number((value * 100).toPrecision(12))}%`;
}

/**
 * One threshold box's parse: a fraction (0.8), a percentage (80%), or a bare number
 * above 1 read as percent. The docs' bound applies after conversion: (0, 1].
 */
function parseThresholdBox(
	text: string
): { readonly kind: "empty" } | { readonly kind: "value"; readonly value: number } | { readonly kind: "invalid" } {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return { kind: "empty" };
	}
	const percent = trimmed.endsWith("%");
	const numberText = percent ? trimmed.slice(0, -1).trim() : trimmed;
	const parsed = Number(numberText);
	if (numberText.length === 0 || !Number.isFinite(parsed)) {
		return { kind: "invalid" };
	}
	const value = percent || parsed > 1 ? parsed / 100 : parsed;
	if (!(value > 0 && value <= 1)) {
		return { kind: "invalid" };
	}
	return { kind: "value", value };
}

/** One of the two threshold inputs with its trailing label; error and hint lines render at the row level. */
function ThresholdBox({
	id,
	label,
	text,
	invalid,
	errorId,
	placeholder,
	onText,
	onCommit,
}: {
	id: string;
	label: string;
	text: string;
	invalid: boolean;
	errorId: string;
	placeholder: string;
	onText: (next: string) => void;
	/** Blur (with where focus went) or Enter; the row decides whether the pair commits. */
	onCommit: (event?: FocusEvent) => void;
}) {
	return (
		// One flex ITEM per pair: the wrapping control cell may break between the
		// two pairs at the 320px floor, but never inside one - loose siblings
		// wrapped as "80% warning 95%" / "error", stranding a label alone. The
		// inner gap-2 restates the cell's own, so the pair reads unchanged.
		<span className="threshold-pair flex items-center gap-2">
			<Input
				id={id}
				type="text"
				spellCheck={false}
				className="threshold-input w-[4.5rem] tabular-nums"
				aria-invalid={invalid}
				aria-describedby={invalid ? errorId : undefined}
				placeholder={placeholder}
				value={text}
				onChange={(event) => onText(event.currentTarget.value)}
				onBlur={(event) => onCommit(event)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						onCommit();
					}
				}}
			/>
			{/* The label TRAILS its input, in the unit's position, so the pair's
			    first control sits at the shared control edge like every other
			    row's - a leading label pushed the input to an x of its own.
			    Still a <label>, so clicking it focuses the box. */}
			<label className="setting-unit text-muted-foreground" htmlFor={id}>
				{label}
			</label>
		</span>
	);
}

/**
 * The usage.alertThresholds row: two inputs over the list setting. Both set writes
 * [low, high] (sorted, equal values collapse); one writes a single-element list (treated
 * as the error threshold); both empty writes [] (off). A stored list the boxes cannot
 * represent renders read-only with the reveal button, so the dashboard never destroys it.
 */
function UsageThresholdsRow({
	values,
	configuredScope,
	hidden,
}: {
	values: readonly number[];
	configuredScope: SettingScope | null;
	hidden: boolean;
}) {
	// Stored -> boxes: [low, high] fills both; a single value is the error
	// threshold by the alerts' semantics, so it fills the Error box alone.
	const externalWarning = values.length === 2 ? percentText(values[0] as number) : "";
	const externalError =
		values.length === 2
			? percentText(values[1] as number)
			: values.length === 1
				? percentText(values[0] as number)
				: "";
	const [warningText, setWarningText] = useState(externalWarning);
	const [errorText, setErrorText] = useState(externalError);
	const syncKey = `${values.join(",")}@${configuredScope ?? "default"}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on syncKey alone; the external texts are read at sync time, not watched
	useEffect(() => {
		setWarningText(externalWarning);
		setErrorText(externalError);
	}, [syncKey]);

	const warning = parseThresholdBox(warningText);
	const error = parseThresholdBox(errorText);
	const parsed =
		warning.kind === "invalid" || error.kind === "invalid"
			? undefined
			: [
					...new Set([
						...(warning.kind === "value" ? [warning.value] : []),
						...(error.kind === "value" ? [error.value] : []),
					]),
				].sort((a, b) => a - b);

	const inputId = "setting-usage.alertThresholds";
	const warningId = `${inputId}-warning`;
	const errorInputId = `${inputId}-error-at`;
	const problemId = `${inputId}-problem`;
	// The two boxes are ONE draft: a blur that only moves focus to the sibling
	// box must not commit, or the write's own state push would resync the pair
	// and overwrite what is being typed in the second box. Enter and a blur
	// leaving the pair commit.
	const commit = (event?: FocusEvent) => {
		const next = event?.relatedTarget;
		if (next instanceof HTMLElement && (next.id === warningId || next.id === errorInputId)) {
			return;
		}
		if (parsed === undefined) {
			return;
		}
		if (parsed.join(",") !== values.join(",")) {
			sendRequest("setUsageAlertThresholds", { values: parsed });
		}
	};

	const title = l10n.t("Usage alert thresholds");
	// The 3+ shape only the settings file can write; the two boxes cannot
	// round-trip it, so the row shows it instead of editing it.
	const custom = values.length > 2;
	// What the CURRENT configuration does, per branch. The custom branch reads
	// the stored list - its boxes do not exist, so their empty drafts must not
	// speak for it (they once printed "Alerts are off." beside a live list);
	// the editable branch reads the live draft the boxes hold.
	const semanticsHint = custom
		? l10n.t(
				"Warns from {0}; errors at {1}.",
				percentText(values[0] as number),
				percentText(values[values.length - 1] as number)
			)
		: parsed === undefined
			? undefined
			: parsed.length === 0
				? l10n.t("Alerts are off.")
				: parsed.length === 1
					? l10n.t("A single threshold goes straight to the error alert.")
					: undefined;
	return (
		<SettingRow
			settingId="usage.alertThresholds"
			title={title}
			titleFor={custom ? undefined : warningId}
			description={
				<>
					{usageThresholdsDescription(custom)}
					{semanticsHint !== undefined ? <span className="ml-1 text-foreground">{semanticsHint}</span> : null}
				</>
			}
			// The tip instructs the two boxes, so it renders only where they do:
			// the custom branch has no fields to enter or clear.
			help={custom ? undefined : helpUsageThresholds()}
			error={
				custom || parsed !== undefined ? undefined : l10n.t("Thresholds run from above 0% to 100%: enter 80% or 0.8.")
			}
			errorId={problemId}
			configuredScope={configuredScope}
			hidden={hidden}
			control={
				custom ? (
					<>
						<span className="font-mono tabular-nums">{values.map(percentText).join(", ")}</span>
						<span className="hint">{l10n.t("Custom list - edit in settings.json.")}</span>
					</>
				) : (
					<>
						<ThresholdBox
							id={warningId}
							label={l10n.t({
								message: "warning",
								comment: ["Trailing label after the lower usage-alert threshold input, unit-style."],
							})}
							text={warningText}
							invalid={warning.kind === "invalid"}
							errorId={problemId}
							placeholder={l10n.t("e.g. 80%")}
							onText={setWarningText}
							onCommit={commit}
						/>
						<ThresholdBox
							id={errorInputId}
							label={l10n.t({
								message: "error",
								comment: ["Trailing label after the higher usage-alert threshold input, unit-style."],
							})}
							text={errorText}
							invalid={error.kind === "invalid"}
							errorId={problemId}
							placeholder={l10n.t("e.g. 95%")}
							onText={setErrorText}
							onCommit={commit}
						/>
					</>
				)
			}
		/>
	);
}

/**
 * The usage.currencySymbol row. maxLength gates typing only: a longer symbol hand-written
 * in settings.json round-trips into the box, and the row must neither truncate it nor
 * let a commit die as a generic envelope failure - an over-limit draft shows the bound
 * (WIRE_LIMITS.currencySymbol, which the intent schema also reads) and never commits.
 * Clearing commits the empty string; commits on Enter or blur.
 */
function CurrencySymbolRow({
	value,
	configuredScope,
	hidden,
}: {
	value: string;
	configuredScope: SettingScope | null;
	hidden: boolean;
}) {
	const [text, setText] = useState(value);
	const syncKey = `${value}@${configuredScope ?? "default"}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on syncKey alone; the external value is read at sync time, not watched
	useEffect(() => {
		setText(value);
	}, [syncKey]);
	const inputId = "setting-usage.currencySymbol";
	const errorId = `${inputId}-error`;
	const error =
		text.length > WIRE_LIMITS.currencySymbol
			? l10n.t("At most {0} characters.", WIRE_LIMITS.currencySymbol)
			: undefined;
	const commit = () => {
		if (error === undefined && text !== value) {
			sendRequest("setCurrencySymbol", { value: text });
		}
	};
	return (
		<SettingRow
			settingId="usage.currencySymbol"
			title={l10n.t("Currency symbol")}
			titleFor={inputId}
			description={currencySymbolDescription()}
			help={helpCurrencySymbol()}
			error={error}
			errorId={errorId}
			configuredScope={configuredScope}
			hidden={hidden}
			control={
				<Input
					id={inputId}
					type="text"
					spellCheck={false}
					className="w-[4.5rem]"
					maxLength={WIRE_LIMITS.currencySymbol}
					placeholder="$"
					aria-invalid={error !== undefined}
					aria-describedby={error === undefined ? undefined : errorId}
					value={text}
					onChange={(event) => setText(event.currentTarget.value)}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							commit();
						}
					}}
				/>
			}
		/>
	);
}

/**
 * The intent schema's bounds, mirrored (intentSchema.ts: z.array(z.string().max(256))
 * .max(64)): a paste the host would reject is refused here with a reason instead of
 * surfacing as a generic envelope failure.
 */
const TOOL_SCHEMA_KEYWORD_MAX_LENGTH = 256;
const TOOL_SCHEMA_KEYWORD_MAX_COUNT = 64;

/**
 * The chat.additionalToolSchemaKeywords row: one comma-separated input. A draft past the
 * intent schema's bounds shows the bound and never commits. A stored list the box cannot
 * round-trip (comma or edge whitespace in an entry, or lossy raw values) renders
 * read-only with the reveal button, so the dashboard never destroys it.
 */
function ToolSchemaKeywordsRow({
	values,
	lossy,
	configuredScope,
	hidden,
}: {
	values: readonly string[];
	/** Whether normalization dropped raw entries the push cannot carry; forces the read-only fallback. */
	lossy: boolean;
	configuredScope: SettingScope | null;
	hidden: boolean;
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
				.map((keyword) => keyword.trim())
				.filter((keyword) => keyword.length > 0)
		),
	];
	const error =
		parsed.length > TOOL_SCHEMA_KEYWORD_MAX_COUNT
			? l10n.t("At most {0} keywords.", TOOL_SCHEMA_KEYWORD_MAX_COUNT)
			: parsed.some((keyword) => keyword.length > TOOL_SCHEMA_KEYWORD_MAX_LENGTH)
				? l10n.t("Keywords run up to {0} characters each.", TOOL_SCHEMA_KEYWORD_MAX_LENGTH)
				: undefined;
	const commit = () => {
		if (error !== undefined) {
			return;
		}
		if (parsed.join(",") !== values.join(",")) {
			sendRequest("setAdditionalToolSchemaKeywords", { values: parsed });
		}
	};

	const title = l10n.t("Extra tool schema keywords");
	const inputId = "setting-chat.additionalToolSchemaKeywords";
	const errorId = `${inputId}-error`;
	// The comma-separated box cannot round-trip an entry that holds a comma or
	// edge whitespace, and the lossy flag covers what the normalized push
	// cannot show at all; only the settings file can write either.
	const custom = lossy || values.some((keyword) => keyword.includes(",") || keyword !== keyword.trim());
	return (
		<SettingRow
			settingId="chat.additionalToolSchemaKeywords"
			title={title}
			titleFor={custom ? undefined : inputId}
			description={toolSchemaKeywordsDescription()}
			help={helpToolSchemaKeywords()}
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
						// Full control-column width: keyword lists grow sideways. The 20rem cap IS the control
						// column, stated on the input so the stacked tier keeps the same width policy (one
						// track there means max-w-full is the whole pane).
						className="w-full max-w-[20rem]"
						aria-invalid={error !== undefined}
						aria-describedby={error === undefined ? undefined : errorId}
						placeholder={l10n.t("e.g. propertyNames, patternProperties")}
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

function SettingGroup({
	title,
	help,
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
	numbers: readonly NumberSettingId[];
	booleans: readonly BooleanSettingId[];
	settings: DashboardSettings;
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

/**
 * Where scalar edits land, for the header's meta line: User settings, except a setting
 * the workspace already sets is changed there (the write-scope rule).
 */
function scopeSummary(scopes: readonly (SettingScope | null)[]): string {
	return scopes.some((scope) => scope === "workspace")
		? l10n.t("editing User settings; a value set in Workspace settings is changed there")
		: l10n.t("editing User settings");
}

/** Every row's configured scope, in one list: the meta line counts and summarizes over it. */
function configuredScopes(settings: DashboardSettings): readonly (SettingScope | null)[] {
	return [
		...Object.values(settings.configuredScopes.numbers),
		...Object.values(settings.configuredScopes.booleans),
		settings.chat.tokenEstimationScope,
		settings.chat.additionalToolSchemaKeywordsScope,
		settings.usage.statusBarScope,
		settings.usage.thresholdsScope,
		settings.usage.currencySymbolScope,
		settings.appearance.themeScope,
		settings.appearance.accentScope,
	];
}

/**
 * One scalar row's searchable text: the two lines the row shows - except the catalog
 * row, whose slot shows the status cluster; isVisible matches it on live status and tip.
 */
function scalarText(id: NumberSettingId | BooleanSettingId): { label: string; description: string } {
	return Object.hasOwn(NUMBER_SETTING_SPECS, id)
		? numberSettingPresentation(id as NumberSettingId)
		: booleanSettingPresentation(id as BooleanSettingId);
}

/**
 * Whether a record editor matches the filter: by its heading, its own header help, or
 * any key it holds in any scope (plus modelParameters' nested parameter names). Store
 * keys only, deliberately: a dirty draft lives inside the editor, which the filter
 * hides but never unmounts.
 */
function recordEditorMatches(
	needle: string,
	title: string,
	help: string,
	scoped: {
		readonly value: Readonly<Record<string, unknown>>;
		readonly otherScopes: readonly { readonly value: Readonly<Record<string, unknown>> }[];
	}
): boolean {
	if (title.toLowerCase().includes(needle) || help.toLowerCase().includes(needle)) {
		return true;
	}
	const records = [scoped.value, ...scoped.otherScopes.map((other) => other.value)];
	return records.some((record) =>
		Object.entries(record).some(
			([key, entry]) =>
				key.toLowerCase().includes(needle) ||
				(entry !== null &&
					typeof entry === "object" &&
					Object.keys(entry).some((param) => param.toLowerCase().includes(needle)))
		)
	);
}

export function SettingsSection({
	settings,
	models,
	observedModelInfoKeys,
	now,
	editRecordRequest,
	writeFailures,
}: {
	settings: DashboardSettings;
	models: readonly DashboardModel[];
	/** The cross-server observed /model/info key union (DashboardState.observedModelInfoKeys), the capability editor's hint evidence. */
	observedModelInfoKeys?: readonly string[] | undefined;
	/** The shared clock tick; the catalog row's "updated N ago" reads it. */
	now?: number;
	/** The inspectors' configure-jump into one of the record editors; see EditRecordRequest. */
	editRecordRequest?: EditRecordRequest | undefined;
	/** The standing scalar-write failures from App's store, for this page to place by owning row. */
	writeFailures?: Partial<Record<SettingWriteMethod, SettingWriteFailure>> | undefined;
}) {
	const [filter, setFilter] = useState("");
	const filterId = useId();
	// A jump must land on a visible editor: a leftover filter that hides the
	// target section would swallow the focus, so the request clears it.
	const editSeq = editRecordRequest?.seq;
	useEffect(() => {
		if (editSeq !== undefined) {
			setFilter("");
		}
	}, [editSeq]);
	const needle = filter.trim().toLowerCase();
	const matches = (...haystack: string[]): boolean =>
		needle.length === 0 || haystack.some((text) => text.toLowerCase().includes(needle));
	// One clock reading for the whole render: the filter haystack and the
	// rendered status cluster must speak the same age - two Date.now() calls
	// straddling a minute boundary would let a needle match "5 min ago" while
	// the row shows 6.
	const nowMs = now ?? Date.now();
	// Row-level help is in a row's haystack: the "?" is visible at rest and its tip carries
	// the matching words, so a reader can see why the row survived. The catalog row's
	// haystack is what that row SHOWS - its static description renders nowhere, and a
	// translated bundle renders the two keys independently, so only excluding it keeps
	// "the haystack holds what the row shows" true in every locale.
	const catalogTexts = Object.values(
		catalogStatusParts(settings.catalog, settings.booleans["models.openRouterCatalog"], nowMs)
	).filter((text): text is string => text !== undefined);
	const isVisible = (id: NumberSettingId | BooleanSettingId): boolean => {
		const { label, description } = scalarText(id);
		if (id === "models.openRouterCatalog") {
			return matches(label, id, settingRowHelp(id) ?? "", ...catalogTexts);
		}
		return matches(label, description, id, settingRowHelp(id) ?? "");
	};

	const placed = new Set<string>(SETTING_GROUPS.flatMap((group) => [...group.numbers, ...group.booleans]));
	const otherNumbers = NUMBER_SETTING_IDS.filter((id) => !placed.has(id));
	const otherBooleans = BOOLEAN_SETTING_IDS.filter((id) => !placed.has(id));

	const paramsVisible =
		needle.length === 0 ||
		recordEditorMatches(needle, modelParametersTitle(), helpModelParametersSection(), settings.modelParameters);
	const capsVisible =
		needle.length === 0 ||
		recordEditorMatches(needle, modelCapabilitiesTitle(), helpModelCapabilitiesSection(), settings.modelCapabilities);
	const anyScalarVisible = [...NUMBER_SETTING_IDS, ...BOOLEAN_SETTING_IDS].some(isVisible);
	// The non-scalar rows filter by the same rule as the scalar ones, so a needle cannot
	// find one kind and miss the other. Hoisted because the empty-state verdict below has
	// to see them: a filter matching only a tail row once rendered it under "nothing matched".
	const statusBarVisible = matches(
		l10n.t("Usage status bar"),
		usageStatusBarDescription(),
		"usage.statusBar",
		helpUsageStatusBar()
	);
	const tokenEstimationVisible = matches(
		l10n.t("Token estimation"),
		tokenEstimationDescription(),
		"chat.tokenEstimation",
		helpTokenEstimation()
	);
	const toolSchemaKeywordsVisible = matches(
		l10n.t("Extra tool schema keywords"),
		toolSchemaKeywordsDescription(),
		"chat.additionalToolSchemaKeywords",
		helpToolSchemaKeywords()
	);
	const thresholdsCustom = settings.usage.alertThresholds.length > 2;
	// The editable branch's help joins its haystack only while that branch
	// renders it: a needle from the tip must not keep the custom row alive.
	const thresholdsVisible = matches(
		l10n.t("Usage alert thresholds"),
		usageThresholdsDescription(thresholdsCustom),
		"usage.alertThresholds",
		...(thresholdsCustom ? [] : [helpUsageThresholds()])
	);
	const currencyVisible = matches(
		l10n.t("Currency symbol"),
		currencySymbolDescription(),
		"usage.currencySymbol",
		helpCurrencySymbol()
	);
	const themeVisible = matches(l10n.t("Dashboard theme"), uiThemeDescription(), "ui.theme", helpUiTheme());
	const accentVisible = matches(l10n.t("Accent color"), uiAccentDescription(), "ui.accent", helpUiAccent());
	// The Import & Export group filters like a scalar row (title and button labels). Its
	// help stays OUT of the haystack even though row-level help is in: a group matched
	// through group help would stand with no row in it matching - the reader scans the
	// surviving rows and finds the needle in none. Section-level help is out likewise.
	const importExportVisible =
		needle.length === 0 ||
		[l10n.t("Import & Export"), l10n.t("Export settings"), l10n.t("Import settings")].some((text) =>
			text.toLowerCase().includes(needle)
		);
	const nothingMatches =
		!anyScalarVisible &&
		!paramsVisible &&
		!capsVisible &&
		!importExportVisible &&
		!statusBarVisible &&
		!tokenEstimationVisible &&
		!toolSchemaKeywordsVisible &&
		!thresholdsVisible &&
		!currencyVisible &&
		!themeVisible &&
		!accentVisible;
	const booleanMeta: Partial<Record<BooleanSettingId, ReactNode>> = {
		"models.openRouterCatalog": (
			<CatalogMeta catalog={settings.catalog} enabled={settings.booleans["models.openRouterCatalog"]} now={nowMs} />
		),
	};
	const scopes = configuredScopes(settings);
	const modifiedCount = scopes.filter((scope) => scope !== null).length;
	// Whether the row a failure would land on is actually on screen: the tail
	// rows carry the named verdicts above, every scalar row the shared one. A
	// hidden row still renders (the filter hides, never unmounts), so a notice
	// placed there would be claimed and invisible at once.
	const rowVisible = (row: SettingRowId): boolean => {
		switch (row) {
			case "chat.tokenEstimation":
				return tokenEstimationVisible;
			case "chat.additionalToolSchemaKeywords":
				return toolSchemaKeywordsVisible;
			case "usage.alertThresholds":
				return thresholdsVisible;
			case "usage.statusBar":
				return statusBarVisible;
			case "usage.currencySymbol":
				return currencyVisible;
			case "ui.theme":
				return themeVisible;
			case "ui.accent":
				return accentVisible;
			default:
				return isVisible(row);
		}
	};
	// Each standing failure lands by the row its fail envelope names (latest seq wins when
	// two share a row); anything unclaimed - a payload that never parsed carries no row, or
	// the owning row the filter hid - falls back to the always-visible section-top line.
	const rowFailures: Partial<Record<SettingRowId, SettingWriteFailure>> = {};
	let unclaimedFailure: SettingWriteFailure | undefined;
	for (const method of SETTING_WRITE_METHODS) {
		const failure = writeFailures?.[method];
		if (failure === undefined) {
			continue;
		}
		const row = failure.row;
		if (row !== undefined && rowVisible(row)) {
			const standing = rowFailures[row];
			if (standing === undefined || failure.seq > standing.seq) {
				rowFailures[row] = failure;
			}
		} else if (unclaimedFailure === undefined || failure.seq > unclaimedFailure.seq) {
			unclaimedFailure = failure;
		}
	}
	// One announcement per failure seq across every surface: the pane-top away
	// line may already have spoken this failure before the reader arrived here.
	const unclaimedRole = useAlertOnce(unclaimedFailure?.seq);
	return (
		<SettingFailuresContext.Provider value={rowFailures}>
			<Section
				id="settings"
				title={l10n.t("Settings")}
				help={helpSettingsSection()}
				docs={{ href: DOCS_LINK_SETTINGS, label: l10n.t("Open the settings guide") }}
				meta={[
					...(modifiedCount === 0
						? []
						: [modifiedCount === 1 ? l10n.t("1 modified") : l10n.t("{0} modified", modifiedCount)]),
					scopeSummary(scopes),
				].join(" - ")}
				actions={
					<>
						{/* The filter's one home is the header line: it governs the whole
					    page the way the header's other actions do, and a floating box
					    between the header and the first group read as belonging to
					    nothing. */}
						<Input
							id={filterId}
							type="text"
							// 16rem beside the button while the header line holds both; once the 640px strip wrap
							// gives this input its own line, w-full is what makes it BE that line.
							className="w-[16rem] @max-[640px]/pane:w-full min-w-0 max-w-full shrink"
							placeholder={l10n.t("Filter settings, e.g. timeout")}
							aria-label={l10n.t("Filter settings")}
							value={filter}
							onChange={(event) => setFilter(event.currentTarget.value)}
						/>
						<Button
							variant="secondary"
							className="whitespace-nowrap"
							onClick={() => sendRequest("executeCommand", { command: "openSettings" })}
						>
							{l10n.t("Open in Settings editor")}
						</Button>
					</>
				}
			>
				{/* The fallback for a failure no mounted row claims; a claimed one
			    renders under its own row instead (see SettingRow). */}
				{unclaimedFailure !== undefined ? (
					<p key={unclaimedFailure.seq} className="error" role={unclaimedRole}>
						{writeFailureText(unclaimedFailure)}
					</p>
				) : null}
				{nothingMatches ? <p className="empty">{l10n.t("No settings match the filter.")}</p> : null}
				{/* The wide tier's track owner (SETTING_GRID_TRACKS): groups and rows
				    subgrid onto these columns, so the label gutter is one measured
				    width for the whole page. */}
				<div className={SETTING_GRID_TRACKS}>
					{SETTING_GROUPS.map((group, index) => {
						// Four groups carry non-scalar tails, mirroring the manifest's grouping.
						const isModelsGroup = group.booleans.includes("models.openRouterCatalog");
						const isChatGroup = group.numbers.includes("chat.timeout");
						const isUsageGroup = group.numbers.includes("usage.pollInterval");
						const isUiGroup = group.booleans.includes("ui.maskSecretInputs");
						return (
							<SettingGroup
								// biome-ignore lint/suspicious/noArrayIndexKey: the group list is a fixed literal; position is the identity
								key={index}
								{...group}
								settings={settings}
								isVisible={isVisible}
								booleanMeta={booleanMeta}
								tailVisible={
									(isModelsGroup && (paramsVisible || capsVisible)) ||
									(isChatGroup && (tokenEstimationVisible || toolSchemaKeywordsVisible)) ||
									(isUsageGroup && (statusBarVisible || thresholdsVisible || currencyVisible)) ||
									(isUiGroup && (themeVisible || accentVisible))
								}
								tail={
									isModelsGroup ? (
										<div className="settings-editors min-w-0">
											{/* The editors' apply-together save model is stated by each
										    editor's own "?" (helpModelParametersSection and
										    helpModelCapabilitiesSection), not by a free-standing
										    paragraph between the rows. */}
											<ModelParametersEditor
												scoped={settings.modelParameters}
												models={models}
												hidden={!paramsVisible}
												external={editRecordRequest?.kind === "parameters" ? editRecordRequest : undefined}
											/>
											<ModelCapabilitiesEditor
												scoped={settings.modelCapabilities}
												models={models}
												observedKeys={observedModelInfoKeys}
												hidden={!capsVisible}
												external={editRecordRequest?.kind === "capabilities" ? editRecordRequest : undefined}
											/>
										</div>
									) : isChatGroup ? (
										<>
											<EnumSettingRow
												settingId="chat.tokenEstimation"
												title={l10n.t("Token estimation")}
												description={tokenEstimationDescription()}
												help={helpTokenEstimation()}
												value={settings.chat.tokenEstimation}
												options={TOKEN_ESTIMATION_MODES}
												optionLabel={tokenEstimationLabel}
												onPick={(value) => sendRequest("setTokenEstimation", { value })}
												configuredScope={settings.chat.tokenEstimationScope}
												hidden={!tokenEstimationVisible}
											/>
											<ToolSchemaKeywordsRow
												values={settings.chat.additionalToolSchemaKeywords}
												lossy={settings.chat.additionalToolSchemaKeywordsLossy}
												configuredScope={settings.chat.additionalToolSchemaKeywordsScope}
												hidden={!toolSchemaKeywordsVisible}
											/>
										</>
									) : isUsageGroup ? (
										<>
											<UsageThresholdsRow
												values={settings.usage.alertThresholds}
												configuredScope={settings.usage.thresholdsScope}
												hidden={!thresholdsVisible}
											/>
											<EnumSettingRow
												settingId="usage.statusBar"
												title={l10n.t("Usage status bar")}
												description={usageStatusBarDescription()}
												help={helpUsageStatusBar()}
												value={settings.usage.statusBarMode}
												options={USAGE_STATUS_BAR_MODES}
												optionLabel={statusBarModeLabel}
												onPick={(value) => sendRequest("setUsageStatusBar", { value })}
												configuredScope={settings.usage.statusBarScope}
												hidden={!statusBarVisible}
											/>
											<CurrencySymbolRow
												value={settings.usage.currencySymbol}
												configuredScope={settings.usage.currencySymbolScope}
												hidden={!currencyVisible}
											/>
										</>
									) : isUiGroup ? (
										<>
											<EnumSettingRow
												settingId="ui.theme"
												title={l10n.t("Dashboard theme")}
												description={uiThemeDescription()}
												help={helpUiTheme()}
												value={settings.appearance.theme}
												options={UI_THEMES}
												optionLabel={uiThemeLabel}
												onPick={(value) => sendRequest("setUiTheme", { value })}
												configuredScope={settings.appearance.themeScope}
												hidden={!themeVisible}
											/>
											<UiAccentRow
												accent={settings.appearance.accent}
												configuredScope={settings.appearance.accentScope}
												hidden={!accentVisible}
											/>
										</>
									) : undefined
								}
							/>
						);
					})}
					{otherNumbers.length + otherBooleans.length > 0 ? (
						<SettingGroup
							title={() => l10n.t("Other")}
							numbers={otherNumbers}
							booleans={otherBooleans}
							settings={settings}
							isVisible={isVisible}
						/>
					) : null}
					{/* The trailing Import & Export group: the two actions ARE its content, so they stand in
					    its body at full size (parked in the heading's actions slot they read as tucked-away
					    chrome). Rendered last so file transfer never sits between rows. */}
					<SettingGroup
						title={() => l10n.t("Import & Export")}
						help={helpImportExportGroup}
						numbers={[]}
						booleans={[]}
						settings={settings}
						isVisible={isVisible}
						tailVisible={importExportVisible}
						tail={
							<div className="settings-transfer flex flex-wrap items-center gap-x-3.5 gap-y-1 py-2">
								<Button
									variant="secondary"
									onClick={() => sendRequest("executeCommand", { command: "exportSettings" })}
								>
									{l10n.t("Export settings")}
								</Button>
								<Button
									variant="secondary"
									onClick={() => sendRequest("executeCommand", { command: "importSettings" })}
								>
									{l10n.t("Import settings")}
								</Button>
							</div>
						}
					/>
				</div>
			</Section>
		</SettingFailuresContext.Provider>
	);
}
