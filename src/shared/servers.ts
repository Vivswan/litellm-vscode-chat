/**
 * Server-related types shared across the extension and provider layers, kept here so the provider layer never imports
 * from src/extension (layering is one-way: extension -> provider -> shared).
 */

import type { TransportErrorClassification, UnservedEndpointEvidence } from "./errorClassification";
import type { FailureCause } from "./failureCause";
import { failureClassification } from "./failureCause";
import type { LogSafeErrorText } from "./logger";
import type { HeaderValue } from "./util/headers";

export interface ServerConfig {
	id: string;
	label: string;
	baseUrl: string;
}

export interface ServerWithKey extends ServerConfig {
	/** Empty string for keyless servers. */
	apiKey: HeaderValue | "";
}

/**
 * What every status row carries.
 *
 * `entryLabel` is the group's CONFIGURED label, never the URL-host display fallback an unlabeled group renders under as
 * `label`, which can collide with a declared entry's label; ui/diagnostics.ts pairs a report with its declared entry
 * on it.
 *
 * `hasApiKey` says whether the configuration carries credentials of any kind (groupHasCredentials); the values never
 * leave their store.
 *
 * `hasOAuth` and `hasVirtualKey` name the kind beside that presence, for rows with no settings entry, whose group
 * configuration is the only source.
 */
interface ServerStatusCommon {
	serverId: string;
	label: string;
	baseUrl: string;
	lastChecked: string;
	servedModelCount: number;
	entryLabel?: string | undefined;
	hasApiKey?: boolean | undefined;
	hasOAuth?: boolean | undefined;
	hasVirtualKey?: boolean | undefined;
}

/**
 * A served group.
 *
 * `hiddenByRemoval` is true when it serves zero models because the user hid it, not because the server listed none:
 * suppression never touches the network, so the outcome stays "ok" and the flag carries the cause.
 *
 * `modelInfoUnsupported` is present when discovery fell back to /models because the model-info probe failed like an
 * unserved endpoint the entry does not declare expected; the models serve fine, and nothing gates on it.
 */
interface ServerStatusOk extends ServerStatusCommon {
	state: "ok";
	hiddenByRemoval?: boolean | undefined;
	modelInfoUnsupported?: UnservedEndpointEvidence | undefined;
	error?: undefined;
}

/**
 * A failed serve.
 *
 * `cause` says why, as a key (shared/failureCause.ts) every surface renders at display time in the current locale;
 * log-legal and protocol-legal because it carries no rendered text.
 *
 * `logSafeError` is the log rendering: a classification, never response-derived text, since log lines prefill public
 * GitHub issues.
 *
 * `expected` is true when the failure hit a category the entry's expectedFailures declares. The outcome stays a
 * truthful error (the stale anchor and failure counting depend on it); presentation derives the "(expected)" downgrade
 * from it.
 *
 * `declaredModelCount` is the declared subset of servedModelCount: how many still-served models exist only because the
 * entry declares them. The "N declared models" wording reads it; counts and verdicts read servedModelCount.
 */
export interface ServerStatusError extends ServerStatusCommon {
	state: "error";
	cause: FailureCause;
	logSafeError: LogSafeErrorText;
	expected?: boolean | undefined;
	declaredModelCount?: number | undefined;
}

export type ServerStatus = ServerStatusOk | ServerStatusError;

/** The transport classification behind a failing status, when its cause is a transport failure. */
export function statusClassification(status: ServerStatusError): TransportErrorClassification | undefined {
	return failureClassification(status.cause);
}

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
