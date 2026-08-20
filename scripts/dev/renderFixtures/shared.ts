/**
 * Shared builders for the render fixtures: one rich, protocol-typed
 * DashboardState covering the screenshot matrix, with per-fixture overrides.
 * Values are invented but realistic; nothing here is secret material.
 */
import type {
	DashboardModel,
	DashboardServer,
	DashboardState,
	DashboardUsage,
	ResolvedModelsView,
	ServerSecretsView,
} from "../../../src/dashboard/viewModels.ts";
import type { SecretFieldId, SecretLocation } from "../../../src/shared/serverEntry.ts";
import { RENDER_EPOCH_MS } from "../renderClock.ts";

// The harness freezes the page's clock to the same instant, so every
// relative and absolute time label renders identically on every run.
const NOW = RENDER_EPOCH_MS;

export function minutesAgoIso(minutes: number): string {
	return new Date(NOW - minutes * 60_000).toISOString();
}

export function minutesAgoMs(minutes: number): number {
	return NOW - minutes * 60_000;
}

/** Proven secret locations (the engine's post-pass truth) with the given fields overridden. */
export function provenSecrets(overrides: Partial<Record<SecretFieldId, SecretLocation>> = {}): ServerSecretsView {
	return {
		kind: "proven",
		locations: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none", ...overrides },
	};
}

export const NO_SECRETS: ServerSecretsView = provenSecrets();

export const PROD_SERVER: DashboardServer = {
	origin: "declared",
	label: "prod",
	baseUrl: "https://litellm.example.com",
	servedModelCount: 3,
	credentials: "present",
	hasOAuth: false,
	state: "ok",
	lastChecked: minutesAgoIso(2),
	config: {
		secrets: provenSecrets({ apiKey: "secure" }),
		headers: { "x-routing-env": "prod" },
		modelParameters: { "gpt-5*": { temperature: 0.2, _force: ["temperature"] } },
		budget: 50,
	},
};

export const GATEWAY_SERVER: DashboardServer = {
	origin: "declared",
	label: "gateway",
	baseUrl: "https://gateway.internal",
	servedModelCount: 1,
	credentials: "absent",
	hasOAuth: true,
	state: "error",
	error: "Model listing failed: 404",
	errorEnglish: "Model listing failed: 404",
	expected: true,
	declaredModelCount: 1,
	lastChecked: minutesAgoIso(9),
	config: {
		secrets: provenSecrets({ oauthClientSecret: "secure", virtualKeyValue: "secure" }),
		oauthTokenUrl: "https://idp.example.com/oauth2/token",
		oauthClientId: "litellm-vscode",
		virtualKeyHeader: "x-litellm-api-key",
		expectedFailures: ["modelListing", "modelInfo"],
		declaredModels: ["deepseek-r1"],
	},
	// No nothing-declared notice: the declared model IS serving (served 1,
	// declared 1), and the builder only flags an expected failure serving
	// nothing at all.
};

export const MISCONFIGURED_SERVER: DashboardServer = {
	origin: "misconfigured",
	label: "broken",
	baseUrl: "https://broken.example.com",
	servedModelCount: 0,
	credentials: "absent",
	hasOAuth: false,
	state: "error",
	error: "misconfigured entry; not used until its configuration is fixed",
	errorEnglish: "misconfigured entry; not used until its configuration is fixed",
	problems: ["has auth.apiKey beside auth.oauth; move it to auth.oauth.apiKey"],
};

export const EXTERNAL_SERVER: DashboardServer = {
	origin: "external",
	label: "Copilot proxy",
	baseUrl: "http://localhost:4000",
	servedModelCount: 2,
	credentials: "present",
	// The host report carries the credential kind for external groups too; this
	// row is the matrix's external-OAuth specimen.
	hasOAuth: true,
	state: "ok",
	lastChecked: minutesAgoIso(5),
	adoptHandle: "handle-fixture",
	hideable: true,
};

// The external-API-key specimen: "API key" + "external" is the widest badge
// pair a row can produce, so the overflow sweep must keep measuring it.
export const EXTERNAL_KEYED_SERVER: DashboardServer = {
	origin: "external",
	label: "Legacy proxy",
	baseUrl: "http://10.0.0.7:4000",
	servedModelCount: 1,
	credentials: "present",
	hasOAuth: false,
	state: "ok",
	lastChecked: minutesAgoIso(12),
	adoptHandle: "handle-fixture-keyed",
	hideable: true,
};

