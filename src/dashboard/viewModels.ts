/**
 * The dashboard's view models: the state the extension pushes into the
 * webview. Imported by both sides, so it must stay pure (no vscode, DOM, or
 * Node). Everything here is derived on demand; nothing is persisted.
 */

import type { CapabilityLevel } from "../shared/config/capabilityResolution";
import type { RecordDiagnostic } from "../shared/config/recordResolution";
import type {
	BooleanSettingId,
	NumberSettingId,
	TokenEstimationMode,
	UiAccent,
	UiTheme,
} from "../shared/config/settingSpec";
import { BOOLEAN_SETTING_SPECS, NUMBER_SETTING_SPECS } from "../shared/config/settingSpec";
import type { TransportErrorClassification, UnservedEndpointEvidence } from "../shared/errorClassification";
import type {
	ExpectedFailureCategory,
	NonSecretOptionalFields,
	SecretFieldId,
	SecretLocation,
} from "../shared/serverEntry";

/** A per-entry modelParameters record: model-ID prefix to request parameters. Non-secret user configuration. */
export type EntryModelParametersPayload = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** A per-entry modelCapabilities record: model-ID prefix to capability fields and directives. Non-secret. */
export type EntryModelCapabilitiesPayload = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The non-secret configuration of a declared server, for the edit form's prefill. */
interface DashboardServerConfig extends NonSecretOptionalFields {
	/** Where each secret currently lives; the values themselves never reach the webview. */
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;
	/** The entry's apiVersion override ("" is a real value: append nothing); the edit form's prefill. */
	readonly apiVersion?: string | undefined;
	/** The entry's own modelParameters, when it has any; the edit form's prefill. */
	readonly modelParameters?: EntryModelParametersPayload | undefined;
	/** The entry's own modelCapabilities, when it has any; the edit form's prefill. */
	readonly modelCapabilities?: EntryModelCapabilitiesPayload | undefined;
	/** The entry's expected discovery-failure categories, when it declares any. */
	readonly expectedFailures?: readonly ExpectedFailureCategory[] | undefined;
	/** The entry's custom HTTP headers (plain settings text, not secrets); the edit form's prefill. */
	readonly headers?: Readonly<Record<string, string>> | undefined;
	/** The entry's discovery.declared model IDs, when it lists any. */
	readonly declaredModels?: readonly string[] | undefined;
	/** The entry's manual usage budget in USD, when set. */
	readonly budget?: number | undefined;
}

/**
 * Row-level warning classifications for declared entries; only the
 * classification crosses the boundary, copy renders webview-side. The
 * InactiveEntryNotice family means the live group did not join by the entry's
 * exact labeled identity, so its entry-only fields may not apply until the
 * group is recreated. The webview derives every badge from this union, so a
 * new member fails compilation until its presentation exists.
 */
export type InactiveEntryNotice =
	| "entry-params-inactive"
	| "entry-capabilities-inactive"
	| "entry-headers-inactive"
	| "entry-api-version-inactive";

export type DeclaredServerNotice = InactiveEntryNotice | "expected-failures-nothing-declared";

/**
 * Why an external group exists, when removal bookkeeping knows; absent for
 * groups added outside this extension. Classifications and labels only, never
 * free text.
 */
export type ExternalServerProvenance =
	| { readonly kind: "removed-entry-leftover"; readonly removedLabel: string }
	| { readonly kind: "rename-leftover"; readonly oldLabel: string; readonly newLabel: string };

/**
 * One tombstoned provider group: serves no models, rendered only on the
 * hidden-groups line. The identity is what the unhideServer intent echoes.
 */
export interface HiddenGroup {
	readonly label: string;
	readonly baseUrl: string;
}

interface DashboardServerBase {
	readonly label: string;
	readonly baseUrl: string;
	readonly modelCount: number;
	/** ISO timestamp of the last discovery attempt; absent while unchecked. */
	readonly lastChecked?: string | undefined;
	/** Whether the server has credentials configured anywhere; never the credentials themselves. */
	readonly hasApiKey: boolean;
	readonly hasOAuth: boolean;
	/**
	 * The server's last successful /model/info key set, for the record editors'
	 * key suggestions. Absence and the empty array differ: absent = no set
	 * available, empty = a real answer. Server-derived strings: render-only,
	 * never logged, and membership tests go through Set/Map ("__proto__" is a
	 * legal member).
	 */
	readonly observedModelInfoKeys?: readonly string[] | undefined;
}

