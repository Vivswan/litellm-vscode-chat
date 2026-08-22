import * as vscode from "vscode";
import { z } from "zod";
import type { HeaderScalar } from "../util/headers";
import { HEADER_NAME_PATTERN, isHeaderScalar, isValidHeaderValue } from "../util/headers";
import { isRecord, isUnsafeRecordKey } from "../util/json";
import type {
	BooleanSettingId,
	FeatureModelId,
	FeatureModelRef,
	InlineLanguageFilter,
	LanguageFilterMode,
	NumberSettingId,
	TokenEstimationMode,
} from "./settingSpec";
import {
	ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY,
	BOOLEAN_SETTING_SPECS,
	COMMIT_GENERATION_PROMPT_SETTING_KEY,
	CONFIG_SECTION,
	CURRENCY_SYMBOL_SETTING_KEY,
	DEFAULT_CURRENCY_SYMBOL,
	DEFAULT_INLINE_LANGUAGE_FILTER,
	DEFAULT_TOKEN_ESTIMATION_MODE,
	DEFAULT_UI_ACCENT,
	DEFAULT_UI_THEME,
	FEATURE_MODEL_SETTING_KEYS,
	INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY,
	isIntegerSetting,
	isUsableThreshold,
	LANGUAGE_FILTER_MODES,
	MIN_TIMEOUT_MS,
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	NUMBER_SETTING_SPECS,
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
	USAGE_STATUS_BAR_SETTING_KEY,
} from "./settingSpec";

type LogFn = (message: string, data?: unknown) => void;

// The object settings' keys live in settingSpec.ts beside the scalar specs
// (vscode-free, so non-host consumers can load them).
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

/** The raw configured value of one number setting, defaulted from its spec. */
function getNumberSetting(id: NumberSettingId): number | null {
	return getConfig().get<number | null>(id, NUMBER_SETTING_SPECS[id].default);
}

function getBooleanSetting(id: BooleanSettingId): boolean {
	return getConfig().get<boolean>(id, BOOLEAN_SETTING_SPECS[id].default);
}

/**
 * Validate a configured number setting: non-finite values fall back to the
 * default, integer-only settings floor fractions (the contribution says
 * integer, but settings.json is free text), and finite values are clamped to
 * the minimum.
 */
function clampNumber(
	raw: unknown,
	fallback: number,
	minimum: number,
	integer: boolean,
	name: string,
	log?: LogFn
): number {
	const candidate = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
	const clamped = Math.max(minimum, integer ? Math.floor(candidate) : candidate);
	if (clamped !== raw) {
		log?.(`Invalid ${name} configuration, using clamped value`, { configured: raw, clamped });
	}
	return clamped;
}

/** The number settings share the clamping read; each one's default, floor, and integer rule come from its spec. */
function getClampedNumberSetting(id: NumberSettingId, log?: LogFn): number {
	const spec = NUMBER_SETTING_SPECS[id];
	return clampNumber(getNumberSetting(id), spec.default, spec.minimum, isIntegerSetting(id), id, log);
}

export function getDiscoveryTimeout(log?: LogFn): number {
	return getClampedNumberSetting("discovery.timeout", log);
}

export function getRequestTimeout(log?: LogFn): number {
	return getClampedNumberSetting("chat.timeout", log);
}

/** Anything outside the token-estimation vocabulary reads as the default ("auto"). */
export function normalizeTokenEstimationMode(raw: unknown): TokenEstimationMode {
	return typeof raw === "string" && (TOKEN_ESTIMATION_MODES as readonly string[]).includes(raw)
		? (raw as TokenEstimationMode)
		: DEFAULT_TOKEN_ESTIMATION_MODE;
}

/**
 * How the local token budget prices text. Read once at activation and on
 * configuration change by the tokenizer wiring, never per count.
 */
export function getTokenEstimationMode(): TokenEstimationMode {
	return normalizeTokenEstimationMode(getConfig().get<unknown>(TOKEN_ESTIMATION_SETTING_KEY));
}

/**
 * How long cached model-discovery results are served, in milliseconds. 0 is a
 * valid configuration: it disables serving from the cache (concurrent
 * refreshes still coalesce into one request).
 */
export function getDiscoveryCacheTtl(log?: LogFn): number {
	return getClampedNumberSetting("discovery.cacheTtl", log);
}

/**
 * How long a failing group refresh may keep serving the group's last known
 * models flagged stale, anchored to the last successful discovery, in
 * milliseconds. 0 disables stale serving entirely, so a failed silent refresh
 * serves the empty list.
 */
export function getDiscoveryStaleServeWindow(log?: LogFn): number {
	return getClampedNumberSetting("discovery.staleServeWindow", log);
}

export function isPromptCachingEnabled(): boolean {
	return getBooleanSetting("chat.promptCaching");
}

