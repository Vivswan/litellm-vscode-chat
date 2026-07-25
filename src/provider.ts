import type {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatProvider,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";
import { ChatClient } from "./provider/chatClient";
import type { ConfigurationPrompt } from "./provider/config";
import { ensureServers } from "./provider/config";
import type { ModelRoute } from "./provider/modelCatalog";
import { buildModelInfos } from "./provider/registration";
import type { Logger } from "./shared/logger";
import type { AggregatedStatus, ServerStatus, ServerWithKey } from "./shared/servers";
import { CHARS_PER_TOKEN, estimateMessagesTokens } from "./shared/tokenEstimation";

export class LiteLLMChatModelProvider implements LanguageModelChatProvider {
	private readonly _client: ChatClient;
	private _statusCallback?: (status: AggregatedStatus) => void;
	private _getServers?: () => Promise<ServerWithKey[]>;
	private _configurationPrompt?: ConfigurationPrompt;

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

	private log(message: string, data?: unknown): void {
		this.logger?.log(message, data);
	}

	private logError(message: string, error: unknown): void {
		this.logger?.error(message, error);
	}

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		this.log("provideLanguageModelChatInformation called", { silent: options.silent });

		const servers = await ensureServers(options.silent, this._getServers, this._configurationPrompt);
		if (!servers || servers.length === 0) {
			this.log("No servers configured, returning empty array");

			if (this._statusCallback) {
				this._statusCallback({ serverStatuses: [], totalModels: 0, silent: options.silent });
			}
			return [];
		}

		this.log("Fetching models from servers", { count: servers.length, labels: servers.map((s) => s.label) });

		const results = await Promise.allSettled(
			servers.map(async (server) => {
				const result = await this._client.fetchModels(server);
				return { server, models: result.models };
			})
		);

		const serverStatuses: ServerStatus[] = [];
		const allInfos: LanguageModelChatInformation[] = [];
		const allRoutes = new Map<string, ModelRoute>();
		const allPromptCaching = new Map<string, boolean>();

		const successfulCount = results.filter((r) => r.status === "fulfilled").length;
		const serverCount = servers.length;

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
				allRoutes.set(k, v);
			}
			for (const [k, v] of reg.promptCaching) {
				allPromptCaching.set(k, v);
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

		// Registrations are only replaced after at least one server answered, so
		// existing routes survive a total outage.
		if (successfulCount > 0) {
			this._client.applyRegistration(allRoutes, allPromptCaching, true);
		}

		this.log("Final model count:", allInfos.length);

		if (this._statusCallback) {
			this._statusCallback({ serverStatuses, totalModels: allInfos.length, silent: options.silent });
		}

		if (successfulCount === 0 && servers.length > 0) {
			if (options.silent) {
				return [];
			}
			const firstError = serverStatuses.find((s) => s.error)?.error ?? "Unknown error";
			throw new Error(firstError);
		}

		return allInfos;
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
			await this._client.send({ model, messages, options, progress: trackingProgress, token });
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
			return Math.ceil(text.length / CHARS_PER_TOKEN);
		}
		return estimateMessagesTokens([text], { includeMultimodal: true });
	}
}
