import type { LanguageModelChatInformation } from "vscode";
import { fingerprint } from "../shared/fingerprint";
import { HEADER_NAME_PATTERN, isValidHeaderValue } from "../shared/headers";
import { isRecord } from "../shared/json";
import type { OAuthConfig, VirtualKeyConfig } from "./auth";
import type { OutputLimitSource } from "./schemas";

/**
 * Support for VS Code-managed provider groups. The host stores one
 * configuration object per named group and passes it to
 * provideLanguageModelChatInformation; it also hands the exact
 * LanguageModelChatInformation objects a provider returned back to
 * provideLanguageModelChatResponse and provideTokenCount, so LiteLLM facts
 * ride on the model objects themselves.
 */

/** Connection details resolved from a provider group's configuration. */
export interface GroupServer {
	baseUrl: string;
	apiKey: string;
	/** Client-credentials authentication; present only when the configuration names a token URL and client ID. */
	oauth?: OAuthConfig;
	/** Gateway virtual key; present only when the configuration names both a header and a value. */
	virtualKey?: VirtualKeyConfig;
}

/** LiteLLM facts attached to a model object, carried across the host round trip. */
interface LiteLLMModelMetadata {
	/** Resolved connection for provider-group models; registry models resolve through the route map instead. */
	readonly server?: GroupServer;
	readonly supportsPromptCaching: boolean;
	/** Where maxOutputTokens came from; only "provider" values escape the request-side cap. */
	readonly outputLimitSource: OutputLimitSource;
}

/** The model information this provider returns to the host. */
export interface LiteLLMModelInfo extends LanguageModelChatInformation {
	readonly litellm: LiteLLMModelMetadata;
}

/** Client-cache IDs for group servers, disjoint from registry server IDs. */
const GROUP_CLIENT_ID_PREFIX = "group:";

/**
 * Two groups may point at one base URL with different credentials, so group
 * identity includes a non-secret fingerprint over the whole credential
 * material: API key, OAuth client credentials, and virtual key. Rotating any
 * of them mints a new identity: the group double-counts in the status window
 * for one cycle until the old identity ages out, which self-heals. Servers
 * without OAuth or a virtual key fingerprint the API key alone, so their
 * identities survive this field addition unchanged.
 */
export function groupClientId(server: GroupServer): string {
	const credentials = [
		server.apiKey,
		...(server.oauth
			? ["oauth", server.oauth.tokenUrl, server.oauth.clientId, server.oauth.clientSecret, server.oauth.scopes ?? ""]
			: []),
		...(server.virtualKey ? ["virtual-key", server.virtualKey.header, server.virtualKey.value] : []),
	].join("\n");
	return `${GROUP_CLIENT_ID_PREFIX}${fingerprint(credentials)}:${server.baseUrl}`;
}

/**
 * Accepts unknown because callers also classify persisted status entries,
 * which older extension versions may have written with arbitrary shapes.
 */
export function isGroupClientId(serverId: unknown): boolean {
	return typeof serverId === "string" && serverId.startsWith(GROUP_CLIENT_ID_PREFIX);
}

/** A non-empty string after trimming, or undefined; the lenient unit of configuration narrowing. */
function usableString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * OAuth is present as one typed unit or not at all: a usable token URL and
 * client ID make the unit, anything less degrades to absent. The secret is
 * taken verbatim (an empty one means a public client) and scopes are optional.
 */
function narrowOAuth(
	tokenUrl: unknown,
	clientId: unknown,
	clientSecret: unknown,
	scopes: unknown
): OAuthConfig | undefined {
	const usableTokenUrl = usableString(tokenUrl);
	const usableClientId = usableString(clientId);
	if (usableTokenUrl === undefined || usableClientId === undefined) {
		return undefined;
	}
	const usableScopes = usableString(scopes);
	return {
		tokenUrl: usableTokenUrl,
		clientId: usableClientId,
		clientSecret: typeof clientSecret === "string" ? clientSecret : "",
		...(usableScopes !== undefined ? { scopes: usableScopes } : {}),
	};
}

type NarrowLog = (message: string, data?: unknown) => void;

/** One warning per rejected header name, so per-request re-narrowing does not spam the log. */
const reportedInvalidVirtualKeys = new Set<string>();

/**
 * The virtual key is present only with a valid header name and a value in
 * the header-value charset; anything less degrades to absent. The value is
 * trimmed first (the platform strips leading and trailing whitespace from
 * header values anyway), then rejected if interior CR/LF or other control
 * octets remain: those would make the platform's Headers throw a TypeError
 * that embeds the full plaintext value. A rejection is logged once per
 * header name so typos are diagnosable; the value never reaches the log.
 */
