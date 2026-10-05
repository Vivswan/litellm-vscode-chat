import * as l10n from "@vscode/l10n";
import type { LanguageModelChatInformation } from "vscode";
import { ThemeIcon } from "vscode";
import type { EffectiveOutputLimitSource, ServerDeclaredCapabilities } from "../../shared/config/capabilityResolution";
import { localizedError, type MirroredError } from "../../shared/mirroredError";
import type {
	NonSecretOptionalFieldId,
	NonSecretOptionalFields,
	OptionalEntryFieldId,
	SecretFieldCarrier,
	SecretFieldId,
} from "../../shared/serverEntry";
import {
	NON_SECRET_OPTIONAL_FIELD_IDS,
	OPTIONAL_ENTRY_FIELDS,
	presentCarriers,
	SECRET_FIELD_IDS,
} from "../../shared/serverEntry";
import type { NormalizedBaseUrl } from "../../shared/util/baseUrl";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { fingerprint } from "../../shared/util/fingerprint";
import { HEADER_NAME_PATTERN, isValidHeaderValue } from "../../shared/util/headers";
import { isRecord } from "../../shared/util/json";
import type { OAuthConfig, VirtualKeyConfig } from "../transport/auth";
import { oauthCredentialFingerprint } from "../transport/auth";

/**
 * The host stores one configuration object per named group and hands the exact LanguageModelChatInformation objects a
 * provider returned back to provideLanguageModelChatResponse and provideTokenCount, so LiteLLM facts ride on the model
 * objects themselves.
 */

export interface GroupServer {
	baseUrl: NormalizedBaseUrl;
	apiKey: string;
	/** Non-secret. Part of the group's identity (see groupClientId). */
	label?: string;
	/** Client-credentials authentication; present only when the configuration names a token URL and client ID. */
	oauth?: OAuthConfig;
	/** Gateway virtual key; present only when the configuration names both a header and a value. */
	virtualKey?: VirtualKeyConfig;
}

interface LiteLLMModelMetadataBase {
	/**
	 * The raw LiteLLM model ID this entry routes to (the request's `model` field), stamped by the mints (registration
	 * and declared-model synthesis), which are the only places that know it: synthetic variants like `foo:cheapest`
	 * and `foo:groq` carry their routed ID here.
	 */
	readonly rawModelId: string;
	readonly supportsPromptCaching: boolean;
	/**
	 * Where maxOutputTokens came from.
	 *   server-declared ("provider") and user-set ("user") -> values escape the request-side cap
	 *   only "defaults"                                    -> keeps it, because a guessed limit must not be sent as-is
	 */
	readonly outputLimitSource: EffectiveOutputLimitSource;
	/**
	 * Gates the input_audio message conversion. Optional because model objects round-trip through the host and older
	 * metadata lacks it (absent reads as false).
	 */
	readonly supportsAudioInput?: boolean;
	/** True for a declared model (an entry's discovery.declared; discovery does not list it). */
	readonly declared?: boolean;
}

/**
 * The `never` pins the credential boundary, so a group-attached copy, whose server embeds the group's credentials, does
 * not compile into the discovery cache (groupDiscovery.ts), StatusWindow.record (statusWindow.ts), or a dashboard
 * snapshot.
 */
export interface PreAttachModelInfo extends LanguageModelChatInformation {
	readonly litellm: LiteLLMModelMetadataBase & {
		/**
		 * Required, so an entry without a baseline is unrepresentable; attach drops it, since the chat path reads
		 * patched values.
		 */
		readonly serverDeclared: ServerDeclaredCapabilities;
		readonly server?: never;
	};
}

/**
 * A model entry with its group's resolved connection attached, for the host round trip only: attachGroupServer is the
 * sole constructor, and the value must never enter a cache, a status snapshot, or a state push.
 */
export interface AttachedModelInfo extends LanguageModelChatInformation {
	readonly litellm: LiteLLMModelMetadataBase & {
		readonly server: GroupServer;
		readonly serverDeclared?: never;
	};
}

export type LiteLLMModelInfo = PreAttachModelInfo | AttachedModelInfo;

/** The credential slice of a group server: what the entry-credentials overlay replaces as one unit. */
export type GroupCredentials = Pick<GroupServer, "apiKey" | "oauth" | "virtualKey">;

/**
 * Wholesale, never merged: the entry's resolved credential set is the complete truth, so an entry that dropped its
 * OAuth unit (or virtual key) must strip the baked one rather than keep authenticating with it.
 */
