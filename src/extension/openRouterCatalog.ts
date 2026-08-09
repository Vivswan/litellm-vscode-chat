/**
 * The runtime home of the OpenRouter capability catalog: serves a
 * CapabilityCatalogLookup for the provider injection seam and keeps the
 * snapshot fresh on a weekly cadence.
 *
 * Data flows through a fallback chain in which the FILE is the truth: the
 * cached refresh under context.globalStorageUri wins, the packaged
 * dist/openrouter-models.json (written by scripts/dev/fetch-openrouter-catalog.ts
 * at prepublish; absent in dev builds) backs it, and an empty snapshot
 * backstops both - a missing or malformed catalog degrades lookups to
 * not-found, never activation. The globalState key holds only advisory
 * scheduling metadata (globalState is not transactional and can revert; a
 * lost timestamp costs one early refresh). Cache writes go temp-then-rename
 * so a crash mid-write can never leave a torn file as the truth.
 *
 * The opt-out setting (read through the injected isEnabled) stops exactly two
 * things: the periodic refresh (all network) and the implicit byRawModelId
 * lookup. Explicit `_openrouter_model` directives keep answering byExactId
 * from the bundled/cached snapshot - they are user intent and cost no
 * network. Refresh failures log fixed classifications only, never
 * response-derived text (logs feed the public issue-report buffer).
 */

import * as vscode from "vscode";
import { DISCOVERY_MAX_RETRIES } from "../provider/catalog/discovery";
import type { CapabilityCatalogLookup } from "../shared/config/capabilityResolution";
import {
	CATALOG_MODEL_COUNT_FLOOR,
	createCatalogLookup,
	EMPTY_CATALOG_SNAPSHOT,
	OPENROUTER_MODELS_URL,
	type OpenRouterCatalogSnapshot,
	parseCatalogSnapshot,
	slimCatalogPayload,
} from "../shared/config/openRouterCatalog";
import { OPENROUTER_CATALOG_METADATA_KEY } from "../shared/config/storageKeys";
import type { Logger } from "../shared/logger";
import { isRecord } from "../shared/util/json";
import type { Clock, Timer } from "../shared/util/timer";
import { PendingCall, REAL_TIMER, SYSTEM_CLOCK } from "../shared/util/timer";

/** The artifact/cache file name, identical in dist/ and globalStorage; the test seam writes the same path. */
export const CATALOG_FILE_NAME = "openrouter-models.json";

const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * The soonest any refresh may run after scheduling: activation never pays for
 * catalog network, and a reverted/lost metadata timestamp (which schedules
 * "soon") still keeps the fetch off the startup path. Also the floor the
 * test-visible backoff sleeps must stay well under.
 */
const MIN_SCHEDULE_DELAY_MS = 60_000;

/**
 * Per-attempt bound; the whole refresh stays hard-bounded at
 * (1 + DISCOVERY_MAX_RETRIES) attempts of this plus the fixed backoffs. A
 * background refresh has no caller waiting on the configured timeouts.
 */
const REFRESH_FETCH_TIMEOUT_MS = 30_000;

export interface OpenRouterCatalogStoreOptions {
	readonly extensionUri: vscode.Uri;
	readonly globalStorageUri: vscode.Uri;
	readonly globalState: vscode.Memento;
	readonly logger: Logger;
	/** The opt-out setting, read at decision time so a toggle needs no rebuild. */
	readonly isEnabled: () => boolean;
	/** Injectable network seam; the default GETs OPENROUTER_MODELS_URL and returns the parsed JSON payload. */
	readonly fetchCatalog?: (signal: AbortSignal) => Promise<unknown>;
	readonly timer?: Timer;
	readonly clock?: Clock;
}

