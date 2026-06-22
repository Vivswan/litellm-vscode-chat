import * as vscode from "vscode";

export type AuthMethod = "apiKey" | "oauth2";

export const DEFAULT_VIRTUAL_KEY_HEADER = "X-LLM-API-CLIENT-ID";

export interface ServerConfig {
	id: string;
	label: string;
	baseUrl: string;
	/** Authentication method. Missing value is treated as "apiKey" for backward compatibility. */
	authMethod?: AuthMethod;
	/** OAuth2 token endpoint (client-credentials grant). */
	oauthTokenUrl?: string;
	/** OAuth2 client identifier. */
	oauthClientId?: string;
	/** Header used to send the optional virtual key. Defaults to X-LLM-API-CLIENT-ID. */
	oauthVirtualKeyHeader?: string;
}

export interface ServerWithKey extends ServerConfig {
	apiKey: string;
	oauthClientSecret?: string;
	oauthVirtualKey?: string;
}

/** Non-secret OAuth2 configuration for a server. */
export interface OAuthConfig {
	tokenUrl: string;
	clientId: string;
	virtualKeyHeader?: string;
}

/** OAuth2 secrets for a server. */
export interface OAuthSecrets {
	clientSecret: string;
	virtualKey?: string;
}

/** Combined input used when adding/updating a server. */
export interface ServerAuthInput {
	authMethod: AuthMethod;
	apiKey?: string;
	oauth?: OAuthConfig & OAuthSecrets;
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

function apiKeySecret(serverId: string): string {
	return `litellm.apiKey.${serverId}`;
}

function oauthClientSecretKey(serverId: string): string {
	return `litellm.oauthClientSecret.${serverId}`;
}

function oauthVirtualKeySecret(serverId: string): string {
	return `litellm.oauthVirtualKey.${serverId}`;
}

export class ServerRegistry {
	constructor(
		private readonly globalState: vscode.Memento,
		private readonly secrets: vscode.SecretStorage
	) {}

	getServers(): ServerConfig[] {
		return this.globalState.get<ServerConfig[]>(REGISTRY_KEY, []);
	}

	async addServer(label: string, baseUrl: string, apiKey: string, auth?: ServerAuthInput): Promise<ServerConfig> {
		const existingIds = new Set(this.getServers().map((s) => s.id));
		let id = generateId();
		while (existingIds.has(id)) {
			id = generateId();
		}
		const resolved = auth ?? { authMethod: "apiKey" as const, apiKey };
		const server = this.buildConfig(id, label, baseUrl, resolved);
		const servers = this.getServers();
		servers.push(server);
		await this.globalState.update(REGISTRY_KEY, servers);
		await this.storeSecrets(id, resolved);
		return server;
	}

	async updateServer(
		id: string,
		label: string,
		baseUrl: string,
		apiKey: string | undefined,
		auth?: ServerAuthInput
	): Promise<void> {
		const servers = this.getServers();
		const idx = servers.findIndex((s) => s.id === id);
		if (idx === -1) {
			return;
		}
		const resolved = auth ?? (apiKey !== undefined ? { authMethod: "apiKey" as const, apiKey } : undefined);
		servers[idx] = resolved ? this.buildConfig(id, label, baseUrl, resolved) : { ...servers[idx], label, baseUrl: baseUrl.replace(/\/+$/, "") };
		await this.globalState.update(REGISTRY_KEY, servers);
		if (resolved) {
			await this.storeSecrets(id, resolved);
		}
	}

	async removeServer(id: string): Promise<void> {
		const servers = this.getServers().filter((s) => s.id !== id);
		await this.globalState.update(REGISTRY_KEY, servers);
		await this.secrets.delete(apiKeySecret(id));
		await this.secrets.delete(oauthClientSecretKey(id));
		await this.secrets.delete(oauthVirtualKeySecret(id));
	}

	async getApiKey(serverId: string): Promise<string> {
		return (await this.secrets.get(apiKeySecret(serverId))) ?? "";
	}

	async getOAuthClientSecret(serverId: string): Promise<string> {
		return (await this.secrets.get(oauthClientSecretKey(serverId))) ?? "";
	}

	async getOAuthVirtualKey(serverId: string): Promise<string> {
		return (await this.secrets.get(oauthVirtualKeySecret(serverId))) ?? "";
	}

	async getServersWithKeys(): Promise<ServerWithKey[]> {
		const servers = this.getServers();
		return Promise.all(
			servers.map(async (s) => ({
				...s,
				apiKey: await this.getApiKey(s.id),
				oauthClientSecret: s.authMethod === "oauth2" ? await this.getOAuthClientSecret(s.id) : undefined,
				oauthVirtualKey: s.authMethod === "oauth2" ? await this.getOAuthVirtualKey(s.id) : undefined,
			}))
		);
	}

	hasLabel(label: string, excludeId?: string): boolean {
		return this.getServers().some((s) => s.label === label && s.id !== excludeId);
	}

	private buildConfig(id: string, label: string, baseUrl: string, auth: ServerAuthInput): ServerConfig {
		const base: ServerConfig = { id, label, baseUrl: baseUrl.replace(/\/+$/, ""), authMethod: auth.authMethod };
		if (auth.authMethod === "oauth2" && auth.oauth) {
			base.oauthTokenUrl = auth.oauth.tokenUrl;
			base.oauthClientId = auth.oauth.clientId;
			const header = auth.oauth.virtualKeyHeader?.trim();
			if (header) {
				base.oauthVirtualKeyHeader = header;
			}
		}
		return base;
	}

	private async storeSecrets(id: string, auth: ServerAuthInput): Promise<void> {
		if (auth.authMethod === "oauth2" && auth.oauth) {
			// Clear API-key secret; OAuth servers don't use it.
			await this.secrets.delete(apiKeySecret(id));
			if (auth.oauth.clientSecret) {
				await this.secrets.store(oauthClientSecretKey(id), auth.oauth.clientSecret);
			} else {
				await this.secrets.delete(oauthClientSecretKey(id));
			}
			if (auth.oauth.virtualKey) {
				await this.secrets.store(oauthVirtualKeySecret(id), auth.oauth.virtualKey);
			} else {
				await this.secrets.delete(oauthVirtualKeySecret(id));
			}
			return;
		}

		// API-key auth: clear any OAuth secrets, store/clear API key.
		await this.secrets.delete(oauthClientSecretKey(id));
		await this.secrets.delete(oauthVirtualKeySecret(id));
		if (auth.apiKey) {
			await this.secrets.store(apiKeySecret(id), auth.apiKey);
		} else {
			await this.secrets.delete(apiKeySecret(id));
		}
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
}

function generateId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	for (let i = 0; i < 8; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}
