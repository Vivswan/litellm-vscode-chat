/**
 * Central registry of every persistent storage key the extension uses.
 *
 * A key called retired below is one the legacy-registry cleanup (legacyRegistryCleanup) deletes. The retired
 * globalState keys are its LEGACY_STATE_KEYS. The retired SecretStorage entries (the per-server API keys those keys
 * name, and the two pre-registry single-server secrets) are not in that list: the cleanup deletes them through
 * SecretStorage.
 */

/** globalState: the retired ServerConfig[] registry blob; deleted with the per-server secrets it names. */
export const SERVER_REGISTRY_KEY = "litellm.serverRegistry";

/** globalState: set once the first-run welcome message has been shown. */
export const HAS_SHOWN_WELCOME_KEY = "litellm.hasShownWelcome";

/** globalState: the last ConnectionStatus, a display cache the first provider report of each session rewrites. */
export const LAST_CONNECTION_STATUS_KEY = "litellm.lastConnectionStatus";

/** globalState: the retired provider-group migration's completion flag. */
export const GROUP_MIGRATION_COMPLETE_KEY = "litellm.groupMigrationComplete";

/** globalState: the retired group migration's seeded-progress records; each record's secret is deleted first. */
export const SEEDED_PROVIDER_GROUPS_KEY = "litellm.seededProviderGroups";

/** globalState: registry server IDs the retired group migration parked for manual review. */
export const SKIPPED_MIGRATION_SERVERS_KEY = "litellm.skippedMigrationServers";

/** globalState: the retired group migration's in-flight submission marker. */
export const PENDING_GROUP_SUBMISSION_KEY = "litellm.pendingGroupSubmission";

/** globalState: server IDs whose migrated secret the retired migration left behind; those secrets go first. */
export const PENDING_SECRET_DELETIONS_KEY = "litellm.pendingSecretDeletions";

/** globalState: baseUrl -> labels of migration-seeded servers, once the retired label-scoped expansion's source. */
export const MIGRATED_SERVER_LABELS_KEY = "litellm.migratedServerLabels";

/** globalState: [label, prefix] pairs the retired label-scoped expansion had resolved into an entry's own record. */
export const MIGRATED_ENTRY_PARAMETER_COPIES_KEY = "litellm.migratedEntryParameterCopies";

/** globalState: ids of registry servers the retired migration seeded, once the orphan cleanup's only evidence. */
export const MIGRATED_SERVER_IDS_KEY = "litellm.migratedServerIds";

/** globalState: the catalog's fetch time; the catalog is a globalStorage file, so a revert here costs one refresh. */
export const OPENROUTER_CATALOG_METADATA_KEY = "litellm.openRouterCatalogMetadata";

/** globalState: the removed global headers setting's last value, parked by older builds; retired, purged only. */
export const PARKED_GLOBAL_HEADERS_KEY = "litellm.parkedGlobalHeaders";

/** globalState: the last report's fingerprint (repeat hint): the snapshot's signature, never log or response text. */
export const LAST_ISSUE_REPORT_KEY = "litellm.lastIssueReport";

/** globalState: label -> MCP rotation count (mcp/versions.ts), persisted so a restart announces no false rotation. */
export const MCP_ENTRY_VERSIONS_KEY = "litellm.mcpEntryVersions";

/** workspaceState: the review threads (reviewComments/persistence.ts); workspace-scoped as they anchor to its files. */
export const REVIEW_COMMENT_THREADS_KEY = "litellm.reviewCommentThreads";

/** SecretStorage: API key for one server of the retired legacy registry; a legacy-registry cleanup target. */
export function apiKeySecret(serverId: string): string {
	return `litellm.apiKey.${serverId}`;
}

/** globalState: label -> non-secret fingerprint of the last provider-group configuration the sync engine pushed. */
export const SERVER_SYNC_FINGERPRINTS_KEY = "litellm.serverSyncFingerprints";

/** globalState: label -> base URL per declared entry, so a removal still knows a vanished label's host. */
export const SYNCED_ENTRY_BASE_URLS_KEY = "litellm.syncedEntryBaseUrls";

/** globalState: removed group identities, served empty and hidden until the entry reappears or the user unhides one. */
export const REMOVED_GROUP_TOMBSTONES_KEY = "litellm.removedGroupTombstones";

/** globalState: identity -> which entry removal or rename orphaned the provider group. */
export const ORPHANED_GROUP_PROVENANCE_KEY = "litellm.orphanedGroupProvenance";

/** SecretStorage: an entry's secure-side apiKey, oauthClientSecret, and virtualKeyValue as one blob, by label. */
const SERVER_SECRETS_KEY_PREFIX = "litellm.serverSecrets.";

export function serverSecretsKey(label: string): string {
	return `${SERVER_SECRETS_KEY_PREFIX}${label}`;
}

/**
 * Whether a SecretStorage change event concerns one of the per-label server blobs. The one owner-level signal that a
 * server credential changed, however it was written (dashboard, palette, settings import, test command), so the
 * reaction wiring cannot miss a writer.
 */
export function isServerSecretsKey(key: string): boolean {
	return key.startsWith(SERVER_SECRETS_KEY_PREFIX);
}

/** SecretStorage: the whole "Undo Last Settings Import" snapshot, as its settings half can carry inline secrets. */
export const PRE_IMPORT_SNAPSHOT_SECRET = "litellm.preImportSnapshot";

/** SecretStorage: the per-install 32-byte hex fingerprint salt; extension/fingerprintSalt.ts owns its lifecycle. */
export const FINGERPRINT_SALT_SECRET = "litellm.fingerprintSalt";

/** SecretStorage: the pre-registry (v0.2.2 and earlier) single server's base URL; retired, never imported. */
export const LEGACY_BASE_URL_SECRET = "litellm.baseUrl";

/** SecretStorage: the pre-registry single server's API key; retired, deleted and never imported. */
export const LEGACY_API_KEY_SECRET = "litellm.apiKey";

/** globalState: the retired single-server migration's interrupted-cleanup marker, listing orphaned secret ids. */
export const LEGACY_CLEANUP_PENDING_KEY = "litellm.legacyCleanupPending";
