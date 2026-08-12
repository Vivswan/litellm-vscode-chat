import * as l10n from "@vscode/l10n";
import type { FocusEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
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
	ResettableSettingId,
	RevealableSettingId,
	SettingScope,
	UsageStatusBarModeSetting,
} from "../../dashboard/viewModels";
import { BOOLEAN_SETTING_IDS, NUMBER_SETTING_IDS } from "../../dashboard/viewModels";
import type { BooleanSettingId, NumberSettingId } from "../../shared/config/settingSpec";
import { NUMBER_SETTING_SPECS } from "../../shared/config/settingSpec";
import { DOCS_LINK_OPENROUTER_CATALOG, DOCS_LINK_SETTINGS } from "./docsLinks";
import { DocsLink, Help } from "./help";
import { helpCatalogRow, helpImportExportGroup, helpSettingsSection, settingRowHelp } from "./helpText";
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
import { Input } from "./ui/input";
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
	/** A muted note under the group title. */
	readonly hint?: () => string;
	readonly numbers: readonly NumberSettingId[];
	readonly booleans: readonly BooleanSettingId[];
}[] = [
	// The manifest's section order (Servers carries no scalar settings).
	{ title: () => l10n.t("Models"), numbers: [], booleans: ["models.openRouterCatalog"] },
	{ title: () => l10n.t("Chat"), numbers: ["chat.timeout"], booleans: ["chat.promptCaching"] },
	{
		title: () => l10n.t("Discovery"),
		numbers: ["discovery.timeout", "discovery.cacheTtl"],
		booleans: [],
	},
	{ title: () => l10n.t("Usage"), numbers: ["usage.pollInterval"], booleans: [] },
	{ title: () => l10n.t("UI"), numbers: [], booleans: ["ui.maskSecretInputs"] },
];

/**
 * One settings row in the native Settings-editor anatomy: semibold title,
 * muted description, control below, all on one left edge. A row whose setting
 * is explicitly configured in some scope gets the theme's modified accent bar
 * (the gutter space is reserved, so toggling it never shifts layout). The
 * filter hides rows via the hidden attribute, never by unmounting: a
 * half-typed draft must survive being filtered away and back.
 */
function SettingRow({ modified, hidden, children }: { modified: boolean; hidden: boolean; children: ReactNode }) {
	return (
		<div className={modified ? "setting-row modified" : "setting-row"} hidden={hidden}>
			{children}
		</div>
	);
}

/**
 * The settings.json jump on a row's head or a record editor's heading: a
 * quiet icon-action posting the revealSetting intent; the extension opens the
 * user settings.json and selects "litellm-vscode-chat.<key>". On rows it is
 * hover/focus-revealed like Reset (the .reveal-json rules); on the editor
 * headings it rests visible, as their docs links do.
 */
function RevealButton({ title, settingId }: { title: string; settingId: RevealableSettingId }) {
	return (
		<Button
			variant="quiet"
			className="reveal-json px-1 py-0"
			aria-label={l10n.t("Open {0} in settings.json", title)}
			onClick={() => sendRequest("revealSetting", { setting: settingId })}
		>
			<IconBraces />
		</Button>
	);
}

/**
 * The reset action on a configured row, shown on hover or while the row holds
 * focus. Named for what it really does: it removes the value from the
 * highest-precedence scope that sets it (the next scope's value or the
 * default shows through), so the accessible name says which scope's value
 * goes, never "reset to default". Each button carries its own accessible
 * name; six bare "Reset"s would be indistinguishable to a screen reader.
 * Sits in the control row after the input, so Tab reaches it from the field
 * it resets.
 */
function ResetButton({
	title,
	scope,
	settingId,
}: {
	title: string;
	scope: SettingScope;
	settingId: ResettableSettingId;
}) {
	const action = l10n.t("Remove the {0} value of {1}", settingScopeLabel(scope), title);
	return (
		<Button
			variant="quiet"
			className="reset"
			aria-label={action}
			onClick={() => sendRequest("resetSetting", { setting: settingId })}
		>
			{l10n.t("Reset")}
		</Button>
	);
}

/**
 * The muted annotation a configured row wears in its head, matching the
 * native Settings editor's "Modified in:" idiom: the accent bar says that a
 * value is set, this says where - and, on number rows, what the setting's
 * built-in default is (the value that applies once no scope sets one; a
 * reset may first reveal another scope's value on the way there). Appended
 * after the title inside the head, so appearing or disappearing never
 * shifts the row's text (the accent gutter is reserved separately).
 */
