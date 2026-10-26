/**
 * The settings page: the scalar rows grouped most-touched first. Grouping is presentation only: a setting not placed in
 * SETTING_GROUPS still renders in a trailing "Other" group, so a new setting can never silently vanish, and the
 * feature-owned rows render on the Features tab instead (the owner map states which).
 */

import * as l10n from "@vscode/l10n";
import type { FocusEvent, ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import type { SettingWriteMethod } from "../../dashboard/endpoints";
import { WIRE_LIMITS } from "../../dashboard/endpoints";
import { parseThresholdBox } from "../../dashboard/presenters";
import { formatPercentExact } from "../../dashboard/spendFormat";
import type {
	CatalogStatusView,
	DashboardModel,
	DashboardSettings,
	SettingRowId,
	SettingScope,
	StringListSetting,
} from "../../dashboard/viewModels";
import { BOOLEAN_SETTING_IDS, NUMBER_SETTING_IDS, settingRowPage } from "../../dashboard/viewModels";
import type {
	BooleanSettingId,
	NumberSettingId,
	SessionIdMode,
	TokenEstimationMode,
	UiAccent,
	UiTheme,
	UsageStatusBarMode,
} from "../../shared/config/settingSpec";
import {
	SESSION_ID_MODES,
	TOKEN_ESTIMATION_MODES,
	UI_ACCENTS,
	UI_THEMES,
	USAGE_STATUS_BAR_MODES,
} from "../../shared/config/settingSpec";
import { useAlertOnce } from "./announceOnce";
import { DOCS_LINK_OPENROUTER_CATALOG, DOCS_LINK_SETTINGS } from "./docsLinks";
import { DocsLink } from "./help";
import {
	helpCurrencySymbol,
	helpImportExportGroup,
	helpModelCapabilitiesSection,
	helpModelParametersSection,
	helpSessionId,
	helpSettingsSection,
	helpTokenEstimation,
	helpToolSchemaKeywords,
	helpUiAccent,
	helpUiTheme,
	helpUsageStatusBar,
	helpUsageThresholds,
	settingRowHelp,
} from "./helpText";
import type { ExternalRecordEdit } from "./recordEditors";
import {
	ModelCapabilitiesEditor,
	ModelParametersEditor,
	modelCapabilitiesTitle,
	modelParametersTitle,
} from "./recordEditors";
import type { SettingWriteFailure } from "./settingRows";
import {
	CommaListRow,
	EnumSettingRow,
	filterMatcher,
	isScalarRowId,
	placeWriteFailures,
	SETTING_GRID_TRACKS,
	SettingFailuresContext,
	SettingGroup,
	SettingRow,
	scalarText,
	writeFailureText,
} from "./settingRows";
import { relativeTime } from "./time";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { Input } from "./ui/input";
import { Radio } from "./ui/radio";
import { Section } from "./ui/section";
import { sendRequest } from "./vscodeApi";

/** Minted by App; the seq keys re-delivery. */
export interface EditRecordRequest extends ExternalRecordEdit {
	readonly kind: "parameters" | "capabilities";
}

/** The groups in form order; titles are zero-arg functions so localized text resolves at render. */
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
	{ title: () => l10n.t("Logs"), numbers: [], booleans: ["logs.redactSecrets"] },
];

/**
 * The catalog row's status text, one place for the row AND the filter: the row shows exactly these strings and the
 * filter matches on them, so a needle always finds the row that visibly says it (the non-scalar description functions'
 * no-drift rule).
 */
function catalogStatusParts(
	catalog: CatalogStatusView,
	enabled: boolean,
	now: number
): { readonly off?: string; readonly summary?: string; readonly failure?: string | undefined } {
	if (!enabled) {
		return { off: l10n.t("Catalog off: no refreshes and no implicit ID matching.") };
	}
	const updated = catalog.lastSuccessAt === undefined ? undefined : relativeTime(catalog.lastSuccessAt, now);
	const count = catalog.modelCount === 1 ? l10n.t("1 catalog model") : l10n.t("{0} catalog models", catalog.modelCount);
	const age = updated === undefined ? l10n.t("bundled snapshot") : l10n.t("updated {0}", updated);
	return {
		summary: `${count} - ${age}`,
		// The classification is CatalogRefreshFailure's fixed English vocabulary, protocol-ish like header names, so it
		// renders raw.
		failure:
			catalog.lastFailure === undefined
				? undefined
				: l10n.t("Last refresh failed ({0}); serving the cached snapshot.", catalog.lastFailure.classification),
	};
}

/**
 * The OpenRouter catalog row's status cluster (docs/dashboard.md#settings), in the row's description slot: snapshot
 * size and age, Refresh, a standing failure on its own line - never a toast - and a short inert line while off. The
 * prose lives in the row's "?".
 */
