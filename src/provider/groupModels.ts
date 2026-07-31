import type { LanguageModelChatInformation } from "vscode";
import { ThemeIcon } from "vscode";
import type { NormalizedBaseUrl } from "../shared/baseUrl";
import { normalizeBaseUrl } from "../shared/baseUrl";
import { fingerprint } from "../shared/fingerprint";
import { HEADER_NAME_PATTERN, isValidHeaderValue } from "../shared/headers";
import { isRecord } from "../shared/json";
import type { OptionalEntryFieldId } from "../shared/serverEntry";
import { OPTIONAL_ENTRY_FIELDS } from "../shared/serverEntry";
import type { OAuthConfig, VirtualKeyConfig } from "./auth";
import { oauthCredentialFingerprint } from "./auth";
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
	baseUrl: NormalizedBaseUrl;
	apiKey: string;
	/** Client-credentials authentication; present only when the configuration names a token URL and client ID. */
	oauth?: OAuthConfig;
	/** Gateway virtual key; present only when the configuration names both a header and a value. */
	virtualKey?: VirtualKeyConfig;
}

/** The LiteLLM facts every model object carries, with or without a server attached. */
interface LiteLLMModelMetadataBase {
	readonly supportsPromptCaching: boolean;
	/** Where maxOutputTokens came from; only "provider" values escape the request-side cap. */
	readonly outputLimitSource: OutputLimitSource;
}

/**
 * Registration output before any group server is attached. The `never` pins
 * the split: the discovery cache, recordServerStatus, and every snapshot the
 * dashboard reads hold this type, and a group-attached copy (whose server
 * embeds the group's credentials) does not compile there.
 */
export interface PreAttachModelInfo extends LanguageModelChatInformation {
	readonly litellm: LiteLLMModelMetadataBase & { readonly server?: never };
}

/**
 * A model entry with its group's resolved connection attached, for the host
 * round trip only: attachGroupServer is the sole constructor, and the value
 * must never enter a cache, a status snapshot, or a state push.
 */
export interface AttachedModelInfo extends LanguageModelChatInformation {
	readonly litellm: LiteLLMModelMetadataBase & { readonly server: GroupServer };
}

/** The model information this provider returns to (and receives back from) the host. */
export type LiteLLMModelInfo = PreAttachModelInfo | AttachedModelInfo;

/** Client-cache IDs for group servers, disjoint from registry server IDs. */
const GROUP_CLIENT_ID_PREFIX = "group:";

/**
 * Two groups may point at one base URL with different credentials, so group
 * identity includes a non-secret fingerprint over the whole credential
 * material: API key, OAuth client credentials (delegated to
 * oauthCredentialFingerprint, the canonical enumeration of the OAuth
 * identity), and virtual key. Within the credential branch the material is
 * JSON-encoded before hashing - the API key is free-form, so a delimiter
 * join would let two different credential sets serialize identically. The
 * plain branch hashes the raw API key so those identities survive
 * credential-field additions and encoding changes unchanged (pinned by
 * test); the trade-off is that the two branches share a hash domain, so a
 * bare API key that is byte-for-byte the credential branch's JSON text
 * collides with that configuration - accepted, since both configurations
 * are the same user's own settings. Rotating any part mints a new identity:
 * the group double-counts in the status window for one cycle until the old
 * identity ages out, which self-heals.
 */
