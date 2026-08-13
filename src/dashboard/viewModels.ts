/**
 * The dashboard's view models: the serializable state the extension pushes
 * into the webview, reduced to display facts. This module is imported by both
 * sides (the extension host and the browser bundle), so it must stay pure: no
 * vscode, no DOM, no Node.
 *
 * The dashboard is a stateless view over the existing stores. Everything in
 * DashboardState is derived on demand from the provider's status window and
 * from workspace configuration; nothing here is persisted anywhere.
 */

import type { CapabilityLevel } from "../shared/config/capabilityResolution";
import type { RecordDiagnostic } from "../shared/config/recordResolution";
import type { BooleanSettingId, NumberSettingId, UiAccent, UiTheme } from "../shared/config/settingSpec";
import { BOOLEAN_SETTING_SPECS, NUMBER_SETTING_SPECS } from "../shared/config/settingSpec";
import type { TransportErrorClassification } from "../shared/errorClassification";
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
 * Row-level warning classifications for declared entries. Only the
 * classification crosses the extension-webview boundary; the user-facing copy
 * is rendered webview-side - the same rule the logs follow (classifications,
 * never free text).
 *
 * The InactiveEntryNotice family: the entry declares an entry-only field
 * (per-entry modelParameters; modelCapabilities, declaredModels, or
 * expectedFailures; custom headers; the apiVersion override), but the live
 * group serving it did not join by the entry's exact labeled identity - it
 * predates entry labels, predates a rename, or carries someone else's label -
 * so the request path's label-and-URL check does not apply those fields.
 * Recreating the group activates them. One classification per field family so
 * a row can name exactly what is inactive; the webview derives every badge
 * and banner phrase from this union, so a new member fails compilation until
 * its presentation exists.
 *
 * "expected-failures-nothing-declared": discovery failed in a category the
 * entry expects, and the entry's discovery.declared list supplies no models -
 * the server is healthy by its own declaration but serves nothing, which only
 * a declared model can fix.
 */
export type InactiveEntryNotice =
	| "entry-params-inactive"
	| "entry-capabilities-inactive"
	| "entry-headers-inactive"
	| "entry-api-version-inactive";

export type DeclaredServerNotice = InactiveEntryNotice | "expected-failures-nothing-declared";

/**
 * Where an external provider group came from, when the extension's removal
 * bookkeeping knows: the leftover of a removed entry (with the removed
 * label), or the leftover of a rename (old label -> new label). Absent for
 * groups added outside this extension or predating the tracking - the webview
 * renders that honest default. Classifications and labels only, never free
 * text, like DeclaredServerNotice.
 */
export type ExternalServerProvenance =
	| { readonly kind: "removed-entry-leftover"; readonly removedLabel: string }
	| { readonly kind: "rename-leftover"; readonly oldLabel: string; readonly newLabel: string };

/**
 * One provider group the user explicitly removed (tombstoned): it answers
 * with no models and leaves the servers table for the collapsed hidden-groups
 * line, which offers Unhide per row. The identity is what the unhideServer
 * intent echoes back.
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
	 * The model_info keys the server's last successful /model/info listing
	 * reported (ServerModelsSnapshot.observedModelInfoKeys), for the record
	 * editors' key suggestions. Absent when no set is available (declared-only
	 * entries, a /models-fallback discovery, pre-discovery) - absence and the
	 * empty array differ: an empty set is a real answer. Server-derived
	 * strings: render-only, never logged, never part of issue-report text, and
	 * membership tests go through Set/Map ("__proto__" is a legal member, so a
	 * raw object key would hit the prototype).
	 */
	readonly observedModelInfoKeys?: readonly string[] | undefined;
}

