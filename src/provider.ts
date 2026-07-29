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
import { ChatClient, type ServerConnection } from "./provider/chatClient";
import type { ConfigurationPrompt } from "./provider/config";
import { ensureServers } from "./provider/config";
import { DiscoveryCache } from "./provider/discoveryCache";
import type { GroupServer, LiteLLMModelInfo } from "./provider/groupModels";
import {
	attachGroupServer,
	groupClientId,
	groupServerLabel,
	isGroupClientId,
	parseGroupConfiguration,
} from "./provider/groupModels";
import type { ModelRoute } from "./provider/modelCatalog";
import { buildModelInfos } from "./provider/registration";
import type { Logger } from "./shared/logger";
import type { AggregatedStatus, ServerStatus, ServerWithKey } from "./shared/servers";
import { getDiscoveryCacheTtl, getTokenDefaults } from "./shared/settings";
import { CHARS_PER_TOKEN, estimateMessagesTokens } from "./shared/tokenEstimation";

/** Rolling status entries and their cached clients are evicted when not refreshed within this window. */
const STATUS_TTL_MS = 10 * 60 * 1000;

/**
 * One server's slice of the status window, for read-only consumers (the
 * dashboard). `models` are the infos as built by registration, before any
 * group server is attached, so a snapshot never carries credentials.
 */
export interface ServerModelsSnapshot {
	readonly status: ServerStatus;
	readonly models: readonly LiteLLMModelInfo[];
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
	private readonly _discoveryCache: DiscoveryCache<readonly LiteLLMModelInfo[]>;
	private _statusCallback?: (status: AggregatedStatus) => void;
	private _getServers?: () => Promise<ServerWithKey[]>;
	private _configurationPrompt?: ConfigurationPrompt;
	private _grouplessRegistryEnabled?: () => boolean;
	// The host fetches each provider group in its own call, so no single call
	// sees the whole picture. Statuses accumulate here keyed by server ID; the
	// group-agnostic call (normally the first of a refresh cycle) advances the
	// cycle counter. An entry survives the cycle after its last report and is
	// evicted at the second cycle boundary; that one-cycle grace is
	// load-bearing: it keeps servers not yet re-fetched in the current sweep
	// visible, so the merged view never flickers mid-sweep. Two fallbacks
	// cover hosts that skip the group-agnostic call: re-seeing a group within
	// one cycle also starts a new cycle, and entries untouched for
	// STATUS_TTL_MS go regardless.
	private _statusCycle = 0;
	private readonly _serverStatuses = new Map<
		string,
		{
			cycle: number;
			at: number;
			status: ServerStatus;
			models: readonly LiteLLMModelInfo[];
			groupServer?: GroupServer;
		}
	>();
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

	constructor(
		userAgent: string,
		private readonly logger?: Logger,
		discoveryCache?: DiscoveryCache<readonly LiteLLMModelInfo[]>
	) {
		this._client = new ChatClient({ userAgent, logger });
		this._discoveryCache = discoveryCache ?? new DiscoveryCache();
	}

	setStatusCallback(callback: (status: AggregatedStatus) => void): void {
		this._statusCallback = callback;
	}

	setServerProvider(getServers: () => Promise<ServerWithKey[]>): void {
		this._getServers = getServers;
		this._client.setServerProvider(getServers);
	}

	setConfigurationPrompt(prompt: ConfigurationPrompt): void {
		this._configurationPrompt = prompt;
	}

	/**
	 * Gate for refreshes that arrive without a group configuration: while the
	 * gate allows it (or no gate is set) they serve the server registry; once
	 * the registry is migrated to provider groups they serve nothing.
	 */
	setGrouplessRegistryEnabled(enabled: () => boolean): void {
		this._grouplessRegistryEnabled = enabled;
	}

	setMigratedServerLabels(getLabels: () => Record<string, string[]>): void {
		this._client.setMigratedServerLabelsProvider(getLabels);
	}

	private log(message: string, data?: unknown): void {
		this.logger?.log(message, data);
	}

	private logError(message: string, error: unknown): void {
		this.logger?.error(message, error);
	}

	private beginStatusCycle(): void {
		this._statusCycle += 1;
		const now = Date.now();
		for (const [serverId, entry] of this._serverStatuses) {
			if (entry.cycle < this._statusCycle - 1 || now - entry.at > STATUS_TTL_MS) {
				this._serverStatuses.delete(serverId);
			}
		}
	}

