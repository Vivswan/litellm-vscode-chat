import * as vscode from "vscode";
import { z } from "zod";
import { CMD } from "../../shared/config/commandIds";
import { LAST_CONNECTION_STATUS_KEY } from "../../shared/config/storageKeys";
import type { Logger, LogSafeErrorText } from "../../shared/logger";
import { markLogSafe } from "../../shared/logger";
import type { AggregatedStatus, ServerStatus } from "../../shared/servers";
import { isErrorServerStatus } from "../../shared/servers";

/** Every connection state, the single source for the union type and the persisted-status schema. */
const CONNECTION_STATES = ["not-configured", "connecting", "loading", "connected", "degraded", "error"] as const;

type ConnectionState = (typeof CONNECTION_STATES)[number];

/**
 * The status bar's (and diagnostics') view of the world, one variant per
 * state so each carries exactly the facts its rendering needs. The
 * "connecting" variant's `attention` flag is presentation state, not a state
 * of its own: a single empty window is normal cold-start ordering (the
 * groupless refresh reports before the per-group ones), but the state must
 * not spin neutrally forever - a second consecutive empty report is evidence
 * of persistence (a declared entry whose sync keeps failing, a native group
 * deleted after the latch flipped), so the presentation degrades to a warning
 * with an actionable tooltip. Any report with servers resets it. It rides
 * inside the variant (not a new state string) so statuses persisted by this
 * version still parse under older versions' state enums.
 */
export type ConnectionStatus =
	| { state: "not-configured"; lastChecked?: string | undefined }
	| {
			/**
			 * `attention` on a transient loading state is carried evidence, not
			 * presentation: the connection test overwrites a connecting state with
			 * "loading", and the degraded-connecting warning must survive that
			 * round trip. The field is engine-owned - updateStatusBar sets it from
			 * the state being replaced and overrides whatever a caller passed -
			 * and handleAggregatedStatus reads it back. Loading always renders as
			 * the neutral spinner.
			 */
			state: "loading";
			attention?: boolean | undefined;
			lastChecked?: string | undefined;
	  }
	| { state: "connecting"; attention: boolean; lastChecked?: string | undefined }
	| {
			state: "connected" | "degraded";
			totalModels: number;
			serverStatuses: readonly ServerStatus[];
			lastChecked?: string | undefined;
	  }
	| {
			state: "error";
			/** Display-only; log lines must use logSafeError (see ServerStatusError for the split's rationale). */
			error: string;
			logSafeError: LogSafeErrorText;
			totalModels?: number | undefined;
			serverStatuses?: readonly ServerStatus[] | undefined;
			lastChecked?: string | undefined;
	  };

// The union and CONNECTION_STATES are the same set, checked both ways at
// compile time: a state added to the union but not the list would silently
// discard every persisted status of that state (the schema below rejects it),
// and a listed state the union lacks could never be constructed.
const _connectionStatesMatchUnion: [
	Exclude<ConnectionStatus["state"], ConnectionState>,
	Exclude<ConnectionState, ConnectionStatus["state"]>,
] extends [never, never]
	? true
	: never = true;

/** The server statuses a connection status carries; empty for the states without a status window. */
export function statusServerStatuses(status: ConnectionStatus): readonly ServerStatus[] {
	switch (status.state) {
		case "connected":
		case "degraded":
			return status.serverStatuses;
		case "error":
			return status.serverStatuses ?? [];
		default:
			return [];
	}
}

/** The model count a connection status carries, or undefined for states that have none. */
export function statusTotalModels(status: ConnectionStatus): number | undefined {
	switch (status.state) {
		case "connected":
		case "degraded":
		case "error":
			return status.totalModels;
		default:
			return undefined;
	}
}

/**
 * One persisted status-window element, over only the fields consumers read
 * (the status bar's counts, diagnostics' group classification and legacy
 * rows). Loose, because older extension versions may have persisted extra
 * fields; discriminated, so an "ok" without a model count or an "error"
 * without its message is malformed rather than half-usable.
 */