/**
 * One server row: a declared entry from the litellm-vscode-chat.servers
 * setting, a live provider group the status window saw, or both merged
 * (joined by label and base URL). Secrets never reach the webview; only
 * their locations do.
 *
 * Discriminated twice. On `origin`: a declared row always carries the edit
 * form's config prefill, an external row always carries the opaque adopt
 * handle, and neither carries the other's field. On `state`: an error row
 * always has its message, an "ok" row may STILL carry one (deliberate: a
 * declared entry whose group upsert failed while an already-live group keeps
 * serving renders "OK (N models) - <sync error>"), and "unchecked" (declared
 * in settings but not yet seen by a discovery pass) carries none.
 * `errorEnglish` is the error's log-safe English rendering
 * (ServerStatus.logSafeError, markLogSafe-branded - no secrets, no raw
 * response text), present only when `error` is the transport error itself:
 * the on-screen row renders the localized `error`, while the copyable
 * diagnostics block substitutes `errorEnglish` so pasted reports stay
 * English (see diagnostics.tsx).
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
				readonly provenance?: undefined;
				readonly hideable?: undefined;
				readonly problems?: undefined;
		  }
		| {
				/**
				 * A servers-setting entry the parser REFUSED (an ambiguous or
				 * incomplete auth shape, per docs/servers.md#authentication): present
				 * in the setting but never synced or served until fixed. `problems`
				 * carries the parser's English structural reports (configuration key
				 * names only, never entered values - the same text the sync engine
				 * logs), rendered on the row, in Configuration diagnostics, and in
				 * copied reports. No `config`: the broken shape cannot round-trip
				 * through the edit form without silently rewriting what the user
				 * typed, so the fix lives in settings.json (the row's Fix action
				 * reveals the entry).
				 */
				readonly origin: "misconfigured";
				readonly problems: readonly string[];
				readonly config?: undefined;
				readonly adoptHandle?: undefined;
				readonly notices?: undefined;
				readonly provenance?: undefined;
				readonly hideable?: undefined;
		  }
		| {
				/**
				 * A provider group managed outside the setting. `adoptHandle` is the
				 * opaque token the adopt intent names its source group by: a salted
				 * one-way hash of the extension-side server ID, stable across state
				 * pushes for the session (rendered labels and row order are not); it
				 * carries no credential material, cannot be reproduced outside the
				 * extension host, and resolves back to a group only while that group
				 * is still external.
				 */
				readonly origin: "external";
				readonly adoptHandle: string;
				readonly config?: undefined;
				readonly notices?: undefined;
				/** Why the group exists, when a removal or rename explains it; see ExternalServerProvenance. */
				readonly provenance?: ExternalServerProvenance | undefined;
				/**
				 * Whether Remove (hide) applies: true for provider-group rows, false
				 * for legacy-registry rows, whose models the registry path would
				 * keep serving - hiding those would only make the dashboard lie.
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
		  }
		| {
				readonly state: "error";
				readonly error: string;
				readonly errorEnglish?: string | undefined;
				/**
				 * The transport classification behind the row's error, when one
				 * exists. Classification only - enum ids and a status number, never
				 * message text - so it is safe to cross the webview boundary; present
				 * under the same rule as errorEnglish (only when `error` IS the
				 * transport error - a masking sync error is not classified). The
				 * webview maps the setup-hint id to the matching troubleshooting-guide
				 * link, exactly like the failure notice's classification.
				 */
				readonly classification?: TransportErrorClassification | undefined;
				/**
				 * True when the failure hit a category the entry's expectedFailures
				 * declares: the discovery outcome stays a truthful error (the stale
				 * anchor and counts depend on it), but every presentation surface
				 * treats it as expected - excluded from failure verdicts, annotated
				 * "(expected)" instead of rendered red.
				 */
				readonly expected?: boolean | undefined;
				/** How many declared models this server keeps serving despite the failure. */
				readonly declaredModelCount?: number | undefined;
		  }
		| {
				readonly state: "unchecked";
				readonly error?: undefined;
				readonly errorEnglish?: undefined;
				readonly classification?: undefined;
				readonly expected?: undefined;
				readonly declaredModelCount?: undefined;
		  }
	);

