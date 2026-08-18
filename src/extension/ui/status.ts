import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { z } from "zod";
import { classifyOverall } from "../../dashboard/presenters";
import { LAST_CONNECTION_STATUS_KEY } from "../../shared/config/storageKeys";
import type { TransportErrorClassification } from "../../shared/errorClassification";
import { SETUP_HINT_KINDS, TRANSPORT_ERROR_KINDS } from "../../shared/errorClassification";
import type { Logger, LogSafeErrorText } from "../../shared/logger";
import { markLogSafe } from "../../shared/logger";
import type { AggregatedStatus, ServerStatus } from "../../shared/servers";
import {
	isErrorServerStatus,
	isHiddenGroupServerStatus,
	unexpectedFailureCount,
	unexpectedServerFailures,
} from "../../shared/servers";

/** Every connection state, the single source for the union type and the persisted-status schema. */
const CONNECTION_STATES = ["not-configured", "connecting", "loading", "connected", "degraded", "error"] as const;

type ConnectionState = (typeof CONNECTION_STATES)[number];

/**
 * The status bar's (and diagnostics') view of the world, one variant per state
 * so each carries exactly the facts its rendering needs. The "connecting"
 * variant's `attention` flag is presentation state, not a state of its own: a
 * single empty window is normal cold-start ordering, but a second consecutive
 * empty report is evidence of persistence, so the presentation degrades to a
 * warning with an actionable tooltip. Any report with servers resets it. It
 * rides inside the variant (not a new state string) so statuses persisted by
 * this version still parse under older versions' state enums.
 */
export type ConnectionStatus =
	| { state: "not-configured"; lastChecked?: string | undefined }
	| { state: "loading"; lastChecked?: string | undefined }
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
			/** Classification only, no message text (see ServerStatusError); absent renders exactly today's UI. */
			classification?: TransportErrorClassification | undefined;
			totalModels?: number | undefined;
			serverStatuses?: readonly ServerStatus[] | undefined;
			lastChecked?: string | undefined;
	  };

// The union and CONNECTION_STATES are the same set, checked both ways at
// compile time: a state in the union but not the list would silently discard
// every persisted status of that state, and a listed state the union lacks
// could never be constructed.
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
 * Whether an error status is the synthetic zero-model verdict rather than a
 * transport failure, so "Connection failed" would misdescribe it. Derived from
 * the carried server statuses, never from the message text, so restored
 * verdicts classify the same as fresh ones; an error that lost its statuses
 * keeps the plain connection-failure rendering.
 */
export function isZeroModelVerdict(status: ConnectionStatus): boolean {
	if (status.state !== "error") {
		return false;
	}
	const serverStatuses = status.serverStatuses ?? [];
	return serverStatuses.length > 0 && unexpectedFailureCount(serverStatuses) === 0;
}

/** What the zero-model judgment renders when it claims the headline; see zeroModelJudgment. */
export interface ZeroModelTexts {
	display: string;
	logSafe: LogSafeErrorText;
	hiddenCount: number;
}

/**
 * The one zero-model judgment, shared by the status bar and every notifier
 * zero-model branch so the toast and the tooltip cannot disagree. It derives
 * its own verdict, so no caller can hand it a stale one: zero models claims
 * the headline only when classifyOverall says "connected" - every server
 * answered (or failed expectedly) yet the catalog is empty, so nothing else
 * explains the situation. Every other verdict already tells its own story -
 * failures, needs-declare, waiting - and a zero-model claim beside it would
 * contradict the surface users are told to check.
 */
export function zeroModelJudgment(
	serverStatuses: readonly ServerStatus[],
	totalModels: number
): ZeroModelTexts | undefined {
	if (totalModels !== 0 || classifyOverall(serverStatuses) !== "connected") {
		return undefined;
	}
	return zeroModelStatusTexts(serverStatuses);
}

/**
 * The zero-model verdict's two renderings, reached only through
 * zeroModelJudgment so no surface can mint its own zero-model prose: a
 * localized display message that names the real cause, and the English log
 * rendering (a classification, never response-derived text) for the
 * issue-report buffer.
 */
