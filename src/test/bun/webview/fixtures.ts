/**
 * Protocol-typed builders: a wire-shape change breaks these fixtures rather than letting the tests drift. The one
 * cast through unknown is poisonedStatePush's, which smuggles protocol-forbidden value fields; it lives here alone.
 */
import type { ExtensionToWebviewMessage } from "../../../dashboard/endpoints";
import type {
	DashboardModel,
	DashboardServer,
	DashboardState,
	DashboardUsage,
	UsageForbiddenServerView,
	UsageServerView,
} from "../../../dashboard/viewModels";
import type { SecretFieldId, SecretLocation } from "../../../shared/serverEntry";
import { makeSettings } from "../../dashboardSettingsFixture";

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

/** Proven secret locations (the engine's post-pass truth) with the given fields overridden. */
export function provenSecrets(
	overrides: Partial<Record<SecretFieldId, SecretLocation>> = {}
): Extract<DeclaredServer["config"]["secrets"], { kind: "proven" }> {
	return { kind: "proven", locations: { ...NO_SECRETS, ...overrides } };
}

export function makeDeclaredServer(overrides: ServerOverrides<DeclaredServer> = {}): DeclaredServer {
	// Only the merge is cast: the checker cannot prove a spread lands on one union member. The
	// override TYPE is per-variant, so an incoherent state cluster fails at the call site.
	const base: DeclaredServer = {
		origin: "declared",
		label: "Prod",
		baseUrl: "http://localhost:4000",
		servedModelCount: 0,
		credentials: "absent",
		hasOAuth: false,
		state: "ok",
		config: { secrets: provenSecrets() },
	};
	return { ...base, ...overrides } as DeclaredServer;
}

/** A declared server whose secret fields live in the given (proven) locations. */
export function declaredWithSecrets(
	secrets: Partial<Record<SecretFieldId, SecretLocation>>,
	overrides: ServerOverrides<DeclaredServer> = {}
): DeclaredServer {
	return makeDeclaredServer({
		credentials: "present",
		config: { secrets: provenSecrets(secrets) },
		...overrides,
	});
}

/**
 * A declared row from the pre-first-pass settings fallback: its secret
 * locations are unproven, so it carries none - and is no edit target. The
 * unproven marker wins over any config override; a helper named for the
 * marker must not silently hand back a proven row. The credential verdict
 * defaults to the builder's own pre-proof value ("unknown"), overridable for
 * the rows something else vouches for.
 */
export function makeUnprovenServer(overrides: ServerOverrides<DeclaredServer> = {}): DeclaredServer {
	return makeDeclaredServer({ credentials: "unknown", ...overrides, config: { secrets: { kind: "unproven" } } });
}

export function makeExternalServer(overrides: ServerOverrides<ExternalServer> = {}): ExternalServer {
	const base: ExternalServer = {
		origin: "external",
		label: "Copilot",
		baseUrl: "http://copilot.example:4000",
		servedModelCount: 2,
		credentials: "present",
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
			secrets: {
				kind: "proven",
				locations: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
			},
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
		credentials: "absent",
		hasOAuth: false,
		state: "error",
		error: "auth configures more than one form",
		problems: ["auth: configures more than one form (oauth beside apiKey)"],
	};
	return { ...base, ...overrides } as MisconfiguredServer;
}
