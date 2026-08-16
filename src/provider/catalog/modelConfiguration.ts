import * as l10n from "@vscode/l10n";
import type { LanguageModelConfigurationSchema } from "vscode";
import type { EffectiveCapabilityFields } from "../../shared/config/capabilityResolution";
import { capabilityField } from "../../shared/config/capabilityResolution";
import { isRecord } from "../../shared/util/json";
import type { LiteLLMProvider } from "./schemas";

/**
 * The per-model configuration surfaced in the host's model picker. A model
 * that returns a `configurationSchema` gets a Configure Model submenu rendered
 * from the schema's enum properties; the host persists the user's choice in
 * the provider group's settings and resolves it back into
 * `options.modelConfiguration` on every chat request. Registration decides
 * which models carry the schema (a capability question), and the request path
 * maps the resolved values onto wire parameters (a parameter question), so
 * both sides live in this one module.
 */

/**
 * The built-in reasoning effort levels, in menu order: the walk's backstop
 * when neither a `reasoning_effort_levels` capability record nor the server's
 * `supports_<level>_reasoning_effort` flags name a per-model list. A floor,
 * not a ceiling: the level vocabulary is open, so a record can list levels
 * this extension has never heard of and the menu offers them verbatim. A level
 * a given model rejects surfaces the server's own invalid-parameter error
 * through the chat error path. "none" is a real wire value (thinking off,
 * where supported), distinct from the sentinel below, which sends nothing.
 */
export const DEFAULT_REASONING_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Sentinel picker value meaning "send nothing; the provider's default
 * applies". The host can only unset a stored choice by selecting the schema
 * default, so without this entry a picked level could never be undone from the
 * menu. The sentinel never reaches the wire:
 * requestParamsFromModelConfiguration drops it, which keeps the pass-through
 * invariant intact even though the host folds this schema default into every
 * request's modelConfiguration.
 */
const PROVIDER_DEFAULT = "default";

/**
 * The localized label of a known picker value; an unknown level shows its raw
 * wire string, a protocol term that stays unlocalized. Resolved at call time,
 * never at module level: modules load before the l10n bundle is configured.
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

/** The localized menu description of a picker value; unknown levels state the wire value they send. */
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
 * The picker's value list for a resolved level list: the sentinel first, then
 * the levels deduplicated in their given order. Sanitized rather than trusted:
 * a level equal to the sentinel would make "send this level" and "send
 * nothing" one menu entry, and an empty string cannot be a wire value. The one
 * enum builder, shared by the schema and by capabilityOverrides' advertises
 * check, so the two can never disagree.
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
 * The schema behind the "Reasoning Effort" submenu, built per model from its
 * resolved level list. Labels and descriptions are built from the values so
 * the host's requirement that `enumItemLabels`/`enumDescriptions` match the
 * enum's length and order holds by construction. The default is the
 * PROVIDER_DEFAULT sentinel, not a real effort level: an unset picker resolves
 * to it and the request path sends nothing.
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

/** LiteLLM's per-level support flags, e.g. supports_xhigh_reasoning_effort; the level name is the capture. */
const REASONING_LEVEL_FLAG = /^supports_(.+)_reasoning_effort$/;

/**
 * The reasoning effort levels a server report flags, or undefined when it
 * flags none. LiteLLM stamps `supports_<level>_reasoning_effort` per level
 * onto model info, `true`/`false`/`null`; only an explicit `true` counts, and
 * a report whose every flag is false or null reads as no signal rather than an
 * empty menu (a user record can still write the exact list). Known levels come
 * back in the built-in menu order, unknown flagged levels after them in report
 * order.
 */
export function reasoningEffortLevelsFromFlags(source: unknown): string[] | undefined {
	if (!isRecord(source)) {
		return undefined;
	}
	const flagged = new Set<string>();
	for (const [key, value] of Object.entries(source)) {
		const level = REASONING_LEVEL_FLAG.exec(key)?.[1];
		if (level !== undefined && level !== "" && value === true) {
			flagged.add(level);
		}
	}
	if (flagged.size === 0) {
		return undefined;
	}
	const known = DEFAULT_REASONING_EFFORT_LEVELS.filter((level) => flagged.has(level));
	const unknown = [...flagged].filter(
		(level) => !(DEFAULT_REASONING_EFFORT_LEVELS as readonly string[]).includes(level)
	);
	return [...known, ...unknown];
}

/**
 * The picker's level list from a model's effective capability fields: the
 * resolved `reasoning_effort_levels` value when some level carries one, else
 * the built-in default list. The extra validation is a backstop: every source
 * of the field is kind-validated already, so a non-string-array cannot arise;
 * falling back keeps the menu total anyway.
 */
export function effectiveReasoningLevels(fields: EffectiveCapabilityFields): readonly string[] {
	const value = capabilityField(fields, "reasoning_effort_levels")?.value;
	return Array.isArray(value) && value.every((level) => typeof level === "string")
		? (value as readonly string[])
		: DEFAULT_REASONING_EFFORT_LEVELS;
}

/**
 * Whether a provider entry's capability data says the model accepts a
 * reasoning-effort request parameter. An explicit supports_reasoning: false is
 * a veto: a deployment merge ANDs the flag across deployments but only
 * intersects the supported-params lists, so without the veto a params list
 * could resurrect a capability one deployment explicitly disclaimed. Otherwise
 * the explicit true flag or reasoning_effort among the supported OpenAI params
 * counts. The per-level flags decide the menu's contents, never the control's
 * existence.
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

/**
 * Request parameters resolved from a request's modelConfiguration, already
 * under their wire keys. A type literal (not an interface) so it satisfies
 * buildRequestBody's Record-typed pass-through.
 */
export type ModelConfigurationRequestParams = {
	reasoning_effort?: string;
};

/**
 * Map the host-resolved modelConfiguration onto wire request parameters. Only
 * the properties this extension declared in its configuration schema are
 * mapped, each under its explicit wire key; the object is never spread
 * blindly, so host-added properties this version never declared cannot leak
 * into the request. The level vocabulary is open on purpose, so any non-empty
 * string except the PROVIDER_DEFAULT sentinel goes out as-is, and the
 * sentinel's drop is how an unset picker sends nothing at all. Non-strings
 * still drop: the host merges the group's stored settings into
 * modelConfiguration verbatim, without checking them against the schema.
 */
export function requestParamsFromModelConfiguration(modelConfiguration: unknown): ModelConfigurationRequestParams {
	if (!isRecord(modelConfiguration)) {
		return {};
	}
	const effort: unknown = modelConfiguration.reasoningEffort;
	return typeof effort === "string" && effort !== "" && effort !== PROVIDER_DEFAULT ? { reasoning_effort: effort } : {};
}
