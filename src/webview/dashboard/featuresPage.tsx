import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { useContext, useEffect, useId, useState } from "react";
import type { SettingWriteMethod } from "../../dashboard/endpoints";
import { WIRE_LIMITS } from "../../dashboard/endpoints";
import { featureDisplayName } from "../../dashboard/featureNames";
import type {
	DashboardModel,
	DashboardSettings,
	LanguageFilterSetting,
	SettingRowId,
	SettingScope,
} from "../../dashboard/viewModels";
import type {
	BooleanSettingId,
	FeatureId,
	FeatureModelId,
	FeatureModelRef,
	NumberSettingId,
} from "../../shared/config/settingSpec";
import {
	AGENT_TOOLS_SETTING_KEYS,
	FEATURE_ENABLE_SETTING_KEYS,
	FEATURE_IDS,
	FEATURE_MODEL_SETTING_KEYS,
	isFeatureModelId,
	LANGUAGE_FILTER_MODES,
} from "../../shared/config/settingSpec";
import { trimHttpWhitespace } from "../../shared/util/headers";
import { useAlertOnce } from "./announceOnce";
import { DOCS_LINK_DASHBOARD_FEATURES } from "./docsLinks";
import {
	helpCommitPrompt,
	helpFeatureModel,
	helpFeaturesSection,
	helpLanguageFilterList,
	helpLanguageFilterMode,
	settingRowHelp,
} from "./helpText";
import { type IntentOutcome, useIntentOutcome } from "./hooks";
import { tupleKey } from "./keys";
import type { CoveredMessage, SettingWriteFailure } from "./settingRows";
import {
	CommaListRow,
	commaListCustom,
	filterMatcher,
	placeWriteFailures,
	SETTING_GRID_TRACKS,
	SettingFailuresContext,
	SettingGroup,
	SettingRow,
	scalarText,
	writeFailureText,
} from "./settingRows";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Section } from "./ui/section";
import { Select } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { sendRequest } from "./vscodeApi";

function featureModelDescription(feature: FeatureModelId): string {
	switch (feature) {
		case "inlineCompletions":
			return l10n.t("Which model serves ghost text; Not set keeps the feature idle.");
		case "commitGeneration":
			return l10n.t("Which model drafts commit messages; Not set keeps the feature idle.");
		case "prGeneration":
			return l10n.t("Which model drafts PR descriptions; Not set keeps the feature idle.");
		case "consultTool":
			return l10n.t("Which model the consult tool asks; Not set keeps the feature idle.");
		case "quickFix":
			return l10n.t("Which model backs the quick-fix fallback; Not set keeps it idle.");
		case "reviewComments":
			return l10n.t("Which model writes review comments; Not set keeps the feature idle.");
	}
}

function featureModelTitle(feature: FeatureModelId): string {
	switch (feature) {
		case "inlineCompletions":
			return l10n.t("Inline completions model");
		case "commitGeneration":
			return l10n.t("Commit generation model");
		case "prGeneration":
			return l10n.t("PR generation model");
		case "consultTool":
			return l10n.t("Consult tool model");
		case "quickFix":
			return l10n.t("Quick fix model");
		case "reviewComments":
			return l10n.t("Review comments model");
	}
}

/**
 * Two words per section, not a sentence per section: the sentence they used to repeat five times is hoisted to the
 * page's one hint (featuresComingHint), so the consequence is stated once and each heading only says which sections it
 * applies to.
 */
function comingSoonMarker(): ReactNode {
	return <Badge>{l10n.t("Coming soon")}</Badge>;
}

function featuresComingHint(): string {
	return l10n.t(
		"Sections marked Coming soon can be configured now; their settings take effect when the feature ships."
	);
}

function commitPromptDescription(): string {
	return l10n.t("Custom instruction for generated commit messages; empty uses the built-in.");
}

function languageFilterModeTitle(): string {
	return l10n.t("Language filter");
}

function languageFilterModeDescription(): string {
	return l10n.t("Whether the language list blocks or allows inline completions.");
}

function languageFilterModeLabel(mode: (typeof LANGUAGE_FILTER_MODES)[number]): string {
	return mode === "allow" ? l10n.t("Allow only listed languages") : l10n.t("Block listed languages");
}

function languageFilterListTitle(mode: (typeof LANGUAGE_FILTER_MODES)[number]): string {
	return mode === "allow" ? l10n.t("Allowed languages") : l10n.t("Blocked languages");
}

