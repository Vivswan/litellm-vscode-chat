/**
 * The dashboard's state bridge: pure builders that reduce the stores (the
 * provider's status window, workspace configuration) to the serializable
 * DashboardState, plus the settings readers they share. Inputs are plain
 * values or injected adapters, never live vscode objects; panel.ts owns the
 * vscode wiring, intents.ts the intent validation and execution.
 */

import type {
	CatalogStatusView,
	ConfigDiagnosticView,
	DashboardModel,
	DashboardServer,
	DashboardSettings,
	DashboardState,
	DashboardUsage,
	DeclaredServerNotice,
	ExternalServerProvenance,
	HiddenGroup,
	ScopedRecordSetting,
	ServerSecretsView,
	SettingScope,
} from "../../dashboard/viewModels";
import { BOOLEAN_SETTING_IDS, NUMBER_SETTING_IDS } from "../../dashboard/viewModels";
import type { PreAttachModelInfo } from "../../provider/catalog/groupModels";
import { modelSupportsPromptCaching } from "../../provider/catalog/groupModels";
import { rawModelIdFromExposed } from "../../provider/catalog/modelCatalog";
import type { ServerModelsSnapshot } from "../../provider/catalog/statusWindow";
import type { CapabilityCatalogLookup, EffectiveCapabilities } from "../../shared/config/capabilityResolution";
import {
	filterUnrecognizedKeys,
	observedEvidenceSet,
	resolveModelCapabilities,
} from "../../shared/config/capabilityResolution";
import { matchChain } from "../../shared/config/modelMatcher";
import type { EffectiveParametersProjection } from "../../shared/config/parameterResolution";
import { projectResolvedParameters, resolveModelParameters } from "../../shared/config/parameterResolution";
import type { ModelResolutionTable } from "../../shared/config/resolutionTable";
import type {
	BooleanSettingId,
	FeatureModelId,
	InlineLanguageFilter,
	NumberSettingId,
} from "../../shared/config/settingSpec";
import {
	ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY,
	COMMIT_GENERATION_PROMPT_SETTING_KEY,
	FEATURE_MODEL_IDS,
	FEATURE_MODEL_SETTING_KEYS,
	INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY,
	LANGUAGE_FILTER_MODES,
	NUMBER_SETTING_SPECS,
	TOKEN_ESTIMATION_SETTING_KEY,
	UI_ACCENT_SETTING_KEY,
	UI_THEME_SETTING_KEY,
} from "../../shared/config/settingSpec";
import {
	CURRENCY_SYMBOL_SETTING_KEY,
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	normalizeAdditionalToolSchemaKeywords,
	normalizeCommitGenerationPrompt,
	normalizeCurrencySymbol,
	normalizeFeatureModelRef,
	normalizeInlineLanguageFilter,
	normalizeModelCapabilities,
	normalizeModelParameters,
	normalizeTokenEstimationMode,
	normalizeUiAccent,
	normalizeUiTheme,
	normalizeUsageAlertThresholds,
	normalizeUsageStatusBarMode,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
	USAGE_STATUS_BAR_SETTING_KEY,
} from "../../shared/config/settings";
import type { TransportErrorClassification, UnservedEndpointEvidence } from "../../shared/errorClassification";
import { pickNonSecretOptionalFields, SECRET_FIELD_IDS } from "../../shared/serverEntry";
import type { ServerStatus } from "../../shared/servers";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { recordFromKeys } from "../../shared/util/json";
import type { DeclaredServerView, ServerEntryReport } from "../servers/serverSync";
import { declaredPresentation } from "../servers/syncFailureOverlay";
import type { SettingsInspection } from "../settingsAccess";
import { resolveConfiguredScope, resolveUpdateScope } from "../settingsAccess";
import { adoptSourceHandle, modelScopeKey } from "./adoptHandle";
import type { LabeledSnapshot } from "./declaredJoin";
import { joinDeclared, labeledSnapshots } from "./declaredJoin";

/**
 * The removal bookkeeping the state builder folds in: the identities the user
 * explicitly removed (tombstones; base URLs normalized) and the recorded
 * origins of orphaned groups. panel.ts reads both from the GroupRemovalStore.
 */
export interface RemovedGroupsView {
	readonly tombstones: readonly { readonly label: string; readonly baseUrl: string }[];
	readonly origins: readonly {
		readonly label: string;
		readonly baseUrl: string;
		readonly origin: ExternalServerProvenance;
	}[];
}

const NO_REMOVED_GROUPS: RemovedGroupsView = { tombstones: [], origins: [] };

/** The per-scope settings-inspection seam; re-exported so this module's consumers keep one import site. */
export type { SettingsInspection } from "../settingsAccess";

/** Read access to the litellm-vscode-chat configuration section; a seam over WorkspaceConfiguration. */
export interface SettingsReader {
	/** The effective value for `key`, as WorkspaceConfiguration.get returns it. */
	get(key: string): unknown;
	/** Per-scope values for `key`, as WorkspaceConfiguration.inspect reports them. */
	inspect(key: string): SettingsInspection | undefined;
}

function buildServer(
	snapshot: ServerModelsSnapshot,
	label: string,
	provenance: ExternalServerProvenance | undefined,
	hideable: boolean
): DashboardServer {
	const { status } = snapshot;
	const base = {
		label,
		baseUrl: status.baseUrl,
		lastChecked: status.lastChecked,
		// The live group's own report is the verdict here: an external row has
		// no declared secrets whose locations could still be unread, and the
		// report carries the credential kind alongside the presence.
		credentials: status.hasApiKey === true ? "present" : "absent",
		hasOAuth: status.hasOAuth === true,
		origin: "external",
		adoptHandle: adoptSourceHandle(status.serverId),
		hideable,
		...(provenance !== undefined ? { provenance } : {}),
		...(snapshot.observedModelInfoKeys !== undefined ? { observedModelInfoKeys: snapshot.observedModelInfoKeys } : {}),
	} as const;
	return status.state === "ok"
		? { ...base, state: "ok", servedModelCount: status.servedModelCount }
		: {
				...base,
				state: "error",
				// The served count is truthful on every state: a failed group still
				// serving its stale-window models says so.
				servedModelCount: status.servedModelCount,
				error: status.error,
				errorEnglish: status.logSafeError,
				...(status.classification !== undefined ? { classification: status.classification } : {}),
			};
}

