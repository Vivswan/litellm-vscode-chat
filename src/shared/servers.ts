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
	/**
	 * How many models this server serves RIGHT NOW, regardless of state: the
	 * one field every aggregate count and every serving verdict reads. On an
	 * error status it counts what the failure still serves (stale-window models
	 * plus declared models), so serving-through-failure stays visible.
	 */
	servedModelCount: number;
	/** Whether the configuration carries credentials; the secrets themselves never leave their store. */
	hasApiKey?: boolean | undefined;
	/**
	 * Whether those credentials are OAuth client credentials rather than a
	 * static key: the credential-kind display for rows with no settings entry
	 * reads this, since the group's configuration is its only source.
	 */
	hasOAuth?: boolean | undefined;
}

interface ServerStatusOk extends ServerStatusCommon {
	state: "ok";
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
	/**
	 * The declared subset of servedModelCount: how many of the still-served
	 * models exist only because the entry declares them. Presentation wording
	 * ("N declared models") reads this; counts and verdicts read servedModelCount.
	 */
	declaredModelCount?: number | undefined;
}

/**
 * One server's discovery outcome. The union makes an error-with-count or a
 * message-less failure unrepresentable.
 */
export type ServerStatus = ServerStatusOk | ServerStatusError;

function isErrorServerStatus(status: ServerStatus): status is ServerStatusError {
	return status.state === "error";
}

/**
 * The failures the entry's expectedFailures does NOT declare. Expected failures
 * are configured as normal, so every failure verdict and failure count reads
 * this filter, never raw isErrorServerStatus.
 */
export function unexpectedServerFailures(statuses: readonly ServerStatus[]): ServerStatusError[] {
	return statuses.filter(
		(status): status is ServerStatusError => isErrorServerStatus(status) && status.expected !== true
	);
}

/** The failed-server count every surface renders; expected failures stay out (see unexpectedServerFailures). */
export function unexpectedFailureCount(statuses: readonly ServerStatus[]): number {
	return unexpectedServerFailures(statuses).length;
}

/**
 * True for a healthy status whose zero models are explained by an explicit
 * user removal (a hidden group). Typed to the two fields it actually reads,
 * not the whole ServerStatus, so surfaces holding a narrower mirror of a
 * status - the chat participant's snapshot shape, for one - can hide removed
 * groups through THIS predicate instead of restating the rule.
 */
export function isHiddenGroupServerStatus(status: {
	readonly state: ServerStatus["state"];
	readonly hiddenByRemoval?: boolean | undefined;
}): boolean {
	return status.state === "ok" && status.hiddenByRemoval === true;
}

export interface AggregatedStatus {
	serverStatuses: ServerStatus[];
	totalModels: number;
	silent: boolean;
}
