/**
 * Imported by both sides, so it must stay pure (no vscode, DOM, or Node). Everything here is derived on demand;
 * nothing is persisted. Timestamps are epoch milliseconds throughout.
 */

import type { CapabilityLevel } from "../shared/config/capabilityResolution";
import type { RecordDiagnostic } from "../shared/config/recordResolution";
import type {
	BooleanSettingId,
	FeatureModelId,
	FeatureModelRef,
	FeatureModelSettingKey,
	LanguageFilterMode,
	NumberSettingId,
	SessionIdMode,
	TokenEstimationMode,
	UiAccent,
	UiTheme,
	UsageStatusBarMode,
} from "../shared/config/settingSpec";
import {
	BOOLEAN_SETTING_SPECS,
	FEATURE_MODEL_SETTING_KEY_LIST,
	NUMBER_SETTING_SPECS,
} from "../shared/config/settingSpec";
import type { UnservedEndpointEvidence } from "../shared/errorClassification";
import type { FailureCause } from "../shared/failureCause";
import type {
	ExpectedFailureCategory,
	McpOptIn,
	NonChatMode,
	NonSecretOptionalFields,
	SecretFieldId,
	SecretLocation,
	SkippedModeCounts,
} from "../shared/serverEntry";

/** A per-entry modelParameters record: model-ID prefix to request parameters. Non-secret user configuration. */
export type EntryModelParametersPayload = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * Where a declared row's secrets live, discriminated on whether the push could PROVE it: proving "none" requires
 * reading the entry's SecretStorage blob, which the pre-first-pass settings fallback cannot do synchronously. The
 * unproven variant carries no locations at all, so a view cannot claim proven-empty when it means unproven - nothing
 * downstream can read a location it does not have.
 *
 *   Values -> never ride either variant
 */
export type ServerSecretsView =
	| { readonly kind: "proven"; readonly locations: Readonly<Record<SecretFieldId, SecretLocation>> }
	| { readonly kind: "unproven"; readonly locations?: undefined };

type ProvenServerSecrets = Extract<ServerSecretsView, { kind: "proven" }>;

/**
 * A row's credential verdict, "unknown" reserved for the window where no verdict exists yet: a declared entry before
 * its secret locations are proven (ServerSecretsView "unproven") with no other evidence of a key. Derived host-side
 * from that same union - the one proof classifier - never recomputed in the webview.
 */
type CredentialPresence = "present" | "absent" | "unknown";

/** A per-entry modelCapabilities record: model-ID prefix to capability fields and directives. Non-secret. */
export type EntryModelCapabilitiesPayload = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

interface DashboardServerConfig extends NonSecretOptionalFields {
	/** Where each secret currently lives, when proven; the values themselves never reach the webview. */
	readonly secrets: ServerSecretsView;

	/** The entry's apiVersion override ("" is a real value: append nothing); the edit form's prefill. */
	readonly apiVersion?: string | undefined;

	/** The entry's per-entry modelParameters record, when it holds any; the edit form's prefill. */
	readonly modelParameters?: EntryModelParametersPayload | undefined;

	/** The entry's per-entry modelCapabilities record, when it holds any; the edit form's prefill. */
	readonly modelCapabilities?: EntryModelCapabilitiesPayload | undefined;

	/** The failure categories the entry declares expected (expectedFailures); the edit form's prefill. */
	readonly expectedFailures?: readonly ExpectedFailureCategory[] | undefined;

	/** The entry's custom HTTP headers (plain settings text, not secrets); the edit form's prefill. */
	readonly headers?: Readonly<Record<string, string>> | undefined;

	/** The entry's discovery.declared model IDs, when it lists any. */
	readonly declaredModels?: readonly string[] | undefined;

	/** The entry's discovery.includeModes, when it names any. */
	readonly includeModes?: readonly NonChatMode[] | undefined;

	/** The entry's manual usage budget in USD, when set. */
	readonly budget?: number | undefined;

	/** The entry's MCP opt-in, when set; the edit form's prefill. */
	readonly mcp?: McpOptIn | undefined;
}

/**
 * Row-level warning classifications for declared entries; only the classification crosses the boundary, copy renders
 * webview-side. The InactiveEntryNotice family means the live group did not join by the entry's exact labeled
 * identity, so its entry-only fields may not apply until the group is recreated.
 *
 *   The webview derives every badge from this union -> a new member fails compilation until its presentation exists
 */
export type InactiveEntryNotice =
	| "entry-params-inactive"
	| "entry-capabilities-inactive"
	| "entry-headers-inactive"
	| "entry-api-version-inactive";

export type DeclaredServerNotice =
	| InactiveEntryNotice
	| "expected-failures-nothing-declared"
	| "non-chat-modes-skipped";

/** Classifications and labels only, never free text. */
export type ExternalServerProvenance =
	| { readonly kind: "removed-entry-leftover"; readonly removedLabel: string }
	| { readonly kind: "rename-leftover"; readonly oldLabel: string; readonly newLabel: string };

/**
 * "removed" is a tombstone (the user removed the entry or the external row), and its identity is what the unhideServer
 * intent echoes; "superseded" is a live group whose entry now declares `declaredBaseUrl`, the leftover an add-only
 * host kept under the old connection - hidden for as long as the entry points elsewhere, so there is nothing to
 * unhide. Deleting a group is the host's job (Manage Language Models, or the models file), and `syncedName` is the
 * name the sync gave a group it created (its entry label).
 *
 *   One hidden provider group -> serves no models, rendered only on the hidden-groups line
 */