/**
 * The state slice of a declared row, decided by the shared sync-failure rule
 * (declaredPresentation): a sync error outranks the live status - even a
 * healthy one, since the group still serving is the entry's OLD configuration
 * and the remove-and-resync instruction must show - while the served count
 * stays the live truth for every label whose models actually render
 * (`labelServes`; an upsertFailed claimant excluded from a shared snapshot's
 * labels serves nothing). The status bar's overlay (applySyncFailures)
 * consumes the same presentation rule, and it carries ONE status per snapshot,
 * so the two surfaces agree by summation: the per-claimant rows' counts add up
 * to the overlay's single per-snapshot count. `errorEnglish` (the
 * transport error's log-safe English) and `classification` (enum ids only,
 * protocol-legal) ride exactly when the row's error IS the transport error; a
 * sync error carries neither.
 */
function declaredOutcome(
	status: ServerStatus | undefined,
	syncError: string | undefined,
	labelServes: boolean
):
	| {
			state: "ok";
			servedModelCount: number;
			modelInfoUnsupported?: UnservedEndpointEvidence | undefined;
	  }
	| {
			state: "error";
			servedModelCount: number;
			error: string;
			errorEnglish?: string | undefined;
			classification?: TransportErrorClassification | undefined;
			expected?: boolean | undefined;
			declaredModelCount?: number | undefined;
	  }
	| { state: "unchecked"; servedModelCount: number } {
	const presentation = declaredPresentation(status, syncError);
	if (presentation.kind === "sync-failed") {
		return {
			state: "error",
			// An upsertFailed claimant of a SHARED snapshot renders no model rows
			// (snapshotLabels drops its label), so the live count would claim
			// models the tables do not show; the count follows the rendered rows.
			servedModelCount: labelServes ? presentation.servedModelCount : 0,
			error: presentation.error,
		};
	}
	// The second test is what narrows `status` below: "unchecked" already means
	// an absent status, but the kind alone tells the compiler nothing.
	if (presentation.kind === "unchecked" || status === undefined) {
		return { state: "unchecked", servedModelCount: 0 };
	}
	if (status.state === "ok") {
		return {
			state: "ok",
			servedModelCount: status.servedModelCount,
			...(status.modelInfoUnsupported !== undefined ? { modelInfoUnsupported: status.modelInfoUnsupported } : {}),
		};
	}
	return {
		state: "error",
		// Stale-window and declared models serve through ANY discovery
		// failure, so the row's count must match the picker whether or not
		// the failure was expected.
		servedModelCount: status.servedModelCount,
		error: status.error,
		errorEnglish: status.logSafeError,
		...(status.classification !== undefined ? { classification: status.classification } : {}),
		...(status.expected === true ? { expected: true } : {}),
		...(status.declaredModelCount !== undefined ? { declaredModelCount: status.declaredModelCount } : {}),
	};
}

/** A rejected entry that has the identity a row needs: both fields narrowed, so no call site defaults them. */
export type DrawableReject = ServerEntryReport & { readonly label: string; readonly baseUrl: string };

/**
 * The declared views with the one fact the views themselves cannot carry:
 * whether their secret locations come from a real blob read. The sync engine
 * reads the secret blobs; the pre-first-pass settings fallback cannot check
 * SecretStorage synchronously, so a field it reports "none" may really be
 * "secure". The tag is producer-owned - declaredViewsFromSetting returns its
 * views already marked "settings-fallback" - and proof is still judged per
 * view (secretsView): an engine view whose own blob read failed is as blind
 * as the fallback.
 */
export type DeclaredServersInput =
	| { readonly source: "engine"; readonly views: readonly DeclaredServerView[] }
	| { readonly source: "settings-fallback"; readonly views: readonly DeclaredServerView[] };

/**
 * One declared view's secrets as the push may claim them. An engine view is
 * proven by its blob read - except under the "secretsUnreadable" class, the
 * one skip whose locations are a guess (the blob read failed and the view
 * degraded to the inline-only reading); the other skip classes keep their
 * successful read. Without a blob read, a view is proven only when every
 * secret field reads "settings": inline wins over any blob, so the setting
 * alone proves those - while a "none" is just "no inline value", and the row
 * must say unproven instead of denying a secure blob nobody read.
 */
function secretsView(view: DeclaredServerView, source: DeclaredServersInput["source"]): ServerSecretsView {
	const locationsGuessed = view.syncErrorClass === "secretsUnreadable";
	if (
		(source === "engine" && !locationsGuessed) ||
		SECRET_FIELD_IDS.every((field) => view.secrets[field] === "settings")
	) {
		return { kind: "proven", locations: view.secrets };
	}
	return { kind: "unproven" };
}

/**
 * The rejected servers-setting entries that earn a row of their own, in
 * setting order. A reject sits in the setting, so a silently missing row would
 * read as a removal - but a row needs an honest identity to draw, and four
 * causes leave a reject without one: no label, no base URL, a label a declared
 * entry already owns, and a label an earlier reject already drew. Those stay
 * in Configuration diagnostics ONLY, which is why this rule is exported rather
 * than inlined: diagnostics drop the entry problems a row already states, and
 * must drop exactly the ones a row was drawn for.
 */
