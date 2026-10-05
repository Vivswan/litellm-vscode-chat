/**
 * Inputs are plain values or injected adapters, never live vscode objects; panel.ts owns the vscode wiring, intents.ts
 * the intent validation and execution.
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
import {
	entryUsesSecretField,
	pickEntryViewFields,
	pickNonSecretOptionalFields,
	SECRET_FIELD_IDS,
} from "../../shared/serverEntry";
import type { ServerStatus } from "../../shared/servers";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { recordFromKeys } from "../../shared/util/json";
import type { TombstoneIdentity } from "../servers/groupRemovals";
import { tombstoneHides } from "../servers/groupRemovals";
import type { DeclaredServerView, DrawableReject, ServerEntryReport } from "../servers/serverSync";
import { drawableRejects, rejectedCarrierLabels, supersedingBaseUrl } from "../servers/serverSync";
import { declaredPresentation } from "../servers/syncFailureOverlay";
import type { SettingsInspection } from "../settingsAccess";
import { resolveConfiguredScope, resolveUpdateScope } from "../settingsAccess";
import { adoptSourceHandle, locateModel, modelScopeKey } from "./adoptHandle";
import type { GroupOwnership, LabeledSnapshot, LegacySnapshot } from "./declaredJoin";
import { labeledSnapshots, resolveGroupOwnership } from "./declaredJoin";

export interface RemovedGroupsView {
	readonly tombstones: readonly TombstoneIdentity[];
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

/**
 * The push's one timestamp conversion: ServerStatus.lastChecked (an ISO string internally and in persisted status)
 * becomes epoch milliseconds on the wire, the same vocabulary every other pushed timestamp uses. The "" never-checked
 * sentinel (syncFailureOverlay's synthetic statuses, restoreServerStatus) maps to a DELIBERATE absent value, as does
 * anything unparseable, so no consumer ever NaN-guards a timestamp again.
 */
function checkedAtMs(lastChecked: string | undefined): number | undefined {
	if (lastChecked === undefined || lastChecked === "") {
		return undefined;
	}
	const ms = new Date(lastChecked).getTime();
	return Number.isNaN(ms) ? undefined : ms;
}

function buildServer(
	snapshot: ServerModelsSnapshot,
	label: string,
	identity:
		| { readonly origin: "external"; readonly provenance: ExternalServerProvenance | undefined }
		| { readonly origin: "legacy"; readonly entryLabel: string }
): DashboardServer {
	const { status } = snapshot;
	const base = {
		label,
		baseUrl: status.baseUrl,
		lastChecked: checkedAtMs(status.lastChecked),
		credentials: status.hasApiKey === true ? "present" : "absent",
		hasOAuth: status.hasOAuth === true,
		...(identity.origin === "external"
			? ({
					origin: "external",
					adoptHandle: adoptSourceHandle(status.serverId),
					...(identity.provenance !== undefined ? { provenance: identity.provenance } : {}),
				} as const)
			: ({
					origin: "legacy",
					entryLabel: identity.entryLabel,
					groupHandle: adoptSourceHandle(status.serverId),
				} as const)),
		...(snapshot.observedModelInfoKeys !== undefined ? { observedModelInfoKeys: snapshot.observedModelInfoKeys } : {}),
		...(snapshot.skippedModeCounts !== undefined ? { skippedModeCounts: snapshot.skippedModeCounts } : {}),
	} as const;
	return status.state === "ok"
		? { ...base, state: "ok", servedModelCount: status.servedModelCount }
		: {
				...base,
				state: "error",
				servedModelCount: status.servedModelCount,
				error: status.error,
				errorEnglish: status.logSafeError,
				...(status.classification !== undefined ? { classification: status.classification } : {}),
				...(status.expected === true ? { expected: true } : {}),
				...(status.declaredModelCount !== undefined ? { declaredModelCount: status.declaredModelCount } : {}),
			};
}

/**
 * A sync error outranks even a healthy live status, because the serving group runs the entry's OLD configuration
 * and the remove-and-resync line must show. The status bar's overlay (applySyncFailures) reads the same rule with
 * ONE status per snapshot, so the two surfaces agree by summation of the per-claimant counts.
 */