export type HiddenGroup =
	| { readonly label: string; readonly baseUrl: string; readonly reason: "removed"; readonly syncedName?: string }
	| {
			readonly label: string;
			readonly baseUrl: string;
			readonly reason: "superseded";
			readonly declaredBaseUrl: string;
	  };

/**
 * `servedModelCount` is the one field the merged counts and every serving verdict read, on every state.
 *
 *   observedModelInfoKeys -> "__proto__" is a legal member, so membership tests go through Set or Map
 *   skippedModeCounts     -> the evidence the edit form offers includeModes on; an all-dropped row explains its empty
 *                            picker with it
 */
interface DashboardServerBase {
	/** Half the row's join identity (with baseUrl); a declared entry's label also names its provider group. */
	readonly label: string;

	/** The other half of the join identity; a declared entry and a live group merge when both halves match. */
	readonly baseUrl: string;

	/** Models served RIGHT NOW, whatever the state; an error row still serving stale or declared models counts them. */
	readonly servedModelCount: number;

	/** When discovery last ran, absent while unchecked; the host maps "" and unparseable stored values to absent. */
	readonly lastChecked?: number | undefined;

	/** "unknown" while config.secrets is unproven and nothing else vouches for a key; it never denies an unread key. */
	readonly credentials: CredentialPresence;

	/** OAuth client credentials, not a static key; declared rows derive it from the entry, external from the group. */
	readonly hasOAuth: boolean;

	/** A virtual-key header rather than a static key; derived like hasOAuth. */
	readonly hasVirtualKey: boolean;

	/** The last successful /model/info key set, for the editors' hints; absent is unknown, empty a real answer. */
	readonly observedModelInfoKeys?: readonly string[] | undefined;

	/** Usable /model/info entries the last listing dropped per non-chat mode; absent means nothing observed. */
	readonly skippedModeCounts?: SkippedModeCounts | undefined;
}

/**
 * One server row: a declared entry, a live provider group, or both merged (joined by label and base URL). A declared
 * entry whose group sync failed is an "error" row even over a live group that keeps serving: the sync error outranks
 * the live state while `servedModelCount` keeps the live truth. A failing row carries its cause as a key, never as
 * text: the webview renders it in its locale and the copyable diagnostics block renders it in English.
 *
 *   declared.entryFieldsInactive
 *                           -> the live group did not join by this entry's exact labeled identity, so entry-only
 *                              fields written NOW may not reach it either; guards on entry-only WRITES key on this
 *                              flag, not the notices, since an entry configuring no such field has the same problem
 *                              and no notice
 *   "misconfigured"         -> a servers-setting entry the parser REFUSED: present in the setting, never synced or
 *                              served until fixed; no `config`, because the broken shape cannot round-trip through
 *                              the edit form, so the row's Fix action reveals it in settings.json instead
 *   misconfigured.problems  -> the parser's English structural reports: configuration key names only, never entered
 *                              values
 *   "legacy"                -> a live group a declared label left behind and still serves from: its configuration
 *                              stamp names the label, or it holds the label's stored secret, while no entry's current
 *                              configuration matches it (a rotated identity, a moved entry's unstamped group, a label
 *                              the setting now rejects); not the user's own, so no Edit, adopt, hide, or credential
 *                              source, and deleting it is the host's job (Manage Language Models, or the models file)
 *   legacy.entryLabel       -> the declared label the group belongs to
 *   legacy.groupHandle      -> the group's opaque per-session token (the same mint as adoptHandle), the row's key
 *                              across pushes
 *   "external"              -> a provider group managed outside the setting; Remove (hide) always applies to it, by
 *                              tombstone
 *   external.adoptHandle    -> the opaque token the adopt intent names its source group by: a salted one-way hash,
 *                              stable for the session, carrying no credential material, resolvable only while the
 *                              group stays external
 *   external.entryLabel     -> the label its configuration is stamped with, absent when unstamped: usually the
 *                              host-side name the sync gave it (which the host refuses to reuse), but a group the
 *                              host named itself can carry any stamp, so the edit form advises on a collision, never
 *                              refuses
 *   ok.modelInfoUnsupported -> ServerStatusOk's, on declared rows only (the fix lives on an entry); a classification,
 *                              with copy rendered webview-side
 *   error.cause             -> a FailureCause key (shared/failureCause.ts) with no message text, so it crosses the
 *                              boundary as data
 *   error.expected          -> the failure hit a category the entry's expectedFailures declares: the outcome stays a
 *                              truthful error (the stale anchor and counts depend on it), but presentation treats it
 *                              as expected
 *   error.declaredModelCount
 *                           -> the declared subset of servedModelCount; drives the "N declared models" wording
 */
