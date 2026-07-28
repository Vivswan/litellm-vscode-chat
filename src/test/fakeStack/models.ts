/**
 * The consolidated fake model catalog: seven realistic aliases over
 * deliberately unrecognizable fake- upstreams. This table drives BOTH the
 * generated LiteLLM proxy config (scripts/litellmConfig.ts) and the docker
 * suite's expectations, so the config and the tests cannot drift apart.
 *
 * Naming is load-bearing (verified by the phase-3a spike): LiteLLM enriches
 * /model/info from litellm_params.model only, never from model_name, so
 * realistic names live on the alias side while every upstream id carries the
 * fake- prefix that keeps it out of the price map. The spike also verified
 * that custom tier keys, explicit-false tool flags, and blocked: true all
 * forward verbatim through /v1/model/info on v1.93 - and that entries with
 * NO declared pricing come back with input/output_cost_per_token stamped to
 * 0, so "no pricing" arrives as zero pricing through the real proxy.
 *
 * The capability matrix is deliberate: every discovery axis has at least one
 * positive and one negative among the registered survivors. tools is
 * three-valued in model_info terms - discovery defaults a MISSING
 * supports_function_calling to TRUE, so the tools-negatives (deepseek-r2,
 * llama-4-scout) must EMIT explicit false flags or the negative silently
 * disappears; the boolean here is emitted either way.
 */

export interface FakeModelPricing {
	/** Wire key: input_cost_per_token. */
	inputCostPerToken: number;
	/** Wire key: output_cost_per_token. */
	outputCostPerToken: number;
	/** Wire key: cache_read_input_token_cost. */
	cacheReadInputTokenCost?: number;
	/** Wire key: cache_creation_input_token_cost. */
	cacheCreationInputTokenCost?: number;
	/** Wire key: input_cost_per_token_above_200k_tokens. */
	inputCostPerTokenAbove200k?: number;
	/** Wire key: output_cost_per_token_above_200k_tokens. */
	outputCostPerTokenAbove200k?: number;
	/** Wire key: cache_read_input_token_cost_above_200k_tokens. */
	cacheReadInputTokenCostAbove200k?: number;
	/** Wire key: cache_creation_input_token_cost_above_200k_tokens. */
	cacheCreationInputTokenCostAbove200k?: number;
}

interface FakeDeployment {
	/** Bare upstream id; the generator emits model: openai/<upstreamModel>. */
	upstreamModel: string;
	/** Omitted limits are omitted from model_info (llama-4-scout's shape). */
	maxInputTokens?: number;
	maxOutputTokens?: number;
}

export interface FakeModelCapabilities {
	/**
	 * Always emitted explicitly, true or false: discovery treats a missing
	 * tools flag as true, so only an explicit false is a real negative.
	 */
	tools: boolean;
	/** The rest are emitted only when true; omission is the negative. */
	vision?: boolean;
	pdfInput?: boolean;
	reasoning?: boolean;
	promptCaching?: boolean;
	audioInput?: boolean;
	audioOutput?: boolean;
}

export interface FakeModel {
	/** The model_name LiteLLM serves; what the host registers. */
	alias: string;
	capabilities: FakeModelCapabilities;
	/**
	 * More than one deployment makes the alias a LiteLLM load-balancing
	 * group. Pricing and capabilities are declared ONCE per model and emitted
	 * identically on every deployment: discovery merges deployments through
	 * agreedCost and every-deployment-supports, so any disagreement would
	 * silently null the merged value.
	 */
	deployments: readonly FakeDeployment[];
	pricing?: FakeModelPricing;
	/** Emitted as model_info blocked: true; the model must never register. */
	blocked?: boolean;
}

/** Flat pricing shared byte-identically by both gpt-5.2 deployments (the merge trap). */
const GPT_52_PRICING: FakeModelPricing = { inputCostPerToken: 1.25e-6, outputCostPerToken: 1e-5 };

