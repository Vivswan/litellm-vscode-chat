import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { z } from "zod";
import { classifyOverall, zeroModelEnglishDetail, zeroModelExplanation } from "../../dashboard/presenters";
import { LAST_CONNECTION_STATUS_KEY } from "../../shared/config/storageKeys";
import type { TransportErrorClassification } from "../../shared/errorClassification";
import { SETUP_HINT_KINDS, TRANSPORT_ERROR_KINDS } from "../../shared/errorClassification";
import type { Logger, LogSafeErrorText } from "../../shared/logger";
import { markLogSafe } from "../../shared/logger";
import type { AggregatedStatus, ServerStatus } from "../../shared/servers";
import { isHiddenGroupServerStatus, unexpectedFailureCount, unexpectedServerFailures } from "../../shared/servers";
import type { DeclaredServerView } from "../servers/serverSync";
import { applySyncFailures } from "../servers/syncFailureOverlay";

/**
 * The status bar's (and diagnostics') view of the world, one variant per state
 * so each carries exactly the facts its rendering needs. The "connecting"
 * variant's `attention` flag is presentation state, not a state of its own: a
 * single empty window is normal cold-start ordering, but a second consecutive
 * empty report is evidence of persistence, so the presentation degrades to a
 * warning with an actionable tooltip. Any report with servers resets it.
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
 * zeroModelJudgment so no surface can mint its own zero-model prose: the
 * shared localized explanation (zeroModelExplanation, which the dashboard's
 * surfaces consume too), and the English log rendering (a classification,
 * never response-derived text) for the issue-report buffer.
 */