export type DashboardServer = DashboardServerBase &
	(
		| {
				readonly origin: "declared";
				readonly config: DashboardServerConfig;
				readonly adoptHandle?: undefined;
				readonly notices?: readonly DeclaredServerNotice[] | undefined;
				readonly entryFieldsInactive?: true | undefined;
				readonly provenance?: undefined;
				readonly problems?: undefined;
		  }
		| {
				readonly origin: "misconfigured";
				readonly problems: readonly string[];
				readonly config?: undefined;
				readonly adoptHandle?: undefined;
				readonly notices?: undefined;
				readonly entryFieldsInactive?: undefined;
				readonly provenance?: undefined;
		  }
		| {
				readonly origin: "legacy";
				readonly entryLabel: string;
				readonly groupHandle: string;
				readonly config?: undefined;
				readonly adoptHandle?: undefined;
				readonly notices?: undefined;
				readonly entryFieldsInactive?: undefined;
				readonly provenance?: undefined;
				readonly problems?: undefined;
		  }
		| {
				readonly origin: "external";
				readonly adoptHandle: string;
				readonly entryLabel?: string | undefined;
				readonly config?: undefined;
				readonly notices?: undefined;
				readonly entryFieldsInactive?: undefined;
				readonly provenance?: ExternalServerProvenance | undefined;
				readonly problems?: undefined;
		  }
	) &
	(
		| {
				readonly state: "ok";
				readonly cause?: undefined;
				readonly expected?: undefined;
				readonly declaredModelCount?: undefined;
				readonly modelInfoUnsupported?: UnservedEndpointEvidence | undefined;
		  }
		| {
				readonly state: "error";
				readonly cause: FailureCause;
				readonly expected?: boolean | undefined;
				readonly declaredModelCount?: number | undefined;
				readonly modelInfoUnsupported?: undefined;
		  }
		| {
				readonly state: "unchecked";
				readonly cause?: undefined;
				readonly expected?: undefined;
				readonly declaredModelCount?: undefined;
				readonly modelInfoUnsupported?: undefined;
		  }
	);

/**
 * DashboardServer narrowed by origin; declared here because two webview modules need them and neither should import a
 * type from the other.
 */
export type DeclaredDashboardServer = Extract<DashboardServer, { origin: "declared" }>;
export type ExternalDashboardServer = Extract<DashboardServer, { origin: "external" }>;

/**
 * A declared row whose secret locations are proven: the only rows the edit form may open on, since its prefill and
 * frozen replace identity both read the locations. Narrowing to this type is how "unproven rows are not edit targets"
 * holds by construction rather than by a check someone remembers.
 */
export type EditableDashboardServer = DeclaredDashboardServer & {
	readonly config: { readonly secrets: ProvenServerSecrets };
};

/** The one narrowing to an edit-form target; the edit page and any affordance gate read this, not their own test. */
export function isEditableServer(server: DashboardServer): server is EditableDashboardServer {
	return server.origin === "declared" && server.config.secrets.kind === "proven";
}

/**
 * One served model as the picker and the models page see it. Costs are USD per million tokens, as registration
 * converted them; the long-context tier costs are present only when the tier differs from the base price.
 */
export interface DashboardModel {
	/** The exposed model ID; registration mints its own for the aggregate variants, so it can differ from rawId. */
	readonly id: string;

	/** The ID the server knows: what a request's `model` field and a modelParameters prefix match against. */
	readonly rawId: string;

	/** A salted per-session hash of the serving server's ID; a stale key de-resolves, never misroutes. Not persisted. */
	readonly scopeKey: string;

	/** The display name registration gave the model. */
	readonly name: string;

	/** The model family registration reported. */
	readonly family: string;

	/** The label of the serving server. */
	readonly serverLabel: string;

	/** The input token limit registration reported. */
	readonly maxInputTokens: number;

	/** The output token limit registration reported. */
	readonly maxOutputTokens: number;

	/** The request's max_tokens when nothing configures one; under maxOutputTokens when a guess exceeds the cap. */
	readonly defaultMaxTokens: number;

	/** The price of a million input tokens. */
	readonly inputCost?: number | undefined;

	/** The price of a million output tokens. */
	readonly outputCost?: number | undefined;

	/** The price of a million cached input tokens read back. */
	readonly cacheReadCost?: number | undefined;

	/** The price of a million input tokens written to the cache. */
	readonly cacheWriteCost?: number | undefined;

	/** The price of a million input tokens in the long-context tier. */
	readonly longContextInputCost?: number | undefined;

	/** The price of a million output tokens in the long-context tier. */
	readonly longContextOutputCost?: number | undefined;

	/** The price of a million cached input tokens read back in the long-context tier. */
	readonly longContextCacheReadCost?: number | undefined;

	/** The price of a million input tokens written to the cache in the long-context tier. */
	readonly longContextCacheWriteCost?: number | undefined;

	/** Whether the model accepts tool definitions. */
	readonly toolCalling: boolean;

	/** Whether the model accepts image input. */
	readonly imageInput: boolean;

	/** Whether the model supports prompt caching, by modelSupportsPromptCaching's reading. */
	readonly promptCaching: boolean;

	/** Whether the model advertises the reasoning-effort configuration control. */
	readonly reasoning: boolean;

	/** True for a declared model discovery does not list; it drives the declared badge. */
	readonly declared?: boolean | undefined;
}

export const NUMBER_SETTING_IDS = Object.keys(NUMBER_SETTING_SPECS) as readonly NumberSettingId[];

export const BOOLEAN_SETTING_IDS = Object.keys(BOOLEAN_SETTING_SPECS) as readonly BooleanSettingId[];

/**
 * The feature model keys derive from FEATURE_MODEL_SETTING_KEYS, so a new feature's row joins without a hand edit here.
 */
export type RevealableSettingId =
	| NumberSettingId
	| BooleanSettingId
	| FeatureModelSettingKey
	| "models.parameters"
	| "models.capabilities"
	| "servers"
	| "chat.additionalToolSchemaKeywords"
	| "chat.tokenEstimation"
	| "usage.alertThresholds"
	| "usage.statusBar"
	| "usage.currencySymbol"
	| "ui.theme"
	| "ui.accent"
	| "inlineCompletions.languageFilter"
	| "commitGeneration.prompt"
	| "chat.sessionId";