/** One registered model, reduced to display facts. Costs are USD per million tokens, as registration converted them. */
export interface DashboardModel {
	readonly id: string;
	/**
	 * The model ID as the server knows it: what a request's `model` field and a
	 * modelParameters prefix match against. Differs from `id` only on
	 * legacy-registry multi-server registrations, where `id` carries a server
	 * namespace.
	 */
	readonly rawId: string;
	/**
	 * An opaque per-session handle for the model's serving server (a salted
	 * hash of the extension-side server ID): what the inspector reads
	 * (readModelParameters, readModelCapabilities) address a server by, so a
	 * stale key de-resolves instead of hitting another server. Push-local,
	 * never persisted.
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
 * tab renders rows or editors for - the scalars plus the record setting.
 * A classification list, not free text: only these ids cross the webview
 * boundary, and the extension resolves each to "litellm-vscode-chat.<id>"
 * itself.
 */
export type RevealableSettingId =
	| NumberSettingId
	| BooleanSettingId
	| "models.parameters"
	| "models.capabilities"
	| "servers"
	| "usage.alertThresholds"
	| "usage.statusBar"
	| "ui.theme"
	| "ui.accent";

export const REVEALABLE_SETTING_IDS: readonly RevealableSettingId[] = [
	...NUMBER_SETTING_IDS,
	...BOOLEAN_SETTING_IDS,
	"models.parameters",
	"models.capabilities",
	"servers",
	"usage.alertThresholds",
	"usage.statusBar",
	"ui.theme",
	"ui.accent",
];

/** The settings the resetSetting intent may name: the scalar rows plus the non-scalar usage and appearance rows. */
export type ResettableSettingId =
	| NumberSettingId
	| BooleanSettingId
	| "usage.statusBar"
	| "usage.alertThresholds"
	| "ui.theme"
	| "ui.accent";

export const RESETTABLE_SETTING_IDS: readonly ResettableSettingId[] = [
	...NUMBER_SETTING_IDS,
	...BOOLEAN_SETTING_IDS,
	"usage.statusBar",
	"usage.alertThresholds",
	"ui.theme",
	"ui.accent",
];

/** The configuration scopes a setting value can live in, in ascending precedence. */
export type SettingScope = "global" | "workspace" | "workspaceFolder";

/**
 * An object setting split by configuration scope. VS Code shallow-merges
 * object settings across scopes (workspace keys win over user keys), so an
 * editor over the merged value would copy user-scope entries into workspace
 * files on write and could never delete an entry from the other scope. The
 * dashboard therefore edits exactly one scope's own record (`editScope`,
 * matching where writes land) and shows the records other scopes hold
 * read-only.
 */
export interface ScopedRecordSetting<V> {
	readonly editScope: SettingScope;
	/** The record the edit scope itself holds; what the editor edits and writes back whole. */
	readonly value: Readonly<Record<string, V>>;
	/** Non-empty records held by other scopes, read-only in the dashboard. */
	readonly otherScopes: readonly { readonly scope: SettingScope; readonly value: Readonly<Record<string, V>> }[];
	/**
	 * The scope-merged record exactly as the request path reads it (the same
	 * normalization applied to WorkspaceConfiguration.get's effective value).
	 * Read-only display truth for the effective-values inspector; the editors
	 * above keep editing single scopes.
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
	 * Where each scalar setting is explicitly configured, if anywhere: the
	 * highest-precedence scope inspection reports a value in (workspaceFolder
	 * over workspace over global), or null when only the default applies.
	 * Drives the form's modified indicator and the per-scope Reset naming.
	 * "Modified" means the key is set somewhere, matching the native Settings
	 * editor - a value pinned to exactly its default still shows the bar and
	 * can be reset - and the named scope is the one a reset removes first.
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
	 * The dashboard's own appearance: the reader's theme and accent, plus where
	 * each is configured. It rides on every state push rather than only the
	 * HTML shell, because the webview restamps the root element from it - that
	 * is what makes a change from either management path land on an open
	 * dashboard instead of waiting for a reopen.
	 */
	readonly appearance: {
		readonly theme: UiTheme;
		readonly themeScope: SettingScope | null;
		readonly accent: UiAccent;
		readonly accentScope: SettingScope | null;
	};
	/** The two non-scalar usage settings' rows (the enum and the fraction list). */
	readonly usage: {
		readonly statusBarMode: UsageStatusBarModeSetting;
		readonly statusBarScope: SettingScope | null;
		/** The configured thresholds as normalization reads them (valid fractions, deduplicated, ascending). */
		readonly alertThresholds: readonly number[];
		readonly thresholdsScope: SettingScope | null;
	};
}

/**
 * The models.openRouterCatalog row's status: the snapshot's size, when the
 * last refresh succeeded, and the standing failure classification when the
 * last one did not (a fixed English vocabulary - "HTTP 503", "network error" -
 * never response-derived text). `refreshing` disables the row's Refresh
 * button while a refresh is in flight.
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
 * One usage endpoint's standing as the card renders it, mirrored from the
 * usage store's classification (closed enums and status numbers only - usage
 * response bodies embed hashed key material, so nothing body-derived may ever
 * ride here). "unavailable" is permanent until an explicit refresh re-probes;
 * "error" keeps retrying on scheduled polls (the poller spaces consecutive
 * failures out with exponential backoff).
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
 * One server's usage facts as the Usage tab renders them: numbers, epoch
 * timestamps, user-configured identity, and closed endpoint-standing enums
 * only (the spend client already narrowed everything response-derived away).
 * Servers whose proxy serves no usage endpoints never appear here at all.
 */
export interface UsageServerView {
	readonly kind: "usage";
	readonly label: string;
	readonly baseUrl: string;
	/**
	 * Whether the data is fresh under the polling rule (last fetch OK and
	 * younger than two poll intervals; ten minutes with polling off). Stale
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
 * A server left with no readable usage by a forbidden standing (401/403 -
 * typically since the key's very first probe): actionable, so it gets a
 * reduced card - a localized headline plus the standings' English detail
 * lines - with no spend numbers to fake. Servers whose endpoints are merely
 * unsupported (a DB-less proxy) stay hidden instead: there is nothing the
 * user can do about those. Same closed-enum discipline as UsageServerView;
 * nothing response-derived rides here.
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

/** One Usage tab card: full usage facts, or the reduced forbidden card. */
export type UsageServerCardView = UsageServerView | UsageForbiddenServerView;

/** The Usage tab's whole snapshot; pushed with every state like the rest. */
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
	/** When this snapshot was computed (epoch ms); ages render against it. */
	readonly generatedAt: number;
}

/** The legacy leftovers worth a dashboard hint; mirrors the migration's LegacyHintKind (never imported: that module is host-only). */
type LegacyHintViewKind = "inert-url-scoped-key" | "inert-global-headers" | "parked-global-headers";

/**
 * How a diagnostic row renders: "warning" is a problem to fix, "advisory" an
 * informational hint (the row renders muted, the configuration still applies
 * as written). The same advisory-vs-problem vocabulary as Logger.advisory in
 * shared/logger.ts, which is the concept's output-channel surface.
 */
type ConfigDiagnosticSeverity = "warning" | "advisory";

/**
 * One configuration problem for the Diagnostics tab, each also rendered
 * beside the row or editor it concerns. Sources: the record lints of the two
 * global settings and every entry's records, the servers-setting parser's
 * per-entry reports, the migration's legacy-leftover hints, and dropped
 * usage.alertThresholds values. Free text here is structural configuration
 * only (setting ids, record keys, header names) - never entered values.
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
			 * "advisory" exactly on the surviving unrecognized-key diagnostics (a
			 * capability field outside the consumed vocabulary that the server's
			 * observed /model/info listing does not name - the field still APPLIES
			 * as-is, it just may be a typo); every other record diagnostic warns.
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
			 * Provider groups hidden by an explicit user removal: each answers
			 * with no models until unhidden from the Servers & Models view's
			 * hidden-groups line. Labels only (the same labels the hidden-groups
			 * line renders), never URLs beyond what that line already shows.
			 */
			readonly kind: "hidden-groups";
			readonly labels: readonly string[];
			readonly severity: ConfigDiagnosticSeverity;
	  };

