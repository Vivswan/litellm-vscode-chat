import type * as vscode from "vscode";
import { z } from "zod";
import type { ServerConfig, ServerWithKey } from "../shared/servers";
import {
	apiKeySecret,
	LEGACY_API_KEY_SECRET,
	LEGACY_BASE_URL_SECRET,
	SERVER_REGISTRY_KEY,
} from "../shared/storageKeys";

const serverConfigSchema = z.looseObject({
	id: z.string(),
	label: z.string(),
	baseUrl: z.string(),
});

// Accepts any number, including NaN and Infinity, which z.number() rejects.
const versionSchema = z.custom<number>((value) => typeof value === "number");

const bareArrayRegistrySchema = z.array(z.unknown());

const versionedRegistrySchema = z.looseObject({
	version: versionSchema,
	servers: z.array(z.unknown()),
});

// Malformed entries are dropped one by one; valid entries are kept as the
// original objects so keys beyond id/label/baseUrl survive round-tripping.
function filterServerConfigs(entries: unknown[]): ServerConfig[] {
	return entries.filter((entry): entry is ServerConfig => serverConfigSchema.safeParse(entry).success);
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

interface PersistedRegistry {
	version: number;
	servers: ServerConfig[];
}

function parsePersistedRegistry(raw: unknown): PersistedRegistry {
	// Registries written before versioning were a bare array.
	const bare = bareArrayRegistrySchema.safeParse(raw);
	if (bare.success) {
		return { version: 0, servers: filterServerConfigs(bare.data) };
	}
	const versioned = versionedRegistrySchema.safeParse(raw);
	if (versioned.success) {
		return { version: versioned.data.version, servers: filterServerConfigs(versioned.data.servers) };
	}
	return { version: 0, servers: [] };
}

export class ServerRegistry {
	// VS Code merges all of an extension's globalState keys into one blob and
	// broadcasts changes back to each extension host, so a naive read-modify-write
	// lets a stale broadcast (e.g. a concurrent status-bar persist) revert a
	// registry write. The in-memory list is authoritative for this window; the
	// persisted blob carries a version so that snapshots from other windows are
	// adopted only when strictly newer, and stale broadcasts are ignored.
	// Simultaneous mutations from two windows remain last-write-wins.
	private servers: ServerConfig[];
	private version: number;
	private persisting = false;
	private lastWrittenBlob: unknown;

	constructor(
		private readonly globalState: vscode.Memento,
		private readonly secrets: vscode.SecretStorage
	) {
		const stored = parsePersistedRegistry(this.globalState.get<unknown>(SERVER_REGISTRY_KEY));
		this.servers = [...stored.servers];
		this.version = stored.version;
	}

	private syncFromStorage(): void {
		// No adoption while our own write is in flight, and never from the blob we
		// wrote ourselves: Memento caches updates optimistically, so after a failed
		// persist the cache can still hold our rejected snapshot.
		if (this.persisting) {
			return;
		}
		const raw = this.globalState.get<unknown>(SERVER_REGISTRY_KEY);
		if (raw === this.lastWrittenBlob) {
			return;
		}
		const stored = parsePersistedRegistry(raw);
		if (stored.version > this.version) {
			this.servers = [...stored.servers];
			this.version = stored.version;
		}
	}

	private async persist(): Promise<void> {
		const next = this.version + 1;
		const blob: PersistedRegistry = { version: next, servers: [...this.servers] };
		this.lastWrittenBlob = blob;
		this.persisting = true;
		try {
			await this.globalState.update(SERVER_REGISTRY_KEY, blob);
			this.version = next;
		} finally {
			this.persisting = false;
		}
	}

	getServers(): ServerConfig[] {
		this.syncFromStorage();
		return [...this.servers];
	}

	async addServer(label: string, baseUrl: string, apiKey: string): Promise<ServerConfig> {
		this.syncFromStorage();
		const existingIds = new Set(this.servers.map((s) => s.id));
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
		this.servers.push(server);
		try {
			await this.persist();
		} catch (error) {
			this.servers = this.servers.filter((s) => s.id !== id);
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
		this.syncFromStorage();
		const idx = this.servers.findIndex((s) => s.id === id);
		if (idx === -1) {
			return;
		}
		const previous = this.servers[idx];
		if (previous === undefined) {
			// Unreachable: idx comes from findIndex above; the guard exists for
			// noUncheckedIndexedAccess.
			return;
		}
		this.servers[idx] = { id, label, baseUrl: normalizeBaseUrl(baseUrl) };
		try {
			await this.persist();
		} catch (error) {
			this.servers[idx] = previous;
			throw error;
		}
		if (apiKey !== undefined) {
			if (apiKey) {
				await this.secrets.store(apiKeySecret(id), apiKey);
			} else {
				await this.secrets.delete(apiKeySecret(id));
			}
		}
	}

	async removeServer(id: string): Promise<void> {
		this.syncFromStorage();
		const previous = this.servers;
		this.servers = this.servers.filter((s) => s.id !== id);
		try {
			await this.persist();
		} catch (error) {
			this.servers = previous;
			throw error;
		}
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
