/**
 * Central registry of every persistent storage key the extension uses.
 */

/** globalState: set once the first-run welcome message has been shown. */
export const HAS_SHOWN_WELCOME_KEY = "litellm.hasShownWelcome";

/**
 * globalState: the last ConnectionStatus, restored into the status bar on activation. An ephemeral display cache
 * rewritten by the first provider report each session, persisted as a version-stamped envelope ({ v, status }; see
 * PERSISTED_STATUS_VERSION in extension/ui/status.ts).
 */
export const LAST_CONNECTION_STATUS_KEY = "litellm.lastConnectionStatus";

/**
 * The catalog itself is a file under globalStorage - globalState is not transactional and can revert, so a lost
 * timestamp costs at most an early refresh, never data.
 */
export const OPENROUTER_CATALOG_METADATA_KEY = "litellm.openRouterCatalogMetadata";

/**
 * globalState: the last opened issue report. The fingerprint is the diagnostics snapshot's signature - version,
 * connection state, counts, configured flags, and error classification enums, never log or response text - and the
 * repeat-report hint compares against it before opening a look-alike report within the recency window.
 */
export const LAST_ISSUE_REPORT_KEY = "litellm.lastIssueReport";

/**
 * globalState: label -> credential-rotation counter for the MCP publisher.
 * Persisted because a counter that reset on every restart would announce a rotation that never happened.
 *
 *   The number rides each published definition as its version  -> the editor is told that a server's tools may
 *                                                                  answer differently now
 *   it counts observed rotations and nothing else               -> no credential material is derivable from it
 */
export const MCP_ENTRY_VERSIONS_KEY = "litellm.mcpEntryVersions";

/**
 * workspaceState: the review comment threads of this workspace, as the schema v1 envelope
 * features/reviewComments/persistence.ts encodes. Workspace-scoped because the threads are anchored to this workspace's
 * files.
 */
export const REVIEW_COMMENT_THREADS_KEY = "litellm.reviewCommentThreads";

/**
 * globalState: label -> non-secret fingerprint of the last provider-group configuration the server sync engine pushed
 * to the host.
 */
export const SERVER_SYNC_FINGERPRINTS_KEY = "litellm.serverSyncFingerprints";

/**
 * globalState: label -> base URL (one spelling, serverSync/vscodeEnv.ts canonicalEntryBaseUrls on read) for the
 * entries the sync engine saw declared, written every pass. The removal path's identity ledger: when a label leaves
 * the setting (possibly while VS Code was closed), this is what still knows which host its provider group pointed at.
 */
export const SYNCED_ENTRY_BASE_URLS_KEY = "litellm.syncedEntryBaseUrls";

/**
 * globalState: identities of provider groups the user explicitly removed. The provider answers a tombstoned group with
 * an empty model list; the dashboard lists it under "hidden groups".
 *   a matching declared entry reappears or the user unhides the group -> Cleared per identity
 */
export const REMOVED_GROUP_TOMBSTONES_KEY = "litellm.removedGroupTombstones";

/**
 * globalState: identity -> origin classification for provider groups a removal or rename orphaned: which entry removal
 * left the group behind, or which rename it predates.
 */
export const ORPHANED_GROUP_PROVENANCE_KEY = "litellm.orphanedGroupProvenance";

/**
 * SecretStorage: the secure-side secrets of one litellm-vscode-chat.servers entry, keyed by its label: a JSON blob
 * holding any of apiKey, oauthClientSecret, and virtualKeyValue the user chose not to keep inline.
 */
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

/**
 * SecretStorage: the pre-import snapshot behind "Undo Last Settings Import", one JSON blob holding every
 * litellm-vscode-chat.* user-scope value plus the touched labels' previous secret blobs. The settings half can carry
 * inline secret text, so the WHOLE snapshot lives under this one key - never a plaintext file, never globalState.
 */
export const PRE_IMPORT_SNAPSHOT_SECRET = "litellm.preImportSnapshot";

/**
 * SecretStorage: the per-install fingerprint salt, 32 random bytes as hex, generated on the first activation that finds
 * none. The lifecycle rules live in src/extension/fingerprintSalt.ts (never regenerate while one exists; never store
 * over a failed read).
 */
export const FINGERPRINT_SALT_SECRET = "litellm.fingerprintSalt";