/**
 * One server row: a declared entry, a live provider group, or both merged
 * (joined by label and base URL). Secrets never reach the webview; only their
 * locations do. An "ok" row may STILL carry an error (a declared entry whose
 * group upsert failed while a live group keeps serving). `errorEnglish` is the
 * log-safe English rendering the copyable diagnostics block substitutes, so
 * pasted reports stay English.
 */
export type DashboardServer = DashboardServerBase &
	(
		| {
				/** In the servers setting (editable here); `config` is the edit form's prefill. */
				readonly origin: "declared";
				readonly config: DashboardServerConfig;
				readonly adoptHandle?: undefined;
				/** Warning classifications for the row, when any apply; see DeclaredServerNotice. */
				readonly notices?: readonly DeclaredServerNotice[] | undefined;
				/**
				 * The live group did not join by this entry's exact labeled identity,
				 * so entry-only fields written NOW may not reach it either. Guards on
				 * entry-only WRITES must key on this flag, not the notices: an entry
				 * configuring no such field has the same problem and no notice.
				 */
				readonly entryFieldsInactive?: true | undefined;
				readonly provenance?: undefined;
				readonly hideable?: undefined;
				readonly problems?: undefined;
		  }
		| {
				/**
				 * A servers-setting entry the parser REFUSED: present in the setting,
				 * never synced or served until fixed. `problems` carries the parser's
				 * English structural reports (configuration key names only, never
				 * entered values). No `config`: the broken shape cannot round-trip
				 * through the edit form, so the row's Fix action reveals it in
				 * settings.json instead.
				 */
				readonly origin: "misconfigured";
				readonly problems: readonly string[];
				readonly config?: undefined;
				readonly adoptHandle?: undefined;
				readonly notices?: undefined;
				readonly entryFieldsInactive?: undefined;
				readonly provenance?: undefined;
				readonly hideable?: undefined;
		  }
		| {
				/**
				 * A provider group managed outside the setting. `adoptHandle` is the
				 * opaque token the adopt intent names its source group by: a salted
				 * one-way hash, stable for the session, carrying no credential
				 * material, resolvable only while the group stays external.
				 */
				readonly origin: "external";
				readonly adoptHandle: string;
				readonly config?: undefined;
				readonly notices?: undefined;
				readonly entryFieldsInactive?: undefined;
				/** Why the group exists, when a removal or rename explains it; see ExternalServerProvenance. */
				readonly provenance?: ExternalServerProvenance | undefined;
				/**
				 * Whether Remove (hide) applies: false for legacy-registry rows, whose
				 * models the registry path would keep serving after a hide.
				 */
				readonly hideable: boolean;
				readonly problems?: undefined;
		  }
	) &
	(
		| {
				readonly state: "ok";
				readonly error?: string | undefined;
				readonly errorEnglish?: string | undefined;
				readonly classification?: undefined;
				readonly expected?: undefined;
				readonly declaredModelCount?: undefined;
				/**
				 * ServerStatusOk.modelInfoUnsupported, on declared rows only (the fix
				 * lives on an entry). Classification only; copy renders webview-side.
				 */
				readonly modelInfoUnsupported?: UnservedEndpointEvidence | undefined;
		  }
		| {
				readonly state: "error";
				readonly error: string;
				readonly errorEnglish?: string | undefined;
				/**
				 * The transport classification behind the row's error (enum ids and a
				 * status number, never message text, so it may cross the webview
				 * boundary); present only when `error` IS the transport error.
				 */
				readonly classification?: TransportErrorClassification | undefined;
				/**
				 * True when the failure hit a category the entry's expectedFailures
				 * declares: the outcome stays a truthful error (the stale anchor and
				 * counts depend on it), but presentation treats it as expected.
				 */
				readonly expected?: boolean | undefined;
				/** How many declared models this server keeps serving despite the failure. */
				readonly declaredModelCount?: number | undefined;
				readonly modelInfoUnsupported?: undefined;
		  }
		| {
				readonly state: "unchecked";
				readonly error?: undefined;
				readonly errorEnglish?: undefined;
				readonly classification?: undefined;
				readonly expected?: undefined;
				readonly declaredModelCount?: undefined;
				readonly modelInfoUnsupported?: undefined;
		  }
	);