function languageFilterListDescription(mode: (typeof LANGUAGE_FILTER_MODES)[number]): string {
	return mode === "allow"
		? l10n.t("Inline completions run only in these language IDs.")
		: l10n.t("Inline completions run everywhere except these language IDs.");
}

/**
 * A multi-claimant model appears once per claimant label on purpose: each label is a distinct addressable entry.
 *
 *   a ref                 -> names a servers-entry label, which external groups do not have
 *   offering their models -> would mint picks the feature could never resolve
 */
function modelRefOptions(
	models: readonly DashboardModel[],
	declaredLabels: ReadonlySet<string>
): readonly FeatureModelRef[] {
	const seen = new Set<string>();
	const options: FeatureModelRef[] = [];
	for (const model of models) {
		const option = { server: model.serverLabel, model: model.rawId };
		const key = modelRefIdentity(option);
		if (declaredLabels.has(model.serverLabel) && !seen.has(key)) {
			seen.add(key);
			options.push(option);
		}
	}
	return options;
}

function modelRefIdentity(ref: FeatureModelRef): string {
	// A JSON tuple, so the encoding is collision-safe whatever characters a label or a discovered model ID contains.
	return tupleKey(ref.server, ref.model);
}

/** The custom-entry sentinel: real option values are JSON tuples (starting with "[") or empty, so it cannot collide. */
const CUSTOM_OPTION = "custom";

/** The tone the covered slot paints a landed probe outcome with: a refusal is an error, otherwise the ack's own tone. */
function probeTone(outcome: IntentOutcome): "ok" | "warning" | "error" {
	if (outcome.result === "fail") {
		return "error";
	}
	return outcome.tone === "warning" ? "warning" : "ok";
}

/** The custom editor's two inputs: a declared server label and a model ID the picker could not list. */
interface CustomModelDraft {
	readonly server: string;
	readonly model: string;
}

interface CustomModelDraftState {
	readonly draft: CustomModelDraft | undefined;
	readonly committable: boolean;
	readonly update: (next: CustomModelDraft | undefined) => void;
	readonly commit: () => void;
}

interface FeatureModelProbe {
	readonly outcome: IntentOutcome | undefined;
	readonly probing: boolean;
	readonly start: () => void;
	readonly clear: () => void;
}

interface ModelPickerProps {
	readonly inputId: string;
	readonly selected: string;
	readonly options: readonly FeatureModelRef[];
	readonly dangling: boolean;
	readonly describedBy: string | undefined;
	readonly onPick: (next: string) => void;
}

interface CustomModelEditorProps {
	readonly inputId: string;
	readonly draft: CustomModelDraft;
	readonly declaredLabels: readonly string[];
	readonly committable: boolean;
	readonly onDraft: (next: CustomModelDraft | undefined) => void;
	readonly onCommit: () => void;
}

interface PickContext {
	readonly feature: FeatureModelId;
	readonly value: FeatureModelRef | null;
	readonly selected: string;
	readonly options: readonly FeatureModelRef[];
	readonly declaredLabels: readonly string[];
	readonly openCustom: (draft: CustomModelDraft) => void;
}

/**
 * The probe's own round trip (hook order is fixed; only probe-carrying rows render the button). The outcome is keyed
 * to the request id AND the tested pair, so a result can never sit beside a model it did not test.
 */
function useFeatureModelProbe(feature: FeatureModelId, value: FeatureModelRef | null): FeatureModelProbe {
	const probe = useIntentOutcome("testFeatureModel");
	const [request, setRequest] = useState<{ id: string; model: string } | undefined>(undefined);
	const current = request !== undefined && value !== null && request.model === modelRefIdentity(value);
	const outcome = current && probe.outcome !== undefined && probe.outcome.id === request.id ? probe.outcome : undefined;
	return {
		outcome,
		probing: current && outcome === undefined,
		start: () => {
			if (value !== null) {
				setRequest({ id: probe.send({ feature, model: value }), model: modelRefIdentity(value) });
			}
		},
		clear: () => setRequest(undefined),
	};
}

/**
 * The custom editor's draft. Any activity in it runs `onActivity`, which clears the landed probe outcome: the editor
 * exists to change what the probe tested, so a standing result would be a stale annotation (the Test connection
 * staleness rule).
 */
