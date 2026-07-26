import * as vscode from "vscode";
import { z } from "zod";
import { normalizePositiveNumber } from "./numbers";

type LogFn = (message: string, data?: unknown) => void;

const CONFIG_SECTION = "litellm-vscode-chat";

export const MIN_TIMEOUT_MS = 1000;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 30000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 300000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
const DEFAULT_CONTEXT_LENGTH = 128000;

function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

/**
 * Validate a configured timeout: non-finite values fall back to the default,
 * finite values are clamped to the minimum. Logs whenever the effective value
 * differs from the configured one.
 */
export function clampTimeout(raw: unknown, fallback: number, name: string, log?: LogFn): number {
	const candidate = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
	const clamped = Math.max(MIN_TIMEOUT_MS, candidate);
	if (clamped !== raw) {
		log?.(`Invalid ${name} configuration, using clamped value`, { configured: raw, clamped });
	}
	return clamped;
}

export function getDiscoveryTimeout(log?: LogFn): number {
	const raw = getConfig().get<number>("discoveryTimeout", DEFAULT_DISCOVERY_TIMEOUT_MS);
	return clampTimeout(raw, DEFAULT_DISCOVERY_TIMEOUT_MS, "discoveryTimeout", log);
}

export function getRequestTimeout(log?: LogFn): number {
	const raw = getConfig().get<number>("requestTimeout", DEFAULT_REQUEST_TIMEOUT_MS);
	return clampTimeout(raw, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeout", log);
}

export function isPromptCachingEnabled(): boolean {
	return getConfig().get<boolean>("promptCaching.enabled", true);
}

/** Top-level shape shared by the `headers` and `modelParameters` settings: a plain object, keyed by string. */
const settingsRecordSchema = z.record(z.string(), z.unknown());

const headerNameSchema = z
	.string()
	.trim()
	.regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);

const headerValueSchema = z.union([z.string(), z.number(), z.boolean()]).transform((value) => String(value));

function normalizeCustomHeaders(raw: unknown, log?: LogFn): Record<string, string> {
	const parsed = settingsRecordSchema.safeParse(raw);
	if (!parsed.success) {
		return {};
	}

	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(parsed.data)) {
		const parsedName = headerNameSchema.safeParse(name);
		if (!parsedName.success) {
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

export function getModelParametersConfig(): Record<string, Record<string, unknown>> {
	const parsed = settingsRecordSchema.safeParse(getConfig().get<Record<string, unknown>>("modelParameters", {}));
	if (!parsed.success) {
		return {};
	}

	// Validate entry-by-entry so one malformed entry drops only itself, not the whole map.
	const modelParameters: Record<string, Record<string, unknown>> = {};
	for (const [modelId, value] of Object.entries(parsed.data)) {
		const entry = modelParametersEntrySchema.safeParse(value);
		if (entry.success) {
			modelParameters[modelId] = entry.data;
		}
	}
	return modelParameters;
}

export function getMaskApiKeyInput(): boolean {
	return getConfig().get<boolean>("maskApiKeyInput", true);
}
