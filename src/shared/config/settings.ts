import * as vscode from "vscode";
import { z } from "zod";
import type { HeaderScalar } from "../util/headers";
import { HEADER_NAME_PATTERN, isHeaderScalar, isValidHeaderValue, trimHttpWhitespace } from "../util/headers";
import { cloneJson, isUnsafeRecordKey, objectSlot } from "../util/json";
import type {
	AgentWriteToolId,
	BooleanSettingId,
	FeatureId,
	FeatureModelId,
	FeatureModelRef,
	InlineLanguageFilter,
	LanguageFilterMode,
	NumberSettingId,
	TokenEstimationMode,
} from "./settingSpec";
import {
	ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY,
	AGENT_TOOL_TOGGLE_KEYS,
	AGENT_TOOLS_SECRET_VALUES_KEY,
	acceptsNumberSetting,
	BOOLEAN_SETTING_SPECS,
	COMMIT_GENERATION_PROMPT_SETTING_KEY,
	CONFIG_SECTION,
	CURRENCY_SYMBOL_SETTING_KEY,
	DEFAULT_CURRENCY_SYMBOL,
	DEFAULT_INLINE_LANGUAGE_FILTER,
	DEFAULT_TOKEN_ESTIMATION_MODE,
	DEFAULT_UI_ACCENT,
	DEFAULT_UI_THEME,
	DEFAULT_USAGE_ALERT_THRESHOLDS,
	DEFAULT_USAGE_STATUS_BAR_MODE,
	FEATURE_ENABLE_SETTING_KEYS,
	FEATURE_MODEL_SETTING_KEYS,
	INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY,
	isUsableThreshold,
	LANGUAGE_FILTER_MODES,
	MIN_TIMEOUT_MS,
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	NUMBER_SETTING_SPECS,
	numberSettingBoundText,
	SERVERS_SETTING_KEY,
	TOKEN_ESTIMATION_MODES,
	TOKEN_ESTIMATION_SETTING_KEY,
	UI_ACCENT_SETTING_KEY,
	UI_ACCENTS,
	UI_THEME_SETTING_KEY,
	UI_THEMES,
	type UiAccent,
	type UiTheme,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
	USAGE_STATUS_BAR_MODES,
	USAGE_STATUS_BAR_SETTING_KEY,
	type UsageStatusBarMode,
	usableThresholds,
} from "./settingSpec";

type LogFn = (message: string, data?: unknown) => void;

// The object settings' keys live in settingSpec.ts beside the scalar specs (vscode-free, so non-host consumers can
// load them).
export {
	CURRENCY_SYMBOL_SETTING_KEY,
	MIN_TIMEOUT_MS,
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	SERVERS_SETTING_KEY,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
	USAGE_STATUS_BAR_SETTING_KEY,
};

export const DEFAULT_DISCOVERY_TIMEOUT_MS = NUMBER_SETTING_SPECS["discovery.timeout"].default;
export const DEFAULT_REQUEST_TIMEOUT_MS = NUMBER_SETTING_SPECS["chat.timeout"].default;
export const DEFAULT_DISCOVERY_CACHE_TTL_MS = NUMBER_SETTING_SPECS["discovery.cacheTtl"].default;

function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function getBooleanSetting(id: BooleanSettingId): boolean {
	return getConfig().get<boolean>(id, BOOLEAN_SETTING_SPECS[id].default);
}

/**
 * settings.json is free text, so the spec's contract (acceptsNumberSetting; the manifest states a looser schema where
 * an off switch exists) is applied here rather than trusted. A value outside it is never guessed at (no clamp, no rounding): the default applies, and the log names
 * the key and the bound, the same judgment the dashboard's Diagnostics tab renders.
 */
function readNumberSetting(id: NumberSettingId, log?: LogFn): number {
	const spec = NUMBER_SETTING_SPECS[id];
	const raw = getConfig().get<unknown>(id, spec.default);
	if (acceptsNumberSetting(id, raw)) {
		return raw as number;
	}
	log?.(`${id} must be a whole number ${numberSettingBoundText(id)}; using the default`, {
		configured: typeof raw === "number" ? raw : typeof raw,
	});
	return spec.default;
}

export function getDiscoveryTimeout(log?: LogFn): number {
	return readNumberSetting("discovery.timeout", log);
}

