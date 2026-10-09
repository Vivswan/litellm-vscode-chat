/**
 * The runtime home of the OpenRouter capability catalog: serves a CapabilityCatalogLookup for the provider injection
 * seam and keeps the snapshot fresh on a weekly cadence.
 *
 *   Data flows through a fallback chain in which the FILE is the truth
 *     -> the cached refresh under globalStorageUri wins, the packaged dist/openrouter-models.json backs it
 *   The globalState key holds only advisory scheduling metadata -> a lost timestamp costs one early refresh
 *   Cache writes go temp-then-rename -> a crash mid-write cannot leave a torn file as the truth
 *   user intent, no network -> Explicit `_openrouter_model` directives keep answering byExactId
 */

import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import * as vscode from "vscode";
import type { CatalogRefreshFailure } from "../dashboard/viewModels";
import { DISCOVERY_MAX_RETRIES } from "../provider/catalog/discovery";
import type { BackoffSleep } from "../provider/transport/retry";
import { retryIdempotent } from "../provider/transport/retry";
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
import { PendingCall, REAL_TIMER, SYSTEM_CLOCK, sleepUnlessAborted } from "../shared/util/timer";

/** The artifact/cache file name, identical in dist/ and globalStorage; the test seam writes the same path. */
export const CATALOG_FILE_NAME = "openrouter-models.json";

const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * The backoff sleeps stay well under it.
 *
 *   activation -> never pays for catalog network
 *   a lost metadata timestamp (which schedules "soon") -> still keeps the fetch off the startup path
 */
const MIN_SCHEDULE_DELAY_MS = 60_000;

const REFRESH_FETCH_TIMEOUT_MS = 30_000;

export interface OpenRouterCatalogStoreOptions {
	readonly extensionUri: vscode.Uri;
	readonly globalStorageUri: vscode.Uri;
	readonly globalState: vscode.Memento;
	readonly logger: Logger;
	/** The opt-out setting, read at decision time so a toggle needs no rebuild. */
	readonly isEnabled: () => boolean;
	/**
	 * Injectable network seam; the default GETs OPENROUTER_MODELS_URL and returns the parsed JSON payload. A failure
	 * retries only in the SDK's error vocabulary (see fetchOpenRouterCatalog); anything else is settled.
	 */
	readonly fetchCatalog?: (signal: AbortSignal) => Promise<unknown>;
	/** Schedules the refreshes (weekly, daily on failure); the retry backoff within one refresh is `sleep`. */
	readonly timer?: Timer;
	readonly clock?: Clock;
	/** The retry backoff between failed fetch attempts: the real timer unless a test passes a zero sleep. */
	readonly sleep?: BackoffSleep;
}

export interface OpenRouterCatalogStore extends vscode.Disposable {
	/** The provider-injected view; stable identity, always answering from the current snapshot. */
	readonly lookup: CapabilityCatalogLookup;
	/**
	 * Fires after a successful refresh swaps in new data (wire to notifyModelInformationChanged + dashboard re-push).
	 */
	readonly onDidUpdate: vscode.Event<void>;
	snapshot(): OpenRouterCatalogSnapshot;
	status(): OpenRouterCatalogStatus;
	/** Load cache -> bundled -> empty and schedule the periodic refresh. Never throws. */
	initialize(): Promise<void>;
	/** Re-read isEnabled after a setting change: cancels the pending refresh or schedules one. */
	applyEnabledSetting(): void;
	/** Refresh immediately (deduplicated with any refresh already in flight). Never rejects. */
	refreshNow(): Promise<void>;
}

/**
 * The catalog facts the dashboard's models.openRouterCatalog row states. The failure classification is the same fixed
 * vocabulary the log line carries - never response-derived text - and it stands until the next success.
 */
export interface OpenRouterCatalogStatus {
	readonly modelCount: number;
	/** Epoch ms of the last successful, persisted refresh; undefined when only the bundled snapshot serves. */
	readonly lastSuccessAt: number | undefined;
	readonly lastFailure?: { readonly classification: CatalogRefreshFailure; readonly at: number } | undefined;
	/** Whether a refresh is in flight right now (the row's Refresh button disables on it). */
	readonly refreshing: boolean;
}

/**
 * The fixed vocabulary the log line and the dashboard row carry, read off the SDK error shapes the fetch throws (the
 * shapes discovery's retry rule judges): response-derived text never reaches either.
 */
function classifyRefreshFailure(error: unknown): CatalogRefreshFailure {
	if (error instanceof APIConnectionTimeoutError) {
		return "timeout";
	}
	if (error instanceof APIError && error.status !== undefined) {
		return `HTTP ${error.status}`;
	}
	return error instanceof SyntaxError ? "unparseable response" : "network error";
}

/**
 * A fetch-created body already tears down on abort; racing the signal explicitly keeps the budget honest for any
 * Response, and settles the read the moment either abort fires rather than when the stream notices.
 */
