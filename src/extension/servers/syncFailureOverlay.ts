/**
 * Sync failures never enter the provider's status window: an entry whose group
 * upsert failed has no group to report, and a blocked entry's live group keeps
 * reporting its OLD configuration as healthy. This module owns the
 * one precedence rule for what a declared entry's sync failure means beside
 * its live status, the overlay that applies it to the status bar's and
 * notifier's statuses, and the one verdict row set every headline surface
 * classifies (ServerVerdict); the dashboard's row builder (declaredOutcome)
 * consumes the same rule, so the surfaces cannot drift.
 */

import type { VerdictRow } from "../../dashboard/viewModels";
import { markLogSafe } from "../../shared/logger";
import type { ServerStatus } from "../../shared/servers";
import { isHiddenGroupServerStatus } from "../../shared/servers";
import { labeledSnapshots, resolveGroupOwnership } from "../dashboard/declaredJoin";
import type { DeclaredServersInput } from "../dashboard/declaredServers";
import type { DeclaredServerView, ServerEntryReport, SyncFailure } from "./serverSync";
// Not through the serverSync barrel: that barrel reaches the vscode host, and this module serves the webview-side
// vocabulary suites too.
import { rejectsWithOwnRow } from "./serverSync/rejects";

/**
 * What a declared entry presents, decided from its live status and its sync failure.
 *
 *   the group the host serves is the entry's OLD configuration
 *     -> a sync failure outranks the live status - even a healthy one
 *   the group keeps serving what it had -> the served count stays the live truth
 */
export type DeclaredPresentation =
	| { readonly kind: "sync-failed"; readonly servedModelCount: number; readonly failure: SyncFailure }
	| { readonly kind: "live" }
	| { readonly kind: "unchecked" };

export function declaredPresentation(
	status: Pick<ServerStatus, "servedModelCount"> | undefined,
	syncFailure: SyncFailure | undefined
): DeclaredPresentation {
	if (syncFailure !== undefined) {
		return { kind: "sync-failed", servedModelCount: status?.servedModelCount ?? 0, failure: syncFailure };
	}
	return status === undefined ? { kind: "unchecked" } : { kind: "live" };
}

/**
 * The status carries the failure class as its cause (every surface renders it at display time, in its locale), and the
 * log rendering is rebuilt from the class alone: enum ids, log-legal by construction.
 */
function syncFailureStatus(
	identity: Pick<
		ServerStatus,
		"serverId" | "label" | "entryLabel" | "baseUrl" | "lastChecked" | "hasApiKey" | "hasOAuth" | "hasVirtualKey"
	>,
	presentation: Extract<DeclaredPresentation, { kind: "sync-failed" }>
): ServerStatus {
	return {
		serverId: identity.serverId,
		label: identity.label,
		...(identity.entryLabel !== undefined ? { entryLabel: identity.entryLabel } : {}),
		baseUrl: identity.baseUrl,
		lastChecked: identity.lastChecked,
		// The credential kinds ride with the presence: persisted and diagnostics data keep what the row shows.
		...(identity.hasApiKey !== undefined ? { hasApiKey: identity.hasApiKey } : {}),
		...(identity.hasOAuth !== undefined ? { hasOAuth: identity.hasOAuth } : {}),
		...(identity.hasVirtualKey !== undefined ? { hasVirtualKey: identity.hasVirtualKey } : {}),
		state: "error",
		cause: { kind: "sync", failureClass: presentation.failure.class },
		logSafeError: markLogSafe(`provider group sync failed (${presentation.failure.class})`),
		servedModelCount: presentation.servedModelCount,
	};
}

/** The overlaid statuses (the window's rows plus the synthesized failures) and the count of entries awaiting a report. */
interface OverlaidWindow {
	readonly statuses: ServerStatus[];
	/** The declared entries no report and no sync failure reached: the dashboard's unchecked rows. */
	readonly unchecked: number;
}

/**
 * Joined by the same ownership the dashboard's servers table renders from (resolveGroupOwnership), so both
 * surfaces blame one snapshot, and an entry with no snapshot reads as the dashboard draws it (declaredOutcome): an
 * error serving nothing, whatever the failure class. A live group reporting later is overlaid as the same error, so
 * the row stays an error; the report only brings the models the group still serves.
 */
