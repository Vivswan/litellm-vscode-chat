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
import { ChatClient } from "./provider/chatClient";
import type { ConfigurationPrompt } from "./provider/config";
import { ensureServers } from "./provider/config";
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
import { getTokenDefaults } from "./shared/settings";
import { CHARS_PER_TOKEN, estimateMessagesTokens } from "./shared/tokenEstimation";

/** Rolling status entries and their cached clients are evicted when not refreshed within this window. */
const STATUS_TTL_MS = 10 * 60 * 1000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LiteLLMChatModelProvider implements LanguageModelChatProvider<LiteLLMModelInfo> {
	private readonly _client: ChatClient;
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
		{ cycle: number; at: number; status: ServerStatus; groupServer?: GroupServer }
	>();
	// Counts per-group status reports only: the groupless report says nothing
	// about whether the host is re-resolving groups, so refreshViaHost's
	// settle-wait must not be armed by it.
	private _groupStatusReportCount = 0;
	private readonly _onDidChangeEmitter = new EventEmitter<void>();
	/** Fired to make the host re-resolve the group-agnostic call and every group through this provider. */
	readonly onDidChangeLanguageModelChatInformation: Event<void> = this._onDidChangeEmitter.event;

	constructor(
		userAgent: string,
		private readonly logger?: Logger
	) {
		this._client = new ChatClient({ userAgent, logger });
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

	private recordServerStatus(status: ServerStatus, groupServer?: GroupServer): void {
		const entry = { cycle: this._statusCycle, at: Date.now(), status, ...(groupServer ? { groupServer } : {}) };
		this._serverStatuses.set(status.serverId, entry);
	}

	private groupClientIdsInStatuses(): string[] {
		return [...this._serverStatuses.keys()].filter(isGroupClientId);
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
			return this.provideGroupModels(options.configuration, options.silent);
		}

		this.log("provideLanguageModelChatInformation called", { silent: options.silent });
		this.beginStatusCycle();

		if (this._grouplessRegistryEnabled && !this._grouplessRegistryEnabled()) {
			this.log("Registry servers are migrated to provider groups; serving no models for the group-agnostic refresh");
			this._client.pruneClients(this.groupClientIdsInStatuses());
			// The merged report keeps the status bar tracking group removals: once
			// the last group ages out of the window, this reports empty.
			this.reportMergedStatus(options.silent);
			return [];
		}

		const servers = await ensureServers(options.silent, this._getServers, this._configurationPrompt);
		if (!servers || servers.length === 0) {
			this.log("No servers configured, returning empty array");
			this._client.pruneClients(this.groupClientIdsInStatuses());
			this.reportMergedStatus(options.silent);
			return [];
		}

		this.log("Fetching models from servers", { count: servers.length, labels: servers.map((s) => s.label) });
		this._client.pruneClients([...servers.map((s) => s.id), ...this.groupClientIdsInStatuses()]);

		// One defaults snapshot for the whole sweep: discovery's deployment
		// merging and registration below must derive constraints from the same
		// values even if the settings change while servers are being fetched.
		const tokenDefaults = getTokenDefaults();

		const results = await Promise.allSettled(
			servers.map(async (server) => {
				const result = await this._client.fetchModels(server, tokenDefaults);
				return { server, models: result.models };
			})
		);

		const serverStatuses: ServerStatus[] = [];
		const allInfos: LiteLLMModelInfo[] = [];
		const allRoutes = new Map<string, ModelRoute>();

		const successfulCount = results.filter((r) => r.status === "fulfilled").length;
		const serverCount = servers.length;

		for (const [i, result] of results.entries()) {
			const server = servers[i];
			if (server === undefined) {
				// Unreachable: allSettled preserves input length; the guard exists
				// for noUncheckedIndexedAccess.
				continue;
			}

			if (result.status === "rejected") {
				const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
				this.logError(`Failed to fetch models from server "${server.label}"`, result.reason);
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

			const { models } = result.value;
			this.log(`Server "${server.label}" returned ${models.length} models`);

			const reg = buildModelInfos(models, server, serverCount, (msg) => this.log(msg), tokenDefaults);
			allInfos.push(...reg.infos);
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
			this.recordServerStatus(status);
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
		const groupServer = parseGroupConfiguration(configuration);
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
			this._client.pruneClients([...this._serverStatuses.keys(), serverId]);
		}

		return this.fetchGroupModels(groupServer, silent);
	}

	private async fetchGroupModels(groupServer: GroupServer, silent: boolean): Promise<LiteLLMModelInfo[]> {
		const server: ServerWithKey = {
			id: groupClientId(groupServer),
			label: groupServerLabel(groupServer.baseUrl),
			baseUrl: groupServer.baseUrl,
			apiKey: groupServer.apiKey,
		};
		this.log("Fetching models for provider group", { baseUrl: server.baseUrl, silent });

		try {
			// One defaults snapshot for this group's refresh; see the sweep above.
			const tokenDefaults = getTokenDefaults();
			const { models } = await this._client.fetchModels(server, tokenDefaults);
			const reg = buildModelInfos(models, server, 1, (msg) => this.log(msg), tokenDefaults);
			const infos = reg.infos.map((info) => attachGroupServer(info, groupServer));
			this.log(`Provider group at ${server.baseUrl} returned ${infos.length} models`);
			this.reportGroupStatus(server, groupServer, silent, { state: "ok", modelCount: infos.length });
			return infos;
		} catch (error) {
			this.logError(`Failed to fetch models for provider group at ${server.baseUrl}`, error);
			const message = error instanceof Error ? error.message : String(error);
			this.reportGroupStatus(server, groupServer, silent, { state: "error", modelCount: 0, error: message });
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
				await this.fetchGroupModels(groupServer, false);
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
		outcome: Pick<ServerStatus, "state" | "modelCount" | "error">
	): void {
		this._groupStatusReportCount += 1;
		this.recordServerStatus(
			{
				serverId: server.id,
				label: server.label,
				baseUrl: server.baseUrl,
				lastChecked: new Date().toISOString(),
				hasApiKey: groupServer.apiKey.length > 0,
				...outcome,
			},
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
