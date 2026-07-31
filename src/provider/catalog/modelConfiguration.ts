import type { LanguageModelConfigurationSchema } from "vscode";
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
 * The reasoning effort levels the picker can put on the wire, in menu order.
 * The one menu serves every reasoning model: LiteLLM's capability data names
 * the reasoning_effort parameter but never its accepted values, so per-model
 * menus cannot be derived from /v1/model/info. A level a given model rejects
 * (e.g. xhigh where only low/medium/high exist) surfaces the server's own
 * invalid-parameter error through the chat error path, where the user can
 * re-pick; LiteLLM's provider translations clamp several such cases first.
 * "none" is a real wire value (thinking off, where supported), distinct from
 * the sentinel below, which sends nothing at all.
 */
export const REASONING_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number];

/**
 * Sentinel picker value meaning "send nothing; the provider's default
 * applies". The host can only unset a stored choice by selecting the schema
 * default (it deletes a stored key exactly when the new value equals that
 * default), so without this entry a picked level could never be undone from
 * the menu. The sentinel never reaches the wire:
 * requestParamsFromModelConfiguration drops it, which keeps the pass-through
 * invariant intact even though the host folds this schema default into every
 * request's modelConfiguration.
 */
const PROVIDER_DEFAULT = "default";

const PICKER_VALUES = [PROVIDER_DEFAULT, ...REASONING_EFFORT_LEVELS] as const;

type PickerValue = (typeof PICKER_VALUES)[number];

const PICKER_LABELS: Readonly<Record<PickerValue, string>> = {
	default: "Provider default",
	none: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra High",
};

const PICKER_DESCRIPTIONS: Readonly<Record<PickerValue, string>> = {
	default: "Send no reasoning effort; the provider's own default applies",
	none: "Ask the model to skip reasoning entirely, on models that can turn thinking off",
	minimal: "The fastest reasoning tier, on models that offer one below Low",
	low: "Favor speed and cost over reasoning depth",
	medium: "Balance reasoning depth against latency",
	high: "Spend more reasoning on harder problems",
	xhigh: "The deepest reasoning tier, on models that offer one above High",
};

/**
 * The schema behind the "Reasoning Effort" submenu. The labels and
 * descriptions are built from the values so the host's requirement that
 * `enumItemLabels`/`enumDescriptions` match the enum's length and order holds
 * by construction. The default is the PROVIDER_DEFAULT sentinel, not a real
 * effort level: an unset picker resolves to it and the request path sends
 * nothing.
 */
export const REASONING_EFFORT_SCHEMA: LanguageModelConfigurationSchema = {
	properties: {
		reasoningEffort: {
			type: "string",
			title: "Reasoning Effort",
			description: "How much reasoning the model puts in before it answers.",
			enum: [...PICKER_VALUES],
			enumItemLabels: PICKER_VALUES.map((value) => PICKER_LABELS[value]),
			enumDescriptions: PICKER_VALUES.map((value) => PICKER_DESCRIPTIONS[value]),
			default: PROVIDER_DEFAULT,
			// Promotes the control to a primary action in the picker.
			group: "navigation",
		},
	},
};

/**
 * Whether a provider entry's capability data says the model accepts a
 * reasoning-effort request parameter. An explicit supports_reasoning: false
 * is a veto (matching the supportsTools convention in schemas.ts): a
 * deployment merge ANDs the flag across deployments but only intersects the
 * supported-params lists, so without the veto a params list could resurrect a
 * capability one deployment explicitly disclaimed. Otherwise the explicit
 * true flag or reasoning_effort among the supported OpenAI params counts.
 * Providers-array entries are lenient pass-throughs, so the params list is
 * re-narrowed before use.
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
	reasoning_effort?: ReasoningEffort;
};

function isReasoningEffort(value: unknown): value is ReasoningEffort {
	return typeof value === "string" && (REASONING_EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Map the host-resolved modelConfiguration onto wire request parameters. Only
 * the properties this extension declared in its configuration schema are
 * mapped, each under its explicit wire key; the object is never spread
 * blindly, so host-added properties this version never declared cannot leak
 * into the request. The value narrowing is load-bearing, not belt-and-braces:
 * the host merges the group's stored settings into modelConfiguration
 * verbatim, without checking them against the schema, so hand-edited or stale
 * settings arrive as-is. Anything but a known effort level drops silently,
 * including the PROVIDER_DEFAULT sentinel, which is how an unset (or reset)
 * picker sends nothing at all.
 */
export function requestParamsFromModelConfiguration(modelConfiguration: unknown): ModelConfigurationRequestParams {
	if (!isRecord(modelConfiguration)) {
		return {};
	}
	const effort: unknown = modelConfiguration.reasoningEffort;
	return isReasoningEffort(effort) ? { reasoning_effort: effort } : {};
}