export function rejectsWithOwnRow(
	entryReports: readonly ServerEntryReport[],
	declared: readonly Pick<DeclaredServerView, "label">[]
): readonly DrawableReject[] {
	const declaredLabels = new Set(declared.map((view) => view.label));
	const drawn = new Set<string>();
	const rows: DrawableReject[] = [];
	for (const report of entryReports) {
		if (
			report.accepted ||
			report.label === undefined ||
			report.baseUrl === undefined ||
			declaredLabels.has(report.label) ||
			drawn.has(report.label)
		) {
			continue;
		}
		drawn.add(report.label);
		rows.push({ ...report, label: report.label, baseUrl: report.baseUrl });
	}
	return rows;
}

/**
 * The servers section merges two sources: entries declared in the servers
 * setting (with their secret locations, for the edit form) and the live
 * provider groups the status window saw (reachability, model counts). A
 * declared entry the status window has not seen renders "unchecked"; a live
 * group with no settings entry renders as external.
 *
 * Snapshots are labeled by URL host (the host never hands the group name to
 * the extension), so the join cannot require a label match; see joinDeclared.
 * `snapshotLabels` maps each snapshot to the labels its models render under:
 * every claiming entry's label when joined (the host registers those models
 * once per group, so the models table must list them per claimant to match the
 * picker), the snapshot's own label otherwise. The one exclusion is a claimant
 * whose sync failed as upsertFailed - the host has no group for it, so a copy
 * would be phantom - while blocked claimants keep theirs; the snapshot still
 * renders under the first claimant when every claimant is excluded. Exact host
 * cardinality is not recoverable from declarations alone.
 *
 * Removal bookkeeping (removedGroups) applies to external rows only: a
 * tombstoned external snapshot leaves the table (the hidden-groups line states
 * it instead) and contributes no models, and the remaining external rows carry
 * their recorded provenance when one exists.
 */
function buildServers(
	labeled: readonly LabeledSnapshot[],
	declaredInput: DeclaredServersInput,
	entryReports: readonly ServerEntryReport[],
	removedGroups: RemovedGroupsView,
	isGroupSnapshot: (serverId: string) => boolean
): { servers: DashboardServer[]; snapshotLabels: string[][] } {
	const declared = declaredInput.views;
	const { matchedByDeclared, unmatched } = joinDeclared(labeled, declared);
	// The removal bookkeeping is keyed by the snapshot's own status label (never
	// the display label, which can carry a collision ordinal) plus the
	// normalized base URL. Only EXTERNAL, GROUP-BACKED rows are ever suppressed:
	// a declared entry matching a tombstone clears it engine-side, and a
	// legacy-registry row has no group a tombstone silences - it would keep
	// serving its models, so hiding it here would lie.
	const isTombstoned = (snapshot: ServerModelsSnapshot) =>
		isGroupSnapshot(snapshot.status.serverId) &&
		removedGroups.tombstones.some(
			(identity) =>
				identity.label === snapshot.status.label &&
				normalizeBaseUrl(identity.baseUrl) === normalizeBaseUrl(snapshot.status.baseUrl)
		);
	const originFor = (snapshot: ServerModelsSnapshot) =>
		removedGroups.origins.find(
			(record) =>
				record.label === snapshot.status.label &&
				normalizeBaseUrl(record.baseUrl) === normalizeBaseUrl(snapshot.status.baseUrl)
		)?.origin;
	// Countable claimant labels per snapshot, in declared order, with the
	// first claimant of any state as the render-at-least-once fallback. Built
	// whole before any row, because a shared snapshot's rows need the full
	// claimant picture to report their own served counts.
	const claimants = new Map<LabeledSnapshot, { labels: string[]; fallback: string }>();
	declared.forEach((view, declaredIndex) => {
		const matched = matchedByDeclared.get(declaredIndex)?.entry;
		if (matched !== undefined) {
			const claimed = claimants.get(matched) ?? { labels: [], fallback: view.label };
			if (view.syncErrorClass !== "upsertFailed") {
				claimed.labels.push(view.label);
			}
			claimants.set(matched, claimed);
		}
	});
	// The labels a snapshot's models render under; snapshotLabels and the rows'
	// served counts read the same rule, so they cannot diverge.
	const labelsRenderedFor = (entry: LabeledSnapshot): string[] => {
		const claimed = claimants.get(entry);
		if (claimed === undefined) {
			return [entry.label];
		}
		return claimed.labels.length > 0 ? claimed.labels : [claimed.fallback];
	};
	const servers: DashboardServer[] = [];
	// Hidden externals leave the table AND the models list; this only bridges the
	// window between the tombstone write and the host's re-resolution.
	const hidden = new Set<LabeledSnapshot>();
	declared.forEach((view, declaredIndex) => {
		const match = matchedByDeclared.get(declaredIndex);
		const matched = match?.entry;
		// Only the exact labeled-identity join proves the live group carries this
		// entry's label, which is what the request path's label-and-URL resolution
		// keys on. Any other pass means the entry's entry-only fields may silently
		// not apply, and the row must say so instead of rendering healthy;
		// modelParameters and the capability/expected-failure pair get separate
		// classifications so a row names exactly what is inactive.
		const entryFieldsInactive = match !== undefined && match.pass !== "identity";
		const notices: DeclaredServerNotice[] = [];
		if (entryFieldsInactive && view.modelParameters !== undefined) {
			notices.push("entry-params-inactive");
		}
		if (
			entryFieldsInactive &&
			(view.modelCapabilities !== undefined || view.expectedFailures !== undefined || view.declaredModels !== undefined)
		) {
			notices.push("entry-capabilities-inactive");
		}
		if (entryFieldsInactive && view.headers !== undefined) {
			notices.push("entry-headers-inactive");
		}
		// "" is a real override (append nothing), so !== undefined is the right
		// activity check here too.
		if (entryFieldsInactive && view.apiVersion !== undefined) {
			notices.push("entry-api-version-inactive");
		}
		const outcome = declaredOutcome(
			matched?.snapshot.status,
			view.syncError,
			matched === undefined || labelsRenderedFor(matched).includes(view.label)
		);
		if (outcome.state === "error" && outcome.expected === true && outcome.servedModelCount === 0) {
			// An expected failure serving NOTHING - no declared models, and the
			// stale window holds nothing; only a declared-models list can fix
			// that, so the row says so. A serving row stays quiet, whatever mix
			// of declared and stale models it serves.
			notices.push("expected-failures-nothing-declared");
		}
		const secrets = secretsView(view, declaredInput.source);
		// The presence verdict reads the SAME union the edit form gates on. Only
		// the deny needs proof: an unproven view's non-"none" location can only
		// be "settings" (both blind readings are inline-only, and inline wins
		// over any blob), and the live group's report is the host's own truth -
		// but an unproven "none" is a guess, and the row says "unknown" instead
		// of denying a secure key nobody read.
		const knownPresent = matched?.snapshot.status.hasApiKey === true || view.secrets.apiKey !== "none";
		servers.push({
			label: view.label,
			baseUrl: view.baseUrl,
			lastChecked: matched?.snapshot.status.lastChecked,
			credentials: knownPresent ? "present" : secrets.kind === "proven" ? "absent" : "unknown",
			hasOAuth: view.oauthTokenUrl !== undefined && view.oauthClientId !== undefined,
			origin: "declared",
			...(matched?.snapshot.observedModelInfoKeys !== undefined
				? { observedModelInfoKeys: matched.snapshot.observedModelInfoKeys }
				: {}),
			config: {
				...pickNonSecretOptionalFields(view),
				...(view.apiVersion !== undefined ? { apiVersion: view.apiVersion } : {}),
				secrets,
				...(view.modelParameters !== undefined ? { modelParameters: view.modelParameters } : {}),
				...(view.modelCapabilities !== undefined ? { modelCapabilities: view.modelCapabilities } : {}),
				...(view.expectedFailures !== undefined && view.expectedFailures.length > 0
					? { expectedFailures: view.expectedFailures }
					: {}),
				...(view.headers !== undefined && Object.keys(view.headers).length > 0 ? { headers: view.headers } : {}),
				...(view.declaredModels !== undefined && view.declaredModels.length > 0
					? { declaredModels: view.declaredModels }
					: {}),
				...(view.budget !== undefined ? { budget: view.budget } : {}),
			},
			...(notices.length > 0 ? { notices } : {}),
			// The webview's declare offers key on the classification itself, since
			// the notices exist only for the field families the entry configures.
			...(entryFieldsInactive ? { entryFieldsInactive: true as const } : {}),
			...outcome,
		});
	});
	for (const entry of unmatched) {
		if (isTombstoned(entry.snapshot)) {
			hidden.add(entry);
			continue;
		}
		servers.push(
			buildServer(
				entry.snapshot,
				entry.label,
				originFor(entry.snapshot),
				isGroupSnapshot(entry.snapshot.status.serverId)
			)
		);
	}
	// Entries the parser refused whole still render as rows: they sit in the
	// setting, and a silently missing row would read as a removal.
	// rejectsWithOwnRow is the one place that rule lives; Configuration
	// diagnostics read it to know which problems a row already states.
	for (const report of rejectsWithOwnRow(entryReports, declared)) {
		servers.push({
			label: report.label,
			baseUrl: report.baseUrl,
			servedModelCount: 0,
			credentials: "absent",
			hasOAuth: false,
			origin: "misconfigured",
			problems: report.problems,
			state: "error",
			// English by the issue-report policy, like the parser problems the row
			// carries; the webview renders its own localized copy.
			error: "misconfigured entry; not used until its configuration is fixed",
			errorEnglish: "misconfigured entry; not used until its configuration is fixed",
		});
	}
	servers.sort((a, b) => a.label.localeCompare(b.label) || a.baseUrl.localeCompare(b.baseUrl));
	return {
		servers,
		snapshotLabels: labeled.map((entry) => (hidden.has(entry) ? [] : labelsRenderedFor(entry))),
	};
}

