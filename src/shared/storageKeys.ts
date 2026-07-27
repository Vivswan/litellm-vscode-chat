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

/** globalState: set once every registry server has been handed to VS Code as a provider group. */
export const GROUP_MIGRATION_COMPLETE_KEY = "litellm.groupMigrationComplete";

/**
 * globalState: records of groups already seeded into VS Code ({ id, name,
 * label, baseUrl, keyFingerprint }), persisted after each success so a retried
 * migration never re-submits a group the host accepted. Cleared when the
 * migration completes.
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
 * groups, so label-scoped modelParameters entries keep matching.
 */
export const MIGRATED_SERVER_LABELS_KEY = "litellm.migratedServerLabels";

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
 * Read and deleted only by ServerRegistry.migrateLegacy().
 */
export const LEGACY_BASE_URL_SECRET = "litellm.baseUrl";
export const LEGACY_API_KEY_SECRET = "litellm.apiKey";
