import { z } from "zod";
import { isRecord } from "../shared/json";

/**
 * Discovery payload schemas and the normalized model shapes they produce.
 * The raw schemas are deliberately minimal: they require exactly what the
 * normalization step reads and let everything else pass through, so a server
 * sending extra or oddly typed capability fields never loses a model.
 */

/**
 * Where a model's effective max output tokens came from: declared by the
 * server (safe to send as-is) or filled in by the configured defaults (a
 * guess, so requests stay under the conservative cap).
 */
export type OutputLimitSource = "provider" | "defaults";

/**
 * A single underlying provider (e.g., together, groq) for a model.
 * Capability metadata read from the LiteLLM API: what the model CAN do, not
 * what we ask it to do (request parameters come from the modelParameters
 * configuration). Only `provider` is validated on the wire; the remaining
 * fields are typed reads of the passed-through entry.
 */
export interface LiteLLMProvider {
	provider: string;
	status: string;
	supports_tools?: boolean | undefined;
	context_length?: number | undefined;
	max_tokens?: number | null | undefined;
	max_input_tokens?: number | null | undefined;
	max_output_tokens?: number | null | undefined;
	source?: "model_info" | undefined;
	/**
	 * Set by deployment merging, which stores effective (possibly
	 * defaults-derived) limits back into max_tokens/max_output_tokens: those
	 * stored values keep the merged advertisement honest but only count as
	 * server-declared when every merged deployment declared its own limit.
	 * Absent on unmerged providers, whose limit fields are the server's.
	 */
	output_limit_source?: OutputLimitSource | undefined;
	/** True if the upstream model advertises prompt caching support. */
	supports_prompt_caching?: boolean | null | undefined;
	/** True if the upstream model supports structured output / response_format schema. */
	supports_response_schema?: boolean | null | undefined;
	/** True if the upstream model supports reasoning/thinking. */
	supports_reasoning?: boolean | null | undefined;
	/** True if the upstream model supports PDF input. */
	supports_pdf_input?: boolean | null | undefined;
	/** List of OpenAI-compatible parameters the model supports. */
	supported_openai_params?: string[] | null | undefined;
	/** Cost per input token as LiteLLM reports it; registration converts it to a per-million display cost. */
	input_cost_per_token?: number | null | undefined;
	/** Cost per output token. */
	output_cost_per_token?: number | null | undefined;
	/** Cost per cached-read input token. */
	cache_read_input_token_cost?: number | null | undefined;
	/** Cost per cache-write input token. */
	cache_creation_input_token_cost?: number | null | undefined;
	/**
	 * Long-context tier costs, synthesized by discovery from LiteLLM's
	 * threshold-suffixed cost keys (input_cost_per_token_above_200k_tokens and
	 * friends); longContextCosts in discovery.ts holds the selection rule.
	 * Unlike the base costs above these never pass through raw: discovery
	 * authors them on every provider it normalizes.
	 */
	long_context_input_cost_per_token?: number | null | undefined;
	long_context_output_cost_per_token?: number | null | undefined;
	long_context_cache_read_input_token_cost?: number | null | undefined;
	long_context_cache_creation_input_token_cost?: number | null | undefined;
}

/** Architecture information for a model. */
export interface LiteLLMArchitecture {
	input_modalities?: string[];
	output_modalities?: string[];
}

/**
 * Normalized model entry used internally after discovery. Both discovery
 * endpoints are narrowed and normalized into this shape, so `providers` is
 * always an array (possibly empty for bare /v1/models entries).
 */
export interface LiteLLMModelItem {
	id: string;
	providers: LiteLLMProvider[];
	architecture?: LiteLLMArchitecture | undefined;
}

/** LiteLLM model metadata entry from /v1/model/info. */
export interface LiteLLMModelInfoItem {
	model_name?: string;
	litellm_params?: {
		model?: string;
	};
	model_info?: {
		id?: string;
		key?: string;
		/** True when the proxy has paused this deployment; blocked deployments must not register. */
		blocked?: boolean | null;
		max_tokens?: number | null | undefined;
		max_input_tokens?: number | null | undefined;
		max_output_tokens?: number | null | undefined;
		litellm_provider?: string;
		supports_function_calling?: boolean | null;
		supports_tool_choice?: boolean | null;
		supports_vision?: boolean | null;
		supports_prompt_caching?: boolean | null | undefined;
		supports_response_schema?: boolean | null | undefined;
		supports_reasoning?: boolean | null | undefined;
		supports_pdf_input?: boolean | null | undefined;
		supports_audio_input?: boolean | null;
		supports_audio_output?: boolean | null;
		supported_openai_params?: string[] | null | undefined;
		/**
		 * Per-token costs; numbers only, and a malformed value degrades to absent
		 * at mapping. Long-context tiers arrive as threshold-suffixed variants of
		 * these keys (e.g. input_cost_per_token_above_200k_tokens) and are read
		 * dynamically by the mapping step, so they carry no declarations here.
		 */
		input_cost_per_token?: number | null | undefined;
		output_cost_per_token?: number | null | undefined;
		cache_read_input_token_cost?: number | null | undefined;
		cache_creation_input_token_cost?: number | null | undefined;
	};
}

/**
 * Raw models-listing entry from either endpoint: `id` must be a string and
 * `providers`, when present, must be an array (/v1/models items omit it).
 * Element contents stay unvalidated here; provider entries are narrowed
 * individually so one malformed entry drops alone.
 */
export const rawModelItemSchema = z.looseObject({
	id: z.string(),
	providers: z.array(z.unknown()).optional(),
	architecture: z.unknown().optional(),
});

export type RawModelItem = z.infer<typeof rawModelItemSchema>;

/** Raw provider entry: `provider` must be a string, everything else passes through. */
export const providerEntrySchema = z.looseObject({
	provider: z.string(),
});

function firstNonEmptyString(...candidates: unknown[]): string | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}
	return undefined;
}

/** The model identifier of a /v1/model/info entry, in documented priority order. */
export function modelInfoId(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const litellmParams = isRecord(value.litellm_params) ? value.litellm_params : undefined;
	const modelInfo = isRecord(value.model_info) ? value.model_info : undefined;
	return firstNonEmptyString(value.model_name, litellmParams?.model, modelInfo?.key, modelInfo?.id);
}

/**
 * Raw /v1/model/info entry: any object carrying at least one usable model
 * identifier among model_name, litellm_params.model, model_info.key, and
 * model_info.id. Field types beyond the identifier stay unvalidated: the
 * mapping step reads them defensively.
 */
export const rawModelInfoItemSchema = z
	.record(z.string(), z.unknown())
	.refine((value) => modelInfoId(value) !== undefined, { message: "no usable model identifier" });
