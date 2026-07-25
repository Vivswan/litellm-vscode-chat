import * as vscode from "vscode";
import { normalizePositiveNumber } from "./numbers";

type LogFn = (message: string, data?: unknown) => void;

const CONFIG_SECTION = "litellm-vscode-chat";

export const MIN_TIMEOUT_MS = 1000;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 30000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 300000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
export const DEFAULT_CONTEXT_LENGTH = 128000;

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

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function normalizeCustomHeaders(raw: unknown, log?: LogFn): Record<string, string> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {};
	}

	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		const trimmedName = name.trim();
		if (!trimmedName || !HEADER_NAME_PATTERN.test(trimmedName)) {
			log?.("Ignoring invalid custom header name", { name });
			continue;
		}
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
			log?.("Ignoring custom header with non-primitive value", { name: trimmedName });
			continue;
		}
		const rendered = String(value);
		if (rendered.includes("\r") || rendered.includes("\n")) {
			log?.("Ignoring custom header with unsafe newline characters", { name: trimmedName });
			continue;
		}
		headers[trimmedName] = rendered;
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

export function getModelParametersConfig(): Record<string, Record<string, unknown>> {
	return getConfig().get<Record<string, Record<string, unknown>>>("modelParameters", {});
}

export function getMaskApiKeyInput(): boolean {
	return getConfig().get<boolean>("maskApiKeyInput", true);
}