function model(overrides: Partial<DashboardModel> & Pick<DashboardModel, "id" | "name">): DashboardModel {
	return {
		rawId: overrides.id,
		scopeKey: "s-prod",
		family: "gpt",
		serverLabel: "prod",
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		outputLimitDeclared: true,
		toolCalling: true,
		imageInput: false,
		promptCaching: false,
		reasoning: false,
		...overrides,
	};
}

export const MODELS: readonly DashboardModel[] = [
	model({ id: "gpt-5.6", name: "GPT-5.6", inputCost: 1.75, outputCost: 12, reasoning: true, imageInput: true }),
	model({ id: "gpt-5-mini", name: "GPT-5 mini", inputCost: 0.3, outputCost: 1.2 }),
	model({
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		family: "claude",
		inputCost: 3,
		outputCost: 15,
		promptCaching: true,
		imageInput: true,
	}),
	model({
		id: "deepseek-r1",
		name: "DeepSeek R1",
		family: "deepseek",
		serverLabel: "gateway",
		scopeKey: "s-gw",
		outputLimitDeclared: false,
		reasoning: true,
		declared: true,
	}),
];

export const USAGE: DashboardUsage = {
	servers: [
		{
			kind: "usage",
			label: "prod",
			baseUrl: "https://litellm.example.com",
			fresh: true,
			keyInfo: { kind: "ok" },
			dailyActivity: { kind: "ok" },
			lastUpdatedAt: minutesAgoMs(1),
			spend: 21.13,
			effectiveBudget: 50,
			entryBudget: 50,
			keyBudget: 100,
			budgetSource: "entry",
			spentFraction: 0.42,
			budgetResetAt: NOW + 12 * 86_400_000,
			requests: { total: 1841, successRate: 0.984, cacheHitRate: 0.37 },
		},
		{
			kind: "usage",
			label: "gateway",
			baseUrl: "https://gateway.internal",
			fresh: true,
			keyInfo: { kind: "ok" },
			dailyActivity: { kind: "unavailable", reason: "unsupported", status: 404 },
			lastUpdatedAt: minutesAgoMs(3),
			spend: 43.5,
			effectiveBudget: 50,
			keyBudget: 50,
			budgetSource: "key",
			spentFraction: 0.87,
		},
		{
			kind: "usage",
			label: "research",
			baseUrl: "https://research.example.com",
			fresh: false,
			keyInfo: { kind: "error", classification: "timeout" },
			dailyActivity: { kind: "ok" },
			lastUpdatedAt: minutesAgoMs(25),
			spend: 28,
			effectiveBudget: 25,
			keyBudget: 25,
			budgetSource: "key",
			spentFraction: 1.12,
			budgetResetAt: NOW + 86_400_000,
			requests: { total: 96, successRate: 0.91 },
		},
		{
			kind: "usage",
			label: "sandbox",
			baseUrl: "http://localhost:4000",
			fresh: true,
			keyInfo: { kind: "ok" },
			dailyActivity: { kind: "unknown" },
			lastUpdatedAt: minutesAgoMs(2),
			spend: 3.07,
			budgetSource: "none",
		},
		{
			kind: "forbidden",
			label: "locked-down",
			baseUrl: "https://locked.example.com",
			keyInfo: { kind: "unavailable", reason: "forbidden", status: 403 },
			dailyActivity: { kind: "unavailable", reason: "forbidden", status: 403 },
		},
	],
	thresholds: [0.8, 0.95],
	pollIntervalMs: 300000,
	discoveryTimeoutMs: 30000,
	refreshing: false,
	refreshingExplicitly: false,
	generatedAt: NOW,
};

/**
 * A realistic full supported_openai_params report (27 entries, the shape a
 * LiteLLM /model/info answer carries for an Anthropic-backed route): the
 * worst case the params-list rendering must stay readable against.
 */
export const OPENAI_PARAMS_FULL: readonly string[] = [
	"frequency_penalty",
	"logit_bias",
	"logprobs",
	"top_logprobs",
	"max_tokens",
	"max_completion_tokens",
	"modalities",
	"prediction",
	"n",
	"presence_penalty",
	"seed",
	"stop",
	"stream",
	"stream_options",
	"temperature",
	"top_p",
	"tools",
	"tool_choice",
	"function_call",
	"functions",
	"parallel_tool_calls",
	"audio",
	"web_search_options",
	"response_format",
	"user",
	"reasoning_effort",
	"thinking",
];

