/**
 * Imported by both sides, so it must stay pure (no vscode, DOM, or Node). Everything here is derived on demand;
 * nothing is persisted.
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
	readonly modelParameters?: EntryModelParametersPayload | undefined;
	readonly modelCapabilities?: EntryModelCapabilitiesPayload | undefined;
	readonly expectedFailures?: readonly ExpectedFailureCategory[] | undefined;
	/** The entry's custom HTTP headers (plain settings text, not secrets); the edit form's prefill. */
	readonly headers?: Readonly<Record<string, string>> | undefined;
	/** The entry's discovery.declared model IDs, when it lists any. */
	readonly declaredModels?: readonly string[] | undefined;
	/** The entry's discovery.includeModes, when it names any. */
	readonly includeModes?: readonly NonChatMode[] | undefined;
	/** The entry's manual usage budget in USD, when set. */
	readonly budget?: number | undefined;
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

interface DashboardServerBase {
	readonly label: string;
	readonly baseUrl: string;
	/**
	 * How many models this server serves RIGHT NOW, regardless of state: the same field the merged counts and every
	 * serving verdict read. An error row still serving stale-window or declared models carries their count here.
	 */
	readonly servedModelCount: number;
	/**
	 * The last discovery attempt as epoch milliseconds, the push's one timestamp vocabulary; absent while unchecked
	 * (the host maps its "" never-checked sentinel and any unparseable stored value to absent).
	 */
	readonly lastChecked?: number | undefined;
	/**
	 * Three-valued because a declared row's "none" is a claim only a secret-blob read can back: while `config.secrets`
	 * is unproven and nothing else vouches for a key, the row says "unknown" instead of denying a secure key nobody
	 * read.
	 */
	readonly credentials: CredentialPresence;
	/**
	 * The credential kind beside that presence: OAuth client credentials, or a virtual-key header, rather than a
	 * static key. Declared rows derive it from the entry's units, external rows from the group's own report.
	 */
	readonly hasOAuth: boolean;
	readonly hasVirtualKey: boolean;
	/**
	 * The server's last successful /model/info key set, for the record editors' key suggestions.
	 *
	 *   absent                       -> no set available
	 *   empty                        -> a real answer
	 *   "__proto__" is a legal member -> membership tests go through Set/Map
	 */
	readonly observedModelInfoKeys?: readonly string[] | undefined;
	/**
	 * How many usable /model/info entries the last successful listing dropped per non-chat mode: the edit form offers
	 * includeModes on this evidence, and an all-dropped row explains its empty picker with it. Absent = nothing
	 * observed, like observedModelInfoKeys.
	 */
	readonly skippedModeCounts?: SkippedModeCounts | undefined;
}

/**
 * One server row: a declared entry, a live provider group, or both merged (joined by label and base URL). A declared
 * entry whose group sync failed is an "error" row even over a live group that keeps serving: the sync error outranks
 * the live state while `servedModelCount` keeps the live truth. A failing row carries its cause as a key, never as
 * text: the webview renders it in its locale and the copyable diagnostics block renders it in English.
 */