const persistedServerStatusSchema = z.discriminatedUnion("state", [
	z.looseObject({
		state: z.literal("ok"),
		label: z.string(),
		baseUrl: z.string(),
		modelCount: z.number(),
		serverId: z.string().optional().catch(undefined),
		lastChecked: z.string().optional().catch(undefined),
		hasApiKey: z.boolean().optional().catch(undefined),
	}),
	z.looseObject({
		state: z.literal("error"),
		label: z.string(),
		baseUrl: z.string(),
		// A message-less (or empty) error element cannot render honestly, so it
		// is malformed and drops; a junk serverId/lastChecked/hasApiKey only
		// drops that field (the catch), never the whole element.
		error: z.string().min(1),
		logSafeError: z.string().min(1).optional().catch(undefined),
		serverId: z.string().optional().catch(undefined),
		lastChecked: z.string().optional().catch(undefined),
		hasApiKey: z.boolean().optional().catch(undefined),
	}),
]);

/** A persisted element as a real ServerStatus, or undefined for junk the parse drops. */
function restoreServerStatus(value: unknown): ServerStatus | undefined {
	const parsed = persistedServerStatusSchema.safeParse(value);
	if (!parsed.success) {
		return undefined;
	}
	const element = parsed.data;
	const common = {
		serverId: element.serverId ?? "",
		label: element.label,
		baseUrl: element.baseUrl,
		lastChecked: element.lastChecked ?? "",
		...(element.hasApiKey !== undefined ? { hasApiKey: element.hasApiKey } : {}),
	};
	return element.state === "ok"
		? { ...common, state: "ok", modelCount: element.modelCount }
		: {
				...common,
				state: "error",
				error: element.error,
				// A status persisted before logSafeError existed carries a display
				// message that may embed response text, so the restore fails closed
				// instead of promoting it to the log-safe slot. A present value was
				// written by publicErrorText (globalState is machine-local and only
				// this extension writes the key), so re-branding it is sound.
				logSafeError: element.logSafeError !== undefined ? markLogSafe(element.logSafeError) : RESTORED_ERROR_LOG_TEXT,
			};
}

/** The fail-closed log rendering for error statuses restored from a version that persisted no logSafeError. */
const RESTORED_ERROR_LOG_TEXT = markLogSafe(
	"server error restored from a previous session (message withheld from logs)"
);

const persistedStatusSchema = z.looseObject({
	state: z.enum(CONNECTION_STATES),
	totalModels: z.number().optional(),
	serverStatuses: z.array(z.unknown()).optional(),
	// An empty persisted message reads as no message at all, so it takes the
	// error state's downgrade path below instead of rendering blank text.
	error: z.string().min(1).optional().catch(undefined),
	logSafeError: z.string().min(1).optional().catch(undefined),
	lastChecked: z.string().optional(),
});

/**
 * The normalizing parse at the persistence trust boundary: statuses may come
 * from other extension versions, so this validates the fields consumers
 * dispatch on and rebuilds a status the union can vouch for. Malformed
 * serverStatuses elements are dropped (never rendered, never crashed on),
 * missing counts default to zero, and two staleness rules apply on restore: a
 * "connecting" that survived a session boundary starts in its needs-attention
 * presentation, and an "error" that lost its message downgrades to that same
 * degraded connecting instead of inventing an error text. Anything else
 * unusable restores as undefined and the caller starts from not-configured.
 */
