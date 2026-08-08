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
import { getDiscoveryCacheTtl, getModelCapabilitiesConfig } from "../shared/config/settings";
import { CHARS_PER_TOKEN, estimateMessagesTokens } from "../shared/conversion/tokenEstimation";
import type { TransportErrorClassification } from "../shared/errorClassification";
import type { Logger, LogSafeErrorText } from "../shared/logger";
import type { ExpectedFailureCategory } from "../shared/serverEntry";
import type { AggregatedStatus, ServerConfig, ServerStatus, ServerWithKey } from "../shared/servers";
import { isErrorServerStatus } from "../shared/servers";
import type { CapabilityOverrideOptions, DeclaredModelSynthesis } from "./catalog/capabilityOverrides";
import { applyCapabilityOverrides, synthesizeDeclaredModels } from "./catalog/capabilityOverrides";
import type { ExpectedDiscoveryFailures } from "./catalog/discovery";
import { DiscoveryCache } from "./catalog/discoveryCache";
import type { AttachedModelInfo, GroupServer, LiteLLMModelInfo, PreAttachModelInfo } from "./catalog/groupModels";
import {
	attachGroupServer,
	groupClientId,
	groupServerLabel,
	markStale,
	parseGroupConfiguration,
	parseModelMetadata,
} from "./catalog/groupModels";
import type { ModelRoute } from "./catalog/modelCatalog";
import { buildModelInfos } from "./catalog/registration";
import type { ServerModelsSnapshot } from "./catalog/statusWindow";
import { StatusWindow } from "./catalog/statusWindow";
import type { ConfigurationPrompt } from "./config";
import { ensureServers } from "./config";
import { ChatClient, type ServerConnection } from "./transport/chatClient";
import { statusErrorTexts, toLanguageModelError } from "./transport/errorMapping";

export type { ServerModelsSnapshot } from "./catalog/statusWindow";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One server's cached discovery result: the registered infos plus the raw
 * model IDs discovery returned. Cache hits need the raw-ID set for `_declare`
 * inertness - the registered infos alone may hold only synthetic variants
 * (`foo:cheapest`) of a discovered `foo`, and a `_declare` on `foo` must stay
 * inert. The cache stays configuration-free: overrides and declared models
 * are applied where models are served, never stored.
 */
export interface DiscoveredGroupModels {
	readonly infos: readonly PreAttachModelInfo[];
	readonly discoveredRawIds: readonly string[];
}

export interface LiteLLMChatModelProviderOptions {
	userAgent: string;
	logger?: Logger | undefined;
	/** Resolves the legacy registry's servers; defaults to an empty list for group-only hosts. */
	getServers?: (() => Promise<ServerWithKey[]>) | undefined;
	/** Request-time resolver for a declared entry's per-entry modelParameters; see ChatClientOptions. */
	getEntryModelParameters?:
		| ((label: string, baseUrl: string) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined)
		| undefined;
	/**
	 * Registration-time resolver for a declared entry's per-entry
	 * modelCapabilities, matched by label and normalized base URL exactly like
	 * getEntryModelParameters. Injected by the extension layer; consumed where
	 * capability overrides are applied to attached models.
	 */
	getEntryModelCapabilities?: ((label: string, baseUrl: string) => ModelCapabilitiesRecord | undefined) | undefined;
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
	 * The OpenRouter capability catalog as in-memory lookup data, injected by
	 * the extension layer (the catalog store owns files, network, and the
	 * opt-out; this layer only resolves). Read at serve time so a refreshed
	 * snapshot reaches the next attach without a rebuild. Defaults to the
	 * empty lookup: every catalog level answers not-found.
	 */
	getCatalogLookup?: (() => CapabilityCatalogLookup) | undefined;
	/**
	 * Gate for refreshes that arrive without a group configuration: while it
	 * returns true (the default) they serve the server registry; once the
	 * registry is migrated to provider groups they serve nothing.
	 */
	grouplessRegistryEnabled?: (() => boolean) | undefined;
	/**
	 * Whether a provider group was explicitly removed by the user (the
	 * extension layer's tombstone store, injected here because this layer
	 * cannot import it). Judged by the group's status label and normalized
	 * base URL. A suppressed group answers with an empty model list and skips
	 * the network entirely; its group-side status still reports, so the
	 * status window and the dashboard stay coherent. Default: nothing is
	 * suppressed.
	 */
	isGroupSuppressed?: ((label: string, baseUrl: string) => boolean) | undefined;
	/** Cache seam for tests (fake TTL clock); the provider owns a real one by default. */
	discoveryCache?: DiscoveryCache<DiscoveredGroupModels> | undefined;
	/** The status window's only clock seam; tests inject a fake. The default reads Date.now at call time. */
	now?: (() => number) | undefined;
}

