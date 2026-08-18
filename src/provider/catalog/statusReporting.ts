import type { TransportErrorClassification, UnservedEndpointEvidence } from "../../shared/errorClassification";
import type { LogSafeErrorText } from "../../shared/logger";
import type { AggregatedStatus, ServerWithKey } from "../../shared/servers";
import type { GroupServer } from "./groupModels";
import type { DiscoveryObservations, ServedModelSets, StatusWindow } from "./statusWindow";

/** One group serve's outcome as recorded into the status window. */
export type GroupServeOutcome =
	| {
			state: "ok";
			/** See ServerStatusCommon: the models this serve handed the host. */
			servedModelCount: number;
			/** See ServerStatusOk: zero models because the user hid the group, never a server outcome. */
			hiddenByRemoval?: boolean;
			/** See ServerStatusOk: the serve fell back to /models past an unserved-looking model-info probe. */
			modelInfoUnsupported?: UnservedEndpointEvidence;
	  }
	| {
			state: "error";
			error: string;
			logSafeError: LogSafeErrorText;
			classification?: TransportErrorClassification;
			/** See ServerStatusError: the truthful error stays; presentation derives the downgrade. */
			expected?: boolean;
			/** See ServerStatusCommon: what the failure still serves (stale-window plus declared models). */
			servedModelCount: number;
			/** See ServerStatusError: the declared subset of servedModelCount. */
			declaredModelCount?: number;
	  };

/**
 * Status bookkeeping around the StatusWindow: every group serve records its
 * outcome here, and every record triggers one merged report to the status
 * callback. Owns the per-group report counter refreshViaHost's settle-wait
 * arms on - per-group reports only, since the groupless report says nothing
 * about whether the host is re-resolving groups.
 */
export class GroupStatusReporter {
	private readonly _window: StatusWindow;
	private _callback?: (status: AggregatedStatus) => void;
	private _groupReportCount = 0;

	/** The window is facade-owned; the facade reads cycles and snapshots from it directly. */
	constructor(window: StatusWindow) {
		this._window = window;
	}

	setCallback(callback: (status: AggregatedStatus) => void): void {
		this._callback = callback;
	}

	/** How many per-group status reports have landed; see refreshViaHost's settle-wait. */
	get groupReportCount(): number {
		return this._groupReportCount;
	}

	/** Report the union of every live group's latest status, so one group's fetch never masks the others. */
	reportMerged(silent: boolean): void {
		if (!this._callback) {
			return;
		}
		const serverStatuses = this._window.snapshots().map((snapshot) => snapshot.status);
		// servedModelCount is the one field answering "how many models does this
		// server serve right now" on every state: stale-window and declared models
		// keep counting through failures, matching what the picker lists.
		const totalModels = serverStatuses.reduce((sum, s) => sum + s.servedModelCount, 0);
		this._callback({ serverStatuses, totalModels, silent });
	}

	reportGroupStatus(
		server: ServerWithKey,
		groupServer: GroupServer,
		silent: boolean,
		outcome: GroupServeOutcome,
		/** The full sets this serve handed the host; the window snapshots both while stale serving anchors to discovered only. */
		served: ServedModelSets,
		/** What this discovery observed (raw IDs, model_info keys); see DiscoveryObservations. */
		observations: DiscoveryObservations = {}
	): void {
		this._groupReportCount += 1;
		this._window.record(
			{
				serverId: server.id,
				label: server.label,
				baseUrl: server.baseUrl,
				lastChecked: new Date().toISOString(),
				// Diagnostics reads this as "authentication configured", so OAuth
				// client credentials count the same as a static key.
				hasApiKey: groupServer.apiKey.length > 0 || groupServer.oauth !== undefined,
				...outcome,
			},
			served,
			groupServer,
			observations
		);
		this.reportMerged(silent);
	}
}