function ModifiedNote({ scope, defaultText }: { scope: SettingScope; defaultText?: string }) {
	return (
		<span className="setting-modified-note">
			{defaultText === undefined
				? l10n.t("Modified in {0} settings", settingScopeLabel(scope))
				: l10n.t("Modified in {0} settings (default: {1})", settingScopeLabel(scope), defaultText)}
		</span>
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
	const help = settingRowHelp(id);
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
		<SettingRow modified={configuredScope !== null} hidden={hidden}>
			<div className="setting-head">
				<label className="setting-title" htmlFor={inputId}>
					{presentation.label}
				</label>
				{help !== undefined ? <Help text={help} name={l10n.t("Help: {0}", presentation.label)} /> : null}
				<RevealButton title={presentation.label} settingId={id} />
				{configuredScope !== null ? <ModifiedNote scope={configuredScope} defaultText={defaultDisplay(id)} /> : null}
			</div>
			<p className="setting-desc">{presentation.description}</p>
			<div className="setting-control">
				<Input
					id={inputId}
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
				<span className="setting-unit" id={unitId}>
					{presentation.unit}
				</span>
				{error !== undefined ? (
					<span className="error" id={errorId}>
						{error}
					</span>
				) : null}
				{equiv !== undefined ? <span className="setting-equiv">{equiv}</span> : null}
				{configuredScope !== null ? (
					<ResetButton title={presentation.label} scope={configuredScope} settingId={id} />
				) : null}
			</div>
		</SettingRow>
	);
}

/**
 * A boolean setting. The title is plain text on purpose: only the
 * checkbox-plus-description label toggles, so a click on the title cannot
 * silently write settings.json. `extra` renders under the control - the
 * OpenRouter catalog row's status line and Refresh button ride there.
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
	const help = settingRowHelp(id);
	return (
		<SettingRow modified={configuredScope !== null} hidden={hidden}>
			<div className="setting-head">
				<span className="setting-title">{presentation.label}</span>
				{help !== undefined ? <Help text={help} name={l10n.t("Help: {0}", presentation.label)} /> : null}
				<RevealButton title={presentation.label} settingId={id} />
				{configuredScope !== null ? <ModifiedNote scope={configuredScope} /> : null}
			</div>
			<div className="setting-control">
				<label className="setting-check" htmlFor={inputId}>
					<Checkbox
						id={inputId}
						checked={value}
						onChange={(event) => sendRequest("setBooleanSetting", { setting: id, value: event.currentTarget.checked })}
					/>
					<span className="setting-desc">{presentation.description}</span>
				</label>
				{configuredScope !== null ? (
					<ResetButton title={presentation.label} scope={configuredScope} settingId={id} />
				) : null}
			</div>
			{extra}
		</SettingRow>
	);
}

/**
 * The OpenRouter catalog row's status line (docs/dashboard.md#settings): the
 * snapshot's size and last refresh, a Refresh button (the same action as the
 * "LiteLLM: Refresh OpenRouter Catalog" command), a standing failure in the
 * row status - never a toast - and an inert hint while the setting is off.
 */
