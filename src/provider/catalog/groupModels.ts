import type { LanguageModelChatInformation } from "vscode";
import { ThemeIcon } from "vscode";
import type { EffectiveOutputLimitSource, ServerDeclaredCapabilities } from "../../shared/config/capabilityResolution";
import type { OptionalEntryFieldId } from "../../shared/serverEntry";
import { OPTIONAL_ENTRY_FIELDS } from "../../shared/serverEntry";
import type { NormalizedBaseUrl } from "../../shared/util/baseUrl";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { fingerprint } from "../../shared/util/fingerprint";
import { HEADER_NAME_PATTERN, isValidHeaderValue } from "../../shared/util/headers";
import { isRecord } from "../../shared/util/json";
import type { OAuthConfig, VirtualKeyConfig } from "../transport/auth";
import { oauthCredentialFingerprint } from "../transport/auth";

/**
 * Support for VS Code-managed provider groups. The host stores one
 * configuration object per named group and hands the exact
 * LanguageModelChatInformation objects a provider returned back to
 * provideLanguageModelChatResponse and provideTokenCount, so LiteLLM facts ride
 * on the model objects themselves.
 */

/** Connection details resolved from a provider group's configuration. */
export interface GroupServer {
	baseUrl: NormalizedBaseUrl;
	apiKey: string;
	/**
	 * The declared settings entry this group mirrors, written into the group
	 * configuration by the sync engine, so external and pre-label groups lack it.
	 * Non-secret. Part of the group's identity (see groupClientId).
	 */
	label?: string;
	/** Client-credentials authentication; present only when the configuration names a token URL and client ID. */
	oauth?: OAuthConfig;
	/** Gateway virtual key; present only when the configuration names both a header and a value. */
	virtualKey?: VirtualKeyConfig;
}

/** The LiteLLM facts every model object carries, with or without a server attached. */
interface LiteLLMModelMetadataBase {
	/**
	 * The raw LiteLLM model ID this entry routes to (the request's `model`
	 * field), stamped by the mints (registration and declared-model synthesis),
	 * which are the only places that know it: synthetic variants like
	 * `foo:cheapest` and `foo:groq` carry their routed ID here, so no consumer
	 * ever re-derives a raw ID from the exposed one.
	 */
	readonly rawModelId: string;
	readonly supportsPromptCaching: boolean;
	/**
	 * Where maxOutputTokens came from: server-declared ("provider") and
	 * user-set ("user", any capability-override level) values escape the
	 * request-side cap; only "defaults" keeps it, because a guessed limit must
	 * not be sent as-is.
	 */
	readonly outputLimitSource: EffectiveOutputLimitSource;
	/**
	 * True when the LiteLLM capability data listed audio among the model's
	 * input modalities; gates the input_audio message conversion. Optional
	 * because model objects round-trip through the host and older metadata
	 * lacks it (absent reads as false).
	 */
	readonly supportsAudioInput?: boolean;
	/** True for a declared model (an entry's discovery.declared; discovery does not list it). */
	readonly declared?: boolean;
}

/**
 * Registration output before any group server is attached. The `never` pins
 * the split: the discovery cache, StatusWindow.record, and every snapshot the
 * dashboard reads hold this type, and a group-attached copy (whose server
 * embeds the group's credentials) does not compile there.
 *
 * `serverDeclared` is registration's post-aggregation server baseline for the
 * capability resolver. Required, so a pre-attach entry without a baseline is
 * unrepresentable rather than silently empty; attach drops it, since the chat
 * path reads only patched values.
 */
export interface PreAttachModelInfo extends LanguageModelChatInformation {
	readonly litellm: LiteLLMModelMetadataBase & {
		readonly serverDeclared: ServerDeclaredCapabilities;
		readonly server?: never;
	};
}

/**
 * A model entry with its group's resolved connection attached, for the host
 * round trip only: attachGroupServer is the sole constructor, and the value
 * must never enter a cache, a status snapshot, or a state push.
 */
export interface AttachedModelInfo extends LanguageModelChatInformation {
	readonly litellm: LiteLLMModelMetadataBase & {
		readonly server: GroupServer;
		readonly serverDeclared?: never;
	};
}