/**
 * How many tools one chat request may carry before it is refused locally
 * instead of sent.
 */
export function getMaxToolsPerRequest(log?: LogFn): number {
	return getClampedNumberSetting("chat.maxToolsPerRequest", log);
}

/**
 * Narrow a raw chat.additionalToolSchemaKeywords value to the keyword names
 * the tool-schema sanitizer keeps beyond its built-in allowlist: non-empty
 * strings, deduplicated, in configuration order. A non-array reads as no
 * additions; non-string, empty, and prototype-polluting entries drop.
 */
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
 * The extra JSON-Schema keywords tool conversion keeps in tool input schemas,
 * on top of the built-in allowlist. Extension only: the built-ins always
 * apply, so this can never strip a keyword the conversion relies on.
 */
export function getAdditionalToolSchemaKeywords(log?: LogFn): readonly string[] {
	return normalizeAdditionalToolSchemaKeywords(
		getConfig().get<unknown>(ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY),
		log
	);
}

/**
 * The floor a NONZERO usage poll interval clamps to: zero stays the
 * documented off switch, but a tiny positive value ("1") would otherwise be
 * a permanent as-fast-as-the-network-allows loop of several GETs per server.
 */
export const MIN_USAGE_POLL_INTERVAL_MS = 30000;

/**
 * How often the usage poller refreshes per-server spend and budget data, in
 * milliseconds. Zero disables polling entirely (the documented off switch;
 * explicit refresh still works), negatives clamp to zero, and nonzero values
 * clamp up to MIN_USAGE_POLL_INTERVAL_MS.
 */
export function getUsagePollIntervalMs(log?: LogFn): number {
	const clamped = getClampedNumberSetting("usage.pollInterval", log);
	if (clamped > 0 && clamped < MIN_USAGE_POLL_INTERVAL_MS) {
		log?.("Invalid usage.pollInterval configuration, using clamped value", {
			configured: clamped,
			clamped: MIN_USAGE_POLL_INTERVAL_MS,
		});
		return MIN_USAGE_POLL_INTERVAL_MS;
	}
	return clamped;
}

/** The delay from the usage poller's start to its first poll, in milliseconds (usage.initialRefreshDelay). */
export function getUsageInitialRefreshDelayMs(log?: LogFn): number {
	return getClampedNumberSetting("usage.initialRefreshDelay", log);
}

/** The refresh delay after a servers-setting change, in milliseconds (usage.serversChangeRefreshDelay). */
export function getUsageServersChangeRefreshDelayMs(log?: LogFn): number {
	return getClampedNumberSetting("usage.serversChangeRefreshDelay", log);
}

/**
 * How long on-demand usage data counts as fresh while polling is off, in
 * milliseconds. 0 is valid: on-demand data then never counts as fresh, so the
 * status bar aggregates nothing while polling is off.
 */
export function getUsagePollingOffFreshnessWindowMs(log?: LogFn): number {
	return getClampedNumberSetting("usage.pollingOffFreshnessWindow", log);
}

/** The budget fractions the usage poller alerts at when nothing valid is configured. */
export const DEFAULT_USAGE_ALERT_THRESHOLDS: readonly number[] = [0.8, 0.95];

/**
 * Narrow a raw usage.alertThresholds value to usable alert fractions: finite
 * numbers in (0, 1], deduplicated and sorted ascending. A non-array falls back
 * to the default; an array keeps only its valid entries (an empty result is a
 * legitimate "no alerts" configuration).
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
	return [...new Set(valid)].sort((a, b) => a - b);
}

export function getUsageAlertThresholds(log?: LogFn): readonly number[] {
	return normalizeUsageAlertThresholds(
		getConfig().get<unknown>(USAGE_ALERT_THRESHOLDS_SETTING_KEY, [...DEFAULT_USAGE_ALERT_THRESHOLDS]),
		log
	);
}

/** When the usage status-bar item shows: always, only while an alert threshold is crossed, or never. */
export const USAGE_STATUS_BAR_MODES = ["always", "alerts-only", "off"] as const;

export type UsageStatusBarMode = (typeof USAGE_STATUS_BAR_MODES)[number];

const DEFAULT_USAGE_STATUS_BAR_MODE: UsageStatusBarMode = "always";

/** Narrow a raw usage.statusBar value to the closed mode vocabulary; anything else reads as the default. */
export function normalizeUsageStatusBarMode(raw: unknown): UsageStatusBarMode {
	return typeof raw === "string" && (USAGE_STATUS_BAR_MODES as readonly string[]).includes(raw)
		? (raw as UsageStatusBarMode)
		: DEFAULT_USAGE_STATUS_BAR_MODE;
}

export function getUsageStatusBarMode(): UsageStatusBarMode {
	return normalizeUsageStatusBarMode(getConfig().get<unknown>(USAGE_STATUS_BAR_SETTING_KEY));
}

