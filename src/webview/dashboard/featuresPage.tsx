/**
 * The Features tab: every feature as one group over the same configuration the
 * Settings editor writes - the enable row, the model picker where the feature
 * has a model key, and the feature's own rows (the inline language filter, the
 * commit prompt). Sections are DATA: FEATURE_REGISTRY is total over FeatureId,
 * so a new feature fails compilation until it declares its section, and the
 * unshipped features render their rows inert (registered vocabulary, a quiet
 * "Coming soon" badge on the heading, and one page-level hint saying what the
 * badge means) so enabling early is safe and visible.
 */

import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { useContext, useEffect, useId, useState } from "react";
import type { SettingWriteMethod } from "../../dashboard/endpoints";
import { WIRE_LIMITS } from "../../dashboard/endpoints";
import type {
	DashboardModel,
	DashboardSettings,
	LanguageFilterSetting,
	SettingRowId,
	SettingScope,
} from "../../dashboard/viewModels";
import type { FeatureId, FeatureModelId, FeatureModelRef } from "../../shared/config/settingSpec";
import {
	FEATURE_ENABLE_SETTING_KEYS,
	FEATURE_IDS,
	FEATURE_MODEL_SETTING_KEYS,
	isFeatureModelId,
	LANGUAGE_FILTER_MODES,
} from "../../shared/config/settingSpec";
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
import { useIntentOutcome } from "./hooks";
import type { SettingWriteFailure } from "./settingRows";
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

/** The model-picker rows' descriptions, keyed by feature; the filter matches this exact text. */
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

/** The model-picker rows' titles, keyed by feature like featureModelDescription. */
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

/** Each feature section's heading, in the registry's render order. */
function featureSectionTitle(feature: FeatureId): string {
	switch (feature) {
		case "inlineCompletions":
			return l10n.t("Inline completions");
		case "commitGeneration":
			return l10n.t("Commit message generation");
		case "prGeneration":
			return l10n.t("PR description generation");
		case "consultTool":
			return l10n.t("Consult tool");
		case "quickFix":
			return l10n.t("Quick fixes");
		case "reviewComments":
			return l10n.t("Review comments");
		case "chatParticipant":
			return l10n.t("Chat participant (@litellm)");
	}
}

/**
 * The marker an unshipped feature's heading wears: the shared Badge, quiet
 * variant - a soft-fill prose fact beside a name, which is the badge's one job.
 * Two words per section, not a sentence per section: the sentence they used to
 * repeat five times is hoisted to the page's one hint (featuresComingHint), so
 * the consequence is stated once and each heading only says which sections it
 * applies to.
 */
function comingSoonMarker(): ReactNode {
	return <Badge>{l10n.t("Coming soon")}</Badge>;
}

/** The page-level hint the section badges point at; rendered only while some section wears one. */
function featuresComingHint(): string {
	return l10n.t(
		"Sections marked Coming soon can be configured now; their settings take effect when the feature ships."
	);
}

function commitPromptDescription(): string {
	return l10n.t("Custom instruction for generated commit messages; empty uses the built-in.");
}

/** The language filter's mode row title and description; the filter matches this exact text. */
function languageFilterModeTitle(): string {
	return l10n.t("Language filter");
}

function languageFilterModeDescription(): string {
	return l10n.t("Whether the language list blocks or allows inline completions.");
}

/** The mode options' names, resolved at call time (no module-level localized constants). */
function languageFilterModeLabel(mode: (typeof LANGUAGE_FILTER_MODES)[number]): string {
	return mode === "allow" ? l10n.t("Allow only listed languages") : l10n.t("Block listed languages");
}

/** The language filter's list row title and description, keyed by the picked mode like its help. */
function languageFilterListTitle(mode: (typeof LANGUAGE_FILTER_MODES)[number]): string {
	return mode === "allow" ? l10n.t("Allowed languages") : l10n.t("Blocked languages");
}

