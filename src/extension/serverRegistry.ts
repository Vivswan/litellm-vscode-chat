import * as vscode from "vscode";

export interface ServerConfig {
	id: string;
	label: string;
	baseUrl: string;
	auth?: ServerAuthConfig;
}

export interface ServerWithKey extends ServerConfig {
	apiKey: string;
	auth: ServerAuthConfig;
	oauthClientId: string;
	oauthClientSecret: string;
	oauthVirtualKey: string;
}

export interface ApiKeyAuthConfig {
	type: "apiKey";
}

export interface OAuth2AuthConfig {
	type: "oauth2";
	tokenUrl: string;
	virtualKeyHeader: string;
}

export type ServerAuthConfig = ApiKeyAuthConfig | OAuth2AuthConfig;

export interface OAuth2Credentials {
	clientId: string;
	clientSecret: string;
	virtualKey: string;
}

export interface ServerStatus {
	serverId: string;
	label: string;
	baseUrl: string;
	state: "ok" | "error";
	modelCount: number;
	error?: string;
	lastChecked: string;
}

const REGISTRY_KEY = "litellm.serverRegistry";
export const DEFAULT_OAUTH2_VIRTUAL_KEY_HEADER = "X-LLM-API-CLIENT-ID";

function apiKeySecret(serverId: string): string {
	return `litellm.apiKey.${serverId}`;
}

function oauthClientIdSecret(serverId: string): string {
	return `litellm.oauth2.clientId.${serverId}`;
}

function oauthClientSecretSecret(serverId: string): string {
	return `litellm.oauth2.clientSecret.${serverId}`;
}

function oauthVirtualKeySecret(serverId: string): string {
	return `litellm.oauth2.virtualKey.${serverId}`;
}

export function normalizeAuthConfig(auth: ServerAuthConfig | undefined): ServerAuthConfig {
	if (auth?.type === "oauth2") {
		return {
			type: "oauth2",
			tokenUrl: auth.tokenUrl.trim(),
			virtualKeyHeader: auth.virtualKeyHeader.trim() || DEFAULT_OAUTH2_VIRTUAL_KEY_HEADER,
		};
	}
	return { type: "apiKey" };
}

export class ServerRegistry {
	constructor(
		private readonly globalState: vscode.Memento,
		private readonly secrets: vscode.SecretStorage
	) {}

	getServers(): ServerConfig[] {
		return this.globalState.get<ServerConfig[]>(REGISTRY_KEY, []);
	}

	async addServer(
		label: string,
		baseUrl: string,
		apiKey: string,
		auth?: ServerAuthConfig,
		oauthCredentials?: OAuth2Credentials
	): Promise<ServerConfig> {
		const existingIds = new Set(this.getServers().map((s) => s.id));
		let id = generateId();
		while (existingIds.has(id)) {
			id = generateId();
		}
		const normalizedAuth = normalizeAuthConfig(auth);
		const server: ServerConfig = { id, label, baseUrl: baseUrl.replace(/\/+$/, ""), auth: normalizedAuth };
		const servers = this.getServers();
		servers.push(server);
		await this.globalState.update(REGISTRY_KEY, servers);
		if (normalizedAuth.type === "apiKey" && apiKey) {
			await this.secrets.store(apiKeySecret(id), apiKey);
		} else if (normalizedAuth.type === "oauth2" && oauthCredentials) {
			await this.storeOAuth2Credentials(id, oauthCredentials);
		}
		return server;
	}