export class LiteLLMChatModelProvider implements LanguageModelChatProvider<LiteLLMModelInfo> {
	private readonly _client: ChatClient;
	// Pre-attach group discovery results, keyed by group client ID. The host
	// re-resolves groups in bursts, so cached sweeps must not hit the network.
	// Explicit refreshes reach it anyway: refreshViaHost clears the cache (and
	// the epoch guard keeps in-flight loads from re-storing pre-clear data)
	// before the host's re-resolution reads through and repopulates it, and
	// testKnownGroupConnections invalidates each group it probes. The group
	// server is attached to the stored infos on every read, never cached. The
	// legacy registry sweep is deliberately uncached: it fetches all servers
	// at once and aggregates errors, and it only serves pre-migration and
	// non-production hosts.
	private readonly _discoveryCache: DiscoveryCache<DiscoveredGroupModels>;
	private readonly logger?: Logger | undefined;
	private _statusCallback?: (status: AggregatedStatus) => void;
	private readonly _getServers: () => Promise<ServerWithKey[]>;
	/**
	 * The last registry sweep's server count and per-server identities, so
	 * declaredModelsForSnapshot and the dashboard's entry-layer resolution
	 * compose registry snapshots exactly as that sweep did (ID minting is
	 * count-dependent, entry resolution label-keyed).
	 */
	private _registrySweep: {
		serverCount: number;
		servers: ReadonlyMap<string, { label: string; baseUrl: string }>;
	} = { serverCount: 1, servers: new Map() };
	private readonly _getEntryModelCapabilities: (label: string, baseUrl: string) => ModelCapabilitiesRecord | undefined;
	private readonly _getExpectedFailures: (
		label: string,
		baseUrl: string
	) => readonly ExpectedFailureCategory[] | undefined;
	private readonly _getCatalogLookup: () => CapabilityCatalogLookup;
	private _configurationPrompt?: ConfigurationPrompt;
	private readonly _grouplessRegistryEnabled: () => boolean;
	private readonly _isGroupSuppressed: (label: string, baseUrl: string) => boolean;
	private readonly _statusWindow: StatusWindow;
	// Counts per-group status reports only: the groupless report says nothing
	// about whether the host is re-resolving groups, so refreshViaHost's
	// settle-wait must not be armed by it.
	private _groupStatusReportCount = 0;
	// Sticky evidence that the host has handed this session at least one provider
	// group: the host passes each group's configuration at prepare time. Once
	// seen it never resets, so the "not configured" surfaces stay silent for a
	// group-configured user even between refresh cycles, when the live status
	// window has aged its entries out. The groupless refresh runs before the
	// per-group refreshes, so this is the honest "servers exist" signal that the
	// live snapshot count cannot give at cold start.
	private _hasSeenGroupConfiguration = false;
	private readonly _onDidChangeEmitter = new EventEmitter<void>();
	/** Fired to make the host re-resolve the group-agnostic call and every group through this provider. */
	readonly onDidChangeLanguageModelChatInformation: Event<void> = this._onDidChangeEmitter.event;

	constructor(options: LiteLLMChatModelProviderOptions) {
		this.logger = options.logger;
		this._getServers = options.getServers ?? (() => Promise.resolve([]));
		this._getEntryModelCapabilities = options.getEntryModelCapabilities ?? (() => undefined);
		this._getExpectedFailures = options.getExpectedFailures ?? (() => undefined);
		this._getCatalogLookup = options.getCatalogLookup ?? (() => EMPTY_CATALOG_LOOKUP);
		this._grouplessRegistryEnabled = options.grouplessRegistryEnabled ?? (() => true);
		this._isGroupSuppressed = options.isGroupSuppressed ?? (() => false);
		this._client = new ChatClient({
			userAgent: options.userAgent,
			logger: options.logger,
			getServers: this._getServers,
			getEntryModelParameters: options.getEntryModelParameters,
		});
		this._discoveryCache = options.discoveryCache ?? new DiscoveryCache();
		this._statusWindow = new StatusWindow(options.now ?? (() => Date.now()));
	}