export function getRequestTimeout(log?: LogFn): number {
	return readNumberSetting("chat.timeout", log);
}

export function normalizeTokenEstimationMode(raw: unknown): TokenEstimationMode {
	return typeof raw === "string" && (TOKEN_ESTIMATION_MODES as readonly string[]).includes(raw)
		? (raw as TokenEstimationMode)
		: DEFAULT_TOKEN_ESTIMATION_MODE;
}

/** Read once at activation and on configuration change by the tokenizer wiring, never per count. */
export function getTokenEstimationMode(): TokenEstimationMode {
	return normalizeTokenEstimationMode(getConfig().get<unknown>(TOKEN_ESTIMATION_SETTING_KEY));
}

/** 0 is a valid configuration. */
export function getDiscoveryCacheTtl(log?: LogFn): number {
	return readNumberSetting("discovery.cacheTtl", log);
}

/**
 * How long a failing group refresh may keep serving the group's last known models flagged stale, anchored to the last
 * successful discovery, in milliseconds.
 */
export function getDiscoveryStaleServeWindow(log?: LogFn): number {
	return readNumberSetting("discovery.staleServeWindow", log);
}

export function isPromptCachingEnabled(): boolean {
	return getBooleanSetting("chat.promptCaching");
}

/** How many tools one chat request may carry before it is refused locally instead of sent. */
export function getMaxToolsPerRequest(log?: LogFn): number {
	return readNumberSetting("chat.maxToolsPerRequest", log);
}

export function normalizeAdditionalToolSchemaKeywords(raw: unknown, log?: LogFn): readonly string[] {
	if (!Array.isArray(raw)) {
		if (raw !== undefined) {
			log?.("Invalid chat.additionalToolSchemaKeywords configuration, using no additional keywords", {
				configured: typeof raw,
			});
		}
		return [];
	}
	const valid = raw.filter(
		(value): value is string => typeof value === "string" && value.length > 0 && !isUnsafeRecordKey(value)
	);
	if (valid.length < raw.length) {
		log?.("Ignoring chat.additionalToolSchemaKeywords entries that are not plain non-empty keyword names", {
			ignored: raw.length - valid.length,
		});
	}
	return [...new Set(valid)];
}

/**
 * The extra JSON-Schema keywords tool conversion keeps in tool input schemas, on top of the built-in allowlist.
 * Extension only: the built-ins always apply, so this can never strip a keyword the conversion relies on.
 */
export function getAdditionalToolSchemaKeywords(log?: LogFn): readonly string[] {
	return normalizeAdditionalToolSchemaKeywords(
		getConfig().get<unknown>(ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY),
		log
	);
}

/** Zero is the documented off switch (explicit refresh still works); see the spec's offValue. */
export function getUsagePollIntervalMs(log?: LogFn): number {
	return readNumberSetting("usage.pollInterval", log);
}

export function getUsageInitialRefreshDelayMs(log?: LogFn): number {
	return readNumberSetting("usage.initialRefreshDelay", log);
}

export function getUsageServersChangeRefreshDelayMs(log?: LogFn): number {
	return readNumberSetting("usage.serversChangeRefreshDelay", log);
}

/** 0 is valid: on-demand data then never counts as fresh, so the status bar aggregates nothing while polling is off. */
export function getUsagePollingOffFreshnessWindowMs(log?: LogFn): number {
	return readNumberSetting("usage.pollingOffFreshnessWindow", log);
}

/**
 * A non-array falls back to the default; an array keeps only its valid entries (an empty result is a legitimate "no
 * alerts" configuration).
 */
export function normalizeUsageAlertThresholds(raw: unknown, log?: LogFn): readonly number[] {
	if (!Array.isArray(raw)) {
		log?.("Invalid usage.alertThresholds configuration, using the default", { configured: typeof raw });
		return DEFAULT_USAGE_ALERT_THRESHOLDS;
	}
	const valid = raw.filter((value): value is number => typeof value === "number" && isUsableThreshold(value));
	if (valid.length < raw.length) {
		log?.("Ignoring usage.alertThresholds entries outside (0, 1]", { ignored: raw.length - valid.length });
	}
	return usableThresholds(valid);
}

export function getUsageAlertThresholds(log?: LogFn): readonly number[] {
	return normalizeUsageAlertThresholds(
		getConfig().get<unknown>(USAGE_ALERT_THRESHOLDS_SETTING_KEY, [...DEFAULT_USAGE_ALERT_THRESHOLDS]),
		log
	);
}