function zeroModelStatusTexts(serverStatuses: readonly ServerStatus[]): ZeroModelTexts {
	const hiddenCount = serverStatuses.filter(isHiddenGroupServerStatus).length;
	const answeredCount = serverStatuses.filter(
		(status) => status.state === "ok" && status.hiddenByRemoval !== true
	).length;
	const sentences: string[] = [];
	if (hiddenCount > 0) {
		sentences.push(
			hiddenCount === 1
				? l10n.t(
						"1 server is hidden by an explicit removal and serves no models. Restore it from the dashboard's server list."
					)
				: l10n.t(
						"{0} servers are hidden by an explicit removal and serve no models. Restore them from the dashboard's server list.",
						hiddenCount
					)
		);
		if (answeredCount > 0) {
			sentences.push(l10n.t("The remaining servers answered but listed no models."));
		}
	} else {
		sentences.push(
			answeredCount === 1
				? l10n.t("The server answered but listed no models.")
				: l10n.t("Your servers answered but listed no models.")
		);
	}
	const hiddenDetail =
		hiddenCount > 0
			? `${hiddenCount} hidden by user removal${answeredCount > 0 ? `; ${answeredCount} answered with an empty listing` : ""}`
			: "answered with an empty listing";
	return {
		display: sentences.join(" "),
		logSafe: markLogSafe(`Servers returned 0 models (${hiddenDetail})`),
		hiddenCount,
	};
}

/**
 * A persisted error classification, shared by the per-server element schema
 * and the top-level status schema. Junk drops the smallest thing that contains
 * it: a junk optional field drops that field and keeps the rest, while a junk
 * kind or a non-object drops the whole classification, because a hint is
 * decoration on an error that renders fine without it.
 */
const persistedClassificationSchema = z
	.object({
		kind: z.enum(TRANSPORT_ERROR_KINDS),
		status: z.number().int().optional().catch(undefined),
		setupHint: z.enum(SETUP_HINT_KINDS).optional().catch(undefined),
	})
	.optional()
	.catch(undefined);

/**
 * Dropped fields removed rather than left as explicit undefined keys (the
 * per-field catch writes those), so restored statuses stay structurally
 * identical to freshly constructed ones.
 */
function restoredClassification(
	parsed: NonNullable<z.infer<typeof persistedClassificationSchema>>
): TransportErrorClassification {
	return {
		kind: parsed.kind,
		...(parsed.status !== undefined ? { status: parsed.status } : {}),
		...(parsed.setupHint !== undefined ? { setupHint: parsed.setupHint } : {}),
	};
}

/**
 * One persisted status-window element, over only the fields consumers read.
 * Loose, because older extension versions may have persisted extra fields;
 * discriminated, so an "ok" without a model count or an "error" without its
 * message is malformed rather than half-usable.
 */