	setStatusCallback(callback: (status: AggregatedStatus) => void): void {
		this._statusCallback = callback;
	}

	setConfigurationPrompt(prompt: ConfigurationPrompt): void {
		this._configurationPrompt = prompt;
	}

	private log(message: string, data?: unknown): void {
		this.logger?.log(message, data);
	}

	private logError(message: string, error: unknown): void {
		this.logger?.error(message, error);
	}

	/** The status window's current view for read-only consumers; see ServerModelsSnapshot. */
	getServerSnapshots(): ServerModelsSnapshot[] {
		return this._statusWindow.snapshots();
	}

	/**
	 * Whether the host has handed this session any provider-group configuration.
	 * Sticky: the "not configured" surfaces consult it so a group-configured user
	 * is never told they have no servers at cold start, when the groupless
	 * refresh reports an empty window before the per-group refreshes arrive.
	 */
	hasSeenGroupConfiguration(): boolean {
		return this._hasSeenGroupConfiguration;
	}

	/** A live group's resolved connection by snapshot server ID; see StatusWindow.getGroupServer for handling rules. */
	getGroupServer(serverId: string): GroupServer | undefined {
		return this._statusWindow.getGroupServer(serverId);
	}

	/**
	 * The capability configuration one serve pass resolves against, assembled
	 * from the injected seams. `entryLabel` names the declared entry candidate
	 * (a group's configured label, a registry server's own); the injected
	 * resolver answers only when label and base URL identify the same declared
	 * entry, mirroring the request path's entry-parameters match.
	 */
	private capabilityOptions(server: ServerConfig, entryLabel: string | undefined): CapabilityOverrideOptions {
		return {
			globalCapabilities: getModelCapabilitiesConfig(),
			entryCapabilities:
				entryLabel !== undefined ? this._getEntryModelCapabilities(entryLabel, server.baseUrl) : undefined,
			catalog: this._getCatalogLookup(),
			log: (message, data) => this.log(message, data),
		};
	}

	/**
	 * Everything a serve pass hands out, derived from one discovery result and
	 * the CURRENT configuration: the discovered infos with capability
	 * overrides applied, and the `_declare`d models discovery did not list
	 * (inert against the discovered raw-ID set, suppressed on collision with a
	 * registered ID). Applied outside the discovery cache and the status
	 * window on purpose - a configuration edit reaches the next serve without
	 * a cache clear, and a removed `_declare` disappears immediately.
	 */
	private decorateServedModels(
		discovered: DiscoveredGroupModels,
		server: ServerConfig,
		serverCount: number,
		entryLabel: string | undefined
	): { overridden: readonly PreAttachModelInfo[]; declared: DeclaredModelSynthesis } {
		const opts = this.capabilityOptions(server, entryLabel);
		const overridden = applyCapabilityOverrides(discovered.infos, server, opts);
		const declared = synthesizeDeclaredModels(
			new Set(discovered.discoveredRawIds),
			new Set(overridden.map((info) => info.id)),
			server,
			serverCount,
			opts
		);
		return { overridden, declared };
	}

	/**
	 * The label+URL identity the serve path resolves entry configuration
	 * (modelCapabilities, expectedFailures) against for one served server, or
	 * undefined when no entry can match (an unlabeled group, or a registry
	 * server no sweep has seen). The dashboard's inspector resolves its entry
	 * layer through this so it can never diverge from what requests use.
	 */
	capabilityEntryIdentity(serverId: string): { label: string; baseUrl: string } | undefined {
		const groupServer = this.getGroupServer(serverId);
		if (groupServer !== undefined) {
			return groupServer.label !== undefined ? { label: groupServer.label, baseUrl: groupServer.baseUrl } : undefined;
		}
		return this._registrySweep.servers.get(serverId);
	}