function overlayGroupCredentials(server: GroupServer, credentials: GroupCredentials): GroupServer {
	return {
		baseUrl: server.baseUrl,
		apiKey: credentials.apiKey,
		...(server.label !== undefined ? { label: server.label } : {}),
		...(credentials.oauth !== undefined ? { oauth: credentials.oauth } : {}),
		...(credentials.virtualKey !== undefined ? { virtualKey: credentials.virtualKey } : {}),
	};
}

/** The same reasons the sync engine skips an entry for (secretsUnreadable, secretsMismatched); see syncFailureOf. */
type CredentialsUnavailableReason = "secretsUnreadable" | "secretsMismatched" | "unusable";

/**
 * The entry-credentials resolver's answer for a labeled group. The baked credentials are the copy the host stored at
 * group creation, which a rotation retires.
 *   external (no declared entry at this label and normalized base URL) -> the baked set stays; a leftover group
 *   resolved                                                           -> the entry's current set overlays it
 *   unavailable(reason)                                                -> a classified failure, never the baked key
 */
export type GroupCredentialsResolution =
	| { readonly kind: "external" }
	| { readonly kind: "resolved"; readonly credentials: GroupCredentials }
	| { readonly kind: "unavailable"; readonly reason: CredentialsUnavailableReason };

/** The one failure a serve or request raises for a declared entry whose credentials did not resolve. */
function credentialsUnavailableError(reason: CredentialsUnavailableReason): MirroredError {
	return localizedError(
		l10n.t(
			"This server entry's credentials could not be resolved, so its stored copy in VS Code was not used. Check the server row on the dashboard, then run LiteLLM: Sync Models Now."
		),
		"entry credentials unavailable",
		`EntryCredentialsUnavailable(${reason})`
	);
}

/** The extension layer's resolver of a declared entry's current credentials; see GroupCredentialsResolution. */
export type EntryCredentialsResolver = (label: string, baseUrl: string) => Promise<GroupCredentialsResolution>;

/**
 * The one overlay for both consumers of a labeled group's credentials.
 *   serve path (provider/index.ts)      -> the failure rides beside the baked server as the discovery preflight failure
 *   request path (transport/chatClient) -> the failure is thrown before anything is sent
 */
export async function overlayEntryCredentials(
	server: GroupServer,
	resolve: EntryCredentialsResolver | undefined
): Promise<{ server: GroupServer; failure?: MirroredError }> {
	if (server.label === undefined || resolve === undefined) {
		return { server };
	}
	let resolution: GroupCredentialsResolution;
	try {
		resolution = await resolve(server.label, server.baseUrl);
	} catch {
		resolution = { kind: "unavailable", reason: "secretsUnreadable" };
	}
	switch (resolution.kind) {
		case "external":
			return { server };
		case "resolved":
			return { server: overlayGroupCredentials(server, resolution.credentials) };
		case "unavailable":
			return { server, failure: credentialsUnavailableError(resolution.reason) };
	}
}

/** Client-cache IDs for group servers, disjoint from any other server id shape (see isGroupClientId). */
const GROUP_CLIENT_ID_PREFIX = "group:";

/**
 * A fixed-arity JSON tuple, injective because escaping keeps every value inside its slot, hashed so no ID
 * embeds credential material. A credential rotation mints a new identity for the same labeled logical
 * group, and statusWindow.ts evicts the previous identity when the new one records.
 *
 *   credential fingerprint -> two groups may share a base URL with different credentials
 *   entry label            -> two DECLARED entries may share the URL and every credential, and without it
 *                             both collapse to one status-window identity and the second never reports
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
 * Accepts unknown because callers also classify persisted status entries, which older extension versions may have
 * written with arbitrary shapes.
 */
export function isGroupClientId(serverId: unknown): boolean {
	return typeof serverId === "string" && serverId.startsWith(GROUP_CLIENT_ID_PREFIX);
}

function usableString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

type RawOptionalFields = { readonly [K in OptionalEntryFieldId]?: unknown };

/**
 * The raw non-secret fields in the shape the settings parser gives an entry (present only with usable text), so the
 * unit builders below read their carriers through presentCarriers, the one owner of the carrier reading, and a unit
 * this parser narrows onto the wire is one entryUsesSecretField attributes to the entry.
 */
function usableNonSecretFields(raw: RawOptionalFields): NonSecretOptionalFields {
	const fields: { -readonly [K in NonSecretOptionalFieldId]?: string } = {};
	for (const id of NON_SECRET_OPTIONAL_FIELD_IDS) {
		const value = usableString(raw[id]);
		if (value !== undefined) {
			fields[id] = value;
		}
	}
	return fields;
}

/**
 * OAuth is present as one typed unit or not at all: a usable token URL and client ID make the unit, anything less
 * degrades to absent. The secret is taken verbatim (an empty one means a public client) and scopes are optional.
 */