function languageFilterListDescription(mode: (typeof LANGUAGE_FILTER_MODES)[number]): string {
	return mode === "allow"
		? l10n.t("Inline completions run only in these language IDs.")
		: l10n.t("Inline completions run everywhere except these language IDs.");
}

/**
 * The (serverLabel, rawId) pairs of DECLARED entries' models as FeatureModelRef options,
 * deduplicated in the models table's order. External groups are excluded by construction:
 * a ref names a servers-entry label, which external groups do not have, so offering their
 * models would mint picks the feature could never resolve. A multi-claimant model appears
 * once per claimant label on purpose: each label is a distinct addressable entry.
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

/** One (server, model) pair's select-option identity; also the option's React key. */
function modelRefIdentity(ref: FeatureModelRef): string {
	// A JSON tuple, so the encoding is collision-safe whatever characters a
	// label or a discovered model ID contains.
	return JSON.stringify([ref.server, ref.model]);
}

/**
 * The select's custom-entry sentinel: real option values are JSON tuples
 * (always starting with "[") or the empty not-set value, so this bare word
 * can never collide with a served pair.
 */
const CUSTOM_OPTION = "custom";

/**
 * One feature's model-picker row, rendered for every model-picking feature. The select
 * offers "Not set" plus every declared entry's served (server, model) pair; a configured
 * ref no offered pair currently backs stays IN the option list (selected, same rendered
 * text), so the dangling state changes no geometry - its only visible delta is the
 * warning in the covered description slot, which holds the cell's height by the covering
 * contract (check-geometry pins both). A standing write failure for this row outranks the
 * dangling warning: both render in the same covered slot, and the warning never clears
 * on its own, so it must not mask "the last change did not apply".
 *
 * "Custom model ID..." swaps the select for a same-height entry cluster (a declared
 * entry's label plus a free-typed model ID): the escape hatch for models the picker
 * cannot list - completion-mode (FIM) models never register as chat models, and a
 * server may serve IDs discovery cannot see. A feature whose probe activation registered
 * (state.featureProbes) also carries the test button: one probe running the feature's
 * exact pipeline, its outcome rendered as a short tone-styled status beside it (counts
 * and classified messages only, never response text).
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
	/** The declared entries' labels, for the custom-entry cluster's server pick. */
	declaredLabels: readonly string[];
	configuredScope: SettingScope | null;
	hidden: boolean;
	/** Whether the host registered a probe for this feature; gates the test button. */
	probeAvailable: boolean;
}) {
	// Dangling is judged by the SERVER label alone: the feature resolves a ref
	// through its declared entry, and a declared server may legitimately serve
	// IDs the chat catalog never lists (completion-mode FIM models above all),
	// so absence from the options proves nothing about the model.
	const dangling = value !== null && !declaredLabels.includes(value.server);
	// A configured pair the options do not list joins them so the pick stays
	// visible and keepable; labels and model IDs are user configuration, safe
	// to render.
	const listed = value !== null && options.some((option) => modelRefIdentity(option) === modelRefIdentity(value));
	const allOptions = value !== null && !listed ? [...options, value] : options;
	const selected = value === null ? "" : modelRefIdentity(value);
	const settingId = FEATURE_MODEL_SETTING_KEYS[feature];
	const inputId = `setting-${settingId}`;
	const errorId = `${inputId}-error`;
	// Custom-entry draft; undefined means the plain select renders.
	const [customDraft, setCustomDraft] = useState<{ server: string; model: string } | undefined>(undefined);
	// The probe's own round trip (hook order is fixed; only probe-carrying rows
	// render the button). The outcome is keyed to the request id AND the tested
	// pair, so a result can never sit beside a model it did not test.
	const probe = useIntentOutcome("testFeatureModel");
	const [probeRequest, setProbeRequest] = useState<{ id: string; model: string } | undefined>(undefined);
	const probeCurrent = probeRequest !== undefined && value !== null && probeRequest.model === modelRefIdentity(value);
	const probeOutcome =
		probeCurrent && probe.outcome !== undefined && probe.outcome.id === probeRequest.id ? probe.outcome : undefined;
	const probing = probeCurrent && probeOutcome === undefined;
	// SettingRow shows a write failure only while `error` is empty, so the
	// standing warning yields to it here; the warning resurfaces once the next
	// push clears the failure.
	const writeFailure = useContext(SettingFailuresContext)[settingId];
	const warningShown = dangling && writeFailure === undefined && customDraft === undefined;
	// The landed probe outcome rides the covered-description slot (the
	// height-keeping overlay), below the dangling warning and write failures.
	// The FULL message travels: the cover renders its first truncated line and
	// the Details disclosure reveals the whole two-part text selectable.
	const probeNotice =
		probeOutcome === undefined || warningShown
			? undefined
			: {
					text: probeOutcome.message ?? "",
					tone:
						probeOutcome.result === "fail"
							? ("error" as const)
							: probeOutcome.tone === "warning"
								? ("warning" as const)
								: ("ok" as const),
				};
	// Any custom-editor activity clears the landed probe outcome: the editor
	// exists to change what the probe tested, so a standing result would be a
	// stale annotation (the Test connection staleness rule).
	const updateDraft = (draft: { server: string; model: string } | undefined) => {
		setCustomDraft(draft);
		setProbeRequest(undefined);
	};
	const pick = (next: string) => {
		if (next === CUSTOM_OPTION) {
			// Only a declared label may seed the draft: the controlled select
			// would otherwise DISPLAY its first option while a commit submitted
			// the stale label underneath.
			const seed = value !== null && declaredLabels.includes(value.server) ? value.server : (declaredLabels[0] ?? "");
			updateDraft({ server: seed, model: "" });
			return;
		}
		if (next === selected) {
			return;
		}
		if (next === "") {
			sendRequest("setFeatureModel", { feature, value: null });
			return;
		}
		// Total by construction: an option value that resolves to no offered pair
		// (impossible from an honest select) writes nothing rather than clearing.
		const picked = allOptions.find((option) => modelRefIdentity(option) === next);
		if (picked !== undefined) {
			sendRequest("setFeatureModel", { feature, value: picked });
		}
	};
	const customCommittable =
		customDraft !== undefined && declaredLabels.includes(customDraft.server) && customDraft.model.trim() !== "";
	const commitCustom = () => {
		if (customDraft === undefined || !customCommittable) {
			return;
		}
		sendRequest("setFeatureModel", { feature, value: { server: customDraft.server, model: customDraft.model.trim() } });
		updateDraft(undefined);
	};
	const picker =
		customDraft === undefined ? (
			<Select
				id={inputId}
				className="min-w-0 max-w-full"
				value={selected}
				aria-invalid={dangling}
				// Only while the warning element actually renders under errorId; the
				// write-failure cover that can replace it carries no id.
				aria-describedby={warningShown ? errorId : undefined}
				onChange={(event) => pick(event.currentTarget.value)}
			>
				<option value="">{l10n.t("Not set")}</option>
				{allOptions.map((option) => (
					// Entry labels and raw IDs are the option's identity; the pair is unique by construction.
					<option key={modelRefIdentity(option)} value={modelRefIdentity(option)}>
						{`${option.server}: ${option.model}`}
					</option>
				))}
				<option value={CUSTOM_OPTION}>{l10n.t("Custom model ID...")}</option>
			</Select>
		) : (
			// A deliberate two-line editor: the inputs share the first line and
			// the RANKED actions sit on their own (Use model primary, Cancel one
			// rank below) - opening it is a user-initiated height change the
			// geometry registry marks intended.
			<div className="flex w-full min-w-0 flex-col gap-2">
				<div className="flex w-full min-w-0 flex-wrap items-center gap-2">
					<Select
						id={inputId}
						aria-label={l10n.t("Server")}
						className="min-w-0 max-w-48 shrink"
						value={customDraft.server}
						onChange={(event) => updateDraft({ ...customDraft, server: event.currentTarget.value })}
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
						value={customDraft.model}
						onInput={(event) => updateDraft({ ...customDraft, model: event.currentTarget.value })}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								commitCustom();
							}
						}}
					/>
				</div>
				<div className="flex items-center gap-2">
					<Button size="compact" variant="default" disabled={!customCommittable} onClick={commitCustom}>
						{l10n.t("Use model")}
					</Button>
					<Button size="compact" variant="secondary" onClick={() => updateDraft(undefined)}>
						{l10n.t("Cancel")}
					</Button>
				</div>
			</div>
		);
	return (
		<SettingRow
			settingId={settingId}
			title={featureModelTitle(feature)}
			titleFor={inputId}
			description={featureModelDescription(feature)}
			help={helpFeatureModel()}
			error={
				warningShown
					? {
							// The ROW says only which server went; the consequence-first
							// sentence rides Details, so the covered line stays scannable
							// at every pane width and in every locale.
							headline: l10n.t('Server "{0}" is unavailable.', value?.server ?? ""),
							detail: l10n.t(
								'This model cannot be reached because server "{0}" is no longer configured. Choose another model or restore that server under Servers.',
								value?.server ?? ""
							),
						}
					: undefined
			}
			errorId={errorId}
			notice={probeNotice}
			configuredScope={configuredScope}
			hidden={hidden}
			control={
				<>
					{picker}
					{probeAvailable && customDraft === undefined ? (
						<Button
							size="compact"
							variant="secondary"
							disabled={value === null || dangling || probing}
							onClick={() => {
								if (value !== null) {
									setProbeRequest({
										id: probe.send({ feature, model: value }),
										model: modelRefIdentity(value),
									});
								}
							}}
						>
							{probing ? l10n.t("Testing...") : l10n.t("Test model")}
						</Button>
					) : null}
				</>
			}
		/>
	);
}

