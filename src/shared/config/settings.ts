import * as vscode from "vscode";
import { z } from "zod";
import type { HeaderScalar } from "../util/headers";
import { HEADER_NAME_PATTERN, isHeaderScalar, isValidHeaderValue } from "../util/headers";
import { isUnsafeRecordKey } from "../util/json";
import type { BooleanSettingId, NumberSettingId } from "./settingSpec";
import { BOOLEAN_SETTING_SPECS, CONFIG_SECTION, MIN_TIMEOUT_MS, NUMBER_SETTING_SPECS } from "./settingSpec";

type LogFn = (message: string, data?: unknown) => void;

export { MIN_TIMEOUT_MS };

/**
 * The object settings' keys under the config section. The scalar settings get
 * theirs from settingSpec.ts; these have no scalar spec, so their readers
 * (here, the server sync engine, and the dashboard's editors) share the keys
 * through these constants, and settingSpec.test.ts pins the package.json
 * contributions against them.
 */
export const HEADERS_SETTING_KEY = "headers";
export const MODEL_CAPABILITIES_SETTING_KEY = "modelCapabilities";
export const MODEL_PARAMETERS_SETTING_KEY = "modelParameters";
export const SERVERS_SETTING_KEY = "servers";

export const DEFAULT_DISCOVERY_TIMEOUT_MS = NUMBER_SETTING_SPECS.discoveryTimeout.default;
export const DEFAULT_REQUEST_TIMEOUT_MS = NUMBER_SETTING_SPECS.requestTimeout.default;
export const DEFAULT_DISCOVERY_CACHE_TTL_MS = NUMBER_SETTING_SPECS.discoveryCacheTtl.default;

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
function getDurationSetting(id: "discoveryTimeout" | "requestTimeout" | "discoveryCacheTtl", log?: LogFn): number {
	const spec = NUMBER_SETTING_SPECS[id];
	return clampDuration(getNumberSetting(id), spec.default, spec.minimum, id, log);
}

export function getDiscoveryTimeout(log?: LogFn): number {
	return getDurationSetting("discoveryTimeout", log);
}

export function getRequestTimeout(log?: LogFn): number {
	return getDurationSetting("requestTimeout", log);
}

/**
 * How long cached model-discovery results are served, in milliseconds. 0 is a
 * valid configuration (the spec's floor): it disables serving from the cache
 * (concurrent refreshes still coalesce into one request).
 */
export function getDiscoveryCacheTtl(log?: LogFn): number {
	return getDurationSetting("discoveryCacheTtl", log);
}

export function isPromptCachingEnabled(): boolean {
	return getBooleanSetting("promptCaching.enabled");
}

/** Top-level shape shared by the `headers` and `modelParameters` settings: a plain object, keyed by string. */
const settingsRecordSchema = z.record(z.string(), z.unknown());

const headerNameSchema = z.string().trim().regex(HEADER_NAME_PATTERN);

const headerValueSchema = z.custom<HeaderScalar>(isHeaderScalar).transform((value) => String(value));

/**
 * Narrow the raw headers setting to the record the wire carries. Values must
 * pass isValidHeaderValue (the one owner of the header-value charset rule,
 * shared with the dashboard's editors and intent validation): a value that
 * reached the platform's Headers instead would throw a TypeError embedding
 * the full plaintext value, and these values can be secrets. Exported for the
 * unit suite; the request path reads it through getCustomHeaders.
 */
export function normalizeCustomHeaders(raw: unknown, log?: LogFn): Record<string, string> {
	const parsed = settingsRecordSchema.safeParse(raw);
	if (!parsed.success) {
		return {};
	}

	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(parsed.data)) {
		const parsedName = headerNameSchema.safeParse(name);
		if (!parsedName.success || isUnsafeRecordKey(parsedName.data)) {
			log?.("Ignoring invalid custom header name", { name });
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
		headers[parsedName.data] = parsedValue.data;
	}

	return headers;
}

export function getCustomHeaders(log?: LogFn): Record<string, string> {
	const raw = getConfig().get<Record<string, unknown>>(HEADERS_SETTING_KEY, {});
	return normalizeCustomHeaders(raw, log);
}

const prefixKeyedEntrySchema = z.record(z.string(), z.unknown());

/**
 * Narrow a raw prefix-keyed setting (modelParameters, modelCapabilities) to
 * the record-of-records shape. Validated entry-by-entry so one malformed
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
 * Narrow a raw modelParameters value to the record-of-records shape. Shared
 * by the request path and the dashboard's settings view.
 */
export function normalizeModelParameters(raw: unknown): Record<string, Record<string, unknown>> {
	return normalizePrefixKeyedRecords(raw);
}

export function getModelParametersConfig(): Record<string, Record<string, unknown>> {
	return normalizeModelParameters(getConfig().get<Record<string, unknown>>(MODEL_PARAMETERS_SETTING_KEY, {}));
}

/**
 * Narrow a raw modelCapabilities value to the record-of-records shape. Shape
 * only, deliberately as lenient as normalizeModelParameters: the capability
 * vocabulary and value typing are enforced in one place,
 * capabilityResolution's parseCapabilityRecord, which also produces the
 * diagnostics the dashboard renders.
 */
export function normalizeModelCapabilities(raw: unknown): Record<string, Record<string, unknown>> {
	return normalizePrefixKeyedRecords(raw);
}

export function getModelCapabilitiesConfig(): Record<string, Record<string, unknown>> {
	return normalizeModelCapabilities(getConfig().get<Record<string, unknown>>(MODEL_CAPABILITIES_SETTING_KEY, {}));
}

export function getMaskApiKeyInput(): boolean {
	return getBooleanSetting("maskApiKeyInput");
}

/**
 * The OpenRouter catalog opt-out. Disabling stops the periodic refresh (all
 * catalog network) and the implicit by-raw-ID lookup; explicit
 * `_openrouter_model` directives keep answering from the bundled or cached
 * snapshot.
 */
export function isOpenRouterCatalogEnabled(): boolean {
	return getBooleanSetting("openRouterCatalog.enabled");
}
