import * as l10n from "@vscode/l10n";
import type {
	CancellationToken,
	Event,
	LanguageModelChatProvider,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart,
	PrepareLanguageModelChatModelOptions,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";
import { CancellationError, EventEmitter, LanguageModelError } from "vscode";
import type { CapabilityCatalogLookup, ModelCapabilitiesRecord } from "../shared/config/capabilityResolution";
import { EMPTY_CATALOG_LOOKUP } from "../shared/config/capabilityResolution";
import { ModelResolutionTable } from "../shared/config/resolutionTable";
import { getDiscoveryStaleServeWindow } from "../shared/config/settings";
import { countTextTokens } from "../shared/conversion/textTokens";
import { estimateMessagesTokens } from "../shared/conversion/tokenEstimation";
import type { Logger } from "../shared/logger";
import { localizedError, type MirroredError } from "../shared/mirroredError";
import type { ExpectedFailureCategory, NonChatMode } from "../shared/serverEntry";
import type { AggregatedStatus } from "../shared/servers";
import type { HeaderValue } from "../shared/util/headers";
import { DiscoveryCache } from "./catalog/discoveryCache";
import { logFailure } from "./catalog/discoveryLog";
import type { DiscoveredGroupModels, SuppressedGroupKey } from "./catalog/groupDiscovery";
import { GroupDiscovery } from "./catalog/groupDiscovery";
import type { EntryCredentialsResolver, GroupServer, LiteLLMModelInfo } from "./catalog/groupModels";
import {
	groupClientId,
	logCredentialRejections,
	overlayEntryCredentials,
	parseGroupConfiguration,
	parseModelMetadata,
} from "./catalog/groupModels";
import type { EntryIdentity } from "./catalog/servedModels";
import { ServedModelDecorator } from "./catalog/servedModels";
import { GroupStatusReporter } from "./catalog/statusReporting";
import type { ServerModelsSnapshot } from "./catalog/statusWindow";
import { StatusWindow } from "./catalog/statusWindow";
import { ChatClient } from "./transport/chatClient";
import type { TransportFetch } from "./transport/nodeHttpFetch";
import { RequestError } from "./transport/transportErrors";

/** The terse classification keeps the model ID out of public logs. */
function unroutableModelError(modelId: string, reason: "no group identity" | "group not served"): MirroredError {
	return localizedError(
		l10n.t('Model "{0}" is not registered with any configured server. Refresh the model list and try again.', modelId),
		`Model "${modelId}" is not registered with any configured server. Refresh the model list and try again.`,
		`RequestRouting(${reason})`
	);
}

/**
 * Only the taxonomy-backed cases map; everything else - including CancellationError, which is never wrapped or logged
 * - passes through unchanged, and 401s keep their auth classification rather than being re-wrapped as anything else.
 *
 *   it renders in the chat UI -> the message is preserved
 *   Wrap a classified transport failure in the stable LanguageModelError -> vscode.lm consumers can branch on the
 *     documented codes instead of matching message text
 */
export function toLanguageModelError(err: unknown): unknown {
	if (!(err instanceof RequestError)) {
		return err;
	}
	let wrapped: Error | undefined;
	if (err.kind === "auth") {
		wrapped = LanguageModelError.NoPermissions(err.message);
	} else if (err.status === 404) {
		wrapped = LanguageModelError.NotFound(err.message);
	} else if (err.status === 429) {
		wrapped = LanguageModelError.Blocked(err.message);
	}
	if (wrapped === undefined) {
		return err;
	}
	wrapped.cause = err;
	return wrapped;
}

export interface LiteLLMChatModelProviderOptions {
	userAgent: HeaderValue;
	logger?: Logger | undefined;
	/** Request-time resolver for a declared entry's per-entry modelParameters; see ChatClientOptions. */
	getEntryModelParameters?:
		| ((label: string, baseUrl: string) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined)
		| undefined;
	/**
	 * Registration-time resolver for a declared entry's per-entry modelCapabilities, matched by label and normalized
	 * base URL exactly like getEntryModelParameters.
	 */
	getEntryModelCapabilities?: ((label: string, baseUrl: string) => ModelCapabilitiesRecord | undefined) | undefined;
	/**
	 * Request- and discovery-time resolver for a declared entry's custom headers, matched like
	 * getEntryModelCapabilities. Headers live on the entry - there is no global headers setting.
	 */
	getEntryHeaders?: ((label: string, baseUrl: string) => Readonly<Record<string, HeaderValue>> | undefined) | undefined;
	/**
	 * Request- and discovery-time resolver for a declared entry's apiVersion override (what apiRootOf appends to the
	 * base URL), matched like getEntryHeaders. "" is a real value (append nothing), distinct from undefined
	 * (auto-detect: keep a version segment already in the URL, else /v1).
	 */
	getEntryApiVersion?: ((label: string, baseUrl: string) => string | undefined) | undefined;
	/**
	 * Registration-time resolver for a declared entry's discovery.declared model IDs, matched like
	 * getEntryModelCapabilities.
	 */
	getEntryDeclaredModels?: ((label: string, baseUrl: string) => readonly string[] | undefined) | undefined;
	/**
	 * Discovery-time resolver for a declared entry's expectedFailures categories, matched like
	 * getEntryModelCapabilities. A listed category's endpoint gets a single discovery attempt and its failure is
	 * downgraded to an expected, info-severity outcome.
	 */
	getExpectedFailures?:
		| ((label: string, baseUrl: string) => readonly ExpectedFailureCategory[] | undefined)
		| undefined;
	/**
	 * Discovery-time resolver for a declared entry's includeModes, matched like getExpectedFailures: the non-chat modes
	 * whose /model/info entries register anyway. Part of the discovery cache key, so an edit refetches.
	 */
	getEntryIncludeModes?: ((label: string, baseUrl: string) => readonly NonChatMode[] | undefined) | undefined;
	/**
	 * The host bakes credentials into a group at creation and its group commands are add-only, so the entry's CURRENT
	 * credentials (matched like getEntryHeaders) overlay the baked ones; see GroupCredentialsResolution for the three
	 * answers and which one keeps the baked set.
	 */
	resolveEntryCredentials?: EntryCredentialsResolver | undefined;
	/** The HTTP transport under the chat client; tests inject a fake here. Defaults to nodeHttpFetch. */
	fetch?: TransportFetch | undefined;
	/**
	 * The OpenRouter capability catalog as in-memory lookup data (the catalog store owns files, network, and the
	 * opt-out; this layer only resolves). Read at serve time so a refreshed snapshot reaches the next attach without a
	 * rebuild.
	 */
	getCatalogLookup?: (() => CapabilityCatalogLookup) | undefined;
	/**
	 * A suppressed group answers empty and skips the network, while its group-side status still reports, so
	 * the status window and the dashboard stay coherent.
	 *
	 *   removed    -> judged by the group's client ID, by the entry label its configuration is stamped with at its
	 *                 base URL, or by the status label and URL a pre-keyed tombstone carries
	 *   superseded -> the entry carrying `entryLabel` now declares another URL; unlabeled groups pass no
	 *                 `entryLabel`, so a URL-host display label never reads as an entry's
	 */
	isGroupSuppressed?: ((group: SuppressedGroupKey) => boolean) | undefined;
	/** Cache seam for tests (fake TTL clock); the provider owns a real one by default. */
	discoveryCache?: DiscoveryCache<DiscoveredGroupModels> | undefined;
	/** The status window's only clock seam; tests inject a fake. The default reads Date.now at call time. */
	now?: (() => number) | undefined;
}

/**
 * Error ownership lives here: transport and discovery modules construct specific errors and throw without logging, and
 * this facade is the SINGLE logging boundary - it logs each failure once, and the composed modules log only through
 * callbacks bound to this class's logger.
 */
export class LiteLLMChatModelProvider implements LanguageModelChatProvider<LiteLLMModelInfo> {
	private readonly _client: ChatClient;
	// The host re-resolves groups in bursts, so cached sweeps must not hit the network; refreshGroups clears it, so
	// an explicit refresh reaches the network anyway. The group identity is stamped onto the stored infos on every
	// read, never cached.
	private readonly _discoveryCache: DiscoveryCache<DiscoveredGroupModels>;
	private readonly logger?: Logger | undefined;
	private readonly _statusWindow: StatusWindow;
	private readonly _reporter: GroupStatusReporter;
	private readonly _decorator: ServedModelDecorator;
	private readonly _discovery: GroupDiscovery;
	private readonly _resolveEntryCredentials?: EntryCredentialsResolver | undefined;
	private readonly _groupServesInFlight = new Set<Promise<unknown>>();
	private _refreshPass: Promise<{ readonly refreshedGroups: number }> | undefined;
	private readonly _onDidChangeEmitter = new EventEmitter<void>();
	private readonly _onDidObserveGroupEmitter = new EventEmitter<void>();
	/**
	 * The precomputed flat resolution table: one instance shared by the chat request path, registration, and the
	 * dashboard's inspectors, so every consumer reads the same cache. Input-fingerprinted, so settings, entry, and
	 * discovery changes reach the next lookup without event plumbing.
	 */
	private readonly _resolution = new ModelResolutionTable();
	/** Fired to make the host re-resolve the group-agnostic call and every group through this provider. */
	readonly onDidChangeLanguageModelChatInformation: Event<void> = this._onDidChangeEmitter.event;
	/**
	 * Fires when a provider group enters the status window under a new identity (see StatusWindow's onGroupEntered):
	 * the sync engine's ownership evidence changed, so the servers wiring re-runs a sync pass.
	 */
	readonly onDidObserveGroup: Event<void> = this._onDidObserveGroupEmitter.event;

	constructor(options: LiteLLMChatModelProviderOptions) {
		this.logger = options.logger;
		this._resolveEntryCredentials = options.resolveEntryCredentials;
		this._client = new ChatClient({
			userAgent: options.userAgent,
			logger: options.logger,
			getEntryModelParameters: options.getEntryModelParameters,
			getEntryHeaders: options.getEntryHeaders,
			getEntryApiVersion: options.getEntryApiVersion,
			resolution: this._resolution,
			fetch: options.fetch,
		});
		this._discoveryCache = options.discoveryCache ?? new DiscoveryCache();
		this._statusWindow = new StatusWindow(
			options.now ?? (() => Date.now()),
			// Read per consumption so settings changes apply live; the out-of-contract diagnostic routes through the
			// facade's logger.
			() => getDiscoveryStaleServeWindow((message, data) => this.log(message, data)),
			() => this._onDidObserveGroupEmitter.fire()
		);
		this._reporter = new GroupStatusReporter(this._statusWindow);
		this._decorator = new ServedModelDecorator({
			getEntryModelCapabilities: options.getEntryModelCapabilities ?? (() => undefined),
			getEntryDeclaredModels: options.getEntryDeclaredModels ?? (() => undefined),
			getCatalogLookup: options.getCatalogLookup ?? (() => EMPTY_CATALOG_LOOKUP),
			resolution: this._resolution,
			log: (message, data) => this.log(message, data),
			logAdvisory: (message, data) => this.logAdvisory(message, data),
		});
		this._discovery = new GroupDiscovery({
			client: this._client,
			cache: this._discoveryCache,
			reporter: this._reporter,
			window: this._statusWindow,
			decorator: this._decorator,
			getEntryApiVersion: options.getEntryApiVersion ?? (() => undefined),
			getExpectedFailures: options.getExpectedFailures ?? (() => undefined),
			getEntryIncludeModes: options.getEntryIncludeModes ?? (() => undefined),
			isGroupSuppressed: options.isGroupSuppressed ?? (() => false),
			log: (message, data) => this.log(message, data),
			logFailure: (message, data, error) => this.logger?.failure(message, data, error),
		});
	}

	setStatusCallback(callback: (status: AggregatedStatus) => void): void {
		this._reporter.setCallback(callback);
	}

	private log(message: string, data?: unknown): void {
		this.logger?.log(message, data);
	}

	private logAdvisory(message: string, data?: unknown): void {
		this.logger?.advisory(message, data);
	}

	private logError(message: string, error: unknown): void {
		this.logger?.error(message, error);
	}

	getServerSnapshots(): ServerModelsSnapshot[] {
		return this._statusWindow.snapshots();
	}

	/** The shared flat resolution table, for the dashboard's inspectors: the SAME cache requests read. */
	get resolutionTable(): ModelResolutionTable {
		return this._resolution;
	}

	/**
	 * Whether the host handed over a group configuration whose serve is still running: with the status window, the
	 * configured-servers gate (wiring/provider.ts). The window records a group only when its serve finishes, so this
	 * is what proves servers exist in between; derived from the running serves, never remembered, so removing every
	 * server mid-session reads as not configured once the window empties.
	 */
	hasGroupServeInFlight(): boolean {
		return this._groupServesInFlight.size > 0;
	}

	getGroupServer(serverId: string): GroupServer | undefined {
		return this._statusWindow.getGroupServer(serverId);
	}

	/** Non-secret; the sync engine's ownership evidence and ledger-less identity source. */
	observedGroupBaseUrls(label: string): readonly string[] {
		return this._statusWindow.observedGroupBaseUrls(label);
	}

	/**
	 * The label+URL identity the serve path resolves entry configuration (modelCapabilities, expectedFailures) against
	 * for one served server. The dashboard's inspector resolves its entry layer through this so it can never diverge
	 * from what requests use.
	 *   an unlabeled group, or a server no longer in the status window -> undefined
	 */
	capabilityEntryIdentity(serverId: string): EntryIdentity | undefined {
		const groupServer = this.getGroupServer(serverId);
		if (groupServer !== undefined && groupServer.label !== undefined) {
			return { label: groupServer.label, baseUrl: groupServer.baseUrl };
		}
		return undefined;
	}

	/**
	 * Clients and cached discovery results prune in lockstep, since both key on the group client ID and its
	 * credential fingerprint. The discovery keep-set composes through GroupDiscovery.cacheKeyFor like the keys
	 * themselves.
	 *   root rotated -> the old root's entry is unreachable and ages out here
	 */
	private pruneServerCaches(keep: readonly string[]): void {
		this._client.pruneClients(keep);
		this._discoveryCache.prune(
			this._statusWindow.groupServers().map((groupServer) => this._discovery.cacheKeyFor(groupServer))
		);
		this._resolution.prune(keep);
	}

	async provideLanguageModelChatInformation(
		options: PrepareLanguageModelChatModelOptions,
		_token: CancellationToken
	): Promise<LiteLLMModelInfo[]> {
		if (options.configuration !== undefined) {
			const serve = this.provideGroupModels(options.configuration, options.silent);
			this._groupServesInFlight.add(serve);
			try {
				return await serve;
			} finally {
				this._groupServesInFlight.delete(serve);
			}
		}

		// The group-agnostic call serves nothing: every model is served through a per-group refresh, and the host makes
		// those calls itself.
		this.log("provideLanguageModelChatInformation called", { silent: options.silent });
		this._statusWindow.beginCycle();
		this.log("Serving no models for the group-agnostic refresh; models are served per provider group");
		this.pruneServerCaches(this._statusWindow.serverIds());
		// Keeps the status bar tracking group removals: once the last group ages out of the window, this reports empty.
		this._reporter.reportMerged(options.silent);
		return [];
	}

	/** Model IDs are returned raw and display names unprefixed because the host namespaces group models itself. */
	private async provideGroupModels(configuration: unknown, silent: boolean): Promise<LiteLLMModelInfo[]> {
		const parsed = parseGroupConfiguration(configuration);
		if (!parsed) {
			this.log("Ignoring provider-group refresh with malformed configuration (baseUrl must be a URL with a host)");
			return [];
		}
		// The baked copy's rejections are logged, not refused: a declared entry's current copy is judged by the overlay
		// below, and an external group has no entry to refuse for.
		logCredentialRejections((message, data) => this.log(message, data), parsed.rejections);
		const baked = parsed.server;
		// The serve generation is claimed BEFORE the overlay's secrets read (the overlay never changes label or base
		// URL, so the pre-overlay parse is a valid claim): a serve that stalls in the resolver while a newer one
		// completes must yield its record, and only arrival order can decide that.
		const generation = this._discovery.beginServe(baked);
		const overlaid = await overlayEntryCredentials(baked, this._resolveEntryCredentials);

		const serverId = groupClientId(overlaid.server);
		if (this._statusWindow.beginCycleOnReSight(serverId, overlaid.server)) {
			this.pruneServerCaches([...this._statusWindow.serverIds(), serverId]);
		}

		const models = await this._discovery.fetchGroupModels(overlaid.server, silent, generation, overlaid.failure);
		// A rotation's record replaced the group's client ID in the window, so the retired client's caches prune here.
		this.pruneServerCaches(this._statusWindow.serverIds());
		return models;
	}

	/**
	 * Fire the model-change event without the refresh round-trip bookkeeping. Used when the suppression predicate's
	 * answers change.
	 */
	notifyModelInformationChanged(): void {
		this._onDidChangeEmitter.fire();
	}

	/**
	 * The explicit refresh (Test Connection, Sync Models Now). One pass at a time: a second caller joins the running
	 * pass, so two passes cannot claim generations against each other's probes. The pass resolves only when the
	 * window holds this pass's outcome, so a caller reading the status afterwards reads it; `refreshedGroups` is how
	 * many group reports landed during the pass, and zero means nothing fresh was read.
	 *
	 *   host serves in flight    -> awaited first: a serve loading pre-refresh data still records (clear() only stops
	 *                               it storing), so it must land before the count starts, and its group is then in the
	 *                               window to be probed
	 *   the probes               -> one per windowed group, after clear(), so each reaches the network or joins a load
	 *                               begun after the clear; the overlay re-runs so a rotation since the group was
	 *                               recorded probes with current credentials
	 *   the change event, last   -> only when a probe changed what some group serves or how (its models, or the
	 *                               outcome the stale marking follows): the host then re-resolves from the cache the
	 *                               probes filled, and a pass that changed nothing asks no group twice (failed loads
	 *                               are never cached, so a re-resolve of a failing group is a new attempt)
	 *   reports landed           -> counted, not the probes: a probe yields its record to a newer serve that recorded
	 *                               first (groupDiscovery.ts), and that serve's record is the pass's then
	 */
	refreshGroups(): Promise<{ readonly refreshedGroups: number }> {
		this._refreshPass ??= this.runRefreshPass().finally(() => {
			this._refreshPass = undefined;
		});
		return this._refreshPass;
	}

	private async runRefreshPass(): Promise<{ readonly refreshedGroups: number }> {
		// Exactly the serves in flight at pass start: one that starts later records on its own, and waiting for it
		// would let a host that keeps starting serves hold the pass (and the dashboard's Retry) open forever.
		await Promise.allSettled([...this._groupServesInFlight]);
		const reportsBefore = this._reporter.groupReportCount;
		const servedBefore = this.servedModelsKey();
		this._discoveryCache.clear();
		// Only the groups the host served this cycle: a group it deleted is still in the window's one-cycle grace, and
		// a probe would record it fresh and keep it on every surface for as long as the user keeps syncing.
		await Promise.all(
			this._statusWindow.currentCycleGroupServers().map(async (groupServer) => {
				try {
					// Claimed before the overlay's await, like provideGroupModels.
					const generation = this._discovery.beginServe(groupServer);
					const overlaid = await overlayEntryCredentials(groupServer, this._resolveEntryCredentials);
					await this._discovery.fetchGroupModels(overlaid.server, false, generation, overlaid.failure);
				} catch {
					// Already logged and recorded in the merged status; the other group servers still get probed.
				}
			})
		);
		// Same lockstep re-derivation as provideGroupModels: a probe's record may have replaced a rotated group's
		// client ID.
		this.pruneServerCaches(this._statusWindow.serverIds());
		if (this.servedModelsKey() !== servedBefore) {
			this._onDidChangeEmitter.fire();
		}
		return { refreshedGroups: this._reporter.groupReportCount - reportsBefore };
	}

	/**
	 * What every group serves right now and how, as one comparable key. The window records undecorated models while a
	 * silent failure hands the host stale-marked ones (groupDiscovery.ts markStale), so the outcome rides beside the
	 * models: a group that went from healthy to failing, or back, must re-resolve even with the same model list.
	 */
	private servedModelsKey(): string {
		return JSON.stringify(
			this._statusWindow
				.snapshots()
				.map(
					({ status, models }) =>
						[
							status.serverId,
							status.state,
							status.state === "error" ? status.cause : undefined,
							status.servedModelCount,
							models,
						] as const
				)
				.sort(([a], [b]) => a.localeCompare(b))
		);
	}

	async provideLanguageModelChatResponse(
		model: LiteLLMModelInfo,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken
	): Promise<void> {
		const trackingProgress: Progress<LanguageModelResponsePart> = {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					this.logError("Progress.report failed", e);
				}
			},
		};
		try {
			// The one parse of the model object's LiteLLM metadata for this request.
			const metadata = parseModelMetadata(model);
			const server = await this.liveGroupServer(model.id, metadata.group);
			await this._client.send({ metadata, server, messages, options, progress: trackingProgress, token });
		} catch (err) {
			// User-initiated cancellation is not an error; logging it would pollute the issue-report buffer and clobber
			// the latest real error. A mapped error's English mirror quotes the response body, so the line is the
			// error's classification and the error itself goes only to the recorder.
			if (!(err instanceof CancellationError)) {
				logFailure((message, data, error) => this.logger?.failure(message, data, error), "Chat request failed", err);
			}
			// Only the throw is wrapped, so the boundary still logs exactly once and keeps the classification.
			throw toLanguageModelError(err);
		}
	}

	/**
	 * A model object names its group; the connection is the window's current one under the entry's current
	 * credentials, so a rotation reaches the very next request, and a model whose group identity has left the window
	 * (or that this provider never served) fails before anything is sent.
	 */
	private async liveGroupServer(modelId: string, group: string | undefined): Promise<GroupServer> {
		if (group === undefined) {
			throw unroutableModelError(modelId, "no group identity");
		}
		const recorded = this._statusWindow.getGroupServerByIdentity(group);
		if (recorded === undefined) {
			throw unroutableModelError(modelId, "group not served");
		}
		const overlaid = await overlayEntryCredentials(recorded, this._resolveEntryCredentials);
		if (overlaid.failure !== undefined) {
			throw overlaid.failure;
		}
		return overlaid.server;
	}

	async provideTokenCount(
		model: LiteLLMModelInfo,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		if (typeof text === "string") {
			return countTextTokens(text);
		}
		// The same capability gates the chat path sends under, so the host's budget prices the same transmitted forms
		// the request would carry. Known overcount: pricing one message at a time synthesizes the tool-image lead-in
		// per message where the real request emits it once per turn (~10 tokens, the safe direction).
		const metadata = parseModelMetadata(model);
		return estimateMessagesTokens([text], {
			imageInput: metadata.imageInput,
			audioInput: metadata.supportsAudioInput,
		});
	}
}