/**
 * The commitGeneration.prompt row: one free-text box over the instruction. The empty
 * string is the built-in instruction (the intent resets the setting); a draft past the
 * wire bound shows the bound and never commits, like the currency symbol. The box is a
 * bounded auto-growing textarea - two rows at rest, eight before it scrolls inside
 * itself - because the prompt is prose that may carry newlines: plain Enter breaks a
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on syncKey alone; the external value is read at sync time, not watched
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
					// Prose grows sideways like the keyword list (the cap IS the control
					// column) and DOWNWARD in place: field-sizing tracks the content
					// between the two-row floor and the eight-row ceiling, then the box
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
						// Plain Enter is a LINE BREAK here, never a commit: the flattening
						// bug this box replaced. The modifier chord keeps a keyboard
						// commit, because the panel dies when hidden and an uncommitted
						// draft dies with it; preventDefault so the chord commits WITHOUT
						// also editing the draft it just committed.
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
 * The languageFilter setting's two rows over one wire method. Each row sends
 * ONLY its own half as a patch - the mode select a mode, the list row
 * languages - and the extension merges the patch onto the stored filter on
 * the chained channel, so two quick writes from different rows can never
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

/**
 * The languageFilter mode row: which way the list row below applies. A
 * companion row - the list row is the setting's primary row (actions, write
 * failures), so the pair reads as one setting spanning two rows.
 */
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
	// The stored value only settings.json can round-trip freezes the mode too:
	// a mode write re-sends the normalized list and would destroy the raw form.
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
						// The mode travels with the languages it applies to: switching
						// mode keeps the list exactly as last written.
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

