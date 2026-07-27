import * as vscode from "vscode";
import { z } from "zod";
import { HEADER_NAME_PATTERN } from "./headers";
import { isUnsafeRecordKey } from "./json";
import { normalizePositiveNumber } from "./numbers";

type LogFn = (message: string, data?: unknown) => void;

const CONFIG_SECTION = "litellm-vscode-chat";

export const MIN_TIMEOUT_MS = 1000;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 30000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 300000;
export const DEFAULT_DISCOVERY_CACHE_TTL_MS = 3600000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
const DEFAULT_CONTEXT_LENGTH = 128000;

function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(CONFIG_SECTION);
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

/** Validate a configured timeout; see clampDuration. */
export function clampTimeout(raw: unknown, fallback: number, name: string, log?: LogFn): number {
	return clampDuration(raw, fallback, MIN_TIMEOUT_MS, name, log);
}

export function getDiscoveryTimeout(log?: LogFn): number {
	const raw = getConfig().get<number>("discoveryTimeout", DEFAULT_DISCOVERY_TIMEOUT_MS);
	return clampTimeout(raw, DEFAULT_DISCOVERY_TIMEOUT_MS, "discoveryTimeout", log);
}

export function getRequestTimeout(log?: LogFn): number {
	const raw = getConfig().get<number>("requestTimeout", DEFAULT_REQUEST_TIMEOUT_MS);
	return clampTimeout(raw, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeout", log);
}

/**
 * How long cached model-discovery results are served, in milliseconds. 0 is a
 * valid configuration: it disables serving from the cache (concurrent
 * refreshes still coalesce into one request).
 */
export function getDiscoveryCacheTtl(log?: LogFn): number {
	const raw = getConfig().get<number>("discoveryCacheTtl", DEFAULT_DISCOVERY_CACHE_TTL_MS);
	return clampDuration(raw, DEFAULT_DISCOVERY_CACHE_TTL_MS, 0, "discoveryCacheTtl", log);
}

export function isPromptCachingEnabled(): boolean {
	return getConfig().get<boolean>("promptCaching.enabled", true);
}

/** Top-level shape shared by the `headers` and `modelParameters` settings: a plain object, keyed by string. */
const settingsRecordSchema = z.record(z.string(), z.unknown());

const headerNameSchema = z.string().trim().regex(HEADER_NAME_PATTERN);

const headerValueSchema = z.union([z.string(), z.number(), z.boolean()]).transform((value) => String(value));

function normalizeCustomHeaders(raw: unknown, log?: LogFn): Record<string, string> {
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
		if (parsedValue.data.includes("\r") || parsedValue.data.includes("\n")) {
			log?.("Ignoring custom header with unsafe newline characters", { name: parsedName.data });
			continue;
		}
		headers[parsedName.data] = parsedValue.data;
	}

	return headers;
}

export function getCustomHeaders(log?: LogFn): Record<string, string> {
	const raw = getConfig().get<Record<string, unknown>>("headers", {});
	return normalizeCustomHeaders(raw, log);
}

export interface TokenDefaults {
	maxOutputTokens: number;
	contextLength: number;
	/** Only set when the user configured defaultMaxInputTokens; there is no built-in default. */
	maxInputTokens: number | undefined;
}

export function getTokenDefaults(): TokenDefaults {
	const config = getConfig();
	return {
		maxOutputTokens:
			normalizePositiveNumber(config.get<number>("defaultMaxOutputTokens", DEFAULT_MAX_OUTPUT_TOKENS)) ??
			DEFAULT_MAX_OUTPUT_TOKENS,
		contextLength:
			normalizePositiveNumber(config.get<number>("defaultContextLength", DEFAULT_CONTEXT_LENGTH)) ??
			DEFAULT_CONTEXT_LENGTH,
		maxInputTokens: normalizePositiveNumber(config.get<number | null>("defaultMaxInputTokens", null)),
	};
}

const modelParametersEntrySchema = z.record(z.string(), z.unknown());

/**
 * Narrow a raw modelParameters value to the record-of-records shape.
 * Validated entry-by-entry so one malformed entry drops only itself, not the
 * whole map; prototype-polluting keys are dropped outright. Shared by the
 * request path and the dashboard's settings view.
 */
export function normalizeModelParameters(raw: unknown): Record<string, Record<string, unknown>> {
	const parsed = settingsRecordSchema.safeParse(raw);
	if (!parsed.success) {
		return {};
	}

	const modelParameters: Record<string, Record<string, unknown>> = {};
	for (const [modelId, value] of Object.entries(parsed.data)) {
		if (isUnsafeRecordKey(modelId)) {
			continue;
		}
		const entry = modelParametersEntrySchema.safeParse(value);
		if (entry.success) {
			modelParameters[modelId] = entry.data;
		}
	}
	return modelParameters;
}

export function getModelParametersConfig(): Record<string, Record<string, unknown>> {
	return normalizeModelParameters(getConfig().get<Record<string, unknown>>("modelParameters", {}));
}

export function getMaskApiKeyInput(): boolean {
	return getConfig().get<boolean>("maskApiKeyInput", true);
}