function CatalogRow({ catalog, enabled, now }: { catalog: CatalogStatusView; enabled: boolean; now: number }) {
	const updated =
		catalog.lastSuccessAt !== undefined
			? (relativeTime(new Date(catalog.lastSuccessAt).toISOString(), now) ?? l10n.t("just now"))
			: undefined;
	return (
		<div className="catalog-row">
			{enabled ? (
				<>
					<span className="hint">
						{catalog.modelCount === 1 ? l10n.t("1 catalog model") : l10n.t("{0} catalog models", catalog.modelCount)}
						{updated !== undefined ? ` - ${l10n.t("updated {0}", updated)}` : ` - ${l10n.t("bundled snapshot")}`}
					</span>
					<Button variant="secondary" disabled={catalog.refreshing} onClick={() => sendRequest("refreshCatalog", null)}>
						{catalog.refreshing ? (
							<>
								<span className="spinner" aria-hidden="true" /> {l10n.t("Refreshing...")}
							</>
						) : (
							l10n.t("Refresh")
						)}
					</Button>
					<Help text={helpCatalogRow()} />
					<DocsLink href={DOCS_LINK_OPENROUTER_CATALOG} label={l10n.t("Open the OpenRouter catalog guide")} />
					{catalog.lastFailure !== undefined ? (
						<span className="error">
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
	);
}

/** The usage.statusBar mode names, resolved at call time (no module-level localized constants). */
function statusBarModeLabel(mode: UsageStatusBarModeSetting): string {
	switch (mode) {
		case "always":
			return l10n.t("always - visible whenever there is something to show");
		case "alerts-only":
			return l10n.t("alerts only - visible while a threshold is crossed");
		case "off":
			return l10n.t("off - never shown");
	}
}

const USAGE_STATUS_BAR_MODES: readonly UsageStatusBarModeSetting[] = ["always", "alerts-only", "off"];

/** The usage.statusBar row: an enum select, committed on change like the checkboxes. */
function UsageStatusBarRow({
	mode,
	configuredScope,
	hidden,
}: {
	mode: UsageStatusBarModeSetting;
	configuredScope: SettingScope | null;
	hidden: boolean;
}) {
	const inputId = "setting-usage.statusBar";
	const title = l10n.t("Usage status bar");
	return (
		<SettingRow modified={configuredScope !== null} hidden={hidden}>
			<div className="setting-head">
				<label className="setting-title" htmlFor={inputId}>
					{title}
				</label>
				<RevealButton title={title} settingId="usage.statusBar" />
				{configuredScope !== null ? <ModifiedNote scope={configuredScope} /> : null}
			</div>
			<p className="setting-desc">
				{l10n.t("When the spend status bar item shows; the worst fresh server's percentage.")}
			</p>
			<div className="setting-control">
				<Select
					id={inputId}
					value={mode}
					onChange={(event) =>
						sendRequest("setUsageStatusBar", {
							value: event.currentTarget.value as UsageStatusBarModeSetting,
						})
					}
				>
					{USAGE_STATUS_BAR_MODES.map((candidate) => (
						<option key={candidate} value={candidate}>
							{statusBarModeLabel(candidate)}
						</option>
					))}
				</Select>
				{configuredScope !== null ? (
					<ResetButton title={title} scope={configuredScope} settingId="usage.statusBar" />
				) : null}
			</div>
		</SettingRow>
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

/** One of the two threshold inputs with its label; error and hint lines render at the row level. */
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
			<label className="setting-unit" htmlFor={id}>
				{label}
			</label>
			<Input
				id={id}
				type="text"
				spellCheck={false}
				className="threshold-input"
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
		<SettingRow modified={configuredScope !== null} hidden={hidden}>
			<div className="setting-head">
				{custom ? (
					<span className="setting-title">{title}</span>
				) : (
					<label className="setting-title" htmlFor={warningId}>
						{title}
					</label>
				)}
				<RevealButton title={title} settingId="usage.alertThresholds" />
				{configuredScope !== null ? <ModifiedNote scope={configuredScope} /> : null}
			</div>
			<p className="setting-desc">
				{l10n.t("Warning at 80% and error at 95% by default; enter 80% or 0.8. Empty both to turn alerts off.")}
			</p>
			{custom ? (
				<div className="setting-control">
					<span>{values.map(percentText).join(", ")}</span>
					<span className="hint">{l10n.t("Custom list - edit in settings.json.")}</span>
					{configuredScope !== null ? (
						<ResetButton title={title} scope={configuredScope} settingId="usage.alertThresholds" />
					) : null}
				</div>
			) : (
				<div className="setting-control">
					<ThresholdBox
						id={warningId}
						label={l10n.t("Warning at")}
						text={warningText}
						invalid={warning.kind === "invalid"}
						errorId={problemId}
						placeholder={l10n.t("e.g. 80%")}
						onText={setWarningText}
						onCommit={commit}
					/>
					<ThresholdBox
						id={errorInputId}
						label={l10n.t("Error at")}
						text={errorText}
						invalid={error.kind === "invalid"}
						errorId={problemId}
						placeholder={l10n.t("e.g. 95%")}
						onText={setErrorText}
						onCommit={commit}
					/>
					{parsed === undefined ? (
						<span className="error" id={problemId}>
							{l10n.t("Thresholds run from above 0% to 100%: enter 80% or 0.8.")}
						</span>
					) : null}
					{semanticsHint !== undefined ? <span className="hint">{semanticsHint}</span> : null}
					{configuredScope !== null ? (
						<ResetButton title={title} scope={configuredScope} settingId="usage.alertThresholds" />
					) : null}
				</div>
			)}
		</SettingRow>
	);
}

function SettingGroup({
	title,
	hint,
	numbers,
	booleans,
	settings,
	isVisible,
	booleanExtras,
	tail,
	tailVisible,
}: {
	title: () => string;
	hint?: (() => string) | undefined;
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
		<div className="settings-group" hidden={empty}>
			<h3 className="settings-group-title">{title()}</h3>
			{hint !== undefined ? <p className="hint">{hint()}</p> : null}
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
 * The scalar groups' scope-context line, matching the record editors'
 * ScopeNote below. Scalar edits land in your User settings, except that a
 * setting the workspace already sets is changed there (the write-scope rule);
 * a value only a folder scope sets is named by its row's Reset action.
 */
function ScalarScopeNote({ settings }: { settings: DashboardSettings }) {
	const scopes = [
		...Object.values(settings.configuredScopes.numbers),
		...Object.values(settings.configuredScopes.booleans),
	];
	const workspaceTouched = scopes.some((scope) => scope === "workspace");
	return (
		<p className="hint">
			{workspaceTouched
				? l10n.t("Editing User settings; a value set in Workspace settings is changed there.")
				: l10n.t("Editing User settings.")}
		</p>
	);
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
	// A jump must land on a visible editor: a leftover filter that hides the
	// target section would swallow the focus, so the request clears it.
	const editSeq = editRecordRequest?.seq;
	useEffect(() => {
		if (editSeq !== undefined) {
			setFilter("");
		}
	}, [editSeq]);
	const needle = filter.trim().toLowerCase();
	const isVisible = (id: NumberSettingId | BooleanSettingId): boolean => {
		if (needle.length === 0) {
			return true;
		}
		const { label, description } = scalarText(id);
		return label.toLowerCase().includes(needle) || description.toLowerCase().includes(needle);
	};

	const placed = new Set<string>(SETTING_GROUPS.flatMap((group) => [...group.numbers, ...group.booleans]));
	const otherNumbers = NUMBER_SETTING_IDS.filter((id) => !placed.has(id));
	const otherBooleans = BOOLEAN_SETTING_IDS.filter((id) => !placed.has(id));

	const paramsVisible =
		needle.length === 0 || recordEditorMatches(needle, modelParametersTitle(), settings.modelParameters);
	const capsVisible =
		needle.length === 0 || recordEditorMatches(needle, modelCapabilitiesTitle(), settings.modelCapabilities);
	const anyScalarVisible = [...NUMBER_SETTING_IDS, ...BOOLEAN_SETTING_IDS].some(isVisible);
	// The Import & Export group filters like a scalar row: its title and button
	// labels stand in for the label, its hint line for the description.
	const importExportVisible =
		needle.length === 0 ||
		[l10n.t("Import & Export"), l10n.t("Export settings"), l10n.t("Import settings"), helpImportExportGroup()].some(
			(text) => text.toLowerCase().includes(needle)
		);
	const nothingMatches = !anyScalarVisible && !paramsVisible && !capsVisible && !importExportVisible;
	const booleanExtras: Partial<Record<BooleanSettingId, ReactNode>> = {
		"models.openRouterCatalog": (
			<CatalogRow
				catalog={settings.catalog}
				enabled={settings.booleans["models.openRouterCatalog"]}
				now={now ?? Date.now()}
			/>
		),
	};
	return (
		<section>
			<h2>
				{l10n.t("Settings")} <Help text={helpSettingsSection()} />
				<DocsLink href={DOCS_LINK_SETTINGS} label={l10n.t("Open the settings guide")} />
			</h2>
			<div className="toolbar">
				<Button variant="secondary" onClick={() => sendRequest("executeCommand", { command: "openSettings" })}>
					{l10n.t("Open in Settings editor")}
				</Button>
			</div>
			<ScalarScopeNote settings={settings} />
			<div className="filterbar">
				<Input
					type="text"
					placeholder={l10n.t("Filter settings, e.g. timeout")}
					aria-label={l10n.t("Filter settings")}
					value={filter}
					onChange={(event) => setFilter(event.currentTarget.value)}
				/>
			</div>
			{nothingMatches ? <p className="empty">{l10n.t("No settings match the filter.")}</p> : null}
			<div className="settings-groups">
				{SETTING_GROUPS.map((group, index) => {
					// Two groups carry non-scalar tails: Models gets the two record
					// editors (mirroring the manifest's grouping - they are model
					// settings, not a page of their own), Usage gets the status bar
					// mode enum and the alert-thresholds row.
					const isModelsGroup = group.booleans.includes("models.openRouterCatalog");
					const isUsageGroup = group.numbers.includes("usage.pollInterval");
					const statusBarVisible =
						needle.length === 0 ||
						l10n.t("Usage status bar").toLowerCase().includes(needle) ||
						"usage.statusbar".includes(needle);
					const thresholdsVisible =
						needle.length === 0 ||
						l10n.t("Usage alert thresholds").toLowerCase().includes(needle) ||
						"usage.alertthresholds".includes(needle);
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
								(isUsageGroup && (statusBarVisible || thresholdsVisible))
							}
							tail={
								isModelsGroup ? (
									<>
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
								) : isUsageGroup ? (
									<>
										<UsageThresholdsRow
											values={settings.usage.alertThresholds}
											configuredScope={settings.usage.thresholdsScope}
											hidden={!thresholdsVisible}
										/>
										<UsageStatusBarRow
											mode={settings.usage.statusBarMode}
											configuredScope={settings.usage.statusBarScope}
											hidden={!statusBarVisible}
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
					hint={helpImportExportGroup}
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
		</section>
	);
}