/** The model information this provider returns to (and receives back from) the host. */
export type LiteLLMModelInfo = PreAttachModelInfo | AttachedModelInfo;

/** The credential slice of a group server: what the entry-credentials overlay replaces as one unit. */
export type GroupCredentials = Pick<GroupServer, "apiKey" | "oauth" | "virtualKey">;

/**
 * Replace a group server's baked-in credentials with a declared entry's
 * current ones. Wholesale, never merged: the entry's resolved credential set
 * is the complete truth, so an entry that dropped its OAuth unit (or virtual
 * key) must strip the baked one rather than keep authenticating with it.
 */
export function overlayGroupCredentials(server: GroupServer, credentials: GroupCredentials): GroupServer {
	return {
		baseUrl: server.baseUrl,
		apiKey: credentials.apiKey,
		...(server.label !== undefined ? { label: server.label } : {}),
		...(credentials.oauth !== undefined ? { oauth: credentials.oauth } : {}),
		...(credentials.virtualKey !== undefined ? { virtualKey: credentials.virtualKey } : {}),
	};
}

/** Client-cache IDs for group servers, disjoint from any other server id shape (see isGroupClientId). */
const GROUP_CLIENT_ID_PREFIX = "group:";

/**
 * Two groups may point at one base URL with different credentials, so group
 * identity includes a non-secret fingerprint over the whole credential
 * material: API key, OAuth client credentials, and virtual key. Two DECLARED
 * entries may even share the URL and every credential, so the entry label
 * joins the identity too - without it both entries would collapse to one
 * status-window identity and the second could never report.
 *
 * The identity is ONE injective encoding: a fixed-arity JSON tuple with one
 * slot per component, absent components as null - the same
 * JSON.stringify-composition rule the fingerprint and the discovery cache key
 * follow. JSON escaping keeps every slot inside its slot, so no free-form
 * value (the raw API key above all) can spell another component or another
 * component combination; the pinned injectivity property drives adversarial
 * JSON-shaped keys through exactly that claim. The tuple is hashed, so no ID
 * embeds credential material. Rotating any part mints a new identity for the
 * same logical group; the status window evicts the retired identity the
 * moment the new one records (StatusWindow.record), so a rotation never
 * leaves a ghost twin. IDs are derived, never stored (the salted fingerprint
 * keeps them stable across sessions for unchanged credentials); the one
 * persisted carrier (the status blob) is version-stamped and restores nothing
 * from other shapes, so a format change costs one blob reset and nothing else.
 */
export function groupClientId(server: GroupServer): string {
	const identity = JSON.stringify([
		server.baseUrl,
		server.label ?? null,
		server.apiKey,
		server.oauth ? oauthCredentialFingerprint(server.oauth) : null,
		server.virtualKey ? [server.virtualKey.header, server.virtualKey.value] : null,
	]);
	return `${GROUP_CLIENT_ID_PREFIX}${fingerprint(identity)}:${server.baseUrl}`;
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
	// The entry label the sync engine stamps into the configuration; not an
	// OPTIONAL_ENTRY_FIELDS member because it is a required field of the
	// declared entry itself, read explicitly here like baseUrl.
	const label = usableString(configuration.label);
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
		...(label !== undefined ? { label } : {}),
		...(oauth !== undefined ? { oauth } : {}),
		...(virtualKey !== undefined ? { virtualKey } : {}),
	};
}

/**
 * Attach the resolved server to a pre-attach model entry: the sole
 * constructor of AttachedModelInfo. The detail field is dropped so the host
 * fills it with the group name.
 *
 * The destructure below is a canary, not round-trip safety: when GroupServer
 * grows an optional field, the `unconsumed` assignment stops compiling and
 * forces a visit to this seam. The real work then happens in the copies that
 * cannot carry such a guard - parseAttachedServer and the ServerConnection
 * copies on the request path.
 */
export function attachGroupServer(info: PreAttachModelInfo, server: GroupServer): AttachedModelInfo {
	const { detail: _detail, ...rest } = info;
	const { baseUrl: _url, apiKey: _key, label: _label, oauth: _oauth, virtualKey: _vk, ...unconsumed } = server;
	// A new GroupServer field lands in `unconsumed` and fails this assignment.
	void (unconsumed satisfies Record<string, never>);
	return {
		...rest,
		litellm: {
			rawModelId: info.litellm.rawModelId,
			supportsPromptCaching: modelSupportsPromptCaching(info),
			outputLimitSource: modelOutputLimitSource(info),
			supportsAudioInput: modelSupportsAudioInput(info),
			...(info.litellm.declared === true ? { declared: true } : {}),
			server: { ...server },
		},
	};
}

