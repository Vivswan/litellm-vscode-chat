/**
 * Central registry of every persistent storage key the extension uses.
 * Memento keys live in globalState; secret keys live in SecretStorage.
 */

/** globalState: the ServerConfig[] server registry. */
export const SERVER_REGISTRY_KEY = "litellm.serverRegistry";

/** globalState: set once the first-run welcome message has been shown. */
export const HAS_SHOWN_WELCOME_KEY = "litellm.hasShownWelcome";

/** globalState: the last ConnectionStatus, restored into the status bar on activation. */
export const LAST_CONNECTION_STATUS_KEY = "litellm.lastConnectionStatus";

/**
 * globalState: set once every registry server has been handed to VS Code as a
 * provider group, or right away on a fresh install with nothing to migrate
 * (src/extension/migrations/registryToProviderGroups.ts).
 */
export const GROUP_MIGRATION_COMPLETE_KEY = "litellm.groupMigrationComplete";

/**
 * globalState: records of groups already seeded into VS Code ({ id, name,
 * label, baseUrl, keyFingerprint }), persisted after each success so a retried
 * migration never re-submits a group the host accepted. Cleared when the
 * migration completes. Owned by
 * src/extension/migrations/registryToProviderGroups.ts, like every group
 * migration key below.
 */
export const SEEDED_PROVIDER_GROUPS_KEY = "litellm.seededProviderGroups";

/**
 * globalState: registry server IDs the migration must leave alone: their
 * group's configuration could not be verified (a name collision or an edit
 * that raced the seeding), so removing the entry could destroy the only
 * correct copy. The user resolves them manually.
 */
export const SKIPPED_MIGRATION_SERVERS_KEY = "litellm.skippedMigrationServers";

/**
 * globalState: the group submission currently in flight ({ id, name, baseUrl,
 * keyFingerprint }), written just before the host command and cleared after
 * the progress write or a pre-accept failure. An "already exists" rejection
 * counts as our own seeding only when this marker matches the server's
 * current identity; without it the name collision belongs to someone else.
 */
export const PENDING_GROUP_SUBMISSION_KEY = "litellm.pendingGroupSubmission";

/**
 * globalState: server IDs whose migrated secret could not be deleted at
 * finalization; retried on every activation until empty.
 */
export const PENDING_SECRET_DELETIONS_KEY = "litellm.pendingSecretDeletions";

/**
 * globalState: baseUrl -> labels for servers that were migrated to provider
 * groups. The label-scoped-modelParameters migration reads it forever to add
 * base-URL-scoped copies of label-scoped keys; the runtime no longer matches
 * labels itself.
 */
export const MIGRATED_SERVER_LABELS_KEY = "litellm.migratedServerLabels";

/**
 * globalState: JSON-encoded [label, prefix] pairs whose label-scoped
 * modelParameters key was already resolved into a declared entry's own
 * modelParameters record (written, or found already present). Each source
 * key migrates into an entry AT MOST ONCE: the sources are copied, never
 * moved, so without this ledger a user deleting the migrated key from the
 * entry would see it resurrected on the next activation. Owned by
 * src/extension/migrations/labelScopedModelParameters.ts.
 */
export const MIGRATED_ENTRY_PARAMETER_COPIES_KEY = "litellm.migratedEntryParameterCopies";

/**
 * globalState: ids of registry servers that were seeded into provider groups,
 * unioned at every finalization and never cleared. The only evidence the
 * post-completion orphan cleanup accepts before deleting an entry: labels and
 * base URLs recur when a user re-adds a server, ids never do. Owned by
 * src/extension/migrations/registryToProviderGroups.ts.
 */
export const MIGRATED_SERVER_IDS_KEY = "litellm.migratedServerIds";

/** SecretStorage: API key for one registered server. */
export function apiKeySecret(serverId: string): string {
	return `litellm.apiKey.${serverId}`;
}

/**
 * globalState: label -> non-secret fingerprint of the last provider-group
 * configuration the server sync engine pushed to the host, so unchanged
 * entries skip the upsert and removed entries are detectable.
 */
export const SERVER_SYNC_FINGERPRINTS_KEY = "litellm.serverSyncFingerprints";

/**
 * SecretStorage: the secure-side secrets of one litellm-vscode-chat.servers
 * entry, keyed by its label: a JSON blob holding any of apiKey,
 * oauthClientSecret, and virtualKeyValue the user chose not to keep inline
 * in settings.
 */
export function serverSecretsKey(label: string): string {
	return `litellm.serverSecrets.${label}`;
}

/**
 * SecretStorage: the pre-registry single-server configuration.
 * Read and deleted only by src/extension/migrations/legacySingleServer.ts.
 */
export const LEGACY_BASE_URL_SECRET = "litellm.baseUrl";
export const LEGACY_API_KEY_SECRET = "litellm.apiKey";

/**
 * globalState: set after the legacy single-server config became a registry
 * entry but before its secrets are deleted, cleared once they are. While set,
 * the deletions are retried on every activation, even after the group
 * migration has emptied the registry, so lingering legacy secrets can never
 * re-import stale config. `true` for a plain interrupted run; an import that
 * lost a cross-window race carries the orphaned per-server secret ids still
 * to delete. Owned by src/extension/migrations/legacySingleServer.ts.
 */
export const LEGACY_CLEANUP_PENDING_KEY = "litellm.legacyCleanupPending";
