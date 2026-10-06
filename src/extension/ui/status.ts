import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { z } from "zod";
import { classifyOverall, zeroModelEnglishDetail, zeroModelExplanation } from "../../dashboard/presenters";
import type { VerdictRow } from "../../dashboard/viewModels";
import { LAST_CONNECTION_STATUS_KEY } from "../../shared/config/storageKeys";
import type { TransportErrorClassification, UnservedEndpointEvidence } from "../../shared/errorClassification";
import { SETUP_HINT_KINDS, TRANSPORT_ERROR_KINDS } from "../../shared/errorClassification";
import type { FailureCause } from "../../shared/failureCause";
import {
	CREDENTIALS_UNAVAILABLE_REASONS,
	failureTexts,
	MISCONFIGURED_ENTRY_TEXT,
	SYNC_ERROR_CLASSES,
} from "../../shared/failureCause";
import { Logger, type LogSafeErrorText, markLogSafe } from "../../shared/logger";
import { HEADER_BORNE_SECRET_FIELDS } from "../../shared/serverEntry";
import type { AggregatedStatus, ServerStatus } from "../../shared/servers";
import { unexpectedFailureCount, unexpectedServerFailures } from "../../shared/servers";
import type { ServerVerdict } from "../servers/syncFailureOverlay";
import { applySyncFailures } from "../servers/syncFailureOverlay";

/**
 * The "connecting" variant's `attention` flag is presentation state, not a state of its own: a single empty window is
 * normal cold-start ordering, but a second consecutive empty report is evidence of persistence, so the presentation
 * degrades to a warning with an actionable tooltip.
 */
export type ConnectionStatus =
	| { state: "not-configured"; lastChecked?: string | undefined }
	| { state: "loading"; lastChecked?: string | undefined }
	| { state: "connecting"; attention: boolean; lastChecked?: string | undefined }
	| {
			state: "connected" | "degraded";
			totalModels: number;
			serverStatuses: readonly ServerStatus[];
			/**
			 * The zero-model judgment made once over the owner's verdict rows when this connected status was judged;
			 * the renderer and the command toasts present it, never re-deriving it. A degraded status never carries one.
			 */
			zeroModel?: ZeroModelJudgment | undefined;
			lastChecked?: string | undefined;
	  }
	| {
			state: "error";
			/**
			 * The headline's key (shared/failureCause.ts): the first unexpected failure's cause, or misconfiguredEntry
			 * when every entry the parser refused and nothing reports. Rendered at display time, never stored as text.
			 */
			cause: FailureCause;
			/** The failing server's URL, where the cause's text names it. */
			baseUrl?: string | undefined;
			logSafeError: LogSafeErrorText;
			totalModels?: number | undefined;
			serverStatuses?: readonly ServerStatus[] | undefined;
			lastChecked?: string | undefined;
	  };

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

/** The zero-model verdict as a key: the two counts its text names, rendered at display time (zeroModelTexts). */
export interface ZeroModelJudgment {
	readonly hiddenCount: number;
	readonly answeredCount: number;
}

/**
 * The one zero-model judgment over the owner's published verdict rows (ServerVerdict.rows), shared by the status bar
 * and the notifier so the toast and the tooltip cannot disagree; the bar carries the result on its connected status
 * for the renderer and the command toasts.
 *
 *   Every other verdict already tells its own story - failures, needs-declare, waiting -> a zero-model claim beside
 *       it would contradict the surface users are told to check
 */
export function zeroModelJudgment(rows: readonly VerdictRow[], totalModels: number): ZeroModelJudgment | undefined {
	if (totalModels !== 0 || classifyOverall(rows) !== "connected") {
		return undefined;
	}
	return zeroModelCounts(rows);
}

function zeroModelCounts(rows: readonly VerdictRow[]): ZeroModelJudgment {
	return {
		hiddenCount: rows.filter((row) => row.hiddenByRemoval === true).length,
		answeredCount: rows.filter((row) => row.state === "ok" && row.hiddenByRemoval !== true).length,
	};
}