export type DashboardServer = DashboardServerBase &
	(
		| {
				readonly origin: "declared";
				readonly config: DashboardServerConfig;
				readonly adoptHandle?: undefined;
				readonly notices?: readonly DeclaredServerNotice[] | undefined;
				/**
				 * The live group did not join by this entry's exact labeled identity, so entry-only fields written NOW
				 * may not reach it either. Guards on entry-only WRITES must key on this flag, not the notices: an entry
				 * configuring no such field has the same problem and no notice.
				 */
				readonly entryFieldsInactive?: true | undefined;
				readonly provenance?: undefined;
				readonly problems?: undefined;
		  }
		| {
				/**
				 * A servers-setting entry the parser REFUSED: present in the setting, never synced or served until
				 * fixed. `problems` carries the parser's English structural reports (configuration key names only,
				 * never entered values).
				 *
				 *   No `config`: the broken shape cannot round-trip through the edit form -> the row's Fix action
				 *                                                                          reveals it in settings.json
				 *                                                                          instead
				 */
				readonly origin: "misconfigured";
				readonly problems: readonly string[];
				readonly config?: undefined;
				readonly adoptHandle?: undefined;
				readonly notices?: undefined;
				readonly entryFieldsInactive?: undefined;
				readonly provenance?: undefined;
		  }
		| {
				/**
				 * A live group a declared label left behind and still serves from: its configuration stamp names the
				 * label, or it holds the label's stored secret, while no entry's current configuration matches it (a
				 * rotated identity, a moved entry's unstamped group, a label the setting now rejects). Not in the
				 * setting, not the user's own: no Edit, no adopt, no hide, never a credential source; deleting it is
				 * the host's job (Manage Language Models, or the models file).
				 */
				readonly origin: "legacy";
				/** The declared label the group belongs to. */
				readonly entryLabel: string;
				/** The group's opaque per-session token (the same mint as adoptHandle), the row's key across pushes. */
				readonly groupHandle: string;
				readonly config?: undefined;
				readonly adoptHandle?: undefined;
				readonly notices?: undefined;
				readonly entryFieldsInactive?: undefined;
				readonly provenance?: undefined;
				readonly problems?: undefined;
		  }
		| {
				/**
				 * A provider group managed outside the setting; Remove (hide) always applies to it, by tombstone.
				 * `adoptHandle` is the opaque token the adopt intent names its source group by: a salted one-way hash,
				 * stable for the session, carrying no credential material, resolvable only while the group stays
				 * external.
				 */
				readonly origin: "external";
				readonly adoptHandle: string;
				/**
				 * The label the group's configuration is stamped with. The sync engine names the groups it creates after
				 * their entry, so the stamp is usually the host-side name (which the host refuses to reuse), but a group
				 * the host named itself can carry any stamp: the edit form advises on a collision, never refuses. Absent
				 * for an unstamped group.
				 */
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
				/**
				 * ServerStatusOk.modelInfoUnsupported, on declared rows only (the fix lives on an entry).
				 * Classification only; copy renders webview-side.
				 */
				readonly modelInfoUnsupported?: UnservedEndpointEvidence | undefined;
		  }
		| {
				readonly state: "error";
				/**
				 * Why the row fails, as a key (shared/failureCause.ts): the webview renders it in its locale, the paste
				 * line in English; it carries no message text, so it crosses the webview boundary as data.
				 */
				readonly cause: FailureCause;
				/**
				 * True when the failure hit a category the entry's expectedFailures declares: the outcome stays a
				 * truthful error (the stale anchor and counts depend on it), but presentation treats it as expected.
				 */
				readonly expected?: boolean | undefined;
				/** The declared subset of servedModelCount; drives the "N declared models" wording. */
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

/** Costs are USD per million tokens, as registration converted them. */
export interface DashboardModel {
	readonly id: string;
	/**
	 * The model ID as the server knows it: what a request's `model` field and a modelParameters prefix match against.
	 * Differs from `id` on registrations that mint exposed IDs of their own (aggregate `:cheapest`/`:fastest`
	 * variants).
	 */
	readonly rawId: string;
	/**
	 * Opaque per-session handle for the serving server (a salted hash of the server ID): a stale key de-resolves
	 * instead of hitting another server. Never persisted.
	 */
	readonly scopeKey: string;
	readonly name: string;
	readonly family: string;
	readonly serverLabel: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	/** The request's max_tokens when nothing configures one; under maxOutputTokens when a guessed limit exceeds the cap. */
	readonly defaultMaxTokens: number;
	readonly inputCost?: number | undefined;
	readonly outputCost?: number | undefined;
	readonly cacheReadCost?: number | undefined;
	readonly cacheWriteCost?: number | undefined;
	/** Long-context tier costs; present only when the tier differs from the base price. */
	readonly longContextInputCost?: number | undefined;
	readonly longContextOutputCost?: number | undefined;
	readonly longContextCacheReadCost?: number | undefined;
	readonly longContextCacheWriteCost?: number | undefined;
	readonly toolCalling: boolean;
	readonly imageInput: boolean;
	readonly promptCaching: boolean;
	/** True when the model advertises the reasoning-effort configuration control. */
	readonly reasoning: boolean;
	/** True for a declared model (discovery does not list it); drives the declared badge. */
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
	| "commitGeneration.prompt";

/**
 * A readonly list typechecked as naming every member of T: an omitted union member makes the argument unsatisfiable, so
 * extending a setting-id union fails compilation here.
 */
const everyId =
	<T extends string>() =>
	<L extends readonly T[]>(ids: Exclude<T, L[number]> extends never ? L : never): readonly T[] =>
		ids;

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
	| "commitGeneration.prompt";

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
	readonly editScope: SettingScope;
	/** The record the edit scope itself holds; what the editor edits and writes back whole. */
	readonly value: Readonly<Record<string, V>>;
	/** Non-empty records held by other scopes, read-only in the dashboard. */
	readonly otherScopes: readonly { readonly scope: SettingScope; readonly value: Readonly<Record<string, V>> }[];
	/**
	 * The scope-merged record exactly as the request path reads it: read-only display truth for the effective-values
	 * inspector, while the editors above keep editing single scopes.
	 */
	readonly effective: Readonly<Record<string, V>>;
}

/** Scalars are the effective values; records are per-scope. */
export interface DashboardSettings {
	readonly numbers: Readonly<Record<NumberSettingId, number | null>>;
	readonly booleans: Readonly<Record<BooleanSettingId, boolean>>;
	/**
	 * The highest-precedence scope each scalar is explicitly configured in, or null when only the default applies.
	 * "Modified" means the key is set somewhere, matching the native Settings editor, and the named scope is the one a
	 * reset removes first.
	 */
	readonly configuredScopes: {
		readonly numbers: Readonly<Record<NumberSettingId, SettingScope | null>>;
		readonly booleans: Readonly<Record<BooleanSettingId, SettingScope | null>>;
	};
	readonly modelParameters: ScopedRecordSetting<Readonly<Record<string, unknown>>>;
	readonly modelCapabilities: ScopedRecordSetting<Readonly<Record<string, unknown>>>;
	readonly catalog: CatalogStatusView;
	/**
	 * The dashboard's own theme and accent, plus where each is configured. On every state push because the webview
	 * restamps the root element from it - what makes a change land on an open dashboard.
	 */
	readonly appearance: {
		readonly theme: UiTheme;
		readonly themeScope: SettingScope | null;
		readonly accent: UiAccent;
		readonly accentScope: SettingScope | null;
	};
	readonly chat: {
		readonly tokenEstimation: TokenEstimationMode;
		readonly tokenEstimationScope: SettingScope | null;
		readonly additionalToolSchemaKeywords: StringListSetting;
	};
	readonly usage: {
		readonly statusBarMode: UsageStatusBarMode;
		readonly statusBarScope: SettingScope | null;
		/** The configured thresholds as normalization reads them (valid fractions, deduplicated, ascending). */
		readonly alertThresholds: readonly number[];
		readonly thresholdsScope: SettingScope | null;
		/**
		 * The prefix every spend and cost figure renders with (display only, never a conversion); the empty string
		 * renders the bare number.
		 */
		readonly currencySymbol: string;
		readonly currencySymbolScope: SettingScope | null;
	};
	/**
	 * Each feature's configured model ref, null while unset or malformed. User configuration only - an entry label
	 * and a raw model ID, never a secret.
	 */
	readonly featureModels: Readonly<Record<FeatureModelId, FeatureModelRef | null>>;
	readonly featureModelScopes: Readonly<Record<FeatureModelId, SettingScope | null>>;
	/** The commitGeneration.prompt row's value; "" means the built-in instruction applies. */
	readonly commitPrompt: string;
	readonly commitPromptScope: SettingScope | null;
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
 * only. Servers whose proxy serves no usage endpoints never appear here.
 */
export interface UsageServerView {
	readonly kind: "usage";
	readonly label: string;
	readonly baseUrl: string;
	/**
	 * Fresh under the polling rule: last fetch OK and younger than two poll intervals (with polling off, than
	 * usage.pollingOffFreshnessWindow). Stale data still renders, labeled with its age.
	 */
	readonly fresh: boolean;
	/** The /key/info standing: why spend numbers are missing or not updating. */
	readonly keyInfo: UsageEndpointStandingView;
	/** The /user/daily/activity standing: why request statistics are missing. */
	readonly dailyActivity: UsageEndpointStandingView;
	/**
	 *   Epoch ms -> the "last updated" label
	 */
	readonly lastUpdatedAt?: number | undefined;
	/** The key's server-side spend in USD, when /key/info reports one. */
	readonly spend?: number | undefined;
	/** The budget bars and alerts run against: entry over key. */
	readonly effectiveBudget?: number | undefined;
	/** The key-reported max_budget, retained even when the entry's budget wins. */
	readonly keyBudget?: number | undefined;
	readonly entryBudget?: number | undefined;
	readonly budgetSource: "entry" | "key" | "none";
	/** spend / effectiveBudget; can exceed 1 (the label shows the literal percentage). */
	readonly spentFraction?: number | undefined;
	/** The key's budget_reset_at as epoch ms, when it carries one. */
	readonly budgetResetAt?: number | undefined;
	/** The recent-window request statistics, when /user/daily/activity answers. */
	readonly requests?:
		| {
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
 * spend numbers to fake. Merely-unsupported servers (a DB-less proxy) stay hidden instead.
 */
export interface UsageForbiddenServerView {
	readonly kind: "forbidden";
	readonly label: string;
	readonly baseUrl: string;
	/** The /key/info standing behind the block. */
	readonly keyInfo: UsageEndpointStandingView;
	/** The /user/daily/activity standing behind the block. */
	readonly dailyActivity: UsageEndpointStandingView;
}

export type UsageServerCardView = UsageServerView | UsageForbiddenServerView;

export interface DashboardUsage {
	readonly servers: readonly UsageServerCardView[];
	/** The normalized alert thresholds, ascending; empty = alerts off. */
	readonly thresholds: readonly number[];
	/** The effective poll interval; 0 = background polling off. */
	readonly pollIntervalMs: number;
	/** The effective discovery.timeout (the usage requests' whole-call bound); the timeout detail line prints it. */
	readonly discoveryTimeoutMs: number;
	/** Whether a usage refresh pass is in flight (one serialized engine); disables Refresh now. */
	readonly refreshing: boolean;
	/** Only an explicit pass wears the busy label; scheduled polls update the numbers silently. */
	readonly refreshingExplicitly: boolean;
	/**
	 *   When this snapshot was computed -> epoch ms
	 */
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

/** Free text here is structural configuration only (setting ids, record keys, header names) - never entered values. */
export type ConfigDiagnosticView =
	| {
			readonly kind: "record";
			/** Which record map: the setting id, or the entry field for entry layers. */
			readonly setting: "models.parameters" | "models.capabilities";
			/** The owning entry's label for entry-layer records; absent for the global settings. */
			readonly entryLabel?: string | undefined;
			readonly diagnostic: RecordDiagnostic;
			/**
			 * "advisory" exactly on the surviving unrecognized-key diagnostics (the field still APPLIES as-is); every
			 * other record diagnostic warns.
			 */
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			/**
			 * One rejected or partially-ignored servers-setting entry; `misconfigured` when the entry is skipped
			 * whole.
			 */
			readonly kind: "entry";
			readonly label?: string | undefined;
			/** The entry's 1-based position in the raw array, for label-less entries. */
			readonly position: number;
			readonly problems: readonly string[];
			readonly misconfigured: boolean;
			/**
			 * Whether a server row was drawn for this entry: a reject with a row has its problems there, so Diagnostics
			 * does not repeat them; a reject without one has no row, and this list is its only report.
			 */
			readonly rowOwned: boolean;
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			readonly kind: "legacy";
			readonly hint: LegacyHintViewKind;
			/** The leftover key: a record key for scoped-key hints, the setting id for the headers hints. */
			readonly oldKey: string;
			/** The setting id the leftover sits in. */
			readonly detail: string;
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			/** usage.alertThresholds entries outside (0, 1], dropped by normalization. */
			readonly kind: "thresholds";
			readonly dropped: number;
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			/**
			 * A number setting outside its contract (acceptsNumberSetting); the default is in effect, never a clamped or
			 * rounded guess. The configured value itself stays out: the key and its spec are the facts.
			 */
			readonly kind: "number-setting";
			readonly setting: NumberSettingId;
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			/**
			 * A record setting the normalizer refused: the whole map when `key` is absent (it reads as empty), else the
			 * one model's entry (it reads as absent) because its value is not an object or its name is reserved.
			 */
			readonly kind: "setting-shape";
			readonly setting: "models.parameters" | "models.capabilities";
			readonly key?: string | undefined;
			readonly reason?: "not-object" | "reserved-name" | undefined;
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			/**
			 * A declared entry's stored credential the request path drops because the platform's Headers would refuse
			 * it; requests go out without it until the key is entered again. `path` is the entry field (auth.apiKey),
			 * never the value.
			 */
			readonly kind: "credential";
			readonly label: string;
			readonly path: string;
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			/**
			 * Provider groups hidden by an explicit user removal. Labels only,
			 * never URLs beyond what the hidden-groups line already shows.
			 */
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

export interface RecordTreeView {
	readonly kind: "parameters" | "capabilities";
	readonly layer: "global" | "entry";
	/** The owning entry's label for entry-layer maps. */
	readonly entryLabel?: string | undefined;
	readonly roots: readonly RecordTreeNode[];
	/** Models this map matches with no record at all (the implicit "everything else" leaf). */
	readonly unmatchedModelIds: readonly string[];
	/** Invalid matcher keys in this map; they match nothing and sit outside the tree. */
	readonly invalidKeys: readonly string[];
}

/**
 *   One record as a tree node -> nested under its next-broader match, computed against the live model set
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
	/** True when `_inherit_from` is false or the empty list: nothing flows past this record. */
	readonly barrier: boolean;
	/** The `_inherit_from` directive rendered for display ("true" or the named keys); absent for the default flow. */
	readonly inheritFrom?: string | undefined;
	readonly children: readonly RecordTreeNode[];
	/** Models whose most specific match in this map is this record, with their resolved values. */
	readonly models: readonly { readonly id: string; readonly resolvedText: string }[];
}

export interface RecordChainLink {
	readonly key: string;
	/** True when `_inherit_from` is false or the empty list: nothing flows past this record. */
	readonly barrier: boolean;
	/** The `_inherit_from` directive rendered for display ("true" or the named keys); absent for the default flow. */
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

export interface ResolvedParamCell {
	readonly name: string;
	readonly valueText: string;
	readonly layer: "entry" | "global";
	/** The record key whose literal field carries the value. */
	readonly key: string;
	/** Present when the winning record inherited the value from `key`; names that winning record. */
	readonly inheritedBy?: string | undefined;
	readonly forced?: true | undefined;
}

export interface ResolvedCapCell {
	readonly name: string;
	readonly valueText: string;
	readonly level: CapabilityLevel;
	readonly key?: string | undefined;
	/** Present when the level's winning record inherited the value from `key`; names that winning record. */
	readonly inheritedBy?: string | undefined;
}

export interface ResolvedModelRow {
	readonly serverLabel: string;
	readonly rawId: string;
	/** The model's scope key (DashboardModel.scopeKey), for the per-row jump to the inspectors. */
	readonly scopeKey: string;
	/** Every matcher key that matched this model in any map; the filter's "show everything gpt-5* touched". */
	readonly matchedKeys: readonly string[];
	readonly parameters: readonly ResolvedParamCell[];
	readonly capabilities: readonly ResolvedCapCell[];
}

/**
 * One row of the overall verdict's input (classifyOverall), the shape the status bar, the notifier, and the dashboard
 * hero all classify. The host builds the set once per surface from the status window joined with the declared entries
 * (verdictRows) and publishes the dashboard's copy here, so the webview classifies the host's rows instead of
 * rebuilding them from the servers table. Field names follow ServerStatus, so a status window is a row set as it is.
 */
export interface VerdictRow {
	readonly state: "ok" | "error" | "unchecked";
	readonly servedModelCount: number;
	readonly expected?: boolean | undefined;
	/** A group the user's configuration hides: answering, but counted apart in the zero-model detail. */
	readonly hiddenByRemoval?: boolean | undefined;
	/** A parser-refused entry's row: configuration, not transport, so it fails the fleet only when nothing else is there. */
	readonly misconfigured?: boolean | undefined;
	/** Why an error row fails and whose URL its text names, for the paste line (error rows only). */
	readonly failure?: { readonly cause: FailureCause; readonly baseUrl: string } | undefined;
}

export interface DashboardState {
	readonly servers: readonly DashboardServer[];
	readonly hiddenGroups: readonly HiddenGroup[];
	/** The hero's and the paste line's verdict input: the same row set the status bar and the notifier classify. */
	readonly verdictRows: readonly VerdictRow[];
	readonly models: readonly DashboardModel[];
	/**
	 * The hero and the diagnostics paste line read this, never models.length - the models table lists a
	 * multi-claimant snapshot once per claimant, so the row count can overcount what the window actually serves.
	 */
	readonly servedModelCount: number;
	/**
	 * The union of the servers' observedModelInfoKeys, across exactly the servers that reported a set. Absent =
	 * unknown, empty = known and empty; same handling rules as the per-server field.
	 */
	readonly observedModelInfoKeys?: readonly string[] | undefined;
	readonly settings: DashboardSettings;
	/**
	 * The features whose model row offers a host-side test probe (the exact pipeline the feature itself runs). Derived
	 * from the probes activation registered, so the button exists exactly where a probe does.
	 */
	readonly featureProbes: readonly FeatureModelId[];
	readonly usage: DashboardUsage;
	readonly diagnostics: readonly ConfigDiagnosticView[];
}

/**
 * The dashboard's top-level sections, one tab each, in the rail's order: what the fleet IS (servers, then the models
 * they serve), then what it DOES (features and the settings behind them), then what is wrong with it. Declared here
 * because deep links cross the boundary: the extension's focusSection message names a tab by ID.
 *
 *   The retired "usage" id can still arrive in stale deep links -> the shell's unknown-section guard drops those
 */
export const DASHBOARD_SECTION_IDS = ["overview", "models", "features", "settings", "diagnostics"] as const;

export type DashboardSectionId = (typeof DASHBOARD_SECTION_IDS)[number];

/** The two pages that render setting rows; every SettingRowId belongs to exactly one. */
export type SettingRowPageId = Extract<DashboardSectionId, "features" | "settings">;

/**
 * Which page owns each settings row: the Features page carries the per-feature rows, the Settings page everything
 * else. TOTAL over SettingRowId by mapped type, so a new row id fails compilation until it names its page - and the
 * consumers' lookups fail OPEN (an id missing at runtime renders visible on the Settings page rather than crashing),
 * which settingRowPage encodes.
 */
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
	"chat.additionalToolSchemaKeywords": "settings",
	"chat.tokenEstimation": "settings",
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