export function normalizeUsageStatusBarMode(raw: unknown): UsageStatusBarMode {
	return typeof raw === "string" && (USAGE_STATUS_BAR_MODES as readonly string[]).includes(raw)
		? (raw as UsageStatusBarMode)
		: DEFAULT_USAGE_STATUS_BAR_MODE;
}

export function getUsageStatusBarMode(): UsageStatusBarMode {
	return normalizeUsageStatusBarMode(getConfig().get<unknown>(USAGE_STATUS_BAR_SETTING_KEY));
}

/**
 * Any string is a legal currency symbol, the empty string included (it renders the bare number). No trimming: a
 * trailing space is how "EUR " keeps the amount readable.
 */
export function normalizeCurrencySymbol(raw: unknown): string {
	return typeof raw === "string" ? raw : DEFAULT_CURRENCY_SYMBOL;
}

/** Display only, never a conversion: amounts render exactly as reported. */
export function getCurrencySymbol(): string {
	return normalizeCurrencySymbol(getConfig().get<unknown>(CURRENCY_SYMBOL_SETTING_KEY));
}

export function normalizeUiTheme(raw: unknown): UiTheme {
	return typeof raw === "string" && (UI_THEMES as readonly string[]).includes(raw)
		? (raw as UiTheme)
		: DEFAULT_UI_THEME;
}

export function getUiTheme(): UiTheme {
	return normalizeUiTheme(getConfig().get<unknown>(UI_THEME_SETTING_KEY));
}

export function normalizeUiAccent(raw: unknown): UiAccent {
	return typeof raw === "string" && (UI_ACCENTS as readonly string[]).includes(raw)
		? (raw as UiAccent)
		: DEFAULT_UI_ACCENT;
}

export function getUiAccent(): UiAccent {
	return normalizeUiAccent(getConfig().get<unknown>(UI_ACCENT_SETTING_KEY));
}

const headerNameSchema = z.string().regex(HEADER_NAME_PATTERN);

const headerValueSchema = z.custom<HeaderScalar>(isHeaderScalar).transform((value) => String(value));

/**
 * Values must pass isValidHeaderValue: a value that reached the platform's Headers instead would throw a TypeError
 * embedding the full plaintext value, and these values can be secrets.
 */
export function normalizeCustomHeaders(raw: unknown, log?: LogFn): Record<string, string> {
	if (raw === undefined) {
		return {};
	}
	const record = objectSlot(raw, "Ignoring custom headers that are not an object", (message) =>
		log?.(message, { configured: typeof raw })
	);
	if (record === undefined) {
		return {};
	}

	const headers: Record<string, string> = {};
	const seenLower = new Set<string>();
	for (const [name, value] of Object.entries(record)) {
		const parsedName = headerNameSchema.safeParse(trimHttpWhitespace(name));
		if (!parsedName.success || isUnsafeRecordKey(parsedName.data)) {
			log?.("Ignoring invalid custom header name", { name });
			continue;
		}
		const lower = parsedName.data.toLowerCase();
		if (seenLower.has(lower)) {
			// Header names are case-insensitive on the wire. Names are user configuration, never response text, so the
			// collision may be named.
			log?.("Ignoring a custom header that repeats an earlier name with different casing; the first wins", {
				name: parsedName.data,
			});
			continue;
		}
		const parsedValue = headerValueSchema.safeParse(value);
		if (!parsedValue.success) {
			log?.("Ignoring custom header with non-primitive value", { name: parsedName.data });
			continue;
		}
		if (!isValidHeaderValue(parsedValue.data)) {
			log?.("Ignoring custom header whose value cannot be sent as an HTTP header", { name: parsedName.data });
			continue;
		}
		seenLower.add(lower);
		headers[parsedName.data] = parsedValue.data;
	}

	return headers;
}

type RecordSettingKey = typeof MODEL_PARAMETERS_SETTING_KEY | typeof MODEL_CAPABILITIES_SETTING_KEY;

/**
 * What the records normalizer refused: the whole map, one model's entry whose value is not an object, or an entry
 * under a reserved name (named; model IDs are user configuration).
 */
type RecordShapeProblem =
	| { readonly kind: "map" }
	| { readonly kind: "entry"; readonly key: string }
	| { readonly kind: "reserved-key"; readonly key: string };

