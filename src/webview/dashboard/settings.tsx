import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
	BooleanSettingId,
	DashboardModel,
	DashboardSettings,
	NumberSettingId,
	RevealableSettingId,
	SettingScope,
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
import { DOCS_LINK_SETTINGS } from "./docsLinks";
import { DocsLink, Help } from "./help";
import { helpSettingsSection, settingRowHelp } from "./helpText";
import { IconBraces } from "./icons";
import { HEADERS_TITLE, HeadersEditor, MODEL_PARAMETERS_TITLE, ModelParametersEditor } from "./recordEditors";
import { postMessage } from "./vscodeApi";

/**
 * The form's grouping and order, most-touched first. Presentation only: the
 * setting inventory itself is the protocol's; anything not placed here still
 * renders, in a trailing "Other" group, so a newly added setting can never
 * silently vanish from the dashboard.
 */
const SETTING_GROUPS: readonly {
	readonly title: string;
	readonly numbers: readonly NumberSettingId[];
	readonly booleans: readonly BooleanSettingId[];
}[] = [
	{
		title: "Model defaults",
		numbers: ["defaultMaxOutputTokens", "defaultContextLength", "defaultMaxInputTokens"],
		booleans: [],
	},
	{ title: "Timeouts", numbers: ["requestTimeout", "discoveryTimeout"], booleans: [] },
	{ title: "Caching", numbers: ["discoveryCacheTtl"], booleans: ["promptCaching.enabled"] },
	{ title: "Input", numbers: [], booleans: ["maskApiKeyInput"] },
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
			aria-label={`Open ${title} in settings.json`}
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
	settingId: NumberSettingId | BooleanSettingId;
}) {
	const action = `Remove the ${settingScopeLabel(scope)} value of ${title}`;
	return (
		<button
			type="button"
			class="quiet reset"
			aria-label={action}
			onClick={() => postMessage({ type: "resetSetting", setting: settingId })}
		>
			Reset
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
	const where = `Modified in ${settingScopeLabel(scope)} settings`;
	return (
		<span class="setting-modified-note">
			{defaultText === undefined ? where : `${where} (default: ${defaultText})`}
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
				{help !== undefined ? <Help text={help} name={`Help: ${presentation.label}`} /> : null}
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
					placeholder={presentation.placeholder}
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
 * silently write settings.json.
 */
function BooleanField({
	id,
	value,
	configuredScope,
	hidden,
}: {
	id: BooleanSettingId;
	value: boolean;
	configuredScope: SettingScope | null;
	hidden: boolean;
}) {
	const presentation = booleanSettingPresentation(id);
	const inputId = `setting-${id}`;
	const help = settingRowHelp(id);
	return (
		<SettingRow modified={configuredScope !== null} hidden={hidden}>
			<div class="setting-head">
				<span class="setting-title">{presentation.label}</span>
				{help !== undefined ? <Help text={help} name={`Help: ${presentation.label}`} /> : null}
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
		</SettingRow>
	);
}

function SettingGroup({
	title,
	numbers,
	booleans,
	settings,
	isVisible,
}: {
	title: string;
	numbers: readonly NumberSettingId[];
	booleans: readonly BooleanSettingId[];
	settings: DashboardSettings;
	/** The filter's verdict per row; a group whose rows are all hidden collapses whole (heading included). */
	isVisible: (id: NumberSettingId | BooleanSettingId) => boolean;
}) {
	const empty = numbers.every((id) => !isVisible(id)) && booleans.every((id) => !isVisible(id));
	return (
		<div class="settings-group" hidden={empty}>
			<h3 class="settings-group-title">{title}</h3>
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
				/>
			))}
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
				? "Editing User settings; a value set in Workspace settings is changed there."
				: "Editing User settings."}
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
}: {
	settings: DashboardSettings;
	models: readonly DashboardModel[];
	failures: FailuresByIntent;
}) {
	const [filter, setFilter] = useState("");
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
		needle.length === 0 || recordEditorMatches(needle, MODEL_PARAMETERS_TITLE, settings.modelParameters);
	const headersVisible = needle.length === 0 || recordEditorMatches(needle, HEADERS_TITLE, settings.headers);
	const anyScalarVisible = [...NUMBER_SETTING_IDS, ...BOOLEAN_SETTING_IDS].some(isVisible);
	const nothingMatches = !anyScalarVisible && !paramsVisible && !headersVisible;
	return (
		<section>
			<h2>
				Settings <Help text={helpSettingsSection()} />
				<DocsLink href={DOCS_LINK_SETTINGS} label="Open the settings guide" />
			</h2>
			<div class="toolbar">
				<button
					type="button"
					class="secondary"
					onClick={() => postMessage({ type: "executeCommand", command: "openSettings" })}
				>
					Open in Settings editor
				</button>
			</div>
			<ScalarScopeNote settings={settings} />
			<div class="filterbar">
				<input
					type="text"
					placeholder="Filter settings, e.g. timeout"
					aria-label="Filter settings"
					value={filter}
					onInput={(event) => setFilter(event.currentTarget.value)}
				/>
			</div>
			{nothingMatches ? <p class="empty">No settings match the filter.</p> : null}
			<div class="settings-groups">
				{SETTING_GROUPS.map((group) => (
					<SettingGroup key={group.title} {...group} settings={settings} isVisible={isVisible} />
				))}
				{otherNumbers.length + otherBooleans.length > 0 ? (
					<SettingGroup
						title="Other"
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
			/>
			<HeadersEditor scoped={settings.headers} failure={failures.setHeaders} hidden={!headersVisible} />
		</section>
	);
}
