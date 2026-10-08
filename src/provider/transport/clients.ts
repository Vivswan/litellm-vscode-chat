import OpenAI from "openai";
import { apiRootOf, serverRootOf } from "../../shared/util/baseUrl";
import { fingerprint } from "../../shared/util/fingerprint";
import { type HeaderValue, headerNameKey } from "../../shared/util/headers";
import type { TransportFetch } from "./nodeHttpFetch";

export interface ServerClientConfig {
	serverId: string;
	baseUrl: string;
	/**
	 *   undefined -> auto (keep a version segment already in the URL, else append /v1)
	 *   ""        -> the base URL is the API root as-is
	 * See apiRootOf.
	 */
	apiVersion?: string | undefined;
	/** Empty string for keyless servers. */
	apiKey: HeaderValue | "";
	userAgent: HeaderValue;
	customHeaders: Record<string, HeaderValue>;
}

/**
 * Never sent: the SDK omits auth entirely when Authorization is nulled out, and a configured custom Authorization
 * header wins the default-headers merge. It only satisfies the SDK's constructor-time credential check for keyless
 * servers.
 */
const KEYLESS_PLACEHOLDER = "keyless";

/**
 * The *Url helpers state exactly what the transport calls - those log lines feed public issue reports and must not
 * drift from the real requests - so their apiVersion parameter is required: a caller cannot silently log the auto
 * root for a client built on an overridden one.
 */
export const MODEL_INFO_PATH = "/model/info";
export const MODELS_PATH = "/models";
/** LiteLLM serves this one at the server root only, with no /v1 twin. */
export const MODEL_GROUP_INFO_PATH = "/model_group/info";
export const CHAT_COMPLETIONS_PATH = "/chat/completions";
const COMPLETIONS_PATH = "/completions";

export function modelInfoUrl(baseUrl: string, apiVersion: string | undefined): string {
	return `${apiRootOf(baseUrl, apiVersion)}${MODEL_INFO_PATH}`;
}

export function modelsUrl(baseUrl: string, apiVersion: string | undefined): string {
	return `${apiRootOf(baseUrl, apiVersion)}${MODELS_PATH}`;
}

export function modelGroupInfoUrl(baseUrl: string, apiVersion: string | undefined): string {
	return `${serverRootOf(baseUrl, apiVersion)}${MODEL_GROUP_INFO_PATH}`;
}

export function chatCompletionsUrl(baseUrl: string, apiVersion: string | undefined): string {
	return `${apiRootOf(baseUrl, apiVersion)}${CHAT_COMPLETIONS_PATH}`;
}

export function completionsUrl(baseUrl: string, apiVersion: string | undefined): string {
	return `${apiRootOf(baseUrl, apiVersion)}${COMPLETIONS_PATH}`;
}

/** Never embeds the API key itself. */
function fingerprintOf(config: ServerClientConfig): string {
	const headerPart = Object.entries(config.customHeaders)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}:${value}`)
		.join("\n");
	// Joined on NUL (spelled as an escape so the file stays text-diffable).
	//
	// An unset apiVersion must not collide with the "" override, so set values carry "=".
	const apiVersionPart = config.apiVersion === undefined ? "" : `=${config.apiVersion}`;
	return fingerprint(
		[config.baseUrl, apiVersionPart, config.userAgent, headerPart, fingerprint(config.apiKey)].join("\u0000")
	);
}

/**
 * A set API key owns both auth headers (Authorization from the SDK's bearer auth, X-API-Key here for gateway
 * compatibility) and conflicting custom headers are dropped. A null value means "send no such header".
 *
 *   Exported as the one owner of this precedence rule -> the extension-side usage client reuses it for its root-level
 *                                                        GETs
 */
export function buildDefaultHeaders(
	config: Pick<ServerClientConfig, "apiKey" | "userAgent" | "customHeaders">
): Record<string, HeaderValue | null> {
	const headers: Record<string, HeaderValue | null> = { ...config.customHeaders, "User-Agent": config.userAgent };
	const hasCustomAuthorization = Object.keys(config.customHeaders).some(
		(key) => headerNameKey(key) === "authorization"
	);
	if (config.apiKey) {
		for (const key of Object.keys(headers)) {
			const lower = headerNameKey(key);
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

export function createServerClient(config: ServerClientConfig, fetchImpl: TransportFetch): OpenAI {
	return new OpenAI({
		baseURL: apiRootOf(config.baseUrl, config.apiVersion),
		apiKey: config.apiKey || KEYLESS_PLACEHOLDER,
		// The SDK default of 2 would re-send chat prompts on 5xx. Discovery opts back in per request.
		maxRetries: 0,
		defaultHeaders: buildDefaultHeaders(config),
		// The ambient OPENAI_LOG must not turn on SDK logging: at debug level it logs request bodies and custom
		// headers, which may carry secrets the SDK's redaction does not know about.
		logLevel: "off",
		// One client serves chat and discovery, so both ride the idle-clock-free transport (see nodeHttpFetch);
		// discovery's short GETs lose nothing by it. The SDK always passes a string URL; Request is type cover.
		fetch: (url, init) => fetchImpl(url instanceof Request ? url.url : url, init),
	});
}

/** prune() drops entries for servers that no longer exist, so removed servers' keys and headers are not retained. */
export class ServerClientCache {
	private readonly entries = new Map<string, { fingerprint: string; client: OpenAI }>();

	constructor(private readonly fetchImpl: TransportFetch) {}

	get(config: ServerClientConfig): OpenAI {
		const fingerprint = fingerprintOf(config);
		const entry = this.entries.get(config.serverId);
		if (entry && entry.fingerprint === fingerprint) {
			return entry.client;
		}
		const client = createServerClient(config, this.fetchImpl);
		this.entries.set(config.serverId, { fingerprint, client });
		return client;
	}

	prune(keep: Iterable<string>): void {
		const keepSet = new Set(keep);
		for (const serverId of this.entries.keys()) {
			if (!keepSet.has(serverId)) {
				this.entries.delete(serverId);
			}
		}
	}
}