export type RecordShapeReport = (problem: RecordShapeProblem) => void;

/** The log-side reporter: one classification line per refusal, the model ID but never a value. */
export function logRecordShapeProblems(setting: RecordSettingKey, log: LogFn): RecordShapeReport {
	return (problem) => {
		switch (problem.kind) {
			case "map":
				log(`Invalid ${setting} configuration, reading it as empty`);
				break;
			case "entry":
				log(`Ignoring ${setting} entry whose value is not an object`, { model: problem.key });
				break;
			case "reserved-key":
				log(`Ignoring ${setting} entry under a reserved name`, { model: problem.key });
				break;
		}
	};
}

/**
 * The one classifier of a records map's shape: a wrong-shaped map reads as empty, a wrong-shaped entry or one under a
 * reserved name as absent, each reported through the caller's channel (the log, or the dashboard's Diagnostics tab).
 */
function normalizePrefixKeyedRecords(
	raw: unknown,
	report?: RecordShapeReport
): Record<string, Record<string, unknown>> {
	if (raw === undefined) {
		return {};
	}
	const tell: RecordShapeReport = (problem) => report?.(problem);
	// Own keys, not a zod record parse: zod drops "__proto__" before anything could name it, and a reserved name is
	// exactly what the user must be told about.
	const map = objectSlot(raw, { kind: "map" } as const, tell);
	if (map === undefined) {
		return {};
	}

	const records: Record<string, Record<string, unknown>> = {};
	for (const modelId of Object.keys(map)) {
		if (isUnsafeRecordKey(modelId)) {
			tell({ kind: "reserved-key", key: modelId });
			continue;
		}
		const entry = objectSlot(map[modelId], { kind: "entry", key: modelId } as const, tell);
		if (entry !== undefined) {
			records[modelId] = cloneJson(entry);
		}
	}
	return records;
}

export function normalizeModelParameters(
	raw: unknown,
	report?: RecordShapeReport
): Record<string, Record<string, unknown>> {
	return normalizePrefixKeyedRecords(raw, report);
}

/**
 * The value each records setting was last reported under. The getters below run per chat request, per inline
 * completion, and per serve, so a wrong-shaped slot would otherwise put the same line in the channel on every one of
 * them; a value already reported reads silently until the user changes the setting. Problems are a function of the
 * value, so the value is the whole identity. A read with no sink never claims a value.
 */
const reportedRecordValues = new Map<RecordSettingKey, string>();

/** Test hook: lets a value the session already reported report again. */
export function resetRecordShapeReports(): void {
	reportedRecordValues.clear();
}

function readRecordsSetting(
	setting: RecordSettingKey,
	log: LogFn | undefined
): Record<string, Record<string, unknown>> {
	const raw = getConfig().get<unknown>(setting, {});
	if (log === undefined) {
		return normalizePrefixKeyedRecords(raw);
	}
	const value = JSON.stringify(cloneJson(raw)) ?? "";
	if (reportedRecordValues.get(setting) === value) {
		return normalizePrefixKeyedRecords(raw);
	}
	reportedRecordValues.set(setting, value);
	return normalizePrefixKeyedRecords(raw, logRecordShapeProblems(setting, log));
}

export function getModelParametersConfig(log?: LogFn): Record<string, Record<string, unknown>> {
	return readRecordsSetting(MODEL_PARAMETERS_SETTING_KEY, log);
}

/**
 * Shape only, deliberately as lenient as normalizeModelParameters: the capability vocabulary and value typing are
 * enforced in one place, capabilityResolution's parseCapabilityRecord.
 */
export function normalizeModelCapabilities(
	raw: unknown,
	report?: RecordShapeReport
): Record<string, Record<string, unknown>> {
	return normalizePrefixKeyedRecords(raw, report);
}

export function getModelCapabilitiesConfig(log?: LogFn): Record<string, Record<string, unknown>> {
	return readRecordsSetting(MODEL_CAPABILITIES_SETTING_KEY, log);
}

export function getMaskSecretInputs(): boolean {
	return getBooleanSetting("ui.maskSecretInputs");
}

/** The OpenRouter catalog opt-out. Explicit `_openrouter_model` directives keep answering from the snapshot. */
export function isOpenRouterCatalogEnabled(): boolean {
	return getBooleanSetting("models.openRouterCatalog");
}