export const FAKE_MODELS: readonly FakeModel[] = [
	{
		// The flagship: full capabilities, cache costs, and the above-200k tier
		// (reachable: 1M declared input) so the long_context_* synthesis and
		// tier display run end to end against a real proxy.
		alias: "claude-opus-4-5",
		capabilities: { tools: true, vision: true, pdfInput: true, reasoning: true, promptCaching: true },
		deployments: [{ upstreamModel: "fake-flagship", maxInputTokens: 1000000, maxOutputTokens: 64000 }],
		pricing: {
			inputCostPerToken: 5e-6,
			outputCostPerToken: 2.5e-5,
			cacheReadInputTokenCost: 5e-7,
			cacheCreationInputTokenCost: 6.25e-6,
			inputCostPerTokenAbove200k: 1e-5,
			outputCostPerTokenAbove200k: 3.75e-5,
			cacheReadInputTokenCostAbove200k: 1e-6,
			cacheCreationInputTokenCostAbove200k: 1.25e-5,
		},
	},
	{
		// The load-balanced pair: two deployments with different declared
		// limits, merged to the smaller bounds by discovery. Tools-only, so it
		// is also the vision-, reasoning-, and caching-negative that still
		// carries tools.
		alias: "gpt-5.2",
		capabilities: { tools: true },
		deployments: [
			{ upstreamModel: "fake-balanced-a", maxInputTokens: 128000, maxOutputTokens: 16000 },
			{ upstreamModel: "fake-balanced-b", maxInputTokens: 64000, maxOutputTokens: 8000 },
		],
		pricing: GPT_52_PRICING,
	},
	{
		// The default target for %play playback, the stream fuzzer, and the
		// multi-turn suite: reasoning on (the fuzzer emits reasoning deltas),
		// caching off (cache anchors would vary every fuzz request), single
		// deployment (responses cannot vary by routing).
		alias: "gpt-5.2-mini",
		capabilities: { tools: true, vision: true, pdfInput: true, reasoning: true },
		deployments: [{ upstreamModel: "fake-mini", maxInputTokens: 128000, maxOutputTokens: 16000 }],
		pricing: { inputCostPerToken: 2.5e-7, outputCostPerToken: 2e-6 },
	},
	{
		// The omni model: bidirectional media flags in LiteLLM's real
		// vocabulary, tolerated-not-consumed by discovery. Deliberately not a
		// second flagship: no reasoning, no caching, no tier.
		alias: "gpt-5.2-omni",
		capabilities: { tools: true, vision: true, pdfInput: true, audioInput: true, audioOutput: true },
		deployments: [{ upstreamModel: "fake-omni", maxInputTokens: 200000, maxOutputTokens: 32000 }],
		pricing: { inputCostPerToken: 2.5e-6, outputCostPerToken: 1e-5 },
	},
	{
		// Reasoning without tools: the tools-negative that still reasons;
		// reasoning_effort pass-through target.
		alias: "deepseek-r2",
		capabilities: { tools: false, reasoning: true },
		deployments: [{ upstreamModel: "fake-reasoner", maxInputTokens: 128000, maxOutputTokens: 32000 }],
		pricing: { inputCostPerToken: 6e-7, outputCostPerToken: 2.4e-6 },
	},
	{
		// Minimal registration: no declared limits (exercises the min(4096,
		// default) output cap through a real proxy) and no declared pricing
		// (which v1.93 stamps to zero costs in /model/info; the absent-pricing
		// display path stays unit-covered). Second explicit tools-negative.
		alias: "llama-4-scout",
		capabilities: { tools: false },
		deployments: [{ upstreamModel: "fake-minimal" }],
	},
	{
		// Blocked: must never register. A decommissioned legacy model is
		// exactly what real deployments block, hence the deliberately old
		// name. The spike observed v1.93 forwards blocked: true verbatim in
		// /model/info while excluding the alias from /v1/models, so both
		// discovery paths get exercised.
		alias: "gpt-4-turbo",
		capabilities: { tools: true },
		deployments: [{ upstreamModel: "fake-blocked" }],
		blocked: true,
	},
];

/** Upstream ids the fake backend serves; blocked deployments are excluded, as real discovery never reaches them. */
export const FAKE_MODEL_UPSTREAM_IDS: readonly string[] = FAKE_MODELS.filter((model) => !model.blocked).flatMap(
	(model) => model.deployments.map((deployment) => deployment.upstreamModel)
);