function narrowVirtualKey(header: unknown, value: unknown, log?: NarrowLog): VirtualKeyConfig | undefined {
	if (header === undefined && value === undefined) {
		return undefined;
	}
	const usableHeader = usableString(header);
	const usableValue = usableString(value);
	if (
		usableHeader !== undefined &&
		usableValue !== undefined &&
		HEADER_NAME_PATTERN.test(usableHeader) &&
		isValidHeaderValue(usableValue)
	) {
		return { header: usableHeader, value: usableValue };
	}
	const name = usableHeader ?? "(not set)";
	if (log !== undefined && !reportedInvalidVirtualKeys.has(name)) {
		reportedInvalidVirtualKeys.add(name);
		log("Ignoring the configured virtual key: the header name or value cannot be sent as an HTTP header", {
			header: name,
		});
	}
	return undefined;
}

/**
 * Narrow a group configuration to a usable server. Returns undefined when the
 * configuration is not an object or has no usable baseUrl; a missing or
 * non-string apiKey means a keyless server, and partial or malformed OAuth
 * and virtual-key fields degrade to absent rather than failing the group.
 * Unknown fields are ignored for forward compatibility.
 */
export function parseGroupConfiguration(configuration: unknown, log?: NarrowLog): GroupServer | undefined {
	if (!isRecord(configuration)) {
		return undefined;
	}
	const baseUrl = usableString(configuration.baseUrl)?.replace(/\/+$/, "");
	if (baseUrl === undefined || baseUrl.length === 0) {
		return undefined;
	}
	const oauth = narrowOAuth(
		configuration.oauthTokenUrl,
		configuration.oauthClientId,
		configuration.oauthClientSecret,
		configuration.oauthScopes
	);
	const virtualKey = narrowVirtualKey(configuration.virtualKeyHeader, configuration.virtualKeyValue, log);
	return {
		baseUrl,
		apiKey: typeof configuration.apiKey === "string" ? configuration.apiKey : "",
		...(oauth !== undefined ? { oauth } : {}),
		...(virtualKey !== undefined ? { virtualKey } : {}),
	};
}

/**
 * Attach the resolved server to a model entry. The detail field is dropped so
 * the host fills it with the group name.
 */
export function attachGroupServer(info: LiteLLMModelInfo, server: GroupServer): LiteLLMModelInfo {
	const { detail: _detail, ...rest } = info;
	return {
		...rest,
		litellm: {
			supportsPromptCaching: modelSupportsPromptCaching(info),
			outputLimitSource: modelOutputLimitSource(info),
			server,
		},
	};
}

/**
 * The model's attached server, re-validated because model objects come back
 * across the host boundary and only their shape is trustworthy, not their
 * type. OAuth and virtual-key sub-objects get the same lenient narrowing as
 * the group configuration: malformed ones degrade to absent.
 */
export function getGroupServer(model: LiteLLMModelInfo, log?: NarrowLog): GroupServer | undefined {
	const candidate: unknown = model.litellm?.server;
	if (!isRecord(candidate) || typeof candidate.baseUrl !== "string" || typeof candidate.apiKey !== "string") {
		return undefined;
	}
	const rawOAuth: unknown = candidate.oauth;
	const rawVirtualKey: unknown = candidate.virtualKey;
	const oauth = isRecord(rawOAuth)
		? narrowOAuth(rawOAuth.tokenUrl, rawOAuth.clientId, rawOAuth.clientSecret, rawOAuth.scopes)
		: undefined;
	const virtualKey = isRecord(rawVirtualKey)
		? narrowVirtualKey(rawVirtualKey.header, rawVirtualKey.value, log)
		: undefined;
	return {
		baseUrl: candidate.baseUrl,
		apiKey: candidate.apiKey,
		...(oauth !== undefined ? { oauth } : {}),
		...(virtualKey !== undefined ? { virtualKey } : {}),
	};
}

export function modelSupportsPromptCaching(model: LiteLLMModelInfo): boolean {
	return model.litellm?.supportsPromptCaching === true;
}

/**
 * The provenance of model.maxOutputTokens, re-validated because model objects
 * come back across the host boundary: anything but an exact "provider" (a
 * missing field, an older extension's metadata) keeps the conservative cap.
 */
export function modelOutputLimitSource(model: LiteLLMModelInfo): OutputLimitSource {
	return model.litellm?.outputLimitSource === "provider" ? "provider" : "defaults";
}

/** Display label for a group server; there is no group name on the extension side, so the URL host stands in. */
export function groupServerLabel(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}