function declaredOutcome(
	status: ServerStatus | undefined,
	syncFailure: DeclaredServerView["syncFailure"],
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
	const presentation = declaredPresentation(status, syncFailure);
	if (presentation.kind === "sync-failed") {
		return {
			state: "error",
			// An upsertFailed claimant of a SHARED snapshot renders no model rows (snapshotLabels drops its label), so
			// the live count would claim models the tables do not show; the count follows the rendered rows.
			servedModelCount: labelServes ? presentation.servedModelCount : 0,
			error: presentation.failure.message,
		};
	}
	// The second test is what narrows `status` below: "unchecked" already means an absent status, but the kind alone
	// tells the compiler nothing.
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
		// Stale-window and declared models serve through ANY discovery failure, so the row's count must match the
		// picker whether or not the failure was expected.
		servedModelCount: status.servedModelCount,
		error: status.error,
		errorEnglish: status.logSafeError,
		...(status.classification !== undefined ? { classification: status.classification } : {}),
		...(status.expected === true ? { expected: true } : {}),
		...(status.declaredModelCount !== undefined ? { declaredModelCount: status.declaredModelCount } : {}),
	};
}

/**
 * The sync engine reads the secret blobs; the pre-first-pass settings fallback cannot check SecretStorage
 * synchronously, so a field it reports "none" may really be "secure". The tag is producer-owned -
 * declaredViewsFromSetting returns its views already marked "settings-fallback" - and proof is still judged per view
 * (secretsView): an engine view whose own blob read failed is as blind as the fallback.
 */
export type DeclaredServersInput =
	| { readonly source: "engine"; readonly views: readonly DeclaredServerView[] }
	| { readonly source: "settings-fallback"; readonly views: readonly DeclaredServerView[] };

/**
 * An engine view is proven by its blob read - except under the "secretsUnreadable" class, the one skip whose locations
 * are a guess (the blob read failed and the view degraded to the inline-only reading); the other skip classes keep
 * their successful read. Without a blob read, a view is proven only when every secret field reads "settings": inline
 * wins over any blob, so the setting alone proves those - while a "none" is just "no inline value", and the row must
 * say unproven instead of denying a secure blob nobody read.
 */
function secretsView(view: DeclaredServerView, source: DeclaredServersInput["source"]): ServerSecretsView {
	const locationsGuessed = view.syncFailure?.class === "secretsUnreadable";
	if (
		(source === "engine" && !locationsGuessed) ||
		SECRET_FIELD_IDS.every((field) => view.secrets[field] === "settings")
	) {
		return { kind: "proven", locations: view.secrets };
	}
	return { kind: "unproven" };
}

export function rejectsWithOwnRow(
	entryReports: readonly ServerEntryReport[],
	declared: readonly Pick<DeclaredServerView, "label">[]
): readonly DrawableReject[] {
	return drawableRejects(entryReports, new Set(declared.map((view) => view.label)));
}

/**
 * A pre-label group reports under its URL host (the host never hands the extension the group name), so the join
 * cannot require a label match (resolveGroupOwnership). `snapshotLabels` lists each joined claimant, because the
 * picker lists the models under each, minus upsertFailed ones unless none else remains; exact host cardinality is
 * not recoverable from declarations alone, hence that first-claimant fallback.
 */
