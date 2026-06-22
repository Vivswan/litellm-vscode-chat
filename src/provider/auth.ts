import type { OAuthSecrets } from "../extension/serverRegistry";

/** Default header the LiteLLM proxy expects the virtual/client key in. */
export const DEFAULT_VIRTUAL_KEY_HEADER = "X-LLM-API-CLIENT-ID";

interface CachedToken {
	token: string;
	expiresAt: number;
}

// Token cache keyed by server id. OAuth access tokens are short-lived, so we
// reuse a cached token until shortly before it expires instead of hitting the
// IDP on every request/discovery.
const tokenCache = new Map<string, CachedToken>();

/** Drop any cached token for a server (call when its OAuth config changes or it is removed). */
export function clearTokenCache(serverId?: string): void {
	if (serverId === undefined) {
		tokenCache.clear();
	} else {
		tokenCache.delete(serverId);
	}
}

async function getOAuthToken(
	serverId: string,
	oauth: OAuthSecrets,
	timeout: number,
	log?: (message: string, data?: unknown) => void
): Promise<string> {
	const now = Date.now();
	const cached = tokenCache.get(serverId);
	if (cached && cached.expiresAt > now) {
		return cached.token;
	}

	log?.("Requesting OAuth token", { idpUrl: oauth.idpUrl, clientId: oauth.clientId });
	const response = await fetch(oauth.idpUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "client_credentials",
			client_id: oauth.clientId,
			client_secret: oauth.clientSecret,
		}).toString(),
		signal: AbortSignal.timeout(timeout),
	});

	if (!response.ok) {
		let text = "";
		try {
			text = await response.text();
		} catch {
			// ignore body read failures
		}
		throw new Error(`OAuth token request failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ""}`);
	}

	const data = (await response.json()) as { access_token?: string; expires_in?: number };
	if (!data.access_token) {
		throw new Error("OAuth token response did not include an access_token");
	}

	// Refresh early so an in-flight request never carries a just-expired token, but
	// clamp the skew so short-lived tokens (expires_in <= 60) stay cached for a usable
	// window instead of being treated as already expired and re-fetched every call.
	const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 300;
	const refreshSkew = Math.min(60, Math.floor(expiresIn / 2));
	tokenCache.set(serverId, { token: data.access_token, expiresAt: now + (expiresIn - refreshSkew) * 1000 });
	return data.access_token;
}

export interface AuthResolvable {
	id: string;
	apiKey: string;
	auth?: { type: "oauth" };
	oauth?: OAuthSecrets;
}

/**
 * Resolves the authentication headers for a server. For OAuth servers this
 * fetches (and caches) a bearer token via the client-credentials flow and adds
 * the virtual-key header; for API-key servers it returns the static
 * Authorization / X-API-Key headers. Returns an empty object when nothing is
 * configured (e.g. a key-less local proxy).
 */
export async function resolveAuthHeaders(
	server: AuthResolvable,
	log?: (message: string, data?: unknown) => void,
	timeout = 30000
): Promise<Record<string, string>> {
	if (server.auth?.type === "oauth" && server.oauth) {
		const token = await getOAuthToken(server.id, server.oauth, timeout, log);
		const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
		if (server.oauth.virtualKey) {
			// The virtual/client key is an opaque identifier: send it verbatim so servers
			// that expect the value as-is work. If a gateway needs a prefix (e.g. "Bearer "),
			// the user includes it in the virtual key value itself.
			const headerName = server.oauth.virtualKeyHeader || DEFAULT_VIRTUAL_KEY_HEADER;
			headers[headerName] = server.oauth.virtualKey;
		}
		return headers;
	}

	if (server.apiKey) {
		return { Authorization: `Bearer ${server.apiKey}`, "X-API-Key": server.apiKey };
	}

	return {};
}
