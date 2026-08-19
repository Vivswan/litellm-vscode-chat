/**
 * Sync failures never enter the provider's status window: an entry whose group
 * upsert failed has no group to report, and a blocked or skipped entry's live
 * group keeps reporting its OLD configuration as healthy. This module owns the
 * one precedence rule for what a declared entry's sync failure means beside
 * its live status, and the overlay that applies it to the status bar's and
 * notifier's input; the dashboard's row builder (declaredOutcome) consumes the
 * same rule, so the surfaces cannot drift.
 */

import { markLogSafe } from "../../shared/logger";
import type { ServerStatus } from "../../shared/servers";
import { joinDeclared, labeledSnapshots } from "../dashboard/declaredJoin";
import type { DeclaredServerView } from "./serverSync";

/**
 * What a declared entry presents, decided from its live status and its sync
 * error. A sync error outranks the live status - even a healthy one, since the
 * group the host serves is the entry's OLD configuration - while the served
 * count stays the live truth (the group keeps serving what it had); an entry
 * with no live status at all has no group behind it, so nothing serves.
 */
export type DeclaredPresentation =
	| { readonly kind: "sync-failed"; readonly servedModelCount: number; readonly error: string }
	| { readonly kind: "live" }
	| { readonly kind: "unchecked" };

export function declaredPresentation(
	status: Pick<ServerStatus, "servedModelCount"> | undefined,
	syncError: string | undefined
): DeclaredPresentation {
	if (syncError !== undefined) {
		return { kind: "sync-failed", servedModelCount: status?.servedModelCount ?? 0, error: syncError };
	}
	return status === undefined ? { kind: "unchecked" } : { kind: "live" };
}

/**
 * A sync failure as a window-shaped error status. The display text is the
 * engine's classified message; the log rendering is rebuilt from the failure
 * CLASS alone (enum ids, so it stays log-legal by construction even if a
 * future engine text ever embeds entry-derived detail).
 */
function syncFailureStatus(
	identity: Pick<ServerStatus, "serverId" | "label" | "baseUrl" | "lastChecked" | "hasApiKey">,
	presentation: Extract<DeclaredPresentation, { kind: "sync-failed" }>,
	syncErrorClass: DeclaredServerView["syncErrorClass"]
): ServerStatus {
	return {
		serverId: identity.serverId,
		label: identity.label,
		baseUrl: identity.baseUrl,
		lastChecked: identity.lastChecked,
		...(identity.hasApiKey !== undefined ? { hasApiKey: identity.hasApiKey } : {}),
		state: "error",
		error: presentation.error,
		logSafeError: markLogSafe(`provider group sync failed (${syncErrorClass ?? "unclassified"})`),
		servedModelCount: presentation.servedModelCount,
	};
}

/**
 * The status bar's and notifier's input: the provider-reported window with the
 * declared entries' sync failures overlaid. Joined by the same passes the
 * dashboard's servers table renders from (joinDeclared), so both surfaces
 * blame the same snapshot: a sync-failed entry's live status becomes an error
 * that keeps its served count, and an upsertFailed entry with no live status
 * appends an error serving nothing - upsertFailed alone proves no group
 * exists. A blocked entry's name IS held by a live group (its report gets the
 * overlay), and a skipped pass (any of the skip classes) leaves the live groups
 * serving, so for those an absent status means "not reported yet", and
 * synthesizing a dead error would race the first discovery report red and
 * fire a toast no later report can retract. Entries without a sync error
 * change nothing - an unchecked entry stays out of the window, exactly as
 * before.
 */
export function applySyncFailures(
	statuses: readonly ServerStatus[],
	declared: readonly DeclaredServerView[]
): ServerStatus[] {
	if (!declared.some((view) => view.syncError !== undefined)) {
		return [...statuses];
	}
	const labeled = labeledSnapshots(statuses.map((status) => ({ status, models: [], discoveredRawIds: [] })));
	const { matchedByDeclared } = joinDeclared(labeled, declared);
	const overlaid = new Map<ServerStatus, ServerStatus>();
	const unseen: ServerStatus[] = [];
	declared.forEach((view, declaredIndex) => {
		const live = matchedByDeclared.get(declaredIndex)?.entry.snapshot.status;
		const presentation = declaredPresentation(live, view.syncError);
		if (presentation.kind !== "sync-failed") {
			return;
		}
		if (live !== undefined) {
			overlaid.set(live, syncFailureStatus(live, presentation, view.syncErrorClass));
		} else if (view.syncErrorClass === "upsertFailed") {
			unseen.push(
				syncFailureStatus(
					// "" is the established missing-value sentinel for both fields
					// (restoreServerStatus writes the same), and the empty serverId is
					// no group client ID, so group-scoped consumers skip the synthetic
					// status.
					{ serverId: "", label: view.label, baseUrl: view.baseUrl, lastChecked: "" },
					presentation,
					view.syncErrorClass
				)
			);
		}
	});
	return [...statuses.map((status) => overlaid.get(status) ?? status), ...unseen];
}
