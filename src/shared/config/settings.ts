import * as vscode from "vscode";
import { z } from "zod";
import type { HeaderScalar } from "../util/headers";
import { HEADER_NAME_PATTERN, isHeaderScalar, isValidHeaderValue } from "../util/headers";
import { isUnsafeRecordKey } from "../util/json";
import type { BooleanSettingId, NumberSettingId } from "./settingSpec";
import {
	BOOLEAN_SETTING_SPECS,
	CONFIG_SECTION,
	MIN_TIMEOUT_MS,
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	NUMBER_SETTING_SPECS,
	SERVERS_SETTING_KEY,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
	USAGE_STATUS_BAR_SETTING_KEY,
} from "./settingSpec";

type LogFn = (message: string, data?: unknown) => void;

// The object settings' keys live in settingSpec.ts beside the scalar specs
// (vscode-free, so non-host consumers can load them); re-exported here for
// the readers that take everything settings-related from this module.
export {
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
 * Validate a configured millisecond duration: non-finite values fall back to
 * the default, finite values are clamped to the minimum. Logs whenever the
 * effective value differs from the configured one.
 */
function clampDuration(raw: unknown, fallback: number, minimum: number, name: string, log?: LogFn): number {
	const candidate = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
	const clamped = Math.max(minimum, candidate);
	if (clamped !== raw) {
		log?.(`Invalid ${name} configuration, using clamped value`, { configured: raw, clamped });
	}
	return clamped;
}

/** The duration settings share the clamping read; each one's default and floor come from its spec. */
function getDurationSetting(id: NumberSettingId, log?: LogFn): number {
	const spec = NUMBER_SETTING_SPECS[id];
	return clampDuration(getNumberSetting(id), spec.default, spec.minimum, id, log);
}

export function getDiscoveryTimeout(log?: LogFn): number {
	return getDurationSetting("discovery.timeout", log);
}

export function getRequestTimeout(log?: LogFn): number {
	return getDurationSetting("chat.timeout", log);
}

/**
 * How long cached model-discovery results are served, in milliseconds. 0 is a
 * valid configuration (the spec's floor): it disables serving from the cache
 * (concurrent refreshes still coalesce into one request).
 */
export function getDiscoveryCacheTtl(log?: LogFn): number {
	return getDurationSetting("discovery.cacheTtl", log);
}

export function isPromptCachingEnabled(): boolean {
	return getBooleanSetting("chat.promptCaching");
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
 * explicit refresh still works), negatives clamp to zero, nonzero values
 * clamp up to MIN_USAGE_POLL_INTERVAL_MS, and non-finite values fall back to
 * the default.
 */
export function getUsagePollIntervalMs(log?: LogFn): number {
	const clamped = getDurationSetting("usage.pollInterval", log);
	if (clamped > 0 && clamped < MIN_USAGE_POLL_INTERVAL_MS) {
		log?.("Invalid usage.pollInterval configuration, using clamped value", {
			configured: clamped,
			clamped: MIN_USAGE_POLL_INTERVAL_MS,
		});
		return MIN_USAGE_POLL_INTERVAL_MS;
	}
	return clamped;
}

/** The budget fractions the usage poller alerts at when nothing valid is configured. */
export const DEFAULT_USAGE_ALERT_THRESHOLDS: readonly number[] = [0.8, 0.95];

/**
 * Narrow a raw usage.alertThresholds value to usable alert fractions: finite
 * numbers in (0, 1], deduplicated and sorted ascending. A non-array falls back
 * to the default; an array keeps only its valid entries (an empty result is a
 * legitimate "no alerts" configuration). Exported for the unit suite and the
 * dashboard's settings view; the poller reads it through
 * getUsageAlertThresholds.
 */
export function normalizeUsageAlertThresholds(raw: unknown, log?: LogFn): readonly number[] {
	if (!Array.isArray(raw)) {
		log?.("Invalid usage.alertThresholds configuration, using the default", { configured: typeof raw });
		return DEFAULT_USAGE_ALERT_THRESHOLDS;
	}
	const valid = raw.filter(
		(value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1
	);
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

/** Top-level shape shared by the record settings (headers, models.parameters): a plain object, keyed by string. */
const settingsRecordSchema = z.record(z.string(), z.unknown());

const headerNameSchema = z.string().trim().regex(HEADER_NAME_PATTERN);

const headerValueSchema = z.custom<HeaderScalar>(isHeaderScalar).transform((value) => String(value));

/**
 * Narrow a raw custom-headers record (a server entry's `headers` field) to
 * the record the wire carries. Values must pass isValidHeaderValue (the one
 * owner of the header-value charset rule, shared with the dashboard's editors
 * and intent validation): a value that reached the platform's Headers instead
 * would throw a TypeError embedding the full plaintext value, and these
 * values can be secrets. Two names differing only by case are one HTTP
 * header: the first one in the object wins and the collision is reported.
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
 * entry drops only itself, not the whole map; prototype-polluting keys are
 * dropped outright.
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

/**
 * Narrow a raw models.parameters value to the record-of-records shape. Shared
 * by the request path and the dashboard's settings view.
 */
export function normalizeModelParameters(raw: unknown): Record<string, Record<string, unknown>> {
	return normalizePrefixKeyedRecords(raw);
}

export function getModelParametersConfig(): Record<string, Record<string, unknown>> {
	return normalizeModelParameters(getConfig().get<Record<string, unknown>>(MODEL_PARAMETERS_SETTING_KEY, {}));
}

/**
 * Narrow a raw models.capabilities value to the record-of-records shape.
 * Shape only, deliberately as lenient as normalizeModelParameters: the
 * capability vocabulary and value typing are enforced in one place,
 * capabilityResolution's parseCapabilityRecord, which also produces the
 * diagnostics the dashboard renders.
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
 * `_openrouter_model` directives keep answering from the bundled or cached
 * snapshot.
 */
export function isOpenRouterCatalogEnabled(): boolean {
	return getBooleanSetting("models.openRouterCatalog");
}
