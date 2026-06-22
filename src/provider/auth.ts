import type { ServerWithKey } from "../extension/serverRegistry";

interface OAuthTokenResponse {
	access_token?: unknown;
	token_type?: unknown;
	expires_in?: unknown;
}

interface CachedOAuthToken {
	accessToken: string;
	expiresAt: number;
}

const oauthTokenCache = new Map<string, CachedOAuthToken>();
const OAUTH_TOKEN_EXPIRY_SKEW_MS = 60_000;
const DEFAULT_OAUTH_TOKEN_TTL_MS = 55 * 60_000;

export function clearOAuthTokenCache(): void {
	oauthTokenCache.clear();
}

export async function getAuthHeaders(
	server: ServerWithKey,
	log: (message: string, data?: unknown) => void,
	logError: (message: string, error: unknown) => void,
	timeout: number
): Promise<Record<string, string>> {
	if (server.auth.type === "oauth2") {
		const accessToken = await getOAuthAccessToken(server, log, logError, timeout);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${accessToken}`,
		};
		if (server.oauthVirtualKey.trim()) {
			headers[server.auth.virtualKeyHeader] = server.oauthVirtualKey.trim();
		}
		return headers;
	}

	if (!server.apiKey) {
		return {};
	}
	return {
		Authorization: `Bearer ${server.apiKey}`,
		"X-API-Key": server.apiKey,
	};
}

async function getOAuthAccessToken(
	server: ServerWithKey,
	log: (message: string, data?: unknown) => void,
	_logError: (message: string, error: unknown) => void,
	timeout: number
): Promise<string> {
	const auth = server.auth;
	if (auth.type !== "oauth2") {
		throw new Error(`OAuth2 authentication is not configured for server "${server.label}"`);
	}
	if (!auth.tokenUrl.trim()) {
		throw new Error(`OAuth2 token URL is not configured for server "${server.label}"`);
	}
	if (!server.oauthClientId.trim() || !server.oauthClientSecret) {
		throw new Error(`OAuth2 client credentials are not configured for server "${server.label}"`);
	}

	const cacheKey = `${server.id}:${auth.tokenUrl}:${server.oauthClientId}:${server.oauthClientSecret}`;
	const cached = oauthTokenCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.accessToken;
	}

	log("Requesting OAuth2 access token", { server: server.label, tokenUrl: auth.tokenUrl });
	const body = new URLSearchParams({
		grant_type: "client_credentials",
		client_id: server.oauthClientId,
		client_secret: server.oauthClientSecret,
	});

	const response = await fetch(auth.tokenUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: body.toString(),
		signal: AbortSignal.timeout(timeout),
	});

	if (!response.ok) {
		throw new Error(
			`OAuth2 token request failed for server "${server.label}": ${response.status} ${response.statusText}`
		);
	}

	const parsed = (await response.json()) as OAuthTokenResponse;
	if (typeof parsed.access_token !== "string" || !parsed.access_token) {
		throw new Error(`OAuth2 token response for server "${server.label}" did not include an access_token`);
	}

	const parsedExpiresIn =
		typeof parsed.expires_in === "number"
			? parsed.expires_in
			: typeof parsed.expires_in === "string"
				? Number(parsed.expires_in)
				: 0;
	const expiresInSeconds = Number.isFinite(parsedExpiresIn) ? parsedExpiresIn : 0;
	const ttlMs =
		expiresInSeconds > 0
			? Math.max(0, expiresInSeconds * 1000 - OAUTH_TOKEN_EXPIRY_SKEW_MS)
			: DEFAULT_OAUTH_TOKEN_TTL_MS;
	oauthTokenCache.set(cacheKey, { accessToken: parsed.access_token, expiresAt: Date.now() + ttlMs });
	return parsed.access_token;
}