/** The languageFilter list row over the shared comma-list editor; its write keeps the mode as last written. */
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

/**
 * One feature's section as data. `coming` renders the standing heading note
 * (the settings are registered ahead of the feature and inert until it ships);
 * `tail` is the feature's own extra rows beyond enable and model.
 */
interface FeatureDescriptor {
	/** Whether the feature has shipped; false renders the "not active yet" heading note. */
	readonly shipped: boolean;
	/**
	 * The feature's rows beyond enable and model, with their filter haystack:
	 * `visible` judges the tail against the shared matcher, `rows` renders it.
	 */
	readonly tail?: {
		readonly visible: (matches: (...haystack: string[]) => boolean, ctx: FeatureTailContext) => boolean;
		readonly rows: (ctx: FeatureTailContext, hidden: boolean) => ReactNode;
	};
}

/** What a feature tail can read and render from; the page assembles it once. */
interface FeatureTailContext {
	readonly settings: DashboardSettings;
}

/**
 * The feature sections, total over FeatureId by mapped type: a new FeatureId
 * fails compilation until it declares its section here, which is what makes a
 * feature a table-row addition instead of a page edit.
 */
const FEATURE_REGISTRY: { readonly [K in FeatureId]: FeatureDescriptor } = {
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
	prGeneration: { shipped: false },
	consultTool: { shipped: false },
	quickFix: { shipped: false },
	reviewComments: { shipped: false },
	chatParticipant: { shipped: true },
};