/** A readonly list typechecked to name every member of T: omitting a union member makes the argument unsatisfiable. */
const everyId =
	<T extends string>() =>
	<L extends readonly T[]>(ids: Exclude<T, L[number]> extends never ? L : never): readonly T[] =>
		ids;

/** Every setting the Reveal gesture opens; extending RevealableSettingId fails to compile until the list names it. */
export const REVEALABLE_SETTING_IDS: readonly RevealableSettingId[] = everyId<RevealableSettingId>()([
	...NUMBER_SETTING_IDS,
	...BOOLEAN_SETTING_IDS,
	...FEATURE_MODEL_SETTING_KEY_LIST,
	"models.parameters",
	"models.capabilities",
	"servers",
	"chat.additionalToolSchemaKeywords",
	"chat.tokenEstimation",
	"usage.alertThresholds",
	"usage.statusBar",
	"usage.currencySymbol",
	"ui.theme",
	"ui.accent",
	"inlineCompletions.languageFilter",
	"commitGeneration.prompt",
	"chat.sessionId",
]);

export type ResettableSettingId =
	| NumberSettingId
	| BooleanSettingId
	| FeatureModelSettingKey
	| "chat.additionalToolSchemaKeywords"
	| "chat.tokenEstimation"
	| "usage.statusBar"
	| "usage.alertThresholds"
	| "usage.currencySymbol"
	| "ui.theme"
	| "ui.accent"
	| "inlineCompletions.languageFilter"
	| "commitGeneration.prompt"
	| "chat.sessionId";

export const RESETTABLE_SETTING_IDS: readonly ResettableSettingId[] = everyId<ResettableSettingId>()([
	...NUMBER_SETTING_IDS,
	...BOOLEAN_SETTING_IDS,
	...FEATURE_MODEL_SETTING_KEY_LIST,
	"chat.additionalToolSchemaKeywords",
	"chat.tokenEstimation",
	"usage.statusBar",
	"usage.alertThresholds",
	"usage.currencySymbol",
	"ui.theme",
	"ui.accent",
	"inlineCompletions.languageFilter",
	"commitGeneration.prompt",
	"chat.sessionId",
]);

/**
 *   the overlap of the two gestures every row offers -> a merely revealable setting cannot reach a row by mistake
 */
export type SettingRowId = ResettableSettingId & RevealableSettingId;

/** The configuration scopes a setting value can live in, in ascending precedence. */
export type SettingScope = "global" | "workspace" | "workspaceFolder";

/**
 * VS Code shallow-merges object settings across scopes, so an editor over the merged value would copy user-scope
 * entries into workspace files and could never delete an entry from the other scope; the dashboard edits exactly one
 * scope's own record.
 */
export interface ScopedRecordSetting<V> {
	/** The scope whose own record `value` holds. */
	readonly editScope: SettingScope;

	/** The record the edit scope itself holds; what the editor edits and writes back whole. */
	readonly value: Readonly<Record<string, V>>;

	/** Non-empty records held by other scopes, read-only in the dashboard. */
	readonly otherScopes: readonly { readonly scope: SettingScope; readonly value: Readonly<Record<string, V>> }[];

	/** The scope-merged record as the request path reads it; read-only truth for the effective-values inspector. */
	readonly effective: Readonly<Record<string, V>>;
}

/**
 * Scalars are the effective values; records are per-scope. A scalar's companion scope (`themeScope`, `sessionIdScope`,
 * `configuredScopes`, and the rest) is the highest-precedence scope the setting is explicitly configured in, or null
 * when only the default applies: "modified" means the key is set somewhere, matching the native Settings editor, and
 * the named scope is the one a reset removes first.
 */
export interface DashboardSettings {
	/** Every number setting's effective value; null is a nullable setting's "none". */
	readonly numbers: Readonly<Record<NumberSettingId, number | null>>;

	/** Every boolean setting's effective value. */
	readonly booleans: Readonly<Record<BooleanSettingId, boolean>>;

	/** The scalars' companion scopes. */
	readonly configuredScopes: {
		/** Each number setting's companion scope. */
		readonly numbers: Readonly<Record<NumberSettingId, SettingScope | null>>;

		/** Each boolean setting's companion scope. */
		readonly booleans: Readonly<Record<BooleanSettingId, SettingScope | null>>;
	};

	/** The models.parameters record, per scope. */
	readonly modelParameters: ScopedRecordSetting<Readonly<Record<string, unknown>>>;

	/** The models.capabilities record, per scope. */
	readonly modelCapabilities: ScopedRecordSetting<Readonly<Record<string, unknown>>>;

	/** The models.openRouterCatalog row's status. */
	readonly catalog: CatalogStatusView;

	/** The theme and accent, on every push: the webview restamps the root element from it, so a change lands live. */
	readonly appearance: {
		/** How the dashboard picks its colors (ui.theme). */
		readonly theme: UiTheme;

		/** theme's companion scope. */
		readonly themeScope: SettingScope | null;

		/** The accent color of primary buttons, selection, focus, and links (ui.accent). */
		readonly accent: UiAccent;

		/** accent's companion scope. */
		readonly accentScope: SettingScope | null;
	};