/**
 * The worst-case effective-capabilities bag both model-inspector fixtures
 * render: the core seven, the three consumed booleans, the FULL eight-field cost
 * family with sub-micro per-token values (the scientific-notation regression
 * case), the 27-element params list, and one unknown extra - with mixed
 * provenance across every level so the Source column shows its whole vocabulary.
 */
export function worstCaseCapabilityFields(): Record<string, unknown> {
	return {
		context_length: {
			value: 272000,
			level: "global",
			key: "gpt-5*",
			shadowed: [{ level: "server", value: 128000 }],
		},
		max_input_tokens: { value: 272000, level: "derived", shadowed: [] },
		max_output_tokens: { value: 16384, level: "server", shadowed: [] },
		supports_function_calling: { value: true, level: "server", shadowed: [] },
		supports_vision: { value: true, level: "entry", key: "gpt-5.6", shadowed: [] },
		supports_reasoning: { value: true, level: "global-fallback", key: "*", shadowed: [] },
		supports_audio_input: { value: false, level: "floor", shadowed: [] },
		supports_prompt_caching: { value: true, level: "server", shadowed: [] },
		supports_pdf_input: { value: true, level: "catalog", key: "anthropic/claude-sonnet-4", shadowed: [] },
		supports_response_schema: { value: true, level: "directive", key: "anthropic/claude-sonnet-4", shadowed: [] },
		input_cost_per_token: { value: 0.000005, level: "server", shadowed: [] },
		output_cost_per_token: { value: 0.000025, level: "server", shadowed: [] },
		cache_read_input_token_cost: { value: 5e-7, level: "server", shadowed: [] },
		cache_creation_input_token_cost: {
			value: 6.25e-6,
			level: "entry",
			key: "gpt-5.6",
			shadowed: [{ level: "server", value: 3.75e-6 }],
		},
		long_context_input_cost_per_token: { value: 0.00001, level: "global", key: "gpt-5*", shadowed: [] },
		long_context_output_cost_per_token: { value: 3.75e-5, level: "server", shadowed: [] },
		long_context_cache_read_input_token_cost: { value: 1e-6, level: "global-fallback", key: "*", shadowed: [] },
		long_context_cache_creation_input_token_cost: { value: 1.25e-5, level: "server", shadowed: [] },
		supported_openai_params: { value: [...OPENAI_PARAMS_FULL], level: "server", shadowed: [] },
		supports_web_search: { value: true, level: "global", key: "gpt-5*", shadowed: [] },
	};
}

/**
 * The same worst case as a RAW record value, for the matcher-editor fixtures:
 * the full eight-field Anthropic-style cost family (sub-micro scientific
 * values included) plus the 27-entry params list - the densest record a
 * record editor has to lay out. One definition, so "full density" cannot
 * quietly mean different things in different fixtures.
 */
export function worstCaseRecordFields(): Record<string, unknown> {
	return {
		input_cost_per_token: 0.000005,
		output_cost_per_token: 0.000025,
		cache_read_input_token_cost: 5e-7,
		cache_creation_input_token_cost: 6.25e-6,
		long_context_input_cost_per_token: 0.00001,
		long_context_output_cost_per_token: 3.75e-5,
		long_context_cache_read_input_token_cost: 1e-6,
		long_context_cache_creation_input_token_cost: 1.25e-5,
		supported_openai_params: [...OPENAI_PARAMS_FULL],
	};
}

/**
 * A genuinely long matcher key, the length real users write: the longest key
 * the base state carries is the 13-character deepseek regex, which says
 * nothing about how the editors survive a route-family regex spanning
 * providers and vendor prefixes.
 */
export const LONG_MATCHER_KEY =
	"/^(openrouter|github_copilot)\\/(anthropic|google)[./](claude|gemini)-[0-9][\\w.-]*(-thinking)?$/i";