function CatalogMeta({ catalog, enabled, now }: { catalog: CatalogStatusView; enabled: boolean; now: number }) {
	const parts = catalogStatusParts(catalog, enabled, now);
	if (parts.off !== undefined) {
		return <span className="catalog-status">{parts.off}</span>;
	}
	return (
		// Plain inline flow, not inline-flex: an atomic inline-flex box takes the whole column the moment it wraps,
		// stranding the trailing "?" alone on the line below.
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
			{parts.failure === undefined ? null : (
				<>
					{/* The break gives the failure a line start of its own without
					    jamming red text beside Refresh, while the error itself stays
					    INLINE: a block box would break after itself too and strand
					    the row's trailing "?" alone on the next line. */}
					<br />
					<span className="error">{parts.failure}</span>
				</>
			)}
		</span>
	);
}

/**
 * The non-scalar rows' descriptions, held here because the filter matches on them exactly as it does scalar
 * descriptions: visible text and filter text must not drift.
 */
function usageStatusBarDescription(): string {
	// What the shown number means lives in the row's "?" (helpUsageStatusBar).
	return l10n.t("When the spend status bar item shows.");
}

function tokenEstimationDescription(): string {
	return l10n.t("How prompts are sized for the local token budget.");
}

function sessionIdDescription(): string {
	return l10n.t("What LiteLLM groups this chat's requests under, e.g. one session per chat.");
}

function toolSchemaKeywordsDescription(): string {
	// The example lives in the input's own placeholder, one column to the left.
	return l10n.t("Extra JSON-Schema keywords kept in tool definitions.");
}

/**
 * The thresholds row's explanation per branch: the read-only custom branch renders no fields, so "clear both fields"
 * would instruct gestures the row cannot take. Branch-keyed because the filter matches the same text the row shows.
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
	// The Auto option names its own behavior ("Follow the editor"), and the row's "?" (helpUiTheme) states it with the
	// high-contrast exception.
	return l10n.t("Whether the dashboard renders light or dark.");
}

function uiAccentDescription(): string {
	return l10n.t("Marks primary actions, selection, focus and links.");
}

/** The usage.statusBar mode names, resolved at call time (no module-level localized constants). */
function statusBarModeLabel(mode: UsageStatusBarMode): string {
	switch (mode) {
		case "always":
			return l10n.t("Always shown");
		case "alerts-only":
			return l10n.t("Only while a threshold is crossed");
		case "off":
			return l10n.t("Never shown");
	}
}

/** The chat.tokenEstimation mode names, resolved at call time (no module-level localized constants). */
function tokenEstimationLabel(mode: TokenEstimationMode): string {
	switch (mode) {
		case "auto":
			return l10n.t("Auto - tokenizer when text needs it");
		case "heuristic":
			return l10n.t("Heuristic - 4 characters per token");
		// The encoding names are protocol terms and stay untranslated; the parenthetical says which model families they
		// meter.
		case "o200k_base":
			return l10n.t("o200k_base tokenizer (GPT-4o and newer)");
		case "cl100k_base":
			return l10n.t("cl100k_base tokenizer (GPT-4 era)");
	}
}