/**
 * Decorate a stale-served model set: a group whose latest silent refresh
 * failed serves its last known models with the picker's warning icon and a
 * hover banner instead of vanishing. The signature accepts and returns
 * AttachedModelInfo only, so decorated copies cannot enter the discovery
 * cache, the status window, or a dashboard snapshot, and the next successful
 * sweep clears the decoration by construction. The banner is a fixed
 * classification plus the LAST SUCCESSFUL sync time: anchoring to the success
 * means repeated failures cannot make stale data look freshly checked, and the
 * failure's display string never rides model metadata into hovers.
 */
export function markStale(infos: readonly AttachedModelInfo[], lastSyncedDisplay: string): AttachedModelInfo[] {
	const warningText = {
		connectivity: `The server is unreachable; showing the models from its last successful sync at ${lastSyncedDisplay}.`,
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
 * `model.litellm`.
 */
export interface ParsedModelMetadata {
	/**
	 * The attached group server, or undefined when the model object carries
	 * none - a state the provider never serves, which the request path fails
	 * loudly on.
	 */
	readonly server: GroupServer | undefined;
	/**
	 * The raw LiteLLM model ID the request's `model` field carries, from the
	 * stamped metadata; a model object whose round trip lost the stamp falls
	 * back to its exposed ID, which group registrations mint raw anyway.
	 */
	readonly rawModelId: string;
	readonly supportsPromptCaching: boolean;
	readonly supportsAudioInput: boolean;
	/** The registered imageInput capability, re-narrowed like the litellm fields; gates image message conversion. */
	readonly imageInput: boolean;
	/** Anything but an exact "provider" or "user" (a missing field, an older extension's metadata) keeps the conservative cap. */
	readonly outputLimitSource: EffectiveOutputLimitSource;
}

/**
 * Parse a model object's LiteLLM metadata at the host boundary. The attached
 * server's base URL is re-normalized because identity surfaces require the
 * normalized form and the host round trip could hand back anything
 * string-shaped. OAuth and virtual-key sub-objects get the same lenient
 * narrowing as the group configuration: malformed ones degrade to absent.
 */
export function parseModelMetadata(model: LiteLLMModelInfo, log?: NarrowLog): ParsedModelMetadata {
	const rawModelId = model.litellm?.rawModelId;
	return {
		server: parseAttachedServer(model.litellm?.server, log),
		rawModelId: typeof rawModelId === "string" && rawModelId.length > 0 ? rawModelId : model.id,
		supportsPromptCaching: modelSupportsPromptCaching(model),
		supportsAudioInput: modelSupportsAudioInput(model),
		imageInput: model.capabilities?.imageInput === true,
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
	const label = usableString(candidate.label);
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
		...(label !== undefined ? { label } : {}),
		...(oauth !== undefined ? { oauth } : {}),
		...(virtualKey !== undefined ? { virtualKey } : {}),
	};
}

export function modelSupportsPromptCaching(model: LiteLLMModelInfo): boolean {
	return model.litellm?.supportsPromptCaching === true;
}

/** Re-narrowed like every host round trip: absent (older metadata) or malformed reads as false. */
function modelSupportsAudioInput(model: LiteLLMModelInfo): boolean {
	return model.litellm?.supportsAudioInput === true;
}

/**
 * The provenance of model.maxOutputTokens, re-validated because model objects
 * come back across the host boundary: only the exact declared markers
 * ("provider" for server-declared, "user" for a capability override) lift the
 * request-side cap; anything else keeps it.
 */
function modelOutputLimitSource(model: LiteLLMModelInfo): EffectiveOutputLimitSource {
	const source: unknown = model.litellm?.outputLimitSource;
	return source === "provider" || source === "user" ? source : "defaults";
}

/** Display label for a group server without a configured label: the host never hands the group NAME to the extension, so the URL host stands in. */
export function groupServerLabel(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}