export function FeaturesSection({
	settings,
	models,
	declaredServerLabels,
	featureProbes,
	writeFailures,
}: {
	settings: DashboardSettings;
	models: readonly DashboardModel[];
	/**
	 * The declared entries' labels (state.servers, origin "declared"): what the feature
	 * model pickers may offer, since a ref addresses a servers-entry label and external
	 * groups have none. Absent offers nothing - fail-closed, never a wrong pick.
	 */
	declaredServerLabels?: readonly string[] | undefined;
	/** The features whose model row carries a test probe (DashboardState.featureProbes). */
	featureProbes?: readonly FeatureModelId[] | undefined;
	/** The standing scalar-write failures from App's store, for this page to place by owning row. */
	writeFailures?: Partial<Record<SettingWriteMethod, SettingWriteFailure>> | undefined;
}) {
	// Computed once for every picker row; the same option list is what the
	// dangling verdict is judged against.
	const featureModelOptions = modelRefOptions(models, new Set(declaredServerLabels ?? []));
	const [filter, setFilter] = useState("");
	const filterId = useId();
	const { needle, matches } = filterMatcher(filter);
	const tailContext: FeatureTailContext = { settings };

	// Per-feature visibility, one verdict per row kind, derived from the same
	// matcher every row's haystack goes through.
	const enableVisible = (feature: FeatureId): boolean => {
		const id = FEATURE_ENABLE_SETTING_KEYS[feature];
		const { label, description } = scalarText(id);
		return matches(label, description, id, settingRowHelp(id) ?? "");
	};
	const modelVisible = (feature: FeatureModelId): boolean =>
		matches(
			featureModelTitle(feature),
			featureModelDescription(feature),
			FEATURE_MODEL_SETTING_KEYS[feature],
			helpFeatureModel()
		);
	const tailVisible = (feature: FeatureId): boolean => {
		const tail = FEATURE_REGISTRY[feature].tail;
		return tail !== undefined && (needle.length === 0 || tail.visible(matches, tailContext));
	};
	const sectionAnyVisible = (feature: FeatureId): boolean =>
		enableVisible(feature) || (isFeatureModelId(feature) && modelVisible(feature)) || tailVisible(feature);
	const nothingMatches = !FEATURE_IDS.some(sectionAnyVisible);
	// The badges' one explanation, hoisted off the headings: derived, so it
	// stands exactly while a visible section wears the badge and disappears of
	// its own accord once every feature ships.
	const comingShown = FEATURE_IDS.some((feature) => !FEATURE_REGISTRY[feature].shipped && sectionAnyVisible(feature));

	// Whether the row a failure would land on is actually on screen; total and
	// fail-open by construction - an id this page cannot name renders visible.
	const rowVisible = (row: SettingRowId): boolean => {
		for (const feature of FEATURE_IDS) {
			if (row === FEATURE_ENABLE_SETTING_KEYS[feature]) {
				return enableVisible(feature);
			}
			if (isFeatureModelId(feature) && row === FEATURE_MODEL_SETTING_KEYS[feature]) {
				return modelVisible(feature);
			}
		}
		if (row === "inlineCompletions.languageFilter") {
			return tailVisible("inlineCompletions");
		}
		if (row === "commitGeneration.prompt") {
			return tailVisible("commitGeneration");
		}
		return true;
	};
	const { rowFailures, unclaimed } = placeWriteFailures(writeFailures, "features", rowVisible);
	// One announcement per failure seq across every surface: the pane-top away
	// line may already have spoken this failure before the reader arrived here.
	const unclaimedRole = useAlertOnce(unclaimed?.seq);

	// The meta line counts this page's own rows: the feature enables, models,
	// and tails, never the Settings page's scalars.
	const scopes: readonly (SettingScope | null)[] = [
		...FEATURE_IDS.map((feature) => settings.configuredScopes.booleans[FEATURE_ENABLE_SETTING_KEYS[feature]]),
		...Object.values(settings.featureModelScopes),
		settings.commitPromptScope,
		settings.languageFilter.languages.scope,
	];
	const modifiedCount = scopes.filter((scope) => scope !== null).length;

	return (
		<SettingFailuresContext.Provider value={rowFailures}>
			<Section
				id="features"
				title={l10n.t("Features")}
				help={helpFeaturesSection()}
				docs={{ href: DOCS_LINK_DASHBOARD_FEATURES, label: l10n.t("Open the features guide") }}
				meta={
					modifiedCount === 0
						? undefined
						: modifiedCount === 1
							? l10n.t("1 modified")
							: l10n.t("{0} modified", modifiedCount)
				}
				actions={
					<Input
						id={filterId}
						type="text"
						// 16rem beside the header line; once the 640px strip wrap gives
						// this input its own line, w-full is what makes it BE that line.
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
				{unclaimed !== undefined ? (
					<p key={unclaimed.seq} className="error" role={unclaimedRole}>
						{writeFailureText(unclaimed)}
					</p>
				) : null}
				{nothingMatches ? <p className="empty">{l10n.t("No features match the filter.")}</p> : null}
				{comingShown ? <p className="hint">{featuresComingHint()}</p> : null}
				<div className={SETTING_GRID_TRACKS}>
					{FEATURE_IDS.map((feature) => {
						const descriptor = FEATURE_REGISTRY[feature];
						const enableId = FEATURE_ENABLE_SETTING_KEYS[feature];
						const model = isFeatureModelId(feature) ? feature : undefined;
						return (
							<SettingGroup
								key={feature}
								title={() => featureSectionTitle(feature)}
								note={descriptor.shipped ? undefined : comingSoonMarker}
								numbers={[]}
								booleans={[enableId]}
								settings={settings}
								isVisible={() => enableVisible(feature)}
								tailVisible={(model !== undefined && modelVisible(model)) || tailVisible(feature)}
								tail={
									<>
										{model !== undefined ? (
											<FeatureModelRow
												feature={model}
												value={settings.featureModels[model]}
												options={featureModelOptions}
												declaredLabels={declaredServerLabels ?? []}
												configuredScope={settings.featureModelScopes[model]}
												hidden={!modelVisible(model)}
												probeAvailable={featureProbes?.includes(model) === true}
											/>
										) : null}
										{descriptor.tail !== undefined ? descriptor.tail.rows(tailContext, !tailVisible(feature)) : null}
									</>
								}
							/>
						);
					})}
				</div>
			</Section>
		</SettingFailuresContext.Provider>
	);
}