	/**
	 * `models` must be the pre-attach infos (registration output), never the
	 * group-attached copies: getServerSnapshots hands them to the dashboard,
	 * and attached copies embed the server's credentials.
	 */
	private recordServerStatus(
		status: ServerStatus,
		models: readonly LiteLLMModelInfo[],
		groupServer?: GroupServer
	): void {
		const entry = {
			cycle: this._statusCycle,
			at: Date.now(),
			status,
			models,
			...(groupServer ? { groupServer } : {}),
		};
		this._serverStatuses.set(status.serverId, entry);
	}

	/** The status window's current view for read-only consumers; see ServerModelsSnapshot. */
	getServerSnapshots(): ServerModelsSnapshot[] {
		return [...this._serverStatuses.values()].map((entry) => ({ status: entry.status, models: entry.models }));
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

	/**
	 * The resolved connection of a live provider group, looked up by the server
	 * ID its status snapshot carries. This is the extension layer's one path to
	 * a group's credentials (the dashboard's adopt action copies them into the
	 * servers setting; the group keeps its own); the value is handed to the
	 * caller only and must never be logged or pushed into webview state.
	 * Registry servers and aged-out groups resolve to undefined.
	 */
	getGroupServer(serverId: string): GroupServer | undefined {
		return this._serverStatuses.get(serverId)?.groupServer;
	}

	private groupClientIdsInStatuses(): string[] {
		return [...this._serverStatuses.keys()].filter(isGroupClientId);
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
		const serverStatuses = [...this._serverStatuses.values()].map((entry) => entry.status);
		const totalModels = serverStatuses.reduce((sum, s) => sum + (s.state === "ok" ? s.modelCount : 0), 0);
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
		this.beginStatusCycle();

		if (this._grouplessRegistryEnabled && !this._grouplessRegistryEnabled()) {
			this.log("Registry servers are migrated to provider groups; serving no models for the group-agnostic refresh");
			this.pruneServerCaches(this.groupClientIdsInStatuses());
			// The merged report keeps the status bar tracking group removals: once
			// the last group ages out of the window, this reports empty.
			this.reportMergedStatus(options.silent);
			return [];
		}

		const servers = await ensureServers(options.silent, this._getServers, this._configurationPrompt);
		if (!servers || servers.length === 0) {
			this.log("No servers configured, returning empty array");
			this.pruneServerCaches(this.groupClientIdsInStatuses());
			this.reportMergedStatus(options.silent);
			return [];
		}

		this.log("Fetching models from servers", { count: servers.length, labels: servers.map((s) => s.label) });
		this.pruneServerCaches([...servers.map((s) => s.id), ...this.groupClientIdsInStatuses()]);

		// One defaults snapshot for the whole sweep: discovery's deployment
		// merging and registration below must derive constraints from the same
		// values even if the settings change while servers are being fetched.
		const tokenDefaults = getTokenDefaults();

		// Each server's discovery outcome is tagged with its server inside the
		// map, so the loop below never has to re-pair results with servers by
		// index. A rejection is caught in place; nothing else here can throw.
		const results = await Promise.all(
			servers.map(async (server) => {
				try {
					const result = await this._client.fetchModels(server, tokenDefaults);
					return { server, outcome: { ok: true as const, models: result.models } };
				} catch (reason) {
					return { server, outcome: { ok: false as const, reason } };
				}
			})
		);

		const serverStatuses: ServerStatus[] = [];
		const allInfos: LiteLLMModelInfo[] = [];
		const allRoutes = new Map<string, ModelRoute>();
		const modelsByServer = new Map<string, readonly LiteLLMModelInfo[]>();

		const successfulCount = results.filter(({ outcome }) => outcome.ok).length;
		const serverCount = servers.length;

		for (const { server, outcome } of results) {
			if (!outcome.ok) {
				const errorMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
				this.logError(`Failed to fetch models from server "${server.label}"`, outcome.reason);
				serverStatuses.push({
					serverId: server.id,
					label: server.label,
					baseUrl: server.baseUrl,
					state: "error",
					modelCount: 0,
					error: errorMsg,
					lastChecked: new Date().toISOString(),
					hasApiKey: server.apiKey.length > 0,
				});
				continue;
			}

			const { models } = outcome;
			this.log(`Server "${server.label}" returned ${models.length} models`);

			const reg = buildModelInfos(models, server, serverCount, (msg) => this.log(msg), tokenDefaults);
			allInfos.push(...reg.infos);
			modelsByServer.set(server.id, reg.infos);
			for (const [k, v] of reg.routes) {
				allRoutes.set(k, v);
			}

			serverStatuses.push({
				serverId: server.id,
				label: server.label,
				baseUrl: server.baseUrl,
				state: "ok",
				modelCount: reg.infos.length,
				lastChecked: new Date().toISOString(),
				hasApiKey: server.apiKey.length > 0,
			});
		}

		// Registrations are only replaced after at least one server answered, so
		// existing routes survive a total outage.
		if (successfulCount > 0) {
			this._client.applyRegistration(allRoutes, true);
		}

		this.log("Final model count:", allInfos.length);

		for (const status of serverStatuses) {
			this.recordServerStatus(status, modelsByServer.get(status.serverId) ?? []);
		}
		this.reportMergedStatus(options.silent);

		if (successfulCount === 0 && servers.length > 0) {
			if (options.silent) {
				return [];
			}
			const firstError = serverStatuses.find((s) => s.error)?.error ?? "Unknown error";
			throw new Error(firstError);
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

		// Re-seeing a group that already reported in this cycle means a new
		// sweep started without a group-agnostic call marking it.
		const serverId = groupClientId(groupServer);
		const existing = this._serverStatuses.get(serverId);
		if (existing && existing.cycle === this._statusCycle) {
			this.beginStatusCycle();
			this.pruneServerCaches([...this._serverStatuses.keys(), serverId]);
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
			label: groupServerLabel(groupServer.baseUrl),
			baseUrl: groupServer.baseUrl,
			apiKey: groupServer.apiKey,
			...(groupServer.oauth !== undefined ? { oauth: groupServer.oauth } : {}),
			...(groupServer.virtualKey !== undefined ? { virtualKey: groupServer.virtualKey } : {}),
		};
		const attach = (infos: readonly LiteLLMModelInfo[]): LiteLLMModelInfo[] =>
			infos.map((info) => attachGroupServer(info, groupServer));

		if (bypassCache) {
			this._discoveryCache.invalidate(server.id);
		} else {
			const ttl = getDiscoveryCacheTtl((msg, data) => this.log(msg, data));
			const cached = this._discoveryCache.lookup(server.id, ttl);
			if (cached !== undefined) {
				this.log("Serving provider group models from the discovery cache", {
					baseUrl: server.baseUrl,
					count: cached.length,
				});
				this.reportGroupStatus(server, groupServer, silent, { state: "ok", modelCount: cached.length }, cached);
				return attach(cached);
			}
		}

		this.log("Fetching models for provider group", { baseUrl: server.baseUrl, silent });
		try {
			const infos = await this._discoveryCache.fetch(server.id, async () => {
				// One defaults snapshot for this group's refresh; see the sweep above.
				const tokenDefaults = getTokenDefaults();
				const { models } = await this._client.fetchModels(server, tokenDefaults);
				return buildModelInfos(models, server, 1, (msg) => this.log(msg), tokenDefaults).infos;
			});
			this.log(`Provider group at ${server.baseUrl} returned ${infos.length} models`);
			this.reportGroupStatus(server, groupServer, silent, { state: "ok", modelCount: infos.length }, infos);
			return attach(infos);
		} catch (error) {
			this.logError(`Failed to fetch models for provider group at ${server.baseUrl}`, error);
			const message = error instanceof Error ? error.message : String(error);
			this.reportGroupStatus(server, groupServer, silent, { state: "error", modelCount: 0, error: message }, []);
			if (silent) {
				return [];
			}
			throw error instanceof Error ? error : new Error(message);
		}
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
		const groupServers = [...this._serverStatuses.values()]
			.map((entry) => entry.groupServer)
			.filter((groupServer): groupServer is GroupServer => groupServer !== undefined);
		for (const groupServer of groupServers) {
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
		outcome: Pick<ServerStatus, "state" | "modelCount" | "error">,
		/** Pre-attach infos only; see recordServerStatus. */
		models: readonly LiteLLMModelInfo[]
	): void {
		this._groupStatusReportCount += 1;
		this.recordServerStatus(
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
			groupServer
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
			throw err;
		}
	}

	async provideTokenCount(
		_model: LiteLLMModelInfo,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		if (typeof text === "string") {
			return Math.ceil(text.length / CHARS_PER_TOKEN);
		}
		return estimateMessagesTokens([text], { includeMultimodal: true });
	}
}
