import type * as vscode from "vscode";
import {
	apiKeySecret,
	LEGACY_API_KEY_SECRET,
	LEGACY_BASE_URL_SECRET,
	SERVER_REGISTRY_KEY,
} from "../shared/storageKeys";

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

function isServerConfig(value: unknown): value is ServerConfig {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<ServerConfig>;
	return (
		typeof candidate.id === "string" && typeof candidate.label === "string" && typeof candidate.baseUrl === "string"
	);
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

export class ServerRegistry {
	constructor(
		private readonly globalState: vscode.Memento,
		private readonly secrets: vscode.SecretStorage
	) {}

	getServers(): ServerConfig[] {
		const raw = this.globalState.get<unknown>(SERVER_REGISTRY_KEY, []);
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw.filter(isServerConfig);
	}

	async addServer(label: string, baseUrl: string, apiKey: string): Promise<ServerConfig> {
		const existingIds = new Set(this.getServers().map((s) => s.id));
		let id = generateId();
		while (existingIds.has(id)) {
			id = generateId();
		}
		const server: ServerConfig = { id, label, baseUrl: normalizeBaseUrl(baseUrl) };
		// The secret goes in first: a failure here leaves no trace, while a registry
		// entry without its key would break requests and block re-migration.
		if (apiKey) {
			await this.secrets.store(apiKeySecret(id), apiKey);
		}
		try {
			const servers = this.getServers();
			servers.push(server);
			await this.globalState.update(SERVER_REGISTRY_KEY, servers);
		} catch (error) {
			if (apiKey) {
				try {
					await this.secrets.delete(apiKeySecret(id));
				} catch {
					// The orphaned secret is unreachable without a registry entry; ignore.
				}
			}
			throw error;
		}
		return server;
	}

	async updateServer(id: string, label: string, baseUrl: string, apiKey: string | undefined): Promise<void> {
		const servers = this.getServers();
		const idx = servers.findIndex((s) => s.id === id);
		if (idx === -1) {
			return;
		}
		servers[idx] = { id, label, baseUrl: normalizeBaseUrl(baseUrl) };
		await this.globalState.update(SERVER_REGISTRY_KEY, servers);
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
		await this.globalState.update(SERVER_REGISTRY_KEY, servers);
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
		const baseUrl = await this.secrets.get(LEGACY_BASE_URL_SECRET);
		if (!baseUrl) {
			return false;
		}
		const apiKey = (await this.secrets.get(LEGACY_API_KEY_SECRET)) ?? "";
		await this.addServer("Default", baseUrl, apiKey);
		await this.secrets.delete(LEGACY_BASE_URL_SECRET);
		await this.secrets.delete(LEGACY_API_KEY_SECRET);
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