	/**
	 * The `_declare`d models the current configuration synthesizes for one
	 * status-window snapshot, for the dashboard's state builder:
	 * getServerSnapshots() stays discovered-only (declared models are
	 * config-rebuilt every serve and never stored), so the dashboard merges
	 * this projection into each server's model list. The composition mirrors
	 * the serve paths exactly - groups decorate with count 1 and the group's
	 * own label, the registry sweep with its recorded count and per-server
	 * labels (status labels can be display fallbacks) - so the dashboard
	 * shows the same IDs, names, and entry-layer resolution the picker
	 * serves. Display-only, so record problems and suppressions do not
	 * re-log on every state push; the serve path already logged them.
	 */
	declaredModelsForSnapshot(snapshot: ServerModelsSnapshot): readonly PreAttachModelInfo[] {
		const { status } = snapshot;
		const identity = this.capabilityEntryIdentity(status.serverId);
		const serverCount = this.getGroupServer(status.serverId) !== undefined ? 1 : this._registrySweep.serverCount;
		const server: ServerConfig = {
			id: status.serverId,
			label: identity?.label ?? status.label,
			baseUrl: status.baseUrl,
		};
		return synthesizeDeclaredModels(
			new Set(snapshot.discoveredRawIds),
			new Set(snapshot.models.map((info) => info.id)),
			server,
			serverCount,
			{ ...this.capabilityOptions(server, identity?.label), log: () => {} }
		).infos;
	}

	/** The declared entry's expectedFailures for this server, or none for unlabeled and unmatched servers. */
	private expectedFailuresFor(entryLabel: string | undefined, baseUrl: string): readonly ExpectedFailureCategory[] {
		return (entryLabel !== undefined ? this._getExpectedFailures(entryLabel, baseUrl) : undefined) ?? [];
	}

	/** The entry's categories in discovery's per-endpoint shape; see ExpectedDiscoveryFailures. */
	private expectedDiscoveryFailures(entryLabel: string | undefined, baseUrl: string): ExpectedDiscoveryFailures {
		const categories = this.expectedFailuresFor(entryLabel, baseUrl);
		return { modelInfo: categories.includes("modelInfo"), modelListing: categories.includes("modelListing") };
	}

	/**
	 * Evict per-server state for servers no longer being served: SDK clients
	 * and cached discovery results move in lockstep, because both embed the
	 * server's credentials (a rotated key mints a new group client ID, so the
	 * old ID drops out of `keep` once its status ages out).
	 */
	private pruneServerCaches(keep: readonly string[]): void {
		this._client.pruneClients(keep);
		this._discoveryCache.prune(keep);
	}

