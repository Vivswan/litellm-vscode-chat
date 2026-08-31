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
import { CancellationError, EventEmitter } from "vscode";
import type { CapabilityCatalogLookup, ModelCapabilitiesRecord } from "../shared/config/capabilityResolution";
import { EMPTY_CATALOG_LOOKUP } from "../shared/config/capabilityResolution";
import { ModelResolutionTable } from "../shared/config/resolutionTable";
import { getDiscoveryStaleServeWindow, getDiscoveryTimeout } from "../shared/config/settings";
import { countTextTokens } from "../shared/conversion/textTokens";
import { estimateMessagesTokens } from "../shared/conversion/tokenEstimation";
import type { Logger } from "../shared/logger";
import type { ExpectedFailureCategory } from "../shared/serverEntry";
import type { AggregatedStatus } from "../shared/servers";
import { DiscoveryCache } from "./catalog/discoveryCache";
import type { DiscoveredGroupModels } from "./catalog/groupDiscovery";
import { GroupDiscovery } from "./catalog/groupDiscovery";
import type { GroupCredentials, GroupServer, LiteLLMModelInfo } from "./catalog/groupModels";
import {
	groupClientId,
	overlayGroupCredentials,
	parseGroupConfiguration,
	parseModelMetadata,
} from "./catalog/groupModels";
import type { EntryIdentity } from "./catalog/servedModels";
import { ServedModelDecorator } from "./catalog/servedModels";
import { GroupStatusReporter } from "./catalog/statusReporting";
import type { ServerModelsSnapshot } from "./catalog/statusWindow";
import { StatusWindow } from "./catalog/statusWindow";
import { ChatClient } from "./transport/chatClient";
import { toLanguageModelError } from "./transport/errorMapping";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The deadline also bounds the host's own re-resolve round trip, which costs
 * the same however low discovery.timeout is configured, so a tiny timeout
 * must not make the host pass abandon almost instantly.
 */
const HOST_REFRESH_DEADLINE_FLOOR_MS = 8000;

/**
 * Headroom on top of the discovery timeout: a group report lands only after
 * the host's dispatch and the provider's post-fetch processing, neither
 * covered by the per-request discovery timeout.
 */
const HOST_REFRESH_DEADLINE_MARGIN_MS = 2000;

/**
 * refreshViaHost's default deadline: one full discovery attempt plus report
 * plumbing, never below the floor. Derived from discovery.timeout so raising
 * it cannot make the host pass give up while a slow fetch is still inside its
 * own budget.
 */
export function hostRefreshDeadlineMs(discoveryTimeoutMs: number): number {
	return Math.max(HOST_REFRESH_DEADLINE_FLOOR_MS, discoveryTimeoutMs + HOST_REFRESH_DEADLINE_MARGIN_MS);
}

/**
 * The default deadline exactly as refreshViaHost derives it. The host pass
 * races discovery fetches, so it reads the DISCOVERY timeout and chat.timeout
 * plays no part.
 */
export function defaultHostRefreshDeadlineMs(log?: (message: string, data?: unknown) => void): number {
	return hostRefreshDeadlineMs(getDiscoveryTimeout(log));
}