/** The session id modes, as the row shows them: what LiteLLM groups the requests by. */
function sessionIdLabel(mode: SessionIdMode): string {
	switch (mode) {
		case "off":
			return l10n.t({
				message: "Off",
				comment: ["The session id setting's off value: no session id rides the request"],
			});
		case "on":
			return l10n.t("On - one session per chat");
		case "folder":
			return l10n.t("Per open folder");
		case "window":
			return l10n.t("Per VS Code window");
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
 * The ui.accent row: four swatches, because the choice IS the color. Native radios carry semantics and keyboard; the
 * visible swatch is their label, ringed when checked and when the hidden input takes focus.
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
							// The checked ring is the foreground, not the accent: a violet ring around the violet
							// swatch is not a selection marker.
							className={cn(
								"cursor-pointer rounded-full p-0.5 outline-offset-(--ring-offset)",
								"has-[:checked]:outline-(length:--ring-w) has-[:checked]:outline-foreground",
								"has-[:checked]:outline-solid has-[:focus-visible]:outline-(length:--ring-w)",
								"has-[:focus-visible]:outline-ring has-[:focus-visible]:outline-solid"
							)}
						>
							<Radio
								className="visually-hidden"
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

/**
 * One of the two threshold inputs with its trailing label; error and hint lines render at the row level.
 *
 *   onCommit -> blur (with where focus went) or Enter; the row decides whether the pair commits
 */
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
	onCommit: (event?: FocusEvent) => void;
}) {
	return (
		// One flex ITEM per pair: the wrapping control cell may break between the two pairs at the 320px floor, but
		// never inside one - loose siblings wrapped as "80% warning 95%" / "error", stranding a label alone. The inner
		// gap-2 restates the cell's own, so the pair reads unchanged.
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

/** The two boxes' texts for a stored list. */
interface ThresholdTexts {
	readonly warning: string;
	readonly error: string;
}

/** The two boxes as one draft: their texts, their parses, and the sorted list they write when both read clean. */
interface ThresholdDraft {
	readonly warningText: string;
	readonly errorText: string;
	readonly setWarningText: (next: string) => void;
	readonly setErrorText: (next: string) => void;
	readonly warning: ReturnType<typeof parseThresholdBox>;
	readonly error: ReturnType<typeof parseThresholdBox>;
	readonly parsed: readonly number[] | undefined;
}

interface ThresholdBoxesProps {
	readonly warningId: string;
	readonly errorInputId: string;
	readonly problemId: string;
	readonly draft: ThresholdDraft;
	readonly onCommit: (event?: FocusEvent) => void;
}

/**
 * Stored -> boxes: [low, high] fills both; a single value is the error threshold by the alerts' semantics, so it fills
 * the Error box alone.
 */
function storedThresholdTexts(values: readonly number[]): ThresholdTexts {
	if (values.length === 2) {
		return { warning: formatPercentExact(values[0] as number), error: formatPercentExact(values[1] as number) };
	}
	return { warning: "", error: values.length === 1 ? formatPercentExact(values[0] as number) : "" };
}

/** The list the two boxes write: sorted, equal values collapsed, nothing while either box reads invalid. */
function parsedThresholds(
	warning: ReturnType<typeof parseThresholdBox>,
	error: ReturnType<typeof parseThresholdBox>
): readonly number[] | undefined {
	if (warning.kind === "invalid" || error.kind === "invalid") {
		return undefined;
	}
	const values = [
		...(warning.kind === "value" ? [warning.value] : []),
		...(error.kind === "value" ? [error.value] : []),
	];
	return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * The boxes' draft, resynced from the store on every value or scope change. One parse per keystroke feeds display and
 * commit alike.
 */
function useThresholdDraft(values: readonly number[], configuredScope: SettingScope | null): ThresholdDraft {
	const stored = storedThresholdTexts(values);
	const [warningText, setWarningText] = useState(stored.warning);
	const [errorText, setErrorText] = useState(stored.error);
	const syncKey = `${values.join(",")}@${configuredScope ?? "default"}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on syncKey alone
	useEffect(() => {
		setWarningText(stored.warning);
		setErrorText(stored.error);
	}, [syncKey]);
	const warning = parseThresholdBox(warningText);
	const error = parseThresholdBox(errorText);
	return {
		warningText,
		errorText,
		setWarningText,
		setErrorText,
		warning,
		error,
		parsed: parsedThresholds(warning, error),
	};
}

/**
 * The description's trailing semantics. The custom branch reads the stored list - its boxes do not exist, so their
 * empty drafts must not speak for it (they once printed "Alerts are off." beside a live list); the editable branch
 * reads the live draft the boxes hold.
 */
function thresholdSemanticsHint(
	custom: boolean,
	values: readonly number[],
	parsed: readonly number[] | undefined
): string | undefined {
	if (custom) {
		return l10n.t(
			"Warns from {0}; errors at {1}.",
			formatPercentExact(values[0] as number),
			formatPercentExact(values[values.length - 1] as number)
		);
	}
	if (parsed === undefined) {
		return undefined;
	}
	if (parsed.length === 0) {
		return l10n.t("Alerts are off.");
	}
	return parsed.length === 1 ? l10n.t("A single threshold goes straight to the error alert.") : undefined;
}

/** The warning and error boxes, each with its unit-style trailing label. */
function ThresholdBoxes({ warningId, errorInputId, problemId, draft, onCommit }: ThresholdBoxesProps) {
	return (
		<>
			<ThresholdBox
				id={warningId}
				label={l10n.t({
					message: "warning",
					comment: ["Trailing label after the lower usage-alert threshold input, unit-style."],
				})}
				text={draft.warningText}
				invalid={draft.warning.kind === "invalid"}
				errorId={problemId}
				placeholder={l10n.t("e.g. 80%")}
				onText={draft.setWarningText}
				onCommit={onCommit}
			/>
			<ThresholdBox
				id={errorInputId}
				label={l10n.t({
					message: "error",
					comment: ["Trailing label after the higher usage-alert threshold input, unit-style."],
				})}
				text={draft.errorText}
				invalid={draft.error.kind === "invalid"}
				errorId={problemId}
				placeholder={l10n.t("e.g. 95%")}
				onText={draft.setErrorText}
				onCommit={onCommit}
			/>
		</>
	);
}

/**
 * Both set writes [low, high] (sorted, equal values collapse); one writes a single-element list (treated as the error
 * threshold); both empty writes [] (off). A stored list the boxes cannot represent renders read-only with the reveal
 * button, so the dashboard never destroys it.
 *
 * The two boxes are ONE draft: a blur that only moves focus to the sibling box must not commit, or the write's own
 * state push would resync the pair and overwrite what is being typed in the second box. Enter and a blur leaving the
 * pair commit.
 *
 * "Did the user change anything" compares in the vocabulary the boxes show: reparsing a rendered percent lands an ulp
 * off the stored value, so a raw compare reads an untouched blur as an edit.
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
	const draft = useThresholdDraft(values, configuredScope);
	const { parsed } = draft;
	const inputId = "setting-usage.alertThresholds";
	const warningId = `${inputId}-warning`;
	const errorInputId = `${inputId}-error-at`;
	const problemId = `${inputId}-problem`;
	const commit = (event?: FocusEvent) => {
		const next = event?.relatedTarget;
		if (next instanceof HTMLElement && (next.id === warningId || next.id === errorInputId)) {
			return;
		}
		if (parsed === undefined) {
			return;
		}
		if (parsed.map(formatPercentExact).join(",") !== values.map(formatPercentExact).join(",")) {
			sendRequest("setUsageAlertThresholds", { values: parsed });
		}
	};
	const custom = values.length > 2;
	const semanticsHint = thresholdSemanticsHint(custom, values, parsed);
	return (
		<SettingRow
			settingId="usage.alertThresholds"
			title={l10n.t("Usage alert thresholds")}
			titleFor={custom ? undefined : warningId}
			description={
				<>
					{usageThresholdsDescription(custom)}
					{semanticsHint === undefined ? null : <span className="ml-1 text-foreground">{semanticsHint}</span>}
				</>
			}
			// The tip instructs the two boxes, so it renders only where they do: the custom branch has no fields to
			// enter or clear.
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
						<span className="font-mono tabular-nums">{values.map(formatPercentExact).join(", ")}</span>
						<span className="hint">{l10n.t("Custom list - edit in settings.json.")}</span>
					</>
				) : (
					<ThresholdBoxes
						warningId={warningId}
						errorInputId={errorInputId}
						problemId={problemId}
						draft={draft}
						onCommit={commit}
					/>
				)
			}
		/>
	);
}

/**
 * maxLength gates typing only: a longer symbol hand-written in settings.json round-trips into the box, and the row
 * must neither truncate it nor let a commit die as a generic envelope failure - an over-limit draft shows the bound
 * (WIRE_LIMITS.currencySymbol, which the intent schema also reads) and never commits.
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on syncKey alone
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

function ToolSchemaKeywordsRow({ setting, hidden }: { setting: StringListSetting; hidden: boolean }) {
	return (
		<CommaListRow
			settingId="chat.additionalToolSchemaKeywords"
			title={l10n.t("Extra tool schema keywords")}
			description={toolSchemaKeywordsDescription()}
			help={helpToolSchemaKeywords()}
			placeholder={l10n.t("e.g. propertyNames, patternProperties")}
			values={setting.values}
			lossy={setting.lossy}
			maxLength={WIRE_LIMITS.schemaKeyword}
			maxCount={WIRE_LIMITS.schemaKeywords}
			countProblem={(max) => l10n.t("At most {0} keywords.", max)}
			lengthProblem={(max) => l10n.t("Keywords run up to {0} characters each.", max)}
			configuredScope={setting.scope}
			hidden={hidden}
			onCommit={(next) => sendRequest("setAdditionalToolSchemaKeywords", { values: next })}
		/>
	);
}

/**
 * Where scalar edits land, for the header's meta line: User settings, except a setting the workspace already sets is
 * changed there (the write-scope rule).
 */
function scopeSummary(scopes: readonly (SettingScope | null)[]): string {
	return scopes.some((scope) => scope === "workspace")
		? l10n.t("editing User settings; a value set in Workspace settings is changed there")
		: l10n.t("editing User settings");
}

function configuredScopes(settings: DashboardSettings): readonly (SettingScope | null)[] {
	return [
		// Only the scalars this page owns: the feature rows' scopes belong to the Features page's own count.
		...NUMBER_SETTING_IDS.filter((id) => settingRowPage(id) === "settings").map(
			(id) => settings.configuredScopes.numbers[id]
		),
		...BOOLEAN_SETTING_IDS.filter((id) => settingRowPage(id) === "settings").map(
			(id) => settings.configuredScopes.booleans[id]
		),
		settings.chat.tokenEstimationScope,
		settings.chat.additionalToolSchemaKeywords.scope,
		settings.chat.sessionIdScope,
		settings.usage.statusBarScope,
		settings.usage.thresholdsScope,
		settings.usage.currencySymbolScope,
		settings.appearance.themeScope,
		settings.appearance.accentScope,
	];
}

/** Store keys only, deliberately: a dirty draft lives inside the editor, which the filter hides but never unmounts. */
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

/** Which of the four groups carrying non-scalar tails a group is, mirroring the manifest's grouping. */
type TailGroupKind = "models" | "chat" | "usage" | "ui";

/** The filter's verdict per non-scalar row, each named so the empty-state verdict and the placement can read them. */
interface TailVisibility {
	readonly params: boolean;
	readonly caps: boolean;
	readonly statusBar: boolean;
	readonly tokenEstimation: boolean;
	readonly toolSchemaKeywords: boolean;
	readonly sessionId: boolean;
	readonly thresholds: boolean;
	readonly currency: boolean;
	readonly theme: boolean;
	readonly accent: boolean;
	readonly importExport: boolean;
}

/** The filter's verdicts for the whole page, from one matcher. */
interface SettingsVisibility {
	readonly scalar: (id: NumberSettingId | BooleanSettingId) => boolean;
	readonly tail: TailVisibility;
	readonly nothingMatches: boolean;
	readonly row: (row: SettingRowId) => boolean;
}

interface GroupTailProps {
	readonly kind: TailGroupKind;
	readonly settings: DashboardSettings;
	readonly models: readonly DashboardModel[];
	readonly observedModelInfoKeys: readonly string[] | undefined;
	readonly editRecordRequest: EditRecordRequest | undefined;
	readonly tail: TailVisibility;
}

interface SettingsToolbarProps {
	readonly filterId: string;
	readonly filter: string;
	readonly onFilter: (next: string) => void;
}

interface ImportExportGroupProps {
	readonly settings: DashboardSettings;
	readonly isVisible: (id: NumberSettingId | BooleanSettingId) => boolean;
	readonly visible: boolean;
}

/**
 * The non-scalar rows filter by the same rule as the scalar ones, so a needle cannot find one kind and miss the other.
 * The thresholds row's editable-branch help joins its haystack only while that branch renders it: a needle from the
 * tip must not keep the custom row alive.
 *
 * The Import & Export group's help stays OUT of the haystack even though row-level help is in: a group matched through
 * group help would stand with no row in it matching - the reader scans the surviving rows and finds the needle in
 * none. Section-level help is out likewise.
 */
function tailVisibility(settings: DashboardSettings, filter: ReturnType<typeof filterMatcher>): TailVisibility {
	const { needle, matches } = filter;
	const thresholdsCustom = settings.usage.alertThresholds.length > 2;
	return {
		params:
			needle.length === 0 ||
			recordEditorMatches(needle, modelParametersTitle(), helpModelParametersSection(), settings.modelParameters),
		caps:
			needle.length === 0 ||
			recordEditorMatches(needle, modelCapabilitiesTitle(), helpModelCapabilitiesSection(), settings.modelCapabilities),
		statusBar: matches(
			l10n.t("Usage status bar"),
			usageStatusBarDescription(),
			"usage.statusBar",
			helpUsageStatusBar()
		),
		tokenEstimation: matches(
			l10n.t("Token estimation"),
			tokenEstimationDescription(),
			"chat.tokenEstimation",
			helpTokenEstimation()
		),
		toolSchemaKeywords: matches(
			l10n.t("Extra tool schema keywords"),
			toolSchemaKeywordsDescription(),
			"chat.additionalToolSchemaKeywords",
			helpToolSchemaKeywords()
		),
		sessionId: matches(l10n.t("Session id"), sessionIdDescription(), "chat.sessionId", helpSessionId()),
		thresholds: matches(
			l10n.t("Usage alert thresholds"),
			usageThresholdsDescription(thresholdsCustom),
			"usage.alertThresholds",
			...(thresholdsCustom ? [] : [helpUsageThresholds()])
		),
		currency: matches(
			l10n.t("Currency symbol"),
			currencySymbolDescription(),
			"usage.currencySymbol",
			helpCurrencySymbol()
		),
		theme: matches(l10n.t("Dashboard theme"), uiThemeDescription(), "ui.theme", helpUiTheme()),
		accent: matches(l10n.t("Accent color"), uiAccentDescription(), "ui.accent", helpUiAccent()),
		importExport:
			needle.length === 0 ||
			[l10n.t("Import & Export"), l10n.t("Export settings"), l10n.t("Import settings")].some((text) =>
				text.toLowerCase().includes(needle)
			),
	};
}

/**
 * The page's verdicts for one matcher. Row-level help is in a row's haystack: the "?" is visible at rest and its tip
 * carries the matching words, so a reader can see why the row survived.
 *
 * The catalog row's haystack is what that row SHOWS - its static description renders nowhere, and a translated bundle
 * renders the two keys independently, so only excluding it keeps "the haystack holds what the row shows" true in every
 * locale.
 *
 * `row` is total and fails OPEN to visible: an id this page cannot name must render its notice, never crash a lookup
 * (settingRowPage's contract).
 */
function settingsVisibility(
	settings: DashboardSettings,
	filter: ReturnType<typeof filterMatcher>,
	nowMs: number
): SettingsVisibility {
	const { matches } = filter;
	const catalogTexts = Object.values(
		catalogStatusParts(settings.catalog, settings.booleans["models.openRouterCatalog"], nowMs)
	).filter((text): text is string => text !== undefined);
	const scalar = (id: NumberSettingId | BooleanSettingId): boolean => {
		const { label, description } = scalarText(id);
		if (id === "models.openRouterCatalog") {
			return matches(label, id, settingRowHelp(id) ?? "", ...catalogTexts);
		}
		return matches(label, description, id, settingRowHelp(id) ?? "");
	};
	const tail = tailVisibility(settings, filter);
	const scalarIds = [...NUMBER_SETTING_IDS, ...BOOLEAN_SETTING_IDS].filter((id) => settingRowPage(id) === "settings");
	const nothingMatches = !scalarIds.some(scalar) && !Object.values(tail).some((visible) => visible);
	const tailRows: Partial<Record<SettingRowId, boolean>> = {
		"chat.tokenEstimation": tail.tokenEstimation,
		"chat.additionalToolSchemaKeywords": tail.toolSchemaKeywords,
		"chat.sessionId": tail.sessionId,
		"usage.alertThresholds": tail.thresholds,
		"usage.statusBar": tail.statusBar,
		"usage.currencySymbol": tail.currency,
		"ui.theme": tail.theme,
		"ui.accent": tail.accent,
	};
	const row = (id: SettingRowId): boolean => {
		const named = tailRows[id];
		if (named !== undefined) {
			return named;
		}
		return isScalarRowId(id) ? scalar(id) : true;
	};
	return { scalar, tail, nothingMatches, row };
}

/** The scalar rows no group places; they render in the trailing Other group so a new setting can never vanish. */
function otherScalarIds(): { readonly numbers: NumberSettingId[]; readonly booleans: BooleanSettingId[] } {
	const placed = new Set<string>(SETTING_GROUPS.flatMap((group) => [...group.numbers, ...group.booleans]));
	return {
		numbers: NUMBER_SETTING_IDS.filter((id) => !placed.has(id) && settingRowPage(id) === "settings"),
		booleans: BOOLEAN_SETTING_IDS.filter((id) => !placed.has(id) && settingRowPage(id) === "settings"),
	};
}

/** Which tail a group carries, by the scalar row that marks it; the other groups carry none. */
function tailGroupKind(group: (typeof SETTING_GROUPS)[number]): TailGroupKind | undefined {
	if (group.booleans.includes("models.openRouterCatalog")) {
		return "models";
	}
	if (group.numbers.includes("chat.timeout")) {
		return "chat";
	}
	if (group.numbers.includes("usage.pollInterval")) {
		return "usage";
	}
	return group.booleans.includes("ui.maskSecretInputs") ? "ui" : undefined;
}

/** Whether any of a group's tail rows survives the filter. */
function groupTailVisible(kind: TailGroupKind | undefined, tail: TailVisibility): boolean {
	switch (kind) {
		case "models":
			return tail.params || tail.caps;
		case "chat":
			return tail.tokenEstimation || tail.toolSchemaKeywords || tail.sessionId;
		case "usage":
			return tail.statusBar || tail.thresholds || tail.currency;
		case "ui":
			return tail.theme || tail.accent;
		default:
			return false;
	}
}

/** The header's quiet count of modified settings, then where they are set. */
function settingsMeta(scopes: readonly (SettingScope | null)[]): string {
	const modifiedCount = scopes.filter((scope) => scope !== null).length;
	const parts: string[] = [];
	if (modifiedCount === 1) {
		parts.push(l10n.t("1 modified"));
	} else if (modifiedCount > 1) {
		parts.push(l10n.t("{0} modified", modifiedCount));
	}
	parts.push(scopeSummary(scopes));
	return parts.join(" - ");
}

/**
 * The two record editors under the Models group. The editors' apply-together save model is stated by each editor's own
 * "?" (helpModelParametersSection and helpModelCapabilitiesSection), not by a free-standing paragraph between the rows.
 */
function ModelsGroupTail({ settings, models, observedModelInfoKeys, editRecordRequest, tail }: GroupTailProps) {
	return (
		<div className="settings-editors min-w-0">
			<ModelParametersEditor
				scoped={settings.modelParameters}
				models={models}
				hidden={!tail.params}
				external={editRecordRequest?.kind === "parameters" ? editRecordRequest : undefined}
			/>
			<ModelCapabilitiesEditor
				scoped={settings.modelCapabilities}
				models={models}
				observedKeys={observedModelInfoKeys}
				hidden={!tail.caps}
				external={editRecordRequest?.kind === "capabilities" ? editRecordRequest : undefined}
			/>
		</div>
	);
}

/** The Chat group's enum and list rows. */
function ChatGroupTail({ settings, tail }: GroupTailProps) {
	return (
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
				hidden={!tail.tokenEstimation}
			/>
			<ToolSchemaKeywordsRow setting={settings.chat.additionalToolSchemaKeywords} hidden={!tail.toolSchemaKeywords} />
			<EnumSettingRow
				settingId="chat.sessionId"
				title={l10n.t("Session id")}
				description={sessionIdDescription()}
				help={helpSessionId()}
				value={settings.chat.sessionId}
				options={SESSION_ID_MODES}
				optionLabel={sessionIdLabel}
				onPick={(value) => sendRequest("setChatSessionId", { value })}
				configuredScope={settings.chat.sessionIdScope}
				hidden={!tail.sessionId}
			/>
		</>
	);
}

/** The Usage group's threshold, status-bar, and currency rows. */
function UsageGroupTail({ settings, tail }: GroupTailProps) {
	return (
		<>
			<UsageThresholdsRow
				values={settings.usage.alertThresholds}
				configuredScope={settings.usage.thresholdsScope}
				hidden={!tail.thresholds}
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
				hidden={!tail.statusBar}
			/>
			<CurrencySymbolRow
				value={settings.usage.currencySymbol}
				configuredScope={settings.usage.currencySymbolScope}
				hidden={!tail.currency}
			/>
		</>
	);
}

function UiGroupTail({ settings, tail }: GroupTailProps) {
	return (
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
				hidden={!tail.theme}
			/>
			<UiAccentRow
				accent={settings.appearance.accent}
				configuredScope={settings.appearance.accentScope}
				hidden={!tail.accent}
			/>
		</>
	);
}

/** A group's tail rows by its kind. */
function GroupTail(props: GroupTailProps) {
	switch (props.kind) {
		case "models":
			return <ModelsGroupTail {...props} />;
		case "chat":
			return <ChatGroupTail {...props} />;
		case "usage":
			return <UsageGroupTail {...props} />;
		case "ui":
			return <UiGroupTail {...props} />;
	}
}

/**
 * The header line's actions. The filter's one home is the header line: it governs the whole page the way the header's
 * other actions do, and a floating box between the header and the first group read as belonging to nothing. 16rem
 * beside the button while the header line holds both; once the 640px strip wrap gives the input its own line, w-full
 * is what makes it BE that line.
 */
function SettingsToolbar({ filterId, filter, onFilter }: SettingsToolbarProps) {
	return (
		<>
			<Input
				id={filterId}
				type="text"
				className="w-[16rem] @max-[640px]/pane:w-full min-w-0 max-w-full shrink"
				placeholder={l10n.t("Filter settings, e.g. timeout")}
				aria-label={l10n.t("Filter settings")}
				value={filter}
				onChange={(event) => onFilter(event.currentTarget.value)}
			/>
			<Button
				variant="secondary"
				className="whitespace-nowrap"
				onClick={() => sendRequest("executeCommand", { command: "openSettings" })}
			>
				{l10n.t("Open in Settings editor")}
			</Button>
		</>
	);
}

/**
 * The trailing Import & Export group: the two actions ARE its content, so they stand in its body at full size (parked
 * in the heading's actions slot they read as tucked-away chrome) and at the primary rank - a section whose whole
 * content is its actions has no quieter neighbour to rank under. Rendered last so file transfer never sits between rows.
 */
function ImportExportGroup({ settings, isVisible, visible }: ImportExportGroupProps) {
	return (
		<SettingGroup
			title={() => l10n.t("Import & Export")}
			help={helpImportExportGroup}
			numbers={[]}
			booleans={[]}
			settings={settings}
			isVisible={isVisible}
			tailVisible={visible}
			tail={
				<div className="settings-transfer flex flex-wrap items-center gap-x-3.5 gap-y-1 py-2">
					<Button onClick={() => sendRequest("executeCommand", { command: "exportSettings" })}>
						{l10n.t("Export settings")}
					</Button>
					<Button onClick={() => sendRequest("executeCommand", { command: "importSettings" })}>
						{l10n.t("Import settings")}
					</Button>
				</div>
			}
		/>
	);
}

/**
 * The Settings page. One clock reading for the whole render: the filter haystack and the rendered status cluster must
 * speak the same age - two Date.now() calls straddling a minute boundary would let a needle match "5 min ago" while
 * the row shows 6. A jump must land on a visible editor: a leftover filter that hides the target section would swallow
 * the focus, so the request clears it.
 */
export function SettingsSection({
	settings,
	models,
	observedModelInfoKeys,
	now,
	editRecordRequest,
	writeFailures,
}: {
	/** The scalars with their scopes, the two scoped records, and the catalog status, as the push carries them. */
	settings: DashboardSettings;

	/** The discovered models; the record editors' matcher inputs suggest from them. */
	models: readonly DashboardModel[];

	/** The cross-server observed /model/info key union (DashboardState.observedModelInfoKeys): the hints' evidence. */
	observedModelInfoKeys?: readonly string[] | undefined;

	/** The shared clock tick; the catalog row's "updated N ago" reads it. */
	now?: number;

	/** The inspectors' configure-jump into one of the record editors (EditRecordRequest). */
	editRecordRequest?: EditRecordRequest | undefined;

	/** The standing scalar-write failures from App's store, for this page to place by owning row. */
	writeFailures?: Partial<Record<SettingWriteMethod, SettingWriteFailure>> | undefined;
}) {
	const [filter, setFilter] = useState("");
	const filterId = useId();
	const editSeq = editRecordRequest?.seq;
	useEffect(() => {
		if (editSeq !== undefined) {
			setFilter("");
		}
	}, [editSeq]);
	const nowMs = now ?? Date.now();
	const visibility = settingsVisibility(settings, filterMatcher(filter), nowMs);
	const { tail } = visibility;
	const other = otherScalarIds();
	const booleanMeta: Partial<Record<BooleanSettingId, ReactNode>> = {
		"models.openRouterCatalog": (
			<CatalogMeta catalog={settings.catalog} enabled={settings.booleans["models.openRouterCatalog"]} now={nowMs} />
		),
	};
	const { rowFailures, unclaimed } = placeWriteFailures(writeFailures, "settings", visibility.row);
	// One announcement per failure seq across every surface: the pane-top away line may already have spoken this
	// failure before the reader arrived here.
	const unclaimedRole = useAlertOnce(unclaimed?.seq);
	return (
		<SettingFailuresContext.Provider value={rowFailures}>
			<Section
				id="settings"
				title={l10n.t("Settings")}
				help={helpSettingsSection()}
				docs={{ href: DOCS_LINK_SETTINGS, label: l10n.t("Open the settings guide") }}
				meta={settingsMeta(configuredScopes(settings))}
				actions={<SettingsToolbar filterId={filterId} filter={filter} onFilter={setFilter} />}
			>
				{/* The fallback for a failure no mounted row claims; a claimed one renders under its own row instead
				    (see SettingRow). */}
				{unclaimed === undefined ? null : (
					<p key={unclaimed.seq} className="error" role={unclaimedRole}>
						{writeFailureText(unclaimed)}
					</p>
				)}
				{visibility.nothingMatches ? <p className="empty">{l10n.t("No settings match the filter.")}</p> : null}
				{/* The wide tier's track owner (SETTING_GRID_TRACKS): groups and rows
				    subgrid onto these columns, so the label gutter is one measured
				    width for the whole page. */}
				<div className={SETTING_GRID_TRACKS}>
					{SETTING_GROUPS.map((group, index) => {
						const kind = tailGroupKind(group);
						return (
							<SettingGroup
								// biome-ignore lint/suspicious/noArrayIndexKey: the group list is a fixed literal
								key={index}
								{...group}
								settings={settings}
								isVisible={visibility.scalar}
								booleanMeta={booleanMeta}
								tailVisible={groupTailVisible(kind, tail)}
								tail={
									kind === undefined ? undefined : (
										<GroupTail
											kind={kind}
											settings={settings}
											models={models}
											observedModelInfoKeys={observedModelInfoKeys}
											editRecordRequest={editRecordRequest}
											tail={tail}
										/>
									)
								}
							/>
						);
					})}
					{other.numbers.length + other.booleans.length > 0 ? (
						<SettingGroup
							title={() => l10n.t("Other")}
							numbers={other.numbers}
							booleans={other.booleans}
							settings={settings}
							isVisible={visibility.scalar}
						/>
					) : null}
					<ImportExportGroup settings={settings} isVisible={visibility.scalar} visible={tail.importExport} />
				</div>
			</Section>
		</SettingFailuresContext.Provider>
	);
}