function narrowOAuth(raw: RawOptionalFields): OAuthConfig | undefined {
	const fields = usableNonSecretFields(raw);
	const carriers = presentCarriers("oauthClientSecret", fields);
	if (carriers === undefined) {
		return undefined;
	}
	return {
		tokenUrl: carriers.oauthTokenUrl,
		clientId: carriers.oauthClientId,
		clientSecret: typeof raw.oauthClientSecret === "string" ? raw.oauthClientSecret : "",
		...(fields.oauthScopes !== undefined ? { scopes: fields.oauthScopes } : {}),
	};
}

type NarrowLog = (message: string, data?: unknown) => void;

/** One warning per rejected header name, so per-request re-narrowing does not spam the log. */
const reportedInvalidVirtualKeys = new Set<string>();

/** A rejection is logged once per header name so typos are diagnosable; the value never reaches the log. */
function narrowVirtualKey(raw: RawOptionalFields, log?: NarrowLog): VirtualKeyConfig | undefined {
	if (raw.virtualKeyHeader === undefined && raw.virtualKeyValue === undefined) {
		return undefined;
	}
	const carriers = presentCarriers("virtualKeyValue", usableNonSecretFields(raw));
	const usableValue = usableString(raw.virtualKeyValue);
	if (
		carriers !== undefined &&
		usableValue !== undefined &&
		HEADER_NAME_PATTERN.test(carriers.virtualKeyHeader) &&
		isValidHeaderValue(usableValue)
	) {
		return { header: carriers.virtualKeyHeader, value: usableValue };
	}
	const name = carriers?.virtualKeyHeader ?? "(not set)";
	if (log !== undefined && !reportedInvalidVirtualKeys.has(name)) {
		reportedInvalidVirtualKeys.add(name);
		log("Ignoring the configured virtual key: the header name or value cannot be sent as an HTTP header", {
			header: name,
		});
	}
	return undefined;
}

/**
 * How one secret field rides a GroupServer: the credential slot it fills, the non-secret fields that ride along
 * without deciding the unit's presence (the ones that decide it are its SECRET_FIELD_CARRIERS), and the narrowing
 * from the raw fields to the slot's value, undefined leaving the slot absent. Discriminated on the slot, so a unit's
 * narrowing must produce its own slot's type.
 */
type CredentialUnit = {
	[S in keyof GroupCredentials]-?: {
		readonly slot: S;
		readonly passengers: readonly NonSecretOptionalFieldId[];
		readonly narrow: (raw: RawOptionalFields, log?: NarrowLog) => GroupCredentials[S] | undefined;
	};
}[keyof GroupCredentials];

/**
 * The parser's reading of the secret-field vocabulary, total over SecretFieldId: a secret field without a unit here
 * does not compile, so buildGroupArgs (serverSync/engine.ts) cannot send one the parser drops. narrowCredentials
 * reads this table, never the field names.
 */
const CREDENTIAL_UNITS = {
	apiKey: {
		slot: "apiKey",
		passengers: [],
		narrow: (raw) => (typeof raw.apiKey === "string" ? raw.apiKey : undefined),
	},
	oauthClientSecret: { slot: "oauth", passengers: ["oauthScopes"], narrow: narrowOAuth },
	virtualKeyValue: { slot: "virtualKey", passengers: [], narrow: narrowVirtualKey },
} as const satisfies Record<SecretFieldId, CredentialUnit>;

/**
 * Every descriptor field is a secret, a carrier of one, or a passenger of one; a field outside all three would ride
 * buildGroupArgs' configuration and vanish here, so it fails this check until a unit claims it.
 */
type ClaimedField =
	| SecretFieldId
	| SecretFieldCarrier<SecretFieldId>
	| (typeof CREDENTIAL_UNITS)[SecretFieldId]["passengers"][number];
void ({} satisfies Record<Exclude<OptionalEntryFieldId, ClaimedField>, never>);

type CredentialSlots = { -readonly [S in keyof GroupCredentials]?: GroupCredentials[S] };

function fillSlot<S extends keyof GroupCredentials>(
	slots: CredentialSlots,
	unit: {
		readonly slot: S;
		readonly narrow: (raw: RawOptionalFields, log?: NarrowLog) => GroupCredentials[S] | undefined;
	},
	raw: RawOptionalFields,
	log?: NarrowLog
): void {
	const value = unit.narrow(raw, log);
	if (value !== undefined) {
		slots[unit.slot] = value;
	}
}

