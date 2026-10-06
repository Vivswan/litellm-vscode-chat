import type { UnservedEndpointEvidence } from "../../shared/errorClassification";
import type { FailureCause } from "../../shared/failureCause";
import type { LogSafeErrorText } from "../../shared/logger";
import type { AggregatedStatus, ServerStatus, ServerWithKey } from "../../shared/servers";
import type { GroupServer } from "./groupModels";
import { groupCredentialKind, groupHasCredentials } from "./groupModels";
import type { DiscoveryObservations, ServedModelSets, StatusWindow } from "./statusWindow";

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
			/** See ServerStatusError: the cause the surfaces render, never text. */
			cause: FailureCause;
			logSafeError: LogSafeErrorText;
			/** See ServerStatusError: the truthful error stays; presentation derives the downgrade. */
			expected?: boolean;
			/** See ServerStatusCommon: what the failure still serves (stale-window plus declared models). */
			servedModelCount: number;
			/** See ServerStatusError: the declared subset of servedModelCount. */
			declaredModelCount?: number;
	  };

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

	/**
	 * How many group reports have landed in the window, ever; a refresh pass (index.ts refreshGroups) reads the
	 * difference across its run, so what it counts is what recorded, whichever serve's record stood.
	 */
	get groupReportCount(): number {
		return this._groupReportCount;
	}

	/** Report the union of every live group's latest status, so one group's fetch never masks the others. */
	reportMerged(silent: boolean): void {
		if (!this._callback) {
			return;
		}
		const serverStatuses = this._window.snapshots().map((snapshot) => snapshot.status);
		const totalModels = serverStatuses.reduce((sum, s) => sum + s.servedModelCount, 0);
		this._callback({ serverStatuses, totalModels, silent });
	}

	/** Only an ok outcome may carry observations, mirroring StatusWindow.record's overload pair. */
	reportGroupStatus(
		server: ServerWithKey,
		groupServer: GroupServer,
		silent: boolean,
		outcome: Extract<GroupServeOutcome, { state: "ok" }>,
		served: ServedModelSets,
		observations?: DiscoveryObservations
	): void;
	reportGroupStatus(
		server: ServerWithKey,
		groupServer: GroupServer,
		silent: boolean,
		outcome: Extract<GroupServeOutcome, { state: "error" }>,
		served: ServedModelSets
	): void;
	reportGroupStatus(
		server: ServerWithKey,
		groupServer: GroupServer,
		silent: boolean,
		outcome: GroupServeOutcome,
		served: ServedModelSets,
		observations: DiscoveryObservations = {}
	): void {
		this._groupReportCount += 1;
		const status: ServerStatus = {
			serverId: server.id,
			label: server.label,
			...(groupServer.label !== undefined ? { entryLabel: groupServer.label } : {}),
			baseUrl: server.baseUrl,
			lastChecked: new Date().toISOString(),
			hasApiKey: groupHasCredentials(groupServer),
			// The credential KIND (the primary form), for the dashboard's external rows: their group configuration is
			// the only place it is knowable.
			hasOAuth: groupCredentialKind(groupServer) === "oauth",
			hasVirtualKey: groupCredentialKind(groupServer) === "virtualKey",
			...outcome,
		};
		if (status.state === "ok") {
			this._window.record(status, served, groupServer, observations);
		} else {
			this._window.record(status, served, groupServer);
		}
		this.reportMerged(silent);
	}
}
