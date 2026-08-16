/**
 * Server-related types shared across the extension and provider layers, kept
 * here so the provider layer never imports from src/extension (layering is
 * one-way: extension -> provider -> shared).
 */

import type { TransportErrorClassification, UnservedEndpointEvidence } from "./errorClassification";
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
	/** Whether the configuration carries credentials; the secrets themselves never leave their store. */
	hasApiKey?: boolean | undefined;
}

interface ServerStatusOk extends ServerStatusCommon {
	state: "ok";
	modelCount: number;
	/**
	 * True when the group serves zero models because the user hid it, not
	 * because the server listed none: suppression never touches the network, so
	 * the outcome stays "ok" and this flag carries the cause.
	 */
	hiddenByRemoval?: boolean | undefined;
	/**
	 * Present when discovery fell back to /models because the model-info probe
	 * failed like an unserved endpoint the entry does not declare expected: the
	 * models serve fine, but every sync pays for the doomed probe first.
	 * Advisory only - nothing gates on it.
	 */
	modelInfoUnsupported?: UnservedEndpointEvidence | undefined;
	error?: undefined;
}

export interface ServerStatusError extends ServerStatusCommon {
	state: "error";
	/**
	 * Display rendering for UI surfaces only: an http failure's text embeds the
	 * response body. NEVER interpolate this into a log line, and never rebuild
	 * an Error from it (rethrow the original so its classification survives) -
	 * log lines prefill public GitHub issues. That is what logSafeError is for.
	 */
	error: string;
	/** The rendering for log lines; the brand makes a display string a compile error here (see LogSafeErrorText). */
	logSafeError: LogSafeErrorText;
	/**
	 * Classification only (enum ids plus an integer status, never message
	 * text), so unlike `error` it is log-legal and protocol-legal. Absent means
	 * the error was not classified.
	 */
	classification?: TransportErrorClassification | undefined;
	/**
	 * True when the failure hit a category the entry's expectedFailures
	 * declares. The outcome stays a truthful error (the stale anchor and
	 * failure counting depend on it); presentation derives the "(expected)"
	 * downgrade from this flag.
	 */
	expected?: boolean | undefined;
	/** How many declared models the server keeps serving despite the failure; absent means none. */
	declaredModelCount?: number | undefined;
	modelCount?: undefined;
}

/**
 * One server's discovery outcome. The union makes an error-with-count or a
 * message-less failure unrepresentable.
 */
export type ServerStatus = ServerStatusOk | ServerStatusError;

export function isErrorServerStatus(status: ServerStatus): status is ServerStatusError {
	return status.state === "error";
}

/** True for a healthy status whose zero models are explained by an explicit user removal (a hidden group). */
export function isHiddenGroupServerStatus(status: ServerStatus): boolean {
	return status.state === "ok" && status.hiddenByRemoval === true;
}

export interface AggregatedStatus {
	serverStatuses: ServerStatus[];
	totalModels: number;
	silent: boolean;
}