export interface LiteLLMChatModelProviderOptions {
	userAgent: string;
	logger?: Logger | undefined;
	/** Request-time resolver for a declared entry's per-entry modelParameters; see ChatClientOptions. */
	getEntryModelParameters?:
		| ((label: string, baseUrl: string) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined)
		| undefined;
	/**
	 * Registration-time resolver for a declared entry's per-entry
	 * modelCapabilities, matched by label and normalized base URL exactly like
	 * getEntryModelParameters.
	 */
	getEntryModelCapabilities?: ((label: string, baseUrl: string) => ModelCapabilitiesRecord | undefined) | undefined;
	/**
	 * Request- and discovery-time resolver for a declared entry's custom
	 * headers, matched like getEntryModelCapabilities. Headers live on the
	 * entry - there is no global headers setting.
	 */
	getEntryHeaders?: ((label: string, baseUrl: string) => Readonly<Record<string, string>> | undefined) | undefined;
	/**
	 * Request- and discovery-time resolver for a declared entry's apiVersion
	 * override (what apiRootOf appends to the base URL), matched like
	 * getEntryHeaders. "" is a real value (append nothing), distinct from
	 * undefined (auto-detect: keep a version segment already in the URL, else
	 * /v1).
	 */
	getEntryApiVersion?: ((label: string, baseUrl: string) => string | undefined) | undefined;
	/**
	 * Registration-time resolver for a declared entry's discovery.declared
	 * model IDs, matched like getEntryModelCapabilities. The IDs register
	 * whenever discovery does not list them - through any discovery failure
	 * type - and go inert when it does.
	 */
	getEntryDeclaredModels?: ((label: string, baseUrl: string) => readonly string[] | undefined) | undefined;
	/**
	 * Discovery-time resolver for a declared entry's expectedFailures
	 * categories, matched like getEntryModelCapabilities. A listed category's
	 * endpoint gets a single discovery attempt and its failure is downgraded
	 * to an expected, info-severity outcome.
	 */
	getExpectedFailures?:
		| ((label: string, baseUrl: string) => readonly ExpectedFailureCategory[] | undefined)
		| undefined;
	/**
	 * Serve- and request-time resolver for a declared entry's CURRENT
	 * credentials, matched by label and normalized base URL like
	 * getEntryHeaders. The host's provider-group configuration bakes the
	 * credentials in at group creation and can never be updated (the group
	 * command surface is add-only), so a labeled group's baked credentials are
	 * overlaid with the matching entry's live ones before anything derives
	 * identity from them; `undefined` (no matching entry, refused secret
	 * ownership, a failed secrets read) keeps the baked credentials in force -
	 * they remain the fallback for external groups and leftover groups whose
	 * entry moved hosts. Never rejects by contract; the facade still guards.
	 */
	resolveEntryCredentials?: ((label: string, baseUrl: string) => Promise<GroupCredentials | undefined>) | undefined;
	/**
	 * The OpenRouter capability catalog as in-memory lookup data (the catalog
	 * store owns files, network, and the opt-out; this layer only resolves).
	 * Read at serve time so a refreshed snapshot reaches the next attach
	 * without a rebuild. Defaults to the empty lookup: every catalog level
	 * answers not-found.
	 */
	getCatalogLookup?: (() => CapabilityCatalogLookup) | undefined;
	/**
	 * Whether a provider group was explicitly removed by the user, judged by
	 * the group's status label and normalized base URL. A suppressed group
	 * answers with an empty model list and skips the network entirely; its
	 * group-side status still reports, so the status window and the dashboard
	 * stay coherent. Default: nothing is suppressed.
	 */
	isGroupSuppressed?: ((label: string, baseUrl: string) => boolean) | undefined;
	/** Cache seam for tests (fake TTL clock); the provider owns a real one by default. */
	discoveryCache?: DiscoveryCache<DiscoveredGroupModels> | undefined;
	/** The status window's only clock seam; tests inject a fake. The default reads Date.now at call time. */
	now?: (() => number) | undefined;
}

/**
 * The vscode-facing facade.
 *
 * Error ownership lives here: transport and discovery modules construct
 * specific errors and throw without logging, and this facade is the SINGLE
 * logging boundary - it logs each failure once, and the composed modules log
 * only through callbacks bound to this class's logger. Cancellation surfaces
 * as vscode.CancellationError and is never logged.
 */
