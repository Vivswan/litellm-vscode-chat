import { z } from "zod";
import type { CostCapabilityField } from "../../shared/config/capabilityResolution";
import { consumedFieldsOfKind } from "../../shared/config/capabilityResolution";
import { recordFromKeys } from "../../shared/util/json";

/**
 * Discovery payload schemas and the normalized model shapes they produce. The schemas are deliberately lenient.
 *   model-info entries -> parse per declared field
 *   provider entries   -> validate only their name
 *   unknown keys       -> pass through everywhere
 *   long-context tiers -> LiteLLM reports them as `<wire field>_above_<N>k_tokens` keys, never under the tier's own
 *                         name; discovery reads them off the pass-through and authors the LONG_CONTEXT_COST_PREFIX
 *                         field
 */

/** Prefixes discovery's long-context tier of the wire cost field that follows it; never a key LiteLLM reports. */
export const LONG_CONTEXT_COST_PREFIX = "long_context_";

export type LongContextCostField = Extract<CostCapabilityField, `${typeof LONG_CONTEXT_COST_PREFIX}${string}`>;

/** A cost field LiteLLM reports directly under its own name. */
type WireCostField = Exclude<CostCapabilityField, LongContextCostField>;

export function isLongContextCostField(field: CostCapabilityField): field is LongContextCostField {
	return field.startsWith(LONG_CONTEXT_COST_PREFIX);
}

export const LONG_CONTEXT_COST_FIELDS: readonly LongContextCostField[] =
	consumedFieldsOfKind("cost").filter(isLongContextCostField);
export const WIRE_COST_FIELDS: readonly WireCostField[] = consumedFieldsOfKind("cost").filter(
	(field): field is WireCostField => !isLongContextCostField(field)
);

/**
 * The per-token cost fields as LiteLLM reports them and a provider entry carries them: null where a merged entry's
 * deployments disagree, which reads as absent. Registration converts them to the per-million display cost and the
 * capability baseline stores them as the server level; a plain record of effective values satisfies it too.
 */
export type PerTokenCosts = { [K in CostCapabilityField]?: number | null | undefined };

export type DeclaredPerTokenCosts = { [K in keyof PerTokenCosts]: number };

/**
 * A single underlying provider (e.g. together, groq) for a model: capability metadata read from the LiteLLM API - what
 * the model CAN do, not what we ask it to do. Only `provider` is validated on the wire; the rest are typed reads of
 * the passed-through entry, except the fields discovery narrows or authors (null is the one "unknown" it writes):
 *   the four token limits    -> normalizePositiveNumber at the mapping sites (numeric strings parse, null and junk
 *                               degrade to undefined), so downstream reads take positive numbers or undefined as-is
 *   the cost fields          -> the zero-pair no-pricing rule; the long-context tiers never pass through raw
 *   replay_reasoning_content -> authored from litellm_provider: true for a deepseek deployment, whose thinking mode
 *                               refuses a tool-carrying request unless every replayed assistant message carries
 *                               reasoning_content
 *   reasoning_effort_levels  -> authored: modelConfiguration's mirror of LiteLLM's resolver over this entry's own
 *                               flags; LiteLLMModelItem.reasoningEfforts (the proxy's own group resolution) outranks it
 */
export interface LiteLLMProvider extends PerTokenCosts {
	provider: string;

	status: string;

	supports_tools?: boolean | null | undefined;

	context_length?: number | undefined;

	max_tokens?: number | undefined;

	max_input_tokens?: number | undefined;

	max_output_tokens?: number | undefined;

	supports_prompt_caching?: boolean | null | undefined;

	supports_response_schema?: boolean | null | undefined;

	supports_reasoning?: boolean | null | undefined;

	supports_pdf_input?: boolean | null | undefined;

	replay_reasoning_content?: boolean | null | undefined;

	supported_openai_params?: string[] | null | undefined;

	reasoning_effort_levels?: string[] | null | undefined;
}

export interface LiteLLMArchitecture {
	input_modalities?: string[];
	output_modalities?: string[];
}

/**
 * Which limits some contributor reported; the capability baseline stores a limit only when its flag is on. `any` is
 * any of the three: the input limit is server-grounded whenever anything numeric was reported.
 */
interface ReportedLimits {
	readonly context: boolean;

	readonly input: boolean;

	readonly output: boolean;

	readonly any: boolean;
}

/**
 * The limits a registered entry advertises. `defaultMaxTokens` is the request's max_tokens when nothing configures
 * one: a declared limit is sent whole, while a floor fill is a guess, so requests stay under DEFAULT_MAX_TOKENS_CAP
 * and the advertised limit keeps the floor.
 */
