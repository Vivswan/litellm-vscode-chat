/**
 * The Settings tab: every scalar setting as one row over the same configuration the
 * Settings editor writes - two views of one file, never two stores. The row anatomy and
 * the filter pipeline live in settingRows.tsx, shared with the Features tab; the
 * per-feature rows live on that tab (featuresPage.tsx), and this page renders everything
 * else: the scalar groups, the record editors, and the import/export tail.
 */

import * as l10n from "@vscode/l10n";
import type { FocusEvent, ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import type { SettingWriteMethod } from "../../dashboard/endpoints";
import { WIRE_LIMITS } from "../../dashboard/endpoints";
import { formatPercentExact } from "../../dashboard/spendFormat";
import type {
	CatalogStatusView,
	DashboardModel,
	DashboardSettings,
	SettingRowId,
	SettingScope,
	StringListSetting,
	UsageStatusBarModeSetting,
} from "../../dashboard/viewModels";
import { BOOLEAN_SETTING_IDS, NUMBER_SETTING_IDS, settingRowPage } from "../../dashboard/viewModels";
import type {
	BooleanSettingId,
	NumberSettingId,
	TokenEstimationMode,
	UiAccent,
	UiTheme,
} from "../../shared/config/settingSpec";
import { isUsableThreshold, TOKEN_ESTIMATION_MODES, UI_ACCENTS, UI_THEMES } from "../../shared/config/settingSpec";
import { useAlertOnce } from "./announceOnce";
import { DOCS_LINK_OPENROUTER_CATALOG, DOCS_LINK_SETTINGS } from "./docsLinks";
import { DocsLink } from "./help";
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

/**
 * The inspectors' configure-jump into one of this tab's record editors: which editor plus
 * the ExternalRecordEdit it applies. Minted by App; the seq keys re-delivery.
 */
export interface EditRecordRequest extends ExternalRecordEdit {
	readonly kind: "parameters" | "capabilities";
}

/**
 * The form's grouping and order, most-touched first. Presentation only: anything not
 * placed here still renders in a trailing "Other" group, so a new setting can never
 * silently vanish (feature-owned rows render on the Features tab instead, which the
 * owner map states). Titles are zero-arg functions so localized text resolves at render.
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
							className="cursor-pointer rounded-full p-0.5 outline-offset-(--ring-offset) has-[:checked]:outline-(length:--ring-w) has-[:checked]:outline-foreground has-[:checked]:outline-solid has-[:focus-visible]:outline-(length:--ring-w) has-[:focus-visible]:outline-ring has-[:focus-visible]:outline-solid"
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
 * One threshold box's parse: a fraction (0.8), a percentage (80%), or a bare number
 * above 1 read as percent. The docs' bound applies after conversion: (0, 1].
 * Lossy in value space by an ulp ("53.3%" is not 0.533 back), but render ->
 * parse -> render IS a fixed point, which is the space commit() compares in.
 */
export function parseThresholdBox(
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
	if (!isUsableThreshold(value)) {
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
	const externalWarning = values.length === 2 ? formatPercentExact(values[0] as number) : "";
	const externalError =
		values.length === 2
			? formatPercentExact(values[1] as number)
			: values.length === 1
				? formatPercentExact(values[0] as number)
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
		// "Did the user change anything" compares in the vocabulary the boxes
		// show: reparsing a rendered percent lands an ulp off the stored value,
		// so a raw compare reads an untouched blur as an edit.
		if (parsed.map(formatPercentExact).join(",") !== values.map(formatPercentExact).join(",")) {
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
				formatPercentExact(values[0] as number),
				formatPercentExact(values[values.length - 1] as number)
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
						<span className="font-mono tabular-nums">{values.map(formatPercentExact).join(", ")}</span>
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

/** The chat.additionalToolSchemaKeywords row over the shared comma-list editor. */
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
 * Where scalar edits land, for the header's meta line: User settings, except a setting
 * the workspace already sets is changed there (the write-scope rule).
 */
function scopeSummary(scopes: readonly (SettingScope | null)[]): string {
	return scopes.some((scope) => scope === "workspace")
		? l10n.t("editing User settings; a value set in Workspace settings is changed there")
		: l10n.t("editing User settings");
}

/** This page's rows' configured scopes, in one list: the meta line counts and summarizes over it. */
function configuredScopes(settings: DashboardSettings): readonly (SettingScope | null)[] {
	return [
		// Only the scalars this page owns: the feature rows' scopes belong to
		// the Features page's own count.
		...NUMBER_SETTING_IDS.filter((id) => settingRowPage(id) === "settings").map(
			(id) => settings.configuredScopes.numbers[id]
		),
		...BOOLEAN_SETTING_IDS.filter((id) => settingRowPage(id) === "settings").map(
			(id) => settings.configuredScopes.booleans[id]
		),
		settings.chat.tokenEstimationScope,
		settings.chat.additionalToolSchemaKeywords.scope,
		settings.usage.statusBarScope,
		settings.usage.thresholdsScope,
		settings.usage.currencySymbolScope,
		settings.appearance.themeScope,
		settings.appearance.accentScope,
	];
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
	const { needle, matches } = filterMatcher(filter);
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
	// A scalar neither placed here nor owned by the Features page still renders
	// (the trailing "Other" group), so a new setting can never silently vanish.
	const otherNumbers = NUMBER_SETTING_IDS.filter((id) => !placed.has(id) && settingRowPage(id) === "settings");
	const otherBooleans = BOOLEAN_SETTING_IDS.filter((id) => !placed.has(id) && settingRowPage(id) === "settings");

	const paramsVisible =
		needle.length === 0 ||
		recordEditorMatches(needle, modelParametersTitle(), helpModelParametersSection(), settings.modelParameters);
	const capsVisible =
		needle.length === 0 ||
		recordEditorMatches(needle, modelCapabilitiesTitle(), helpModelCapabilitiesSection(), settings.modelCapabilities);
	const scalarIds = [...NUMBER_SETTING_IDS, ...BOOLEAN_SETTING_IDS].filter((id) => settingRowPage(id) === "settings");
	const anyScalarVisible = scalarIds.some(isVisible);
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
	// rows carry the named verdicts above, every scalar row the shared one, and
	// anything else fails OPEN to visible - an id this page cannot name must
	// render its notice, never crash a lookup (settingRowPage's contract).
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
				return isScalarRowId(row) ? isVisible(row) : true;
		}
	};
	const { rowFailures, unclaimed } = placeWriteFailures(writeFailures, "settings", rowVisible);
	// One announcement per failure seq across every surface: the pane-top away
	// line may already have spoken this failure before the reader arrived here.
	const unclaimedRole = useAlertOnce(unclaimed?.seq);
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
				{unclaimed !== undefined ? (
					<p key={unclaimed.seq} className="error" role={unclaimedRole}>
						{writeFailureText(unclaimed)}
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
												setting={settings.chat.additionalToolSchemaKeywords}
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
					    chrome) and at the primary rank - a section whose whole content is its actions has
					    no quieter neighbour to rank under. Rendered last so file transfer never sits
					    between rows. */}
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
								<Button onClick={() => sendRequest("executeCommand", { command: "exportSettings" })}>
									{l10n.t("Export settings")}
								</Button>
								<Button onClick={() => sendRequest("executeCommand", { command: "importSettings" })}>
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