function useCustomModelDraft(
	feature: FeatureModelId,
	declaredLabels: readonly string[],
	onActivity: () => void
): CustomModelDraftState {
	const [draft, setDraft] = useState<CustomModelDraft | undefined>(undefined);
	const committable =
		draft !== undefined && declaredLabels.includes(draft.server) && trimHttpWhitespace(draft.model) !== "";
	const update = (next: CustomModelDraft | undefined) => {
		setDraft(next);
		onActivity();
	};
	return {
		draft,
		committable,
		update,
		commit: () => {
			if (draft === undefined || !committable) {
				return;
			}
			sendRequest("setFeatureModel", {
				feature,
				value: { server: draft.server, model: trimHttpWhitespace(draft.model) },
			});
			update(undefined);
		},
	};
}

/**
 * A select pick. The custom option opens the editor seeded only by a declared label: the controlled select would
 * otherwise DISPLAY its first option while a commit submitted the stale label underneath. Total by construction: an
 * option value that resolves to no offered pair (impossible from an honest select) writes nothing rather than clearing.
 */
function pickModel(next: string, picker: PickContext): void {
	const { feature, value, selected, options, declaredLabels } = picker;
	if (next === CUSTOM_OPTION) {
		const seed = value !== null && declaredLabels.includes(value.server) ? value.server : (declaredLabels[0] ?? "");
		picker.openCustom({ server: seed, model: "" });
		return;
	}
	if (next === selected) {
		return;
	}
	if (next === "") {
		sendRequest("setFeatureModel", { feature, value: null });
		return;
	}
	const picked = options.find((option) => modelRefIdentity(option) === next);
	if (picked !== undefined) {
		sendRequest("setFeatureModel", { feature, value: picked });
	}
}

/**
 * The ROW says only which server went; the consequence-first sentence rides Details, so the covered line stays
 * scannable at every pane width and in every locale.
 */
function danglingError(server: string): CoveredMessage {
	return {
		headline: l10n.t('Server "{0}" is unavailable.', server),
		detail: l10n.t(
			'This model cannot be reached because server "{0}" is no longer configured. Choose another model or restore that server under Servers.',
			server
		),
	};
}

/** The offered pairs plus the custom escape hatch; `describedBy` names the warning only while it renders. */
function ModelPicker({ inputId, selected, options, dangling, describedBy, onPick }: ModelPickerProps) {
	return (
		<Select
			id={inputId}
			className="min-w-0 max-w-full"
			value={selected}
			aria-invalid={dangling}
			aria-describedby={describedBy}
			onChange={(event) => onPick(event.currentTarget.value)}
		>
			<option value="">{l10n.t("Not set")}</option>
			{options.map((option) => (
				<option key={modelRefIdentity(option)} value={modelRefIdentity(option)}>
					{`${option.server}: ${option.model}`}
				</option>
			))}
			<option value={CUSTOM_OPTION}>{l10n.t("Custom model ID...")}</option>
		</Select>
	);
}

/**
 * A deliberate two-line editor: the inputs share the first line and the RANKED actions sit on their own (Use model
 * primary, Cancel one rank below) - opening it is a user-initiated height change the geometry registry marks intended.
 */
function CustomModelEditor({ inputId, draft, declaredLabels, committable, onDraft, onCommit }: CustomModelEditorProps) {
	return (
		<div className="flex w-full min-w-0 flex-col gap-2">
			<div className="flex w-full min-w-0 flex-wrap items-center gap-2">
				<Select
					id={inputId}
					aria-label={l10n.t("Server")}
					className="min-w-0 max-w-48 shrink"
					value={draft.server}
					onChange={(event) => onDraft({ ...draft, server: event.currentTarget.value })}
				>
					{declaredLabels.length === 0 ? <option value="">{l10n.t("No servers configured")}</option> : null}
					{declaredLabels.map((label) => (
						<option key={label} value={label}>
							{label}
						</option>
					))}
				</Select>
				<Input
					aria-label={l10n.t("Model ID")}
					className="w-32 min-w-0 flex-1"
					placeholder={l10n.t("e.g. codestral-fim")}
					maxLength={WIRE_LIMITS.modelId}
					value={draft.model}
					onInput={(event) => onDraft({ ...draft, model: event.currentTarget.value })}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							onCommit();
						}
					}}
				/>
			</div>
			<div className="flex items-center gap-2">
				<Button size="compact" variant="default" disabled={!committable} onClick={onCommit}>
					{l10n.t("Use model")}
				</Button>
				<Button size="compact" variant="secondary" onClick={() => onDraft(undefined)}>
					{l10n.t("Cancel")}
				</Button>
			</div>
		</div>
	);
}