	/** The chat rows' values and scopes. */
	readonly chat: {
		/** How prompt sizes are estimated for the local token budget (chat.tokenEstimation). */
		readonly tokenEstimation: TokenEstimationMode;

		/** tokenEstimation's companion scope. */
		readonly tokenEstimationScope: SettingScope | null;

		/** The extra JSON-Schema keywords kept in tool input schemas (chat.additionalToolSchemaKeywords). */
		readonly additionalToolSchemaKeywords: StringListSetting;

		/** What LiteLLM groups a chat request under (chat.sessionId). */
		readonly sessionId: SessionIdMode;

		/** sessionId's companion scope. */
		readonly sessionIdScope: SettingScope | null;
	};

	/** The usage rows' values and scopes. */
	readonly usage: {
		/** When the usage status-bar item shows (usage.statusBar). */
		readonly statusBarMode: UsageStatusBarMode;

		/** statusBarMode's companion scope. */
		readonly statusBarScope: SettingScope | null;

		/** usage.alertThresholds as normalization reads them: valid fractions, deduplicated, ascending. */
		readonly alertThresholds: readonly number[];

		/** alertThresholds' companion scope. */
		readonly thresholdsScope: SettingScope | null;

		/** The prefix on every spend and cost figure, display only, never a conversion; "" renders the bare number. */
		readonly currencySymbol: string;

		/** currencySymbol's companion scope. */
		readonly currencySymbolScope: SettingScope | null;
	};

	/** Each feature's model ref, an entry label plus a raw model ID (never a secret); null while unset or malformed. */
	readonly featureModels: Readonly<Record<FeatureModelId, FeatureModelRef | null>>;

	/** Each feature model's companion scope. */
	readonly featureModelScopes: Readonly<Record<FeatureModelId, SettingScope | null>>;

	/** The commitGeneration.prompt row's value; "" means the built-in instruction applies. */
	readonly commitPrompt: string;

	/** commitPrompt's companion scope. */
	readonly commitPromptScope: SettingScope | null;

	/** The inlineCompletions.languageFilter setting as its two rows render it. */
	readonly languageFilter: LanguageFilterSetting;
}

/**
 * The inlineCompletions.languageFilter setting as its two rows render it: the mode plus the languages list riding the
 * shared StringListSetting shape (the list's lossy flag and scope speak for the whole setting - one key holds both
 * halves).
 */
export interface LanguageFilterSetting {
	readonly mode: LanguageFilterMode;
	readonly languages: StringListSetting;
}

/**
 * One normalized string-list setting as its comma-list row renders it (the schema keywords and the language filter's
 * list): the normalized values, plus the lossy flag that forces the row's read-only fallback when normalization
 * dropped or rewrote raw entries a comma-box edit would silently destroy.
 */
export interface StringListSetting {
	readonly values: readonly string[];
	readonly lossy: boolean;
	readonly scope: SettingScope | null;
}

/**
 * The OpenRouter catalog refresh failure vocabulary, English by policy: the store's log line (which feeds the public
 * issue-report buffer) and the dashboard row show it verbatim like a header name, so it is fixed words and numbers
 * only, never response-derived text. Each word names the phase that failed: `HTTP <status>` a non-2xx answer,
 * `timeout` the store's own per-attempt budget expiring (headers or body), `unparseable response` a body that arrived
 * whole but is not JSON, the floor a payload too small to trust, `network error` everything else.
 */
export type CatalogRefreshFailure =
	| "network error"
	| "timeout"
	| "unparseable response"
	| `HTTP ${number}`
	| `payload below the ${number}-model floor`;

/** The models.openRouterCatalog row's status; `lastFailure` stands until the next successful refresh. */
export interface CatalogStatusView {
	readonly modelCount: number;
	readonly lastSuccessAt: number | undefined;
	readonly lastFailure?: { readonly classification: CatalogRefreshFailure; readonly at: number } | undefined;
	readonly refreshing: boolean;
}

/** One OpenRouter catalog entry as the picker lists it; id is what `_openrouter_model` takes. */
export interface CatalogModelSummary {
	readonly id: string;
	readonly name: string;
}

/**
 * One usage endpoint's standing (closed enums and status numbers only - usage response bodies embed hashed key
 * material, so nothing body-derived may ride here).
 *
 *   "error" -> keeps retrying on scheduled polls
 */
export type UsageEndpointStandingView =
	| { readonly kind: "unknown" }
	| { readonly kind: "ok" }
	| { readonly kind: "unavailable"; readonly reason: "unsupported" | "forbidden"; readonly status?: number | undefined }
	| {
			readonly kind: "error";
			readonly classification?: "http" | "network" | "timeout" | undefined;
			readonly status?: number | undefined;
	  };

/**
 * One server's usage facts: numbers, epoch timestamps, user-configured identity, and closed endpoint-standing enums
 * only. Servers whose proxy serves no usage endpoints never appear here, and a stale card still renders, labeled with
 * its age.
 */
export interface UsageServerView {
	/** The full card; a server left with no readable usage by a forbidden standing gets UsageForbiddenServerView. */
	readonly kind: "usage";

	/** The entry's label, half of the identity the user configured. */
	readonly label: string;

	/** The entry's base URL, the other half of the configured identity. */
	readonly baseUrl: string;

	/** True when the last fetch succeeded within two poll intervals (polling off: usage.pollingOffFreshnessWindow). */
	readonly fresh: boolean;

	/** The /key/info standing: why spend numbers are missing or not updating. */
	readonly keyInfo: UsageEndpointStandingView;