export interface OpenRouterCatalogStore extends vscode.Disposable {
	/** The provider-injected view; stable identity, always answering from the current snapshot. */
	readonly lookup: CapabilityCatalogLookup;
	/** Fires after a successful refresh swaps in new data (wire to notifyModelInformationChanged + dashboard re-push). */
	readonly onDidUpdate: vscode.Event<void>;
	/** The current snapshot, for consumers that list entries (the dashboard's catalog picker). */
	snapshot(): OpenRouterCatalogSnapshot;
	/** The dashboard row's status facts: size, last successful refresh, and the last failure when one stands. */
	status(): OpenRouterCatalogStatus;
	/** Load cache -> bundled -> empty and schedule the periodic refresh. Never throws. */
	initialize(): Promise<void>;
	/** Re-read isEnabled after a setting change: cancels the pending refresh or schedules one. */
	applyEnabledSetting(): void;
	/** Refresh immediately (deduplicated with any refresh already in flight). Never rejects. */
	refreshNow(): Promise<void>;
}

/**
 * The catalog facts the dashboard's models.openRouterCatalog row states. The
 * failure classification is the same fixed vocabulary the log line carries
 * ("HTTP 503", "network error", "payload below the N-model floor") - never
 * response-derived text - and it stands until the next successful refresh.
 */
export interface OpenRouterCatalogStatus {
	readonly modelCount: number;
	/** Epoch ms of the last successful, persisted refresh; undefined when only the bundled snapshot serves. */
	readonly lastSuccessAt: number | undefined;
	readonly lastFailure?: { readonly classification: string; readonly at: number } | undefined;
	/** Whether a refresh is in flight right now (the row's Refresh button disables on it). */
	readonly refreshing: boolean;
}

