/**
 * Protocol-typed builders for the webview suite. Everything here compiles
 * against src/extension/dashboard/protocol.ts, so a wire-shape change breaks
 * these fixtures instead of letting the tests drift from the contract. The
 * one deliberate exception is poisonedState, which casts through unknown to
 * smuggle protocol-forbidden value fields; the cast lives here and only here.
 */
import type {
	DashboardModel,
	DashboardServer,
	DashboardSettings,
	DashboardState,
	DashboardUsage,
	ExtensionToWebviewMessage,
	SecretFieldId,
	SecretLocation,
	UsageServerView,
} from "../../extension/dashboard/protocol";

type DeclaredServer = Extract<DashboardServer, { origin: "declared" }>;
type ExternalServer = Extract<DashboardServer, { origin: "external" }>;

export function makeSettings(overrides: Partial<DashboardSettings> = {}): DashboardSettings {
	return {
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
				"usage.pollInterval": null,
			},
			booleans: { "chat.promptCaching": null, "ui.maskSecretInputs": null, "models.openRouterCatalog": null },
		},
		modelParameters: { editScope: "global", value: {}, otherScopes: [], effective: {} },
		modelCapabilities: { editScope: "global", value: {}, otherScopes: [], effective: {} },
		catalog: { modelCount: 0, lastSuccessAt: undefined, refreshing: false },
		usage: { statusBarMode: "always", statusBarScope: null, alertThresholds: [0.8, 0.95], thresholdsScope: null },
		...overrides,
	};
}

/** The Usage tab's empty snapshot; override per test. */
export function makeUsage(overrides: Partial<DashboardUsage> = {}): DashboardUsage {
	return {
		servers: [],
		thresholds: [0.8, 0.95],
		pollIntervalMs: 300000,
		discoveryTimeoutMs: 30000,
		refreshing: false,
		generatedAt: Date.now(),
		...overrides,
	};
}

/** One usage server card's view; override per test. */
export function makeUsageServer(overrides: Partial<UsageServerView> = {}): UsageServerView {
	return {
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

const NO_SECRETS: Readonly<Record<SecretFieldId, SecretLocation>> = {
	apiKey: "none",
	oauthClientSecret: "none",
	virtualKeyValue: "none",
};

export function makeDeclaredServer(overrides: Partial<DeclaredServer> = {}): DeclaredServer {
	// The base literal is fully typed against the protocol, so a drifted or
	// renamed required field fails compilation here. Only the merge itself is
	// cast: spreading a Partial over the state/error discriminated union is
	// beyond what the checker can prove.
	const base: DeclaredServer = {
		origin: "declared",
		label: "Prod",
		baseUrl: "http://localhost:4000",
		modelCount: 0,
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
	overrides: Partial<DeclaredServer> = {}
): DeclaredServer {
	return makeDeclaredServer({
		hasApiKey: true,
		config: { secrets: { ...NO_SECRETS, ...secrets } },
		...overrides,
	});
}

export function makeExternalServer(overrides: Partial<ExternalServer> = {}): ExternalServer {
	const base: ExternalServer = {
		origin: "external",
		label: "Copilot",
		baseUrl: "http://copilot.example:4000",
		modelCount: 2,
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
	return {
		servers: [],
		hiddenGroups: [],
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
	return { type: "state", state };
}

/**
 * A state push whose server rows illegally carry secret VALUE fields the
 * protocol forbids (state pushes carry locations only). If any component
 * spreads server or config objects into the DOM, the sentinel surfaces and
 * the leak sweep catches it. The cast through unknown is confined to this
 * helper on purpose; never let it normalize into non-test code.
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
	return { type: "state", state } as unknown as ExtensionToWebviewMessage;
}

type MisconfiguredServer = Extract<DashboardServer, { origin: "misconfigured" }>;

/** A servers-setting entry the parser refused: present in the setting, never synced or served. */
export function makeMisconfiguredServer(overrides: Partial<MisconfiguredServer> = {}): MisconfiguredServer {
	const base: MisconfiguredServer = {
		origin: "misconfigured",
		label: "Broken",
		baseUrl: "http://broken.test:4000",
		modelCount: 0,
		hasApiKey: false,
		hasOAuth: false,
		state: "error",
		error: "auth configures more than one form",
		problems: ["auth: configures more than one form (oauth beside apiKey)"],
	};
	return { ...base, ...overrides } as MisconfiguredServer;
}