function overlayDeclared(statuses: readonly ServerStatus[], declared: readonly DeclaredServerView[]): OverlaidWindow {
	const labeled = labeledSnapshots(statuses.map((status) => ({ status, models: [], discoveredRawIds: [] })));
	const { matchedByDeclared } = resolveGroupOwnership({ labeled, declared });
	const overlaid = new Map<ServerStatus, ServerStatus>();
	const unseen: ServerStatus[] = [];
	let unchecked = 0;
	declared.forEach((view, declaredIndex) => {
		const live = matchedByDeclared.get(declaredIndex)?.entry.snapshot.status;
		const presentation = declaredPresentation(live, view.syncFailure);
		if (presentation.kind === "unchecked") {
			unchecked += 1;
			return;
		}
		if (presentation.kind !== "sync-failed") {
			return;
		}
		if (live !== undefined) {
			overlaid.set(live, syncFailureStatus(live, presentation));
		} else {
			unseen.push(
				syncFailureStatus(
					// "" is the established missing-value sentinel for both fields (restoreServerStatus writes the
					// same), and the empty serverId is no group client ID, so group-scoped consumers skip the synthetic
					// status.
					{ serverId: "", label: view.label, baseUrl: view.baseUrl, lastChecked: "" },
					presentation
				)
			);
		}
	});
	return { statuses: [...statuses.map((status) => overlaid.get(status) ?? status), ...unseen], unchecked };
}

/** The statuses the bar renders and persists: the window with each declared entry's sync failure overlaid. */
export function applySyncFailures(
	statuses: readonly ServerStatus[],
	declared: readonly DeclaredServerView[]
): ServerStatus[] {
	if (!declared.some((view) => view.syncFailure !== undefined)) {
		return [...statuses];
	}
	return overlayDeclared(statuses, declared).statuses;
}

/**
 * The verdict row set (classifyOverall's input): the overlaid statuses, one unchecked row per declared entry awaiting
 * its first report, and one misconfigured row per parser-refused entry. Private to ServerVerdict, so no surface can
 * build a variant of its own.
 */
function verdictRows(
	statuses: readonly ServerStatus[],
	declared: readonly DeclaredServerView[],
	misconfiguredEntries: number
): readonly VerdictRow[] {
	const window = overlayDeclared(statuses, declared);
	return [
		...window.statuses.map(
			(status): VerdictRow => ({
				state: status.state,
				servedModelCount: status.servedModelCount,
				...(status.state === "error" ? { failure: { cause: status.cause, baseUrl: status.baseUrl } } : {}),
				...(status.state === "error" && status.expected === true ? { expected: true } : {}),
				...(isHiddenGroupServerStatus(status) ? { hiddenByRemoval: true } : {}),
			})
		),
		...Array.from({ length: window.unchecked }, (): VerdictRow => ({ state: "unchecked", servedModelCount: 0 })),
		...Array.from(
			{ length: misconfiguredEntries },
			(): VerdictRow => ({
				state: "error",
				servedModelCount: 0,
				misconfigured: true,
				failure: { cause: { kind: "misconfiguredEntry" }, baseUrl: "" },
			})
		),
	];
}

/** Where the owner reads its one state from; production binds the provider, the sync engine, and the servers setting. */
export interface ServerVerdictSources {
	/** The provider's status window as it stands: every group's latest report. */
	statuses(): readonly ServerStatus[];
	/** The declared entries as every surface resolves them (resolveDeclaredServers). */
	declared(): DeclaredServersInput;
	/** The servers setting's per-entry acceptance reports (serverSettingReports). */
	entryReports(): readonly ServerEntryReport[];
}

/**
 * The one owner of the overall verdict's input. The status bar, the notifier, the dashboard hero, and the paste line
 * all classify rows(), and every surface that joins or judges the declared entries reads declared() here, so no two
 * surfaces can read one window differently: an unchecked entry beside a failed one is "degraded" everywhere, a
 * parser-refused entry beside a healthy one is "connected" everywhere.
 */
export class ServerVerdict {
	constructor(private readonly sources: ServerVerdictSources) {}

	declared(): DeclaredServersInput {
		return this.sources.declared();
	}

	rows(): readonly VerdictRow[] {
		const declared = this.sources.declared().views;
		return verdictRows(
			this.sources.statuses(),
			declared,
			rejectsWithOwnRow(this.sources.entryReports(), declared).length
		);
	}
}