	/** The /user/daily/activity standing: why request statistics are missing. */
	readonly dailyActivity: UsageEndpointStandingView;

	/** When the spend last updated; the "last updated" label renders it. */
	readonly lastUpdatedAt?: number | undefined;

	/** The key's server-side spend in USD, when /key/info reports one. */
	readonly spend?: number | undefined;

	/** What the budget bars and alerts run against: the entry's budget over the key's. */
	readonly effectiveBudget?: number | undefined;

	/** The key-reported max_budget, retained even when the entry's budget wins. */
	readonly keyBudget?: number | undefined;

	/** The entry's manual budget in USD, when set. */
	readonly entryBudget?: number | undefined;

	/** Which budget effectiveBudget took: the entry's, the key's, or none. */
	readonly budgetSource: "entry" | "key" | "none";

	/** spend / effectiveBudget; it can exceed 1 (the label shows the literal percentage). */
	readonly spentFraction?: number | undefined;

	/** The key's budget_reset_at, when it carries one. */
	readonly budgetResetAt?: number | undefined;

	/** The recent-window statistics, when /user/daily/activity answers. */
	readonly requests?:
		| {
				/** Every API request in the window. */
				readonly total: number;

				/** successfulRequests / total, when total > 0. */
				readonly successRate?: number | undefined;

				/** cacheReadInputTokens / promptTokens, when prompt tokens exist. */
				readonly cacheHitRate?: number | undefined;
		  }
		| undefined;
}

/**
 * A server left with no readable usage by a forbidden standing (401/403): actionable, so it gets a reduced card with no
 * spend numbers to fake. Merely-unsupported servers (a DB-less proxy) stay hidden instead. `keyInfo` and
 * `dailyActivity` are the standings behind the block.
 */
export interface UsageForbiddenServerView {
	readonly kind: "forbidden";
	readonly label: string;
	readonly baseUrl: string;
	readonly keyInfo: UsageEndpointStandingView;
	readonly dailyActivity: UsageEndpointStandingView;
}

export type UsageServerCardView = UsageServerView | UsageForbiddenServerView;

export interface DashboardUsage {
	/** One card per server whose proxy serves usage endpoints; a forbidden standing gets the reduced card. */
	readonly servers: readonly UsageServerCardView[];

	/** The normalized alert thresholds, ascending; empty = alerts off. */
	readonly thresholds: readonly number[];

	/** The effective poll interval; 0 = background polling off. */
	readonly pollIntervalMs: number;

	/** The effective discovery.timeout (each usage attempt's clock); the timeout detail line prints it. */
	readonly discoveryTimeoutMs: number;

	/** Whether a usage refresh pass is in flight (one serialized engine); disables Refresh now. */
	readonly refreshing: boolean;

	/** Only an explicit pass wears the busy label; scheduled polls update the numbers silently. */
	readonly refreshingExplicitly: boolean;

	/** When this snapshot was computed, as epoch ms. */
	readonly generatedAt: number;
}

/**
 * The legacy leftovers worth a dashboard hint; mirrors the migration's LegacyHintKind (never imported: that module is
 * host-only).
 */
type LegacyHintViewKind = "inert-url-scoped-key" | "inert-global-headers";

/**
 * How a diagnostic row renders: "warning" is a problem to fix, "advisory" an informational hint (the configuration
 * still applies as written). The same vocabulary as Logger.advisory in shared/logger.ts.
 */
export type ConfigDiagnosticSeverity = "warning" | "advisory";

/**
 * One diagnostics row. Free text here is structural configuration only (setting ids, record keys, header names), never
 * entered values.
 *
 *   "record"         -> `setting` names the record map (the setting id, or the entry field for entry layers) and
 *                       `entryLabel` the owning entry for entry-layer records, absent for the global settings;
 *                       `severity` is "advisory" exactly on the surviving unrecognized-key diagnostics (the field still
 *                       APPLIES as-is), and every other record diagnostic warns
 *   "entry"          -> one rejected or partially-ignored servers-setting entry, `misconfigured` when it is skipped
 *                       whole; `position` is 1-based in the raw array, for label-less entries; `rowOwned` says a server
 *                       row was drawn for it and carries its problems, so Diagnostics does not repeat them, while a
 *                       reject with no row has this list as its only report
 *   "legacy"         -> `oldKey` is the leftover key (a record key for scoped-key hints, the setting id for the headers
 *                       hints) and `detail` the setting id the leftover sits in
 *   "thresholds"     -> usage.alertThresholds entries outside (0, 1], dropped by normalization
 *   "number-setting" -> a number setting outside its contract (acceptsNumberSetting): the default is in effect, never
 *                       a clamped or rounded guess, and the configured value itself stays out (the key and its spec
 *                       are the facts)
 *   "setting-shape"  -> a record setting the normalizer refused: the whole map when `key` is absent (it reads as
 *                       empty), else the one model's entry (it reads as absent) because its value is not an object or
 *                       its name is reserved
 *   "credential"     -> a declared entry's stored credential the request path drops because the platform's Headers
 *                       would refuse it; requests go out without it until the key is entered again; `path` is the
 *                       entry field (auth.apiKey), never the value
 *   "hidden-groups"  -> provider groups hidden by an explicit user removal; labels only, never URLs beyond what the
 *                       hidden-groups line already shows
 */