export const RESOLVED_VIEW: ResolvedModelsView = {
	trees: [
		{
			kind: "parameters",
			layer: "global",
			roots: [
				{
					key: "*",
					fields: [
						{ name: "temperature", valueText: "0.7", inheritable: true, forced: false, fallback: false },
						{ name: "top_p", valueText: "0.9", inheritable: true, forced: false, fallback: false },
					],
					barrier: false,
					children: [
						{
							key: "gpt-5*",
							fields: [{ name: "temperature", valueText: "0.3", inheritable: true, forced: true, fallback: false }],
							barrier: true,
							inheritFrom: "false",
							children: [
								{
									key: "gpt-5.6",
									fields: [],
									barrier: false,
									children: [],
									models: [{ id: "gpt-5.6", resolvedText: "temperature 0.3, max_tokens 8192" }],
								},
							],
							models: [{ id: "gpt-5-mini", resolvedText: "temperature 0.3" }],
						},
						{
							key: "claude-sonnet-4",
							fields: [{ name: "temperature", valueText: "1", inheritable: false, forced: false, fallback: false }],
							barrier: false,
							children: [],
							models: [{ id: "claude-sonnet-4", resolvedText: "temperature 1, top_p 0.9" }],
						},
					],
					models: [],
				},
			],
			unmatchedModelIds: ["deepseek-r1"],
			invalidKeys: ["gpt*5"],
		},
		{
			kind: "capabilities",
			layer: "entry",
			entryLabel: "gateway",
			roots: [
				{
					key: "deepseek-r1",
					fields: [
						{ name: "supports_reasoning", valueText: "true", inheritable: false, forced: false, fallback: false },
						{ name: "context_length", valueText: "131072", inheritable: false, forced: false, fallback: true },
					],
					barrier: false,
					children: [],
					models: [{ id: "deepseek-r1", resolvedText: "supports_reasoning true, context_length 131072" }],
				},
			],
			unmatchedModelIds: [],
			invalidKeys: [],
		},
	],
	rows: [
		{
			serverLabel: "prod",
			rawId: "claude-sonnet-4",
			scopeKey: "s-prod",
			matchedKeys: ["*", "claude-sonnet-4"],
			parameters: [{ name: "temperature", valueText: "1", layer: "global", key: "claude-sonnet-4" }],
			capabilities: [
				// A catalog-directive model: the token facts fill from the
				// _openrouter_model directive while the UNIFORM server pricing
				// collapses under one source badge.
				{ name: "context_length", valueText: "200000", level: "directive", key: "anthropic/claude-sonnet-4" },
				{ name: "max_output_tokens", valueText: "64000", level: "directive", key: "anthropic/claude-sonnet-4" },
				{ name: "supports_prompt_caching", valueText: "true", level: "server" },
				{ name: "input_cost_per_token", valueText: "0.000003", level: "server" },
				{ name: "output_cost_per_token", valueText: "0.000015", level: "server" },
				{ name: "cache_read_input_token_cost", valueText: "3e-7", level: "server" },
				{ name: "cache_creation_input_token_cost", valueText: "0.00000375", level: "server" },
				{ name: "supported_openai_params", valueText: JSON.stringify(OPENAI_PARAMS_FULL), level: "server" },
			],
		},
		{
			serverLabel: "prod",
			rawId: "gpt-5.6",
			scopeKey: "s-prod",
			matchedKeys: ["*", "gpt-5*", "gpt-5.6"],
			parameters: [
				{
					name: "temperature",
					valueText: "0.3",
					layer: "global",
					key: "gpt-5*",
					inheritedBy: "gpt-5.6",
					forced: true,
				},
				{ name: "max_tokens", valueText: "8192", layer: "entry", key: "gpt-5.6" },
			],
			capabilities: [
				{ name: "context_length", valueText: "272000", level: "server" },
				{ name: "max_output_tokens", valueText: "16384", level: "server" },
				{ name: "supports_reasoning", valueText: "true", level: "global", key: "gpt-5*" },
				{ name: "supports_pdf_input", valueText: "true", level: "catalog", key: "anthropic/claude-sonnet-4" },
				{ name: "supports_web_search", valueText: "true", level: "global", key: "gpt-5*" },
				// The full Anthropic-style cost family with MIXED sources, so the
				// collapsed pricing line badges each tier separately.
				{ name: "input_cost_per_token", valueText: "0.000005", level: "server" },
				{ name: "output_cost_per_token", valueText: "0.000025", level: "server" },
				{ name: "cache_read_input_token_cost", valueText: "5e-7", level: "server" },
				{ name: "cache_creation_input_token_cost", valueText: "0.00000625", level: "entry", key: "gpt-5.6" },
				{ name: "long_context_input_cost_per_token", valueText: "0.00001", level: "global", key: "gpt-5*" },
				{ name: "long_context_output_cost_per_token", valueText: "0.0000375", level: "server" },
				{
					name: "long_context_cache_read_input_token_cost",
					valueText: "0.000001",
					level: "global-fallback",
					key: "*",
				},
				{ name: "long_context_cache_creation_input_token_cost", valueText: "0.0000125", level: "server" },
				{ name: "supported_openai_params", valueText: JSON.stringify(OPENAI_PARAMS_FULL), level: "server" },
			],
		},
		{
			serverLabel: "gateway",
			rawId: "deepseek-r1",
			scopeKey: "s-gw",
			matchedKeys: ["deepseek-r1"],
			parameters: [],
			capabilities: [
				{ name: "context_length", valueText: "131072", level: "entry-fallback", key: "deepseek-r1" },
				{ name: "supports_reasoning", valueText: "true", level: "entry", key: "deepseek-r1" },
				{ name: "max_output_tokens", valueText: "16000", level: "floor" },
				// An open-vocabulary field with a LONG raw wire key: the key renders
				// as-is (no friendly label), so it is the widest unbreakable token
				// the capability column ever has to survive at narrow panes.
				{
					name: "x_gateway_rate_limit_tier_override",
					valueText: '"gold-eu-west"',
					level: "entry",
					key: "deepseek-r1",
				},
			],
		},
	],
	recordCount: 5,
};