function buildModel(info: PreAttachModelInfo, serverLabel: string, serverId: string, scopeKey: string): DashboardModel {
	return {
		id: info.id,
		// The request's `model` field: group registrations expose raw IDs already,
		// legacy multi-server ones namespace them with the server ID, which the
		// shared strip inverts.
		rawId: rawModelIdFromExposed(info.id, serverId),
		scopeKey,
		name: info.name,
		family: info.family,
		serverLabel,
		maxInputTokens: info.maxInputTokens,
		maxOutputTokens: info.maxOutputTokens,
		outputLimitDeclared: info.litellm.outputLimitSource !== "defaults",
		inputCost: info.inputCost,
		outputCost: info.outputCost,
		cacheReadCost: info.cacheCost,
		cacheWriteCost: info.cacheWriteCost,
		longContextInputCost: info.longContextInputCost,
		longContextOutputCost: info.longContextOutputCost,
		longContextCacheReadCost: info.longContextCacheCost,
		longContextCacheWriteCost: info.longContextCacheWriteCost,
		toolCalling: Boolean(info.capabilities?.toolCalling),
		imageInput: Boolean(info.capabilities?.imageInput),
		promptCaching: modelSupportsPromptCaching(info),
		reasoning: info.configurationSchema !== undefined,
		...(info.litellm.declared === true ? { declared: true } : {}),
	};
}

/**
 * The value shown for a number setting: a configured finite number (or null
 * where null is legal) passes through even when out of range, because the
 * dashboard shows what is configured; anything unusable falls back to the
 * package.json default so the form still renders a real value.
 */
function readNumberSetting(reader: SettingsReader, id: NumberSettingId): number | null {
	const spec = NUMBER_SETTING_SPECS[id];
	const raw = reader.get(id);
	if (spec.nullable && (raw === null || raw === undefined)) {
		return null;
	}
	if (typeof raw === "number" && Number.isFinite(raw)) {
		return raw;
	}
	return readNumberDefault(reader, id);
}

function readBooleanSetting(reader: SettingsReader, id: BooleanSettingId): boolean {
	const raw = reader.get(id);
	if (typeof raw === "boolean") {
		return raw;
	}
	return readBooleanDefault(reader, id);
}

