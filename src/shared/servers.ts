/**
 * Server-related types shared across the extension and provider layers.
 * They live here so the provider layer never imports from src/extension
 * (the dependency between layers is one-way: extension -> provider -> shared).
 */

import type { LogSafeErrorText } from "./logger";

export interface ServerConfig {
	id: string;
	label: string;
	baseUrl: string;
}

export interface ServerWithKey extends ServerConfig {
	apiKey: string;
}

interface ServerStatusCommon {
	serverId: string;
	label: string;
	baseUrl: string;
	lastChecked: string;
	/** Whether the server's configuration carries credentials (a static API key or OAuth client credentials); the secrets themselves never leave their store. */
	hasApiKey?: boolean | undefined;
}

interface ServerStatusOk extends ServerStatusCommon {
	state: "ok";
	modelCount: number;
	error?: undefined;
}

export interface ServerStatusError extends ServerStatusCommon {
	state: "error";
	/**
	 * Display rendering for UI surfaces only (status bar, toasts, the
	 * dashboard): an http failure's text embeds the response body. NEVER
	 * interpolate this into a log line, and never rebuild an Error from it
	 * (rethrow the original so its classification survives) - log lines land
	 * in the issue-report buffer, which prefills public GitHub issues; that
	 * is what logSafeError is for.
	 */
	error: string;
	/** The rendering for log lines; the brand makes a display string a compile error here (see LogSafeErrorText). */
	logSafeError: LogSafeErrorText;
	modelCount?: undefined;
}

/**
 * One server's discovery outcome. A discriminated union: a reachable server
 * carries its model count, a failed one carries its error message, and the
 * type makes an error-with-count or a message-less failure unrepresentable.
 */
export type ServerStatus = ServerStatusOk | ServerStatusError;

export function isErrorServerStatus(status: ServerStatus): status is ServerStatusError {
	return status.state === "error";
}

export interface AggregatedStatus {
	serverStatuses: ServerStatus[];
	totalModels: number;
	silent: boolean;
}
