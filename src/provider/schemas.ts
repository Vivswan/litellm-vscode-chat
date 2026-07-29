import { z } from "zod";

/**
 * Discovery payload schemas and the normalized model shapes they produce.
 * The schemas are deliberately lenient so a server sending extra or oddly
 * typed fields never loses a model: model-info entries parse per declared
 * field (a malformed value degrades to undefined), provider entries validate
 * only their name, and unknown keys pass through everywhere.
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
 * configuration). Only `provider` is validated on the wire; discovery
 * re-narrows the four base cost fields and authors the internal markers
 * (output_limit_source, long-context costs), and the remaining
 * fields are typed reads of the passed-through entry.
 */
export interface LiteLLMProvider {
	provider: string;
	status: string;
	/** Wire pass-throughs may carry null; supportsTools treats only an explicit false as a veto. */
	supports_tools?: boolean | null | undefined;
	context_length?: number | undefined;
	max_tokens?: number | null | undefined;
	max_input_tokens?: number | null | undefined;
	max_output_tokens?: number | null | undefined;
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
 * How a discovered model registers, decided by discovery and switched on by
 * registration:
 * - "deployment": a /v1/model/info entry (or several merged deployments of one
 *   model_name) with a single authoritative provider; registers once, with
 *   pricing.
 * - "bare": a /v1/models entry without provider data; registers once on
 *   defaults.
 * - "group": a providers-array entry; registers cheapest/fastest aggregates
 *   and per-provider entries (or one untooled base entry), so its providers
 *   list is non-empty by construction.
 */
export type ModelShape =
	| { readonly kind: "deployment"; readonly provider: LiteLLMProvider }
	| { readonly kind: "bare" }
	| { readonly kind: "group"; readonly providers: readonly [LiteLLMProvider, ...LiteLLMProvider[]] };

/**
 * Normalized model entry used internally after discovery. Both discovery
 * endpoints are narrowed and normalized into this shape; `shape` carries the
 * registration-relevant provider data.
 */
export interface LiteLLMModelItem {
	id: string;
	shape: ModelShape;
	architecture?: LiteLLMArchitecture | undefined;
}

/**
 * Whether a provider entry's capability data says the model can call tools.
 * Missing or null counts as supported - only an explicit false is a veto -
 * because pass-through entries rarely declare the flag and silently losing
 * tool calling is the worse failure. The one home of the
 * `supports_tools !== false` convention; supportsReasoningEffort in
 * modelConfiguration.ts explains why vetoes work this way.
 */
export function supportsTools(provider: LiteLLMProvider): boolean {
	return provider.supports_tools !== false;
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

/**
 * A declared field parses leniently: a malformed value degrades to undefined
 * instead of dropping the whole entry, preserving the never-lose-a-model rule
 * while keeping the reads downstream typed.
 */
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

/** Capability flags arrive as booleans, or an explicit null meaning unknown. */
const lenientFlag = lenient(z.boolean().nullable());
/** Token limits arrive as numbers or numeric strings; normalizePositiveNumber narrows them at mapping. */
const lenientLimit = lenient(z.union([z.number(), z.string()]).nullable());
/**
 * Per-token costs are JSON numbers; normalizeCostPerToken re-narrows sign and
 * finiteness at mapping. Long-context tiers arrive as threshold-suffixed
 * variants of the cost keys (e.g. input_cost_per_token_above_200k_tokens) and
 * are read dynamically from the loose pass-through, so they carry no
 * declarations here.
 */
const lenientCost = lenient(z.number().nullable());

const modelInfoFieldsSchema = z.looseObject({
	id: lenient(z.string()),
	key: lenient(z.string()),
	/** True when the proxy has paused this deployment; blocked deployments must not register. */
	blocked: lenientFlag,
	max_tokens: lenientLimit,
	max_input_tokens: lenientLimit,
	max_output_tokens: lenientLimit,
	litellm_provider: lenient(z.string()),
	supports_function_calling: lenientFlag,
	supports_tool_choice: lenientFlag,
	supports_vision: lenientFlag,
	supports_prompt_caching: lenientFlag,
	supports_response_schema: lenientFlag,
	supports_reasoning: lenientFlag,
	supports_pdf_input: lenientFlag,
	supports_audio_input: lenientFlag,
	supports_audio_output: lenientFlag,
	// Per-element leniency: a non-string member drops alone instead of
	// degrading the whole list to unknown.
	supported_openai_params: lenient(
		z
			.array(z.unknown())
			.transform((params) => params.filter((param): param is string => typeof param === "string"))
			.nullable()
	),
	input_cost_per_token: lenientCost,
	output_cost_per_token: lenientCost,
	cache_read_input_token_cost: lenientCost,
	cache_creation_input_token_cost: lenientCost,
});

/**
 * Raw /v1/model/info entry: any object carrying at least one usable model
 * identifier among model_name, litellm_params.model, model_info.key, and
 * model_info.id, in that documented priority order. The transform resolves
 * that identifier once and carries it as `modelId`, so the mapping step is
 * total; every other declared field degrades to undefined when malformed
 * rather than dropping the entry.
 */
export const rawModelInfoItemSchema = z
	.looseObject({
		model_name: lenient(z.string()),
		litellm_params: lenient(z.looseObject({ model: lenient(z.string()) })),
		model_info: lenient(modelInfoFieldsSchema),
	})
	.transform((item, ctx) => {
		const modelId = firstNonEmptyString(
			item.model_name,
			item.litellm_params?.model,
			item.model_info?.key,
			item.model_info?.id
		);
		if (modelId === undefined) {
			ctx.addIssue({ code: "custom", message: "no usable model identifier" });
			return z.NEVER;
		}
		return { ...item, modelId };
	});

/** LiteLLM model metadata entry from /v1/model/info, parsed and carrying its resolved model id. */
export type LiteLLMModelInfoItem = z.infer<typeof rawModelInfoItemSchema>;

/**
 * The declared model_info fields without looseObject's pass-through index
 * signature. Test builders type against this so a renamed field fails the
 * build instead of silently becoming an unexercised pass-through key.
 */
export type ModelInfoFields = Pick<
	z.infer<typeof modelInfoFieldsSchema>,
	keyof (typeof modelInfoFieldsSchema)["shape"]
>;