export class LiteLLMChatModelProvider implements LanguageModelChatProvider<LiteLLMModelInfo> {
	private readonly _client: ChatClient;
	// Pre-attach group discovery results, keyed by group client ID. The host
	// re-resolves groups in bursts, so cached sweeps must not hit the network.
	// Explicit refreshes reach it anyway: refreshViaHost clears the cache, and
	// testKnownGroupConnections invalidates each group it probes. The group
	// server is attached to the stored infos on every read, never cached.
	private readonly _discoveryCache: DiscoveryCache<DiscoveredGroupModels>;
	private readonly logger?: Logger | undefined;
	private readonly _statusWindow: StatusWindow;
	private readonly _reporter: GroupStatusReporter;
	private readonly _decorator: ServedModelDecorator;
	private readonly _discovery: GroupDiscovery;
	/** See LiteLLMChatModelProviderOptions.resolveEntryCredentials. */
	private readonly _resolveEntryCredentials?:
		| ((label: string, baseUrl: string) => Promise<GroupCredentials | undefined>)
		| undefined;
	// Sticky evidence that the host has handed this session at least one provider
	// group. Once seen it never resets, so the "not configured" surfaces stay
	// silent for a group-configured user even between refresh cycles, when the
	// live status window has aged its entries out.
	private _hasSeenGroupConfiguration = false;
	private readonly _onDidChangeEmitter = new EventEmitter<void>();
	/**
	 * The precomputed flat resolution table: one instance shared by the chat
	 * request path, registration, and the dashboard's inspectors, so every
	 * consumer reads the same cache. Input-fingerprinted, so settings, entry,
	 * and discovery changes reach the next lookup without event plumbing.
	 */
	private readonly _resolution = new ModelResolutionTable();
	/** Fired to make the host re-resolve the group-agnostic call and every group through this provider. */
	readonly onDidChangeLanguageModelChatInformation: Event<void> = this._onDidChangeEmitter.event;