/**
 * The package.json default of a number setting, the display fallback when the
 * configured value is unusable (readNumberSetting). Falls back further to the
 * spec's own floor when even the inspected default is unusable.
 */
function readNumberDefault(reader: SettingsReader, id: NumberSettingId): number | null {
	const spec = NUMBER_SETTING_SPECS[id];
	const fallback = reader.inspect(id)?.defaultValue;
	if (typeof fallback === "number" && Number.isFinite(fallback)) {
		return fallback;
	}
	return spec.nullable ? null : spec.minimum;
}

function readBooleanDefault(reader: SettingsReader, id: BooleanSettingId): boolean {
	const fallback = reader.inspect(id)?.defaultValue;
	return typeof fallback === "boolean" ? fallback : false;
}

const ALL_SCOPES: readonly SettingScope[] = ["global", "workspace", "workspaceFolder"];

/**
 * Split an object setting by scope: the record the edit scope holds (writes
 * replace it whole) and, read-only, the records other scopes hold. Built from
 * inspection, never from the merged effective value; see ScopedRecordSetting
 * for why. `effectiveRaw` is the one merged read, sanitized the same way, for
 * the inspector's request-path view.
 */
function buildScopedRecord<V>(
	effectiveRaw: unknown,
	inspection: SettingsInspection | undefined,
	sanitize: (raw: unknown) => Record<string, V>
): ScopedRecordSetting<V> {
	const editScope = resolveUpdateScope(inspection);
	const rawByScope: Record<SettingScope, unknown> = {
		global: inspection?.globalValue,
		workspace: inspection?.workspaceValue,
		workspaceFolder: inspection?.workspaceFolderValue,
	};
	const otherScopes = ALL_SCOPES.filter((scope) => scope !== editScope)
		.map((scope) => ({ scope, value: sanitize(rawByScope[scope]) }))
		.filter((entry) => Object.keys(entry.value).length > 0);
	return { editScope, value: sanitize(rawByScope[editScope]), otherScopes, effective: sanitize(effectiveRaw) };
}

/**
 * Whether a normalized list DROPPED or rewrote anything from the raw
 * configured value. The state push carries only the normalized list, so
 * without this flag a list row cannot tell a clean list from one hiding
 * entries a comma-box edit would silently destroy; the flag forces the row's
 * read-only fallback instead. One rule for every normalized list setting (the
 * schema keywords, the language filter's list).
 */
function normalizedListLossy(raw: unknown, normalized: readonly string[]): boolean {
	if (raw === undefined) {
		return false;
	}
	return (
		!Array.isArray(raw) || raw.length !== normalized.length || normalized.some((value, index) => raw[index] !== value)
	);
}

/** The catalog status a headless or test build renders when no store rides the inputs. */
export const EMPTY_CATALOG_STATUS: CatalogStatusView = {
	modelCount: 0,
	lastSuccessAt: undefined,
	refreshing: false,
};

/** The usage snapshot a headless or test build renders when no poller rides the inputs. */
export const EMPTY_USAGE_VIEW: DashboardUsage = {
	servers: [],
	thresholds: [],
	pollIntervalMs: 0,
	discoveryTimeoutMs: 0,
	refreshing: false,
	refreshingExplicitly: false,
	generatedAt: 0,
};

export function readDashboardSettings(reader: SettingsReader, catalog: CatalogStatusView): DashboardSettings {
	// Read once, normalize once: the lossy verdict compares the same raw value
	// the normalized list came from.
	const rawKeywords = reader.get(ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY);
	const keywords = normalizeAdditionalToolSchemaKeywords(rawKeywords);
	return {
		numbers: recordFromKeys(NUMBER_SETTING_IDS, (id) => readNumberSetting(reader, id)),
		booleans: recordFromKeys(BOOLEAN_SETTING_IDS, (id) => readBooleanSetting(reader, id)),
		configuredScopes: {
			numbers: recordFromKeys(NUMBER_SETTING_IDS, (id) => resolveConfiguredScope(reader.inspect(id))),
			booleans: recordFromKeys(BOOLEAN_SETTING_IDS, (id) => resolveConfiguredScope(reader.inspect(id))),
		},
		modelParameters: buildScopedRecord(
			reader.get(MODEL_PARAMETERS_SETTING_KEY),
			reader.inspect(MODEL_PARAMETERS_SETTING_KEY),
			normalizeModelParameters
		),
		modelCapabilities: buildScopedRecord(
			reader.get(MODEL_CAPABILITIES_SETTING_KEY),
			reader.inspect(MODEL_CAPABILITIES_SETTING_KEY),
			normalizeModelCapabilities
		),
		catalog,
		appearance: {
			theme: normalizeUiTheme(reader.get(UI_THEME_SETTING_KEY)),
			themeScope: resolveConfiguredScope(reader.inspect(UI_THEME_SETTING_KEY)),
			accent: normalizeUiAccent(reader.get(UI_ACCENT_SETTING_KEY)),
			accentScope: resolveConfiguredScope(reader.inspect(UI_ACCENT_SETTING_KEY)),
		},
		chat: {
			tokenEstimation: normalizeTokenEstimationMode(reader.get(TOKEN_ESTIMATION_SETTING_KEY)),
			tokenEstimationScope: resolveConfiguredScope(reader.inspect(TOKEN_ESTIMATION_SETTING_KEY)),
			additionalToolSchemaKeywords: {
				values: keywords,
				lossy: normalizedListLossy(rawKeywords, keywords),
				scope: resolveConfiguredScope(reader.inspect(ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY)),
			},
		},
		usage: {
			statusBarMode: normalizeUsageStatusBarMode(reader.get(USAGE_STATUS_BAR_SETTING_KEY)),
			statusBarScope: resolveConfiguredScope(reader.inspect(USAGE_STATUS_BAR_SETTING_KEY)),
			alertThresholds: normalizeUsageAlertThresholds(reader.get(USAGE_ALERT_THRESHOLDS_SETTING_KEY)),
			thresholdsScope: resolveConfiguredScope(reader.inspect(USAGE_ALERT_THRESHOLDS_SETTING_KEY)),
			currencySymbol: normalizeCurrencySymbol(reader.get(CURRENCY_SYMBOL_SETTING_KEY)),
			currencySymbolScope: resolveConfiguredScope(reader.inspect(CURRENCY_SYMBOL_SETTING_KEY)),
		},
		featureModels: recordFromKeys(
			FEATURE_MODEL_IDS,
			(feature) => normalizeFeatureModelRef(reader.get(FEATURE_MODEL_SETTING_KEYS[feature]), feature) ?? null
		),
		featureModelScopes: recordFromKeys(FEATURE_MODEL_IDS, (feature) =>
			resolveConfiguredScope(reader.inspect(FEATURE_MODEL_SETTING_KEYS[feature]))
		),
		// CR-normalized at this boundary alone: the webview's textarea drafts in
		// \n, so a settings.json prompt written with \r\n would never compare
		// equal to its own round trip (a phantom "modified" draft on every push).
		// The request path (getCommitGenerationPrompt) keeps the stored text
		// verbatim - the prompt is model-facing.
		commitPrompt: normalizeCommitGenerationPrompt(reader.get(COMMIT_GENERATION_PROMPT_SETTING_KEY)).replace(
			/\r\n?/g,
			"\n"
		),
		commitPromptScope: resolveConfiguredScope(reader.inspect(COMMIT_GENERATION_PROMPT_SETTING_KEY)),
		languageFilter: (() => {
			const raw = reader.get(INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY);
			const filter = normalizeInlineLanguageFilter(raw);
			return {
				mode: filter.mode,
				languages: {
					values: filter.languages,
					lossy: languageFilterLossy(raw, filter),
					scope: resolveConfiguredScope(reader.inspect(INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY)),
				},
			};
		})(),
	};
}

