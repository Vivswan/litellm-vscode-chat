/**
 * Protocol-typed builders: a wire-shape change breaks these fixtures rather than letting the tests drift. The one
 * cast through unknown is poisonedStatePush's, which smuggles protocol-forbidden value fields; it lives here alone.
 */
import type { ExtensionToWebviewMessage } from "../../../dashboard/endpoints";
import type {
	DashboardModel,
	DashboardServer,
	DashboardSettings,
	DashboardState,
	DashboardUsage,
	UsageForbiddenServerView,
	UsageServerView,
} from "../../../dashboard/viewModels";
import type { SecretFieldId, SecretLocation } from "../../../shared/serverEntry";

type DeclaredServer = Extract<DashboardServer, { origin: "declared" }>;
type ExternalServer = Extract<DashboardServer, { origin: "external" }>;

/** The state cluster's keys: the fields that must move together when an override changes `state`. */
type ServerStateKey =
	| "state"
	| "error"
	| "errorEnglish"
	| "classification"
	| "expected"
	| "declaredModelCount"
	| "modelInfoUnsupported";

/**
 * Per-variant overrides for a builder whose base sits in the "ok" cluster: row fields override
 * freely, but the state cluster rides its variant's own shape - `state: "error"` without its
 * `error` fails to typecheck, and an "ok" override cannot smuggle error-only companions.
 */
type ServerOverrides<V extends DashboardServer> = Partial<Omit<V, ServerStateKey>> &
	(
		| Partial<Pick<Extract<V, { state: "ok" }>, ServerStateKey>>
		| Pick<Extract<V, { state: "error" }>, ServerStateKey>
		| Pick<Extract<V, { state: "unchecked" }>, ServerStateKey>
	);

export function makeSettings(overrides: Partial<DashboardSettings> = {}): DashboardSettings {
	return {
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
				"usage.pollInterval": null,
				"usage.initialRefreshDelay": null,
				"usage.serversChangeRefreshDelay": null,
				"usage.pollingOffFreshnessWindow": null,
			},
			booleans: { "chat.promptCaching": null, "ui.maskSecretInputs": null, "models.openRouterCatalog": null },
		},
		modelParameters: { editScope: "global", value: {}, otherScopes: [], effective: {} },
		modelCapabilities: { editScope: "global", value: {}, otherScopes: [], effective: {} },
		catalog: { modelCount: 0, lastSuccessAt: undefined, refreshing: false },
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
		...overrides,
	};
}

/** The Servers page's empty usage snapshot; override per test. */
export function makeUsage(overrides: Partial<DashboardUsage> = {}): DashboardUsage {
	return {
		servers: [],
		thresholds: [0.8, 0.95],
		pollIntervalMs: 300000,
		discoveryTimeoutMs: 30000,
		refreshing: false,
		refreshingExplicitly: false,
		generatedAt: Date.now(),
		...overrides,
	};
}

/** One usage server card's view; override per test. */
export function makeUsageServer(overrides: Partial<UsageServerView> = {}): UsageServerView {
	return {
		kind: "usage",
		label: "Prod",
		baseUrl: "http://localhost:4000",
		fresh: true,
		keyInfo: { kind: "ok" },
		dailyActivity: { kind: "unknown" },
		lastUpdatedAt: Date.now(),
		spend: 12.5,
		effectiveBudget: 50,
		keyBudget: 50,
		budgetSource: "key",
		spentFraction: 0.25,
		...overrides,
	};
}

/** The reduced card for a never-available server blocked by a forbidden standing. */
export function makeForbiddenUsageServer(overrides: Partial<UsageForbiddenServerView> = {}): UsageForbiddenServerView {
	return {
		kind: "forbidden",
		label: "Locked",
		baseUrl: "http://locked.test:4000",
		keyInfo: { kind: "unavailable", reason: "forbidden", status: 403 },
		dailyActivity: { kind: "unavailable", reason: "forbidden", status: 403 },
		...overrides,
	};
}

const NO_SECRETS: Readonly<Record<SecretFieldId, SecretLocation>> = {
	apiKey: "none",
	oauthClientSecret: "none",
	virtualKeyValue: "none",
};

