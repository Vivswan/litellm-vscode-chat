import * as l10n from "@vscode/l10n";
import type { LanguageModelConfigurationSchema } from "vscode";
import type { EffectiveCapabilityFields } from "../../shared/config/capabilityResolution";
import { capabilityField } from "../../shared/config/capabilityResolution";
import { isRecord } from "../../shared/util/json";
import type { LiteLLMProvider } from "./schemas";

/**
 * A model that returns a `configurationSchema` gets a Configure Model submenu rendered from the schema's enum
 * properties; the host persists the user's choice in the provider group's settings and resolves it back into
 * `options.modelConfiguration` on every chat request. Registration decides which models carry the schema (a capability
 * question), and the request path maps the resolved values onto wire parameters (a parameter question), so both sides
 * live in this one module.
 */

/**
 * The built-in reasoning effort levels, in menu order: the walk's backstop when neither a `reasoning_effort_levels`
 * capability record nor the server's `supports_<level>_reasoning_effort` flags name a per-model list. "none" is a real
 * wire value (thinking off, where supported), distinct from the sentinel below, which sends nothing.
 *   A floor, not a ceiling: the level vocabulary is open -> a record can list levels this extension has never heard of
 *                                                            and the menu offers them verbatim
 *   A level a given model rejects                        -> surfaces the server's own invalid-parameter error through
 *                                                            the chat error path
 */
export const DEFAULT_REASONING_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * The host can only unset a stored choice by selecting the schema default, so without this entry a picked level could
 * never be undone from the menu. The sentinel never reaches the wire: requestParamsFromModelConfiguration drops it,
 * which keeps the pass-through invariant intact even though the host folds this schema default into every request's
 * modelConfiguration.
 */
const PROVIDER_DEFAULT = "default";

/**
 * The localized label of a known picker value; an unknown level shows its raw wire string, a protocol term that stays
 * unlocalized. Resolved at call time, never at module level: modules load before the l10n bundle is configured.
 */
function pickerLabel(value: string): string {
	switch (value) {
		case PROVIDER_DEFAULT:
			return l10n.t("Provider default");
		case "none":
			return l10n.t({ message: "Off", comment: ["Reasoning effort level label in the model picker"] });
		case "minimal":
			return l10n.t({ message: "Minimal", comment: ["Reasoning effort level label in the model picker"] });
		case "low":
			return l10n.t({ message: "Low", comment: ["Reasoning effort level label in the model picker"] });
		case "medium":
			return l10n.t({ message: "Medium", comment: ["Reasoning effort level label in the model picker"] });
		case "high":
			return l10n.t({ message: "High", comment: ["Reasoning effort level label in the model picker"] });
		case "xhigh":
			return l10n.t({ message: "Extra High", comment: ["Reasoning effort level label in the model picker"] });
		case "max":
			return l10n.t({ message: "Max", comment: ["Reasoning effort level label in the model picker"] });
		default:
			return value;
	}
}

function pickerDescription(value: string): string {
	switch (value) {
		case PROVIDER_DEFAULT:
			return l10n.t("Send no reasoning effort; the provider's own default applies");
		case "none":
			return l10n.t("Ask the model to skip reasoning entirely, on models that can turn thinking off");
		case "minimal":
			return l10n.t("The fastest reasoning tier, on models that offer one below Low");
		case "low":
			return l10n.t("Favor speed and cost over reasoning depth");
		case "medium":
			return l10n.t("Balance reasoning depth against latency");
		case "high":
			return l10n.t("Spend more reasoning on harder problems");
		case "xhigh":
			return l10n.t("A deeper reasoning tier above High, on models that offer one");
		case "max":
			return l10n.t("The deepest reasoning tier, on models that offer one");
		default:
			return l10n.t('Sent as reasoning_effort "{0}"', value);
	}
}

/**
 * Sanitized rather than trusted: a level equal to the sentinel would make "send this level" and "send nothing" one
 * menu entry, and an empty string cannot be a wire value.
 */
export function reasoningEffortPickerValues(levels: readonly string[]): readonly string[] {
	const seen = new Set<string>([PROVIDER_DEFAULT, ""]);
	const values: string[] = [PROVIDER_DEFAULT];
	for (const level of levels) {
		if (!seen.has(level)) {
			seen.add(level);
			values.push(level);
		}
	}
	return values;
}