/** An absent key is the empty string, GroupServer's no-key value. */
function narrowCredentials(raw: RawOptionalFields, log?: NarrowLog): GroupCredentials {
	const slots: CredentialSlots = {};
	for (const field of SECRET_FIELD_IDS) {
		fillSlot(slots, CREDENTIAL_UNITS[field], raw, log);
	}
	return { ...slots, apiKey: slots.apiKey ?? "" };
}

/**
 * Malformed OAuth or virtual-key fields degrade to absent, not to a failed group, and unknown fields pass for
 * forward compatibility. The credentials come off CREDENTIAL_UNITS, so the fields this parser carries are the fields
 * that table claims.
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
	// The entry label the sync engine stamps into the configuration; not an OPTIONAL_ENTRY_FIELDS member because it is
	// a required field of the declared entry itself, read explicitly here like baseUrl.
	const label = usableString(configuration.label);
	const raw: { -readonly [K in OptionalEntryFieldId]?: unknown } = {};
	for (const { id } of OPTIONAL_ENTRY_FIELDS) {
		raw[id] = configuration[id];
	}
	return { baseUrl, ...narrowCredentials(raw, log), ...(label !== undefined ? { label } : {}) };
}

/**
 * `detail` is dropped so the host fills it with the group name. The destructure below is a canary, not
 * round-trip safety; when GroupServer grows a field it stops compiling so someone visits the copies that
 * cannot carry such a guard, parseAttachedServer below and chatClient.ts's ServerConnection copies.
 */
export function attachGroupServer(info: PreAttachModelInfo, server: GroupServer): AttachedModelInfo {
	const { detail: _detail, ...rest } = info;
	const { baseUrl: _url, apiKey: _key, label: _label, oauth: _oauth, virtualKey: _vk, ...unconsumed } = server;
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
 * Attached-only in and out, so decorated copies cannot enter the discovery cache, the status window, or a
 * dashboard snapshot, and the next successful sweep clears the decoration by construction. The banner
 * names the LAST SUCCESSFUL sync, never the failure, so repeated failures cannot look freshly checked.
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
 * Model objects come back across the host boundary, so only their shape is trustworthy, not their type. This is the
 * chat path's one parse of `model.litellm`.
 */
export interface ParsedModelMetadata {
	/**
	 * The attached group server, or undefined when the model object carries none - a state the provider never serves,
	 * which the request path fails loudly on.
	 */
	readonly server: GroupServer | undefined;
	/**
	 * A model object whose round trip lost the stamp falls back to its exposed ID, which group registrations mint raw
	 * anyway.
	 */
	readonly rawModelId: string;
	readonly supportsPromptCaching: boolean;
	readonly supportsAudioInput: boolean;
	/** The registered imageInput capability, re-narrowed like the litellm fields; gates image message conversion. */
	readonly imageInput: boolean;
	/**
	 * Anything but an exact "provider" or "user" (a missing field, an older extension's metadata) keeps the
	 * conservative cap.
	 */
	readonly outputLimitSource: EffectiveOutputLimitSource;
}

/**
 * The attached server's base URL is re-normalized because identity surfaces require the normalized form and the host
 * round trip could hand back anything string-shaped. OAuth and virtual-key sub-objects get the same lenient narrowing
 * as the group configuration: malformed ones degrade to absent.
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

function parseAttachedServer(candidate: unknown, log?: NarrowLog): GroupServer | undefined {
	if (!isRecord(candidate) || typeof candidate.baseUrl !== "string" || typeof candidate.apiKey !== "string") {
		return undefined;
	}
	const baseUrl = normalizeBaseUrl(candidate.baseUrl);
	if (baseUrl.length === 0) {
		// Symmetric with parseGroupConfiguration: a URL that normalizes to nothing (e.g. "/") is no server.
		return undefined;
	}
	const label = usableString(candidate.label);
	const rawOAuth: unknown = candidate.oauth;
	const rawVirtualKey: unknown = candidate.virtualKey;
	const oauth = isRecord(rawOAuth)
		? narrowOAuth({
				oauthTokenUrl: rawOAuth.tokenUrl,
				oauthClientId: rawOAuth.clientId,
				oauthClientSecret: rawOAuth.clientSecret,
				oauthScopes: rawOAuth.scopes,
			})
		: undefined;
	const virtualKey = isRecord(rawVirtualKey)
		? narrowVirtualKey({ virtualKeyHeader: rawVirtualKey.header, virtualKeyValue: rawVirtualKey.value }, log)
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

function modelOutputLimitSource(model: LiteLLMModelInfo): EffectiveOutputLimitSource {
	const source: unknown = model.litellm?.outputLimitSource;
	return source === "provider" || source === "user" ? source : "defaults";
}

/** The host never hands the group NAME to the extension, so the URL host stands in. */
export function groupServerLabel(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}
