import type * as vscode from "vscode";
import { z } from "zod";
import { apiKeySecret, SERVER_REGISTRY_KEY, SKIPPED_MIGRATION_SERVERS_KEY } from "../../shared/config/storageKeys";
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

const bareArrayRegistrySchema = z.array(z.unknown());

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
	// Registries written before versioning were a bare array.
	const bare = bareArrayRegistrySchema.safeParse(raw);
	if (bare.success) {
		return { version: 0, servers: filterServerConfigs(bare.data) };
	}
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

/** What the installed mutation guard reports at a mutator's entry; anything but "ok" refuses with a typed error. */
export type RegistryMutationVerdict = "ok" | "migrating" | "retired";

/** A registry mutation refused because the provider-group migration is seeding groups right now. */
export class MigrationInProgressError extends Error {
	constructor() {
		// English by policy: this can land in the output channel and the public
		// issue-report buffer.
		super("registry mutation refused: the provider-group migration is running");
		this.name = "MigrationInProgressError";
	}
}

/** A registry mutation refused because the migration retired the registry (provider groups serve instead). */
export class RegistryRetiredError extends Error {
	constructor() {
		super("registry mutation refused: the registry was migrated to provider groups");
		this.name = "RegistryRetiredError";
	}
}

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

	/**
	 * Consulted at every public mutator's entry; anything but "ok" refuses with
	 * the matching typed error. Defaults to "ok" so the registry stands alone;
	 * activation installs the real verdict (registryMutationVerdict in
	 * serverManagement.ts).
	 */
	private mutationGuard: () => RegistryMutationVerdict = () => "ok";

	installMutationGuard(guard: () => RegistryMutationVerdict): void {
		this.mutationGuard = guard;
	}

	private assertMutable(): void {
		const verdict = this.mutationGuard();
		if (verdict === "migrating") {
			throw new MigrationInProgressError();
		}
		if (verdict === "retired") {
			throw new RegistryRetiredError();
		}
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
		this.assertMutable();
		return this.addServerUnguarded(label, baseUrl, apiKey);
	}

	/**
	 * The machinery's path around the mutation guard, paired with
	 * removeServerUnguarded: the migrations mutate while their own lock reports
	 * "migrating". Every user flow goes through the guarded methods.
	 */
	async addServerUnguarded(label: string, baseUrl: string, apiKey: string): Promise<ServerConfig> {
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
		this.assertMutable();
		this.syncFromStorage();
		const previous = this.servers.find((s) => s.id === id);
		if (previous === undefined) {
			return;
		}
		const idx = this.servers.indexOf(previous);
		const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
		// The secret goes in first, like addServerUnguarded: if the entry persist
		// below fails, the entry still names its old host and the old key is
		// restored - the reverse order could leave a re-pointed entry paired with
		// the old host's key when the secret write fails after the persist. The
		// window between the key store and the persist still exists (a concurrent
		// legacy request reads the old entry with the new key); this ordering only
		// fixes which DURABLE state a failure can leave behind.
		let previousKey: string | undefined;
		if (apiKey !== undefined) {
			previousKey = await this.secrets.get(apiKeySecret(id));
			if (apiKey) {
				await this.secrets.store(apiKeySecret(id), apiKey);
			} else {
				await this.secrets.delete(apiKeySecret(id));
			}
		}
		this.servers[idx] = { id, label, baseUrl: normalizedBaseUrl };
		try {
			await this.persist();
		} catch (error) {
			this.servers[idx] = previous;
			if (apiKey !== undefined) {
				try {
					if (previousKey === undefined) {
						await this.secrets.delete(apiKeySecret(id));
					} else {
						await this.secrets.store(apiKeySecret(id), previousKey);
					}
				} catch {
					// The restore failed too, so the entry (still at its old host)
					// would keep serving the NEW key - a credential that belongs
					// elsewhere. Deleting errs toward a missing credential (requests
					// 401 and the user re-enters), never a mismatched one. If even
					// the delete fails, the mismatch stands: reaching it takes a
					// Memento failure plus two consecutive SecretStorage write
					// failures, and SecretStorage offers no transaction to close
					// that last window on this legacy surface.
					try {
						await this.secrets.delete(apiKeySecret(id));
					} catch {
						// Ignored: the persist failure below is what the caller sees.
					}
				}
			}
			throw error;
		}
		// A server the group migration skipped is resolved by renaming or
		// repointing it, so the marker lifts as soon as the entry mutation
		// persists - the earlier secret operations may fail transiently and must
		// not leave the server permanently skipped. A marker another window adds
		// in the same instant self-heals by re-skipping.
		if (previous.label !== label || previous.baseUrl !== normalizedBaseUrl) {
			const skipped = this.globalState.get<unknown>(SKIPPED_MIGRATION_SERVERS_KEY);
			if (Array.isArray(skipped) && skipped.includes(id)) {
				const remaining = skipped.filter((skippedId) => skippedId !== id);
				await this.globalState.update(SKIPPED_MIGRATION_SERVERS_KEY, remaining.length > 0 ? remaining : undefined);
			}
		}
	}

	async removeServer(id: string): Promise<void> {
		this.assertMutable();
		await this.removeServerUnguarded(id);
	}

	/** See addServerUnguarded. */
	async removeServerUnguarded(id: string): Promise<void> {
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
