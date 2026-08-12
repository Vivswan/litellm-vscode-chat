import type { TransportErrorClassification } from "../../shared/errorClassification";
import type { LogSafeErrorText } from "../../shared/logger";
import type { AggregatedStatus, ServerWithKey } from "../../shared/servers";
import type { GroupServer, PreAttachModelInfo } from "./groupModels";
import type { DiscoveryObservations, StatusWindow } from "./statusWindow";

/** One group serve's outcome as recorded into the status window. */
export type GroupServeOutcome =
	| {
			state: "ok";
			modelCount: number;
			/** See ServerStatusOk: zero models because the user hid the group, never a server outcome. */
			hiddenByRemoval?: boolean;
	  }
	| {
			state: "error";
			error: string;
			logSafeError: LogSafeErrorText;
			classification?: TransportErrorClassification;
			/** See ServerStatusError: the truthful error stays; presentation derives the downgrade. */
			expected?: boolean;
			declaredModelCount?: number;
	  };

/**
 * Status bookkeeping around the StatusWindow: every group serve records its
 * outcome here, and every record triggers one merged report to the status
 * callback (the status bar, notifier, and dashboard fan-out installed by the
 * extension layer). Owns the per-group report counter refreshViaHost's
 * settle-wait arms on - per-group reports only, because the groupless report
 * says nothing about whether the host is re-resolving groups.
 */
export class GroupStatusReporter {
	private readonly _window: StatusWindow;
	private _callback?: (status: AggregatedStatus) => void;
	private _groupReportCount = 0;

	/** Records into the facade-owned window; the facade keeps reading cycles and snapshots from it directly. */
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
		// Declared models serve through ANY discovery failure (config-rebuilt,
		// never discovered): the picker lists them, so the aggregate count must
		// match it whether or not the failure was expected.
		const totalModels = serverStatuses.reduce(
			(sum, s) => sum + (s.state === "ok" ? s.modelCount : (s.declaredModelCount ?? 0)),
			0
		);
		this._callback({ serverStatuses, totalModels, silent });
	}

	reportGroupStatus(
		server: ServerWithKey,
		groupServer: GroupServer,
		silent: boolean,
		outcome: GroupServeOutcome,
		/** Discovered pre-attach infos only; declared models are config-rebuilt every serve and never recorded. */
		models: readonly PreAttachModelInfo[],
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
			models,
			groupServer,
			observations
		);
		this.reportMerged(silent);
	}
}
