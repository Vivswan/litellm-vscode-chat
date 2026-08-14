/**
 * The Settings tab: every scalar setting as one row, grouped the way the
 * manifest groups them, over the same configuration the Settings editor
 * writes - these rows and settings.json are two views of one file, never two
 * stores.
 *
 * Every row has the same full-bleed anatomy: a right-aligned label in a fixed
 * gutter, the control starting at one shared edge, the explanation growing
 * with the pane, and the row's actions in a reserved trailing slot at the
 * pane's right edge. The explanation column is also where a row states a
 * problem, so an error takes the hint's place instead of pushing every row
 * below it down - the form's height does not change while you type. Marking a
 * row modified, revealing its settings.json line, and resetting the scope
 * that sets it are the same three gestures on every kind of row, so the
 * vocabulary cannot drift between a number, a checkbox, an enum, and a color.
 */

import * as l10n from "@vscode/l10n";
import type { FocusEvent, ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { WIRE_LIMITS } from "../../dashboard/endpoints";
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
import { DOCS_LINK_OPENROUTER_CATALOG, DOCS_LINK_SETTINGS } from "./docsLinks";
import { DocsLink, Help } from "./help";
import {
	helpCurrencySymbol,
	helpImportExportGroup,
	helpSettingsSection,
	helpTokenEstimation,
	helpToolSchemaKeywords,
	helpUiAccent,
	helpUiTheme,
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
 * The inspectors' configure-jump into one of this tab's record editors: which
 * editor, plus the ExternalRecordEdit the editor applies (focus the record
 * carrying `key`, or create an exact-ID draft). Minted by App on an
 * inspector's button; the seq keys re-delivery.
 */
export interface EditRecordRequest extends ExternalRecordEdit {
	readonly kind: "parameters" | "capabilities";
}

/**
 * The form's grouping and order, most-touched first. Presentation only: the
 * setting inventory itself is the protocol's; anything not placed here still
 * renders, in a trailing "Other" group, so a newly added setting can never
 * silently vanish from the dashboard. Titles are zero-arg functions so the
 * localized text resolves at render time, not at module load.
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
 * The one row template every row obeys, full-bleed: the label gutter, the
 * control column, the explanation column growing with the pane, and the
 * reserved actions slot at the pane's right edge. A constant rather than a
 * class string per row kind, because the catalog row used to restate the
 * gutter as padding (11rem, the track plus the gap) and a literal offset
 * drifts the moment either number changes.
 *
 * The actions slot is a FIXED track on purpose: Reset renders only on
 * configured rows, so an auto track would size per row and hand modified and
 * clean rows different explanation edges. Fixed, every description ends at
 * one right edge and the settings.json jump sits at one x down the page.
 *
 * Narrow: the four tracks become one. A description column twenty characters
 * wide is not a column, it is a word per line, and the title's right edge
 * stops meaning anything once nothing lines up beside it. Stacked, the row
 * reads title, control, description - the order it is spoken in - and the
 * actions pin to the row's top-right corner instead of becoming a fourth
 * line. The PANE decides, not the window: this pane can be narrow inside a
 * wide window whenever the editor is split. The threshold sits at 910, clear
 * of a band the rail's collapse creates: collapsing the rail hands the pane
 * 168px, so a window growing through 1000px drops the pane from ~902 to ~736
 * and grows again - every pane width in between happens TWICE, and a
 * breakpoint inside it fires in reverse as the window widens. A reader
 * dragging a splitter rightward would have watched this page collapse.
 */
const SETTING_ROW_GRID =
	"grid grid-cols-[10rem_minmax(0,20rem)_minmax(0,1fr)_5.5rem] gap-x-4 @max-[910px]/pane:grid-cols-1 @max-[910px]/pane:gap-x-0";

/**
 * The label cell, which turns at the same width the tracks do: right-aligned
 * against the control while there is a column to align to, left-aligned once
 * the row is one track and there is not. Stacked, it also reserves the row's
 * top-right corner (pr-24): the actions slot pins there absolutely, and a
 * long or translated title would otherwise run under Reset and the
 * settings.json jump - which are ALWAYS painted below the 560px tier.
 *
 * A constant because the row renders the label two ways - a `label` when it has
 * a control to name, a `span` when it does not - and the threshold spelled once
 * per branch is a threshold that can move in one of them. The number cannot be
 * interpolated out: Tailwind compiles the variants it can read whole, so
 * `@max-[910px]/pane:` has to appear in the source as itself.
 */
const SETTING_TITLE = "setting-title text-right font-semibold @max-[910px]/pane:text-left @max-[910px]/pane:pr-24";

/**
 * The settings.json jump every row carries: a quiet icon button posting the
 * revealSetting intent; the extension opens the user settings.json and selects
 * "litellm-vscode-chat.<key>". Lives in the row's trailing actions slot with
 * Reset, hover- and focus-revealed through the shared Reveal idiom, so a
 * resting row is label, control, and explanation and nothing else.
 */
function RevealButton({ title, settingId }: { title: string; settingId: SettingRowId }) {
	return (
		<Reveal within="setting">
			<Button
				variant="secondary"
				size="compact"
				className="reveal-json px-1 py-0"
				aria-label={l10n.t("Open {0} in settings.json", title)}
				onClick={() => sendRequest("revealSetting", { setting: settingId })}
			>
				<IconBraces />
			</Button>
		</Reveal>
	);
}

/**
 * The reset action on a configured row. Named for what it really does: it
 * removes the value from the highest-precedence scope that sets it (the next
 * scope's value or the default shows through), so the accessible name says
 * which scope's value goes, never "reset to default". Each button carries its
 * own accessible name; six bare "Reset"s would be indistinguishable to a
 * screen reader. Lives in the trailing actions slot before the settings.json
 * jump, one home on every kind of row.
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
 * A configured row's annotation, in the description zone's tail. The at-rest
 * signal is the SHAPE - the accent bar in the gutter - so words appear only
 * where they add something: a User-scope value shows nothing at rest and
 * reveals the built-in default on hover or focus (the fact that decides
 * whether Reset is worth pressing), while a workspace-scope value names its
 * scope at rest, because "my user setting is not what applies here" is the
 * one case the bar alone cannot disambiguate.
 */
function ModifiedNote({ scope, defaultText }: { scope: SettingScope; defaultText?: string | undefined }) {
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
 * One settings row, whatever it holds: the label gutter, the control, and the
 * explanation column that a live error takes over. A row whose setting is
 * explicitly configured in some scope wears the theme's modified accent in
 * the gutter (the border is always there, transparent when clean, so marking
 * a row never shifts it) and offers the Reset that removes exactly that
 * scope's value. The filter hides rows via the hidden attribute, never by
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
}) {
	return (
		<div
			className={cn(
				SETTING_ROW_GRID,
				"setting-row group/setting -ml-3 relative items-baseline gap-y-1 rounded-xs border-l-2 py-2 pl-2.5 hover:bg-accent",
				// The right edge mirrors the record rows' (-mx-2 with px-2): the
				// hover tint overhangs the pane's cap by 8px while the CONTENT stops
				// exactly at it, so every row's actions slot and the record editors'
				// frames share one edge. pr-3 without the margin left the row's
				// content 12px short of everything below it.
				"-mr-2 pr-2",
				configuredScope !== null
					? "modified border-l-[var(--vscode-settings-modifiedItemIndicator,var(--vscode-focusBorder))]"
					: "border-l-transparent"
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
			<div className="setting-control flex flex-wrap items-center gap-2">{control}</div>
			{/* The error does not replace the description in the flow, it covers
			    it: the description stays, merely invisible, so the cell keeps the
			    height it had and no row below moves while you type.

			    The help glyph trails the description INLINE, inside the same
			    prose flow, so it sits where the words end on every row instead of
			    holding a phantom column at the pane's far edge. It stays the
			    description span's SIBLING rather than its child, because the
			    error overlay hides the description with visibility - and a row
			    explaining what you typed wrong is the worst moment to make its
			    help unreachable.

			    The cell owns breaking because it owns wrapping: a description
			    with one unbroken token would otherwise set its own min-content
			    width and push straight out of the column. The 72ch cap (p.hint's
			    own measure) is a READING cap inside the growing track, not a
			    second structural edge: only structure goes full-bleed, prose
			    stops where lines stay readable. */}
			<div className="setting-hint relative min-w-0 max-w-[72ch] break-words text-[0.95em] text-muted-foreground">
				<span className={cn("setting-desc", error !== undefined && "invisible")}>{description}</span>
				{/* An AT-REST note (a workspace override) precedes the glyph, so
				    the "?" stays the resting description's last element on every
				    row. The hover-only User-scope note trails it instead: at rest
				    nothing visible follows the glyph, and rendering the invisible
				    note before it would hold a blank gap open mid-sentence. */}
				{configuredScope !== null && configuredScope !== "global" ? (
					<>
						{" "}
						<ModifiedNote scope={configuredScope} defaultText={defaultText} />
					</>
				) : null}
				{/* A no-break space binds the glyph to the word before it, so a
				    sentence that exactly fills the measure cannot orphan a lone
				    "?" onto its own line. */}
				{help !== undefined ? (
					<>
						{"\u00a0"}
						<Help text={help} name={l10n.t("Help: {0}", title)} />
					</>
				) : null}
				{configuredScope === "global" ? (
					<>
						{" "}
						<ModifiedNote scope={configuredScope} defaultText={defaultText} />
					</>
				) : null}
				{/* pointer-events-none because the overlay spans the whole cell,
				    glyph included: without it a row with an error has an
				    unhoverable "?" - exactly when its help is most wanted. What it
				    covers is `visibility: hidden` and so untouchable anyway. */}
				{error !== undefined ? (
					<span className="error pointer-events-none absolute inset-0" id={errorId}>
						{error}
					</span>
				) : null}
			</div>
			{/* The row's one actions slot, at the pane's right edge: Reset when a
			    scope sets a value, then the settings.json jump, always in that
			    order and always last - the anatomy's fourth track, so the pair
			    lands at the same x on every row. Stacked, the slot pins to the
			    row's top-right corner (the row is relative for exactly this)
			    instead of stacking as a lone fourth line. */}
			<div className="setting-actions flex items-center justify-end gap-1.5 self-start justify-self-end @max-[910px]/pane:absolute @max-[910px]/pane:top-1.5 @max-[910px]/pane:right-2">
				{configuredScope !== null ? <ResetButton title={title} scope={configuredScope} settingId={settingId} /> : null}
				<RevealButton title={title} settingId={settingId} />
			</div>
		</div>
	);
}

/**
 * A number setting edited as draft text and committed on blur or Enter, so
 * half-typed values never reach the configuration. The draft is parsed once
 * per keystroke (parseNumberDraft), and the error display, the commit, and
 * the equivalence hint all read that one verdict, never latched at commit
 * time: a valid draft must never render as invalid, and the equivalence hint
 * must stay live while the user types their way out of a rejected value. An
 * external state push resets the draft to the store's value.
 *
 * One display exception to the live verdict: a minimum-bound rejection stays
 * quiet until the field first blurs (or Enter tries to commit), because
 * typing the 5 of 5000 honestly passes below the bound. The parse itself is
 * unchanged - an invalid draft still never commits - and the blurred latch
 * re-arms on every external resync.
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
 * A boolean setting. The title is plain text on purpose: only the checkbox
 * and its explanation toggle, so a click on the label gutter cannot silently
 * write settings.json. `extra` renders under the row - the OpenRouter catalog
 * row's status line and Refresh button ride there.
 */
function BooleanField({
	id,
	value,
	configuredScope,
	hidden,
	extra,
}: {
	id: BooleanSettingId;
	value: boolean;
	configuredScope: SettingScope | null;
	hidden: boolean;
	extra?: ReactNode;
}) {
	const presentation = booleanSettingPresentation(id);
	const inputId = `setting-${id}`;
	return (
		<>
			<SettingRow
				settingId={id}
				title={presentation.label}
				description={
					<label className="cursor-pointer" htmlFor={inputId}>
						{presentation.description}
					</label>
				}
				help={settingRowHelp(id)}
				configuredScope={configuredScope}
				hidden={hidden}
				control={
					<Checkbox
						id={inputId}
						checked={value}
						onChange={(event) => sendRequest("setBooleanSetting", { setting: id, value: event.currentTarget.checked })}
					/>
				}
			/>
			{/* Hidden with the row it belongs to: a filter that hides the catalog
			    setting must not leave its status line and Refresh button behind. */}
			{extra !== undefined ? <div hidden={hidden}>{extra}</div> : null}
		</>
	);
}

/**
 * The OpenRouter catalog row's status line (docs/dashboard.md#settings): the
 * snapshot's size and last refresh, a Refresh button (the same action as the
 * "LiteLLM: Refresh OpenRouter Catalog" command), a standing failure in the
 * row status - never a toast - and an inert hint while the setting is off.
 * It adopts the shared row grid and starts at the control zone's own edge, a
 * structured second line of the row above rather than a floater; the failure
 * takes a line of its own instead of jamming red text beside Refresh.
 */
function CatalogRow({ catalog, enabled, now }: { catalog: CatalogStatusView; enabled: boolean; now: number }) {
	const updated =
		catalog.lastSuccessAt !== undefined
			? (relativeTime(new Date(catalog.lastSuccessAt).toISOString(), now) ?? l10n.t("just now"))
			: undefined;
	return (
		<div className={cn("catalog-row", SETTING_ROW_GRID, "pt-1 pb-1 text-[0.95em]")}>
			<div
				className={cn(
					"col-start-2 col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1",
					// Stacked, the grid is one track; starting at a second column
					// would mint an implicit one and indent this line into nothing.
					"@max-[910px]/pane:col-span-1 @max-[910px]/pane:col-start-1"
				)}
			>
				{enabled ? (
					<>
						<span className="hint">
							{catalog.modelCount === 1 ? l10n.t("1 catalog model") : l10n.t("{0} catalog models", catalog.modelCount)}
							{updated !== undefined ? ` - ${l10n.t("updated {0}", updated)}` : ` - ${l10n.t("bundled snapshot")}`}
						</span>
						<Button
							variant="secondary"
							size="compact"
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
						</Button>
						<DocsLink href={DOCS_LINK_OPENROUTER_CATALOG} label={l10n.t("Open the OpenRouter catalog guide")} />
						{catalog.lastFailure !== undefined ? (
							<span className="error basis-full">
								{/* The classification is a fixed English vocabulary ("HTTP 503",
							    "network error"), protocol-ish like header names. */}
								{l10n.t("Last refresh failed ({0}); serving the cached snapshot.", catalog.lastFailure.classification)}
							</span>
						) : null}
					</>
				) : (
					<span className="hint">
						{l10n.t(
							"Catalog off: no refreshes and no implicit ID matching; explicit _openrouter_model directives keep answering from the cached snapshot."
						)}
					</span>
				)}
			</div>
		</div>
	);
}

/**
 * The non-scalar rows' descriptions. They live here rather than inline because
 * the filter matches on them exactly as it does for a scalar row's description,
 * and a row whose filter text and visible text can drift is a row a needle
 * finds without showing, or shows without finding.
 */
function usageStatusBarDescription(): string {
	return l10n.t("When the spend status bar item shows; the worst fresh server's percentage.");
}

function tokenEstimationDescription(): string {
	return l10n.t("How prompts are sized for the local token budget.");
}

function toolSchemaKeywordsDescription(): string {
	// The example lives in the input's own placeholder, one column to the left.
	return l10n.t("Extra JSON-Schema keywords kept in tool definitions.");
}

function usageThresholdsDescription(): string {
	return l10n.t("Enter 80% or 0.8; the lower value warns, the higher errors. Clear both fields to turn alerts off.");
}

function currencySymbolDescription(): string {
	return l10n.t('Prefix on every spend and price figure, e.g. "EUR ".');
}

function uiThemeDescription(): string {
	return l10n.t("Whether the dashboard renders light or dark; Auto follows the editor.");
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
 * Any closed-vocabulary setting as a select: the option list, how to name an
 * option, and where the pick goes. One component rather than one per enum,
 * because two hand-written near-copies of a select row is how the two drift
 * apart - and a third enum setting should cost a call, not a component.
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
 * The ui.accent row: four swatches rather than a list of color words, because
 * the choice IS the color. Native radios carry the semantics and the keyboard
 * (arrow keys move between them, one tab stop for the group); the visible
 * swatch is their label, ringed when checked and when the hidden input takes
 * focus.
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
 * One threshold box's parse: a fraction (0.8), a percentage (80%), or a bare
 * number above 1 read as a percent (80 means 80%). The docs' bound applies
 * after conversion: each value in (0, 1], so 0 and anything past 100% reject.
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
		<>
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
			    row's - a leading "Warning at" pushed the input to an x of its
			    own. Still a <label>, so clicking it focuses the box. */}
			<label className="setting-unit text-muted-foreground" htmlFor={id}>
				{label}
			</label>
		</>
	);
}

/**
 * The usage.alertThresholds row: two inputs over the list setting - "Warning
 * at" and "Error at", the two-threshold shape the defaults use. Both set
 * writes [low, high] (sorted; equal values collapse to one); one set writes a
 * single-element list, which the alerts treat as the error threshold; both
 * empty writes [] (alerts off). A stored list these two boxes cannot
 * represent (3+ values, hand-written) renders read-only with the reveal
 * button, so the dashboard never destroys it.
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
	const semanticsHint =
		parsed === undefined
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
					{usageThresholdsDescription()}
					{semanticsHint !== undefined ? <span className="ml-1 text-foreground">{semanticsHint}</span> : null}
				</>
			}
			error={parsed === undefined ? l10n.t("Thresholds run from above 0% to 100%: enter 80% or 0.8.") : undefined}
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
 * The usage.currencySymbol row: one short text box over the string setting.
 * Any text is legal - the symbol is display-only and never sent anywhere -
 * up to the wire cap (WIRE_LIMITS.currencySymbol), which both the maxLength
 * and the intent schema read. maxLength gates typing only: a longer symbol
 * hand-written in settings.json round-trips into the box via the state push,
 * and the row must neither truncate it nor let a commit die as a generic
 * envelope failure - so an over-limit draft shows the bound as the row's
 * error and never commits, and deleting down to the cap recovers in place.
 * Clearing the box commits the empty string, which renders bare numbers.
 * Commits on Enter or blur, like the thresholds pair.
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
 * The intent schema's bounds on setAdditionalToolSchemaKeywords, mirrored
 * (intentSchema.ts: z.array(z.string().max(256)).max(64)) for the same reason
 * the currency row reads WIRE_LIMITS: a paste the host would reject is
 * refused here with a reason, instead of surfacing as a generic envelope
 * failure after the fact.
 */
const TOOL_SCHEMA_KEYWORD_MAX_LENGTH = 256;
const TOOL_SCHEMA_KEYWORD_MAX_COUNT = 64;

/**
 * The chat.additionalToolSchemaKeywords row: one comma-separated input over
 * the list setting. Splitting on commas, trimming, and dropping empties gives
 * every draft a reading; a draft past the intent schema's bounds shows the
 * bound as the row's error and never commits. A stored list the box cannot
 * round-trip renders read-only with the reveal button, so the dashboard
 * never destroys it - both the shapes the box cannot spell (an entry holding
 * a comma or edge whitespace) and, via the lossy flag, raw values whose
 * dropped entries the normalized push cannot even show.
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
						// Full control-column width: keyword lists grow sideways, unlike
						// the intrinsic-width number inputs above.
						className="w-full max-w-full"
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
	booleanExtras,
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
	/** Extra content under specific boolean rows (the catalog row's status line). */
	booleanExtras?: Partial<Record<BooleanSettingId, ReactNode>>;
	/** Rows appended after the scalar rows (the Usage group's enum and list rows). */
	tail?: ReactNode;
	/** Whether any tail row survives the filter; keeps the group heading alive for them. */
	tailVisible?: boolean;
}) {
	const empty = numbers.every((id) => !isVisible(id)) && booleans.every((id) => !isVisible(id)) && tailVisible !== true;
	return (
		<div className="settings-group mt-6" hidden={empty}>
			{/* Sentence case, not an all-caps letterspaced eyebrow: the group
			    heading separates by weight, space and the hairline, the same way
			    the section header does one level up. Full-strength foreground
			    because the record editors nested inside a group head themselves
			    at muted 600 - a parent that matches its children ranks nothing. */}
			{/* The glyph is the heading's sibling, not its child, the same way
			    SectionHeader arranges the pair one level up: a button nested
			    inside a heading folds its accessible name into the heading's, so
			    the group would announce as "Import & Export Help: Import &
			    Export". The rule and the spacing belong to the line, so they sit
			    on the wrapper and the heading carries neither. */}
			<div className="settings-group-head mt-0 mb-2 flex items-baseline gap-x-2 border-border border-b pb-1">
				<h3 className="settings-group-title m-0 font-semibold text-[0.95em]">{title()}</h3>
				{/* Behind the glyph, not above the rows. A group's explanation is
				    read once and then never again, so as a standing paragraph it
				    costs every later visit the space and the eye movement while
				    telling a returning reader nothing. The "?" is where the rows
				    below already put their own detail. */}
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
					extra={booleanExtras?.[id]}
				/>
			))}
			{tail}
		</div>
	);
}

