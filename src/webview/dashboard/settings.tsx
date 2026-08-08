import * as l10n from "@vscode/l10n";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
	BooleanSettingId,
	CatalogStatusView,
	DashboardModel,
	DashboardSettings,
	NumberSettingId,
	ResettableSettingId,
	RevealableSettingId,
	SettingScope,
	UsageStatusBarModeSetting,
} from "../../extension/dashboard/protocol";
import {
	BOOLEAN_SETTING_IDS,
	booleanSettingPresentation,
	defaultDisplay,
	draftSyncKey,
	equivalence,
	isBoundViolation,
	NUMBER_SETTING_IDS,
	NUMBER_SETTING_SPECS,
	NUMBER_SETTING_UNITS,
	numberSettingPresentation,
	parseNumberDraft,
	settingScopeLabel,
} from "../../extension/dashboard/protocol";
import type { FailuresByIntent } from "./app";
import { DOCS_LINK_OPENROUTER_CATALOG, DOCS_LINK_SETTINGS } from "./docsLinks";
import { DocsLink, Help } from "./help";
import { helpCatalogRow, helpSettingsSection, settingRowHelp } from "./helpText";
import { IconBraces } from "./icons";
import type { CatalogSearchResponse, ExternalRecordEdit } from "./recordEditors";
import {
	ModelCapabilitiesEditor,
	ModelParametersEditor,
	modelCapabilitiesTitle,
	modelParametersTitle,
} from "./recordEditors";
import { relativeTime } from "./time";
import { postMessage } from "./vscodeApi";

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
function SettingRow({
	modified,
	hidden,
	children,
}: {
	modified: boolean;
	hidden: boolean;
	children: ComponentChildren;
}) {
	return (
		<div class={modified ? "setting-row modified" : "setting-row"} hidden={hidden}>
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
		<button
			type="button"
			class="quiet reset"
			aria-label={action}
			onClick={() => postMessage({ type: "resetSetting", setting: settingId })}
		>
			{l10n.t("Reset")}
		</button>
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
		<span class="setting-modified-note">
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
	// ms settings take the duration grammar ("90s", "5m"), so their input must
	// be type="text": a number input silently swallows the suffix letters.
	// Token settings keep type="number".
	const duration = NUMBER_SETTING_UNITS[id] === "ms";

	// Keyed on draftSyncKey, not on the value alone: a successful reset of a
	// value pinned to exactly its default changes only the configured scope,
	// and a stale rejected draft must resync on that push too.
	const syncKey = draftSyncKey(value, configuredScope);
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
				postMessage({ type: "setNumberSetting", setting: id, value: null });
			}
			return;
		}
		if (parse.value !== value) {
			postMessage({ type: "setNumberSetting", setting: id, value: parse.value });
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
			<div class="setting-head">
				<label class="setting-title" for={inputId}>
					{presentation.label}
				</label>
				{help !== undefined ? <Help text={help} name={l10n.t("Help: {0}", presentation.label)} /> : null}
				<RevealButton title={presentation.label} settingId={id} />
				{configuredScope !== null ? <ModifiedNote scope={configuredScope} defaultText={defaultDisplay(id)} /> : null}
			</div>
			<p class="setting-desc">{presentation.description}</p>
			<div class="setting-control">
				<input
					id={inputId}
					type={duration ? "text" : "number"}
					// The default text inputmode, stated on purpose: a numeric one
					// would hide the s/m/h suffix keys the duration grammar needs.
					inputMode={duration ? "text" : undefined}
					spellcheck={duration ? false : undefined}
					min={duration ? undefined : NUMBER_SETTING_SPECS[id].minimum}
					class={error === undefined ? "" : "invalid"}
					aria-invalid={error !== undefined}
					aria-describedby={error === undefined ? unitId : `${unitId} ${errorId}`}
					value={text}
					onInput={(event) => setText(event.currentTarget.value)}
					onBlur={settle}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							settle();
						}
					}}
				/>
				<span class="setting-unit" id={unitId}>
					{presentation.unit}
				</span>
				{error !== undefined ? (
					<span class="error" id={errorId}>
						{error}
					</span>
				) : null}
				{equiv !== undefined ? <span class="setting-equiv">{equiv}</span> : null}
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
	extra?: ComponentChildren;
}) {
	const presentation = booleanSettingPresentation(id);
	const inputId = `setting-${id}`;
	const help = settingRowHelp(id);
	return (
		<SettingRow modified={configuredScope !== null} hidden={hidden}>
			<div class="setting-head">
				<span class="setting-title">{presentation.label}</span>
				{help !== undefined ? <Help text={help} name={l10n.t("Help: {0}", presentation.label)} /> : null}
				<RevealButton title={presentation.label} settingId={id} />
				{configuredScope !== null ? <ModifiedNote scope={configuredScope} /> : null}
			</div>
			<div class="setting-control">
				<label class="setting-check" for={inputId}>
					<input
						id={inputId}
						type="checkbox"
						checked={value}
						onChange={(event) =>
							postMessage({ type: "setBooleanSetting", setting: id, value: event.currentTarget.checked })
						}
					/>
					<span class="setting-desc">{presentation.description}</span>
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
		<div class="catalog-row">
			{enabled ? (
				<>
					<span class="hint">
						{catalog.modelCount === 1 ? l10n.t("1 catalog model") : l10n.t("{0} catalog models", catalog.modelCount)}
						{updated !== undefined ? ` - ${l10n.t("updated {0}", updated)}` : ` - ${l10n.t("bundled snapshot")}`}
					</span>
					<button
						type="button"
						class="secondary"
						disabled={catalog.refreshing}
						onClick={() => postMessage({ type: "refreshCatalog" })}
					>
						{catalog.refreshing ? (
							<>
								<span class="spinner" aria-hidden="true" /> {l10n.t("Refreshing...")}
							</>
						) : (
							l10n.t("Refresh")
						)}
					</button>
					<Help text={helpCatalogRow()} />
					<DocsLink href={DOCS_LINK_OPENROUTER_CATALOG} label={l10n.t("Open the OpenRouter catalog guide")} />
					{catalog.lastFailure !== undefined ? (
						<span class="error">
							{/* The classification is a fixed English vocabulary ("HTTP 503",
							    "network error"), protocol-ish like header names. */}
							{l10n.t("Last refresh failed ({0}); serving the cached snapshot.", catalog.lastFailure.classification)}
						</span>
					) : null}
				</>
			) : (
				<span class="hint">
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
			<div class="setting-head">
				<label class="setting-title" for={inputId}>
					{title}
				</label>
				<RevealButton title={title} settingId="usage.statusBar" />
				{configuredScope !== null ? <ModifiedNote scope={configuredScope} /> : null}
			</div>
			<p class="setting-desc">{l10n.t("When the spend status bar item shows; the worst fresh server's percentage.")}</p>
			<div class="setting-control">
				<select
					id={inputId}
					value={mode}
					onChange={(event) =>
						postMessage({
							type: "setUsageStatusBar",
							value: event.currentTarget.value as UsageStatusBarModeSetting,
						})
					}
				>
					{USAGE_STATUS_BAR_MODES.map((candidate) => (
						<option key={candidate} value={candidate}>
							{statusBarModeLabel(candidate)}
						</option>
					))}
				</select>
				{configuredScope !== null ? (
					<ResetButton title={title} scope={configuredScope} settingId="usage.statusBar" />
				) : null}
			</div>
		</SettingRow>
	);
}

/**
 * The usage.alertThresholds draft's parse: comma-separated fractions in
 * (0, 1], deduplicated and sorted like normalization writes them; empty means
 * alerts off.
 */
function parseThresholdsDraft(
	text: string
): { readonly ok: true; readonly values: readonly number[] } | { readonly ok: false; readonly problem: string } {
	const parts = text
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	const values: number[] = [];
	for (const part of parts) {
		const value = Number(part);
		if (!Number.isFinite(value)) {
			return { ok: false, problem: l10n.t("Not a number: {0}", part) };
		}
		if (!(value > 0 && value <= 1)) {
			return { ok: false, problem: l10n.t("Thresholds are fractions in (0, 1], e.g. 0.8") };
		}
		values.push(value);
	}
	const deduped = [...new Set(values)].sort((a, b) => a - b);
	// The intent schema's list bound; failing it inline beats a generic
	// intentFailed toast after the round trip.
	if (deduped.length > 32) {
		return { ok: false, problem: l10n.t("At most 32 thresholds") };
	}
	return { ok: true, values: deduped };
}

/** The usage.alertThresholds row: a fraction-list input, committed on blur or Enter like the number rows. */
function UsageThresholdsRow({
	values,
	configuredScope,
	hidden,
}: {
	values: readonly number[];
	configuredScope: SettingScope | null;
	hidden: boolean;
}) {
	const external = values.join(", ");
	const [text, setText] = useState(external);
	const syncKey = `${external}@${configuredScope ?? "default"}`;
	useEffect(() => {
		setText(external);
	}, [syncKey]);
	const parse = parseThresholdsDraft(text);
	const commit = () => {
		if (!parse.ok) {
			return;
		}
		if (parse.values.join(",") !== values.join(",")) {
			postMessage({ type: "setUsageAlertThresholds", values: [...parse.values] });
		}
	};
	const inputId = "setting-usage.alertThresholds";
	const errorId = `${inputId}-error`;
	const title = l10n.t("Usage alert thresholds");
	const equiv =
		parse.ok && parse.values.length > 0
			? `= ${parse.values.map((v) => `${Math.round(v * 100)}%`).join(", ")}`
			: undefined;
	return (
		<SettingRow modified={configuredScope !== null} hidden={hidden}>
			<div class="setting-head">
				<label class="setting-title" for={inputId}>
					{title}
				</label>
				<RevealButton title={title} settingId="usage.alertThresholds" />
				{configuredScope !== null ? <ModifiedNote scope={configuredScope} /> : null}
			</div>
			<p class="setting-desc">
				{l10n.t("Budget fractions that trigger a one-time alert each, e.g. 0.8, 0.95; empty turns alerts off.")}
			</p>
			<div class="setting-control">
				<input
					id={inputId}
					type="text"
					spellcheck={false}
					class={parse.ok ? "" : "invalid"}
					aria-invalid={!parse.ok}
					aria-describedby={parse.ok ? undefined : errorId}
					value={text}
					onInput={(event) => setText(event.currentTarget.value)}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							commit();
						}
					}}
				/>
				{!parse.ok ? (
					<span class="error" id={errorId}>
						{parse.problem}
					</span>
				) : null}
				{equiv !== undefined ? <span class="setting-equiv">{equiv}</span> : null}
				{configuredScope !== null ? (
					<ResetButton title={title} scope={configuredScope} settingId="usage.alertThresholds" />
				) : null}
			</div>
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
	booleanExtras?: Partial<Record<BooleanSettingId, ComponentChildren>>;
	/** Rows appended after the scalar rows (the Usage group's enum and list rows). */
	tail?: ComponentChildren;
	/** Whether any tail row survives the filter; keeps the group heading alive for them. */
	tailVisible?: boolean;
}) {
	const empty = numbers.every((id) => !isVisible(id)) && booleans.every((id) => !isVisible(id)) && tailVisible !== true;
	return (
		<div class="settings-group" hidden={empty}>
			<h3 class="settings-group-title">{title()}</h3>
			{hint !== undefined ? <p class="hint">{hint()}</p> : null}
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
		<p class="hint">
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
	failures,
	catalogResults,
	now,
	editRecordRequest,
}: {
	settings: DashboardSettings;
	models: readonly DashboardModel[];
	failures: FailuresByIntent;
	/** The latest catalogSearchResults response, for the capability editor's `_openrouter_model` picker. */
	catalogResults?: CatalogSearchResponse | undefined;
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
	const nothingMatches = !anyScalarVisible && !paramsVisible && !capsVisible;
	const booleanExtras: Partial<Record<BooleanSettingId, ComponentChildren>> = {
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
			<div class="toolbar">
				<button
					type="button"
					class="secondary"
					onClick={() => postMessage({ type: "executeCommand", command: "openSettings" })}
				>
					{l10n.t("Open in Settings editor")}
				</button>
			</div>
			<ScalarScopeNote settings={settings} />
			<div class="filterbar">
				<input
					type="text"
					placeholder={l10n.t("Filter settings, e.g. timeout")}
					aria-label={l10n.t("Filter settings")}
					value={filter}
					onInput={(event) => setFilter(event.currentTarget.value)}
				/>
			</div>
			{nothingMatches ? <p class="empty">{l10n.t("No settings match the filter.")}</p> : null}
			<div class="settings-groups">
				{SETTING_GROUPS.map((group, index) => {
					// The Usage group also carries the two non-scalar usage settings:
					// the status bar mode enum and the alert-thresholds list.
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
							key={index}
							{...group}
							settings={settings}
							isVisible={isVisible}
							booleanExtras={booleanExtras}
							tailVisible={isUsageGroup && (statusBarVisible || thresholdsVisible)}
							tail={
								isUsageGroup ? (
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
			</div>
			<ModelParametersEditor
				scoped={settings.modelParameters}
				models={models}
				failure={failures.setModelParameters}
				hidden={!paramsVisible}
				external={editRecordRequest?.kind === "parameters" ? editRecordRequest : undefined}
			/>
			<ModelCapabilitiesEditor
				scoped={settings.modelCapabilities}
				models={models}
				failure={failures.setModelCapabilities}
				catalogResults={catalogResults}
				hidden={!capsVisible}
				external={editRecordRequest?.kind === "capabilities" ? editRecordRequest : undefined}
			/>
		</section>
	);
}