/**
 * The zero-model verdict's two renderings, reached only through the judgment so no surface can mint its own zero-model
 * prose: the shared localized explanation (zeroModelExplanation, which the dashboard's surfaces consume too), in the
 * current locale at display time, and the English log rendering (a classification, never response-derived text) for
 * the issue-report buffer.
 */
export function zeroModelTexts(zero: ZeroModelJudgment): {
	readonly display: string;
	readonly logSafe: LogSafeErrorText;
} {
	return {
		display: zeroModelExplanation(zero.hiddenCount, zero.answeredCount),
		logSafe: markLogSafe(`Servers returned 0 models (${zeroModelEnglishDetail(zero.hiddenCount, zero.answeredCount)})`),
	};
}

/**
 * The persisted status store: the live shapes field for field, with a failing status's cause as the key the restore
 * renders from (shared/failureCause.ts). The persisted types have no field for rendered text, so a status cannot
 * spread display text into the store, and the writer below names every live field through restoreTotal's total
 * mapping.
 */
interface PersistedOkElement {
	readonly state: "ok";
	readonly label: string;
	readonly baseUrl: string;
	readonly servedModelCount: number;
	readonly hiddenByRemoval?: boolean | undefined;
	readonly modelInfoUnsupported?: UnservedEndpointEvidence | undefined;
	readonly serverId?: string | undefined;
	readonly entryLabel?: string | undefined;
	readonly lastChecked?: string | undefined;
	readonly hasApiKey?: boolean | undefined;
	readonly hasOAuth?: boolean | undefined;
	readonly hasVirtualKey?: boolean | undefined;
}

interface PersistedErrorElement {
	readonly state: "error";
	readonly label: string;
	readonly baseUrl: string;
	readonly servedModelCount: number;
	readonly logSafeError: string;
	readonly cause: FailureCause;
	readonly expected?: boolean | undefined;
	readonly declaredModelCount?: number | undefined;
	readonly serverId?: string | undefined;
	readonly entryLabel?: string | undefined;
	readonly lastChecked?: string | undefined;
	readonly hasApiKey?: boolean | undefined;
	readonly hasOAuth?: boolean | undefined;
	readonly hasVirtualKey?: boolean | undefined;
}

type PersistedElement = PersistedOkElement | PersistedErrorElement;

type PersistedStatus =
	| { readonly state: "not-configured"; readonly lastChecked?: string | undefined }
	| { readonly state: "loading"; readonly lastChecked?: string | undefined }
	| { readonly state: "connecting"; readonly lastChecked?: string | undefined }
	| {
			readonly state: "connected" | "degraded";
			readonly totalModels: number;
			readonly serverStatuses: readonly PersistedElement[];
			readonly zeroModel?: true | undefined;
			readonly lastChecked?: string | undefined;
	  }
	| {
			readonly state: "error";
			readonly cause: FailureCause;
			readonly baseUrl?: string | undefined;
			readonly logSafeError: string;
			readonly serverStatuses: readonly PersistedElement[];
			readonly totalModels?: number | undefined;
			readonly lastChecked?: string | undefined;
	  };

function persistedElement(element: ServerStatus): PersistedElement {
	if (element.state === "ok") {
		return restoreTotal<PersistedOkElement>({
			state: "ok",
			label: element.label,
			baseUrl: element.baseUrl,
			servedModelCount: element.servedModelCount,
			hiddenByRemoval: element.hiddenByRemoval,
			modelInfoUnsupported: element.modelInfoUnsupported,
			serverId: element.serverId,
			entryLabel: element.entryLabel,
			lastChecked: element.lastChecked,
			hasApiKey: element.hasApiKey,
			hasOAuth: element.hasOAuth,
			hasVirtualKey: element.hasVirtualKey,
		});
	}
	return restoreTotal<PersistedErrorElement>({
		state: "error",
		label: element.label,
		baseUrl: element.baseUrl,
		servedModelCount: element.servedModelCount,
		logSafeError: element.logSafeError,
		cause: element.cause,
		expected: element.expected,
		declaredModelCount: element.declaredModelCount,
		serverId: element.serverId,
		entryLabel: element.entryLabel,
		lastChecked: element.lastChecked,
		hasApiKey: element.hasApiKey,
		hasOAuth: element.hasOAuth,
		hasVirtualKey: element.hasVirtualKey,
	});
}

