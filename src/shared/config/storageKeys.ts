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
 * provider group, or right away on a fresh install with nothing to migrate.
 */
export const GROUP_MIGRATION_COMPLETE_KEY = "litellm.groupMigrationComplete";

/**
 * globalState: records of groups already seeded into VS Code, persisted after
 * each success so a retried migration never re-submits a group the host
 * accepted. Cleared when the migration completes.
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
 * globalState: the group submission currently in flight, written just before
 * the host command and cleared after. An "already exists" rejection counts as
 * our own seeding only when this marker matches the server's current identity;
 * without it the name collision belongs to someone else.
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
 * globalState: [label, prefix] pairs whose label-scoped modelParameters key
 * was already resolved into a declared entry's own record. Each source key
 * migrates into an entry AT MOST ONCE: the sources are copied, never moved, so
 * without this ledger a user deleting the migrated key from the entry would
 * see it resurrected on the next activation.
 */
export const MIGRATED_ENTRY_PARAMETER_COPIES_KEY = "litellm.migratedEntryParameterCopies";

/**
 * globalState: ids of registry servers that were seeded into provider groups,
 * unioned at every finalization and never cleared. The only evidence the
 * post-completion orphan cleanup accepts before deleting an entry: labels and
 * base URLs recur when a user re-adds a server, ids never do.
 */
export const MIGRATED_SERVER_IDS_KEY = "litellm.migratedServerIds";

/**
 * globalState: advisory refresh metadata for the OpenRouter capability
 * catalog, used only to schedule the next weekly refresh. The catalog itself
 * is a file under globalStorage - globalState is not transactional and can
 * revert, so a lost timestamp costs at most an early refresh, never data.
 */
export const OPENROUTER_CATALOG_METADATA_KEY = "litellm.openRouterCatalogMetadata";

/**
 * globalState: the removed global `headers` setting's last value, parked by
 * the settings-redesign migration when it deletes the key. The old setting
 * reached servers without a declared entry, which the redesigned per-entry
 * headers cannot express, so the parked copy keeps that loss recoverable.
 * Written at most once and never overwritten.
 */
export const PARKED_GLOBAL_HEADERS_KEY = "litellm.parkedGlobalHeaders";

/**
 * globalState: the last opened issue report. The fingerprint is the
 * diagnostics snapshot's signature - version, connection state, counts,
 * configured flags, and error classification enums, never log or response
 * text - and the repeat-report hint compares against it before opening a
 * look-alike report within the recency window.
 */
export const LAST_ISSUE_REPORT_KEY = "litellm.lastIssueReport";

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
 * globalState: label -> normalized base URL for the entries the sync engine
 * saw declared, written every pass. The removal path's identity ledger: when a
 * label leaves the setting (possibly while VS Code was closed), this is what
 * still knows which host its provider group pointed at.
 */
export const SYNCED_ENTRY_BASE_URLS_KEY = "litellm.syncedEntryBaseUrls";

/**
 * globalState: identities of provider groups the user explicitly removed. The
 * provider answers a tombstoned group with an empty model list; the dashboard
 * lists it under "hidden groups". Cleared per identity when a matching
 * declared entry reappears or the user unhides the group.
 */
export const REMOVED_GROUP_TOMBSTONES_KEY = "litellm.removedGroupTombstones";

/**
 * globalState: identity -> origin classification for provider groups a removal
 * or rename orphaned: which entry removal left the group behind, or which
 * rename it predates. Labels and classifications only, never free text.
 */
export const ORPHANED_GROUP_PROVENANCE_KEY = "litellm.orphanedGroupProvenance";

/**
 * SecretStorage: the secure-side secrets of one litellm-vscode-chat.servers
 * entry, keyed by its label: a JSON blob holding any of apiKey,
 * oauthClientSecret, and virtualKeyValue the user chose not to keep inline.
 */
export function serverSecretsKey(label: string): string {
	return `litellm.serverSecrets.${label}`;
}

/**
 * SecretStorage: the pre-import snapshot behind "Undo Last Settings Import",
 * one JSON blob holding every litellm-vscode-chat.* user-scope value plus the
 * touched labels' previous secret blobs. The settings half can carry inline
 * secret text, so the WHOLE snapshot lives under this one key - never a
 * plaintext file, never globalState. One slot: each import overwrites it, undo
 * clears it.
 */
export const PRE_IMPORT_SNAPSHOT_SECRET = "litellm.preImportSnapshot";

/**
 * SecretStorage: the per-install fingerprint salt, 32 random bytes as hex,
 * generated on the first activation that finds none. The lifecycle rules live
 * in src/extension/fingerprintSalt.ts (never regenerate while one exists;
 * never store over a failed read).
 */
export const FINGERPRINT_SALT_SECRET = "litellm.fingerprintSalt";

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
 * to delete.
 */
export const LEGACY_CLEANUP_PENDING_KEY = "litellm.legacyCleanupPending";