	/** Report the union of the latest registry and group statuses, so one group's fetch never masks the others. */
	private reportMergedStatus(silent: boolean): void {
		if (!this._statusCallback) {
			return;
		}
		const serverStatuses = this._statusWindow.snapshots().map((snapshot) => snapshot.status);
		// Declared models serve through ANY discovery failure (config-rebuilt,
		// never discovered): the picker lists them, so the aggregate count must
		// match it whether or not the failure was expected.
		const totalModels = serverStatuses.reduce(
			(sum, s) => sum + (s.state === "ok" ? s.modelCount : (s.declaredModelCount ?? 0)),
			0
		);
		this._statusCallback({ serverStatuses, totalModels, silent });
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

		this.log("provideLanguageModelChatInformation called", { silent: options.silent });
		this._statusWindow.beginCycle();

		if (!this._grouplessRegistryEnabled()) {
			this.log("Registry servers are migrated to provider groups; serving no models for the group-agnostic refresh");
			this.pruneServerCaches(this._statusWindow.groupClientIds());
			// The merged report keeps the status bar tracking group removals: once
			// the last group ages out of the window, this reports empty.
			this.reportMergedStatus(options.silent);
			return [];
		}

		const servers = await ensureServers(options.silent, this._getServers, this._configurationPrompt);
		if (!servers || servers.length === 0) {
			this.log("No servers configured, returning empty array");
			this.pruneServerCaches(this._statusWindow.groupClientIds());
			this.reportMergedStatus(options.silent);
			return [];
		}

		this.log("Fetching models from servers", { count: servers.length, labels: servers.map((s) => s.label) });
		this.pruneServerCaches([...servers.map((s) => s.id), ...this._statusWindow.groupClientIds()]);

		// Each server's discovery outcome is tagged with its server inside the
		// map, so the loop below never has to re-pair results with servers by
		// index. A rejection is caught in place; nothing else here can throw.
		const results = await Promise.all(
			servers.map(async (server) => {
				try {
					const result = await this._client.fetchModels(
						server,
						this.expectedDiscoveryFailures(server.label, server.baseUrl)
					);
					return { server, outcome: { ok: true as const, models: result.models } };
				} catch (reason) {
					return { server, outcome: { ok: false as const, reason } };
				}
			})
		);

		const serverStatuses: ServerStatus[] = [];
		const allInfos: PreAttachModelInfo[] = [];
		const allRoutes = new Map<string, ModelRoute>();
		// Declared-model routes, kept apart so a total outage can still register
		// them additively (see the applyRegistration call below).
		const declaredRoutes = new Map<string, ModelRoute>();
		const modelsByServer = new Map<string, readonly PreAttachModelInfo[]>();
		const rawIdsByServer = new Map<string, readonly string[]>();

		const successfulCount = results.filter(({ outcome }) => outcome.ok).length;
		const serverCount = servers.length;
		// The sweep's composition facts, recorded for declaredModelsForSnapshot:
		// the projection must mint the same IDs and resolve the same entry
		// layer as this pass did (status labels can be display fallbacks).
		this._registrySweep = {
			serverCount,
			servers: new Map(servers.map((s) => [s.id, { label: s.label, baseUrl: s.baseUrl }])),
		};
		// The original thrown value of the first UNEXPECTED failing server, kept
		// so the all-failed throw below rethrows it instead of rebuilding an
		// Error from the display string (which would lose the classification and
		// leak the body when the caller logs it). Expected failures never set it
		// but keep their own first original for the all-expected rethrow.
		let firstFailureReason: unknown;
		let firstExpectedFailureReason: unknown;

		for (const { server, outcome } of results) {
			if (!outcome.ok) {
				const expected = this.expectedFailuresFor(server.label, server.baseUrl).includes("modelListing");
				// Declared models serve despite the failure, rebuilt from current
				// configuration (nothing was discovered, so nothing is inert).
				const { declared } = this.decorateServedModels(
					{ infos: [], discoveredRawIds: [] },
					server,
					serverCount,
					server.label
				);
				if (expected) {
					if (firstExpectedFailureReason === undefined) {
						firstExpectedFailureReason = outcome.reason;
					}
					// The one boundary log for an expected terminal failure: an info
					// classification instead of an error, keeping the issue-report
					// buffer clean of failures the user declared normal.
					this.log(`Model discovery failed (expected: modelListing) for server "${server.label}"`);
				} else {
					if (firstFailureReason === undefined) {
						firstFailureReason = outcome.reason;
					}
					this.logError(`Failed to fetch models from server "${server.label}"`, outcome.reason);
				}
				const texts = statusErrorTexts(outcome.reason);
				serverStatuses.push({
					serverId: server.id,
					label: server.label,
					baseUrl: server.baseUrl,
					state: "error",
					...texts,
					...(expected ? { expected: true } : {}),
					...(declared.infos.length > 0 ? { declaredModelCount: declared.infos.length } : {}),
					lastChecked: new Date().toISOString(),
					hasApiKey: server.apiKey.length > 0,
				});
				allInfos.push(...declared.infos);
				for (const [k, v] of declared.routes) {
					declaredRoutes.set(k, v);
				}
				continue;
			}

			const { models } = outcome;
			this.log(`Server "${server.label}" returned ${models.length} models`);

			const reg = buildModelInfos(models, server, serverCount, (msg) => this.log(msg));
			const discoveredRawIds = models.map((model) => model.id);
			const { overridden, declared } = this.decorateServedModels(
				{ infos: reg.infos, discoveredRawIds },
				server,
				serverCount,
				server.label
			);
			allInfos.push(...overridden, ...declared.infos);
			// The window keeps the DISCOVERED models only; declared models are
			// config-rebuilt on every serve and the dashboard merges them via
			// declaredModelsForSnapshot.
			modelsByServer.set(server.id, overridden);
			rawIdsByServer.set(server.id, discoveredRawIds);
			for (const [k, v] of reg.routes) {
				allRoutes.set(k, v);
			}
			for (const [k, v] of declared.routes) {
				declaredRoutes.set(k, v);
			}

			serverStatuses.push({
				serverId: server.id,
				label: server.label,
				baseUrl: server.baseUrl,
				state: "ok",
				modelCount: overridden.length + declared.infos.length,
				lastChecked: new Date().toISOString(),
				hasApiKey: server.apiKey.length > 0,
			});
		}

		for (const [k, v] of declaredRoutes) {
			allRoutes.set(k, v);
		}
		// Registrations are only replaced after at least one server answered, so
		// existing routes survive a total outage. Declared routes still land on
		// a total outage - additively, never replacing valid prior discovery
		// routes - because they are the only way registry-path chat can route a
		// declared model (the sole-server fallback cannot serve multi-server
		// setups).
		if (successfulCount > 0) {
			this._client.applyRegistration(allRoutes, true);
		} else if (declaredRoutes.size > 0) {
			this._client.applyRegistration(declaredRoutes, false);
		}

		this.log("Final model count:", allInfos.length);

		for (const status of serverStatuses) {
			this._statusWindow.record(
				status,
				modelsByServer.get(status.serverId) ?? [],
				{ kind: "registry" },
				rawIdsByServer.get(status.serverId) ?? []
			);
		}
		this.reportMergedStatus(options.silent);

		const firstFailure = serverStatuses.find(isErrorServerStatus);
		if (successfulCount === 0 && firstFailure !== undefined) {
			if (options.silent) {
				// The all-failed silent sweep still serves the declared models
				// (empty when none are declared, as it always was).
				return allInfos;
			}
			if (firstFailureReason === undefined && allInfos.length > 0) {
				// Every failure was expected and declarations exist: like the group
				// path's Test Connection rule, serve the declared set instead of
				// throwing; the statuses above keep the truthful errors.
				return allInfos;
			}
			// Like the group site below: the ORIGINAL error is rethrown so its
			// classification, kind, and status survive to the caller's log (an
			// all-expected sweep without declarations rethrows ITS first original
			// for the same reason).
			const reason = firstFailureReason ?? firstExpectedFailureReason;
			throw reason instanceof Error ? reason : new Error(firstFailure.error);
		}

		return allInfos;
	}