/**
 * Any string is a legal currency symbol, the empty string included (it renders
 * the bare number). No trimming: a trailing space is how "EUR " keeps the
 * amount readable.
 */
export function normalizeCurrencySymbol(raw: unknown): string {
	return typeof raw === "string" ? raw : DEFAULT_CURRENCY_SYMBOL;
}

/** Display only, never a conversion: amounts render exactly as reported. */
export function getCurrencySymbol(): string {
	return normalizeCurrencySymbol(getConfig().get<unknown>(CURRENCY_SYMBOL_SETTING_KEY));
}

/** Anything outside the theme vocabulary reads as the default. */
export function normalizeUiTheme(raw: unknown): UiTheme {
	return typeof raw === "string" && (UI_THEMES as readonly string[]).includes(raw)
		? (raw as UiTheme)
		: DEFAULT_UI_THEME;
}

export function getUiTheme(): UiTheme {
	return normalizeUiTheme(getConfig().get<unknown>(UI_THEME_SETTING_KEY));
}

/** Anything outside the accent vocabulary reads as the default. */
export function normalizeUiAccent(raw: unknown): UiAccent {
	return typeof raw === "string" && (UI_ACCENTS as readonly string[]).includes(raw)
		? (raw as UiAccent)
		: DEFAULT_UI_ACCENT;
}

export function getUiAccent(): UiAccent {
	return normalizeUiAccent(getConfig().get<unknown>(UI_ACCENT_SETTING_KEY));
}

/** Top-level shape shared by the record settings (headers, models.parameters): a plain object, keyed by string. */
const settingsRecordSchema = z.record(z.string(), z.unknown());

const headerNameSchema = z.string().trim().regex(HEADER_NAME_PATTERN);

const headerValueSchema = z.custom<HeaderScalar>(isHeaderScalar).transform((value) => String(value));

/**
 * Narrow a raw custom-headers record (a server entry's `headers` field) to
 * the record the wire carries. Values must pass isValidHeaderValue: a value
 * that reached the platform's Headers instead would throw a TypeError
 * embedding the full plaintext value, and these values can be secrets. Two
 * names differing only by case are one HTTP header: the first one in the
 * object wins and the collision is reported.
 */