export type ConfigDiagnosticView =
	| {
			readonly kind: "record";
			readonly setting: "models.parameters" | "models.capabilities";
			readonly entryLabel?: string | undefined;
			readonly diagnostic: RecordDiagnostic;
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			readonly kind: "entry";
			readonly label?: string | undefined;
			readonly position: number;
			readonly problems: readonly string[];
			readonly misconfigured: boolean;
			readonly rowOwned: boolean;
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			readonly kind: "legacy";
			readonly hint: LegacyHintViewKind;
			readonly oldKey: string;
			readonly detail: string;
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			readonly kind: "thresholds";
			readonly dropped: number;
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			readonly kind: "number-setting";
			readonly setting: NumberSettingId;
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			readonly kind: "setting-shape";
			readonly setting: "models.parameters" | "models.capabilities";
			readonly key?: string | undefined;
			readonly reason?: "not-object" | "reserved-name" | undefined;
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			readonly kind: "credential";
			readonly label: string;
			readonly path: string;
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			readonly kind: "hidden-groups";
			readonly labels: readonly string[];
			readonly severity: ConfigDiagnosticSeverity;
	  };

/**
 * Serialized on demand (the readResolvedModels request), never in state pushes: it scales with models x fields. Local
 * to the dashboard by design - never part of issue reports.
 */
export interface ResolvedModelsView {
	/** One tree per record map that holds records, in render order. */
	readonly trees: readonly RecordTreeView[];

	/** One row per (server, model), every resolved field with provenance. */
	readonly rows: readonly ResolvedModelRow[];

	/** Total records across every map; 0 drives the no-records empty state. */
	readonly recordCount: number;
}

/**
 * One record map's tree, roots first; `entryLabel` names the owning entry for entry-layer maps. `unmatchedModelIds`
 * are the models the map matches with no record at all (the implicit "everything else" leaf), and `invalidKeys` are
 * its invalid matcher keys, which match nothing and sit outside the tree.
 */
export interface RecordTreeView {
	readonly kind: "parameters" | "capabilities";
	readonly layer: "global" | "entry";
	readonly entryLabel?: string | undefined;
	readonly roots: readonly RecordTreeNode[];
	readonly unmatchedModelIds: readonly string[];
	readonly invalidKeys: readonly string[];
}

/**
 * One record as a tree node, nested under its next-broader match, computed against the live model set.
 *
 *   barrier     -> `_inherit_from` is false or the empty list: nothing flows past this record
 *   inheritFrom -> the `_inherit_from` directive rendered for display ("true" or the named keys); absent for the
 *                  default flow
 *   models      -> the models whose most specific match in this map is this record, with their resolved values
 */
export interface RecordTreeNode {
	readonly key: string;
	readonly fields: readonly {
		readonly name: string;
		readonly valueText: string;
		readonly inheritable: boolean;
		readonly forced: boolean;
		readonly fallback: boolean;
	}[];
	readonly barrier: boolean;
	readonly inheritFrom?: string | undefined;
	readonly children: readonly RecordTreeNode[];
	readonly models: readonly { readonly id: string; readonly resolvedText: string }[];
}

/** One link of a model's matching chain; `barrier` and `inheritFrom` read as RecordTreeNode's do. */
export interface RecordChainLink {
	readonly key: string;
	readonly barrier: boolean;
	readonly inheritFrom?: string | undefined;
}

/**
 * One record map's matching chain for an inspected model, broadest to most specific (the winner last). Computed
 * extension-side from the same matchChain the resolvers run; an entry-layer chain carries the entry's label so the
 * edit jump never guesses.
 */
export type RecordChainView =
	| { readonly layer: "global"; readonly links: readonly RecordChainLink[] }
	| { readonly layer: "entry"; readonly entryLabel: string; readonly links: readonly RecordChainLink[] };

/**
 * One resolved parameter with its provenance: `key` is the record whose literal field carries the value, `inheritedBy`
 * names the winning record when it inherited the value from `key`, and `forced` marks a `_force`d parameter, whose
 * record value beats the request's own runtime options.
 */
export interface ResolvedParamCell {
	readonly name: string;
	readonly valueText: string;
	readonly layer: "entry" | "global";
	readonly key: string;
	readonly inheritedBy?: string | undefined;
	readonly forced?: true | undefined;
}

/**
 * One resolved capability field with its provenance; `inheritedBy` names the level's winning record when it inherited
 * the value from `key`.
 */
export interface ResolvedCapCell {
	readonly name: string;
	readonly valueText: string;
	readonly level: CapabilityLevel;
	readonly key?: string | undefined;
	readonly inheritedBy?: string | undefined;
}

/**
 * One (server, model) row. `scopeKey` is the model's DashboardModel.scopeKey, for the per-row jump to the inspectors,
 * and `matchedKeys` every matcher key that matched the model in any map (the filter's "show everything gpt-5*
 * touched").
 */
export interface ResolvedModelRow {
	readonly serverLabel: string;
	readonly rawId: string;
	readonly scopeKey: string;
	readonly matchedKeys: readonly string[];
	readonly parameters: readonly ResolvedParamCell[];
	readonly capabilities: readonly ResolvedCapCell[];
}

/**
 * One row of the overall verdict's input (classifyOverall), the shape the status bar, the notifier, and the dashboard
 * hero all classify. Field names follow ServerStatus, so a status window is a row set as it is.
 *
 * The host builds the set once per surface from the status window joined with the declared entries (verdictRows) and
 * publishes the dashboard's copy here, so the webview classifies the host's rows instead of rebuilding them from the
 * servers table.
 */