/**
 * Labels and descriptions are built from the values so the host's requirement that `enumItemLabels`/`enumDescriptions`
 * match the enum's length and order holds by construction. The default is the PROVIDER_DEFAULT sentinel, not a real
 * effort level: an unset picker resolves to it and the request path sends nothing.
 */
export function reasoningEffortSchema(levels: readonly string[]): LanguageModelConfigurationSchema {
	const values = reasoningEffortPickerValues(levels);
	return {
		properties: {
			reasoningEffort: {
				type: "string",
				title: l10n.t("Reasoning Effort"),
				description: l10n.t("How much reasoning the model puts in before it answers."),
				enum: [...values],
				enumItemLabels: values.map(pickerLabel),
				enumDescriptions: values.map(pickerDescription),
				default: PROVIDER_DEFAULT,
				// Promotes the control to a primary action in the picker.
				group: "navigation",
			},
		},
	};
}

/**
 * The one menu order: known levels in the built-in order, unknown ones after them as they arrived. The flag-derived
 * list and modelCatalog's cross-deployment merge both sort through here, so a known level's place never depends on
 * which deployment the server listed first.
 */
export function orderedReasoningLevels(levels: Iterable<string>): string[] {
	const present = new Set(levels);
	const known = DEFAULT_REASONING_EFFORT_LEVELS.filter((level) => present.has(level));
	const unknown = [...present].filter(
		(level) => !(DEFAULT_REASONING_EFFORT_LEVELS as readonly string[]).includes(level)
	);
	return [...known, ...unknown];
}

/** The flags LiteLLM reads, by polarity; medium and high have no flag and are always on for a reasoning model. */
const OPT_OUT_EFFORT_FLAGS = {
	minimal: "supports_minimal_reasoning_effort",
	low: "supports_low_reasoning_effort",
} as const;
const OPT_IN_EFFORT_FLAGS = { xhigh: "supports_xhigh_reasoning_effort", max: "supports_max_reasoning_effort" } as const;
const NONE_EFFORT_FLAG = "supports_none_reasoning_effort";
const EFFORT_FLAGS: readonly string[] = [
	NONE_EFFORT_FLAG,
	...Object.values(OPT_OUT_EFFORT_FLAGS),
	...Object.values(OPT_IN_EFFORT_FLAGS),
];

/** LiteLLM's `is None`: JSON null and an absent key read alike. */
function isUnset(value: unknown): boolean {
	return value === undefined || value === null;
}

/**
 * LiteLLM's litellm/router_utils/reasoning_effort_capability.py, mirrored for a proxy that predates
 * /model_group/info's supported_reasoning_efforts; the vectors in litellmReasoningEffortCases.ts are LiteLLM's own.
 * undefined is "unknown" and never narrows a group; [] is a model that takes no level. Two inputs LiteLLM has and the
 * wire does not: the cost-map twin merge (a prefixed entry's flags inherited from its unprefixed twin) stays
 * server-side, and discovery passes deploymentIsMapped false, so a flagless entry is unknown, never an empty menu.
 */
export function resolveSupportedReasoningEfforts(
	modelInfo: unknown,
	options: { readonly deploymentIsMapped: boolean }
): string[] | undefined {
	if (!isRecord(modelInfo)) {
		return undefined;
	}
	if (modelInfo.supports_reasoning === false) {
		return [];
	}
	const hasFlag = EFFORT_FLAGS.some((flag) => !isUnset(modelInfo[flag]));
	if (modelInfo.supports_reasoning !== true && !hasFlag) {
		return options.deploymentIsMapped ? [] : undefined;
	}
	const declared = modelInfo.reasoning_effort_levels;
	if (Array.isArray(declared)) {
		return DEFAULT_REASONING_EFFORT_LEVELS.filter((level) => declared.includes(level));
	}
	if (!hasFlag) {
		return undefined;
	}
	const allowed = new Set<string>(["medium", "high"]);
	for (const [level, flag] of Object.entries(OPT_OUT_EFFORT_FLAGS)) {
		if (modelInfo[flag] !== false) {
			allowed.add(level);
		}
	}
	for (const [level, flag] of Object.entries(OPT_IN_EFFORT_FLAGS)) {
		if (modelInfo[flag] === true) {
			allowed.add(level);
		}
	}
	if (supportsNoneReasoningEffort(modelInfo)) {
		allowed.add("none");
	}
	return DEFAULT_REASONING_EFFORT_LEVELS.filter((level) => allowed.has(level));
}