/**
 * One feature's enable flag, through the FEATURE_ENABLE_SETTING_KEYS map: the one pipeline for every feature opt-in.
 */
export function isFeatureEnabled(feature: FeatureId): boolean {
	return getBooleanSetting(FEATURE_ENABLE_SETTING_KEYS[feature]);
}

/** One agent write tool's own toggle; the feature switch (isFeatureEnabled("agentTools")) gates it too. */
export function isAgentWriteToolEnabled(tool: AgentWriteToolId): boolean {
	return getBooleanSetting(AGENT_TOOL_TOGGLE_KEYS[tool]);
}

export function agentToolsAcceptSecretValues(): boolean {
	return getBooleanSetting(AGENT_TOOLS_SECRET_VALUES_KEY);
}

/**
 * Narrow a raw `<feature>.model` value to the explicit model choice: an object whose `server` and `model` are
 * non-empty strings, edge-trimmed like the entry labels they address. null is the manifest's declared "unset".
 */
export function normalizeFeatureModelRef(
	raw: unknown,
	feature: FeatureModelId,
	log?: LogFn
): FeatureModelRef | undefined {
	if (raw === undefined || raw === null) {
		return undefined;
	}
	const unset = `Invalid ${FEATURE_MODEL_SETTING_KEYS[feature]} configuration, reading the model as unset`;
	const tell = (message: string) => log?.(message, { configured: typeof raw });
	const ref = objectSlot(raw, unset, tell);
	if (ref === undefined) {
		return undefined;
	}
	const server = typeof ref.server === "string" ? trimHttpWhitespace(ref.server) : "";
	const model = typeof ref.model === "string" ? trimHttpWhitespace(ref.model) : "";
	if (server.length === 0 || model.length === 0) {
		tell(unset);
		return undefined;
	}
	return { server, model };
}

export function getFeatureModelRef(feature: FeatureModelId, log?: LogFn): FeatureModelRef | undefined {
	return normalizeFeatureModelRef(getConfig().get<unknown>(FEATURE_MODEL_SETTING_KEYS[feature]), feature, log);
}

/**
 * Narrow a raw commitGeneration.prompt value: any string passes verbatim (model-facing text, so no trimming), anything
 * else reads as "" - the empty string that means "use the built-in instruction".
 */
export function normalizeCommitGenerationPrompt(raw: unknown): string {
	return typeof raw === "string" ? raw : "";
}

export function getCommitGenerationPrompt(): string {
	return normalizeCommitGenerationPrompt(getConfig().get<unknown>(COMMIT_GENERATION_PROMPT_SETTING_KEY));
}

export function normalizeInlineLanguageFilter(raw: unknown, log?: LogFn): InlineLanguageFilter {
	if (raw === undefined) {
		return DEFAULT_INLINE_LANGUAGE_FILTER;
	}
	const invalid = "Invalid inlineCompletions.languageFilter configuration, using the default (block nothing)";
	const tell = (message: string) => log?.(message, { configured: typeof raw });
	const filter = objectSlot(raw, invalid, tell);
	if (filter === undefined) {
		return DEFAULT_INLINE_LANGUAGE_FILTER;
	}
	if (typeof filter.mode !== "string" || !(LANGUAGE_FILTER_MODES as readonly string[]).includes(filter.mode)) {
		tell(invalid);
		return DEFAULT_INLINE_LANGUAGE_FILTER;
	}
	const mode = filter.mode as LanguageFilterMode;
	if (!Array.isArray(filter.languages)) {
		if (filter.languages !== undefined) {
			log?.("Invalid inlineCompletions.languageFilter languages configuration, using the empty list", {
				configured: typeof filter.languages,
			});
		}
		return { mode, languages: [] };
	}
	const valid = filter.languages
		.filter((value): value is string => typeof value === "string")
		.map((value) => trimHttpWhitespace(value))
		.filter((value) => value.length > 0);
	if (valid.length < filter.languages.length) {
		log?.("Ignoring language filter entries that are not non-empty language IDs", {
			ignored: filter.languages.length - valid.length,
		});
	}
	return { mode, languages: [...new Set(valid)] };
}

export function getInlineLanguageFilter(log?: LogFn): InlineLanguageFilter {
	return normalizeInlineLanguageFilter(getConfig().get<unknown>(INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY), log);
}