/**
 * Where scalar edits land, for the header's meta line. Edits go to your User
 * settings, except that a setting the workspace already sets is changed there
 * (the write-scope rule); a value only a folder scope sets is named by its
 * row's Reset action.
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

/** One scalar row's searchable text: its label and description, the two lines the row itself shows. */
function scalarText(id: NumberSettingId | BooleanSettingId): { label: string; description: string } {
	return Object.hasOwn(NUMBER_SETTING_SPECS, id)
		? numberSettingPresentation(id as NumberSettingId)
		: booleanSettingPresentation(id as BooleanSettingId);
}

/**
 * Whether a record editor matches the filter: by its heading (as scalar rows
 * match their labels) or by any key it holds in any scope - the record's own
 * keys plus, for modelParameters, the parameter names nested one level down.
 * Store keys only, deliberately: a dirty draft's rows live inside the editor,
 * which the filter hides but never unmounts.
 */
function recordEditorMatches(
	needle: string,
	title: string,
	scoped: {
		readonly value: Readonly<Record<string, unknown>>;
		readonly otherScopes: readonly { readonly value: Readonly<Record<string, unknown>> }[];
	}
): boolean {
	if (title.toLowerCase().includes(needle)) {
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
}: {
	settings: DashboardSettings;
	models: readonly DashboardModel[];
	/** The cross-server observed /model/info key union (DashboardState.observedModelInfoKeys), the capability editor's hint evidence. */
	observedModelInfoKeys?: readonly string[] | undefined;
	/** The shared clock tick; the catalog row's "updated N ago" reads it. */
	now?: number;
	/** The inspectors' configure-jump into one of the record editors; see EditRecordRequest. */
	editRecordRequest?: EditRecordRequest | undefined;
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
	const isVisible = (id: NumberSettingId | BooleanSettingId): boolean => {
		const { label, description } = scalarText(id);
		return matches(label, description, id);
	};

	const placed = new Set<string>(SETTING_GROUPS.flatMap((group) => [...group.numbers, ...group.booleans]));
	const otherNumbers = NUMBER_SETTING_IDS.filter((id) => !placed.has(id));
	const otherBooleans = BOOLEAN_SETTING_IDS.filter((id) => !placed.has(id));

	const paramsVisible =
		needle.length === 0 || recordEditorMatches(needle, modelParametersTitle(), settings.modelParameters);
	const capsVisible =
		needle.length === 0 || recordEditorMatches(needle, modelCapabilitiesTitle(), settings.modelCapabilities);
	const anyScalarVisible = [...NUMBER_SETTING_IDS, ...BOOLEAN_SETTING_IDS].some(isVisible);
	// The non-scalar rows filter by the same rule as the scalar ones - name,
	// explanation, setting id - so a needle cannot find one kind and miss the
	// other. Hoisted because the empty-state verdict below has to see them: a
	// filter matching only a tail row used to render that row under a "nothing
	// matched" line.
	const statusBarVisible = matches(l10n.t("Usage status bar"), usageStatusBarDescription(), "usage.statusBar");
	const tokenEstimationVisible = matches(
		l10n.t("Token estimation"),
		tokenEstimationDescription(),
		"chat.tokenEstimation"
	);
	const toolSchemaKeywordsVisible = matches(
		l10n.t("Extra tool schema keywords"),
		toolSchemaKeywordsDescription(),
		"chat.additionalToolSchemaKeywords"
	);
	const thresholdsVisible = matches(
		l10n.t("Usage alert thresholds"),
		usageThresholdsDescription(),
		"usage.alertThresholds"
	);
	const currencyVisible = matches(l10n.t("Currency symbol"), currencySymbolDescription(), "usage.currencySymbol");
	const themeVisible = matches(l10n.t("Dashboard theme"), uiThemeDescription(), "ui.theme");
	const accentVisible = matches(l10n.t("Accent color"), uiAccentDescription(), "ui.accent");
	// The Import & Export group filters like a scalar row: its title and button
	// labels stand in for the label, and it has no description to add. Its
	// explanation is deliberately NOT in the haystack, and not because the two
	// could drift - the haystack would call the same function the tip renders.
	// It is that a needle matching only the help leaves a group standing whose
	// every visible word misses the needle, with nothing on screen to say why
	// it survived. Row-level and section-level help are out for the same
	// reason, so including this one would have been the odd case out.
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
	const booleanExtras: Partial<Record<BooleanSettingId, ReactNode>> = {
		"models.openRouterCatalog": (
			<CatalogRow
				catalog={settings.catalog}
				enabled={settings.booleans["models.openRouterCatalog"]}
				now={now ?? Date.now()}
			/>
		),
	};
	const scopes = configuredScopes(settings);
	const modifiedCount = scopes.filter((scope) => scope !== null).length;
	return (
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
						className="w-[16rem] min-w-0 max-w-full shrink"
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
			{nothingMatches ? <p className="empty">{l10n.t("No settings match the filter.")}</p> : null}
			<div className="settings-groups">
				{SETTING_GROUPS.map((group, index) => {
					// Four groups carry non-scalar tails: Models gets the two record
					// editors (mirroring the manifest's grouping - they are model
					// settings, not a page of their own), Chat gets the
					// token-estimation enum and the tool-schema-keywords list, Usage
					// gets the status bar mode enum and the alert-thresholds row.
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
							booleanExtras={booleanExtras}
							tailVisible={
								(isModelsGroup && (paramsVisible || capsVisible)) ||
								(isChatGroup && (tokenEstimationVisible || toolSchemaKeywordsVisible)) ||
								(isUsageGroup && (statusBarVisible || thresholdsVisible || currencyVisible)) ||
								(isUiGroup && (themeVisible || accentVisible))
							}
							tail={
								isModelsGroup ? (
									<>
										{/* The one statement of the editors' save model, above both
										    (never the same paragraph twice): the rows below are
										    drafts until Apply, unlike the scalar rows above. */}
										<p className="hint record-editors-note" hidden={!paramsVisible && !capsVisible}>
											{l10n.t(
												"Rows in the two editors below apply together via their Apply button; the settings above save each change on its own."
											)}
										</p>
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
									</>
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
				{/* The trailing Import & Export group: no settings rows, just two
				    actions invoking the export/import commands over the same
				    executeCommand post the header's Report a bug uses. Rendered
				    after every other group so file transfer never sits between
				    rows. */}
				<SettingGroup
					title={() => l10n.t("Import & Export")}
					help={helpImportExportGroup}
					numbers={[]}
					booleans={[]}
					settings={settings}
					isVisible={isVisible}
					tailVisible={importExportVisible}
					tail={
						<div className="toolbar">
							<Button variant="secondary" onClick={() => sendRequest("executeCommand", { command: "exportSettings" })}>
								{l10n.t("Export settings")}
							</Button>
							<Button variant="secondary" onClick={() => sendRequest("executeCommand", { command: "importSettings" })}>
								{l10n.t("Import settings")}
							</Button>
						</div>
					}
				/>
			</div>
		</Section>
	);
}