	/**
	 * Serve one VS Code-managed provider group: fetch models from the server
	 * named by the group's configuration and attach the resolved connection to
	 * every entry. Model IDs are returned raw and display names unprefixed
	 * because the host namespaces group models itself.
	 */
	private async provideGroupModels(configuration: unknown, silent: boolean): Promise<LiteLLMModelInfo[]> {
		const groupServer = parseGroupConfiguration(configuration, (message, data) => this.log(message, data));
		if (!groupServer) {
			this.log("Ignoring provider-group refresh with malformed configuration (baseUrl must be a string)");
			return [];
		}

		// Re-seeing a group within one unmarked cycle means a new sweep started
		// without a group-agnostic call; the window decides (marked cycles are
		// host-driven and never restart mid-sweep; see StatusWindow).
		const serverId = groupClientId(groupServer);
		if (this._statusWindow.beginCycleOnReSight(serverId)) {
			this.pruneServerCaches([...this._statusWindow.serverIds(), serverId]);
		}

		return this.fetchGroupModels(groupServer, silent);
	}

	/**
	 * Resolve one group's models, preferring the discovery cache: a fresh
	 * cached result is served without a network call but still reports its
	 * remembered outcome, so the merged status (and the cycle bookkeeping that
	 * ages groups out) stays live across cached sweeps. Cache misses go through
	 * the single-flight fetch, so a burst of host calls for one group costs one
	 * request; every caller still reports status once, like it always did.
	 * `bypassCache` (testKnownGroupConnections) drops the stored result first,
	 * forcing the network, and the fresh result repopulates the cache.
	 *
	 * The cache holds pre-attach infos; the group server is attached on every
	 * read, cached or fetched, so each sweep hands the host fresh objects and
	 * nothing the host mutates in place (like the group-name detail) can be
	 * pinned into later sweeps. Attaching the full group server (OAuth and
	 * virtual-key credentials included) also means cached sweeps route chat
	 * requests with the current credentials; the cache key is the group client
	 * ID, which fingerprints those credentials, so rotating any of them lands
	 * on a fresh cache entry.
	 */
	private async fetchGroupModels(
		groupServer: GroupServer,
		silent: boolean,
		bypassCache = false
	): Promise<LiteLLMModelInfo[]> {
		const server: ServerConnection = {
			id: groupClientId(groupServer),
			label: groupServer.label ?? groupServerLabel(groupServer.baseUrl),
			baseUrl: groupServer.baseUrl,
			apiKey: groupServer.apiKey,
			...(groupServer.oauth !== undefined ? { oauth: groupServer.oauth } : {}),
			...(groupServer.virtualKey !== undefined ? { virtualKey: groupServer.virtualKey } : {}),
		};
		const attach = (infos: readonly PreAttachModelInfo[]): AttachedModelInfo[] =>
			infos.map((info) => attachGroupServer(info, groupServer));

		// A group the user explicitly removed answers empty and never touches
		// the network or the cache. Its status still reports (as healthy with
		// zero models) so the status window ages it like any live group and the
		// dashboard's hidden-groups view sees a coherent snapshot. Unhiding
		// fires the change event; the host's re-resolution then lands back here
		// with the predicate answering false.
		if (this._isGroupSuppressed(server.label, groupServer.baseUrl)) {
			this.log("Provider group is hidden by an explicit user removal; serving no models", {
				baseUrl: server.baseUrl,
			});
			this.reportGroupStatus(server, groupServer, silent, { state: "ok", modelCount: 0 }, [], []);
			return [];
		}

		if (bypassCache) {
			this._discoveryCache.invalidate(server.id);
		} else {
			const ttl = getDiscoveryCacheTtl((msg, data) => this.log(msg, data));
			const cached = this._discoveryCache.lookup(server.id, ttl);
			if (cached !== undefined) {
				const { overridden, declared } = this.decorateServedModels(cached, server, 1, groupServer.label);
				this.log("Serving provider group models from the discovery cache", {
					baseUrl: server.baseUrl,
					count: overridden.length + declared.infos.length,
				});
				this.reportGroupStatus(
					server,
					groupServer,
					silent,
					{ state: "ok", modelCount: overridden.length + declared.infos.length },
					overridden,
					cached.discoveredRawIds
				);
				return attach([...overridden, ...declared.infos]);
			}
		}

		this.log("Fetching models for provider group", { baseUrl: server.baseUrl, silent });
		const expectedFailures = this.expectedDiscoveryFailures(groupServer.label, server.baseUrl);
		try {
			const discovered = await this._discoveryCache.fetch(server.id, async () => {
				const { models } = await this._client.fetchModels(server, expectedFailures);
				return {
					infos: buildModelInfos(models, server, 1, (msg) => this.log(msg)).infos,
					discoveredRawIds: models.map((model) => model.id),
				};
			});
			// Overrides and declared models are applied to what is SERVED, never
			// to what is cached or recorded: the cache and the window stay
			// configuration-free, so an edit reaches the very next serve.
			const { overridden, declared } = this.decorateServedModels(discovered, server, 1, groupServer.label);
			this.log(`Provider group at ${server.baseUrl} returned ${discovered.infos.length} models`);
			this.reportGroupStatus(
				server,
				groupServer,
				silent,
				{ state: "ok", modelCount: overridden.length + declared.infos.length },
				overridden,
				discovered.discoveredRawIds
			);
			return attach([...overridden, ...declared.infos]);
		} catch (error) {
			const expected = expectedFailures.modelListing;
			if (expected) {
				// The one boundary log for an expected terminal failure: an info
				// classification instead of an error (see the registry sweep).
				this.log(`Model discovery failed (expected: modelListing) for provider group`, {
					baseUrl: server.baseUrl,
				});
			} else {
				this.logError(`Failed to fetch models for provider group at ${server.baseUrl}`, error);
			}
			// Like the registry sweep: both status renderings are constructed at
			// this boundary (see statusErrorTexts).
			const texts = statusErrorTexts(error);
			// The window's last known models ride along with the error status, so
			// a group that just failed does not lose its last-served set: a silent
			// refresh returns those models decorated as stale (warning icon plus
			// hover banner) instead of making them vanish. Retention is anchored
			// to the last SUCCESSFUL discovery (see staleServableModels); the
			// banner names the same success time, so repeated failures cannot
			// make the data look freshly checked either. Past the window the
			// failure serves the empty list, as it always did. The window is the
			// honest source here - it is this session's live state, unlike the
			// extension layer's persisted status, which can be a stale prior
			// session's. Declared models are rebuilt from the current
			// configuration and merged in un-staled (they never depend on the
			// success anchor and never enter the window); a `_declare`d ID the
			// last discovery listed stays inert against the stale set. Test
			// Connection (non-silent) still throws, except that an expected
			// failure with declared models serves the declared set instead.
			const stale = this._statusWindow.staleServableModels(server.id);
			const { overridden, declared } = this.decorateServedModels(
				stale !== undefined
					? { infos: stale.models, discoveredRawIds: stale.discoveredRawIds }
					: { infos: [], discoveredRawIds: [] },
				server,
				1,
				groupServer.label
			);
			this.reportGroupStatus(
				server,
				groupServer,
				silent,
				{
					state: "error",
					...texts,
					...(expected ? { expected: true } : {}),
					...(declared.infos.length > 0 ? { declaredModelCount: declared.infos.length } : {}),
				},
				stale?.models ?? [],
				stale?.discoveredRawIds ?? []
			);
			if (silent) {
				const staleServed =
					stale !== undefined ? markStale(attach(overridden), new Date(stale.lastSuccessAt).toLocaleString()) : [];
				return [...staleServed, ...attach(declared.infos)];
			}
			if (expected && declared.infos.length > 0) {
				return attach(declared.infos);
			}
			throw error instanceof Error ? error : new Error(texts.error);
		}
	}

