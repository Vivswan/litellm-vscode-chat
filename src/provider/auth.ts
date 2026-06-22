import { DEFAULT_VIRTUAL_KEY_HEADER } from "../extension/serverRegistry";
import type { ServerWithKey } from "../extension/serverRegistry";

/** Clock-skew safety margin (ms) applied before a cached token's expiry. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
/** Fallback token lifetime (ms) used when the IdP omits expires_in. */
const FALLBACK_TOKEN_TTL_MS = 5 * 60_000;

export type FetchLike = typeof globalThis.fetch;

export type LogFn = (message: string, data?: unknown) => void;

interface ApiKeyAuth {
	method: "apiKey";
	apiKey: string;
}

interface OAuthAuth {
	method: "oauth2";
	tokenUrl: string;
	clientId: string;
	clientSecret: string;
	virtualKey?: string;
	virtualKeyHeader: string;
}

export type AuthContext = ApiKeyAuth | OAuthAuth;

interface CachedToken {
	accessToken: string;
	/** Epoch ms at which the token should be considered expired (margin already applied). */
	expiresAt: number;
}

/** In-memory cache of OAuth tokens, keyed by tokenUrl + clientId + clientSecret. */
const tokenCache = new Map<string, CachedToken>();

/** Clears the cached OAuth token(s). Exposed for tests. */
export function clearTokenCache(): void {
	tokenCache.clear();
}

function tokenCacheKey(auth: OAuthAuth): string {
	return `${auth.tokenUrl}\u0000${auth.clientId}\u0000${auth.clientSecret}`;
}

/** Maps a stored server (with secrets) to a resolved auth context. */
export function buildAuthFromServer(server: ServerWithKey): AuthContext {
	if (server.authMethod === "oauth2") {
		return {
			method: "oauth2",
			tokenUrl: server.oauthTokenUrl ?? "",
			clientId: server.oauthClientId ?? "",
			clientSecret: server.oauthClientSecret ?? "",
			virtualKey: server.oauthVirtualKey || undefined,
			virtualKeyHeader: server.oauthVirtualKeyHeader?.trim() || DEFAULT_VIRTUAL_KEY_HEADER,
		};
	}
	return { method: "apiKey", apiKey: server.apiKey ?? "" };
}

interface OAuthTokenResponse {
	access_token?: string;
	token_type?: string;
	expires_in?: number;
}

async function fetchOAuthToken(auth: OAuthAuth, fetchImpl: FetchLike, log?: LogFn): Promise<CachedToken> {
	if (!auth.tokenUrl || !auth.clientId || !auth.clientSecret) {
		throw new Error(
			"OAuth2 is not fully configured for this server. Please run the \"Manage LiteLLM Provider\" command and provide the Token URL, Client ID, and Client Secret."
		);
	}

	const body = new URLSearchParams({
		grant_type: "client_credentials",
		client_id: auth.clientId,
		client_secret: auth.clientSecret,
	});

	log?.("Requesting OAuth2 access token", { tokenUrl: auth.tokenUrl, clientId: auth.clientId });

	let response: Response;
	try {
		response = await fetchImpl(auth.tokenUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: body.toString(),
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`OAuth2 token request failed: unable to reach token endpoint ${auth.tokenUrl}. ${msg}`, {
			cause: error,
		});
	}

	if (!response.ok) {
		let detail = "";
		try {
			detail = await response.text();
		} catch {
			// ignore body read errors
		}
		throw new Error(
			`OAuth2 token request failed: ${response.status} ${response.statusText}${detail ? `\n${detail}` : ""}`
		);
	}

	let parsed: OAuthTokenResponse;
	try {
		parsed = (await response.json()) as OAuthTokenResponse;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`OAuth2 token request failed: could not parse token response as JSON. ${msg}`, {
			cause: error,
		});
	}

	const accessToken = parsed.access_token;
	if (!accessToken) {
		throw new Error("OAuth2 token request failed: response did not include an access_token.");
	}

	const lifetimeMs =
		typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in) && parsed.expires_in > 0
			? parsed.expires_in * 1000
			: FALLBACK_TOKEN_TTL_MS;
	const expiresAt = Date.now() + Math.max(0, lifetimeMs - TOKEN_EXPIRY_MARGIN_MS);

	return { accessToken, expiresAt };
}

async function getOAuthToken(auth: OAuthAuth, fetchImpl: FetchLike, log?: LogFn): Promise<string> {
	const key = tokenCacheKey(auth);
	const cached = tokenCache.get(key);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.accessToken;
	}
	const token = await fetchOAuthToken(auth, fetchImpl, log);
	tokenCache.set(key, token);
	return token.accessToken;
}

/**
 * Resolves the HTTP headers used to authenticate a request to the LiteLLM server.
 * For OAuth2 this performs (and caches) the client-credentials token exchange.
 */
export async function getAuthHeaders(
	auth: AuthContext,
	fetchImpl: FetchLike = globalThis.fetch,
	log?: LogFn
): Promise<Record<string, string>> {
	if (auth.method === "oauth2") {
		const token = await getOAuthToken(auth, fetchImpl, log);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			"X-API-Key": token,
		};
		if (auth.virtualKey) {
			headers[auth.virtualKeyHeader] = auth.virtualKey;
		}
		return headers;
	}

	const headers: Record<string, string> = {};
	if (auth.apiKey) {
		headers.Authorization = `Bearer ${auth.apiKey}`;
		headers["X-API-Key"] = auth.apiKey;
	}
	return headers;
}