/**
 * Whether a filter row edit would rewrite raw configured state the push
 * cannot carry: a value normalization rewrote (unrecognized mode, dropped or
 * trimmed language entries) or keys a { mode, languages } write would drop.
 * The whole-object twin of normalizedListLossy, and the same read-only
 * fallback consumes it.
 */
function languageFilterLossy(raw: unknown, filter: InlineLanguageFilter): boolean {
	if (raw === undefined) {
		return false;
	}
	if (
		typeof raw !== "object" ||
		raw === null ||
		Array.isArray(raw) ||
		!("mode" in raw) ||
		typeof raw.mode !== "string" ||
		!(LANGUAGE_FILTER_MODES as readonly string[]).includes(raw.mode)
	) {
		return true;
	}
	if (Object.keys(raw).some((key) => key !== "mode" && key !== "languages")) {
		return true;
	}
	const languages = (raw as { readonly languages?: unknown }).languages;
	return languages === undefined ? false : normalizedListLossy(languages, filter.languages);
}

/**
 * Legacy-registry servers with no server row of their own: after a sweep a
 * registry server can also surface as an external snapshot row (same base
 * URL), and the same server must never be stated twice.
 */
function countUnlistedLegacyServers(
	servers: readonly DashboardServer[],
	legacyServers: readonly { readonly baseUrl: string }[]
): number {
	const shown = new Set(servers.map((server) => normalizeBaseUrl(server.baseUrl)));
	return legacyServers.filter((server) => !shown.has(normalizeBaseUrl(server.baseUrl))).length;
}

/**
 * What the request path would resolve for one server's requests, as panel.ts
 * resolves it: the group's label paired with the declared entry's own
 * modelParameters, through the SAME resolver chat requests use. Undefined for
 * unlabeled groups, legacy-registry snapshots, and labels no declared entry
 * matches at that URL - exactly the requests that get only the global setting.
 */