function restoreConnectionStatus(value: unknown): ConnectionStatus | undefined {
	const parsed = persistedStatusSchema.safeParse(value);
	if (!parsed.success) {
		return undefined;
	}
	const raw = parsed.data;
	const lastChecked = raw.lastChecked !== undefined ? { lastChecked: raw.lastChecked } : {};
	const serverStatuses = (raw.serverStatuses ?? []).flatMap((element) => {
		const restored = restoreServerStatus(element);
		return restored === undefined ? [] : [restored];
	});
	switch (raw.state) {
		case "not-configured":
			return { state: "not-configured", ...lastChecked };
		case "loading":
			// A carried attention flag is not restored: like the connecting rule
			// below, the session boundary makes it stale, and the first empty
			// report after a restored loading never counted as consecutive.
			return { state: "loading", ...lastChecked };
		case "connecting":
			// A restored "connecting" is stale by definition (it survived a whole
			// session boundary without resolving), so it starts degraded instead
			// of spinning neutrally on last session's unfinished state.
			return { state: "connecting", attention: true, ...lastChecked };
		case "connected":
		case "degraded":
			return { state: raw.state, totalModels: raw.totalModels ?? 0, serverStatuses, ...lastChecked };
		case "error":
			if (raw.error === undefined) {
				// An error that lost its message cannot render honestly; it is as
				// stale as a restored connecting, so it degrades the same way.
				return { state: "connecting", attention: true, ...lastChecked };
			}
			return {
				state: "error",
				error: raw.error,
				// Same fail-closed rule as restoreServerStatus: a pre-upgrade
				// display message never becomes the log rendering.
				logSafeError: raw.logSafeError !== undefined ? markLogSafe(raw.logSafeError) : RESTORED_ERROR_LOG_TEXT,
				serverStatuses,
				...(raw.totalModels !== undefined ? { totalModels: raw.totalModels } : {}),
				...lastChecked,
			};
	}
}