function persistedStatus(status: ConnectionStatus): PersistedStatus {
	switch (status.state) {
		case "not-configured":
		case "loading":
		case "connecting":
			return restoreTotal<Extract<PersistedStatus, { state: typeof status.state }>>({
				state: status.state,
				lastChecked: status.lastChecked,
			});
		case "connected":
		case "degraded":
			return restoreTotal<Extract<PersistedStatus, { state: "connected" | "degraded" }>>({
				state: status.state,
				totalModels: status.totalModels,
				serverStatuses: status.serverStatuses.map(persistedElement),
				zeroModel: status.zeroModel !== undefined ? true : undefined,
				lastChecked: status.lastChecked,
			});
		case "error":
			return restoreTotal<Extract<PersistedStatus, { state: "error" }>>({
				state: "error",
				cause: status.cause,
				baseUrl: status.baseUrl,
				logSafeError: status.logSafeError,
				serverStatuses: (status.serverStatuses ?? []).map(persistedElement),
				totalModels: status.totalModels,
				lastChecked: status.lastChecked,
			});
	}
}

/**
 * Junk drops the smallest thing that contains it: a junk optional field drops that field and keeps the rest, while a
 * junk kind or a non-object drops the whole classification, because a hint is decoration on an error that renders fine
 * without it.
 */
const persistedClassificationFields = z.object({
	kind: z.enum(TRANSPORT_ERROR_KINDS),
	status: z.number().int().optional().catch(undefined),
	setupHint: z.enum(SETUP_HINT_KINDS).optional().catch(undefined),
	unsupportedEndpoint: z.literal("modelListing").optional().catch(undefined),
});

const persistedClassificationSchema = persistedClassificationFields.optional().catch(undefined);

/**
 * A field the live type gains cannot be silently omitted from a restore; the `-?` mapping makes the rebuild
 * literal stop compiling until it names the field. Undefined-valued keys are stripped so restored statuses stay
 * structurally identical to fresh ones, which build their optionals by conditional spread.
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
	// Sound because `total` carried every key of T, required keys could not be undefined, and only undefined-valued
	// keys (absent optionals) were dropped.
	return cleaned as T;
}

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
 * One persisted status-window element, the current ServerStatus shape field for field (the key census below fails
 * closed on drift). Loose, so an extra field never poisons an element; discriminated, so an "ok" without its served
 * count or an "error" without its cause and log rendering is malformed rather than half-usable.
 */
const persistedOkElementSchema = z.looseObject({
	state: z.literal("ok"),
	label: z.string(),
	baseUrl: z.string(),
	// An ok element without its served count cannot render honestly, so the count is required: junk in it drops the
	// whole element, while junk in an optional field below only drops that field (the catch).
	servedModelCount: z.number().int().nonnegative(),
	hiddenByRemoval: z.boolean().optional().catch(undefined),
	modelInfoUnsupported: z.enum(["timeout", "status"]).optional().catch(undefined),
	serverId: z.string().optional().catch(undefined),
	entryLabel: z.string().optional().catch(undefined),
	lastChecked: z.string().optional().catch(undefined),
	hasApiKey: z.boolean().optional().catch(undefined),
	hasOAuth: z.boolean().optional().catch(undefined),
	hasVirtualKey: z.boolean().optional().catch(undefined),
});

/** The cause as written: a junk arm is not the current shape, so its element (or status) drops rather than guess. */
const persistedCauseSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("transport"), classification: persistedClassificationFields }),
	z.object({ kind: z.literal("sync"), failureClass: z.enum(SYNC_ERROR_CLASSES) }),
	z.object({ kind: z.literal("credentials"), reason: z.enum(CREDENTIALS_UNAVAILABLE_REASONS) }),
	z.object({ kind: z.literal("credentialsRefused"), fields: z.array(z.enum(HEADER_BORNE_SECRET_FIELDS)).min(1) }),
	z.object({ kind: z.literal("misconfiguredEntry") }),
	z.object({ kind: z.literal("unclassified") }),
]);