async function fetchOpenRouterCatalog(signal: AbortSignal): Promise<unknown> {
	const response = await globalThis.fetch(OPENROUTER_MODELS_URL, {
		signal: AbortSignal.any([signal, AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS)]),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	try {
		return await response.json();
	} catch {
		throw new Error("unparseable response");
	}
}

/**
 * A fixed-vocabulary rendering of a refresh failure for the log line: the
 * default fetch throws only `HTTP <status>` and `unparseable response`
 * markers, and anything else (DNS, TLS, abort races, an injected fetch's
 * surprises) collapses to "network error" - response-derived text never
 * reaches the log.
 */
function classifyRefreshFailure(error: unknown): string {
	if (error instanceof Error && (/^HTTP \d+$/.test(error.message) || error.message === "unparseable response")) {
		return error.message;
	}
	return "network error";
}

class Store implements OpenRouterCatalogStore {
	readonly lookup: CapabilityCatalogLookup;
	readonly onDidUpdate: vscode.Event<void>;

	private readonly updateEmitter = new vscode.EventEmitter<void>();
	private readonly fetchCatalog: (signal: AbortSignal) => Promise<unknown>;
	private readonly timer: Timer;
	private readonly clock: Clock;
	private readonly abort = new AbortController();

	private current = EMPTY_CATALOG_SNAPSHOT;
	private inner = createCatalogLookup(EMPTY_CATALOG_SNAPSHOT, { implicitLookup: true });
	private readonly scheduled: PendingCall;
	private pendingBackoff: { cancel: () => void; resolve: () => void } | undefined;
	private inFlight: Promise<void> | undefined;
	private disposed = false;
	/** The last refresh failure, standing until the next success; see OpenRouterCatalogStatus. */
	private lastFailure: { classification: string; at: number } | undefined;

	constructor(private readonly options: OpenRouterCatalogStoreOptions) {
		this.fetchCatalog = options.fetchCatalog ?? fetchOpenRouterCatalog;
		this.timer = options.timer ?? REAL_TIMER;
		this.clock = options.clock ?? SYSTEM_CLOCK;
		this.scheduled = new PendingCall(this.timer);
		this.onDidUpdate = this.updateEmitter.event;
		this.lookup = {
			byExactId: (id) => this.inner.byExactId(id),
			byRawModelId: (rawId) => (this.options.isEnabled() ? this.inner.byRawModelId(rawId) : { kind: "not-found" }),
		};
	}

	snapshot(): OpenRouterCatalogSnapshot {
		return this.current;
	}

	status(): OpenRouterCatalogStatus {
		return {
			modelCount: this.current.models.length,
			lastSuccessAt: this.readLastSuccess(),
			...(this.lastFailure !== undefined ? { lastFailure: this.lastFailure } : {}),
			refreshing: this.inFlight !== undefined,
		};
	}

	async initialize(): Promise<void> {
		const cached = await this.readSnapshotFile(this.cacheUri());
		if (cached.kind === "ok") {
			this.install(cached.snapshot);
		} else {
			if (cached.kind === "unusable") {
				this.options.logger.log("OpenRouter catalog cache unreadable; falling back to the bundled snapshot");
			}
			const bundled = await this.readSnapshotFile(
				vscode.Uri.joinPath(this.options.extensionUri, "dist", CATALOG_FILE_NAME)
			);
			if (bundled.kind === "ok") {
				this.install(bundled.snapshot);
			}
			// Both missing (a dev build without the artifact): the empty snapshot
			// stays in place and every lookup answers not-found.
		}
		this.scheduleFromMetadata();
	}

	applyEnabledSetting(): void {
		if (!this.options.isEnabled()) {
			this.scheduled.cancel();
			return;
		}
		this.ensureScheduled();
	}

	refreshNow(): Promise<void> {
		this.inFlight ??= this.runRefresh().finally(() => {
			this.inFlight = undefined;
			this.ensureScheduled();
		});
		return this.inFlight;
	}

	dispose(): void {
		this.disposed = true;
		this.scheduled.cancel();
		this.abort.abort();
		// A backoff sleep must not strand an in-flight refresh promise.
		this.pendingBackoff?.cancel();
		this.pendingBackoff?.resolve();
		this.pendingBackoff = undefined;
		this.updateEmitter.dispose();
	}

	private cacheUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.options.globalStorageUri, CATALOG_FILE_NAME);
	}

	private install(snapshot: OpenRouterCatalogSnapshot): void {
		this.current = snapshot;
		this.inner = createCatalogLookup(snapshot, { implicitLookup: true });
	}

	private async readSnapshotFile(
		uri: vscode.Uri
	): Promise<{ kind: "ok"; snapshot: OpenRouterCatalogSnapshot } | { kind: "missing" } | { kind: "unusable" }> {
		let bytes: Uint8Array;
		try {
			bytes = await vscode.workspace.fs.readFile(uri);
		} catch {
			return { kind: "missing" };
		}
		let payload: unknown;
		try {
			payload = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return { kind: "unusable" };
		}
		const snapshot = parseCatalogSnapshot(payload);
		return snapshot.models.length > 0 ? { kind: "ok", snapshot } : { kind: "unusable" };
	}

	private scheduleFromMetadata(): void {
		const lastSuccessAt = this.readLastSuccess();
		const delay =
			lastSuccessAt === undefined
				? MIN_SCHEDULE_DELAY_MS
				: Math.min(
						Math.max(lastSuccessAt + REFRESH_INTERVAL_MS - this.clock.now(), MIN_SCHEDULE_DELAY_MS),
						REFRESH_INTERVAL_MS
					);
		this.schedule(delay);
	}

	/**
	 * Re-establish the scheduling invariant - enabled implies a pending timer
	 * or a refresh in flight - by arming the metadata-based schedule when
	 * neither exists. A refresh that bails early (disabled or disposed
	 * mid-flight) arms no follow-up itself, so its completion funnels through
	 * here; schedule() stays a no-op while disabled or disposed.
	 */
	private ensureScheduled(): void {
		if (!this.scheduled.pending && this.inFlight === undefined) {
			this.scheduleFromMetadata();
		}
	}

	private schedule(ms: number): void {
		this.scheduled.cancel();
		if (this.disposed || !this.options.isEnabled()) {
			return;
		}
		this.scheduled.arm(() => {
			void this.refreshNow();
		}, ms);
	}

	private readLastSuccess(): number | undefined {
		const metadata = this.options.globalState.get<unknown>(OPENROUTER_CATALOG_METADATA_KEY);
		if (!isRecord(metadata)) {
			return undefined;
		}
		const { lastSuccessAt } = metadata;
		return typeof lastSuccessAt === "number" && Number.isFinite(lastSuccessAt) ? lastSuccessAt : undefined;
	}

	private async runRefresh(): Promise<void> {
		if (this.disposed || !this.options.isEnabled()) {
			return;
		}
		let payload: unknown;
		try {
			payload = await this.fetchWithRetries();
		} catch (error) {
			if (this.disposed || !this.options.isEnabled()) {
				return;
			}
			const classification = classifyRefreshFailure(error);
			this.lastFailure = { classification, at: this.clock.now() };
			this.options.logger.log(`OpenRouter catalog refresh failed (${classification})`);
			this.schedule(FAILURE_RETRY_MS);
			return;
		}
		if (this.disposed || !this.options.isEnabled()) {
			return;
		}
		const slim = slimCatalogPayload(payload);
		const snapshot = parseCatalogSnapshot(slim);
		// The build script's floor, applied at runtime too: a truncated or
		// drifted live response must never replace a full cached catalog.
		if (snapshot.models.length < CATALOG_MODEL_COUNT_FLOOR) {
			this.lastFailure = {
				classification: `payload below the ${CATALOG_MODEL_COUNT_FLOOR}-model floor`,
				at: this.clock.now(),
			};
			this.options.logger.log(
				`OpenRouter catalog refresh failed (payload below the ${CATALOG_MODEL_COUNT_FLOOR}-model floor)`
			);
			this.schedule(FAILURE_RETRY_MS);
			return;
		}
		this.install(snapshot);
		this.lastFailure = undefined;
		const persisted = await this.persist(`${JSON.stringify(slim, null, "\t")}\n`);
		if (persisted) {
			try {
				await this.options.globalState.update(OPENROUTER_CATALOG_METADATA_KEY, { lastSuccessAt: this.clock.now() });
			} catch {
				// Advisory only: the file above is the truth, and a lost timestamp
				// just schedules the next refresh early.
			}
		}
		this.updateEmitter.fire();
		// An unpersisted refresh serves from memory this session only, so the
		// retry cadence applies: a restart would fall back to stale data.
		this.schedule(persisted ? REFRESH_INTERVAL_MS : FAILURE_RETRY_MS);
	}

	/** Idempotent GET, so it retries like discovery's model-listing calls; chat completions never do. */
	private async fetchWithRetries(): Promise<unknown> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				return await this.fetchCatalog(this.abort.signal);
			} catch (error) {
				// Opting out mid-refresh stops the remaining attempts (the setting
				// promises "no catalog network"), and dispose() resolves a pending
				// backoff, so both are re-checked before every retry.
				if (this.disposed || !this.options.isEnabled() || attempt >= DISCOVERY_MAX_RETRIES) {
					throw error;
				}
				await this.backoff(1000 * 2 ** attempt);
				if (this.disposed || !this.options.isEnabled()) {
					throw error;
				}
			}
		}
	}

	private backoff(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const cancel = this.timer.set(() => {
				this.pendingBackoff = undefined;
				resolve();
			}, ms);
			this.pendingBackoff = { cancel, resolve };
		});
	}

	private async persist(text: string): Promise<boolean> {
		const target = this.cacheUri();
		// globalStorage is shared across VS Code windows, so the temp name is
		// per-write unique: concurrent refreshes each rename their own complete
		// file, never a torn interleaving.
		const temp = vscode.Uri.joinPath(
			this.options.globalStorageUri,
			`${CATALOG_FILE_NAME}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`
		);
		try {
			await vscode.workspace.fs.createDirectory(this.options.globalStorageUri);
			await vscode.workspace.fs.writeFile(temp, new TextEncoder().encode(text));
			await vscode.workspace.fs.rename(temp, target, { overwrite: true });
			return true;
		} catch {
			this.options.logger.log("OpenRouter catalog cache write failed; serving the refreshed catalog in memory only");
			try {
				await vscode.workspace.fs.delete(temp);
			} catch {
				// Best effort: the unique name means a leftover temp is inert.
			}
			return false;
		}
	}
}

export function createOpenRouterCatalogStore(options: OpenRouterCatalogStoreOptions): OpenRouterCatalogStore {
	return new Store(options);
}