export interface VerdictRow {
	/** ServerStatus knows ok and error alone: "unchecked" is a declared entry awaiting its first report (verdictRows). */
	readonly state: "ok" | "error" | "unchecked";

	/** May exceed zero on an error row: a failure still serving stale or declared models never reads as dead. */
	readonly servedModelCount: number;

	/** A failure the user declared expected (error rows only): it neither degrades nor fails the verdict. */
	readonly expected?: boolean | undefined;

	/** A group the user's configuration hides: answering, but counted apart in the zero-model detail. */
	readonly hiddenByRemoval?: boolean | undefined;

	/** A parser-refused entry: configuration, not transport, so it fails the verdict only when every row is one. */
	readonly misconfigured?: boolean | undefined;

	/** Why an error row fails and whose URL its text names, for the paste line (error rows only). */
	readonly failure?: { readonly cause: FailureCause; readonly baseUrl: string } | undefined;
}

/** One full state push; the webview never holds partial truth. */
export interface DashboardState {
	/** Every server row, sorted by label and then base URL. */
	readonly servers: readonly DashboardServer[];

	/** The provider groups hidden from the tables: removed by tombstone, or superseded by their entry's new base URL. */
	readonly hiddenGroups: readonly HiddenGroup[];

	/** The hero's and the paste line's verdict input: the same row set the status bar and the notifier classify. */
	readonly verdictRows: readonly VerdictRow[];

	/** The models table's rows, one per claimant of a multi-claimant snapshot, sorted by server label and then name. */
	readonly models: readonly DashboardModel[];

	/** What the hero and the paste line read, never models.length, which counts a snapshot once per claimant. */
	readonly servedModelCount: number;

	/** The union of the servers' sets over exactly the servers that reported one; absent is unknown, empty is known. */
	readonly observedModelInfoKeys?: readonly string[] | undefined;

	/** The settings pages' values and scopes. */
	readonly settings: DashboardSettings;

	/** The features whose model row offers a test probe: exactly those with a registered probe. */
	readonly featureProbes: readonly FeatureModelId[];

	/** The usage cards' snapshot. */
	readonly usage: DashboardUsage;

	/** The Diagnostics tab's rows. */
	readonly diagnostics: readonly ConfigDiagnosticView[];
}

/** The top-level sections, one tab each, in the rail's order; deep links (focusSection) name a tab by ID. */
export const DASHBOARD_SECTION_IDS = ["overview", "models", "features", "settings", "diagnostics"] as const;

/**
 * A tab ID, named across the boundary by the extension's focusSection message. The rail's order reads what the setup
 * IS (the servers, then the models they serve), then what it DOES (the features and the settings behind them), then
 * what is wrong with it. The retired "usage" id can still arrive in stale deep links; the shell's unknown-section
 * guard drops it.
 */
export type DashboardSectionId = (typeof DASHBOARD_SECTION_IDS)[number];

/** The two pages that render setting rows; every SettingRowId belongs to exactly one. */
export type SettingRowPageId = Extract<DashboardSectionId, "features" | "settings">;

/** The page owning each settings row, total over SettingRowId: a new row id fails to compile until it names a page. */
const SETTING_ROW_PAGES: { readonly [K in SettingRowId]: SettingRowPageId } = {
	"chat.timeout": "settings",
	"chat.maxToolsPerRequest": "settings",
	"discovery.timeout": "settings",
	"discovery.cacheTtl": "settings",
	"discovery.staleServeWindow": "settings",
	"usage.pollInterval": "settings",
	"usage.initialRefreshDelay": "settings",
	"usage.serversChangeRefreshDelay": "settings",
	"usage.pollingOffFreshnessWindow": "settings",
	"chat.promptCaching": "settings",
	"models.openRouterCatalog": "settings",
	"ui.maskSecretInputs": "settings",
	"logs.redactSecrets": "settings",
	"chat.additionalToolSchemaKeywords": "settings",
	"chat.tokenEstimation": "settings",
	"chat.sessionId": "settings",
	"usage.alertThresholds": "settings",
	"usage.statusBar": "settings",
	"usage.currencySymbol": "settings",
	"ui.theme": "settings",
	"ui.accent": "settings",
	"inlineCompletions.enabled": "features",
	"inlineCompletions.model": "features",
	"inlineCompletions.languageFilter": "features",
	"commitGeneration.enabled": "features",
	"commitGeneration.model": "features",
	"commitGeneration.prompt": "features",
	"prGeneration.enabled": "features",
	"prGeneration.model": "features",
	"consultTool.enabled": "features",
	"consultTool.model": "features",
	"quickFix.enabled": "features",
	"quickFix.model": "features",
	"reviewComments.enabled": "features",
	"reviewComments.model": "features",
	"chatParticipant.enabled": "features",
	"agentTools.enabled": "features",
	"agentTools.setSetting.enabled": "features",
	"agentTools.editModelRecords.enabled": "features",
	"agentTools.saveServer.enabled": "features",
	"agentTools.removeServer.enabled": "features",
	"agentTools.runAction.enabled": "features",
	"agentTools.secretValues.enabled": "features",
};

/**
 * The page a row lives on, total over any string: an id the map does not know reads as the Settings page instead of
 * crashing a lookup - the fail-open half of the owner-map contract (a misrouted notice beats a dead page).
 */
export function settingRowPage(row: string): SettingRowPageId {
	return Object.hasOwn(SETTING_ROW_PAGES, row) ? SETTING_ROW_PAGES[row as SettingRowId] : "settings";
}