function restoredCause(parsed: z.infer<typeof persistedCauseSchema>): FailureCause {
	switch (parsed.kind) {
		case "transport":
			return { kind: "transport", classification: restoredClassification(parsed.classification) };
		case "credentialsRefused": {
			const [first, ...rest] = parsed.fields;
			// The schema's min(1) guarantees the head; the tuple type cannot read that off an array.
			return first === undefined ? { kind: "unclassified" } : { kind: "credentialsRefused", fields: [first, ...rest] };
		}
		case "sync":
		case "credentials":
		case "misconfiguredEntry":
		case "unclassified":
			return parsed;
	}
}

const persistedErrorElementSchema = z.looseObject({
	state: z.literal("error"),
	label: z.string(),
	baseUrl: z.string(),
	// The cause is the key every surface renders from; the log rendering may never be rebuilt from display text. Both
	// and the served count are required: junk in any of them drops the whole element, junk in an optional field only
	// drops that field.
	cause: persistedCauseSchema,
	logSafeError: z.string().min(1),
	expected: z.boolean().optional().catch(undefined),
	servedModelCount: z.number().int().nonnegative(),
	declaredModelCount: z.number().int().nonnegative().optional().catch(undefined),
	serverId: z.string().optional().catch(undefined),
	entryLabel: z.string().optional().catch(undefined),
	lastChecked: z.string().optional().catch(undefined),
	hasApiKey: z.boolean().optional().catch(undefined),
	hasOAuth: z.boolean().optional().catch(undefined),
	hasVirtualKey: z.boolean().optional().catch(undefined),
});

const persistedServerStatusSchema = z.discriminatedUnion("state", [
	persistedOkElementSchema,
	persistedErrorElementSchema,
]);

// Fail-closed key census, checked both ways at compile time: every field of the persisted element types (what the
// writer produces) has a schema field, every cause kind has a schema arm, and the schemas carry nothing the types
// lack, so a new or renamed field or cause fails here until the schema (and the restore) learn it. The live fields are
// covered on the other side: the writer and the restore both go through restoreTotal, which names every field of its
// target.
const _persistedShapesMatchSchemas: [
	Exclude<keyof PersistedOkElement, keyof typeof persistedOkElementSchema.shape>,
	Exclude<keyof typeof persistedOkElementSchema.shape, keyof PersistedOkElement>,
	Exclude<keyof PersistedErrorElement, keyof typeof persistedErrorElementSchema.shape>,
	Exclude<keyof typeof persistedErrorElementSchema.shape, keyof PersistedErrorElement>,
	Exclude<FailureCause["kind"], z.infer<typeof persistedCauseSchema>["kind"]>,
	Exclude<z.infer<typeof persistedCauseSchema>["kind"], FailureCause["kind"]>,
	Exclude<keyof TransportErrorClassification, keyof typeof persistedClassificationFields.shape>,
	Exclude<keyof typeof persistedClassificationFields.shape, keyof TransportErrorClassification>,
] extends [never, never, never, never, never, never, never, never]
	? true
	: never = true;

/**
 * Both rebuild literals go through restoreTotal, so every field the live variants carry must be named here - the schema
 * census guards the parse side, this guards the reconstruction side.
 */
function restoreServerStatus(value: unknown): ServerStatus | undefined {
	const parsed = persistedServerStatusSchema.safeParse(value);
	if (!parsed.success) {
		return undefined;
	}
	const element = parsed.data;
	if (element.state === "error") {
		return restoreTotal<Extract<ServerStatus, { state: "error" }>>({
			state: "error",
			serverId: element.serverId ?? "",
			label: element.label,
			entryLabel: element.entryLabel,
			baseUrl: element.baseUrl,
			lastChecked: element.lastChecked ?? "",
			servedModelCount: element.servedModelCount,
			hasApiKey: element.hasApiKey,
			hasOAuth: element.hasOAuth,
			hasVirtualKey: element.hasVirtualKey,
			cause: restoredCause(element.cause),
			// Written by publicErrorText last session, so re-branding it is sound.
			logSafeError: markLogSafe(element.logSafeError),
			expected: element.expected,
			declaredModelCount: element.declaredModelCount,
		});
	}
	return restoreTotal<Extract<ServerStatus, { state: "ok" }>>({
		state: "ok",
		serverId: element.serverId ?? "",
		label: element.label,
		entryLabel: element.entryLabel,
		baseUrl: element.baseUrl,
		lastChecked: element.lastChecked ?? "",
		servedModelCount: element.servedModelCount,
		hasApiKey: element.hasApiKey,
		hasOAuth: element.hasOAuth,
		hasVirtualKey: element.hasVirtualKey,
		hiddenByRemoval: element.hiddenByRemoval,
		modelInfoUnsupported: element.modelInfoUnsupported,
		// The union's discriminating never-marker; never a value.
		error: undefined,
	});
}

