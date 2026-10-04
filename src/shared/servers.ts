/**
 * Server-related types shared across the extension and provider layers, kept here so the provider layer never imports
 * from src/extension (layering is one-way: extension -> provider -> shared).
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
	servedModelCount: number;
	/**
	 * The group's CONFIGURED label, never the URL-host display fallback an unlabeled group renders under as `label`,
	 * which can collide with a declared entry's label. ui/diagnostics.ts pairs a report with its declared entry on it.
	 */
	entryLabel?: string | undefined;
	/** Whether the configuration carries credentials; the secrets themselves never leave their store. */
	hasApiKey?: boolean | undefined;
	/**
	 * Whether those credentials are OAuth client credentials rather than a static key: the credential-kind display for
	 * rows with no settings entry reads this, since the group's configuration is its only source.
	 */
	hasOAuth?: boolean | undefined;
}

interface ServerStatusOk extends ServerStatusCommon {
	state: "ok";
	/**
	 * True when the group serves zero models because the user hid it, not because the server listed none: suppression
	 * never touches the network, so the outcome stays "ok" and this flag carries the cause.
	 */
	hiddenByRemoval?: boolean | undefined;
	/**
	 * Present when discovery fell back to /models because the model-info probe failed like an unserved endpoint the
	 * entry does not declare expected: the models serve fine.
	 * Advisory only - nothing gates on it.
	 */
	modelInfoUnsupported?: UnservedEndpointEvidence | undefined;
	error?: undefined;
}

export interface ServerStatusError extends ServerStatusCommon {
	state: "error";
	/**
	 * Display rendering for UI surfaces only.
	 * NEVER interpolate this into a log line, and never rebuild an Error from it (rethrow the original so its
	 * classification survives) - log lines prefill public GitHub issues.
	 */
	error: string;
	logSafeError: LogSafeErrorText;
	/**
	 * Classification only (enum ids plus an integer status, never message text), so unlike `error` it is log-legal and
	 * protocol-legal.
	 */
	classification?: TransportErrorClassification | undefined;
	/**
	 * True when the failure hit a category the entry's expectedFailures declares. The outcome stays a truthful error
	 * (the stale anchor and failure counting depend on it); presentation derives the "(expected)" downgrade from this
	 * flag.
	 */
	expected?: boolean | undefined;
	/**
	 * The declared subset of servedModelCount: how many of the still-served models exist only because the entry
	 * declares them. Presentation wording ("N declared models") reads this; counts and verdicts read servedModelCount.
	 */
	declaredModelCount?: number | undefined;
}

export type ServerStatus = ServerStatusOk | ServerStatusError;

function isErrorServerStatus(status: ServerStatus): status is ServerStatusError {
	return status.state === "error";
}

/** The failures the entry's expectedFailures does NOT declare. Expected failures are configured as normal. */
export function unexpectedServerFailures(statuses: readonly ServerStatus[]): ServerStatusError[] {
	return statuses.filter(
		(status): status is ServerStatusError => isErrorServerStatus(status) && status.expected !== true
	);
}

export function unexpectedFailureCount(statuses: readonly ServerStatus[]): number {
	return unexpectedServerFailures(statuses).length;
}

/**
 * Typed to the two fields it actually reads, not the whole ServerStatus, so surfaces holding a narrower mirror of a
 * status - the chat participant's snapshot shape, for one - can hide removed groups through THIS predicate instead of
 * restating the rule.
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