/**
 * A configured pair the options do not list joins them so the pick stays visible and keepable; labels and model IDs
 * are user configuration, safe to render.
 */
function optionsWithValue(
	options: readonly FeatureModelRef[],
	value: FeatureModelRef | null
): readonly FeatureModelRef[] {
	if (value === null) {
		return options;
	}
	const listed = options.some((option) => modelRefIdentity(option) === modelRefIdentity(value));
	return listed ? options : [...options, value];
}

interface FeatureModelControlProps {
	readonly feature: FeatureModelId;
	readonly value: FeatureModelRef | null;
	readonly options: readonly FeatureModelRef[];
	readonly declaredLabels: readonly string[];
	readonly inputId: string;
	readonly dangling: boolean;
	readonly describedBy: string | undefined;
	readonly probeAvailable: boolean;
	readonly probe: FeatureModelProbe;
	readonly custom: CustomModelDraftState;
}

/** The row's control cell: the picker or the open custom editor, and the test button beside a closed picker. */
function FeatureModelControl(props: FeatureModelControlProps) {
	const { feature, value, options, declaredLabels, inputId, dangling, describedBy, probeAvailable, probe, custom } =
		props;
	const selected = value === null ? "" : modelRefIdentity(value);
	if (custom.draft !== undefined) {
		return (
			<CustomModelEditor
				inputId={inputId}
				draft={custom.draft}
				declaredLabels={declaredLabels}
				committable={custom.committable}
				onDraft={custom.update}
				onCommit={custom.commit}
			/>
		);
	}
	return (
		<>
			<ModelPicker
				inputId={inputId}
				selected={selected}
				options={options}
				dangling={dangling}
				describedBy={describedBy}
				onPick={(next) =>
					pickModel(next, { feature, value, selected, options, declaredLabels, openCustom: custom.update })
				}
			/>
			{probeAvailable ? (
				<Button
					size="compact"
					variant="secondary"
					disabled={value === null || dangling || probe.probing}
					onClick={probe.start}
				>
					{probe.probing ? l10n.t("Testing...") : l10n.t("Test model")}
				</Button>
			) : null}
		</>
	);
}

/**
 * A configured ref no offered pair backs stays IN the option list, selected with the same rendered text, so the
 * dangling state changes no geometry (check-geometry pins it, feature-model-dangling). A standing write failure
 * outranks the dangling warning in the covered slot, because the warning never clears on its own.
 *
 *   "Custom model ID..." -> the escape hatch for models the picker cannot list
 *   test button outcome  -> counts and classified messages; the model's completion text never renders
 */
function FeatureModelRow({
	feature,
	value,
	options,
	declaredLabels,
	configuredScope,
	hidden,
	probeAvailable,
}: {
	feature: FeatureModelId;
	value: FeatureModelRef | null;
	options: readonly FeatureModelRef[];
	declaredLabels: readonly string[];
	configuredScope: SettingScope | null;
	hidden: boolean;
	probeAvailable: boolean;
}) {
	// Dangling is judged by the SERVER label alone: the feature resolves a ref through its declared entry, and a
	// declared server may legitimately serve IDs the chat catalog does not list (completion-mode FIM models above
	// all, unless the entry includes the mode), so absence from the options proves nothing about the model.
	const dangling = value !== null && !declaredLabels.includes(value.server);
	const settingId = FEATURE_MODEL_SETTING_KEYS[feature];
	const inputId = `setting-${settingId}`;
	const errorId = `${inputId}-error`;
	const probe = useFeatureModelProbe(feature, value);
	const custom = useCustomModelDraft(feature, declaredLabels, probe.clear);
	// SettingRow shows a write failure only while `error` is empty, so the standing warning yields to it here; the
	// warning resurfaces once the next push clears the failure.
	const writeFailure = useContext(SettingFailuresContext)[settingId];
	const warningShown = dangling && writeFailure === undefined && custom.draft === undefined;
	// The landed probe outcome rides the covered-description slot (the height-keeping overlay), below the dangling
	// warning and write failures. The FULL message travels: the cover renders its first truncated line and the Details
	// disclosure reveals the whole two-part text selectable.
	const probeNotice =
		probe.outcome === undefined || warningShown
			? undefined
			: { text: probe.outcome.message ?? "", tone: probeTone(probe.outcome) };
	return (
		<SettingRow
			settingId={settingId}
			title={featureModelTitle(feature)}
			titleFor={inputId}
			description={featureModelDescription(feature)}
			help={helpFeatureModel()}
			error={warningShown ? danglingError(value?.server ?? "") : undefined}
			errorId={errorId}
			notice={probeNotice}
			configuredScope={configuredScope}
			hidden={hidden}
			control={
				<FeatureModelControl
					feature={feature}
					value={value}
					options={optionsWithValue(options, value)}
					declaredLabels={declaredLabels}
					inputId={inputId}
					dangling={dangling}
					// Only while the warning element actually renders under errorId; the write-failure cover that can
					// replace it carries no id.
					describedBy={warningShown ? errorId : undefined}
					probeAvailable={probeAvailable}
					probe={probe}
					custom={custom}
				/>
			}
		/>
	);
}

