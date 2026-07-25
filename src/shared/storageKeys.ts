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

/** SecretStorage: API key for one registered server. */
export function apiKeySecret(serverId: string): string {
	return `litellm.apiKey.${serverId}`;
}

/**
 * SecretStorage: the pre-registry single-server configuration.
 * Read and deleted only by ServerRegistry.migrateLegacy().
 */
export const LEGACY_BASE_URL_SECRET = "litellm.baseUrl";
export const LEGACY_API_KEY_SECRET = "litellm.apiKey";
