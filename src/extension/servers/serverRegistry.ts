import type * as vscode from "vscode";
import { z } from "zod";
import { apiKeySecret, SERVER_REGISTRY_KEY } from "../../shared/config/storageKeys";
import type { ServerConfig, ServerWithKey } from "../../shared/servers";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";

const serverConfigSchema = z.looseObject({
	id: z.string(),
	label: z.string(),
	baseUrl: z.string(),
});

// Any number, so a blob with a broken version still yields its servers
// (z.number() rejects NaN and Infinity); parsePersistedRegistry sanitizes it.
const versionSchema = z.custom<number>((value) => typeof value === "number");

const versionedRegistrySchema = z.looseObject({
	version: versionSchema,
	servers: z.array(z.unknown()),
});

// Valid entries are kept as the original objects, so keys beyond
// id/label/baseUrl survive round-tripping.
function filterServerConfigs(entries: unknown[]): ServerConfig[] {
	return entries.filter((entry): entry is ServerConfig => serverConfigSchema.safeParse(entry).success);
}

interface PersistedRegistry {
	version: number;
	servers: ServerConfig[];
}

function parsePersistedRegistry(raw: unknown): PersistedRegistry {
	// Pre-versioning bare-array blobs read as this shape through the wrapping
	// view the registry is constructed over (migrations/bareArrayBlobs.ts).
	const versioned = versionedRegistrySchema.safeParse(raw);
	if (versioned.success) {
		// A broken persisted version freezes the protocol permanently: Infinity
		// and huge finite values can never be exceeded, NaN compares newer to
		// nothing. Anything but a nonnegative safe integer re-enters versioning
		// at 0 instead, keeping the servers.
		const rawVersion = versioned.data.version;
		const version = Number.isSafeInteger(rawVersion) && rawVersion >= 0 ? rawVersion : 0;
		return { version, servers: filterServerConfigs(versioned.data.servers) };
	}
	return { version: 0, servers: [] };
}

/**
 * The retired legacy server store: server URLs in globalState, per-server API
 * keys in SecretStorage. Nothing serves from it and no user surface edits it
 * anymore; it survives only as the migrations' read source and cleanup target
 * (legacySingleServer imports into it, registryToProviderGroups drains it), so
 * the mutators here are migration machinery, not user flows.
 */
export class ServerRegistry {
	// VS Code broadcasts globalState changes back to every extension host, so a
	// stale broadcast can revert a naive read-modify-write. The in-memory list is
	// authoritative for this window; the persisted blob's version gates adoption
	// to strictly newer snapshots. Concurrent windows remain last-write-wins.
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
		// wrote ourselves: Memento caches updates optimistically, so a failed
		// persist can leave our rejected snapshot in the cache.
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
}

function generateId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	for (let i = 0; i < 8; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}