/**
 * The empty string is the built-in instruction (the intent resets the setting); a draft past the wire bound shows the
 * bound and never commits, like the currency symbol. The box is a bounded auto-growing textarea - two rows at rest,
 * eight before it scrolls inside itself - because the prompt is prose that may carry newlines: plain Enter breaks a
 * line, so blur and Ctrl/Cmd+Enter commit, and the value round-trips verbatim.
 */
function CommitPromptRow({
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
	const inputId = "setting-commitGeneration.prompt";
	const errorId = `${inputId}-error`;
	const error =
		text.length > WIRE_LIMITS.commitPrompt ? l10n.t("At most {0} characters.", WIRE_LIMITS.commitPrompt) : undefined;
	const commit = () => {
		if (error === undefined && text !== value) {
			sendRequest("setCommitPrompt", { value: text });
		}
	};
	return (
		<SettingRow
			settingId="commitGeneration.prompt"
			title={l10n.t("Commit message prompt")}
			titleFor={inputId}
			description={commitPromptDescription()}
			help={helpCommitPrompt()}
			error={error}
			errorId={errorId}
			configuredScope={configuredScope}
			hidden={hidden}
			control={
				<Textarea
					id={inputId}
					rows={2}
					spellCheck={false}
					// Prose grows sideways like the keyword list (the cap IS the control column) and DOWNWARD in place:
					// field-sizing tracks the content between the two-row floor and the eight-row ceiling, then the box
					// scrolls internally. 8px = the vertical padding plus the borders.
					className="w-full max-w-[20rem] resize-none overflow-y-auto [field-sizing:content] min-h-[calc(2lh+8px)] max-h-[calc(8lh+8px)]"
					maxLength={WIRE_LIMITS.commitPrompt}
					placeholder={l10n.t("built-in instruction")}
					aria-invalid={error !== undefined}
					aria-describedby={error === undefined ? undefined : errorId}
					value={text}
					onChange={(event) => setText(event.currentTarget.value)}
					onBlur={commit}
					onKeyDown={(event) => {
						// Plain Enter is a LINE BREAK here, never a commit: the flattening bug this box replaced. The
						// modifier chord keeps a keyboard commit, because the panel dies when hidden and an uncommitted
						// draft dies with it; preventDefault so the chord commits WITHOUT also editing the draft it
						// just committed.
						if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
							event.preventDefault();
							commit();
						}
					}}
				/>
			}
		/>
	);
}

/**
 * Each row sends ONLY its own half as a patch - the mode select a mode, the list row languages - and the extension
 * merges the patch onto the stored filter on the chained channel, so two quick writes from different rows can never
 * revert each other and a refused write leaves nothing stale client-side.
 */
function LanguageFilterRows({ filter, hidden }: { filter: LanguageFilterSetting; hidden: boolean }) {
	return (
		<>
			<LanguageFilterModeRow
				filter={filter}
				hidden={hidden}
				onPick={(mode) => sendRequest("setLanguageFilter", { mode })}
			/>
			<LanguageFilterListRow
				filter={filter}
				hidden={hidden}
				onCommit={(languages) => sendRequest("setLanguageFilter", { languages })}
			/>
		</>
	);
}

