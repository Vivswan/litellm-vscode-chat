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
} from "../../../src/extension/dashboard/protocol.ts";

const NOW = Date.now();

export function minutesAgoIso(minutes: number): string {
	return new Date(NOW - minutes * 60_000).toISOString();
}

export function minutesAgoMs(minutes: number): number {
	return NOW - minutes * 60_000;
}

export const NO_SECRETS = { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } as const;

export const PROD_SERVER: DashboardServer = {
	origin: "declared",
	label: "prod",
	baseUrl: "https://litellm.example.com",
	modelCount: 3,
	hasApiKey: true,
	hasOAuth: false,
	state: "ok",
	lastChecked: minutesAgoIso(2),
	config: {
		secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
		headers: { "x-routing-env": "prod" },
		modelParameters: { "gpt-5*": { temperature: 0.2, _force: ["temperature"] } },
		budget: 50,
	},
};

export const GATEWAY_SERVER: DashboardServer = {
	origin: "declared",
	label: "gateway",
	baseUrl: "https://gateway.internal",
	modelCount: 1,
	hasApiKey: false,
	hasOAuth: true,
	state: "error",
	error: "Model listing failed: 404",
	errorEnglish: "Model listing failed: 404",
	expected: true,
	declaredModelCount: 1,
	lastChecked: minutesAgoIso(9),
	config: {
		secrets: { apiKey: "none", oauthClientSecret: "secure", virtualKeyValue: "secure" },
		oauthTokenUrl: "https://idp.example.com/oauth2/token",
		oauthClientId: "litellm-vscode",
		virtualKeyHeader: "x-litellm-api-key",
		expectedFailures: ["modelListing", "modelInfo"],
		declaredModels: ["deepseek-r1"],
	},
	notices: ["expected-failures-nothing-declared"],
};

export const MISCONFIGURED_SERVER: DashboardServer = {
	origin: "misconfigured",
	label: "broken",
	baseUrl: "https://broken.example.com",
	modelCount: 0,
	hasApiKey: false,
	hasOAuth: false,
	state: "error",
	error: "misconfigured entry; not used until its configuration is fixed",
	errorEnglish: "misconfigured entry; not used until its configuration is fixed",
	problems: ["sets another auth form beside oauth; companions belong inside the oauth object"],
};

export const EXTERNAL_SERVER: DashboardServer = {
	origin: "external",
	label: "Copilot proxy",
	baseUrl: "http://localhost:4000",
	modelCount: 2,
	hasApiKey: true,
	hasOAuth: false,
	state: "ok",
	lastChecked: minutesAgoIso(5),
	adoptHandle: "handle-fixture",
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
	generatedAt: NOW,
};

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
							fields: [{ name: "temperature", valueText: "0.3", inheritable: true, forced: false, fallback: false }],
							barrier: true,
							inheritFrom: "false",
							children: [],
							models: [
								{ id: "gpt-5.6", resolvedText: "temperature 0.3, max_tokens 8192" },
								{ id: "gpt-5-mini", resolvedText: "temperature 0.3" },
							],
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
			rawId: "gpt-5.6",
			scopeKey: "s-prod",
			matchedKeys: ["*", "gpt-5*"],
			parameters: [
				{
					name: "temperature",
					valueText: "0.3",
					layer: "global",
					key: "gpt-5*",
					inheritedFrom: "gpt-5*",
					forced: true,
				},
				{ name: "max_tokens", valueText: "8192", layer: "entry", key: "gpt-5.6" },
			],
			capabilities: [
				{ name: "context_length", valueText: "272000", level: "server" },
				{ name: "max_output_tokens", valueText: "16384", level: "server" },
				{ name: "supports_reasoning", valueText: "true", level: "global", key: "gpt-5*" },
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
			],
		},
	],
	recordCount: 5,
};

export function baseState(overrides: Partial<DashboardState> = {}): DashboardState {
	return {
		servers: [PROD_SERVER, GATEWAY_SERVER, EXTERNAL_SERVER],
		hiddenGroups: [],
		models: [...MODELS],
		settings: {
			numbers: {
				"chat.timeout": 300000,
				"discovery.timeout": 30000,
				"discovery.cacheTtl": 3600000,
				"usage.pollInterval": 300000,
			},
			booleans: { "chat.promptCaching": true, "ui.maskSecretInputs": true, "models.openRouterCatalog": true },
			configuredScopes: {
				numbers: {
					"chat.timeout": null,
					"discovery.timeout": null,
					"discovery.cacheTtl": null,
					"usage.pollInterval": "global",
				},
				booleans: { "chat.promptCaching": null, "ui.maskSecretInputs": null, "models.openRouterCatalog": null },
			},
			modelParameters: {
				editScope: "global",
				value: {
					"*": { temperature: 0.7, top_p: 0.9, _inheritable: true },
					"gpt-5*": { temperature: 0.3, _inheritable: true, _inherit_from: false, _force: ["temperature"] },
					"claude-sonnet-4": { temperature: 1 },
				},
				otherScopes: [],
				effective: {
					"*": { temperature: 0.7, top_p: 0.9, _inheritable: true },
					"gpt-5*": { temperature: 0.3, _inheritable: true, _inherit_from: false, _force: ["temperature"] },
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
			usage: { statusBarMode: "always", statusBarScope: null, alertThresholds: [0.8, 0.95], thresholdsScope: null },
		},
		usage: USAGE,
		diagnostics: [],
		legacyServerCount: 0,
		...overrides,
	};
}