const persistedServerStatusSchema = z.discriminatedUnion("state", [
	z.looseObject({
		state: z.literal("ok"),
		label: z.string(),
		baseUrl: z.string(),
		modelCount: z.number(),
		hiddenByRemoval: z.boolean().optional().catch(undefined),
		serverId: z.string().optional().catch(undefined),
		lastChecked: z.string().optional().catch(undefined),
		hasApiKey: z.boolean().optional().catch(undefined),
	}),
	z.looseObject({
		state: z.literal("error"),
		label: z.string(),
		baseUrl: z.string(),
		// A message-less (or empty) error element cannot render honestly, so it
		// is malformed and drops; a junk optional field below only drops that
		// field (the catch), never the whole element.
		error: z.string().min(1),
		logSafeError: z.string().min(1).optional().catch(undefined),
		classification: persistedClassificationSchema,
		expected: z.boolean().optional().catch(undefined),
		declaredModelCount: z.number().int().nonnegative().optional().catch(undefined),
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
		? {
				...common,
				state: "ok",
				modelCount: element.modelCount,
				...(element.hiddenByRemoval !== undefined ? { hiddenByRemoval: element.hiddenByRemoval } : {}),
			}
		: {
				...common,
				state: "error",
				error: element.error,
				// A status persisted before logSafeError existed carries a display
				// message that may embed response text, so the restore fails closed
				// instead of promoting it to the log-safe slot. A present value was
				// written by publicErrorText, so re-branding it is sound.
				logSafeError: element.logSafeError !== undefined ? markLogSafe(element.logSafeError) : RESTORED_ERROR_LOG_TEXT,
				...(element.classification !== undefined
					? { classification: restoredClassification(element.classification) }
					: {}),
				...(element.expected !== undefined ? { expected: element.expected } : {}),
				...(element.declaredModelCount !== undefined ? { declaredModelCount: element.declaredModelCount } : {}),
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
	classification: persistedClassificationSchema,
	lastChecked: z.string().optional(),
});

/**
 * The normalizing parse at the persistence trust boundary: statuses may come
 * from other extension versions, so this rebuilds a status the union can vouch
 * for. Malformed serverStatuses elements are dropped, missing counts default
 * to zero, and two staleness rules apply on restore: a "connecting" that
 * survived a session boundary starts in its needs-attention presentation, and
 * an "error" that lost its message downgrades to that same degraded
 * connecting. Anything else unusable restores as undefined and the caller
 * starts from not-configured.
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
			return { state: "loading", ...lastChecked };
		case "connecting":
			// A restored "connecting" is stale by definition (it survived a whole
			// session boundary without resolving), so it starts degraded.
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
				...(raw.classification !== undefined ? { classification: restoredClassification(raw.classification) } : {}),
				serverStatuses,
				...(raw.totalModels !== undefined ? { totalModels: raw.totalModels } : {}),
				...lastChecked,
			};
	}
}

/** One rendered status-bar presentation: everything a status item shows at once; "plain" clears the background. */
export interface StatusItemView {
	readonly text: string;
	readonly tooltip: string;
	readonly severity: "plain" | "warning" | "error";
}

/** The status-bar surface as the renderers consume it; StatusItem is the real one, tests inject fakes. */
export interface StatusItemLike extends vscode.Disposable {
	readonly command: string | vscode.Command | undefined;
	render(view: StatusItemView): void;
	show(): void;
	hide(): void;
	/**
	 * Fires once when the item is disposed, including by the slot registry's
	 * self-heal, where the OWNER must tear down too, not just the visible half.
	 * Optional so test fakes stay one-liners.
	 */
	onDidDispose?(listener: () => void): void;
}

/**
 * The named slots the extension's real status bar items live in. One host has
 * one status bar, so slot occupancy is a per-host (module-scope) fact: at most
 * ONE live real item may exist per slot, ever. Duplicate identical items have
 * accumulated in shared hosts twice from double constructions; the registry
 * makes that state self-healing and observable instead of possible.
 */
export type StatusItemSlot = "connection" | "usage";

/** The live real item per slot; see StatusItem's constructor and dispose. */
const liveSlotItems = new Map<StatusItemSlot, StatusItem>();

/** Every real creation this host ever made; a test-visible counter for the no-real-items-in-suites guards. */
let realItemCreations = 0;

/** How many real status bar items this host has ever created (test seam; monotonic). */
export function realStatusItemCreationCount(): number {
	return realItemCreations;
}

/** The live real items right now, at most one per slot by construction (test seam). */
export function liveStatusItemSlots(): readonly StatusItemSlot[] {
	return [...liveSlotItems.keys()];
}

/**
 * A thin wrapper over vscode.window.createStatusBarItem shared by the
 * extension's status bar items: alignment, priority, and click command are
 * fixed at construction, and render() maps the severity onto the theme's
 * status bar background colors.
 *
 * THE ONE CREATION POINT: this constructor is the only place in src/ that may
 * call vscode.window.createStatusBarItem (statusItemRegistry.test.ts scans the
 * tree and fails on a second call site). Creating into an occupied slot
 * disposes the previous holder first and reports the replacement through
 * `log`, so the UI self-heals while the lifecycle bug stays visible.
 */
export class StatusItem implements StatusItemLike {
	private readonly item: vscode.StatusBarItem;
	private readonly slot: StatusItemSlot;
	private readonly disposeListeners: (() => void)[] = [];
	private disposed = false;

	constructor(options: {
		readonly slot: StatusItemSlot;
		readonly alignment: vscode.StatusBarAlignment;
		readonly priority: number;
		readonly command: string | vscode.Command;
		/** Classification-only logging (English); reports a replaced slot. */
		readonly log?: (message: string) => void;
	}) {
		const previous = liveSlotItems.get(options.slot);
		if (previous !== undefined) {
			// Self-heal: the slot invariant beats the stale holder. The log line
			// is the evidence a double construction happened at all.
			options.log?.(`status-item slot replaced: ${options.slot}`);
			previous.dispose();
		}
		this.slot = options.slot;
		this.item = vscode.window.createStatusBarItem(options.alignment, options.priority);
		realItemCreations += 1;
		this.item.command = options.command;
		liveSlotItems.set(options.slot, this);
	}

	get command(): string | vscode.Command | undefined {
		return this.item.command;
	}

	onDidDispose(listener: () => void): void {
		// Registering on an already-disposed item fires immediately: an owner
		// handed a pre-disposed surface must still learn to tear down, or it
		// keeps its subscriptions alive forever.
		if (this.disposed) {
			listener();
			return;
		}
		this.disposeListeners.push(listener);
	}

	render(view: StatusItemView): void {
		// A stale holder disposed by the slot self-heal must not write to a
		// disposed vscode item.
		if (this.disposed) {
			return;
		}
		this.item.text = view.text;
		this.item.tooltip = view.tooltip;
		this.item.backgroundColor =
			view.severity === "plain" ? undefined : new vscode.ThemeColor(`statusBarItem.${view.severity}Background`);
	}

	show(): void {
		if (this.disposed) {
			return;
		}
		this.item.show();
	}

	hide(): void {
		if (this.disposed) {
			return;
		}
		this.item.hide();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		// Only the slot's current holder vacates it: a stale holder disposed
		// after its replacement must not evict the live item.
		if (liveSlotItems.get(this.slot) === this) {
			liveSlotItems.delete(this.slot);
		}
		this.item.dispose();
		for (const listener of this.disposeListeners.splice(0)) {
			listener();
		}
	}
}

export class StatusBarManager {
	private _connectionStatus: ConnectionStatus = { state: "not-configured" };
	private readonly _statusBarItem: StatusItemLike;
	/**
	 * The attention verdict of the last connecting status this manager set,
	 * held across a transient "loading" overwrite (the connection test) and
	 * cleared by every other state, so a degraded connecting resumes degraded
	 * after the test instead of resetting to the neutral spinner. Session state
	 * only: never persisted, and a new session starts false.
	 */
	private lastConnectingAttention = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly logger: Logger,
		/**
		 * The shared not-configured gate: an empty status window on a configured
		 * install renders as "connecting", never as "not configured" - the
		 * persisted state feeds the diagnostics snapshot that lands in public
		 * issue reports, so the claim must be honest.
		 */
		private readonly hasConfiguredServers: () => boolean,
		/**
		 * The rendering surface, REQUIRED so no code path can create a real
		 * status bar item by accident: activation passes the real StatusItem
		 * explicitly, and test constructions can only ever inject a recording
		 * seam. (Duplicate real items have twice accumulated in the shared test
		 * host from a defaulted construction.)
		 */
		item: StatusItemLike
	) {
		this._statusBarItem = item;
		context.subscriptions.push(this._statusBarItem);

		const restored = restoreConnectionStatus(context.globalState.get<unknown>(LAST_CONNECTION_STATUS_KEY));
		if (restored !== undefined) {
			this._connectionStatus = restored;
			this.lastConnectingAttention = restored.state === "connecting" && restored.attention;
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
			this.lastConnectingAttention =
				status.state === "connecting"
					? status.attention
					: status.state === "loading"
						? this.lastConnectingAttention
						: false;
			this._connectionStatus = status;
			await this.context.globalState.update(LAST_CONNECTION_STATUS_KEY, status);
		}

		const current = this._connectionStatus;
		switch (current.state) {
			case "not-configured":
				this._statusBarItem.render({
					text: l10n.t("$(warning) LiteLLM"),
					tooltip: l10n.t("Not configured - click to set up"),
					severity: "warning",
				});
				break;
			case "connecting":
				if (current.attention) {
					this._statusBarItem.render({
						text: l10n.t("$(warning) LiteLLM"),
						tooltip: l10n.t(
							"Configured servers have not reported any models\nClick to open the dashboard and check the configuration"
						),
						severity: "warning",
					});
				} else {
					this._statusBarItem.render({
						text: l10n.t("$(loading~spin) LiteLLM"),
						tooltip: l10n.t("Waiting for the configured servers to report..."),
						severity: "plain",
					});
				}
				break;
			case "loading":
				this._statusBarItem.render({
					text: l10n.t("$(loading~spin) LiteLLM"),
					tooltip: l10n.t("Fetching models..."),
					severity: "plain",
				});
				break;
			case "connected": {
				const count = current.totalModels;
				const serverCount = current.serverStatuses.length;
				// The counts live in the tooltip, not the item's text: the bar
				// stays quiet (docs/dashboard.md#the-status-bar-items).
				const available =
					serverCount > 1
						? count === 1
							? l10n.t("1 model available from {0} servers", serverCount)
							: l10n.t("{0} models available from {1} servers", count, serverCount)
						: count === 1
							? l10n.t("1 model available")
							: l10n.t("{0} models available", count);
				this._statusBarItem.render({
					text: l10n.t("$(check) LiteLLM"),
					tooltip: `${available}\n${l10n.t("Click for diagnostics")}`,
					severity: "plain",
				});
				break;
			}
			case "degraded": {
				const count = current.totalModels;
				// Expected failures are not "unreachable" in the verdict's sense; the
				// shared count excludes them (see handleAggregatedStatus).
				const failedCount = unexpectedFailureCount(current.serverStatuses);
				const available = count === 1 ? l10n.t("1 model available") : l10n.t("{0} models available", count);
				const unreachable =
					failedCount === 1 ? l10n.t("1 server unreachable") : l10n.t("{0} servers unreachable", failedCount);
				this._statusBarItem.render({
					text: l10n.t("$(warning) LiteLLM"),
					tooltip: `${available}\n${unreachable}\n${l10n.t("Click for diagnostics")}`,
					severity: "warning",
				});
				break;
			}
			case "error":
				this._statusBarItem.render({
					text: l10n.t("$(error) LiteLLM"),
					// The synthetic zero-model verdict is not a connection failure, so
					// the tooltip's first line must not blame the connection.
					tooltip: isZeroModelVerdict(current)
						? l10n.t("No models available\n{0}\nClick for details", current.error)
						: l10n.t("Connection failed\n{0}\nClick for details", current.error),
					severity: "error",
				});
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
				// connecting variant's attention flag for why that degrades.
				// lastConnectingAttention carries the verdict across the connection
				// test's transient loading overwrite.
				const previous = this._connectionStatus;
				this.logger.log("No server statuses yet; configured servers have not reported");
				void this.updateStatusBar({
					state: "connecting",
					attention: previous.state === "connecting" || this.lastConnectingAttention,
					lastChecked: now,
				});
			} else {
				this.logger.log("No servers configured");
				void this.updateStatusBar({ state: "not-configured", lastChecked: now });
			}
			return;
		}

		// The one verdict pipeline: classifyOverall owns the branch rules (red
		// only when EVERY server failed unexpectedly, degraded on any unexpected
		// failure, needs-declare when everything failed expectedly with nothing
		// declared), shared with the dashboard headline and the notifier, so the
		// surfaces can never disagree on a line users paste into issue reports.
		// This method only maps verdicts onto status-bar states.
		const verdict = classifyOverall(serverStatuses);
		const firstFailure = unexpectedServerFailures(serverStatuses)[0];
		// Declared models serve through ANY discovery failure, so a failed server
		// with declarations still counts as serving in the log lines.
		const failures = serverStatuses.filter(isErrorServerStatus);
		const servingCount =
			serverStatuses.length -
			failures.length +
			failures.filter((failure) => (failure.declaredModelCount ?? 0) > 0).length;

		switch (verdict) {
			case "not-configured":
				// Unreachable: the empty window returned above. Render it honestly.
				void this.updateStatusBar({ state: "not-configured", lastChecked: now });
				return;
			case "error": {
				if (firstFailure === undefined) {
					// Unreachable: a status window carries no misconfigured rows, so
					// the error verdict guarantees an unexpected failure.
					return;
				}
				// logSafeError, never error: this line lands in the issue-report buffer.
				this.logger.log(`All servers failed: ${firstFailure.logSafeError}`);
				void this.updateStatusBar({
					state: "error",
					error: firstFailure.error,
					logSafeError: firstFailure.logSafeError,
					...(firstFailure.classification !== undefined ? { classification: firstFailure.classification } : {}),
					serverStatuses,
					totalModels: 0,
					lastChecked: now,
				});
				return;
			}
			case "degraded":
				this.logger.log(
					`Partial success: ${servingCount} serving, ${unexpectedFailureCount(serverStatuses)} failed, ${totalModels} models`
				);
				void this.updateStatusBar({
					state: "degraded",
					serverStatuses,
					totalModels,
					lastChecked: now,
				});
				return;
			case "needs-declare":
				// Every server failed expectedly with nothing declared: the status
				// bar's rendering of the needs-declare verdict - the actionable
				// warning, never the zero-model red branch.
				this.logger.log("All discovery failures are expected and no models are declared");
				void this.updateStatusBar({ state: "connecting", attention: true, lastChecked: now });
				return;
			case "waiting":
				// Unreachable: a status window has no unchecked rows. The spinner is
				// the honest rendering of a checked-nothing verdict.
				void this.updateStatusBar({ state: "connecting", attention: false, lastChecked: now });
				return;
			case "connected": {
				const zero = zeroModelJudgment(serverStatuses, totalModels);
				if (zero !== undefined) {
					this.logger.log(`Warning: ${zero.logSafe}`);
					void this.updateStatusBar({
						state: "error",
						// Display localizes; the log-safe rendering stays English by policy.
						// No classification: this verdict is synthetic, not a transport failure.
						error: zero.display,
						logSafeError: zero.logSafe,
						serverStatuses,
						totalModels: 0,
						lastChecked: now,
					});
					return;
				}
				this.logger.log(`Successfully fetched ${totalModels} models from ${servingCount} server(s)`);
				void this.updateStatusBar({
					state: "connected",
					serverStatuses,
					totalModels,
					lastChecked: now,
				});
			}
		}
	}
}