/**
 * The Diagnostics tab's Resolved-models view: the precomputed resolution
 * rendered two ways - the matcher-key inheritance trees and the flat
 * per-model provenance table. Serialized on demand (the readResolvedModels
 * request), never in state pushes: the view scales with models x fields.
 * Local to the dashboard by design - never part of issue reports.
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
 * One record as a tree node: nested under its next-broader match (computed
 * against the live model set, so the tree changes when the model list does; a
 * key that sits under different parents for different models renders once
 * under each). Value texts are formatJsonValue renderings.
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
 * specific (the winner last): the inspectors' compact inheritance figure.
 * Computed extension-side from the same matchChain the resolvers run; the
 * webview holds no matcher logic. An entry-layer chain carries the declared
 * entry's label, so the figure and its edit jump never guess it.
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
	 * rendered as the collapsed hidden-groups line with an Unhide per row.
	 * They contribute nothing to the overall verdict or the model counts.
	 */
	readonly hiddenGroups: readonly HiddenGroup[];
	readonly models: readonly DashboardModel[];
	/**
	 * The union of the servers' observedModelInfoKeys, across exactly the
	 * servers that reported a set (sorted; the global capability record
	 * editor's key suggestions). Absent when no server reported one - absence
	 * means "unknown", the empty array means "known and empty". Same handling
	 * rules as the per-server field: server-derived strings, render-only,
	 * membership through Set/Map.
	 */
	readonly observedModelInfoKeys?: readonly string[] | undefined;
	readonly settings: DashboardSettings;
	/** The Usage tab's snapshot; see DashboardUsage. */
	readonly usage: DashboardUsage;
	/** Configuration problems found in the settings; see ConfigDiagnosticView. */
	readonly diagnostics: readonly ConfigDiagnosticView[];
	/**
	 * Legacy-registry servers (pre-migration installs and test mode) with no
	 * server row of their own; 0 once the registry is empty or every entry
	 * also surfaces as a live row. Labels and URLs stay extension-side: the
	 * Diagnostics tab only states the count.
	 */
	readonly legacyServerCount: number;
}

/**
 * The dashboard's top-level sections, one tab each. Servers and models share
 * the overview tab (they are one workflow: connect a server, see its models);
 * the settings form and the Diagnostics page get pages of their own. Declared
 * here because deep links cross the boundary: the extension's focusSection
 * message names a tab by ID (litellm.showDiagnostics lands on "diagnostics"),
 * and the webview's tab bar renders exactly this list.
 */
export const DASHBOARD_SECTION_IDS = ["overview", "usage", "settings", "diagnostics"] as const;

export type DashboardSectionId = (typeof DASHBOARD_SECTION_IDS)[number];