export function baseState(overrides: Partial<DashboardState> = {}): DashboardState {
	// The merged served count derives from whichever server rows the fixture
	// renders (an explicit override still wins), so fixture states stay
	// producible: the hero's count is the rows' sum in production too.
	const servers = overrides.servers ?? [PROD_SERVER, GATEWAY_SERVER, EXTERNAL_SERVER];
	return {
		servers,
		hiddenGroups: [],
		servedModelCount: servers.reduce((sum, server) => sum + server.servedModelCount, 0),
		models: [...MODELS],
		settings: {
			numbers: {
				"chat.timeout": 300000,
				"chat.maxToolsPerRequest": 128,
				"discovery.timeout": 30000,
				"discovery.cacheTtl": 3600000,
				"discovery.staleServeWindow": 600000,
				"usage.pollInterval": 300000,
				"usage.initialRefreshDelay": 5000,
				"usage.serversChangeRefreshDelay": 2000,
				"usage.pollingOffFreshnessWindow": 600000,
			},
			booleans: { "chat.promptCaching": true, "ui.maskSecretInputs": true, "models.openRouterCatalog": true },
			configuredScopes: {
				numbers: {
					"chat.timeout": null,
					"chat.maxToolsPerRequest": null,
					"discovery.timeout": null,
					"discovery.cacheTtl": null,
					"discovery.staleServeWindow": null,
					"usage.pollInterval": "global",
					"usage.initialRefreshDelay": null,
					"usage.serversChangeRefreshDelay": null,
					"usage.pollingOffFreshnessWindow": null,
				},
				booleans: { "chat.promptCaching": null, "ui.maskSecretInputs": null, "models.openRouterCatalog": null },
			},
			modelParameters: {
				editScope: "global",
				value: {
					"*": { temperature: 0.7, top_p: 0.9, _inheritable: true },
					"gpt-5*": { temperature: 0.3, _inheritable: true, _inherit_from: false, _force: ["temperature"] },
					"/deepseek.*/i": { reasoning_effort: "high" },
					"claude-sonnet-4": { temperature: 1 },
				},
				otherScopes: [],
				effective: {
					"*": { temperature: 0.7, top_p: 0.9, _inheritable: true },
					"gpt-5*": { temperature: 0.3, _inheritable: true, _inherit_from: false, _force: ["temperature"] },
					"/deepseek.*/i": { reasoning_effort: "high" },
					"claude-sonnet-4": { temperature: 1 },
				},
			},
			modelCapabilities: {
				editScope: "global",
				value: {
					"*": { _inheritable: true, _fallback: ["context_length"], context_length: 131072 },
					"my-alias": { _openrouter_model: "anthropic/claude-sonnet-4" },
				},
				otherScopes: [],
				effective: {
					"*": { _inheritable: true, _fallback: ["context_length"], context_length: 131072 },
					"my-alias": { _openrouter_model: "anthropic/claude-sonnet-4" },
				},
			},
			catalog: { modelCount: 324, lastSuccessAt: minutesAgoMs(60 * 26), refreshing: false },
			appearance: { theme: "auto", themeScope: null, accent: "blue", accentScope: null },
			chat: {
				tokenEstimation: "auto",
				tokenEstimationScope: null,
				additionalToolSchemaKeywords: [],
				additionalToolSchemaKeywordsLossy: false,
				additionalToolSchemaKeywordsScope: null,
			},
			usage: {
				statusBarMode: "always",
				statusBarScope: null,
				alertThresholds: [0.8, 0.95],
				thresholdsScope: null,
				currencySymbol: "$",
				currencySymbolScope: null,
			},
		},
		usage: USAGE,
		diagnostics: [],
		legacyServerCount: 0,
		...overrides,
	};
}