export function normalizeCustomHeaders(raw: unknown, log?: LogFn): Record<string, string> {
	const parsed = settingsRecordSchema.safeParse(raw);
	if (!parsed.success) {
		return {};
	}

	const headers: Record<string, string> = {};
	const seenLower = new Set<string>();
	for (const [name, value] of Object.entries(parsed.data)) {
		const parsedName = headerNameSchema.safeParse(name);
		if (!parsedName.success || isUnsafeRecordKey(parsedName.data)) {
			log?.("Ignoring invalid custom header name", { name });
			continue;
		}
		const lower = parsedName.data.toLowerCase();
		if (seenLower.has(lower)) {
			// Header names are case-insensitive on the wire; sending both spellings
			// would concatenate them unpredictably. Names are user configuration,
			// never response text, so the collision may be named.
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

const prefixKeyedEntrySchema = z.record(z.string(), z.unknown());

/**
 * Narrow a raw matcher-keyed setting (models.parameters, models.capabilities)
 * to the record-of-records shape. Validated entry-by-entry so one malformed
 * entry drops only itself; prototype-polluting keys are dropped outright.
 */
function normalizePrefixKeyedRecords(raw: unknown): Record<string, Record<string, unknown>> {
	const parsed = settingsRecordSchema.safeParse(raw);
	if (!parsed.success) {
		return {};
	}

	const records: Record<string, Record<string, unknown>> = {};
	for (const [modelId, value] of Object.entries(parsed.data)) {
		if (isUnsafeRecordKey(modelId)) {
			continue;
		}
		const entry = prefixKeyedEntrySchema.safeParse(value);
		if (entry.success) {
			records[modelId] = entry.data;
		}
	}
	return records;
}

/** Narrow a raw models.parameters value to the record-of-records shape. */
export function normalizeModelParameters(raw: unknown): Record<string, Record<string, unknown>> {
	return normalizePrefixKeyedRecords(raw);
}

export function getModelParametersConfig(): Record<string, Record<string, unknown>> {
	return normalizeModelParameters(getConfig().get<Record<string, unknown>>(MODEL_PARAMETERS_SETTING_KEY, {}));
}

/**
 * Narrow a raw models.capabilities value to the record-of-records shape. Shape
 * only, deliberately as lenient as normalizeModelParameters: the capability
 * vocabulary and value typing are enforced in one place,
 * capabilityResolution's parseCapabilityRecord.
 */
export function normalizeModelCapabilities(raw: unknown): Record<string, Record<string, unknown>> {
	return normalizePrefixKeyedRecords(raw);
}

export function getModelCapabilitiesConfig(): Record<string, Record<string, unknown>> {
	return normalizeModelCapabilities(getConfig().get<Record<string, unknown>>(MODEL_CAPABILITIES_SETTING_KEY, {}));
}

export function getMaskSecretInputs(): boolean {
	return getBooleanSetting("ui.maskSecretInputs");
}

/**
 * The OpenRouter catalog opt-out. Disabling stops the periodic refresh (all
 * catalog network) and the implicit by-raw-ID lookup; explicit
 * `_openrouter_model` directives keep answering from the snapshot.
 */
export function isOpenRouterCatalogEnabled(): boolean {
	return getBooleanSetting("models.openRouterCatalog");
}

/** The inline-completions opt-in; false means zero registration and zero traffic. */
export function isInlineCompletionsEnabled(): boolean {
	return getBooleanSetting("inlineCompletions.enabled");
}

/** The commit-generation opt-in; false hides the command surfaces and sends nothing. */
export function isCommitGenerationEnabled(): boolean {
	return getBooleanSetting("commitGeneration.enabled");
}

/**
 * Narrow a raw `<feature>.model` value to the explicit model choice: an object
 * whose `server` and `model` are non-empty strings, edge-trimmed like the
 * entry labels they address. Lenient by design - anything else is advisory-
 * logged and reads as unset, which keeps the feature fail-closed inert.
 */
export function normalizeFeatureModelRef(
	raw: unknown,
	feature: FeatureModelId,
	log?: LogFn
): FeatureModelRef | undefined {
	if (raw === undefined || raw === null) {
		return undefined;
	}
	const server = isRecord(raw) && typeof raw.server === "string" ? raw.server.trim() : "";
	const model = isRecord(raw) && typeof raw.model === "string" ? raw.model.trim() : "";
	if (server.length === 0 || model.length === 0) {
		log?.(`Invalid ${FEATURE_MODEL_SETTING_KEYS[feature]} configuration, reading the model as unset`, {
			configured: typeof raw,
		});
		return undefined;
	}
	return { server, model };
}

/** One feature's configured model ref, or undefined while unset or malformed (the feature stays idle). */
export function getFeatureModelRef(feature: FeatureModelId, log?: LogFn): FeatureModelRef | undefined {
	return normalizeFeatureModelRef(getConfig().get<unknown>(FEATURE_MODEL_SETTING_KEYS[feature]), feature, log);
}

/**
 * Narrow a raw commitGeneration.prompt value: any string passes verbatim
 * (model-facing text, so no trimming), anything else reads as "" - the empty
 * string that means "use the built-in instruction".
 */
export function normalizeCommitGenerationPrompt(raw: unknown): string {
	return typeof raw === "string" ? raw : "";
}

/** The custom commit instruction; "" means the built-in instruction applies. */
export function getCommitGenerationPrompt(): string {
	return normalizeCommitGenerationPrompt(getConfig().get<unknown>(COMMIT_GENERATION_PROMPT_SETTING_KEY));
}

/**
 * Narrow a raw inlineCompletions.languageFilter value to the filter the
 * provider and the language status row consume. Lenient by design: a value
 * without a recognized mode is advisory-logged and reads as the default
 * (block nothing), and languages entries that are not non-empty strings drop
 * (edge-trimmed, deduplicated in configuration order).
 */
export function normalizeInlineLanguageFilter(raw: unknown, log?: LogFn): InlineLanguageFilter {
	if (raw === undefined) {
		return DEFAULT_INLINE_LANGUAGE_FILTER;
	}
	if (
		!isRecord(raw) ||
		typeof raw.mode !== "string" ||
		!(LANGUAGE_FILTER_MODES as readonly string[]).includes(raw.mode)
	) {
		log?.("Invalid inlineCompletions.languageFilter configuration, using the default (block nothing)", {
			configured: typeof raw,
		});
		return DEFAULT_INLINE_LANGUAGE_FILTER;
	}
	const mode = raw.mode as LanguageFilterMode;
	if (!Array.isArray(raw.languages)) {
		if (raw.languages !== undefined) {
			log?.("Invalid inlineCompletions.languageFilter languages configuration, using the empty list", {
				configured: typeof raw.languages,
			});
		}
		return { mode, languages: [] };
	}
	const valid = raw.languages
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	if (valid.length < raw.languages.length) {
		log?.("Ignoring language filter entries that are not non-empty language IDs", {
			ignored: raw.languages.length - valid.length,
		});
	}
	return { mode, languages: [...new Set(valid)] };
}

/** The inline-completions language filter, normalized (see normalizeInlineLanguageFilter). */
export function getInlineLanguageFilter(log?: LogFn): InlineLanguageFilter {
	return normalizeInlineLanguageFilter(getConfig().get<unknown>(INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY), log);
}