export interface TokenConstraints {
	readonly maxOutputTokens: number;

	readonly defaultMaxTokens: number;

	readonly contextLength: number;

	readonly maxInputTokens: number;

	readonly reported: ReportedLimits;
}

/**
 * A merged deployment set's provider is the deployments' flag and cost merge; its limits are the collapse of every
 * deployment's own, which that merged record cannot express, so they ride beside it.
 */
export type ModelShape =
	| { readonly kind: "deployment"; readonly provider: LiteLLMProvider; readonly limits: TokenConstraints }
	| { readonly kind: "bare" }
	| { readonly kind: "group"; readonly providers: readonly [LiteLLMProvider, ...LiteLLMProvider[]] };

/**
 * One listed model after narrowing. `reasoningEfforts` is LiteLLM's own resolution of the Thinking Effort menu for
 * the model group (/model_group/info's supported_reasoning_efforts), carried on the item so every shape, the bare one
 * included, keeps it: a list is the menu, null is the proxy saying unknown, absent is a proxy that never served the
 * field (the per-provider reasoning_effort_levels then decide).
 */
export interface LiteLLMModelItem {
	id: string;

	shape: ModelShape;

	architecture?: LiteLLMArchitecture | undefined;

	reasoningEfforts?: readonly string[] | null | undefined;
}

/**
 * Missing or null counts as supported - only an explicit false is a veto - because pass-through entries rarely declare
 * the flag and silently losing tool calling is the worse failure. The one home of that convention.
 */
export function supportsTools(provider: LiteLLMProvider): boolean {
	return provider.supports_tools !== false;
}

/** The envelope both listing endpoints answer with; element contents are narrowed per entry below. */
export const dataEnvelopeSchema = z.looseObject({ data: z.array(z.unknown()) });

/** Element contents stay unvalidated; provider entries are narrowed one by one, so a malformed entry drops alone. */
export const rawModelItemSchema = z.looseObject({
	id: z.string(),
	providers: z.array(z.unknown()).optional(),
	architecture: z.unknown().optional(),
});

export type RawModelItem = z.infer<typeof rawModelItemSchema>;

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

/** A malformed value degrades to undefined instead of dropping the whole entry, keeping downstream reads typed. */
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

/** Capability flags arrive as booleans, or an explicit null meaning unknown. */
const lenientFlag = lenient(z.boolean().nullable());

/** Token limits arrive as numbers or numeric strings; normalizePositiveNumber narrows them at mapping. */
const lenientLimit = lenient(z.union([z.number(), z.string()]).nullable());

/** Per-token costs are JSON numbers; normalizeCostPerToken re-narrows sign and finiteness at mapping. */
const lenientCost = lenient(z.number().nullable());

/** The model_info fields discovery declares; unknown keys pass through, which is where the long-context tiers ride. */
const modelInfoFieldsSchema = z.looseObject({
	id: lenient(z.string()),
	key: lenient(z.string()),
	/** True when the proxy has paused this deployment; blocked deployments must not register. */
	blocked: lenientFlag,
	/**
	 * LiteLLM's endpoint discriminator.
	 *   Absent or unrecognized modes -> register as always
	 */
	mode: lenient(z.string()),
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
	// Per-element leniency: a non-string member drops alone instead of degrading the whole list to unknown.
	supported_openai_params: lenient(
		z
			.array(z.unknown())
			.transform((params) => params.filter((param): param is string => typeof param === "string"))
			.nullable()
	),
	...recordFromKeys(WIRE_COST_FIELDS, () => lenientCost),
});

/** The transform resolves it once as `modelId` so mapping is total. */
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

export type LiteLLMModelInfoItem = z.infer<typeof rawModelInfoItemSchema>;

/** One /model_group/info entry, narrowed to the two keys discovery reads. */
export const modelGroupInfoItemSchema = z.looseObject({
	model_group: z.string(),
	// LiteLLM's own resolution for the group: a list is the menu, null is the proxy saying it does not know, and an
	// absent key is a proxy from before the field existed (it degrades to undefined like a malformed value, so the
	// deployment flags decide).
	supported_reasoning_efforts: lenient(
		z
			.array(z.unknown())
			.transform((levels) => levels.filter((level): level is string => typeof level === "string"))
			.nullable()
	),
});

/**
 * The declared model_info fields without looseObject's index signature. Test builders type against this so a renamed
 * field fails the build instead of silently becoming an unexercised pass-through key.
 */
export type ModelInfoFields = Pick<
	z.infer<typeof modelInfoFieldsSchema>,
	keyof (typeof modelInfoFieldsSchema)["shape"]
>;