export class StatusBarManager {
	private _connectionStatus: ConnectionStatus = { state: "not-configured" };
	private readonly _statusBarItem: vscode.StatusBarItem;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly logger: Logger,
		/**
		 * The shared not-configured gate (declared servers, group evidence): an
		 * empty status window on a configured install renders as "connecting",
		 * never as "not configured" - the persisted state also feeds the
		 * diagnostics snapshot that lands in public issue reports, so the claim
		 * must be honest.
		 */
		private readonly hasConfiguredServers: () => boolean
	) {
		this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this._statusBarItem.command = CMD.openDashboard;
		context.subscriptions.push(this._statusBarItem);

		const restored = restoreConnectionStatus(context.globalState.get<unknown>(LAST_CONNECTION_STATUS_KEY));
		if (restored !== undefined) {
			this._connectionStatus = restored;
		}
		// Rendering without an argument never persists, so nothing needs awaiting.
		void this.updateStatusBar();
	}

	get connectionStatus(): ConnectionStatus {
		return this._connectionStatus;
	}

	/** Whether the connecting state renders as needs-attention; pinned by tests. */
	get connectingAttention(): boolean {
		return this._connectionStatus.state === "connecting" && this._connectionStatus.attention;
	}

	/** The command the status bar item runs on click; pinned by tests. */
	get clickCommand(): string | vscode.Command | undefined {
		return this._statusBarItem.command;
	}

	async updateStatusBar(status?: ConnectionStatus): Promise<void> {
		if (status) {
			// A transient "loading" (the connection test) overwrites a connecting
			// state; its needs-attention evidence rides along so the next empty
			// report can read it back instead of resetting to the neutral spinner.
			const next: ConnectionStatus =
				status.state === "loading" && this.connectingAttention ? { ...status, attention: true } : status;
			this._connectionStatus = next;
			await this.context.globalState.update(LAST_CONNECTION_STATUS_KEY, next);
		}

		const current = this._connectionStatus;
		switch (current.state) {
			case "not-configured":
				this._statusBarItem.text = vscode.l10n.t("$(warning) LiteLLM");
				this._statusBarItem.tooltip = vscode.l10n.t("Not configured - click to set up");
				this._statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
				break;
			case "connecting":
				if (current.attention) {
					this._statusBarItem.text = vscode.l10n.t("$(warning) LiteLLM");
					this._statusBarItem.tooltip = vscode.l10n.t(
						"Configured servers have not reported any models\nClick to open the dashboard and check the configuration"
					);
					this._statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
				} else {
					this._statusBarItem.text = vscode.l10n.t("$(loading~spin) LiteLLM");
					this._statusBarItem.tooltip = vscode.l10n.t("Waiting for the configured servers to report...");
					this._statusBarItem.backgroundColor = undefined;
				}
				break;
			case "loading":
				this._statusBarItem.text = vscode.l10n.t("$(loading~spin) LiteLLM");
				this._statusBarItem.tooltip = vscode.l10n.t("Fetching models...");
				this._statusBarItem.backgroundColor = undefined;
				break;
			case "connected": {
				const count = current.totalModels;
				const serverCount = current.serverStatuses.length;
				const available =
					serverCount > 1
						? count === 1
							? vscode.l10n.t("1 model available from {0} servers", serverCount)
							: vscode.l10n.t("{0} models available from {1} servers", count, serverCount)
						: count === 1
							? vscode.l10n.t("1 model available")
							: vscode.l10n.t("{0} models available", count);
				this._statusBarItem.text = vscode.l10n.t("$(check) LiteLLM ({0})", count);
				this._statusBarItem.tooltip = `${available}\n${vscode.l10n.t("Click for diagnostics")}`;
				this._statusBarItem.backgroundColor = undefined;
				break;
			}
			case "degraded": {
				const count = current.totalModels;
				const failedCount = current.serverStatuses.filter(isErrorServerStatus).length;
				const available =
					count === 1 ? vscode.l10n.t("1 model available") : vscode.l10n.t("{0} models available", count);
				const unreachable =
					failedCount === 1
						? vscode.l10n.t("1 server unreachable")
						: vscode.l10n.t("{0} servers unreachable", failedCount);
				this._statusBarItem.text = vscode.l10n.t("$(warning) LiteLLM ({0})", count);
				this._statusBarItem.tooltip = `${available}\n${unreachable}\n${vscode.l10n.t("Click for diagnostics")}`;
				this._statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
				break;
			}
			case "error":
				this._statusBarItem.text = vscode.l10n.t("$(error) LiteLLM");
				this._statusBarItem.tooltip = vscode.l10n.t("Connection failed\n{0}\nClick for details", current.error);
				this._statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
				break;
		}
		this._statusBarItem.show();
	}

	handleAggregatedStatus(aggStatus: AggregatedStatus): void {
		const now = new Date().toISOString();
		const { serverStatuses, totalModels } = aggStatus;

		if (serverStatuses.length === 0) {
			// The empty window is only a not-configured verdict when nothing else
			// proves servers exist; at cold start the groupless refresh reports
			// empty before the per-group refreshes arrive.
			if (this.hasConfiguredServers()) {
				// Already connecting = a second consecutive empty report; see the
				// connecting variant's attention flag for why that degrades. A
				// loading state that carried the flag counts the same: the warning
				// must survive the connection test's transient overwrite.
				const previous = this._connectionStatus;
				this.logger.log("No server statuses yet; configured servers have not reported");
				void this.updateStatusBar({
					state: "connecting",
					attention: previous.state === "connecting" || (previous.state === "loading" && previous.attention === true),
					lastChecked: now,
				});
			} else {
				this.logger.log("No servers configured");
				void this.updateStatusBar({ state: "not-configured", lastChecked: now });
			}
			return;
		}

		const failures = serverStatuses.filter(isErrorServerStatus);
		const firstFailure = failures[0];
		const okCount = serverStatuses.length - failures.length;

		if (firstFailure !== undefined && okCount === 0) {
			// logSafeError, never error: this line lands in the issue-report buffer.
			this.logger.log(`All servers failed: ${firstFailure.logSafeError}`);
			void this.updateStatusBar({
				state: "error",
				error: firstFailure.error,
				logSafeError: firstFailure.logSafeError,
				serverStatuses,
				totalModels: 0,
				lastChecked: now,
			});
		} else if (failures.length > 0) {
			this.logger.log(`Partial success: ${okCount} ok, ${failures.length} failed, ${totalModels} models`);
			void this.updateStatusBar({
				state: "degraded",
				serverStatuses,
				totalModels,
				lastChecked: now,
			});
		} else if (totalModels === 0) {
			this.logger.log("Warning: All servers returned 0 models");
			void this.updateStatusBar({
				state: "error",
				// Display localizes; the log-safe rendering stays English by policy.
				error: vscode.l10n.t("Servers returned 0 models"),
				logSafeError: markLogSafe("Servers returned 0 models"),
				serverStatuses,
				totalModels: 0,
				lastChecked: now,
			});
		} else {
			this.logger.log(`Successfully fetched ${totalModels} models from ${okCount} server(s)`);
			void this.updateStatusBar({
				state: "connected",
				serverStatuses,
				totalModels,
				lastChecked: now,
			});
		}
	}
}
