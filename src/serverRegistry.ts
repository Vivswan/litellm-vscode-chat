import * as vscode from "vscode";

export interface ServerConfig {
	id: string;
	label: string;
	baseUrl: string;
}

export interface ServerWithKey extends ServerConfig {
	apiKey: string;
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

export class ServerRegistry {
	constructor(
		private readonly globalState: vscode.Memento,
		private readonly secrets: vscode.SecretStorage
	) {}

	getServers(): ServerConfig[] {
		return this.globalState.get<ServerConfig[]>(REGISTRY_KEY, []);
	}

	async addServer(label: string, baseUrl: string, apiKey: string): Promise<ServerConfig> {
		const id = generateId();
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
		if (apiKey !== undefined) {
			if (apiKey) {
				await this.secrets.store(apiKeySecret(id), apiKey);
			} else {
				await this.secrets.delete(apiKeySecret(id));
			}
		}
	}

	async removeServer(id: string): Promise<void> {
		const servers = this.getServers().filter((s) => s.id !== id);
		await this.globalState.update(REGISTRY_KEY, servers);
		await this.secrets.delete(apiKeySecret(id));
	}

	async getApiKey(serverId: string): Promise<string> {
		return (await this.secrets.get(apiKeySecret(serverId))) ?? "";
	}

	async getServersWithKeys(): Promise<ServerWithKey[]> {
		const servers = this.getServers();
		return Promise.all(
			servers.map(async (s) => ({
				...s,
				apiKey: await this.getApiKey(s.id),
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