	async updateServer(
		id: string,
		label: string,
		baseUrl: string,
		apiKey: string | undefined,
		auth?: ServerAuthConfig,
		oauthCredentials?: OAuth2Credentials
	): Promise<void> {
		const servers = this.getServers();
		const idx = servers.findIndex((s) => s.id === id);
		if (idx === -1) {
			return;
		}
		const normalizedAuth = normalizeAuthConfig(auth ?? servers[idx].auth);
		servers[idx] = { id, label, baseUrl: baseUrl.replace(/\/+$/, ""), auth: normalizedAuth };
		await this.globalState.update(REGISTRY_KEY, servers);
		if (normalizedAuth.type === "apiKey" && apiKey !== undefined) {
			if (apiKey) {
				await this.secrets.store(apiKeySecret(id), apiKey);
			} else {
				await this.secrets.delete(apiKeySecret(id));
			}
			await this.deleteOAuth2Credentials(id);
		} else if (normalizedAuth.type === "oauth2") {
			await this.secrets.delete(apiKeySecret(id));
			if (oauthCredentials) {
				await this.storeOAuth2Credentials(id, oauthCredentials);
			}
		}
	}

	async removeServer(id: string): Promise<void> {
		const servers = this.getServers().filter((s) => s.id !== id);
		await this.globalState.update(REGISTRY_KEY, servers);
		await this.secrets.delete(apiKeySecret(id));
		await this.deleteOAuth2Credentials(id);
	}

	async getApiKey(serverId: string): Promise<string> {
		return (await this.secrets.get(apiKeySecret(serverId))) ?? "";
	}

	async getOAuth2Credentials(serverId: string): Promise<OAuth2Credentials> {
		return {
			clientId: (await this.secrets.get(oauthClientIdSecret(serverId))) ?? "",
			clientSecret: (await this.secrets.get(oauthClientSecretSecret(serverId))) ?? "",
			virtualKey: (await this.secrets.get(oauthVirtualKeySecret(serverId))) ?? "",
		};
	}

	async getServersWithKeys(): Promise<ServerWithKey[]> {
		const servers = this.getServers();
		return Promise.all(
			servers.map(async (s) => {
				const oauthCredentials = await this.getOAuth2Credentials(s.id);
				return {
					...s,
					auth: normalizeAuthConfig(s.auth),
					apiKey: await this.getApiKey(s.id),
					oauthClientId: oauthCredentials.clientId,
					oauthClientSecret: oauthCredentials.clientSecret,
					oauthVirtualKey: oauthCredentials.virtualKey,
				};
			})
		);
	}

	hasLabel(label: string, excludeId?: string): boolean {
		return this.getServers().some((s) => s.label === label && s.id !== excludeId);
	}

	async migrateLegacy(): Promise<boolean> {
		if (this.getServers().length > 0) {
			return false;
		}
		const baseUrl = await this.secrets.get("litellm.baseUrl");
		if (!baseUrl) {
			return false;
		}
		const apiKey = (await this.secrets.get("litellm.apiKey")) ?? "";
		await this.addServer("Default", baseUrl, apiKey);
		await this.secrets.delete("litellm.baseUrl");
		await this.secrets.delete("litellm.apiKey");
		return true;
	}

	private async storeOAuth2Credentials(serverId: string, credentials: OAuth2Credentials): Promise<void> {
		if (credentials.clientId) {
			await this.secrets.store(oauthClientIdSecret(serverId), credentials.clientId);
		} else {
			await this.secrets.delete(oauthClientIdSecret(serverId));
		}
		if (credentials.clientSecret) {
			await this.secrets.store(oauthClientSecretSecret(serverId), credentials.clientSecret);
		} else {
			await this.secrets.delete(oauthClientSecretSecret(serverId));
		}
		if (credentials.virtualKey) {
			await this.secrets.store(oauthVirtualKeySecret(serverId), credentials.virtualKey);
		} else {
			await this.secrets.delete(oauthVirtualKeySecret(serverId));
		}
	}

	private async deleteOAuth2Credentials(serverId: string): Promise<void> {
		await this.secrets.delete(oauthClientIdSecret(serverId));
		await this.secrets.delete(oauthClientSecretSecret(serverId));
		await this.secrets.delete(oauthVirtualKeySecret(serverId));
	}
}

function generateId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	for (let i = 0; i < 8; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}