function LanguageFilterModeRow({
	filter,
	hidden,
	onPick,
}: {
	filter: LanguageFilterSetting;
	hidden: boolean;
	onPick: (mode: (typeof LANGUAGE_FILTER_MODES)[number]) => void;
}) {
	const inputId = "setting-inlineCompletions.languageFilter-mode";
	// The stored value only settings.json can round-trip freezes the mode too: a mode write re-sends the normalized
	// list and would destroy the raw form.
	const custom = commaListCustom(filter.languages.values, filter.languages.lossy);
	return (
		<SettingRow
			settingId="inlineCompletions.languageFilter"
			companion
			title={languageFilterModeTitle()}
			titleFor={custom ? undefined : inputId}
			description={languageFilterModeDescription()}
			help={helpLanguageFilterMode()}
			configuredScope={filter.languages.scope}
			hidden={hidden}
			control={
				custom ? (
					<>
						<span>{languageFilterModeLabel(filter.mode)}</span>
						<span className="hint">{l10n.t("Custom list - edit in settings.json.")}</span>
					</>
				) : (
					<Select
						id={inputId}
						className="max-w-full"
						value={filter.mode}
						onChange={(event) => onPick(event.currentTarget.value as (typeof LANGUAGE_FILTER_MODES)[number])}
					>
						{LANGUAGE_FILTER_MODES.map((candidate) => (
							<option key={candidate} value={candidate}>
								{languageFilterModeLabel(candidate)}
							</option>
						))}
					</Select>
				)
			}
		/>
	);
}

function LanguageFilterListRow({
	filter,
	hidden,
	onCommit,
}: {
	filter: LanguageFilterSetting;
	hidden: boolean;
	onCommit: (languages: readonly string[]) => void;
}) {
	return (
		<CommaListRow
			settingId="inlineCompletions.languageFilter"
			title={languageFilterListTitle(filter.mode)}
			description={languageFilterListDescription(filter.mode)}
			help={helpLanguageFilterList(filter.mode)}
			placeholder={filter.mode === "allow" ? l10n.t("e.g. typescript, python") : l10n.t("e.g. markdown, plaintext")}
			values={filter.languages.values}
			lossy={filter.languages.lossy}
			maxLength={WIRE_LIMITS.languageId}
			maxCount={WIRE_LIMITS.languageList}
			countProblem={(max) => l10n.t("At most {0} language IDs.", max)}
			lengthProblem={(max) => l10n.t("Language IDs run up to {0} characters each.", max)}
			configuredScope={filter.languages.scope}
			hidden={hidden}
			onCommit={onCommit}
		/>
	);
}

/** One feature's section; declaring it in FEATURE_REGISTRY makes a feature a table-row addition, never a page edit. */
interface FeatureDescriptor {
	readonly shipped: boolean;
	readonly booleans?: readonly BooleanSettingId[];
	readonly tail?: {
		readonly visible: (matches: (...haystack: string[]) => boolean, ctx: FeatureTailContext) => boolean;
		readonly rows: (ctx: FeatureTailContext, hidden: boolean) => ReactNode;
	};
}

interface FeatureTailContext {
	readonly settings: DashboardSettings;
}

/** Total over FeatureId by mapped type: a new FeatureId fails compilation until it declares its section here. */
export const FEATURE_REGISTRY: { readonly [K in FeatureId]: FeatureDescriptor } = {
	inlineCompletions: {
		shipped: true,
		tail: {
			visible: (matches, ctx) =>
				matches(
					languageFilterModeTitle(),
					languageFilterModeDescription(),
					"inlineCompletions.languageFilter",
					helpLanguageFilterMode()
				) ||
				matches(
					languageFilterListTitle(ctx.settings.languageFilter.mode),
					languageFilterListDescription(ctx.settings.languageFilter.mode),
					"inlineCompletions.languageFilter",
					helpLanguageFilterList(ctx.settings.languageFilter.mode)
				),
			rows: (ctx, hidden) => <LanguageFilterRows filter={ctx.settings.languageFilter} hidden={hidden} />,
		},
	},
	commitGeneration: {
		shipped: true,
		tail: {
			visible: (matches) =>
				matches(
					l10n.t("Commit message prompt"),
					commitPromptDescription(),
					"commitGeneration.prompt",
					helpCommitPrompt()
				),
			rows: (ctx, hidden) => (
				<CommitPromptRow
					value={ctx.settings.commitPrompt}
					configuredScope={ctx.settings.commitPromptScope}
					hidden={hidden}
				/>
			),
		},
	},
	prGeneration: { shipped: true },
	consultTool: { shipped: true },
	quickFix: { shipped: true },
	reviewComments: { shipped: true },
	chatParticipant: { shipped: true },
	agentTools: {
		shipped: true,
		booleans: AGENT_TOOLS_SETTING_KEYS.filter((id) => id !== FEATURE_ENABLE_SETTING_KEYS.agentTools),
	},
};