export function groupClientId(server: GroupServer): string {
	const credentials =
		server.oauth || server.virtualKey
			? JSON.stringify([
					server.apiKey,
					server.oauth ? oauthCredentialFingerprint(server.oauth) : null,
					server.virtualKey ? [server.virtualKey.header, server.virtualKey.value] : null,
				])
			: server.apiKey;
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
 *
 * The entry fields are read through OPTIONAL_ENTRY_FIELDS (the one descriptor
 * of a server entry's fields), and the rest-destructure below is the totality
 * guard: a field added to the descriptor fails this function's compile until
 * the parser consumes it, so nothing buildGroupArgs sends can silently drop
 * on the host-configuration path.
 */
export function parseGroupConfiguration(configuration: unknown, log?: NarrowLog): GroupServer | undefined {
	if (!isRecord(configuration)) {
		return undefined;
	}
	const rawBaseUrl = usableString(configuration.baseUrl);
	const baseUrl = rawBaseUrl === undefined ? undefined : normalizeBaseUrl(rawBaseUrl);
	if (baseUrl === undefined || baseUrl.length === 0) {
		return undefined;
	}
	const fields: { -readonly [K in OptionalEntryFieldId]?: unknown } = {};
	for (const { id } of OPTIONAL_ENTRY_FIELDS) {
		fields[id] = configuration[id];
	}
	const {
		apiKey,
		oauthTokenUrl,
		oauthClientId,
		oauthClientSecret,
		oauthScopes,
		virtualKeyHeader,
		virtualKeyValue,
		...unconsumed
	} = fields;
	// A new descriptor field lands in `unconsumed` and fails this assignment.
	void (unconsumed satisfies Record<string, never>);
	const oauth = narrowOAuth(oauthTokenUrl, oauthClientId, oauthClientSecret, oauthScopes);
	const virtualKey = narrowVirtualKey(virtualKeyHeader, virtualKeyValue, log);
	return {
		baseUrl,
		apiKey: typeof apiKey === "string" ? apiKey : "",
		...(oauth !== undefined ? { oauth } : {}),
		...(virtualKey !== undefined ? { virtualKey } : {}),
	};
}

/**
 * Attach the resolved server to a pre-attach model entry: the sole
 * constructor of AttachedModelInfo. The detail field is dropped so the host
 * fills it with the group name.
 */
export function attachGroupServer(info: PreAttachModelInfo, server: GroupServer): AttachedModelInfo {
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
 * Decorate a stale-served model set: a group whose latest silent refresh
 * failed serves its last known models with the picker's warning icon and a
 * hover banner instead of vanishing. The signature accepts and returns
 * AttachedModelInfo only, so decorated copies cannot enter the discovery
 * cache, the status window, or a dashboard snapshot - those hold
 * PreAttachModelInfo, and attachment happens on every read, so the next
 * successful sweep clears the decoration by construction. The banner is a
 * fixed classification plus timestamp: the failure's display string is
 * response-derived and must not ride model metadata into hovers.
 */
export function markStale(infos: readonly AttachedModelInfo[], lastChecked: string): AttachedModelInfo[] {
	const warningText = {
		connectivity: `The server was unreachable at ${lastChecked}; showing the last models it reported.`,
	};
	return infos.map((info) => ({
		...info,
		statusIcon: new ThemeIcon("warning"),
		warningText,
	}));
}

/**
 * The LiteLLM facts of one model object, re-validated in a single pass. Model
 * objects come back across the host boundary, so only their shape is
 * trustworthy, not their type; this is the chat path's one parse of
 * `model.litellm`, and everything downstream reads the parsed result instead
 * of narrowing the model again.
 */
export interface ParsedModelMetadata {
	/** The attached group server, or undefined for registry-served models. */
	readonly server: GroupServer | undefined;
	readonly supportsPromptCaching: boolean;
	/** Anything but an exact "provider" (a missing field, an older extension's metadata) keeps the conservative cap. */
	readonly outputLimitSource: OutputLimitSource;
}

/**
 * Parse a model object's LiteLLM metadata at the host boundary. The attached
 * server's base URL is re-normalized because identity surfaces (groupClientId,
 * the migrated-label lookup) require the normalized form, and the host round
 * trip could hand back anything string-shaped. OAuth and virtual-key
 * sub-objects get the same lenient narrowing as the group configuration:
 * malformed ones degrade to absent.
 */
export function parseModelMetadata(model: LiteLLMModelInfo, log?: NarrowLog): ParsedModelMetadata {
	return {
		server: parseAttachedServer(model.litellm?.server, log),
		supportsPromptCaching: modelSupportsPromptCaching(model),
		outputLimitSource: modelOutputLimitSource(model),
	};
}

/** The lenient re-narrowing of an attached group server; see parseModelMetadata. */
function parseAttachedServer(candidate: unknown, log?: NarrowLog): GroupServer | undefined {
	if (!isRecord(candidate) || typeof candidate.baseUrl !== "string" || typeof candidate.apiKey !== "string") {
		return undefined;
	}
	const baseUrl = normalizeBaseUrl(candidate.baseUrl);
	if (baseUrl.length === 0) {
		// Symmetric with parseGroupConfiguration: a URL that normalizes to
		// nothing (e.g. "/") is no server.
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
		baseUrl,
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
 * Chat requests read this through parseModelMetadata's single parse.
 */
function modelOutputLimitSource(model: LiteLLMModelInfo): OutputLimitSource {
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
