/**
 * Central registry of every persistent storage key the extension uses.
 * Memento keys live in globalState; secret keys live in SecretStorage.
 */

/**
 * globalState: the retired legacy ServerConfig[] server registry blob. Nothing
 * reads it; the legacy-registry cleanup deletes it (and the per-server secrets
 * its entries reference) at activation.
 */
export const SERVER_REGISTRY_KEY = "litellm.serverRegistry";

/** globalState: set once the first-run welcome message has been shown. */
export const HAS_SHOWN_WELCOME_KEY = "litellm.hasShownWelcome";

/**
 * globalState: the last ConnectionStatus, restored into the status bar on
 * activation. An ephemeral display cache rewritten by the first provider
 * report each session, persisted as a version-stamped envelope
 * ({ v, status }; see PERSISTED_STATUS_VERSION in extension/ui/status.ts).
 * The restore accepts exactly the current version's shape; anything else
 * restores as undefined and the bar starts from scratch - a shape change
 * bumps the stamp instead of accreting legacy readings.
 */
export const LAST_CONNECTION_STATUS_KEY = "litellm.lastConnectionStatus";

/**
 * globalState: the retired provider-group migration's completion flag, set on
 * every install that ever activated a post-v0.3.1 build (fresh installs marked
 * themselves complete right away). The legacy-registry cleanup deletes it.
 */
export const GROUP_MIGRATION_COMPLETE_KEY = "litellm.groupMigrationComplete";

/**
 * globalState: the retired provider-group migration's seeded-progress records.
 * The legacy-registry cleanup deletes the key, deleting each record's
 * per-server secret first.
 */
export const SEEDED_PROVIDER_GROUPS_KEY = "litellm.seededProviderGroups";

/**
 * globalState: registry server IDs the retired provider-group migration parked
 * for manual review. The legacy-registry cleanup deletes it.
 */
export const SKIPPED_MIGRATION_SERVERS_KEY = "litellm.skippedMigrationServers";

/**
 * globalState: the retired provider-group migration's in-flight submission
 * marker. The legacy-registry cleanup deletes it.
 */
export const PENDING_GROUP_SUBMISSION_KEY = "litellm.pendingGroupSubmission";

/**
 * globalState: server IDs whose migrated secret the retired provider-group
 * migration could not delete. The legacy-registry cleanup deletes each listed
 * secret, then the key.
 */
export const PENDING_SECRET_DELETIONS_KEY = "litellm.pendingSecretDeletions";

/**
 * globalState: baseUrl -> labels for servers the retired provider-group
 * migration seeded, once the retired label-scoped modelParameters expansion's
 * read source. Nothing reads it; the legacy-registry cleanup deletes it.
 */
export const MIGRATED_SERVER_LABELS_KEY = "litellm.migratedServerLabels";

/**
 * globalState: [label, prefix] pairs the retired label-scoped modelParameters
 * expansion had already resolved into a declared entry's own record. Nothing
 * reads it; the legacy-registry cleanup deletes it.
 */
export const MIGRATED_ENTRY_PARAMETER_COPIES_KEY = "litellm.migratedEntryParameterCopies";

/**
 * globalState: ids of registry servers the retired provider-group migration
 * seeded, once the orphan cleanup's only accepted evidence. The legacy-registry
 * cleanup deletes it.
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
 * older builds' settings-redesign migration. RETIRED: the parked copy was by
 * construction a duplicate of headers already written into declared entries,
 * and its Apply/Discard recovery flow is deleted. The key survives only as a
 * purge target in legacyRegistryCleanup's LEGACY_STATE_KEYS.
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

/**
 * globalState: label -> credential-rotation counter for the MCP publisher. The
 * number rides each published definition as its version, so the editor is told
 * that a server's tools may answer differently now; it counts observed
 * rotations and nothing else, so no credential material is derivable from it.
 * Persisted because a counter that reset on every restart would announce a
 * rotation that never happened.
 */
export const MCP_ENTRY_VERSIONS_KEY = "litellm.mcpEntryVersions";

/**
 * workspaceState: the review comment threads of this workspace, as the schema
 * v1 envelope features/reviewComments/persistence.ts encodes. Workspace-scoped
 * because the threads are anchored to this workspace's files; written on every
 * thread mutation and read once, at feature init.
 */
export const REVIEW_COMMENT_THREADS_KEY = "litellm.reviewCommentThreads";

/** SecretStorage: API key for one server of the retired legacy registry; a legacy-registry cleanup target. */
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
const SERVER_SECRETS_KEY_PREFIX = "litellm.serverSecrets.";

export function serverSecretsKey(label: string): string {
	return `${SERVER_SECRETS_KEY_PREFIX}${label}`;
}

/**
 * Whether a SecretStorage change event concerns one of the per-label server
 * blobs. The one owner-level signal that a server credential changed, however
 * it was written (dashboard, palette, settings import, test command), so the
 * reaction wiring cannot miss a writer.
 */
export function isServerSecretsKey(key: string): boolean {
	return key.startsWith(SERVER_SECRETS_KEY_PREFIX);
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
 * SecretStorage: the pre-registry single-server configuration of v0.2.2 and
 * earlier. Deleted by the legacy-registry cleanup, never imported.
 */
export const LEGACY_BASE_URL_SECRET = "litellm.baseUrl";
export const LEGACY_API_KEY_SECRET = "litellm.apiKey";

/**
 * globalState: the retired single-server migration's interrupted-cleanup
 * marker; its object form lists orphaned per-server secret ids. The
 * legacy-registry cleanup deletes the listed secrets, then the key.
 */
export const LEGACY_CLEANUP_PENDING_KEY = "litellm.legacyCleanupPending";