function readBody(response: Response, signal: AbortSignal): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		response
			.text()
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/**
 * One GET in the SDK's error vocabulary, so discovery's retry rule reads it unchanged (a 503 with `x-should-retry:
 * false` is settled here too).
 *   our own budget expiring, whichever phase it interrupts -> APIConnectionTimeoutError
 *   a connect failure or a socket death mid-body            -> APIConnectionError
 *   a non-2xx answer                                        -> APIError carrying the status and headers
 *   a body that is not JSON                                 -> JSON.parse's SyntaxError
 */
async function fetchOpenRouterCatalog(signal: AbortSignal): Promise<unknown> {
	const budget = AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS);
	const attempt = AbortSignal.any([signal, budget]);
	const classifyAbort = (error: unknown): unknown => {
		if (signal.aborted) {
			return signal.reason;
		}
		return budget.aborted
			? new APIConnectionTimeoutError()
			: new APIConnectionError({ cause: error instanceof Error ? error : undefined });
	};
	let response: Response;
	try {
		response = await globalThis.fetch(OPENROUTER_MODELS_URL, { signal: attempt });
	} catch (error) {
		throw classifyAbort(error);
	}
	if (!response.ok) {
		throw new APIError(response.status, undefined, undefined, response.headers);
	}
	let text: string;
	try {
		text = await readBody(response, attempt);
	} catch (error) {
		throw classifyAbort(error);
	}
	const payload: unknown = JSON.parse(text);
	return payload;
}

class Store implements OpenRouterCatalogStore {
	readonly lookup: CapabilityCatalogLookup;
	readonly onDidUpdate: vscode.Event<void>;

	private readonly updateEmitter = new vscode.EventEmitter<void>();
	private readonly fetchCatalog: (signal: AbortSignal) => Promise<unknown>;
	private readonly timer: Timer;
	private readonly clock: Clock;
	private readonly sleep: BackoffSleep;
	private readonly abort = new AbortController();

	private current = EMPTY_CATALOG_SNAPSHOT;
	private inner = createCatalogLookup(EMPTY_CATALOG_SNAPSHOT, { implicitLookup: true });
	private readonly scheduled: PendingCall;
	private inFlight: Promise<void> | undefined;
	private disposed = false;
	/** The last refresh failure, standing until the next success; see OpenRouterCatalogStatus. */
	private lastFailure: { classification: CatalogRefreshFailure; at: number } | undefined;

	constructor(private readonly options: OpenRouterCatalogStoreOptions) {
		this.fetchCatalog = options.fetchCatalog ?? fetchOpenRouterCatalog;
		this.timer = options.timer ?? REAL_TIMER;
		this.clock = options.clock ?? SYSTEM_CLOCK;
		this.sleep = options.sleep ?? sleepUnlessAborted;
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
		if (cached.kind === "unusable") {
			this.options.logger.log("OpenRouter catalog cache unreadable; falling back to the bundled snapshot");
		}
		const source =
			cached.kind === "ok"
				? cached
				: await this.readSnapshotFile(vscode.Uri.joinPath(this.options.extensionUri, "dist", CATALOG_FILE_NAME));
		// Unconditional: openRouterCatalogTestSeam.ts re-runs initialize after deleting the cache file, and the snapshot
		// that file held must stop serving with it.
		this.install(source.kind === "ok" ? source.snapshot : EMPTY_CATALOG_SNAPSHOT);
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

	/** A refresh that bails early arms no follow-up itself, so its completion funnels through here. */
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
		//   The build script's floor -> applied at runtime too
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
				// Advisory only: the file above is the truth, and a lost timestamp just schedules the next refresh
				// early.
			}
		}
		this.updateEmitter.fire();
		// An unpersisted refresh serves from memory this session only, so the retry cadence applies: a restart would
		// fall back to stale data.
		this.schedule(persisted ? REFRESH_INTERVAL_MS : FAILURE_RETRY_MS);
	}

	/**
	 * Idempotent GET, so it retries under discovery's pipeline (chat completions never retry): a settled answer - a
	 * 200 with a non-JSON body, a non-transient 4xx - gets one attempt because the rule does not retry it, exactly as
	 * for discovery's own body parse. Opting out mid-refresh turns the next attempt into a settled failure, which
	 * runRefresh swallows; dispose() ends a backoff sleep through the signal.
	 */
	private fetchWithRetries(): Promise<unknown> {
		return retryIdempotent(
			() =>
				this.options.isEnabled()
					? this.fetchCatalog(this.abort.signal)
					: Promise.reject(new Error("OpenRouter catalog refresh opted out")),
			{ maxRetries: DISCOVERY_MAX_RETRIES, signal: this.abort.signal, sleep: this.sleep }
		);
	}

	private async persist(text: string): Promise<boolean> {
		const target = this.cacheUri();
		// globalStorage is shared across windows, so the temp name is per-write unique: concurrent refreshes each
		// rename their own complete file.
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
