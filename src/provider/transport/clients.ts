import OpenAI from "openai";
import { apiRootOf } from "../../shared/util/baseUrl";
import { fingerprint } from "../../shared/util/fingerprint";

export interface ServerClientConfig {
	serverId: string;
	baseUrl: string;
	/**
	 * The entry's apiVersion override: undefined means auto (keep a version
	 * segment already in the URL, else append /v1), "" means the base URL is
	 * the API root as-is. See apiRootOf.
	 */
	apiVersion?: string | undefined;
	/** Empty string for keyless servers. */
	apiKey: string;
	userAgent: string;
	customHeaders: Record<string, string>;
}

/**
 * Never sent: the SDK omits auth entirely when Authorization is nulled out,
 * and a configured custom Authorization header wins the default-headers merge.
 * It only satisfies the SDK's constructor-time credential check for keyless
 * servers.
 */
const KEYLESS_PLACEHOLDER = "keyless";

/**
 * SDK request paths, relative to the client's base URL. The *Url helpers state
 * exactly what the transport calls - those log lines feed public issue reports
 * and must not drift from the real requests - so their apiVersion parameter is
 * required: a caller cannot silently log the auto root for a client built on
 * an overridden one.
 */
export const MODEL_INFO_PATH = "/model/info";
export const MODELS_PATH = "/models";
export const CHAT_COMPLETIONS_PATH = "/chat/completions";
export const COMPLETIONS_PATH = "/completions";

/** The absolute model-discovery endpoint, for logs; requests go through MODEL_INFO_PATH on the client. */
export function modelInfoUrl(baseUrl: string, apiVersion: string | undefined): string {
	return `${apiRootOf(baseUrl, apiVersion)}${MODEL_INFO_PATH}`;
}

/** The absolute models-listing endpoint, for logs; requests go through MODELS_PATH on the client. */
export function modelsUrl(baseUrl: string, apiVersion: string | undefined): string {
	return `${apiRootOf(baseUrl, apiVersion)}${MODELS_PATH}`;
}

/** The absolute chat endpoint, for logs; requests go through CHAT_COMPLETIONS_PATH on the client. */
export function chatCompletionsUrl(baseUrl: string, apiVersion: string | undefined): string {
	return `${apiRootOf(baseUrl, apiVersion)}${CHAT_COMPLETIONS_PATH}`;
}

/** The absolute text-completions (FIM) endpoint; the one route inline completions call. */
export function completionsUrl(baseUrl: string, apiVersion: string | undefined): string {
	return `${apiRootOf(baseUrl, apiVersion)}${COMPLETIONS_PATH}`;
}

/** Non-secret change detector for a server's client-relevant config; never embeds the API key itself. */
function fingerprintOf(config: ServerClientConfig): string {
	const headerPart = Object.entries(config.customHeaders)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}:${value}`)
		.join("\n");
	// Joined on NUL (spelled as an escape so the file stays text-diffable): the
	// byte cannot occur inside any part, so the join is unambiguous. An unset
	// apiVersion must not collide with the "" override, so set values carry "=".
	const apiVersionPart = config.apiVersion === undefined ? "" : `=${config.apiVersion}`;
	return fingerprint(
		[config.baseUrl, apiVersionPart, config.userAgent, headerPart, fingerprint(config.apiKey)].join("\u0000")
	);
}

/**
 * Default headers precedence: custom headers, then the extension's User-Agent,
 * then auth. A set API key owns both auth headers (Authorization from the
 * SDK's bearer auth, X-API-Key here for gateway compatibility) and conflicting
 * custom headers are dropped; keyless servers send no auth header unless the
 * user configured their own Authorization. A null value means "send no such
 * header". Exported as the one owner of this precedence rule: the
 * extension-side usage client reuses it for its root-level GETs, with an
 * explicit Bearer Authorization since no SDK adds one there.
 */
export function buildDefaultHeaders(
	config: Pick<ServerClientConfig, "apiKey" | "userAgent" | "customHeaders">
): Record<string, string | null> {
	const headers: Record<string, string | null> = { ...config.customHeaders, "User-Agent": config.userAgent };
	const hasCustomAuthorization = Object.keys(config.customHeaders).some((key) => key.toLowerCase() === "authorization");
	if (config.apiKey) {
		for (const key of Object.keys(headers)) {
			const lower = key.toLowerCase();
			if (lower === "authorization" || lower === "x-api-key") {
				delete headers[key];
			}
		}
		headers["X-API-Key"] = config.apiKey;
	} else if (!hasCustomAuthorization) {
		headers.Authorization = null;
	}
	return headers;
}

export function createServerClient(config: ServerClientConfig): OpenAI {
	return new OpenAI({
		baseURL: apiRootOf(config.baseUrl, config.apiVersion),
		apiKey: config.apiKey || KEYLESS_PLACEHOLDER,
		// The SDK default of 2 would re-send chat prompts on 5xx. Discovery opts
		// back in per request.
		maxRetries: 0,
		defaultHeaders: buildDefaultHeaders(config),
		// The ambient OPENAI_LOG must not turn on SDK logging: at debug level it
		// logs request bodies and custom headers, which may carry secrets the
		// SDK's redaction does not know about.
		logLevel: "off",
		// The SDK captures fetch at construction; reading globalThis.fetch per
		// call keeps test-time fetch replacement working.
		fetch: (url, init) => globalThis.fetch(url, init),
	});
}

/**
 * One client per server, rebuilt only when the server's client-relevant config
 * changes. prune() drops entries for servers that no longer exist, so removed
 * servers' keys and headers are not retained.
 */
export class ServerClientCache {
	private readonly entries = new Map<string, { fingerprint: string; client: OpenAI }>();

	get(config: ServerClientConfig): OpenAI {
		const fingerprint = fingerprintOf(config);
		const entry = this.entries.get(config.serverId);
		if (entry && entry.fingerprint === fingerprint) {
			return entry.client;
		}
		const client = createServerClient(config);
		this.entries.set(config.serverId, { fingerprint, client });
		return client;
	}

	/** Drop cached clients for any server ID not in `keep`. */
	prune(keep: Iterable<string>): void {
		const keepSet = new Set(keep);
		for (const serverId of this.entries.keys()) {
			if (!keepSet.has(serverId)) {
				this.entries.delete(serverId);
			}
		}
	}
}