export function makeDeclaredServer(overrides: ServerOverrides<DeclaredServer> = {}): DeclaredServer {
	// Only the merge is cast: the checker cannot prove a spread lands on one union member. The
	// override TYPE is per-variant, so an incoherent state cluster fails at the call site.
	const base: DeclaredServer = {
		origin: "declared",
		label: "Prod",
		baseUrl: "http://localhost:4000",
		servedModelCount: 0,
		hasApiKey: false,
		hasOAuth: false,
		state: "ok",
		config: { secrets: NO_SECRETS },
	};
	return { ...base, ...overrides } as DeclaredServer;
}

/** A declared server whose secret fields live in the given locations. */
export function declaredWithSecrets(
	secrets: Partial<Record<SecretFieldId, SecretLocation>>,
	overrides: ServerOverrides<DeclaredServer> = {}
): DeclaredServer {
	return makeDeclaredServer({
		hasApiKey: true,
		config: { secrets: { ...NO_SECRETS, ...secrets } },
		...overrides,
	});
}

export function makeExternalServer(overrides: ServerOverrides<ExternalServer> = {}): ExternalServer {
	const base: ExternalServer = {
		origin: "external",
		label: "Copilot",
		baseUrl: "http://copilot.example:4000",
		servedModelCount: 2,
		hasApiKey: true,
		hasOAuth: false,
		state: "ok",
		adoptHandle: "handle-abc123",
		hideable: true,
	};
	return { ...base, ...overrides } as ExternalServer;
}

export function makeModel(overrides: Partial<DashboardModel> = {}): DashboardModel {
	return {
		id: "gpt-test",
		rawId: "gpt-test",
		scopeKey: "s0",
		name: "GPT Test",
		family: "gpt",
		serverLabel: "Prod",
		maxInputTokens: 128000,
		maxOutputTokens: 16000,
		outputLimitDeclared: false,
		toolCalling: true,
		imageInput: false,
		promptCaching: false,
		reasoning: false,
		...overrides,
	};
}

export function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
	// Derived like production's builder (the rows' served sum), so component
	// tests build states the real builder could produce; an explicit override
	// still wins for the deliberately inconsistent cases.
	const servers = overrides.servers ?? [];
	return {
		servers,
		hiddenGroups: [],
		servedModelCount: servers.reduce((sum, server) => sum + server.servedModelCount, 0),
		models: [],
		settings: makeSettings(),
		usage: makeUsage(),
		diagnostics: [],
		legacyServerCount: 0,
		...overrides,
	};
}

/** The extension's full state push for the given state. */
export function statePush(state: DashboardState): ExtensionToWebviewMessage {
	return { kind: "push", state };
}

/**
 * A state push whose server rows illegally carry secret VALUE fields (pushes carry locations only). Any component
 * that spreads a server or config object into the DOM surfaces the sentinel for the leak sweep. The cast through
 * unknown is confined to this helper on purpose; never let it normalize into non-test code.
 */
export function poisonedStatePush(sentinel: string): ExtensionToWebviewMessage {
	const poisonedServer = {
		...declaredWithSecrets({ apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" }),
		apiKey: sentinel,
		secretValue: sentinel,
		config: {
			secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
			apiKey: sentinel,
			values: { apiKey: sentinel },
		},
	};
	const state = {
		...makeState(),
		servers: [poisonedServer],
	};
	return { kind: "push", state } as unknown as ExtensionToWebviewMessage;
}

type MisconfiguredServer = Extract<DashboardServer, { origin: "misconfigured" }>;

/**
 * A misconfigured row's overrides, base cluster "error": no "unchecked" arm, because the
 * base's `error` would survive the spread and the unchecked variant forbids carrying one.
 */
type MisconfiguredOverrides = Partial<Omit<MisconfiguredServer, ServerStateKey>> &
	(
		| Partial<Pick<Extract<MisconfiguredServer, { state: "error" }>, ServerStateKey>>
		| Pick<Extract<MisconfiguredServer, { state: "ok" }>, ServerStateKey>
	);

/** A servers-setting entry the parser refused: present in the setting, never synced or served. */
export function makeMisconfiguredServer(overrides: MisconfiguredOverrides = {}): MisconfiguredServer {
	const base: MisconfiguredServer = {
		origin: "misconfigured",
		label: "Broken",
		baseUrl: "http://broken.test:4000",
		servedModelCount: 0,
		hasApiKey: false,
		hasOAuth: false,
		state: "error",
		error: "auth configures more than one form",
		problems: ["auth: configures more than one form (oauth beside apiKey)"],
	};
	return { ...base, ...overrides } as MisconfiguredServer;
}
