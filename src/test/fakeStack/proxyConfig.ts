/**
 * Pure emission of the LiteLLM proxy config text for the local docker stack.
 * The source of truth is src/test/fakeStack/models.ts (the consolidated
 * aliases); the canned response library in src/test/scenarios.ts no longer
 * feeds the config - its shapes are addressed per request via the %play
 * command. No filesystem or environment access here: real-provider decisions
 * arrive through an injected env lookup, so the unit suite pins the emission
 * on every CI OS without docker. scripts/litellmConfig.ts wraps this with
 * the .env-aware lookup and the atomic write to docker/.generated/.
 */

import { COMMAND_SIGIL } from "./commands";
import type { FakeModel, FakeModelCapabilities, FakeModelPricing } from "./models";
import { FAKE_MODELS } from "./models";

const FAKE_API_BASE = "http://fake-openai:8080/v1";

const REAL_PROVIDERS: ReadonlyArray<{ prefix: string; envVar: string }> = [
	{ prefix: "openai", envVar: "OPENAI_API_KEY" },
	{ prefix: "anthropic", envVar: "ANTHROPIC_API_KEY" },
	{ prefix: "github", envVar: "GITHUB_API_KEY" },
];

export interface GenerateOptions {
	/**
	 * Emit wildcard routes for real providers whose API key is set, plus the
	 * opt-in bare "*" passthrough. The docker test orchestrator passes false
	 * so test config is byte-identical with and without local keys.
	 */
	realProviders: boolean;
}

/** Resolves an environment variable for wildcard decisions; "" means unset. */
export type EnvLookup = (name: string) => string;

/** Aliases are what a real deployment would name; dots allowed. */
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
/**
 * Upstream ids stay deliberately unrecognizable: the mandatory fake- prefix
 * keeps them out of LiteLLM's price map, which the phase-3a spike verified
 * is the only enrichment key (litellm_params.model, never model_name).
 */
const UPSTREAM_PATTERN = /^fake-[a-z0-9-]+$/;

/**
 * Plain decimal formatting, guarded on both ends. Below 5e-13 the toFixed(12)
 * rendering collapses to "0" and at 1e21 JS strings go exponential - but the
 * real reason zero and negatives are rejected too is that a zero cost in
 * FAKE_MODELS is far more likely a bug than intent: "no pricing" is spelled
 * by omitting the pricing object, never by writing 0.
 */
