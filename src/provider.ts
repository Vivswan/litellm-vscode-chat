import type {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatProvider,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";
import * as vscode from "vscode";
import type { ServerStatus, ServerWithKey } from "./extension/serverRegistry";
import type { IssueReporter } from "./issueReporter";
import { sendChatRequest } from "./provider/client";
import { ensureServers } from "./provider/config";
import { fetchModels } from "./provider/discovery";
import { getCustomHeaders } from "./provider/httpHeaders";
import { buildModelInfos } from "./provider/registration";
import type { ModelRoute } from "./provider/request";

export interface AggregatedStatus {
	serverStatuses: ServerStatus[];
	totalModels: number;
}

export class LiteLLMChatModelProvider implements LanguageModelChatProvider {
	private _promptCachingSupport = new Map<string, boolean>();
	private _statusCallback?: (status: AggregatedStatus) => void;
	private _hasShownNoConfigNotification = false;
	private _toolCallIdCounter = 0;
	private _modelRoutes = new Map<string, ModelRoute>();
	private _getServers?: () => Promise<ServerWithKey[]>;

	/**
	 * In-flight model discovery promise. Used to coalesce concurrent
	 * `provideLanguageModelChatInformation` / `prepareLanguageModelChatInformation`
	 * invocations into a single network round-trip (single-flight).
	 */
	private _modelFetchInflight: Promise<LanguageModelChatInformation[]> | undefined;
	/**
	 * Cached model list, populated after a successful fetch. Served from cache
	 * when the cache age is below `refreshIntervalMs` and the configured server
	 * list (by id + baseUrl) has not changed.
	 */
	private _cachedModelInfos: LanguageModelChatInformation[] | undefined;
	private _cachedServerStatuses: ServerStatus[] | undefined;
	private _cachedSuccessfulCount = 0;
	private _cachedServersHash: string | undefined;
	private _cachedFetchedAt: number | undefined;

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly userAgent: string,
		private readonly outputChannel?: vscode.OutputChannel,
		private readonly issueReporter?: IssueReporter
	) {}

	setStatusCallback(callback: (status: AggregatedStatus) => void): void {
		this._statusCallback = callback;
	}

	setServerProvider(getServers: () => Promise<ServerWithKey[]>): void {
		this._getServers = getServers;
	}

	private log(message: string, data?: unknown): void {
		if (this.outputChannel) {
			const timestamp = new Date().toISOString();
			const line =
				data !== undefined
					? `[${timestamp}] ${message}: ${JSON.stringify(data, null, 2)}`
					: `[${timestamp}] ${message}`;
			this.outputChannel.appendLine(line);
			this.issueReporter?.appendLog(line);
		}
	}

	private logError(message: string, error: unknown): void {
		const errorMsg = error instanceof Error ? error.message : String(error);
		if (this.outputChannel) {
			const timestamp = new Date().toISOString();
			this.outputChannel.appendLine(`[${timestamp}] ERROR: ${message}: ${errorMsg}`);
			this.issueReporter?.appendLog(`[${timestamp}] ERROR: ${message}: ${errorMsg}`);
			if (error instanceof Error && error.stack) {
				this.outputChannel.appendLine(`Stack trace: ${error.stack}`);
			}
		}
		this.issueReporter?.recordError(message, error);
	}

	async prepareLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		// Single-flight: if a fetch is already running, join it instead of starting a new one.
		if (this._modelFetchInflight) {
			this.log("Joining in-flight model fetch");
			return this._modelFetchInflight;
		}

		// Reserve the inflight slot synchronously — before any `await` — so that
		// concurrent callers coalesce onto a single promise.
		let resolve!: (value: LanguageModelChatInformation[]) => void;
		let reject!: (reason: unknown) => void;
		const inflight = new Promise<LanguageModelChatInformation[]>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		inflight.finally(() => {
			if (this._modelFetchInflight === inflight) {
				this._modelFetchInflight = undefined;
			}
		});
		this._modelFetchInflight = inflight;

		try {
			this.log("prepareLanguageModelChatInformation called", { silent: options.silent });

			const settings = vscode.workspace.getConfiguration("litellm-vscode-chat");
			const rawRefreshInterval = settings.get<number>("refreshInterval", 900000);
			const refreshIntervalMs = Math.max(0, Number.isFinite(rawRefreshInterval) ? rawRefreshInterval : 900000);
			if (rawRefreshInterval !== refreshIntervalMs) {
				this.log("Invalid refreshInterval configuration, using clamped value", {
					configured: rawRefreshInterval,
					clamped: refreshIntervalMs,
				});
			}

			const servers = await ensureServers(options.silent, this._getServers, this.secrets);
			if (!servers || servers.length === 0) {
				this.log("No servers configured, returning empty array");

				if (options.silent && !this._hasShownNoConfigNotification) {
					this._hasShownNoConfigNotification = true;
					vscode.window
						.showWarningMessage("LiteLLM: No servers configured. Click to configure.", "Configure Now", "Dismiss")
						.then((choice) => {
							if (choice === "Configure Now") {
								vscode.commands.executeCommand("litellm.manage");
							}
						});
				}

				if (this._statusCallback) {
					this._statusCallback({ serverStatuses: [], totalModels: 0 });
				}
				resolve([]);
				return [];
			}

			// TTL cache: serve cached model list when it is fresh and the configured
			// server list (by id + baseUrl) has not changed since the cache was populated.
			const serversHash = computeServersHash(servers);
			if (refreshIntervalMs > 0) {
				const cached = this._cachedModelInfos;
				const cachedFetchedAt = this._cachedFetchedAt;
				const cachedServersHash = this._cachedServersHash;
				if (
					cached !== undefined &&
					cachedFetchedAt !== undefined &&
					cachedServersHash !== undefined &&
					cachedServersHash === serversHash
				) {
					const ageMs = Date.now() - cachedFetchedAt;
					if (ageMs < refreshIntervalMs) {
						this.log("Serving cached model list", {
							ageMs,
							refreshIntervalMs,
							models: cached.length,
						});
						if (this._statusCallback && this._cachedServerStatuses) {
							this._statusCallback({
								serverStatuses: this._cachedServerStatuses,
								totalModels: cached.length,
							});
						}
						resolve(cached);
						return cached;
					}
				}
			}

			this.log("Fetching models from servers", { count: servers.length, labels: servers.map((s) => s.label) });

			const rawDiscoveryTimeout = settings.get<number>("discoveryTimeout", 30000);
			const customHeaders = getCustomHeaders((msg, data) => this.log(msg, data));
			const discoveryTimeout = Math.max(1000, Number.isFinite(rawDiscoveryTimeout) ? rawDiscoveryTimeout : 30000);
			if (rawDiscoveryTimeout !== discoveryTimeout) {
				this.log("Invalid discoveryTimeout configuration, using clamped value", {
					configured: rawDiscoveryTimeout,
					clamped: discoveryTimeout,
				});
			}

			const result = await this.fetchModelsFromServers(
				servers,
				discoveryTimeout,
				customHeaders,
				serversHash,
				options.silent
			);
			resolve(result);
			return result;
		} catch (error) {
			reject(error);
			throw error;
		}
	}

	private async fetchModelsFromServers(
		servers: ServerWithKey[],
		discoveryTimeout: number,
		customHeaders: Record<string, string>,
		serversHash: string,
		silent: boolean
	): Promise<LanguageModelChatInformation[]> {
		const results = await Promise.allSettled(
			servers.map(async (server) => {
				const result = await fetchModels(
					server.apiKey,
					server.baseUrl,
					this.userAgent,
					(msg, data) => this.log(msg, data),
					(msg, err) => this.logError(msg, err),
					customHeaders,
					discoveryTimeout
				);
				return { server, models: result.models };
			})
		);

		const serverStatuses: ServerStatus[] = [];
		const allInfos: LanguageModelChatInformation[] = [];

		const successfulCount = results.filter((r) => r.status === "fulfilled").length;
		const serverCount = servers.length;

		if (successfulCount > 0) {
			this._modelRoutes.clear();
			this._promptCachingSupport.clear();
		}

		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			const server = servers[i];

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
				});
				continue;
			}

			const { models } = result.value;
			this.log(`Server "${server.label}" returned ${models.length} models`);

			const reg = buildModelInfos(models, server, serverCount, (msg) => this.log(msg));
			allInfos.push(...reg.infos);
			for (const [k, v] of reg.routes) {
				this._modelRoutes.set(k, v);
			}
			for (const [k, v] of reg.promptCaching) {
				this._promptCachingSupport.set(k, v);
			}

			serverStatuses.push({
				serverId: server.id,
				label: server.label,
				baseUrl: server.baseUrl,
				state: "ok",
				modelCount: reg.infos.length,
				lastChecked: new Date().toISOString(),
			});
		}

		this.log("Final model count:", allInfos.length);

		// Only populate the cache when at least one server returned successfully.
		// If all servers failed, leave the cache untouched so the next call retries.
		if (successfulCount > 0) {
			this._cachedModelInfos = allInfos;
			this._cachedServerStatuses = serverStatuses;
			this._cachedSuccessfulCount = successfulCount;
			this._cachedServersHash = serversHash;
			this._cachedFetchedAt = Date.now();
		}

		if (this._statusCallback) {
			this._statusCallback({ serverStatuses, totalModels: allInfos.length });
		}

		if (allInfos.length === 0 && successfulCount > 0) {
			vscode.window
				.showWarningMessage(
					"LiteLLM: Your servers returned no models. Check your LiteLLM proxy configuration.",
					"Check Server",
					"Reconfigure",
					"Report Issue"
				)
				.then((choice) => {
					if (choice === "Check Server") {
						vscode.commands.executeCommand("litellm.testConnection");
					} else if (choice === "Reconfigure") {
						vscode.commands.executeCommand("litellm.manage");
					} else if (choice === "Report Issue") {
						vscode.commands.executeCommand("litellm.reportIssue");
					}
				});
		}

		if (successfulCount === 0 && servers.length > 0) {
			const firstError = serverStatuses.find((s) => s.error)?.error ?? "Unknown error";
			if (silent) {
				vscode.window
					.showErrorMessage(`LiteLLM: ${firstError}`, "Reconfigure", "Report Issue", "Dismiss")
					.then((choice) => {
						if (choice === "Reconfigure") {
							vscode.commands.executeCommand("litellm.manage");
						} else if (choice === "Report Issue") {
							vscode.commands.executeCommand("litellm.reportIssue");
						}
					});
				return [];
			}
			throw new Error(firstError);
		}

		return allInfos;
	}

	/**
	 * Drops the cached model list so the next call to
	 * `provideLanguageModelChatInformation` triggers a fresh fetch.
	 *
	 * Wire this from configuration changes that affect what should be returned:
	 * - edits to `litellm-vscode-chat.headers` or `litellm-vscode-chat.discoveryTimeout`
	 *   (those change the actual HTTP request)
	 * - edits to `litellm-vscode-chat.refreshInterval` (the new TTL should take
	 *   effect immediately)
	 * - user-initiated actions that semantically expect fresh data, e.g. the
	 *   "Test Connection" command.
	 *
	 * Note: server add/edit/remove does NOT need to call this explicitly — the
	 * built-in hash check on `(id, baseUrl)` invalidates the cache when the
	 * configured server list changes.
	 */
	invalidateModelCache(): void {
		if (this._cachedModelInfos !== undefined || this._cachedFetchedAt !== undefined) {
			this.log("Model cache invalidated");
		}
		this._cachedModelInfos = undefined;
		this._cachedServerStatuses = undefined;
		this._cachedSuccessfulCount = 0;
		this._cachedServersHash = undefined;
		this._cachedFetchedAt = undefined;
	}

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return this.prepareLanguageModelChatInformation({ silent: options.silent ?? false }, _token);
	}

	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
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
			this._toolCallIdCounter = await sendChatRequest(
				{ model, messages, options, progress: trackingProgress, token },
				this._modelRoutes,
				this._promptCachingSupport,
				this._getServers,
				this.secrets,
				this.userAgent,
				this._toolCallIdCounter,
				(msg, data) => this.log(msg, data),
				(msg, err) => this.logError(msg, err)
			);
		} catch (err) {
			this.logError("Chat request failed", err);
			throw err;
		}
	}

	async provideTokenCount(
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		if (typeof text === "string") {
			return Math.ceil(text.length / 4);
		} else {
			let totalTokens = 0;
			for (const part of text.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					totalTokens += Math.ceil(part.value.length / 4);
				} else if (part instanceof vscode.LanguageModelDataPart) {
					const mime = part.mimeType.toLowerCase();
					if (mime.startsWith("image/")) {
						totalTokens += 765;
					} else if (mime === "application/pdf") {
						totalTokens += 500;
					} else if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json")) {
						totalTokens += Math.ceil(part.data.length / 4);
					}
				}
			}
			return totalTokens;
		}
	}
}

/**
 * Stable hash of the configured server list, used to invalidate the model cache
 * whenever the user adds, removes, edits, or reorders servers. Order-independent
 * so reordering the same set of servers does not invalidate the cache.
 */
export function computeServersHash(servers: readonly ServerWithKey[]): string {
	const entries = servers
		.map((s) => `${s.id}\u0000${s.baseUrl}`)
		.sort()
		.join("\u0001");
	// Cheap, deterministic, no crypto needed — collisions would only force one
	// extra refetch per cache window which is harmless.
	let hash = 5381;
	for (let i = 0; i < entries.length; i++) {
		hash = ((hash << 5) + hash + entries.charCodeAt(i)) | 0;
	}
	return `srv:${entries.length}:${hash.toString(36)}`;
}