/** The header's quiet count of modified rows; nothing while none is. */
function modifiedMeta(count: number): string | undefined {
	if (count === 0) {
		return undefined;
	}
	return count === 1 ? l10n.t("1 modified") : l10n.t("{0} modified", count);
}

/** The filter's verdicts, one per kind of row the page renders; every verdict reads the one matcher. */
interface FeatureVisibility {
	readonly scalar: (id: NumberSettingId | BooleanSettingId) => boolean;
	readonly model: (feature: FeatureModelId) => boolean;
	readonly tail: (feature: FeatureId) => boolean;
	readonly section: (feature: FeatureId) => boolean;
	readonly row: (row: SettingRowId) => boolean;
}

interface FeatureGroupProps {
	readonly feature: FeatureId;
	readonly settings: DashboardSettings;
	readonly visibility: FeatureVisibility;
	readonly tailContext: FeatureTailContext;
	readonly featureModelOptions: readonly FeatureModelRef[];
	readonly declaredLabels: readonly string[];
	readonly featureProbes: readonly FeatureModelId[] | undefined;
}

/** A feature's boolean rows: its enable switch first, then the switches its descriptor adds. */
function featureBooleans(feature: FeatureId): readonly BooleanSettingId[] {
	return [FEATURE_ENABLE_SETTING_KEYS[feature], ...(FEATURE_REGISTRY[feature].booleans ?? [])];
}

/**
 * The filter's verdicts for one matcher. `row` is total and fail-open by construction: an id this page cannot name
 * renders visible.
 */
function featureVisibility(
	filter: ReturnType<typeof filterMatcher>,
	tailContext: FeatureTailContext
): FeatureVisibility {
	const { needle, matches } = filter;
	const scalar = (id: NumberSettingId | BooleanSettingId): boolean => {
		const { label, description } = scalarText(id);
		return matches(label, description, id, settingRowHelp(id) ?? "");
	};
	const model = (feature: FeatureModelId): boolean =>
		matches(
			featureModelTitle(feature),
			featureModelDescription(feature),
			FEATURE_MODEL_SETTING_KEYS[feature],
			helpFeatureModel()
		);
	const tail = (feature: FeatureId): boolean => {
		const descriptor = FEATURE_REGISTRY[feature].tail;
		return descriptor !== undefined && (needle.length === 0 || descriptor.visible(matches, tailContext));
	};
	const section = (feature: FeatureId): boolean =>
		featureBooleans(feature).some(scalar) || (isFeatureModelId(feature) && model(feature)) || tail(feature);
	const row = (id: SettingRowId): boolean => {
		for (const feature of FEATURE_IDS) {
			const own = featureBooleans(feature).find((candidate) => candidate === id);
			if (own !== undefined) {
				return scalar(own);
			}
			if (isFeatureModelId(feature) && id === FEATURE_MODEL_SETTING_KEYS[feature]) {
				return model(feature);
			}
		}
		if (id === "inlineCompletions.languageFilter") {
			return tail("inlineCompletions");
		}
		if (id === "commitGeneration.prompt") {
			return tail("commitGeneration");
		}
		return true;
	};
	return { scalar, model, tail, section, row };
}

/** How many of the page's settings are configured somewhere: every feature switch, model ref, prompt, and list. */
function modifiedScopeCount(settings: DashboardSettings): number {
	const scopes: readonly (SettingScope | null)[] = [
		...FEATURE_IDS.flatMap((feature) => featureBooleans(feature).map((id) => settings.configuredScopes.booleans[id])),
		...Object.values(settings.featureModelScopes),
		settings.commitPromptScope,
		settings.languageFilter.languages.scope,
	];
	return scopes.filter((scope) => scope !== null).length;
}