export function costLiteral(value: number): string {
	if (!Number.isFinite(value) || value < 5e-13 || value >= 1e21) {
		throw new Error(`Cost ${value} is outside the plain-decimal window [5e-13, 1e21)`);
	}
	return value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

/** Exhaustive: a new FakeModelPricing field fails to compile until it has a wire key. */
const PRICING_WIRE_KEYS: Readonly<Record<keyof FakeModelPricing, string>> = {
	inputCostPerToken: "input_cost_per_token",
	outputCostPerToken: "output_cost_per_token",
	cacheReadInputTokenCost: "cache_read_input_token_cost",
	cacheCreationInputTokenCost: "cache_creation_input_token_cost",
	inputCostPerTokenAbove200k: "input_cost_per_token_above_200k_tokens",
	outputCostPerTokenAbove200k: "output_cost_per_token_above_200k_tokens",
	cacheReadInputTokenCostAbove200k: "cache_read_input_token_cost_above_200k_tokens",
	cacheCreationInputTokenCostAbove200k: "cache_creation_input_token_cost_above_200k_tokens",
};

/**
 * Exhaustive for the same reason; tools is excluded because it is emitted
 * explicitly (true AND false - discovery defaults a missing flag to true, so
 * only an explicit false is a real tools-negative).
 */
const CAPABILITY_WIRE_KEYS: Readonly<Record<Exclude<keyof FakeModelCapabilities, "tools">, string>> = {
	vision: "supports_vision",
	pdfInput: "supports_pdf_input",
	reasoning: "supports_reasoning",
	promptCaching: "supports_prompt_caching",
	audioInput: "supports_audio_input",
	audioOutput: "supports_audio_output",
};

/**
 * model_info lines for one FAKE_MODELS deployment. Pricing and capability
 * flags come from the model's single shared declaration, so every deployment
 * of a load-balanced pair emits byte-identical values (discovery merges
 * through agreedCost and every-deployment-supports; disagreement would
 * silently null the merged result).
 */
function consolidatedInfoLines(model: FakeModel, deployment: FakeModel["deployments"][number]): string[] {
	const lines: string[] = [];
	if (deployment.maxInputTokens !== undefined) {
		lines.push(`      max_input_tokens: ${deployment.maxInputTokens}`);
	}
	if (deployment.maxOutputTokens !== undefined) {
		lines.push(
			`      max_output_tokens: ${deployment.maxOutputTokens}`,
			`      max_tokens: ${deployment.maxOutputTokens}`
		);
	}
	lines.push(
		`      supports_function_calling: ${model.capabilities.tools}`,
		`      supports_tool_choice: ${model.capabilities.tools}`
	);
	for (const [property, wireKey] of Object.entries(CAPABILITY_WIRE_KEYS) as Array<
		[Exclude<keyof FakeModelCapabilities, "tools">, string]
	>) {
		if (model.capabilities[property]) {
			lines.push(`      ${wireKey}: true`);
		}
	}
	for (const [property, wireKey] of Object.entries(PRICING_WIRE_KEYS) as Array<[keyof FakeModelPricing, string]>) {
		const value = model.pricing?.[property];
		if (value !== undefined) {
			lines.push(`      ${wireKey}: ${costLiteral(value)}`);
		}
	}
	if (model.blocked) {
		lines.push("      blocked: true");
	}
	return lines;
}

export function consolidatedModelEntry(model: FakeModel): string {
	if (!ALIAS_PATTERN.test(model.alias)) {
		throw new Error(`Alias "${model.alias}" must match ${ALIAS_PATTERN}`);
	}
	return model.deployments
		.map((deployment) => {
			if (!UPSTREAM_PATTERN.test(deployment.upstreamModel)) {
				throw new Error(`Upstream "${deployment.upstreamModel}" must match ${UPSTREAM_PATTERN}`);
			}
			return [
				`  - model_name: ${model.alias}`,
				"    litellm_params:",
				`      model: openai/${deployment.upstreamModel}`,
				`      api_base: ${FAKE_API_BASE}`,
				"      api_key: fake-key",
				"      # Forward params LiteLLM would otherwise reject for plain openai",
				"      # models; the extension's pass-through contract is under test.",
				'      allowed_openai_params: ["reasoning_effort", "verbosity"]',
				"    model_info:",
				...consolidatedInfoLines(model, deployment),
			].join("\n");
		})
		.join("\n\n");
}

/** Duplicate aliases would form silent unintended load-balancing groups; duplicate upstreams break %deployment's oracle. */
export function assertUniqueNames(models: readonly FakeModel[] = FAKE_MODELS): void {
	const aliases = new Set<string>();
	const upstreams = new Set<string>();
	for (const model of models) {
		if (aliases.has(model.alias)) {
			throw new Error(`Duplicate FAKE_MODELS alias "${model.alias}"`);
		}
		aliases.add(model.alias);
		for (const deployment of model.deployments) {
			if (upstreams.has(deployment.upstreamModel)) {
				throw new Error(`Duplicate FAKE_MODELS upstream "${deployment.upstreamModel}"`);
			}
			upstreams.add(deployment.upstreamModel);
		}
	}
}

// -- Assembly -----------------------------------------------------------------

function realProviderEntry(prefix: string, envVar: string): string {
	return [
		`  - model_name: ${prefix}/*`,
		"    litellm_params:",
		`      model: ${prefix}/*`,
		`      api_key: os.environ/${envVar}`,
	].join("\n");
}

function realProviderSection(envValue: EnvLookup): string[] {
	const entries = REAL_PROVIDERS.filter(({ envVar }) => envValue(envVar) !== "").map(({ prefix, envVar }) =>
		realProviderEntry(prefix, envVar)
	);
	if (envValue("LITELLM_WILDCARD_ALL") === "1") {
		entries.push(['  - model_name: "*"', "    litellm_params:", '      model: "*"'].join("\n"));
	}
	if (entries.length === 0) {
		return [];
	}
	return [
		"",
		"  # Real providers whose API key was set at generation time; keys arrive",
		"  # via .env through docker-compose.",
		...entries,
	];
}

export function generateConfig(options: GenerateOptions, envValue: EnvLookup = () => ""): string {
	assertUniqueNames();
	const consolidatedEntries = FAKE_MODELS.map(consolidatedModelEntry);

	return [
		"# Generated at stack startup by scripts/litellmConfig.ts; do not edit.",
		"# The source of truth is src/test/fakeStack/models.ts. Inspect the",
		"# output with:",
		"#   bun run generate-config",
		"",
		"model_list:",
		"  # Consolidated fake models served by the fake-openai container:",
		"  # realistic aliases over fake- upstreams, driven by",
		"  # src/test/fakeStack/models.ts. LiteLLM strips the openai/ prefix, so",
		"  # the backend receives the bare fake-* upstream id.",
		consolidatedEntries.join("\n\n"),
		...(options.realProviders ? realProviderSection(envValue) : []),
		"",
		"router_settings:",
		`  # The fake backend serves deliberate ${COMMAND_SIGIL}error:<status> responses; the`,
		"  # router's failure cooldown would otherwise sideline a model for",
		"  # seconds and poison unrelated tests. This applies to the optional",
		"  # real-provider wildcard routes too: they are single-deployment",
		"  # catch-alls, so a cooldown buys them nothing either. Some router",
		"  # versions read cooldown_time through a truthiness coalesce where 0",
		"  # falls back to the default, so allowed_fails is the load-bearing",
		"  # knob.",
		"  allowed_fails: 1000000",
		"  cooldown_time: 0",
		"",
		"general_settings:",
		"  master_key: os.environ/LITELLM_MASTER_KEY",
		"",
	].join("\n");
}
