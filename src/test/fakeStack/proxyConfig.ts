/**
 * Pure emission of the LiteLLM proxy config text for the local docker stack.
 * The source of truth is src/test/fakeStack/models.ts (the consolidated
 * aliases); the canned response library in src/test/scenarios.ts no longer
 * feeds the config - its shapes are addressed per request via the %play
 * command. No filesystem or environment access here: real-provider decisions
 * arrive through an injected env lookup, so the unit suite pins the emission
 * on every CI OS without docker. scripts/stack/litellmConfig.ts wraps this with
 * the .env-aware lookup and the atomic write to docker/.generated/.
 */

import { COMMAND_SIGIL } from "./commands";
import type { FakeModel, FakeModelCapabilities, FakeModelPricing } from "./models";
import { FAKE_MODELS } from "./models";

/**
 * The container-internal port the fake OpenAI backend binds.
 * scripts/stack/fake-openai-server.ts defaults its PORT env to this number, and
 * docker-compose.yml restates it three times (the service's PORT env, the
 * host mapping's container side, the healthcheck URL); stackDrift.test.ts
 * pins those compose copies.
 */
export const FAKE_BACKEND_PORT = 8080;

const FAKE_API_BASE = `http://fake-openai:${FAKE_BACKEND_PORT}/v1`;

/**
 * The real-provider wildcard routes the generated config may emit, keyed by
 * the API-key variable each route reads via os.environ inside the container.
 * docker-compose.yml must pass every envVar through to the litellm service
 * and .env.example must template it; stackDrift.test.ts pins both.
 * (github was a member until GitHub Models was retired on 2026-07-30.)
 */
export const REAL_PROVIDERS: ReadonlyArray<{ prefix: string; envVar: string }> = [
	{ prefix: "openai", envVar: "OPENAI_API_KEY" },
	{ prefix: "anthropic", envVar: "ANTHROPIC_API_KEY" },
];

export type GenerateOptions =
	/**
	 * The deterministic test mode: no wildcard routes, no Copilot entries, no
	 * network anywhere near generation. The docker test orchestrator uses
	 * this so local keys and logins can never change test results.
	 */
	| { realProviders: false }
	/**
	 * The real mode carries its Copilot catalog explicitly (fetched by the
	 * caller; [] when no login is seeded), so a test-mode call cannot smuggle
	 * models in and a real-mode call cannot forget to decide.
	 */
	| { realProviders: true; copilotModels: readonly CopilotModel[] };

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

/** The real-provider model_list entries, split by what gates the expansion flag. */
interface RealProviderEntries {
	entries: string[];
	/** Entries from keyed REAL_PROVIDERS rows; the bare "*" passthrough is not one. */
	keyed: number;
}

function realProviderEntries(envValue: EnvLookup): RealProviderEntries {
	const entries = REAL_PROVIDERS.filter(({ envVar }) => envValue(envVar) !== "").map(({ prefix, envVar }) =>
		realProviderEntry(prefix, envVar)
	);
	const keyed = entries.length;
	if (envValue("LITELLM_WILDCARD_ALL") === "1") {
		entries.push(['  - model_name: "*"', "    litellm_params:", '      model: "*"'].join("\n"));
	}
	return { entries, keyed };
}