/**
 * Opt-in only where LiteLLM's request path refuses the level: its azure gpt-5 config raises on reasoning_effort "none"
 * without an explicit true, and that config is selected for the gpt-5 and gpt-6 names (minus gpt-5-chat) plus any
 * deployment spelled gpt5_series.
 */
function supportsNoneReasoningEffort(modelInfo: Record<string, unknown>): boolean {
	const flag = modelInfo[NONE_EFFORT_FLAG];
	const key = modelInfo.key;
	if (modelInfo.litellm_provider !== "azure" || typeof key !== "string" || !isAzureGpt5Family(key)) {
		return flag !== false;
	}
	return flag === true;
}

function isAzureGpt5Family(model: string): boolean {
	const bare = model.split("/").at(-1) ?? model;
	const reasoningSeries = (model.includes("gpt-5") || model.includes("gpt-6")) && !bare.includes("gpt-5-chat");
	return reasoningSeries || model.includes("gpt5_series");
}

/**
 * LiteLLM's group merge: a deployment resolved to unknown never narrows, and a level survives only when every
 * deployment with an answer accepts it, so the group offers nothing routing could reject. One departure from the
 * Python: a level outside the built-in vocabulary survives when both sides carry it, because the user's own levels are
 * open here and LiteLLM's are an enum.
 */
export function intersectSupportedReasoningEfforts(
	current: readonly string[] | undefined,
	resolved: readonly string[] | undefined
): string[] | undefined {
	if (resolved === undefined) {
		return current === undefined ? undefined : [...current];
	}
	if (current === undefined) {
		return [...resolved];
	}
	const keep = new Set(resolved);
	return orderedReasoningLevels(current.filter((level) => keep.has(level)));
}

/**
 * The extra validation is a backstop: every source of the field is kind-validated already, so a non-string-array
 * cannot arise; falling back keeps the menu total anyway.
 */
export function effectiveReasoningLevels(fields: EffectiveCapabilityFields): readonly string[] {
	const value = capabilityField(fields, "reasoning_effort_levels")?.value;
	return Array.isArray(value) && value.every((level) => typeof level === "string")
		? (value as readonly string[])
		: DEFAULT_REASONING_EFFORT_LEVELS;
}

/**
 * An explicit supports_reasoning: false is a veto: a deployment merge ANDs the flag across deployments but only
 * intersects the supported-params lists, so without the veto a params list could resurrect a capability one deployment
 * explicitly disclaimed.
 *   The per-level flags -> decide the menu's contents, never the control's existence
 */
export function supportsReasoningEffort(provider: LiteLLMProvider): boolean {
	if (provider.supports_reasoning === false) {
		return false;
	}
	if (provider.supports_reasoning === true) {
		return true;
	}
	const params: unknown = provider.supported_openai_params;
	return Array.isArray(params) && params.includes("reasoning_effort");
}

/** A type literal, not an interface, so it satisfies buildRequestBody's Record-typed pass-through. */
export type ModelConfigurationRequestParams = {
	reasoning_effort?: string;
};

/**
 * Never spread, so host-added properties this version's schema never declared cannot leak into the request, and
 * non-strings drop because the host merges the group's stored settings in verbatim, unchecked against the schema. The
 * level vocabulary is open on purpose, so any non-empty string except the PROVIDER_DEFAULT sentinel goes out as-is;
 * the sentinel's drop is how an unset picker sends nothing.
 */
export function requestParamsFromModelConfiguration(modelConfiguration: unknown): ModelConfigurationRequestParams {
	if (!isRecord(modelConfiguration)) {
		return {};
	}
	const effort: unknown = modelConfiguration.reasoningEffort;
	return typeof effort === "string" && effort !== "" && effort !== PROVIDER_DEFAULT ? { reasoning_effort: effort } : {};
}
