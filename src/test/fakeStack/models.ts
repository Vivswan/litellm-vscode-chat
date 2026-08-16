/**
 * The consolidated fake model catalog: realistic aliases over deliberately
 * unrecognizable fake- upstreams. This table drives BOTH the generated LiteLLM
 * proxy config and the docker suite's expectations, so the two cannot drift.
 *
 * Naming is load-bearing: LiteLLM enriches /model/info from litellm_params.model
 * only, never from model_name, so realistic names live on the alias side while
 * every upstream id carries the fake- prefix that keeps it out of the price map.
 * Observed on v1.93: an entry with NO declared pricing comes back with
 * input/output_cost_per_token stamped to 0, so "no pricing" arrives as zero
 * pricing through the real proxy.
 *
 * The capability matrix is deliberate: every discovery axis has at least one
 * positive and one negative among the registered survivors. Discovery defaults a
 * MISSING supports_function_calling to TRUE, so the tools-negatives must EMIT
 * explicit false flags or the negative silently disappears.
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
	/**
	 * Emitted as one supports_<level>_reasoning_effort: true flag per level;
	 * omission emits no per-level flags at all, so the extension's picker menu
	 * falls back to its built-in level list.
	 */
	reasoningEffortLevels?: readonly string[];
}

export interface FakeModel {
	/** The model_name LiteLLM serves; what the host registers. */
	alias: string;
	capabilities: FakeModelCapabilities;
	/**
	 * More than one deployment makes the alias a LiteLLM load-balancing group.
	 * Pricing and capabilities are declared ONCE per model and emitted identically
	 * on every deployment, because discovery merges deployments and any
	 * disagreement would silently null the merged value.
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
		// (reachable: 1M declared input) so the long-context tier synthesis and
		// display run end to end against a real proxy.
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
		// Reasoning without tools: the tools-negative that still reasons, and the
		// reasoning_effort pass-through target. Its per-level flags make it the
		// server-declared-levels positive; the other reasoning models keep the
		// built-in list.
		alias: "deepseek-r2",
		capabilities: { tools: false, reasoning: true, reasoningEffortLevels: ["low", "medium", "high", "max"] },
		deployments: [{ upstreamModel: "fake-reasoner", maxInputTokens: 128000, maxOutputTokens: 32000 }],
		pricing: { inputCostPerToken: 6e-7, outputCostPerToken: 2.4e-6 },
	},
	{
		// Minimal registration: no declared limits (exercises the min(4096,
		// default) output cap through a real proxy) and no declared pricing, which
		// v1.93 stamps to zero costs in /model/info. Second explicit
		// tools-negative.
		alias: "llama-4-scout",
		capabilities: { tools: false },
		deployments: [{ upstreamModel: "fake-minimal" }],
	},
	{
		// Blocked: must never register. v1.93 forwards blocked: true verbatim in
		// /model/info while excluding the alias from /v1/models, so both discovery
		// paths get exercised.
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

/**
 * The designated playback target, exported so target-selection plumbing reads
 * one declaration. A catalog rename does NOT flow through automatically: the
 * lookup is by alias literal, so renaming the model throws here and the
 * maintainer updates this one literal. The docker suites' own alias and upstream
 * literals stay independent oracles and must NOT be derived from this.
 */
export const PLAYBACK_MODEL: { readonly alias: string } = (() => {
	const alias = "gpt-5.2-mini";
	const model = FAKE_MODELS.find((candidate) => candidate.alias === alias);
	if (model === undefined) {
		throw new Error(`Playback target "${alias}" is not in FAKE_MODELS; update PLAYBACK_MODEL's alias literal`);
	}
	if (model.blocked === true) {
		throw new Error(`Playback target "${alias}" is blocked, so it never registers; designate a survivor`);
	}
	// Single deployment is part of the designation: responses must not vary by
	// routing.
	if (model.deployments.length !== 1) {
		throw new Error(`Playback target "${alias}" must keep exactly one deployment, found ${model.deployments.length}`);
	}
	return { alias: model.alias };
})();
