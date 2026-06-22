import * as vscode from "vscode";
import { clearTokenCache } from "../provider/auth";

/** Non-secret OAuth client-credentials config persisted alongside a server. */
export interface OAuthConfig {
	type: "oauth";
	/** IDP token endpoint that issues the access token. */
	idpUrl: string;
	clientId: string;
	/** Header the proxy expects the virtual key in (defaults applied at request time). */
	virtualKeyHeader?: string;
}

/** OAuth config with the secrets resolved from SecretStorage, ready to use. */
export interface OAuthSecrets {
	idpUrl: string;
	clientId: string;
	clientSecret: string;
	virtualKey: string;
	virtualKeyHeader?: string;
}

/** Parameters for creating/updating an OAuth client-credentials server. */
export interface OAuthInput {
	idpUrl: string;
	clientId: string;
	clientSecret: string;
	virtualKey: string;
	virtualKeyHeader?: string;
}

export interface ServerConfig {
	id: string;
	label: string;
	baseUrl: string;
	/** Present only for OAuth servers; absent means static API key auth. */
	auth?: OAuthConfig;
}

export interface ServerWithKey extends ServerConfig {
	apiKey: string;
	/** Present only for OAuth servers; carries the resolved secrets. */
	oauth?: OAuthSecrets;
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

function clientSecretSecret(serverId: string): string {
	return `litellm.oauth.clientSecret.${serverId}`;
}

function virtualKeySecret(serverId: string): string {
	return `litellm.oauth.virtualKey.${serverId}`;
}

export class ServerRegistry {
	constructor(
		private readonly globalState: vscode.Memento,
		private readonly secrets: vscode.SecretStorage
	) {}

	getServers(): ServerConfig[] {
		return this.globalState.get<ServerConfig[]>(REGISTRY_KEY, []);
	}

	async addServer(label: string, baseUrl: string, apiKey: string): Promise<ServerConfig> {
		const existingIds = new Set(this.getServers().map((s) => s.id));
		let id = generateId();
		while (existingIds.has(id)) {
			id = generateId();
		}
		const server: ServerConfig = { id, label, baseUrl: baseUrl.replace(/\/+$/, "") };
		const servers = this.getServers();
		servers.push(server);
		await this.globalState.update(REGISTRY_KEY, servers);
		if (apiKey) {
			await this.secrets.store(apiKeySecret(id), apiKey);
		}
		return server;
	}

	async updateServer(id: string, label: string, baseUrl: string, apiKey: string | undefined): Promise<void> {
		const servers = this.getServers();
		const idx = servers.findIndex((s) => s.id === id);
		if (idx === -1) {
			return;
		}
		servers[idx] = { id, label, baseUrl: baseUrl.replace(/\/+$/, "") };
		await this.globalState.update(REGISTRY_KEY, servers);
		// Switching to API-key auth: drop any stale OAuth secrets/token.
		await this.secrets.delete(clientSecretSecret(id));
		await this.secrets.delete(virtualKeySecret(id));
		clearTokenCache(id);
		if (apiKey !== undefined) {
			if (apiKey) {
				await this.secrets.store(apiKeySecret(id), apiKey);
			} else {
				await this.secrets.delete(apiKeySecret(id));
			}
		}
	}

	async addOAuthServer(label: string, baseUrl: string, oauth: OAuthInput): Promise<ServerConfig> {
		const existingIds = new Set(this.getServers().map((s) => s.id));
		let id = generateId();
		while (existingIds.has(id)) {
			id = generateId();
		}
		const auth: OAuthConfig = {
			type: "oauth",
			idpUrl: oauth.idpUrl,
			clientId: oauth.clientId,
			...(oauth.virtualKeyHeader ? { virtualKeyHeader: oauth.virtualKeyHeader } : {}),
		};
		const server: ServerConfig = { id, label, baseUrl: baseUrl.replace(/\/+$/, ""), auth };
		const servers = this.getServers();
		servers.push(server);
		await this.globalState.update(REGISTRY_KEY, servers);
		await this.secrets.store(clientSecretSecret(id), oauth.clientSecret);
		await this.secrets.store(virtualKeySecret(id), oauth.virtualKey);
		return server;
	}

	async updateOAuthServer(id: string, label: string, baseUrl: string, oauth: OAuthInput): Promise<void> {
		const servers = this.getServers();
		const idx = servers.findIndex((s) => s.id === id);
		if (idx === -1) {
			return;
		}
		const auth: OAuthConfig = {
			type: "oauth",
			idpUrl: oauth.idpUrl,
			clientId: oauth.clientId,
			...(oauth.virtualKeyHeader ? { virtualKeyHeader: oauth.virtualKeyHeader } : {}),
		};
		servers[idx] = { id, label, baseUrl: baseUrl.replace(/\/+$/, ""), auth };
		await this.globalState.update(REGISTRY_KEY, servers);
		// Switching to OAuth auth: drop any stale static API key.
		await this.secrets.delete(apiKeySecret(id));
		await this.secrets.store(clientSecretSecret(id), oauth.clientSecret);
		await this.secrets.store(virtualKeySecret(id), oauth.virtualKey);
		clearTokenCache(id);
	}

	async removeServer(id: string): Promise<void> {
		const servers = this.getServers().filter((s) => s.id !== id);
		await this.globalState.update(REGISTRY_KEY, servers);
		await this.secrets.delete(apiKeySecret(id));
		await this.secrets.delete(clientSecretSecret(id));
		await this.secrets.delete(virtualKeySecret(id));
		clearTokenCache(id);
	}

	async getApiKey(serverId: string): Promise<string> {
		return (await this.secrets.get(apiKeySecret(serverId))) ?? "";
	}

	async getOAuthSecrets(server: ServerConfig): Promise<OAuthSecrets | undefined> {
		if (server.auth?.type !== "oauth") {
			return undefined;
		}
		return {
			idpUrl: server.auth.idpUrl,
			clientId: server.auth.clientId,
			clientSecret: (await this.secrets.get(clientSecretSecret(server.id))) ?? "",
			virtualKey: (await this.secrets.get(virtualKeySecret(server.id))) ?? "",
			...(server.auth.virtualKeyHeader ? { virtualKeyHeader: server.auth.virtualKeyHeader } : {}),
		};
	}

	async getServersWithKeys(): Promise<ServerWithKey[]> {
		const servers = this.getServers();
		return Promise.all(
			servers.map(async (s) => ({
				...s,
				apiKey: s.auth?.type === "oauth" ? "" : await this.getApiKey(s.id),
				oauth: await this.getOAuthSecrets(s),
			}))
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
}

function generateId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	for (let i = 0; i < 8; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}