/**
 * DashboardServer narrowed by origin; declared here because two webview
 * modules need them and neither should import a type from the other.
 */
export type DeclaredDashboardServer = Extract<DashboardServer, { origin: "declared" }>;
export type ExternalDashboardServer = Extract<DashboardServer, { origin: "external" }>;

/** One registered model, reduced to display facts. Costs are USD per million tokens, as registration converted them. */
export interface DashboardModel {
	readonly id: string;
	/**
	 * The model ID as the server knows it: what a request's `model` field and a
	 * modelParameters prefix match against. Differs from `id` only on
	 * legacy-registry multi-server registrations, where `id` is namespaced.
	 */
	readonly rawId: string;
	/**
	 * Opaque per-session handle for the serving server (a salted hash of the
	 * server ID): a stale key de-resolves instead of hitting another server.
	 * Never persisted.
	 */
	readonly scopeKey: string;
	readonly name: string;
	readonly family: string;
	readonly serverLabel: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	/** Whether the server declared the output limit; gates the request's max_tokens cap (see resolveMaxTokens). */
	readonly outputLimitDeclared: boolean;
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
 * The settings the revealSetting intent may name: exactly what the Settings
 * tab renders rows or editors for. A classification list, not free text.
 */
export type RevealableSettingId =
	| NumberSettingId
	| BooleanSettingId
	| "models.parameters"
	| "models.capabilities"
	| "servers"
	| "chat.additionalToolSchemaKeywords"
	| "chat.tokenEstimation"
	| "usage.alertThresholds"
	| "usage.statusBar"
	| "usage.currencySymbol"
	| "ui.theme"
	| "ui.accent";

/**
 * A readonly list typechecked as naming every member of T: an omitted union
 * member makes the argument unsatisfiable, so extending a setting-id union
 * fails compilation here.
 */
const everyId =
	<T extends string>() =>
	<L extends readonly T[]>(ids: Exclude<T, L[number]> extends never ? L : never): readonly T[] =>
		ids;

export const REVEALABLE_SETTING_IDS: readonly RevealableSettingId[] = everyId<RevealableSettingId>()([
	...NUMBER_SETTING_IDS,
	...BOOLEAN_SETTING_IDS,
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
]);

/** The settings the resetSetting intent may name: the scalar rows plus the non-scalar chat, usage, and appearance rows. */
export type ResettableSettingId =
	| NumberSettingId
	| BooleanSettingId
	| "chat.additionalToolSchemaKeywords"
	| "chat.tokenEstimation"
	| "usage.statusBar"
	| "usage.alertThresholds"
	| "usage.currencySymbol"
	| "ui.theme"
	| "ui.accent";

export const RESETTABLE_SETTING_IDS: readonly ResettableSettingId[] = everyId<ResettableSettingId>()([
	...NUMBER_SETTING_IDS,
	...BOOLEAN_SETTING_IDS,
	"chat.additionalToolSchemaKeywords",
	"chat.tokenEstimation",
	"usage.statusBar",
	"usage.alertThresholds",
	"usage.currencySymbol",
	"ui.theme",
	"ui.accent",
]);

/**
 * The settings the Settings tab renders a row for: exactly the overlap of the
 * two gestures every row offers, so a merely revealable setting cannot reach a
 * row by mistake.
 */
export type SettingRowId = ResettableSettingId & RevealableSettingId;

/** The configuration scopes a setting value can live in, in ascending precedence. */
export type SettingScope = "global" | "workspace" | "workspaceFolder";

/**
 * An object setting split by configuration scope. VS Code shallow-merges
 * object settings across scopes, so an editor over the merged value would copy
 * user-scope entries into workspace files and could never delete an entry from
 * the other scope; the dashboard edits exactly one scope's own record.
 */
export interface ScopedRecordSetting<V> {
	readonly editScope: SettingScope;
	/** The record the edit scope itself holds; what the editor edits and writes back whole. */
	readonly value: Readonly<Record<string, V>>;
	/** Non-empty records held by other scopes, read-only in the dashboard. */
	readonly otherScopes: readonly { readonly scope: SettingScope; readonly value: Readonly<Record<string, V>> }[];
	/**
	 * The scope-merged record exactly as the request path reads it: read-only
	 * display truth for the effective-values inspector, while the editors above
	 * keep editing single scopes.
	 */
	readonly effective: Readonly<Record<string, V>>;
}

/** The usage.statusBar enum, re-declared here so the webview bundle needs no settings-module import. */
export type UsageStatusBarModeSetting = "always" | "alerts-only" | "off";

/** The settings snapshot the dashboard renders. Scalars are the effective values; records are per-scope. */
export interface DashboardSettings {
	readonly numbers: Readonly<Record<NumberSettingId, number | null>>;
	readonly booleans: Readonly<Record<BooleanSettingId, boolean>>;
	/**
	 * The highest-precedence scope each scalar is explicitly configured in, or
	 * null when only the default applies. "Modified" means the key is set
	 * somewhere, matching the native Settings editor, and the named scope is the
	 * one a reset removes first.
	 */
	readonly configuredScopes: {
		readonly numbers: Readonly<Record<NumberSettingId, SettingScope | null>>;
		readonly booleans: Readonly<Record<BooleanSettingId, SettingScope | null>>;
	};
	readonly modelParameters: ScopedRecordSetting<Readonly<Record<string, unknown>>>;
	/** The models.capabilities twin of modelParameters; the Settings tab's second record editor. */
	readonly modelCapabilities: ScopedRecordSetting<Readonly<Record<string, unknown>>>;
	/** The OpenRouter catalog row's status line; see CatalogStatusView. */
	readonly catalog: CatalogStatusView;
	/**
	 * The dashboard's own theme and accent, plus where each is configured. On
	 * every state push because the webview restamps the root element from it -
	 * what makes a change land on an open dashboard.
	 */
	readonly appearance: {
		readonly theme: UiTheme;
		readonly themeScope: SettingScope | null;
		readonly accent: UiAccent;
		readonly accentScope: SettingScope | null;
	};
	/** The Chat group's non-scalar tail: the chat.tokenEstimation enum row and the schema-keywords list row. */
	readonly chat: {
		readonly tokenEstimation: TokenEstimationMode;
		readonly tokenEstimationScope: SettingScope | null;
		/** The configured chat.additionalToolSchemaKeywords as normalization reads them (non-empty strings, deduplicated). */
		readonly additionalToolSchemaKeywords: readonly string[];
		/**
		 * Whether normalization DROPPED anything from the raw configured value.
		 * Without this flag the row cannot tell a clean list from one hiding
		 * entries a dashboard edit would silently destroy, and must fall back to
		 * read-only instead.
		 */
		readonly additionalToolSchemaKeywordsLossy: boolean;
		readonly additionalToolSchemaKeywordsScope: SettingScope | null;
	};
	/** The non-scalar usage settings' rows (the enum, the fraction list, and the currency symbol). */
	readonly usage: {
		readonly statusBarMode: UsageStatusBarModeSetting;
		readonly statusBarScope: SettingScope | null;
		/** The configured thresholds as normalization reads them (valid fractions, deduplicated, ascending). */
		readonly alertThresholds: readonly number[];
		readonly thresholdsScope: SettingScope | null;
		/**
		 * The prefix every spend and cost figure renders with (display only,
		 * never a conversion); the empty string renders the bare number.
		 */
		readonly currencySymbol: string;
		readonly currencySymbolScope: SettingScope | null;
	};
}

/**
 * The models.openRouterCatalog row's status. `lastFailure.classification` is
 * a fixed English vocabulary ("HTTP 503", "network error"), never
 * response-derived text.
 */
export interface CatalogStatusView {
	readonly modelCount: number;
	readonly lastSuccessAt: number | undefined;
	readonly lastFailure?: { readonly classification: string; readonly at: number } | undefined;
	readonly refreshing: boolean;
}

/** One OpenRouter catalog entry as the picker lists it; id is what `_openrouter_model` takes. */
export interface CatalogModelSummary {
	readonly id: string;
	readonly name: string;
}

/**
 * One usage endpoint's standing (closed enums and status numbers only - usage
 * response bodies embed hashed key material, so nothing body-derived may ride
 * here). "unavailable" is permanent until an explicit refresh re-probes;
 * "error" keeps retrying on scheduled polls.
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
 * One server's usage facts: numbers, epoch timestamps, user-configured
 * identity, and closed endpoint-standing enums only. Servers whose proxy
 * serves no usage endpoints never appear here.
 */
export interface UsageServerView {
	readonly kind: "usage";
	readonly label: string;
	readonly baseUrl: string;
	/**
	 * Fresh under the polling rule: last fetch OK and younger than two poll
	 * intervals (with polling off, than usage.pollingOffFreshnessWindow). Stale
	 * data still renders, labeled with its age.
	 */
	readonly fresh: boolean;
	/** The /key/info standing: why spend numbers are missing or not updating. */
	readonly keyInfo: UsageEndpointStandingView;
	/** The /user/daily/activity standing: why request statistics are missing. */
	readonly dailyActivity: UsageEndpointStandingView;
	/** Epoch ms of the last successful fetch; the "last updated" label. */
	readonly lastUpdatedAt?: number | undefined;
	/** The key's server-side spend in USD, when /key/info reports one. */
	readonly spend?: number | undefined;
	/** The budget bars and alerts run against: entry over key. */
	readonly effectiveBudget?: number | undefined;
	/** The key-reported max_budget, retained even when the entry's budget wins. */
	readonly keyBudget?: number | undefined;
	/** The entry's manual budget, when set. */
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
 * A server left with no readable usage by a forbidden standing (401/403):
 * actionable, so it gets a reduced card with no spend numbers to fake.
 * Merely-unsupported servers (a DB-less proxy) stay hidden instead.
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

/** One server's usage card: full usage facts, or the reduced forbidden card. */
export type UsageServerCardView = UsageServerView | UsageForbiddenServerView;

/** The usage snapshot the Servers page joins onto its rows; pushed with every state like the rest. */
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
	/**
	 * Whether that pass was explicitly requested (Refresh now, the palette
	 * command). Only an explicit pass wears the busy label; scheduled polls
	 * update the numbers silently.
	 */
	readonly refreshingExplicitly: boolean;
	/** When this snapshot was computed (epoch ms); ages render against it. */
	readonly generatedAt: number;
}

/** The legacy leftovers worth a dashboard hint; mirrors the migration's LegacyHintKind (never imported: that module is host-only). */
type LegacyHintViewKind = "inert-url-scoped-key" | "inert-global-headers" | "parked-global-headers";

/**
 * How a diagnostic row renders: "warning" is a problem to fix, "advisory" an
 * informational hint (the configuration still applies as written). The same
 * vocabulary as Logger.advisory in shared/logger.ts.
 */
export type ConfigDiagnosticSeverity = "warning" | "advisory";

/**
 * One configuration problem for the Diagnostics tab, each also rendered
 * beside the row or editor it concerns. Free text here is structural
 * configuration only (setting ids, record keys, header names) - never
 * entered values.
 */
export type ConfigDiagnosticView =
	| {
			readonly kind: "record";
			/** Which record map: the setting id, or the entry field for entry layers. */
			readonly setting: "models.parameters" | "models.capabilities";
			/** The owning entry's label for entry-layer records; absent for the global settings. */
			readonly entryLabel?: string | undefined;
			readonly diagnostic: RecordDiagnostic;
			/**
			 * "advisory" exactly on the surviving unrecognized-key diagnostics (the
			 * field still APPLIES as-is); every other record diagnostic warns.
			 */
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			/** One rejected or partially-ignored servers-setting entry; `misconfigured` when the entry is skipped whole. */
			readonly kind: "entry";
			readonly label?: string | undefined;
			/** The entry's 1-based position in the raw array, for label-less entries. */
			readonly position: number;
			readonly problems: readonly string[];
			readonly misconfigured: boolean;
			/**
			 * Whether a server row was drawn for this entry: a reject with a row has
			 * its problems there, so Diagnostics does not repeat them; a reject
			 * without one has no row, and this list is its only report.
			 */
			readonly rowOwned: boolean;
			readonly severity: ConfigDiagnosticSeverity;
	  }
	| {
			readonly kind: "legacy";
			readonly hint: LegacyHintViewKind;
			/** The leftover key: a record key for scoped-key hints, the setting id for the headers hints. */
			readonly oldKey: string;
			/** The setting id the leftover sits in, or the parked header names. */
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
			 * Provider groups hidden by an explicit user removal. Labels only,
			 * never URLs beyond what the hidden-groups line already shows.
			 */
			readonly kind: "hidden-groups";
			readonly labels: readonly string[];
			readonly severity: ConfigDiagnosticSeverity;
	  };

/**
 * The Diagnostics tab's Resolved-models view. Serialized on demand (the
 * readResolvedModels request), never in state pushes: it scales with models x
 * fields. Local to the dashboard by design - never part of issue reports.
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
 * One record as a tree node: nested under its next-broader match, computed
 * against the live model set (a key under different parents for different
 * models renders once under each).
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

/** One record in a model's per-map matching chain; see RecordChainView. */
export interface RecordChainLink {
	readonly key: string;
	/** True when `_inherit_from` is false or the empty list: nothing flows past this record. */
	readonly barrier: boolean;
	/** The `_inherit_from` directive rendered for display ("true" or the named keys); absent for the default flow. */
	readonly inheritFrom?: string | undefined;
}

/**
 * One record map's matching chain for an inspected model, broadest to most
 * specific (the winner last). Computed extension-side from the same matchChain
 * the resolvers run; an entry-layer chain carries the entry's label so the
 * edit jump never guesses.
 */
export type RecordChainView =
	| { readonly layer: "global"; readonly links: readonly RecordChainLink[] }
	| { readonly layer: "entry"; readonly entryLabel: string; readonly links: readonly RecordChainLink[] };

/** One flat-table cell: a resolved parameter with its provenance. */
export interface ResolvedParamCell {
	readonly name: string;
	readonly valueText: string;
	readonly layer: "entry" | "global";
	/** The record key whose literal field carries the value. */
	readonly key: string;
	readonly inheritedFrom?: string | undefined;
	readonly forced?: true | undefined;
}

/** One flat-table cell: a resolved capability with its provenance level. */
export interface ResolvedCapCell {
	readonly name: string;
	readonly valueText: string;
	readonly level: CapabilityLevel;
	readonly key?: string | undefined;
	readonly inheritedFrom?: string | undefined;
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

export interface DashboardState {
	readonly servers: readonly DashboardServer[];
	/**
	 * Groups the user explicitly removed, out of the servers table by design:
	 * rendered on the hidden-groups line, contributing nothing to the overall
	 * verdict or the model counts.
	 */
	readonly hiddenGroups: readonly HiddenGroup[];
	readonly models: readonly DashboardModel[];
	/**
	 * The union of the servers' observedModelInfoKeys, across exactly the
	 * servers that reported a set. Absent = unknown, empty = known and empty;
	 * same handling rules as the per-server field.
	 */
	readonly observedModelInfoKeys?: readonly string[] | undefined;
	readonly settings: DashboardSettings;
	/** The Servers page's usage snapshot (spend units, drawers, diagnostics); see DashboardUsage. */
	readonly usage: DashboardUsage;
	/** Configuration problems found in the settings; see ConfigDiagnosticView. */
	readonly diagnostics: readonly ConfigDiagnosticView[];
	/**
	 * Legacy-registry servers (pre-migration installs and test mode) with no
	 * server row of their own. Labels and URLs stay extension-side; the
	 * Diagnostics tab only states the count.
	 */
	readonly legacyServerCount: number;
}

/**
 * The dashboard's top-level sections, one tab each, in the rail's order.
 * Declared here because deep links cross the boundary: the extension's
 * focusSection message names a tab by ID. The retired "usage" id can still
 * arrive in stale deep links; the shell's unknown-section guard drops those,
 * which a test pins.
 */
export const DASHBOARD_SECTION_IDS = ["overview", "models", "diagnostics", "settings"] as const;

export type DashboardSectionId = (typeof DASHBOARD_SECTION_IDS)[number];