function zeroModelStatusTexts(serverStatuses: readonly ServerStatus[]): ZeroModelTexts {
	const hiddenCount = serverStatuses.filter(isHiddenGroupServerStatus).length;
	const answeredCount = serverStatuses.filter(
		(status) => status.state === "ok" && status.hiddenByRemoval !== true
	).length;
	return {
		display: zeroModelExplanation(hiddenCount, answeredCount),
		logSafe: markLogSafe(`Servers returned 0 models (${zeroModelEnglishDetail(hiddenCount, answeredCount)})`),
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
const persistedClassificationFields = z.object({
	kind: z.enum(TRANSPORT_ERROR_KINDS),
	status: z.number().int().optional().catch(undefined),
	setupHint: z.enum(SETUP_HINT_KINDS).optional().catch(undefined),
	unsupportedEndpoint: z.literal("modelListing").optional().catch(undefined),
});

const persistedClassificationSchema = persistedClassificationFields.optional().catch(undefined);

/**
 * The exhaustive-reconstruction guard for the restore path: the `-?` mapping
 * makes EVERY key of the target type required at the compile level, so a
 * field the live type or the schema gains cannot be silently omitted from a
 * restore - the rebuild literal stops compiling until it names the field.
 * Only keys the target type itself allows to be undefined (its optionals) may
 * be supplied as undefined; a required key demands a real value, so no call
 * site can compile its way into dropping one. Undefined-valued keys are then
 * stripped so restored statuses stay structurally identical to freshly
 * constructed ones (which build their optionals by conditional spread).
 */
function restoreTotal<T extends object>(
	total: {
		[K in keyof T]-?: undefined extends T[K] ? T[K] | undefined : T[K];
	}
): T {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(total)) {
		if (value !== undefined) {
			cleaned[key] = value;
		}
	}
	// Sound because `total` carried every key of T, required keys could not be
	// undefined, and only undefined-valued keys (absent optionals) were dropped.
	return cleaned as T;
}

/** A restored classification, total over TransportErrorClassification by construction (restoreTotal). */
function restoredClassification(
	parsed: NonNullable<z.infer<typeof persistedClassificationSchema>>
): TransportErrorClassification {
	return restoreTotal<TransportErrorClassification>({
		kind: parsed.kind,
		status: parsed.status,
		setupHint: parsed.setupHint,
		unsupportedEndpoint: parsed.unsupportedEndpoint,
	});
}

/**
 * One persisted status-window element, the current ServerStatus shape field
 * for field (the key census below fails closed on drift). Loose, so an extra
 * field never poisons an element; discriminated, so an "ok" without its
 * served count or an "error" without its two message slots is malformed
 * rather than half-usable.
 */
const persistedOkElementSchema = z.looseObject({
	state: z.literal("ok"),
	label: z.string(),
	baseUrl: z.string(),
	// An ok element without its served count cannot render honestly, so the
	// count is required: junk in it drops the whole element, while junk in an
	// optional field below only drops that field (the catch).
	servedModelCount: z.number().int().nonnegative(),
	hiddenByRemoval: z.boolean().optional().catch(undefined),
	modelInfoUnsupported: z.enum(["timeout", "status"]).optional().catch(undefined),
	serverId: z.string().optional().catch(undefined),
	lastChecked: z.string().optional().catch(undefined),
	hasApiKey: z.boolean().optional().catch(undefined),
	hasOAuth: z.boolean().optional().catch(undefined),
});

const persistedErrorElementSchema = z.looseObject({
	state: z.literal("error"),
	label: z.string(),
	baseUrl: z.string(),
	// A message-less (or empty) error element cannot render honestly, and the
	// log rendering may never be rebuilt from display text, so both message
	// slots and the served count are required; junk in any of them drops the
	// whole element, junk in an optional field only drops that field.
	error: z.string().min(1),
	logSafeError: z.string().min(1),
	classification: persistedClassificationSchema,
	expected: z.boolean().optional().catch(undefined),
	servedModelCount: z.number().int().nonnegative(),
	declaredModelCount: z.number().int().nonnegative().optional().catch(undefined),
	serverId: z.string().optional().catch(undefined),
	lastChecked: z.string().optional().catch(undefined),
	hasApiKey: z.boolean().optional().catch(undefined),
	hasOAuth: z.boolean().optional().catch(undefined),
});

const persistedServerStatusSchema = z.discriminatedUnion("state", [
	persistedOkElementSchema,
	persistedErrorElementSchema,
]);

// Fail-closed key census, checked both ways at compile time: every field of
// the live ServerStatus variants and of TransportErrorClassification has a
// schema field, and the schemas carry no key the types lack, so a new or
// renamed field fails here until the schema (and restoreServerStatus) learn
// it instead of being silently dropped on restore. The ok variant's
// `error?: undefined` never-marker exists only to discriminate the union and
// is the one exclusion.
const _persistedShapesMatchLiveTypes: [
	Exclude<keyof Extract<ServerStatus, { state: "ok" }>, keyof typeof persistedOkElementSchema.shape | "error">,
	Exclude<keyof typeof persistedOkElementSchema.shape, keyof Extract<ServerStatus, { state: "ok" }>>,
	Exclude<keyof Extract<ServerStatus, { state: "error" }>, keyof typeof persistedErrorElementSchema.shape>,
	Exclude<keyof typeof persistedErrorElementSchema.shape, keyof Extract<ServerStatus, { state: "error" }>>,
	Exclude<keyof TransportErrorClassification, keyof typeof persistedClassificationFields.shape>,
	Exclude<keyof typeof persistedClassificationFields.shape, keyof TransportErrorClassification>,
] extends [never, never, never, never, never, never]
	? true
	: never = true;

/**
 * A persisted element as a real ServerStatus, or undefined for junk the parse
 * drops. Both rebuild literals go through restoreTotal, so every field the
 * live variants carry must be named here - the schema census guards the
 * parse side, this guards the reconstruction side.
 */
function restoreServerStatus(value: unknown): ServerStatus | undefined {
	const parsed = persistedServerStatusSchema.safeParse(value);
	if (!parsed.success) {
		return undefined;
	}
	const element = parsed.data;
	if (element.state === "ok") {
		return restoreTotal<Extract<ServerStatus, { state: "ok" }>>({
			state: "ok",
			serverId: element.serverId ?? "",
			label: element.label,
			baseUrl: element.baseUrl,
			lastChecked: element.lastChecked ?? "",
			servedModelCount: element.servedModelCount,
			hasApiKey: element.hasApiKey,
			hasOAuth: element.hasOAuth,
			hiddenByRemoval: element.hiddenByRemoval,
			modelInfoUnsupported: element.modelInfoUnsupported,
			// The union's discriminating never-marker; never a value.
			error: undefined,
		});
	}
	return restoreTotal<Extract<ServerStatus, { state: "error" }>>({
		state: "error",
		serverId: element.serverId ?? "",
		label: element.label,
		baseUrl: element.baseUrl,
		lastChecked: element.lastChecked ?? "",
		servedModelCount: element.servedModelCount,
		hasApiKey: element.hasApiKey,
		hasOAuth: element.hasOAuth,
		error: element.error,
		// Written by publicErrorText last session, so re-branding it is sound.
		logSafeError: markLogSafe(element.logSafeError),
		classification: element.classification !== undefined ? restoredClassification(element.classification) : undefined,
		expected: element.expected,
		declaredModelCount: element.declaredModelCount,
	});
}

/**
 * The persisted blob's shape version, stamped on every write. The restore
 * accepts exactly this version: any other stamp - including the absent stamp
 * of every earlier extension version - restores as undefined, and the bar
 * starts from not-configured (or connecting, once servers are seen) until the
 * first provider report rewrites the blob, seconds after activation. The blob
 * is an ephemeral display cache, so that reset IS the migration: bump this
 * whenever the persisted shape changes, and the change is detected instead of
 * tolerated by lenient dual readings.
 */
const PERSISTED_STATUS_VERSION = 1;

const persistedStatusSchema = z.discriminatedUnion("state", [
	z.looseObject({ state: z.literal("not-configured"), lastChecked: z.string().optional() }),
	z.looseObject({ state: z.literal("loading"), lastChecked: z.string().optional() }),
	z.looseObject({ state: z.literal("connecting"), lastChecked: z.string().optional() }),
	z.looseObject({
		state: z.enum(["connected", "degraded"]),
		totalModels: z.number(),
		serverStatuses: z.array(z.unknown()),
		lastChecked: z.string().optional(),
	}),
	z.looseObject({
		state: z.literal("error"),
		// An empty message (or an empty log rendering) cannot render honestly,
		// so it is not the current shape and fails the whole restore.
		error: z.string().min(1),
		logSafeError: z.string().min(1),
		classification: persistedClassificationSchema,
		totalModels: z.number().optional(),
		serverStatuses: z.array(z.unknown()).optional(),
		lastChecked: z.string().optional(),
	}),
]);

// The persisted schema and the ConnectionStatus union cover the same states,
// checked both ways at compile time: a union state the schema lacks could
// never survive a session boundary, and a schema state the union lacks could
// never be constructed.
const _persistedStatesMatchUnion: [
	Exclude<ConnectionStatus["state"], z.infer<typeof persistedStatusSchema>["state"]>,
	Exclude<z.infer<typeof persistedStatusSchema>["state"], ConnectionStatus["state"]>,
] extends [never, never]
	? true
	: never = true;

/** The version-stamped envelope every write persists; the restore accepts nothing else. */
const persistedEnvelopeSchema = z.looseObject({
	v: z.literal(PERSISTED_STATUS_VERSION),
	status: persistedStatusSchema,
});

/**
 * The parse at the persistence trust boundary. The blob is an ephemeral
 * display cache, so the restore is strict: only the current version-stamped
 * shape parses, and anything else - an earlier version's blob, a foreign
 * stamp, junk - restores as undefined and the caller starts from
 * not-configured until the first provider report. Within a current-shape
 * blob, junk still drops the smallest thing that contains it: a malformed
 * serverStatuses element drops, a junk optional field drops that field. One
 * staleness rule applies on restore: a "connecting" that survived a whole
 * session boundary starts in its needs-attention presentation.
 */
function restoreConnectionStatus(value: unknown): ConnectionStatus | undefined {
	const parsed = persistedEnvelopeSchema.safeParse(value);
	if (!parsed.success) {
		return undefined;
	}
	const raw = parsed.data.status;
	// Every branch rebuilds through restoreTotal, so a field a variant gains
	// cannot be silently dropped on restore.
	switch (raw.state) {
		case "not-configured":
			return restoreTotal<Extract<ConnectionStatus, { state: "not-configured" }>>({
				state: "not-configured",
				lastChecked: raw.lastChecked,
			});
		case "loading":
			return restoreTotal<Extract<ConnectionStatus, { state: "loading" }>>({
				state: "loading",
				lastChecked: raw.lastChecked,
			});
		case "connecting":
			// A restored "connecting" is stale by definition (it survived a whole
			// session boundary without resolving), so it starts degraded.
			return restoreTotal<Extract<ConnectionStatus, { state: "connecting" }>>({
				state: "connecting",
				attention: true,
				lastChecked: raw.lastChecked,
			});
		case "connected":
		case "degraded":
			return restoreTotal<Extract<ConnectionStatus, { state: "connected" | "degraded" }>>({
				state: raw.state,
				totalModels: raw.totalModels,
				serverStatuses: restoreServerStatuses(raw.serverStatuses),
				lastChecked: raw.lastChecked,
			});
		case "error":
			return restoreTotal<Extract<ConnectionStatus, { state: "error" }>>({
				state: "error",
				error: raw.error,
				// Written by publicErrorText last session, so re-branding it is sound.
				logSafeError: markLogSafe(raw.logSafeError),
				classification: raw.classification !== undefined ? restoredClassification(raw.classification) : undefined,
				serverStatuses: restoreServerStatuses(raw.serverStatuses ?? []),
				totalModels: raw.totalModels,
				lastChecked: raw.lastChecked,
			});
	}
}

/** The persisted window's elements as real ServerStatus values, junk elements dropped. */
function restoreServerStatuses(elements: readonly unknown[]): ServerStatus[] {
	return elements.flatMap((element) => {
		const restored = restoreServerStatus(element);
		return restored === undefined ? [] : [restored];
	});
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
	/**
	 * The last provider report, pre-overlay, so refreshFromSync can re-render
	 * with fresh declared views: sync outcomes change the overlay without any
	 * provider report. Session state; the empty report stands in before the
	 * first callback, exactly what the groupless cold-start refresh sends.
	 */
	private lastAggregated: AggregatedStatus | undefined;
	/**
	 * The overlaid window last judged, for refreshFromSync's no-change skip.
	 * A JSON rendering is deterministic here: both sides serialize the same
	 * base status objects through the same overlay construction, so equal
	 * worlds stringify equal.
	 */
	private lastJudgedOverlay: string | undefined;
	/**
	 * True while the status is still the constructor's restore-less connecting
	 * seed (a configured install whose blob failed the versioned restore). The
	 * seed is presentation, not evidence: the empty-report escalation must not
	 * count it as an already-reported empty window, or the first real empty
	 * report after a version bump would render the warning. Cleared by the
	 * first status write; session state only.
	 */
	private seededConnecting = false;

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
		 * The declared entries as of the last sync pass, for the sync-failure
		 * overlay: sync failures never enter the provider's status window, so the
		 * bar reads them from here (applySyncFailures).
		 */
		private readonly getDeclared: () => readonly DeclaredServerView[],
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
		} else if (this.hasConfiguredServers()) {
			// The shared not-configured gate applies to the restore-less start too:
			// after a version bump resets the blob, a configured install must
			// render "connecting" until the first report, never claim "not
			// configured" in the bar, the setup gate, or a diagnostics snapshot.
			this._connectionStatus = { state: "connecting", attention: false };
			this.seededConnecting = true;
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
			// Any real status write retires the constructor's connecting seed.
			this.seededConnecting = false;
			this.lastConnectingAttention =
				status.state === "connecting"
					? status.attention
					: status.state === "loading"
						? this.lastConnectingAttention
						: false;
			this._connectionStatus = status;
			await this.context.globalState.update(LAST_CONNECTION_STATUS_KEY, { v: PERSISTED_STATUS_VERSION, status });
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
				// The shared zero-model judgment: connected-with-nothing-to-serve is
				// ONE consistently rendered warning (bar, hero, notifier, Test
				// Connection all warning-grade), never a red connection failure.
				const zero = zeroModelJudgment(current.serverStatuses, current.totalModels);
				if (zero !== undefined) {
					this._statusBarItem.render({
						text: l10n.t("$(warning) LiteLLM"),
						tooltip: l10n.t("No models available\n{0}\nClick for details", zero.display),
						severity: "warning",
					});
					break;
				}
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
				// "failing", not "unreachable": the count also holds reachable servers
				// whose provider-group sync failed (applySyncFailures), and a failing
				// server may still serve stale or declared models. Expected failures stay out.
				const failedCount = unexpectedFailureCount(current.serverStatuses);
				const available = count === 1 ? l10n.t("1 model available") : l10n.t("{0} models available", count);
				const failing = failedCount === 1 ? l10n.t("1 server failing") : l10n.t("{0} servers failing", failedCount);
				this._statusBarItem.render({
					text: l10n.t("$(warning) LiteLLM"),
					tooltip: `${available}\n${failing}\n${l10n.t("Click for diagnostics")}`,
					severity: "warning",
				});
				break;
			}
			case "error":
				this._statusBarItem.render({
					text: l10n.t("$(error) LiteLLM"),
					tooltip: l10n.t("Connection failed\n{0}\nClick for details", current.error),
					severity: "error",
				});
				break;
		}
		this._statusBarItem.show();
	}

	handleAggregatedStatus(aggStatus: AggregatedStatus): void {
		this.lastAggregated = aggStatus;
		const now = new Date().toISOString();
		// Sync failures never enter the provider's status window (a failed upsert
		// has no group to report, and a blocked group keeps reporting its old
		// configuration as healthy), so the bar judges the overlaid window - the
		// same precedence the dashboard rows render.
		const serverStatuses = applySyncFailures(aggStatus.serverStatuses, this.getDeclared());
		this.lastJudgedOverlay = JSON.stringify(serverStatuses);
		const { totalModels } = aggStatus;

		if (serverStatuses.length === 0) {
			// The empty window is only a not-configured verdict when nothing else
			// proves servers exist; at cold start the groupless refresh reports
			// empty before the per-group refreshes arrive.
			if (this.hasConfiguredServers()) {
				// Already connecting = a second consecutive empty report; see the
				// connecting variant's attention flag for why that degrades. The
				// constructor's restore-less seed is excluded explicitly: it is
				// presentation, not a reported empty window (seededConnecting).
				// lastConnectingAttention carries the verdict across the connection
				// test's transient loading overwrite.
				const previous = this._connectionStatus;
				this.logger.log("No server statuses yet; configured servers have not reported");
				void this.updateStatusBar({
					state: "connecting",
					attention: (previous.state === "connecting" && !this.seededConnecting) || this.lastConnectingAttention,
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
		// Serving means serving on ANY state: a failed server still serving its
		// stale-window or declared models counts in the log lines.
		const servingCount = serverStatuses.filter((status) => status.state === "ok" || status.servedModelCount > 0).length;

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
				// The error verdict now proves nothing serves (a serving failure reads
				// degraded), so the zero count is derived, not assumed.
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
					// The state stays the honest "connected": the servers answered and
					// nothing failed. The connected renderer derives the same judgment
					// and presents it as a warning, never a connection failure.
					this.logger.log(`Warning: ${zero.logSafe}`);
				} else {
					this.logger.log(`Successfully fetched ${totalModels} models from ${servingCount} server(s)`);
				}
				void this.updateStatusBar({
					state: "connected",
					serverStatuses,
					totalModels,
					lastChecked: now,
				});
			}
		}
	}

	/**
	 * Re-judge the last provider report after a sync pass: a sync-only change
	 * (an upsert failing, a blocked entry clearing) moves the overlay without
	 * any provider report firing the status callback. Judged only when the
	 * overlaid window actually changed: replaying an unchanged report must not
	 * escalate the connecting spinner (a second FRESH empty report is the
	 * evidence of persistence, a sync pass is not) or duplicate log lines.
	 * Before any report, only a non-empty overlay says something a restored
	 * status does not.
	 */
	refreshFromSync(): void {
		const base = this.lastAggregated ?? { serverStatuses: [], totalModels: 0, silent: true };
		const overlaid = applySyncFailures(base.serverStatuses, this.getDeclared());
		if (this.lastAggregated === undefined && overlaid.length === 0) {
			return;
		}
		if (JSON.stringify(overlaid) === this.lastJudgedOverlay) {
			return;
		}
		this.handleAggregatedStatus(base);
	}
}
