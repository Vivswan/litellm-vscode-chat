import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
	BooleanSettingId,
	DashboardSettings,
	NumberSettingId,
	SettingScope,
} from "../../extension/dashboard/protocol";
import {
	BOOLEAN_SETTING_IDS,
	BOOLEAN_SETTINGS,
	draftSyncKey,
	equivalence,
	NUMBER_SETTING_IDS,
	NUMBER_SETTINGS,
	SETTING_SCOPE_LABELS,
} from "../../extension/dashboard/protocol";
import type { FailuresByIntent } from "./app";
import { HeadersEditor, ModelParametersEditor } from "./recordEditors";
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
 * (the gutter space is reserved, so toggling it never shifts layout).
 */
function SettingRow({ modified, children }: { modified: boolean; children: ComponentChildren }) {
	return <div class={modified ? "setting-row modified" : "setting-row"}>{children}</div>;
}

/**
 * The reset action on a configured row, shown on hover or while the row holds
 * focus. Named for what it really does: it removes the value from the
 * highest-precedence scope that sets it (the next scope's value or the
 * default shows through), so the tooltip and accessible name say which
 * scope's value goes, never "reset to default". Each button carries its own
 * accessible name; six bare "Reset"s would be indistinguishable to a screen
 * reader. Sits in the control row after the input, so Tab reaches it from the
 * field it resets.
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
	const action = `Remove the ${SETTING_SCOPE_LABELS[scope]} value of ${title}`;
	return (
		<button
			type="button"
			class="quiet reset"
			title={action}
			aria-label={action}
			onClick={() => postMessage({ type: "resetSetting", setting: settingId })}
		>
			Reset
		</button>
	);
}

/** Why this draft cannot be committed, or undefined when it can. */
function draftProblem(id: NumberSettingId, text: string): string | undefined {
	const spec = NUMBER_SETTINGS[id];
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return spec.nullable ? undefined : "Enter a number";
	}
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) {
		return "Not a number";
	}
	if (parsed < spec.minimum) {
		return `Must be at least ${spec.minimum}`;
	}
	return undefined;
}

/**
 * A number setting edited as draft text and committed on blur or Enter, so
 * half-typed values never reach the configuration. The validation verdict is
 * derived from the draft on every keystroke, never latched at commit time: a
 * valid draft must never render as invalid, and the equivalence hint must
 * stay live while the user types their way out of a rejected value. An
 * external state push resets the draft to the store's value.
 */
function NumberField({
	id,
	value,
	configuredScope,
}: {
	id: NumberSettingId;
	value: number | null;
	configuredScope: SettingScope | null;
}) {
	const spec = NUMBER_SETTINGS[id];
	const [text, setText] = useState(value === null ? "" : String(value));

	// Keyed on draftSyncKey, not on the value alone: a successful reset of a
	// value pinned to exactly its default changes only the configured scope,
	// and a stale rejected draft must resync on that push too.
	const syncKey = draftSyncKey(value, configuredScope);
	useEffect(() => {
		setText(value === null ? "" : String(value));
	}, [syncKey]);

	const error = draftProblem(id, text);
	const commit = () => {
		if (error !== undefined) {
			return;
		}
		const trimmed = text.trim();
		if (trimmed.length === 0) {
			if (value !== null) {
				postMessage({ type: "setNumberSetting", setting: id, value: null });
			}
			return;
		}
		const parsed = Number(trimmed);
		if (parsed !== value) {
			postMessage({ type: "setNumberSetting", setting: id, value: parsed });
		}
	};

	const inputId = `setting-${id}`;
	const unitId = `${inputId}-unit`;
	const errorId = `${inputId}-error`;
	const equiv = error === undefined ? equivalence(id, text) : undefined;
	return (
		<SettingRow modified={configuredScope !== null}>
			<label class="setting-title" for={inputId}>
				{spec.label}
			</label>
			<p class="setting-desc">{spec.description}</p>
			<div class="setting-control">
				<input
					id={inputId}
					type="number"
					min={spec.minimum}
					class={error === undefined ? "" : "invalid"}
					aria-invalid={error !== undefined}
					aria-describedby={error === undefined ? unitId : `${unitId} ${errorId}`}
					value={text}
					placeholder={spec.nullable ? "derived" : undefined}
					onInput={(event) => setText(event.currentTarget.value)}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							commit();
						}
					}}
				/>
				<span class="setting-unit" id={unitId}>
					{spec.unit}
				</span>
				{error !== undefined ? (
					<span class="error" id={errorId}>
						{error}
					</span>
				) : null}
				{equiv !== undefined ? <span class="setting-equiv">{equiv}</span> : null}
				{configuredScope !== null ? <ResetButton title={spec.label} scope={configuredScope} settingId={id} /> : null}
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
}: {
	id: BooleanSettingId;
	value: boolean;
	configuredScope: SettingScope | null;
}) {
	const spec = BOOLEAN_SETTINGS[id];
	const inputId = `setting-${id}`;
	return (
		<SettingRow modified={configuredScope !== null}>
			<span class="setting-title">{spec.label}</span>
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
					<span class="setting-desc">{spec.description}</span>
				</label>
				{configuredScope !== null ? <ResetButton title={spec.label} scope={configuredScope} settingId={id} /> : null}
			</div>
		</SettingRow>
	);
}

function SettingGroup({
	title,
	numbers,
	booleans,
	settings,
}: {
	title: string;
	numbers: readonly NumberSettingId[];
	booleans: readonly BooleanSettingId[];
	settings: DashboardSettings;
}) {
	return (
		<div class="settings-group">
			<h3 class="settings-group-title">{title}</h3>
			{numbers.map((id) => (
				<NumberField
					key={id}
					id={id}
					value={settings.numbers[id]}
					configuredScope={settings.configuredScopes.numbers[id]}
				/>
			))}
			{booleans.map((id) => (
				<BooleanField
					key={id}
					id={id}
					value={settings.booleans[id]}
					configuredScope={settings.configuredScopes.booleans[id]}
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

export function SettingsSection({ settings, failures }: { settings: DashboardSettings; failures: FailuresByIntent }) {
	const placed = new Set<string>(SETTING_GROUPS.flatMap((group) => [...group.numbers, ...group.booleans]));
	const otherNumbers = NUMBER_SETTING_IDS.filter((id) => !placed.has(id));
	const otherBooleans = BOOLEAN_SETTING_IDS.filter((id) => !placed.has(id));
	return (
		<section>
			<div class="section-head">
				<h2>Settings</h2>
				<button
					type="button"
					class="secondary"
					onClick={() => postMessage({ type: "executeCommand", command: "openSettings" })}
				>
					Open in Settings editor
				</button>
			</div>
			<ScalarScopeNote settings={settings} />
			<div class="settings-groups">
				{SETTING_GROUPS.map((group) => (
					<SettingGroup key={group.title} {...group} settings={settings} />
				))}
				{otherNumbers.length + otherBooleans.length > 0 ? (
					<SettingGroup title="Other" numbers={otherNumbers} booleans={otherBooleans} settings={settings} />
				) : null}
			</div>
			<ModelParametersEditor scoped={settings.modelParameters} failure={failures.setModelParameters} />
			<HeadersEditor scoped={settings.headers} failure={failures.setHeaders} />
		</section>
	);
}