	constructor(options: LiteLLMChatModelProviderOptions) {
		this.logger = options.logger;
		this._resolveEntryCredentials = options.resolveEntryCredentials;
		this._client = new ChatClient({
			userAgent: options.userAgent,
			logger: options.logger,
			getEntryModelParameters: options.getEntryModelParameters,
			getEntryHeaders: options.getEntryHeaders,
			getEntryApiVersion: options.getEntryApiVersion,
			resolveEntryCredentials: options.resolveEntryCredentials,
			resolution: this._resolution,
		});
		this._discoveryCache = options.discoveryCache ?? new DiscoveryCache();
		this._statusWindow = new StatusWindow(
			options.now ?? (() => Date.now()),
			// Read per consumption so settings changes apply live; the clamp
			// warning routes through the facade's logger.
			() => getDiscoveryStaleServeWindow((message, data) => this.log(message, data))
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
			isGroupSuppressed: options.isGroupSuppressed ?? (() => false),
			log: (message, data) => this.log(message, data),
			logError: (message, error) => this.logError(message, error),
		});
	}

	setStatusCallback(callback: (status: AggregatedStatus) => void): void {
		this._reporter.setCallback(callback);
	}

	private log(message: string, data?: unknown): void {
		this.logger?.log(message, data);
	}

	/** Channel-only advisory notes; see Logger.advisory for why these bypass the issue-report buffer. */
	private logAdvisory(message: string, data?: unknown): void {
		this.logger?.advisory(message, data);
	}

	private logError(message: string, error: unknown): void {
		this.logger?.error(message, error);
	}

	/** The status window's current view for read-only consumers. */
	getServerSnapshots(): ServerModelsSnapshot[] {
		return this._statusWindow.snapshots();
	}

	/** The shared flat resolution table, for the dashboard's inspectors: the SAME cache requests read. */
	get resolutionTable(): ModelResolutionTable {
		return this._resolution;
	}

	/**
	 * Whether the host has handed this session any provider-group configuration.
	 * Sticky: the "not configured" surfaces consult it so a group-configured user
	 * is never told they have no servers at cold start.
	 */
	hasSeenGroupConfiguration(): boolean {
		return this._hasSeenGroupConfiguration;
	}

	/** A live group's resolved connection by snapshot server ID; see StatusWindow.getGroupServer for handling rules. */
	getGroupServer(serverId: string): GroupServer | undefined {
		return this._statusWindow.getGroupServer(serverId);
	}

	/**
	 * The label+URL identity the serve path resolves entry configuration
	 * (modelCapabilities, expectedFailures) against for one served server, or
	 * undefined when no entry can match (an unlabeled group, or a server no
	 * longer in the status window). The dashboard's inspector resolves its
	 * entry layer through this so it can never diverge from what requests use.
	 */
	capabilityEntryIdentity(serverId: string): EntryIdentity | undefined {
		const groupServer = this.getGroupServer(serverId);
		if (groupServer !== undefined && groupServer.label !== undefined) {
			return { label: groupServer.label, baseUrl: groupServer.baseUrl };
		}
		return undefined;
	}

	/**
	 * Evict per-server state for servers no longer being served: SDK clients
	 * and cached discovery results move in lockstep, because both embed the
	 * server's credentials (a rotated key mints a new group client ID). The
	 * discovery cache keys compose the group ID with the effective API root
	 * (GroupDiscovery.cacheKeyFor), so its keep-set is built through the same
	 * composition: a kept group keeps exactly its current-root entry, and an
	 * entry a root rotation left unreachable ages out here. A kept ID the
	 * status window cannot resolve (never observed today: every windowed ID
	 * carries its group server) contributes no key, which fails safe - the
	 * worst case is one extra discovery round trip, never a wrongly kept
	 * credential-bearing entry.
	 */
	private pruneServerCaches(keep: readonly string[]): void {
		this._client.pruneClients(keep);
		this._discoveryCache.prune(
			keep.flatMap((serverId) => {
				const groupServer = this._statusWindow.getGroupServer(serverId);
				return groupServer !== undefined ? [this._discovery.cacheKeyFor(groupServer)] : [];
			})
		);
		this._resolution.prune(keep);
	}

	async provideLanguageModelChatInformation(
		options: PrepareLanguageModelChatModelOptions,
		_token: CancellationToken
	): Promise<LiteLLMModelInfo[]> {
		// The host passes the group's configuration for per-group refreshes.
		if (options.configuration !== undefined) {
			// The host only hands a group configuration for a group that exists, so
			// this is proof the session has configured servers even before the
			// group's own status report lands.
			this._hasSeenGroupConfiguration = true;
			return this.provideGroupModels(options.configuration, options.silent);
		}

		// The group-agnostic call serves nothing: every model is served through
		// a per-group refresh, and the host makes those calls itself.
		this.log("provideLanguageModelChatInformation called", { silent: options.silent });
		this._statusWindow.beginCycle();
		this.log("Serving no models for the group-agnostic refresh; models are served per provider group");
		this.pruneServerCaches(this._statusWindow.serverIds());
		// Keeps the status bar tracking group removals: once the last group ages
		// out of the window, this reports empty.
		this._reporter.reportMerged(options.silent);
		return [];
	}

	/**
	 * Overlay a labeled group's baked credentials with its declared entry's
	 * current ones (see LiteLLMChatModelProviderOptions.resolveEntryCredentials).
	 * Applied before anything derives identity from the server, so the client
	 * ID, discovery cache key, and status window all describe the credentials
	 * requests actually use. A resolver failure keeps the baked credentials:
	 * the facade is the logging boundary, so the failure is logged once here.
	 */
	private async overlayEntryCredentials(server: GroupServer): Promise<GroupServer> {
		if (server.label === undefined || this._resolveEntryCredentials === undefined) {
			return server;
		}
		try {
			const credentials = await this._resolveEntryCredentials(server.label, server.baseUrl);
			return credentials !== undefined ? overlayGroupCredentials(server, credentials) : server;
		} catch (error) {
			this.logError("Resolving a declared entry's credentials failed; using the group's stored credentials", error);
			return server;
		}
	}

	/**
	 * Serve one VS Code-managed provider group. Model IDs are returned raw and
	 * display names unprefixed because the host namespaces group models itself.
	 */
	private async provideGroupModels(configuration: unknown, silent: boolean): Promise<LiteLLMModelInfo[]> {
		const parsed = parseGroupConfiguration(configuration, (message, data) => this.log(message, data));
		if (!parsed) {
			this.log("Ignoring provider-group refresh with malformed configuration (baseUrl must be a string)");
			return [];
		}
		// The serve generation is claimed BEFORE the overlay's secrets read (the
		// overlay never changes label or base URL, so the pre-overlay parse is a
		// valid claim): a serve that stalls in the resolver while a newer one
		// completes must yield its record, and only arrival order can decide that.
		const generation = this._discovery.beginServe(parsed);
		const groupServer = await this.overlayEntryCredentials(parsed);

		// Re-seeing a group within one unmarked cycle means a new sweep started
		// without a group-agnostic call; the window decides (marked cycles are
		// host-driven and never restart mid-sweep; see StatusWindow).
		const serverId = groupClientId(groupServer);
		if (this._statusWindow.beginCycleOnReSight(serverId)) {
			this.pruneServerCaches([...this._statusWindow.serverIds(), serverId]);
		}

		return this._discovery.fetchGroupModels(groupServer, silent, false, generation);
	}

	/**
	 * Fire the model-change event without the refresh round-trip bookkeeping.
	 * Used when the suppression predicate's answers change, so the picker
	 * reflects the change immediately.
	 */
	notifyModelInformationChanged(): void {
		this._onDidChangeEmitter.fire();
	}

	/**
	 * Ask the host to re-resolve this provider by firing the change event. The
	 * wait is bounded and armed only by per-group reports (the groupless report
	 * alone proves nothing about groups), resolving once group reports have gone
	 * quiet for `quietMs`, or at `deadlineMs`. Zero group reports by the deadline
	 * (the event went nowhere, or the host only made the groupless call) falls
	 * back to probing the group servers already observed in the status window.
	 */
	async refreshViaHost(deadlineMs?: number, quietMs = 500): Promise<void> {
		const deadline = deadlineMs ?? defaultHostRefreshDeadlineMs((message, data) => this.log(message, data));
		// Every caller wants a real round trip (Test Connection, Sync Models Now),
		// so the discovery cache is dropped first; clear() detaches in-flight
		// loads, so they cannot re-store pre-drop data.
		this._discoveryCache.clear();
		const groupReportsBefore = this._reporter.groupReportCount;
		this._onDidChangeEmitter.fire();

		const start = Date.now();
		let lastCount = groupReportsBefore;
		let lastChangeAt = Date.now();
		while (Date.now() - start < deadline) {
			await delay(50);
			if (this._reporter.groupReportCount !== lastCount) {
				lastCount = this._reporter.groupReportCount;
				lastChangeAt = Date.now();
			} else if (lastCount > groupReportsBefore && Date.now() - lastChangeAt >= quietMs) {
				return;
			}
		}
		if (lastCount === groupReportsBefore) {
			this.log("The host did not re-resolve any group after the model-change event; probing known group servers");
			await this.testKnownGroupConnections();
		}
	}

	/**
	 * Fetch models from every group server observed in the status window: a
	 * real network round trip per group. Fallback for hosts that do not react
	 * to the change event; outcomes land in the merged status. Windowed group
	 * servers were overlaid when they were recorded, but the overlay re-runs
	 * here so a rotation since that serve still probes with current
	 * credentials.
	 */
	async testKnownGroupConnections(): Promise<void> {
		for (const groupServer of this._statusWindow.groupServers()) {
			try {
				// Claimed before the overlay's await, like provideGroupModels.
				const generation = this._discovery.beginServe(groupServer);
				await this._discovery.fetchGroupModels(
					await this.overlayEntryCredentials(groupServer),
					false,
					true,
					generation
				);
			} catch {
				// Already logged and recorded in the merged status; the remaining
				// group servers still get probed.
			}
		}
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
			await this._client.send({ model, messages, options, progress: trackingProgress, token });
		} catch (err) {
			// User-initiated cancellation is not an error; logging it would
			// pollute the issue-report buffer and clobber the latest real error.
			if (!(err instanceof CancellationError)) {
				this.logError("Chat request failed", err);
			}
			// Only the throw is wrapped, so the boundary still logs exactly once
			// and keeps the classification.
			throw toLanguageModelError(err);
		}
	}

	async provideTokenCount(
		model: LiteLLMModelInfo,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		if (typeof text === "string") {
			return countTextTokens(text);
		}
		// The same capability gates the chat path sends under, so the host's
		// budget prices the same transmitted forms the request would carry.
		// Known overcount: pricing one message at a time synthesizes the
		// tool-image lead-in per message where the real request emits it once
		// per turn (~10 tokens, the safe direction).
		const metadata = parseModelMetadata(model, (message, data) => this.log(message, data));
		return estimateMessagesTokens([text], {
			imageInput: metadata.imageInput,
			audioInput: metadata.supportsAudioInput,
		});
	}
}