/**
 * The blob is an ephemeral display cache, so that reset IS the migration: bump this whenever the persisted shape
 * changes, and the change is detected instead of tolerated by lenient dual readings.
 *
 *   The restore accepts exactly this version: any other stamp -> restores as undefined, and the bar starts from
 *       not-configured (or connecting, once servers are seen) until the first provider report rewrites the blob,
 *       seconds after activation
 */
const PERSISTED_STATUS_VERSION = 7;

const persistedStatusSchema = z.discriminatedUnion("state", [
	z.looseObject({ state: z.literal("not-configured"), lastChecked: z.string().optional() }),
	z.looseObject({ state: z.literal("loading"), lastChecked: z.string().optional() }),
	z.looseObject({ state: z.literal("connecting"), lastChecked: z.string().optional() }),
	z.looseObject({
		state: z.enum(["connected", "degraded"]),
		totalModels: z.number(),
		serverStatuses: z.array(z.unknown()),
		zeroModel: z.literal(true).optional().catch(undefined),
		lastChecked: z.string().optional(),
	}),
	z.looseObject({
		state: z.literal("error"),
		// The cause is the headline's key; an empty log rendering is not the current shape and fails the whole restore.
		cause: persistedCauseSchema,
		baseUrl: z.string().optional().catch(undefined),
		logSafeError: z.string().min(1),
		totalModels: z.number().optional(),
		serverStatuses: z.array(z.unknown()).optional(),
		lastChecked: z.string().optional(),
	}),
]);

// The persisted schema and the ConnectionStatus union cover the same states, checked both ways at compile time: a union
// state the schema lacks could never survive a session boundary, and a schema state the union lacks could never be
// constructed.
const _persistedStatesMatchUnion: [
	Exclude<ConnectionStatus["state"], z.infer<typeof persistedStatusSchema>["state"]>,
	Exclude<z.infer<typeof persistedStatusSchema>["state"], ConnectionStatus["state"]>,
] extends [never, never]
	? true
	: never = true;

const persistedEnvelopeSchema = z.looseObject({
	v: z.literal(PERSISTED_STATUS_VERSION),
	status: persistedStatusSchema,
});

/**
 * The blob is an ephemeral display cache, so the restore at this trust boundary is strict, and an earlier version's
 * blob, a foreign stamp, or junk restores as undefined rather than as a best guess.
 */
function restoreConnectionStatus(value: unknown): ConnectionStatus | undefined {
	const parsed = persistedEnvelopeSchema.safeParse(value);
	if (!parsed.success) {
		return undefined;
	}
	const raw = parsed.data.status;
	// Every branch rebuilds through restoreTotal, so a field a variant gains cannot be silently dropped on restore.
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
			// A restored "connecting" is stale by definition (it survived a whole session boundary without resolving),
			// so it starts degraded.
			return restoreTotal<Extract<ConnectionStatus, { state: "connecting" }>>({
				state: "connecting",
				attention: true,
				lastChecked: raw.lastChecked,
			});
		case "connected":
		case "degraded": {
			const serverStatuses = restoreServerStatuses(raw.serverStatuses);
			return restoreTotal<Extract<ConnectionStatus, { state: "connected" | "degraded" }>>({
				state: raw.state,
				totalModels: raw.totalModels,
				serverStatuses,
				// The texts rebuild from the restored statuses (the hidden and answered counts live there), so a restore
				// into another locale reads in that locale.
				zeroModel: raw.zeroModel === true ? zeroModelCounts(serverStatuses) : undefined,
				lastChecked: raw.lastChecked,
			});
		}
		case "error":
			return restoreTotal<Extract<ConnectionStatus, { state: "error" }>>({
				state: "error",
				cause: restoredCause(raw.cause),
				baseUrl: raw.baseUrl,
				// Written by publicErrorText last session, so re-branding it is sound.
				logSafeError: markLogSafe(raw.logSafeError),
				serverStatuses: restoreServerStatuses(raw.serverStatuses ?? []),
				totalModels: raw.totalModels,
				lastChecked: raw.lastChecked,
			});
	}
}