function buildServers(
	labeled: readonly LabeledSnapshot[],
	declaredInput: DeclaredServersInput,
	entryReports: readonly ServerEntryReport[],
	removedGroups: RemovedGroupsView,
	ownership: GroupOwnership,
	tombstoned: ReadonlySet<LabeledSnapshot>
): { servers: DashboardServer[]; snapshotLabels: string[][] } {
	const declared = declaredInput.views;
	const { matchedByDeclared, external, legacy } = ownership;
	// Provenance is keyed by the snapshot's own status label (never the display label, which can carry a collision
	// ordinal) plus the normalized base URL.
	const originFor = (snapshot: ServerModelsSnapshot) =>
		removedGroups.origins.find(
			(record) =>
				record.label === snapshot.status.label &&
				normalizeBaseUrl(record.baseUrl) === normalizeBaseUrl(snapshot.status.baseUrl)
		)?.origin;
	// Countable claimant labels per snapshot, in declared order, with the first claimant of any state as the
	// render-at-least-once fallback. Built whole before any row, because a shared snapshot's rows need the full
	// claimant picture to report their own served counts.
	const claimants = new Map<LabeledSnapshot, { labels: string[]; fallback: string }>();
	declared.forEach((view, declaredIndex) => {
		const matched = matchedByDeclared.get(declaredIndex)?.entry;
		if (matched !== undefined) {
			const claimed = claimants.get(matched) ?? { labels: [], fallback: view.label };
			if (view.syncFailure?.class !== "upsertFailed") {
				claimed.labels.push(view.label);
			}
			claimants.set(matched, claimed);
		}
	});
	// The labels a snapshot's models render under; snapshotLabels and the rows' served counts read the same rule, so
	// they cannot diverge.
	const labelsRenderedFor = (entry: LabeledSnapshot): string[] => {
		const claimed = claimants.get(entry);
		if (claimed === undefined) {
			return [entry.label];
		}
		return claimed.labels.length > 0 ? claimed.labels : [claimed.fallback];
	};
	const servers: DashboardServer[] = [];
	// Hidden groups leave the table AND the models list; for tombstones this only bridges the window between the
	// write and the host's re-resolution, for superseded leftovers it is the rule itself.
	const hidden = new Set<LabeledSnapshot>([
		...tombstoned,
		...legacy.flatMap((leftover) => (supersededBy(leftover, declared) === undefined ? [] : [leftover.labeled])),
	]);
	declared.forEach((view, declaredIndex) => {
		const match = matchedByDeclared.get(declaredIndex);
		const matched = match?.entry;
		// Only the exact labeled-identity join proves the live group carries this entry's label, which is what the
		// request path's label-and-URL resolution keys on. Any other pass means the entry's entry-only fields may
		// silently not apply, and the row must say so instead of rendering healthy; modelParameters and the
		// capability/expected-failure pair get separate classifications so a row names exactly what is inactive.
		const entryFieldsInactive = match !== undefined && match.pass !== "identity";
		const notices: DeclaredServerNotice[] = [];
		if (entryFieldsInactive && view.modelParameters !== undefined) {
			notices.push("entry-params-inactive");
		}
		if (
			entryFieldsInactive &&
			(view.modelCapabilities !== undefined ||
				view.expectedFailures !== undefined ||
				view.declaredModels !== undefined ||
				view.includeModes !== undefined)
		) {
			notices.push("entry-capabilities-inactive");
		}
		if (entryFieldsInactive && view.headers !== undefined) {
			notices.push("entry-headers-inactive");
		}
		// "" is a real override (append nothing), so !== undefined is the right activity check here too.
		if (entryFieldsInactive && view.apiVersion !== undefined) {
			notices.push("entry-api-version-inactive");
		}
		const outcome = declaredOutcome(
			matched?.snapshot.status,
			view.syncFailure,
			matched === undefined || labelsRenderedFor(matched).includes(view.label)
		);
		if (outcome.state === "error" && outcome.expected === true && outcome.servedModelCount === 0) {
			// An expected failure serving NOTHING - no declared models, and the stale window holds nothing; only a
			// declared-models list can fix that, so the row says so. A serving row stays quiet, whatever mix of
			// declared and stale models it serves.
			notices.push("expected-failures-nothing-declared");
		}
		if (
			outcome.state === "ok" &&
			outcome.servedModelCount === 0 &&
			Object.values(matched?.snapshot.skippedModeCounts ?? {}).some((count) => count > 0)
		) {
			// Every usable model the server lists has a mode discovery drops by default; only the entry's includeModes
			// can admit them, so the row says so instead of reading as a healthy empty server.
			notices.push("non-chat-modes-skipped");
		}
		const secrets = secretsView(view, declaredInput.source);
		// The presence verdict reads the SAME union the edit form gates on. Only the deny needs proof: an unproven
		// view's non-"none" location can only be "settings" (both blind readings are inline-only, and inline wins over
		// any blob), and the live group's report is the host's own truth - but an unproven "none" is a guess, and the
		// row says "unknown" instead of denying a secure key nobody read.
		const knownPresent = matched?.snapshot.status.hasApiKey === true || view.secrets.apiKey !== "none";
		servers.push({
			label: view.label,
			baseUrl: view.baseUrl,
			lastChecked: checkedAtMs(matched?.snapshot.status.lastChecked),
			credentials: knownPresent ? "present" : secrets.kind === "proven" ? "absent" : "unknown",
			// The badge reads the same wire rule the secret machinery judges by: an active OAuth unit is
			// entryUsesSecretField's oauthClientSecret arm.
			hasOAuth: entryUsesSecretField(view, "oauthClientSecret"),
			origin: "declared",
			...(matched?.snapshot.observedModelInfoKeys !== undefined
				? { observedModelInfoKeys: matched.snapshot.observedModelInfoKeys }
				: {}),
			...(matched?.snapshot.skippedModeCounts !== undefined
				? { skippedModeCounts: matched.snapshot.skippedModeCounts }
				: {}),
			config: {
				//   Both registries ride whole -> no per-field emptiness re-checks here - a field registered in
				//     ENTRY_VIEW_FIELD_SET reaches the edit form's prefill by construction
				...pickNonSecretOptionalFields(view),
				...pickEntryViewFields(view),
				secrets,
			},
			...(notices.length > 0 ? { notices } : {}),
			// The webview's declare offers key on the classification itself, since the notices exist only for the field
			// families the entry configures.
			...(entryFieldsInactive ? { entryFieldsInactive: true as const } : {}),
			...outcome,
		});
	});
	for (const entry of external) {
		servers.push(
			buildServer(entry.snapshot, entry.label, { origin: "external", provenance: originFor(entry.snapshot) })
		);
	}
	// A legacy leftover the provider still serves from has a row, like the picker has its models; the superseded
	// ones (hidden above) match the provider's own suppression and leave both.
	for (const { labeled, entryLabel } of legacy) {
		if (hidden.has(labeled)) {
			continue;
		}
		servers.push(buildServer(labeled.snapshot, labeled.label, { origin: "legacy", entryLabel }));
	}
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
			// English by the issue-report policy, like the parser problems the row carries; the webview renders its own
			// localized copy.
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

function buildModel(info: PreAttachModelInfo, serverLabel: string, scopeKey: string): DashboardModel {
	return {
		id: info.id,
		// The request's `model` field: the raw ID the mint stamped onto the model's litellm metadata, never re-derived
		// from the exposed ID.
		rawId: info.litellm.rawModelId,
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
 * The value shown for a number setting: a configured finite number (or null where null is legal) passes through even
 * when out of range, because the dashboard shows what is configured; anything unusable falls back to the package.json
 * default so the form still renders a real value.
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
 * Built from inspection, never from the merged effective value; see ScopedRecordSetting for why. `effectiveRaw` is the
 * one merged read, sanitized the same way, for the inspector's request-path view.
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
 * The state push carries only the normalized list, so without this flag a list row cannot tell a clean list from one
 * hiding entries a comma-box edit would silently destroy; the flag forces the row's read-only fallback instead. One
 * rule for every normalized list setting (the schema keywords, the language filter's list).
 */
function normalizedListLossy(raw: unknown, normalized: readonly string[]): boolean {
	if (raw === undefined) {
		return false;
	}
	return (
		!Array.isArray(raw) || raw.length !== normalized.length || normalized.some((value, index) => raw[index] !== value)
	);
}

export const EMPTY_CATALOG_STATUS: CatalogStatusView = {
	modelCount: 0,
	lastSuccessAt: undefined,
	refreshing: false,
};

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
	// Read once, normalize once: the lossy verdict compares the same raw value the normalized list came from.
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
		// CR-normalized at this boundary alone: the webview's textarea drafts in \n, so a settings.json prompt written
		// with \r\n would never compare equal to its own round trip (a phantom "modified" draft on every push). The
		// request path (getCommitGenerationPrompt) keeps the stored text verbatim - the prompt is model-facing.
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
 * Whether a filter row edit would rewrite raw configured state the push cannot carry: a value normalization rewrote
 * (unrecognized mode, dropped or trimmed language entries) or keys a { mode, languages } write would drop. The
 * whole-object twin of normalizedListLossy, and the same read-only fallback consumes it.
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
 * What the request path would resolve for one server's requests, as panel.ts resolves it: the group's label paired with
 * the declared entry's own modelParameters, through the SAME resolver chat requests use. Undefined for unlabeled groups
 * and labels no declared entry matches at that URL - exactly the requests that get only the global setting.
 */
export type EntryParametersResolution = {
	readonly entryLabel: string;
	readonly entryParameters: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

export interface DashboardStateInputs {
	readonly snapshots: readonly ServerModelsSnapshot[];
	readonly reader: SettingsReader;
	readonly declared?: DeclaredServersInput;
	/** The per-entry acceptance reports (serverSettingReports): the Misconfigured rows and the ownership's carriers. */
	readonly entryReports?: readonly ServerEntryReport[];
	/** The declared labels whose stored secret each live group carries, by server ID (storedSecretHolders). */
	readonly secretHolders?: ReadonlyMap<string, readonly string[]>;
	readonly removedGroups?: RemovedGroupsView;
	/**
	 * Whether a tombstoned identity's group was observed alive at some point this session (suppressed groups still
	 * report, deleted groups never do). Gates the hidden-groups line only: offering Unhide for a tombstone whose group
	 * the host no longer holds would reference nothing.
	 */
	readonly wasGroupObserved?: (tombstone: TombstoneIdentity) => boolean;
	/**
	 * Like wasGroupObserved, but only for observations of a LABELED group at the identity (its configuration carried
	 * the entry label): what lets a tombstone be classified superseded once its entry declares another URL. The default
	 * observes nothing, so tombstones read as removed.
	 */
	readonly wasLabeledGroupObserved?: (tombstone: TombstoneIdentity) => boolean;
	readonly catalog?: CatalogStatusView;
	readonly usage?: DashboardUsage;
	readonly diagnostics?: readonly ConfigDiagnosticView[];
	/** The features whose model row offers a host-side probe; defaults to none (no Test buttons). */
	readonly featureProbes?: readonly FeatureModelId[];
}

/**
 * The URL a legacy leftover's stamped entry now declares, when the leftover is the one legacy class the provider
 * suppresses too (isGroupSuppressed, by the group's own stamp): a group STAMPED with an accepted label whose entry
 * moved, whichever label's secret it holds. An unstamped holder of a moved entry's secret is a legacy row instead,
 * because the provider keeps serving it.
 */
function supersededBy(leftover: LegacySnapshot, declared: readonly DeclaredServerView[]): string | undefined {
	const { snapshot } = leftover.labeled;
	return snapshot.entryLabel === undefined
		? undefined
		: supersedingBaseUrl(declared, snapshot.entryLabel, snapshot.status.baseUrl);
}

/** The superseded leftovers among the ownership's legacy groups, as hidden-groups rows; see HiddenGroup. */
function supersededLeftovers(ownership: GroupOwnership, declared: readonly DeclaredServerView[]): HiddenGroup[] {
	return ownership.legacy.flatMap((leftover): HiddenGroup[] => {
		const declaredBaseUrl = supersededBy(leftover, declared);
		const { status } = leftover.labeled.snapshot;
		return declaredBaseUrl === undefined
			? []
			: [{ label: status.label, baseUrl: status.baseUrl, reason: "superseded", declaredBaseUrl }];
	});
}

interface HiddenGroupsInputs {
	readonly removedGroups: RemovedGroupsView;
	readonly declared: readonly DeclaredServerView[];
	/** The live leftovers the ownership hides (supersededLeftovers). */
	readonly superseded: readonly HiddenGroup[];
	/** See DashboardStateInputs.wasGroupObserved. */
	readonly wasGroupObserved: (tombstone: TombstoneIdentity) => boolean;
	/** See DashboardStateInputs.wasLabeledGroupObserved. */
	readonly wasLabeledGroupObserved: (tombstone: TombstoneIdentity) => boolean;
}

/**
 * Removed groups render from the tombstones, never live snapshots, so an unhide stays offered after the group's
 * snapshot ages out of the status window. A superseded verdict holds without a live snapshot too, because an idle
 * window evicts and re-reports live groups.
 *
 *   tombstone never observed this session                              -> not offered as a ghost
 *   tombstone seen as a LABELED group, entry now declaring another URL -> superseded, since an Unhide could not lift it
 */
function visibleHiddenGroups(inputs: HiddenGroupsInputs): HiddenGroup[] {
	const { removedGroups, declared, superseded, wasGroupObserved, wasLabeledGroupObserved } = inputs;
	// One row per reason and shown identity, the key the webview lists by: two client-ID tombstones under one label
	// and URL unhide together, so one row acts; a superseded leftover under a removed row's identity is another group
	// and keeps its own row, two superseded ones read the same.
	const shown = new Map<string, HiddenGroup>();
	const show = (group: HiddenGroup) => {
		const key = JSON.stringify([group.reason, group.label, normalizeBaseUrl(group.baseUrl)]);
		if (!shown.has(key)) {
			shown.set(key, group);
		}
	};
	for (const identity of removedGroups.tombstones) {
		if (wasGroupObserved(identity)) {
			show(tombstoneRow(identity));
		}
	}
	for (const group of superseded) {
		show(group);
	}
	function tombstoneRow(identity: TombstoneIdentity): HiddenGroup {
		const labeled = wasLabeledGroupObserved(identity);
		const declaredBaseUrl = labeled ? supersedingBaseUrl(declared, identity.label, identity.baseUrl) : undefined;
		if (declaredBaseUrl !== undefined) {
			return { label: identity.label, baseUrl: identity.baseUrl, reason: "superseded", declaredBaseUrl };
		}
		return {
			label: identity.label,
			baseUrl: identity.baseUrl,
			reason: "removed",
			...(labeled ? { syncedName: identity.label } : {}),
		};
	}
	return [...shown.values()].sort((a, b) => a.label.localeCompare(b.label) || a.baseUrl.localeCompare(b.baseUrl));
}

/**
 * Undefined when none does: "no server has reported keys" must stay distinguishable from "the servers reported none",
 * because the advisory-hint filter drops every hint on the former. Observed keys are server-derived strings: Set-built,
 * never raw object keys ("__proto__" is a legal member), and never logged.
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
	// Code-unit order, matching discovery's own per-server sort: these are wire identifiers, and locale collation would
	// make the push host-dependent.
	return [...union].sort();
}

export function buildDashboardState(inputs: DashboardStateInputs): DashboardState {
	const {
		snapshots,
		reader,
		declared = { source: "engine", views: [] },
		entryReports = [],
		secretHolders,
		removedGroups = NO_REMOVED_GROUPS,
		wasGroupObserved = () => true,
		wasLabeledGroupObserved = () => false,
		catalog = EMPTY_CATALOG_STATUS,
		usage = EMPTY_USAGE_VIEW,
		diagnostics = [],
		featureProbes = [],
	} = inputs;
	const labeled = labeledSnapshots(snapshots);
	// A tombstoned group is out of the join: the provider serves nothing from it, so no declared entry may claim it
	// by label and URL; a declared entry whose own client or connection ID it carries clears the tombstone
	// engine-side (GroupRemovalStore.clearTombstonesFor) and claims it on the next push.
	const tombstoned = new Set(
		labeled.filter(({ snapshot }) =>
			removedGroups.tombstones.some((record) =>
				tombstoneHides(record, {
					groupId: snapshot.status.serverId,
					label: snapshot.status.label,
					entryLabel: snapshot.entryLabel,
					baseUrl: snapshot.status.baseUrl,
				})
			)
		)
	);
	const ownership = resolveGroupOwnership({
		labeled: labeled.filter((entry) => !tombstoned.has(entry)),
		declared: declared.views,
		carriers: rejectedCarrierLabels(entryReports),
		...(secretHolders !== undefined ? { secretHolders } : {}),
	});
	const { servers, snapshotLabels } = buildServers(
		labeled,
		declared,
		entryReports,
		removedGroups,
		ownership,
		tombstoned
	);
	const hiddenGroups = visibleHiddenGroups({
		removedGroups,
		declared: declared.views,
		superseded: supersededLeftovers(ownership, declared.views),
		wasGroupObserved,
		wasLabeledGroupObserved,
	});
	const observedUnion = observedModelInfoKeysUnion(snapshots);
	return {
		servers,
		hiddenGroups,
		// The served-count truth for the hero and the paste line, reduced like reportMerged's totalModels but over the
		// VISIBLE snapshots only: a tombstoned snapshot's models leave the tables (snapshotLabels drops them), so its
		// count must leave the headline too. Immune to the models array's per-claimant copies either way.
		servedModelCount: labeled.reduce(
			(sum, entry, index) =>
				(snapshotLabels[index] ?? []).length > 0 ? sum + entry.snapshot.status.servedModelCount : sum,
			0
		),
		models: labeled
			.flatMap(({ snapshot, label }, index) =>
				(snapshotLabels[index] ?? [label]).flatMap((serverLabel) =>
					snapshot.models.map((info) => buildModel(info, serverLabel, modelScopeKey(snapshot.status.serverId)))
				)
			)
			.sort((a, b) => a.serverLabel.localeCompare(b.serverLabel) || a.name.localeCompare(b.name)),
		...(observedUnion !== undefined ? { observedModelInfoKeys: observedUnion } : {}),
		settings: readDashboardSettings(reader, catalog),
		featureProbes,
		usage,
		diagnostics,
	};
}

export type EntryCapabilitiesRecord = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface ModelCapabilitiesQuery {
	readonly snapshots: readonly ServerModelsSnapshot[];
	readonly reader: SettingsReader;
	readonly resolveEntryCapabilities: (serverId: string) => EntryCapabilitiesRecord | undefined;
	/** The OpenRouter catalog as in-memory lookup; EMPTY_CATALOG_LOOKUP when no snapshot exists. */
	readonly catalog: CapabilityCatalogLookup;
	/**
	 * The provider's shared flat resolution table, so the inspector reads the SAME cache requests and registration use.
	 * Absent, the responder runs the same pure walk uncached (tests, headless callers).
	 */
	readonly resolution?: ModelResolutionTable | undefined;
}

/**
 * Answer one readModelCapabilities request: locate the model behind the scope key and raw ID, then run the SAME
 * resolveModelCapabilities walk registration runs, through the provider's shared resolution table when the query
 * carries one. A store change between the push and the request can de-resolve the key; undefined tells the inspector
 * the state moved on instead of inventing values.
 */
export function resolveDashboardModelCapabilities(
	query: ModelCapabilitiesQuery,
	scopeKey: string,
	rawId: string
): EffectiveCapabilities | undefined {
	// locateModel owns the de-resolution: scope keys hash the server ID, so a stale key resolves to nothing rather than
	// to another server.
	const located = locateModel(query.snapshots, scopeKey, rawId);
	if (located === undefined) {
		return undefined;
	}
	const { snapshot } = located.labeled;
	const serverId = snapshot.status.serverId;
	const info = located.info;
	const inputs = {
		globalCapabilities: normalizeModelCapabilities(query.reader.get(MODEL_CAPABILITIES_SETTING_KEY)),
		entryCapabilities: query.resolveEntryCapabilities(serverId),
		catalog: query.catalog,
		// Registration's post-aggregation baseline, riding every pre-attach model: the inspector resolves over the same
		// walk registration serves.
		serverDeclared: info.litellm.serverDeclared,
	};
	const resolved =
		query.resolution !== undefined
			? query.resolution.resolveCapabilities(serverId, rawId, inputs)
			: resolveModelCapabilities({ rawModelId: rawId, ...inputs });
	// The advisory filter judges each hint by its layer's own evidence, the SAME evidence Configuration diagnostics and
	// the settings editor use: entry records apply to this server only, so its own listing judges them; a global record
	// applies to every server, so a key ANY server observed is real (the cross-server union). The non-global branch
	// falls back to the stricter per-server evidence deliberately, so a future RecordLayer member fails safe (fewer
	// hints) instead of borrowing the union's broader proof.
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

export interface ModelParametersQuery {
	readonly snapshots: readonly ServerModelsSnapshot[];
	readonly reader: SettingsReader;
	readonly resolveEntryParameters: (serverId: string) => EntryParametersResolution | undefined;
	/** The provider's shared flat resolution table; absent, the responder runs the same pure walk uncached. */
	readonly resolution?: ModelResolutionTable | undefined;
}

/** Undefined when the key or model no longer resolves, like resolveDashboardModelCapabilities. */
export function resolveDashboardModelParameters(
	query: ModelParametersQuery,
	scopeKey: string,
	rawId: string
): EffectiveParametersProjection | undefined {
	const located = locateModel(query.snapshots, scopeKey, rawId);
	if (located === undefined) {
		return undefined;
	}
	const serverId = located.labeled.snapshot.status.serverId;
	const info = located.info;
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
 * The most specific GLOBAL record key matching a model, for the inspectors' configure-jump: the webview holds no
 * resolver logic, so the extension names the record to focus - or none, and the editor creates a fresh exact-ID draft.
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