	/**
	 * Fire the model-change event without the refresh round-trip bookkeeping:
	 * the host re-resolves every group through this provider. Used when the
	 * suppression predicate's answers change (a group was hidden or unhidden),
	 * so the picker reflects the change immediately.
	 */
	notifyModelInformationChanged(): void {
		this._onDidChangeEmitter.fire();
	}

	/**
	 * Ask the host to re-resolve this provider by firing the change event: the
	 * host then makes the group-agnostic call and one call per configured
	 * group, a real round trip in both eras. The wait is bounded and armed
	 * only by per-group reports (the groupless report alone proves nothing
	 * about groups), resolving once group reports have gone quiet for
	 * `quietMs`, or at `deadlineMs`. Zero group reports by the deadline (the
	 * event went nowhere, or the host only made the groupless call) falls back
	 * to probing the group servers already observed in the status window.
	 */
	async refreshViaHost(deadlineMs = 8000, quietMs = 500): Promise<void> {
		// Every caller of this method wants a real round trip (Test Connection,
		// Sync Models Now), so the discovery cache is dropped first; the epoch
		// guard keeps in-flight loads from re-storing pre-drop data. The host's
		// re-resolution then reads through the empty cache and repopulates it.
		this._discoveryCache.clear();
		const groupReportsBefore = this._groupStatusReportCount;
		this._onDidChangeEmitter.fire();

		const start = Date.now();
		let lastCount = groupReportsBefore;
		let lastChangeAt = Date.now();
		while (Date.now() - start < deadlineMs) {
			await delay(50);
			if (this._groupStatusReportCount !== lastCount) {
				lastCount = this._groupStatusReportCount;
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
	 * to the change event; outcomes land in the merged status.
	 */
	async testKnownGroupConnections(): Promise<void> {
		for (const groupServer of this._statusWindow.groupServers()) {
			try {
				await this.fetchGroupModels(groupServer, false, true);
			} catch {
				// The failure is already logged and recorded in the merged status;
				// the remaining group servers still get probed.
			}
		}
	}

	private reportGroupStatus(
		server: ServerWithKey,
		groupServer: GroupServer,
		silent: boolean,
		outcome:
			| { state: "ok"; modelCount: number }
			| {
					state: "error";
					error: string;
					logSafeError: LogSafeErrorText;
					classification?: TransportErrorClassification;
					/** See ServerStatusError: the truthful error stays; presentation derives the downgrade. */
					expected?: boolean;
					declaredModelCount?: number;
			  },
		/** Discovered pre-attach infos only; declared models are config-rebuilt every serve and never recorded. */
		models: readonly PreAttachModelInfo[],
		/** The raw IDs discovery returned for `models`; see ServerModelsSnapshot.discoveredRawIds. */
		discoveredRawIds: readonly string[]
	): void {
		this._groupStatusReportCount += 1;
		this._statusWindow.record(
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
			{ kind: "group", groupServer },
			discoveredRawIds
		);
		this.reportMergedStatus(silent);
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
			// The ORIGINAL error is logged above; only the throw is wrapped, so
			// the boundary still logs exactly once and keeps the classification.
			throw toLanguageModelError(err);
		}
	}

	async provideTokenCount(
		model: LiteLLMModelInfo,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		if (typeof text === "string") {
			return Math.ceil(text.length / CHARS_PER_TOKEN);
		}
		// The same capability gates the chat path sends under, so the host's
		// budget prices the same transmitted forms the request would carry.
		const metadata = parseModelMetadata(model, (message, data) => this.log(message, data));
		return estimateMessagesTokens([text], {
			imageInput: metadata.imageInput,
			audioInput: metadata.supportsAudioInput,
		});
	}
}