/** One feature's group: its switches, then its model row and descriptor tail where it has them. */
function FeatureGroup(props: FeatureGroupProps) {
	const { feature, settings, visibility, tailContext, featureModelOptions, declaredLabels, featureProbes } = props;
	const descriptor = FEATURE_REGISTRY[feature];
	const model = isFeatureModelId(feature) ? feature : undefined;
	return (
		<SettingGroup
			title={() => featureDisplayName(feature, "title")}
			note={descriptor.shipped ? undefined : comingSoonMarker}
			numbers={[]}
			booleans={featureBooleans(feature)}
			settings={settings}
			isVisible={visibility.scalar}
			tailVisible={(model !== undefined && visibility.model(model)) || visibility.tail(feature)}
			tail={
				<>
					{model === undefined ? null : (
						<FeatureModelRow
							feature={model}
							value={settings.featureModels[model]}
							options={featureModelOptions}
							declaredLabels={declaredLabels}
							configuredScope={settings.featureModelScopes[model]}
							hidden={!visibility.model(model)}
							probeAvailable={featureProbes?.includes(model) === true}
						/>
					)}
					{descriptor.tail === undefined ? null : descriptor.tail.rows(tailContext, !visibility.tail(feature))}
				</>
			}
		/>
	);
}

/**
 * The Features page: one section per FeatureId, as FEATURE_REGISTRY declares it, behind one filter box.
 *
 *   declaredServerLabels -> the declared entries' labels (state.servers, origin "declared"), all the feature model
 *                           pickers may offer: a ref addresses a servers-entry label and external groups have none;
 *                           absent offers nothing (fail-closed, never a wrong pick)
 */
export function FeaturesSection({
	settings,
	models,
	declaredServerLabels,
	featureProbes,
	writeFailures,
}: {
	settings: DashboardSettings;
	models: readonly DashboardModel[];
	declaredServerLabels?: readonly string[] | undefined;
	featureProbes?: readonly FeatureModelId[] | undefined;
	writeFailures?: Partial<Record<SettingWriteMethod, SettingWriteFailure>> | undefined;
}) {
	const featureModelOptions = modelRefOptions(models, new Set(declaredServerLabels ?? []));
	const [filter, setFilter] = useState("");
	const filterId = useId();
	const tailContext: FeatureTailContext = { settings };
	const visibility = featureVisibility(filterMatcher(filter), tailContext);
	const nothingMatches = !FEATURE_IDS.some(visibility.section);
	const comingShown = FEATURE_IDS.some((feature) => !FEATURE_REGISTRY[feature].shipped && visibility.section(feature));
	const { rowFailures, unclaimed } = placeWriteFailures(writeFailures, "features", visibility.row);
	// One announcement per failure seq across every surface: the pane-top away line may already have spoken this
	// failure before the reader arrived here.
	const unclaimedRole = useAlertOnce(unclaimed?.seq);

	return (
		<SettingFailuresContext.Provider value={rowFailures}>
			<Section
				id="features"
				title={l10n.t("Features")}
				help={helpFeaturesSection()}
				docs={{ href: DOCS_LINK_DASHBOARD_FEATURES, label: l10n.t("Open the features guide") }}
				meta={modifiedMeta(modifiedScopeCount(settings))}
				actions={
					<Input
						id={filterId}
						type="text"
						className="w-[16rem] @max-[640px]/pane:w-full min-w-0 max-w-full shrink"
						placeholder={l10n.t("Filter features, e.g. commit")}
						aria-label={l10n.t("Filter features")}
						value={filter}
						onChange={(event) => setFilter(event.currentTarget.value)}
					/>
				}
			>
				{/* The fallback for a failure no mounted row claims; a claimed one
				    renders under its own row instead (see SettingRow). */}
				{unclaimed === undefined ? null : (
					<p key={unclaimed.seq} className="error" role={unclaimedRole}>
						{writeFailureText(unclaimed)}
					</p>
				)}
				{nothingMatches ? <p className="empty">{l10n.t("No features match the filter.")}</p> : null}
				{comingShown ? <p className="hint">{featuresComingHint()}</p> : null}
				<div className={SETTING_GRID_TRACKS}>
					{FEATURE_IDS.map((feature) => (
						<FeatureGroup
							key={feature}
							feature={feature}
							settings={settings}
							visibility={visibility}
							tailContext={tailContext}
							featureModelOptions={featureModelOptions}
							declaredLabels={declaredServerLabels ?? []}
							featureProbes={featureProbes}
						/>
					))}
				</div>
			</Section>
		</SettingFailuresContext.Provider>
	);
}