export type EntryParametersResolution = {
	readonly entryLabel: string;
	readonly entryParameters: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

/**
 * Everything buildDashboardState reduces, as one options object. Only
 * `snapshots` and `reader` are required; every optional input defaults to the
 * value that is right where the corresponding store cannot contribute (tests,
 * headless callers).
 */
export interface DashboardStateInputs {
	readonly snapshots: readonly ServerModelsSnapshot[];
	readonly reader: SettingsReader;
	/** The declared views with their proof source; see DeclaredServersInput. Defaults to the engine's empty list. */
	readonly declared?: DeclaredServersInput;
	/** The per-entry acceptance reports (serverSettingReports); drives the Misconfigured rows. */
	readonly entryReports?: readonly ServerEntryReport[];
	/** The legacy registry's servers, reduced to base URLs; see DashboardState.legacyServerCount. */
	readonly legacyServers?: readonly { readonly baseUrl: string }[];
	readonly removedGroups?: RemovedGroupsView;
	/**
	 * Whether a snapshot belongs to a provider group (vs the legacy registry);
	 * gates tombstone suppression and the external rows' hideable flag. The
	 * default treats everything as a group.
	 */
	readonly isGroupSnapshot?: (serverId: string) => boolean;
	/**
	 * Whether a tombstoned identity's group was observed alive at some point
	 * this session (suppressed groups still report, deleted groups never do).
	 * Gates the hidden-groups line only: offering Unhide for a tombstone whose
	 * group the host no longer holds would reference nothing. The default shows
	 * everything.
	 */
	readonly wasGroupObserved?: (label: string, baseUrl: string) => boolean;
	/** The OpenRouter catalog row's status; defaults to the empty snapshot. */
	readonly catalog?: CatalogStatusView;
	/** The Servers page's usage snapshot; defaults to the empty view. */
	readonly usage?: DashboardUsage;
	/** The Configuration diagnostics list; defaults to none. */
	readonly diagnostics?: readonly ConfigDiagnosticView[];
	/** The features whose model row offers a host-side probe; defaults to none (no Test buttons). */
	readonly featureProbes?: readonly FeatureModelId[];
}

/**
 * The hidden-groups view both the servers section and Configuration
 * diagnostics render: the tombstones themselves, never live snapshots (an
 * unhide must stay offered after the suppressed group's snapshot ages out of
 * the status window), gated by the session-sticky observation set so a
 * tombstone whose group the host no longer holds is not offered as a ghost.
 */
export function visibleHiddenGroups(
	removedGroups: RemovedGroupsView,
	wasGroupObserved: (label: string, baseUrl: string) => boolean
): HiddenGroup[] {
	return removedGroups.tombstones
		.filter((identity) => wasGroupObserved(identity.label, identity.baseUrl))
		.map((identity) => ({ label: identity.label, baseUrl: identity.baseUrl }))
		.sort((a, b) => a.label.localeCompare(b.label) || a.baseUrl.localeCompare(b.baseUrl));
}

/**
 * The union of the snapshots' observed /model/info keys, across the snapshots
 * that carry a set (sorted for a stable push). Undefined when none does: "no
 * server has reported keys" must stay distinguishable from "the servers
 * reported none", because the advisory-hint filter drops every hint on the
 * former. Observed keys are server-derived strings: Set-built, never raw
 * object keys ("__proto__" is a legal member), and never logged.
 */
export function observedModelInfoKeysUnion(
	snapshots: readonly Pick<ServerModelsSnapshot, "observedModelInfoKeys">[]
): readonly string[] | undefined {
	const reported = snapshots.map((snapshot) => snapshot.observedModelInfoKeys).filter((keys) => keys !== undefined);
	if (reported.length === 0) {
		return undefined;
	}
	const union = new Set<string>();
	for (const keys of reported) {
		for (const key of keys) {
			union.add(key);
		}
	}
	// Code-unit order, matching discovery's own per-server sort: these are
	// wire identifiers, and locale collation would make the push host-dependent.
	return [...union].sort();
}

/**
 * Each declared entry's observed /model/info key set, keyed by entry label,
 * joined by the same passes the servers table renders from (joinDeclared).
 * Entries with no snapshot, or whose snapshot carries no set, are absent - the
 * advisory-hint filter reads absence as "unknown" and stays silent. Same
 * handling rules as observedModelInfoKeysUnion (Map-keyed, never logged).
 */
export function observedKeysByEntryLabel(
	snapshots: readonly ServerModelsSnapshot[],
	declared: readonly DeclaredServerView[]
): ReadonlyMap<string, readonly string[]> {
	const { matchedByDeclared } = joinDeclared(labeledSnapshots(snapshots), declared);
	const byLabel = new Map<string, readonly string[]>();
	declared.forEach((view, declaredIndex) => {
		const keys = matchedByDeclared.get(declaredIndex)?.entry.snapshot.observedModelInfoKeys;
		if (keys !== undefined) {
			byLabel.set(view.label, keys);
		}
	});
	return byLabel;
}

export function buildDashboardState(inputs: DashboardStateInputs): DashboardState {
	const {
		snapshots,
		reader,
		declared = { source: "engine", views: [] },
		entryReports = [],
		legacyServers = [],
		removedGroups = NO_REMOVED_GROUPS,
		isGroupSnapshot = () => true,
		wasGroupObserved = () => true,
		catalog = EMPTY_CATALOG_STATUS,
		usage = EMPTY_USAGE_VIEW,
		diagnostics = [],
		featureProbes = [],
	} = inputs;
	const labeled = labeledSnapshots(snapshots);
	const { servers, snapshotLabels } = buildServers(labeled, declared, entryReports, removedGroups, isGroupSnapshot);
	// See visibleHiddenGroups for why this renders from the tombstones, not from
	// live snapshots.
	const hiddenGroups = visibleHiddenGroups(removedGroups, wasGroupObserved);
	const observedUnion = observedModelInfoKeysUnion(snapshots);
	return {
		servers,
		hiddenGroups,
		// The served-count truth for the hero and the paste line, reduced like
		// reportMerged's totalModels but over the VISIBLE snapshots only: a
		// tombstoned snapshot's models leave the tables (snapshotLabels drops
		// them), so its count must leave the headline too. Immune to the models
		// array's per-claimant copies either way.
		servedModelCount: labeled.reduce(
			(sum, entry, index) =>
				(snapshotLabels[index] ?? []).length > 0 ? sum + entry.snapshot.status.servedModelCount : sum,
			0
		),
		models: labeled
			.flatMap(({ snapshot, label }, index) =>
				(snapshotLabels[index] ?? [label]).flatMap((serverLabel) =>
					snapshot.models.map((info) =>
						buildModel(info, serverLabel, snapshot.status.serverId, modelScopeKey(snapshot.status.serverId))
					)
				)
			)
			.sort((a, b) => a.serverLabel.localeCompare(b.serverLabel) || a.name.localeCompare(b.name)),
		...(observedUnion !== undefined ? { observedModelInfoKeys: observedUnion } : {}),
		settings: readDashboardSettings(reader, catalog),
		featureProbes,
		usage,
		diagnostics,
		legacyServerCount: countUnlistedLegacyServers(servers, legacyServers),
	};
}

/** A per-entry modelCapabilities record as the request-scope resolution hands it over. */
export type EntryCapabilitiesRecord = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** What the readModelCapabilities responder resolves against; panel.ts supplies the live stores. */
export interface ModelCapabilitiesQuery {
	readonly snapshots: readonly ServerModelsSnapshot[];
	readonly reader: SettingsReader;
	/** The declared entry's own modelCapabilities for a snapshot's server, resolved like entry modelParameters. */
	readonly resolveEntryCapabilities: (serverId: string) => EntryCapabilitiesRecord | undefined;
	/** The OpenRouter catalog as in-memory lookup; EMPTY_CATALOG_LOOKUP when no snapshot exists. */
	readonly catalog: CapabilityCatalogLookup;
	/**
	 * The provider's shared flat resolution table, so the inspector reads the
	 * SAME cache requests and registration use. Absent, the responder runs the
	 * same pure walk uncached (tests, headless callers).
	 */
	readonly resolution?: ModelResolutionTable | undefined;
}

/**
 * Answer one readModelCapabilities request: locate the model behind the scope
 * key and raw ID, then run the SAME resolveModelCapabilities walk registration
 * runs, through the provider's shared resolution table when the query carries
 * one. A store change between the push and the request can de-resolve the key;
 * undefined tells the inspector the state moved on instead of inventing values.
 */
export function resolveDashboardModelCapabilities(
	query: ModelCapabilitiesQuery,
	scopeKey: string,
	rawId: string
): EffectiveCapabilities | undefined {
	// Scope keys hash the server ID (modelScopeKey), so a stale key resolves to
	// nothing rather than to another server.
	const labeled = labeledSnapshots(query.snapshots).find(
		(entry) => modelScopeKey(entry.snapshot.status.serverId) === scopeKey
	);
	if (labeled === undefined) {
		return undefined;
	}
	const { snapshot } = labeled;
	const serverId = snapshot.status.serverId;
	const info = snapshot.models.find((model) => rawModelIdFromExposed(model.id, serverId) === rawId);
	if (info === undefined) {
		return undefined;
	}
	const inputs = {
		globalCapabilities: normalizeModelCapabilities(query.reader.get(MODEL_CAPABILITIES_SETTING_KEY)),
		entryCapabilities: query.resolveEntryCapabilities(serverId),
		catalog: query.catalog,
		// Registration's post-aggregation baseline, riding every pre-attach model:
		// the inspector resolves over the same walk registration serves.
		serverDeclared: info.litellm.serverDeclared,
	};
	const resolved =
		query.resolution !== undefined
			? query.resolution.resolveCapabilities(serverId, rawId, inputs)
			: resolveModelCapabilities({ rawModelId: rawId, ...inputs });
	// The advisory filter judges each hint by its layer's own evidence, the SAME
	// evidence Configuration diagnostics and the settings editor use: entry
	// records apply to this server only, so its own listing judges them; a global
	// record applies to every server, so a key ANY server observed is real (the
	// cross-server union). The non-global branch falls back to the stricter
	// per-server evidence deliberately, so a future RecordLayer member fails safe
	// (fewer hints) instead of borrowing the union's broader proof.
	if (!resolved.diagnostics.some((diagnostic) => diagnostic.kind === "unrecognized-key")) {
		return resolved;
	}
	const entryEvidence = observedEvidenceSet(snapshot.observedModelInfoKeys);
	const globalEvidence = observedEvidenceSet(observedModelInfoKeysUnion(query.snapshots));
	const diagnostics = filterUnrecognizedKeys(resolved.diagnostics, (diagnostic) =>
		diagnostic.layer === "global" ? globalEvidence : entryEvidence
	);
	return diagnostics.length === resolved.diagnostics.length ? resolved : { ...resolved, diagnostics };
}

/** What the readModelParameters responder resolves against; panel.ts supplies the live stores. */
export interface ModelParametersQuery {
	readonly snapshots: readonly ServerModelsSnapshot[];
	readonly reader: SettingsReader;
	/** The request path's per-entry modelParameters resolution for a snapshot's server. */
	readonly resolveEntryParameters: (serverId: string) => EntryParametersResolution | undefined;
	/** The provider's shared flat resolution table; absent, the responder runs the same pure walk uncached. */
	readonly resolution?: ModelResolutionTable | undefined;
}

/**
 * Answer one readModelParameters request: locate the model behind the scope
 * key and raw ID, resolve the configured merge through the provider's shared
 * flat table when the query carries one, and project it into the inspector's
 * rows (entry-layer refs carry the declared entry's label). Undefined when the
 * key or model no longer resolves, like resolveDashboardModelCapabilities.
 */
export function resolveDashboardModelParameters(
	query: ModelParametersQuery,
	scopeKey: string,
	rawId: string
): EffectiveParametersProjection | undefined {
	const labeled = labeledSnapshots(query.snapshots).find(
		(entry) => modelScopeKey(entry.snapshot.status.serverId) === scopeKey
	);
	if (labeled === undefined) {
		return undefined;
	}
	const { snapshot } = labeled;
	const serverId = snapshot.status.serverId;
	const info = snapshot.models.find((model) => rawModelIdFromExposed(model.id, serverId) === rawId);
	if (info === undefined) {
		return undefined;
	}
	const entry = query.resolveEntryParameters(serverId);
	const inputs = {
		globalParameters: normalizeModelParameters(query.reader.get(MODEL_PARAMETERS_SETTING_KEY)),
		entryParameters: entry?.entryParameters,
	};
	const resolved =
		query.resolution !== undefined
			? query.resolution.resolveParameters(serverId, rawId, inputs)
			: resolveModelParameters({ rawModelId: rawId, ...inputs });
	return projectResolvedParameters(
		resolved,
		{
			maxOutputTokens: info.maxOutputTokens,
			outputLimitDeclared: info.litellm.outputLimitSource !== "defaults",
		},
		entry?.entryLabel
	);
}

/**
 * The most specific GLOBAL record key matching a model, for the inspectors'
 * configure-jump: the webview holds no resolver logic, so the extension names
 * the record to focus - or none, and the editor creates a fresh exact-ID draft.
 */
export function mostSpecificGlobalRecordKey(
	reader: SettingsReader,
	kind: "parameters" | "capabilities",
	rawId: string
): string | undefined {
	const records =
		kind === "parameters"
			? normalizeModelParameters(reader.get(MODEL_PARAMETERS_SETTING_KEY))
			: normalizeModelCapabilities(reader.get(MODEL_CAPABILITIES_SETTING_KEY));
	const { chain } = matchChain(rawId, records);
	return chain[chain.length - 1]?.key;
}
