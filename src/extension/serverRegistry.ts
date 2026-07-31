import type * as vscode from "vscode";
import { z } from "zod";
import { apiKeySecret, SERVER_REGISTRY_KEY, SKIPPED_MIGRATION_SERVERS_KEY } from "../shared/config/storageKeys";
import type { ServerConfig, ServerWithKey } from "../shared/servers";
import { normalizeBaseUrl } from "../shared/util/baseUrl";

const serverConfigSchema = z.looseObject({
	id: z.string(),
	label: z.string(),
	baseUrl: z.string(),
});

// Accepts any number so a blob with a broken version still yields its servers
// (z.number() rejects NaN and Infinity, which would drop the whole registry);
// parsePersistedRegistry sanitizes the version itself to a safe integer.
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
		// A broken persisted version would poison the protocol: Infinity (a
		// hand-edited 1e999 survives JSON.parse) wins every "strictly newer"
		// comparison yet can never be exceeded, NaN compares newer to nothing,
		// and a huge finite value like 1e20 freezes too because version + 1
		// rounds back to version. Anything that is not a nonnegative safe
		// integer re-enters versioning at 0 instead, keeping the servers. A
		// window still running with a higher healthy version outranks the
		// recovered state until its own next persist - the last-write-wins
		// concession the class comment documents - which beats the permanent
		// cross-window freeze the broken version caused.
		const rawVersion = versioned.data.version;
		const version = Number.isSafeInteger(rawVersion) && rawVersion >= 0 ? rawVersion : 0;
		return { version, servers: filterServerConfigs(versioned.data.servers) };
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
		const previous = this.servers.find((s) => s.id === id);
		if (previous === undefined) {
			return;
		}
		const idx = this.servers.indexOf(previous);
		const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
		this.servers[idx] = { id, label, baseUrl: normalizedBaseUrl };
		try {
			await this.persist();
		} catch (error) {
			this.servers[idx] = previous;
			throw error;
		}
		// A server the group migration skipped (a name collision, or an edit
		// that raced the seeding) is naturally resolved by renaming or
		// repointing it, so the skip marker lifts as soon as the entry mutation
		// persists, independent of the secret operations below, which may fail
		// transiently and must not leave the server permanently skipped.
		// This read-filter-write can race a marker another window adds in the
		// same instant; that self-heals by re-skipping (one extra notice), so
		// no merge protocol is warranted for a removal.
		if (previous.label !== label || previous.baseUrl !== normalizedBaseUrl) {
			const skipped = this.globalState.get<unknown>(SKIPPED_MIGRATION_SERVERS_KEY);
			if (Array.isArray(skipped) && skipped.includes(id)) {
				const remaining = skipped.filter((skippedId) => skippedId !== id);
				await this.globalState.update(SKIPPED_MIGRATION_SERVERS_KEY, remaining.length > 0 ? remaining : undefined);
			}
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
}

function generateId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	for (let i = 0; i < 8; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}