function restoreServerStatuses(elements: readonly unknown[]): ServerStatus[] {
	return elements.flatMap((element) => {
		const restored = restoreServerStatus(element);
		return restored === undefined ? [] : [restored];
	});
}

export interface StatusItemView {
	readonly text: string;
	readonly tooltip: string;
	readonly severity: "plain" | "warning" | "error";
}

export interface StatusItemLike extends vscode.Disposable {
	readonly command: string | vscode.Command | undefined;
	render(view: StatusItemView): void;
	show(): void;
	hide(): void;
	/**
	 * Fires once when the item is disposed, including by the slot registry's self-heal, where the OWNER must tear down
	 * too, not just the visible half. Optional so test fakes stay one-liners.
	 */
	onDidDispose?(listener: () => void): void;
}

/**
 * One host has one status bar, so slot occupancy is a per-host (module-scope) fact: at most ONE live real item may
 * exist per slot, ever. Duplicate identical items have accumulated in shared hosts twice from double constructions; the
 * registry makes that state self-healing and observable instead of possible.
 */
export type StatusItemSlot = "connection" | "usage";

const liveSlotItems = new Map<StatusItemSlot, StatusItem>();

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
 * THE ONE CREATION POINT for vscode.window.createStatusBarItem in src/; statusItemRegistry.test.ts scans the tree and
 * fails on a second call site. Creating into an occupied slot disposes the previous holder and logs the replacement, so
 * the UI self-heals while the lifecycle bug stays visible.
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
			// Self-heal: the slot invariant beats the stale holder. The log line is the evidence a double construction
			// happened at all.
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
		// Registering on an already-disposed item fires immediately: an owner handed a pre-disposed surface must still
		// learn to tear down, or it keeps its subscriptions alive forever.
		if (this.disposed) {
			listener();
			return;
		}
		this.disposeListeners.push(listener);
	}

	render(view: StatusItemView): void {
		// A stale holder disposed by the slot self-heal must not write to a disposed vscode item.
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
		// Only the slot's current holder vacates it: a stale holder disposed after its replacement must not evict the
		// live item.
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
	 * The attention verdict of the last connecting status this manager set, held across a transient "loading" overwrite
	 * (the connection test) and cleared by every other state, so a degraded connecting resumes degraded after the test
	 * instead of resetting to the neutral spinner.
	 *
	 *   Session state only -> never persisted
	 */
	private lastConnectingAttention = false;
	/**
	 * The last provider report, pre-overlay, so refreshFromSync can re-render with fresh declared views: sync outcomes
	 * change the overlay without any provider report. Session state; the empty report stands in before the first
	 * callback, exactly what the groupless cold-start refresh sends.
	 */
	private lastAggregated: AggregatedStatus | undefined;
	/**
	 * The overlaid window last judged, for refreshFromSync's no-change skip. A JSON rendering is deterministic here:
	 * both sides serialize the same base status objects through the same overlay construction, so equal worlds
	 * stringify equal.
	 */
	private lastJudgedOverlay: string | undefined;
	/**
	 * True while the status is still the constructor's restore-less connecting seed (a configured install whose blob
	 * failed the versioned restore). The seed is presentation, not evidence: the empty-report escalation must not count
	 * it as an already-reported empty window, or the first real empty report after a version bump would render the
	 * warning.
	 */
	private seededConnecting = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly logger: Logger,
		/**
		 * The shared not-configured gate: an empty status window on a configured install renders as "connecting", never
		 * as "not configured" - the persisted state feeds the diagnostics snapshot that lands in public issue reports,
		 * so the claim must be honest.
		 */
		private readonly hasConfiguredServers: () => boolean,
		/**
		 * The one owner of the verdict rows the bar classifies and of the declared set its sync-failure overlay reads
		 * (applySyncFailures): sync failures never enter the provider's status window.
		 */
		private readonly verdict: Pick<ServerVerdict, "declared" | "rows">,
		/**
		 * (Duplicate real items have twice accumulated in the shared test host from a defaulted construction.)
		 *
		 *   The rendering surface, REQUIRED so no code path can create a real status bar item by accident
		 *     -> activation passes the real StatusItem explicitly
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
			// The shared not-configured gate applies to the restore-less start too: after a version bump resets the
			// blob, a configured install must render "connecting" until the first report, never claim "not configured"
			// in the bar, the setup gate, or a diagnostics snapshot.
			this._connectionStatus = { state: "connecting", attention: false };
			this.seededConnecting = true;
		}
		// Rendering without an argument never persists, so nothing needs awaiting.
		void this.updateStatusBar();
	}

	get connectionStatus(): ConnectionStatus {
		return this._connectionStatus;
	}

	get connectingAttention(): boolean {
		return this._connectionStatus.state === "connecting" && this._connectionStatus.attention;
	}

	get clickCommand(): string | vscode.Command | undefined {
		return this._statusBarItem.command;
	}

	async updateStatusBar(status?: ConnectionStatus): Promise<void> {
		if (status) {
			this.seededConnecting = false;
			this.lastConnectingAttention =
				status.state === "connecting"
					? status.attention
					: status.state === "loading"
						? this.lastConnectingAttention
						: false;
			this._connectionStatus = status;
			// Keys, not rendered text (persistedStatus): every explanation renders again at restore time, in the
			// locale the window restores into.
			await this.context.globalState.update(LAST_CONNECTION_STATUS_KEY, {
				v: PERSISTED_STATUS_VERSION,
				status: persistedStatus(status),
			});
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
				// The judgment handleAggregatedStatus carried onto the status: connected-with-nothing-to-serve is ONE
				// consistently rendered warning (bar, hero, notifier, Test Connection all warning-grade), never a red
				// connection failure.
				const zero = current.zeroModel;
				if (zero !== undefined) {
					this._statusBarItem.render({
						text: l10n.t("$(warning) LiteLLM"),
						tooltip: l10n.t("No models available\n{0}\nClick for details", zeroModelTexts(zero).display),
						severity: "warning",
					});
					break;
				}
				const count = current.totalModels;
				const serverCount = current.serverStatuses.length;
				// The counts live in the tooltip, not the item's text: the bar stays quiet
				// (docs/dashboard.md#the-status-bar-items).
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
				// "failing", not "unreachable": the count also holds reachable servers whose provider-group sync failed
				// (applySyncFailures), and a failing server may still serve stale or declared models.
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
					// The rendered cause leaves the extension here (a configured URL may carry a registered value).
					tooltip: l10n.t(
						"Connection failed\n{0}\nClick for details",
						Logger.redact(failureTexts(current.cause, current.baseUrl ?? "").display)
					),
					severity: "error",
				});
				break;
		}
		this._statusBarItem.show();
	}

	handleAggregatedStatus(aggStatus: AggregatedStatus): void {
		this.lastAggregated = aggStatus;
		const now = new Date().toISOString();
		//   a failed upsert has no group to report, and a blocked group keeps reporting its old configuration as
		//       healthy -> the bar judges the overlaid window - the same precedence the dashboard rows render
		const serverStatuses = applySyncFailures(aggStatus.serverStatuses, this.verdict.declared().views);
		// The owner's published set (the dashboard hero and the notifier classify the same one).
		const rows = this.verdict.rows();
		this.lastJudgedOverlay = JSON.stringify([serverStatuses, rows]);
		const { totalModels } = aggStatus;

		// This method only maps verdicts onto status-bar states.
		//
		//   The one verdict pipeline -> classifyOverall owns the branch rules (red only when EVERY server failed
		//       unexpectedly, degraded on any unexpected failure, needs-declare when everything failed expectedly with
		//       nothing declared), shared with the dashboard headline and the notifier
		const verdict = classifyOverall(rows);
		if (rows.length === 0 || verdict === "waiting") {
			// Nothing has reported: no row at all, or only declared entries awaiting their first report. A not-configured
			// verdict needs nothing else to prove servers exist; at cold start the groupless refresh reports empty before
			// the per-group refreshes arrive.
			if (this.hasConfiguredServers()) {
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

		const firstFailure = unexpectedServerFailures(serverStatuses)[0];
		// Serving means serving on ANY state: a failed server still serving its stale-window or declared models counts
		// in the log lines.
		const servingCount = serverStatuses.filter((status) => status.state === "ok" || status.servedModelCount > 0).length;

		switch (verdict) {
			case "not-configured":
				// Unreachable: an empty row set returned above. Rendered honestly all the same.
				void this.updateStatusBar({ state: "not-configured", lastChecked: now });
				return;
			case "error": {
				if (firstFailure === undefined) {
					// Every row is a parser-refused entry: nothing reports, so the error has no transport failure to name.
					this.logger.log("All servers failed: every entry is misconfigured");
					void this.updateStatusBar({
						state: "error",
						cause: { kind: "misconfiguredEntry" },
						logSafeError: markLogSafe(MISCONFIGURED_ENTRY_TEXT),
						serverStatuses,
						totalModels: 0,
						lastChecked: now,
					});
					return;
				}
				// The error verdict now proves nothing serves (a serving failure reads degraded), so the zero count is
				// derived, not assumed. logSafeError, never error: this line lands in the issue-report buffer.
				this.logger.log(`All servers failed: ${firstFailure.logSafeError}`);
				void this.updateStatusBar({
					state: "error",
					cause: firstFailure.cause,
					baseUrl: firstFailure.baseUrl,
					logSafeError: firstFailure.logSafeError,
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
				// Every server failed expectedly with nothing declared: the status bar's rendering of the needs-declare
				// verdict - the actionable warning, never the zero-model red branch.
				this.logger.log("All discovery failures are expected and no models are declared");
				void this.updateStatusBar({ state: "connecting", attention: true, lastChecked: now });
				return;
			case "connected": {
				const zero = zeroModelJudgment(rows, totalModels);
				if (zero !== undefined) {
					// Carried on the status: the renderer and the command toasts present this judgment as a warning,
					// never a connection failure, without deriving their own.
					this.logger.log(`Warning: ${zeroModelTexts(zero).logSafe}`);
				} else {
					this.logger.log(`Successfully fetched ${totalModels} models from ${servingCount} server(s)`);
				}
				void this.updateStatusBar({
					state: "connected",
					serverStatuses,
					totalModels,
					...(zero !== undefined ? { zeroModel: zero } : {}),
					lastChecked: now,
				});
			}
		}
	}

	/**
	 * Re-judge the last provider report after a sync pass: a sync-only change (an upsert failing, a blocked entry
	 * clearing) moves the overlay without any provider report firing the status callback. Judged only when the overlaid
	 * window actually changed: replaying an unchanged report must not escalate the connecting spinner (a second FRESH
	 * empty report is the evidence of persistence, a sync pass is not) or duplicate log lines.
	 *
	 *   Before any report -> only a non-empty overlay says something a restored status does not
	 */
	refreshFromSync(): void {
		const base = this.lastAggregated ?? { serverStatuses: [], totalModels: 0, silent: true };
		const overlaid = applySyncFailures(base.serverStatuses, this.verdict.declared().views);
		// Before any report, news is a non-empty overlay or a non-empty row set (a refused entry is a row with no
		// overlay); a restored status says neither.
		if (this.lastAggregated === undefined && overlaid.length === 0 && this.verdict.rows().length === 0) {
			return;
		}
		// The same key handleAggregatedStatus judged by: an entry leaving or entering the awaiting set changes the
		// verdict rows without changing one overlaid status.
		if (JSON.stringify([overlaid, this.verdict.rows()]) === this.lastJudgedOverlay) {
			return;
		}
		this.handleAggregatedStatus(base);
	}
}