function realProviderSection(entries: string[]): string[] {
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

/**
 * A wildcard route advertises only its literal pattern; check_provider_endpoint
 * makes LiteLLM query the keyed provider's live model endpoint and expand the
 * wildcard - on /v1/models only, so it serves direct API consumers of the
 * proxy. The extension's picker reads /v1/model/info, where the wildcard
 * still appears as its literal entry. Gated on KEYED routes: the bare "*"
 * passthrough has no provider endpoint to expand, the fake catalog needs no
 * expansion, and the test config must not depend on provider reachability.
 */
function expansionSection(keyedEntries: number): string[] {
	if (keyedEntries === 0) {
		return [];
	}
	return ["litellm_settings:", "  check_provider_endpoint: true", ""];
}

/**
 * Where the GitHub Copilot device-flow token lives on the host, relative to
 * the repo root (seeded by `bun run copilot-login`). docker-compose.yml
 * restates it in the litellm mount, the fake-openai masking volume, and the
 * GITHUB_COPILOT_TOKEN_DIR env; stackDrift.test.ts pins those copies.
 */
export const COPILOT_TOKEN_DIR = "docker/.copilot-token";

/** One model from the GitHub Copilot catalog, as fetched at generation time. */
export interface CopilotModel {
	readonly id: string;
	/** The catalog's capabilities.type: "chat", "embeddings", ... */
	readonly type: string;
	/** The catalog's supported_endpoints; empty means the default /chat/completions. */
	readonly supportedEndpoints: readonly string[];
}

/** Copilot ids are emitted into YAML unquoted, so gate them hard. */
const COPILOT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** The outcome of parsing a raw Copilot catalog payload at the boundary. */
export interface CopilotCatalogParse {
	models: CopilotModel[];
	/** Entries dropped for an unusable or unsafe id; names only, never secrets. */
	rejected: string[];
}

/**
 * Boundary parser for the Copilot /models payload: every malformed entry is
 * dropped into `rejected` instead of thrown, so no catalog drift can abort
 * config generation - the emission below stays total for whatever this
 * returns. Unknown shapes degrade to the chat defaults.
 */
export function parseCopilotCatalog(payload: unknown): CopilotCatalogParse {
	const data = (payload as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) {
		return { models: [], rejected: [] };
	}
	const models: CopilotModel[] = [];
	const rejected: string[] = [];
	for (const raw of data as Array<Record<string, unknown>>) {
		const id = raw?.id;
		if (typeof id !== "string" || !COPILOT_ID_PATTERN.test(id)) {
			rejected.push(typeof id === "string" ? id : "<non-string id>");
			continue;
		}
		const capabilities = raw.capabilities as { type?: unknown } | undefined;
		const endpoints = raw.supported_endpoints;
		models.push({
			id,
			type: typeof capabilities?.type === "string" ? capabilities.type : "chat",
			supportedEndpoints: Array.isArray(endpoints)
				? endpoints.filter((endpoint): endpoint is string => typeof endpoint === "string")
				: [],
		});
	}
	return { models, rejected };
}

/**
 * LiteLLM's model_info mode for a catalog entry. Embeddings models declare
 * themselves via type; chat-vs-responses comes from supported_endpoints
 * (an empty list means the default /chat/completions), because the catalog
 * reports type "chat" even for models the API only serves via /responses.
 */
function copilotMode(model: CopilotModel): string | undefined {
	if (model.type === "embeddings") {
		return "embedding";
	}
	if (model.supportedEndpoints.includes("/responses") && !model.supportedEndpoints.includes("/chat/completions")) {
		return "responses";
	}
	return undefined;
}

/**
 * Explicit github_copilot/<id> routes for every model the live Copilot
 * catalog reported when the config was generated. Auth is not in the entry:
 * the github_copilot provider reads its device-flow token from
 * GITHUB_COPILOT_TOKEN_DIR inside the container.
 */
function copilotSection(models: readonly CopilotModel[]): string[] {
	if (models.length === 0) {
		return [];
	}
	const entries = models.map((model) => {
		if (!COPILOT_ID_PATTERN.test(model.id)) {
			throw new Error(`Copilot model id "${model.id}" must match ${COPILOT_ID_PATTERN}`);
		}
		const lines = [
			`  - model_name: github_copilot/${model.id}`,
			"    litellm_params:",
			`      model: github_copilot/${model.id}`,
		];
		const mode = copilotMode(model);
		if (mode !== undefined) {
			lines.push("    model_info:", `      mode: ${mode}`);
		}
		return lines.join("\n");
	});
	return [
		"",
		"  # GitHub Copilot models, discovered from the live catalog at generation",
		"  # time (bun run copilot-login seeds the token; no token, no entries).",
		...entries,
	];
}

export function generateConfig(options: GenerateOptions, envValue: EnvLookup = () => ""): string {
	assertUniqueNames();
	const consolidatedEntries = FAKE_MODELS.map(consolidatedModelEntry);
	const realEntries = options.realProviders ? realProviderEntries(envValue) : { entries: [], keyed: 0 };
	const copilotModels = options.realProviders ? options.copilotModels : [];

	return [
		"# Generated at stack startup by scripts/stack/litellmConfig.ts; do not edit.",
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
		...realProviderSection(realEntries.entries),
		...copilotSection(copilotModels),
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
		...expansionSection(realEntries.keyed),
		"general_settings:",
		"  master_key: os.environ/LITELLM_MASTER_KEY",
		"",
	].join("\n");
}
