import * as l10n from "@vscode/l10n";
import type { LanguageModelChatInformation } from "vscode";
import { ThemeIcon } from "vscode";
import { guessedMaxTokensDefault, type ServerDeclaredCapabilities } from "../../shared/config/capabilityResolution";
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
import { canonicalBaseUrl, canonicalUrl } from "../../shared/util/baseUrl";
import { displayUrl } from "../../shared/util/displayUrl";
import { fingerprint } from "../../shared/util/fingerprint";
import { HEADER_NAME_PATTERN, sendableHeaderValue, usableHttpText } from "../../shared/util/headers";
import { isRecord } from "../../shared/util/json";
import type { OAuthConfig, VirtualKeyConfig } from "../transport/auth";
import { oauthCredentialFingerprint } from "../transport/auth";

/**
 * The host stores one configuration object per named group and hands the exact LanguageModelChatInformation objects a
 * provider returned back to provideLanguageModelChatResponse and provideTokenCount, so LiteLLM facts ride on the model
 * objects themselves. The group's connection does not: a model carries its group's identity, and the provider resolves
 * the live connection from it at request time, so no credential value is ever handed to the host.
 */

export interface GroupServer {
	baseUrl: NormalizedBaseUrl;
	apiKey: string;
	/** Non-secret. Part of the group's identity (see groupIdentity and groupClientId). */
	label?: string;
	/** Client-credentials authentication; present only when the configuration names a token URL and client ID. */
	oauth?: OAuthConfig;
	/** Gateway virtual key; present only when the configuration names both a header and a value. */
	virtualKey?: VirtualKeyConfig;
	/**
	 * Set by overlayEntryCredentials when a declared entry at this label and URL owns the group. Owned, the group's
	 * identity is the rotation-stable label plus URL (the setting is truth); unowned, it stays the client ID, since no
	 * declarative source exists that would make one labeled external twin stand in for another.
	 */
	entryOwned?: true;
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
	 * The request's max_tokens when nothing configures one, decided where the limit was derived (registration, or the
	 * capability walk on a rebuild); the chat path reads it and applies no cap of its own.
	 */
	readonly defaultMaxTokens: number;
	/**
	 * Gates the input_audio message conversion. Optional because model objects round-trip through the host and older
	 * metadata lacks it (absent reads as false).
	 */
	readonly supportsAudioInput?: boolean;
	/** True for a declared model (an entry's discovery.declared; discovery does not list it). */
	readonly declared?: boolean;
}

/**
 * The `never` pins the serve boundary: a served copy, stamped with one group's identity and possibly stale-decorated
 * (markStale), does not compile into the discovery cache (groupDiscovery.ts), StatusWindow.record (statusWindow.ts),
 * or a dashboard snapshot, which hold the configuration-free form.
 */
export interface PreAttachModelInfo extends LanguageModelChatInformation {
	readonly litellm: LiteLLMModelMetadataBase & {
		/**
		 * Required, so an entry without a baseline is unrepresentable; attach drops it, since the chat path reads
		 * patched values.
		 */
		readonly serverDeclared: ServerDeclaredCapabilities;
		readonly group?: never;
	};
}

/**
 * A model entry stamped with the identity of the group that served it, for the host round trip: attachGroup is the
 * sole constructor. No field of this type can hold a credential value; the request path resolves the live connection
 * from `group`.
 */
export interface AttachedModelInfo extends LanguageModelChatInformation {
	readonly litellm: LiteLLMModelMetadataBase & {
		readonly group: string;
		readonly serverDeclared?: never;
	};
}

export type LiteLLMModelInfo = PreAttachModelInfo | AttachedModelInfo;

/** The credential slice of a group server: what the entry-credentials overlay replaces as one unit. */
export type GroupCredentials = Pick<GroupServer, "apiKey" | "oauth" | "virtualKey">;

/**
 * Wholesale, never merged: the entry's resolved credential set is the complete truth, so an entry that dropped its
 * OAuth unit (or virtual key) must strip the baked one rather than keep authenticating with it. The destructure is a
 * canary: when GroupServer grows a field it stops compiling, so the field-by-field copies here and in groupDiscovery's
 * ServerConnection get visited.
 */
function overlayGroupCredentials(server: GroupServer, credentials: GroupCredentials): GroupServer {
	const { baseUrl, label, apiKey: _key, oauth: _oauth, virtualKey: _vk, entryOwned: _owned, ...unconsumed } = server;
	void (unconsumed satisfies Record<string, never>);
	return {
		baseUrl,
		apiKey: credentials.apiKey,
		...(label !== undefined ? { label } : {}),
		...(credentials.oauth !== undefined ? { oauth: credentials.oauth } : {}),
		...(credentials.virtualKey !== undefined ? { virtualKey: credentials.virtualKey } : {}),
		entryOwned: true,
	};
}

/**
 * The secret fields that ride an HTTP header, so a value the platform's Headers would refuse is a refusal of the field.
 * The OAuth client secret rides the token request's body (transport/auth.ts) and has no header rule.
 */
export const HEADER_BORNE_SECRET_FIELDS = ["apiKey", "virtualKeyValue"] as const satisfies readonly SecretFieldId[];

export type RejectedCredentialField = (typeof HEADER_BORNE_SECRET_FIELDS)[number];

/**
 * Why a declared entry's credentials did not resolve. secretsUnreadable and secretsMismatched are the sync engine's own
 * skip reasons (syncFailureOf); a refusal carries the fields the user-facing text names, never zero of them.
 */
type CredentialsUnavailable =
	| { readonly reason: "secretsUnreadable" | "secretsMismatched" | "unusable" }
	| {
			readonly reason: "credentialsRefused";
			readonly fields: readonly [RejectedCredentialField, ...RejectedCredentialField[]];
	  };

/**
 * The entry-credentials resolver's answer for a labeled group, overlaid onto the connection handed in: at serve time
 * the host-baked set a rotation retires, at request time the status window's recorded set.
 *   external (no declared entry at this label and normalized base URL) -> the connection handed in stays; a leftover group
 *   resolved                                                           -> the entry's current set overlays it
 *   unavailable(reason)                                                -> a classified failure, never the handed-in key
 */
export type GroupCredentialsResolution =
	| { readonly kind: "external" }
	| { readonly kind: "resolved"; readonly credentials: GroupCredentials }
	| ({ readonly kind: "unavailable" } & CredentialsUnavailable);

const REJECTED_FIELD_KIND: Readonly<
	Record<RejectedCredentialField, { readonly display: () => string; readonly english: string }>
> = {
	apiKey: { display: () => l10n.t("API key"), english: "API key" },
	virtualKeyValue: { display: () => l10n.t("virtual key"), english: "virtual key" },
};

/** The one failure a serve or request raises for a declared entry whose credentials did not resolve. */
function credentialsUnavailableError(unavailable: CredentialsUnavailable): MirroredError {
	switch (unavailable.reason) {
		case "secretsUnreadable":
		case "secretsMismatched":
		case "unusable":
			return localizedError(
				l10n.t(
					"This server entry's credentials could not be resolved, so its stored copy in VS Code was not used. Check the server row on the dashboard, then run LiteLLM: Sync Models Now."
				),
				"entry credentials unavailable",
				`EntryCredentialsUnavailable(${unavailable.reason})`
			);
		case "credentialsRefused": {
			const kinds = unavailable.fields.map((field) => REJECTED_FIELD_KIND[field]);
			return localizedError(
				l10n.t(
					"This server entry's {0} cannot be sent as an HTTP header, so no request was made. Enter the value again from the server row on the dashboard.",
					kinds.map((kind) => kind.display()).join(", ")
				),
				`This server entry's ${kinds.map((kind) => kind.english).join(", ")} cannot be sent as an HTTP header, so no request was made. Enter the value again from the server row on the dashboard.`,
				"EntryCredentialsUnavailable(credentialsRefused)"
			);
		}
	}
}

/** The extension layer's resolver of a declared entry's current credentials; see GroupCredentialsResolution. */
export type EntryCredentialsResolver = (label: string, baseUrl: string) => Promise<GroupCredentialsResolution>;

/**
 * The one overlay for both consumers of a labeled group's credentials, both in provider/index.ts.
 *   serve path   -> the failure rides beside the baked server as the discovery preflight failure
 *   request path -> the failure is thrown before anything is sent
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
			return { server: { ...server, entryOwned: true }, failure: credentialsUnavailableError(resolution) };
	}
}

/** Client-cache IDs for group servers, disjoint from any other server id shape (see isGroupClientId). */
const GROUP_CLIENT_ID_PREFIX = "group:";

/**
 * A fixed-arity JSON tuple, injective because escaping keeps every value inside its slot, hashed so no ID embeds
 * credential material; the readable URL suffix is the credential-free spelling (userinfo stripped). A credential
 * rotation mints a new client ID for the same logical group; a labeled group's logicalGroupId (statusWindow.ts) does
 * not change, so its status entry survives the rotation.
 *
 *   credential fingerprint -> two groups may share a base URL with different credentials
 *   entry label            -> two DECLARED entries may share the URL and every credential, and without it
 *                             both would share one client ID, the dashboard's handle to a group (getGroupServer)
 */
export function groupClientId(server: GroupServer): string {
	const identity = JSON.stringify([
		server.baseUrl,
		server.label ?? null,
		server.apiKey,
		server.oauth ? oauthCredentialFingerprint(server.oauth) : null,
		server.virtualKey ? [server.virtualKey.header, server.virtualKey.value] : null,
	]);
	return `${GROUP_CLIENT_ID_PREFIX}${fingerprint(identity)}:${displayUrl(server.baseUrl)}`;
}

/**
 * Accepts unknown because callers also classify persisted status entries, which older extension versions may have
 * written with arbitrary shapes.
 */
export function isGroupClientId(serverId: unknown): boolean {
	return typeof serverId === "string" && serverId.startsWith(GROUP_CLIENT_ID_PREFIX);
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
		const value = usableHttpText(raw[id]);
		if (value !== undefined) {
			fields[id] = value;
		}
	}
	return fields;
}

/**
 * OAuth is present as one typed unit or not at all: a usable token URL and client ID make the unit, anything less
 * degrades to absent. The secret is taken verbatim (an empty one means a public client) and scopes are optional; it
 * rides the token request's body (transport/auth.ts), never a header, so no header rule applies to it.
 */
function narrowOAuth(raw: RawOptionalFields): OAuthConfig | undefined {
	const fields = usableNonSecretFields(raw);
	const carriers = presentCarriers("oauthClientSecret", fields);
	// The token URL in its one spelling, like baseUrl: the credential fingerprint hashes it, so a host group created
	// under the user's spelling must mint the identity the canonical entry expects.
	const tokenUrl = carriers === undefined ? undefined : canonicalUrl(carriers.oauthTokenUrl);
	if (carriers === undefined || tokenUrl === undefined) {
		return undefined;
	}
	return {
		tokenUrl,
		clientId: carriers.oauthClientId,
		clientSecret: typeof raw.oauthClientSecret === "string" ? raw.oauthClientSecret : "",
		...(fields.oauthScopes !== undefined ? { scopes: fields.oauthScopes } : {}),
	};
}

/**
 * A credential the narrowing dropped, named by field so the dashboard can point at the entry's auth field and the log
 * can classify it. `header` is the virtual key's configured header name (user configuration, never a value);
 * `fingerprint` identifies the configured value for once-only logging and never reveals it.
 */
export interface CredentialRejection {
	readonly field: RejectedCredentialField;
	readonly header?: string;
	readonly fingerprint: string;
}

export type CredentialRejectionReport = (rejection: CredentialRejection) => void;

/** One log line per distinct rejected value, so the host's repeated group refreshes do not spam the log. */
const loggedRejections = new Set<string>();

/**
 * The serve path's reporter for the host-baked configuration (provider/index.ts): the classification, the virtual key's
 * header name for typo hunting, never a value. A declared entry's own copy is judged in entryCredentials.ts instead.
 */
export function logCredentialRejections(log: (message: string, data?: unknown) => void): CredentialRejectionReport {
	return (rejection) => {
		const key = `${rejection.field}:${rejection.fingerprint}`;
		if (loggedRejections.has(key)) {
			return;
		}
		loggedRejections.add(key);
		if (rejection.field === "apiKey") {
			log("Ignoring the configured API key: the value cannot be sent as an HTTP header");
		} else {
			log("Ignoring the configured virtual key: the header name or value cannot be sent as an HTTP header", {
				header: rejection.header,
			});
		}
	};
}

/**
 * The key rides two headers (transport/clients.ts buildDefaultHeaders), so a value the platform's Headers would
 * refuse never reaches it: that TypeError quotes the whole value, and it would surface in the chat error, the
 * dashboard row, and the output channel. A pasted trailing newline is the common case and is repaired by trimming;
 * a value still refused has no unambiguous repair and drops the key.
 */
function narrowApiKey(raw: RawOptionalFields, report?: CredentialRejectionReport): string | undefined {
	if (typeof raw.apiKey !== "string") {
		return undefined;
	}
	const sendable = sendableHeaderValue(raw.apiKey);
	if (sendable !== undefined) {
		return sendable;
	}
	report?.({ field: "apiKey", fingerprint: fingerprint(raw.apiKey) });
	return undefined;
}

/**
 * A rejection names the header so typos are diagnosable; the value never leaves the narrowing. A header with no value
 * is a missing secret and a value with no header is a dormant one (a stored blob the entry no longer uses); the
 * secret-location view already shows both, so neither is a rejection: a rejection is a unit the entry configured and
 * cannot send. The value is read by the one credential trim rule (sendableHeaderValue), so a pasted newline is
 * repaired and a Latin-1 byte survives, exactly as for the API key.
 */
function narrowVirtualKey(raw: RawOptionalFields, report?: CredentialRejectionReport): VirtualKeyConfig | undefined {
	if (raw.virtualKeyHeader === undefined && raw.virtualKeyValue === undefined) {
		return undefined;
	}
	const carriers = presentCarriers("virtualKeyValue", usableNonSecretFields(raw));
	const sendable = typeof raw.virtualKeyValue === "string" ? sendableHeaderValue(raw.virtualKeyValue) : undefined;
	if (
		carriers !== undefined &&
		sendable !== undefined &&
		sendable.length > 0 &&
		HEADER_NAME_PATTERN.test(carriers.virtualKeyHeader)
	) {
		return { header: carriers.virtualKeyHeader, value: sendable };
	}
	if (carriers !== undefined && raw.virtualKeyValue !== undefined) {
		const value = typeof raw.virtualKeyValue === "string" ? raw.virtualKeyValue : "";
		report?.({
			field: "virtualKeyValue",
			header: carriers.virtualKeyHeader,
			fingerprint: fingerprint(`${carriers.virtualKeyHeader}\u0000${value}`),
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
		readonly narrow: (raw: RawOptionalFields, report?: CredentialRejectionReport) => GroupCredentials[S] | undefined;
	};
}[keyof GroupCredentials];

/**
 * The parser's reading of the secret-field vocabulary, total over SecretFieldId: a secret field without a unit here
 * does not compile, so buildGroupArgs (serverSync/engine.ts) cannot send one the parser drops. narrowGroupCredentials
 * reads this table, never the field names.
 */
const CREDENTIAL_UNITS = {
	apiKey: { slot: "apiKey", passengers: [], narrow: narrowApiKey },
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
		readonly narrow: (raw: RawOptionalFields, report?: CredentialRejectionReport) => GroupCredentials[S] | undefined;
	},
	raw: RawOptionalFields,
	report?: CredentialRejectionReport
): void {
	const value = unit.narrow(raw, report);
	if (value !== undefined) {
		slots[unit.slot] = value;
	}
}

/**
 * The credential half of a group server from the raw optional fields (an absent key is the empty string, GroupServer's
 * no-key value). Exported so the usage client (usage/spendClient.ts) narrows by this very table and cannot diverge on
 * which credentials travel.
 */
export function narrowGroupCredentials(raw: RawOptionalFields, report?: CredentialRejectionReport): GroupCredentials {
	const slots: CredentialSlots = {};
	for (const field of SECRET_FIELD_IDS) {
		fillSlot(slots, CREDENTIAL_UNITS[field], raw, report);
	}
	return { ...slots, apiKey: slots.apiKey ?? "" };
}

/**
 * Malformed OAuth or virtual-key fields degrade to absent, not to a failed group, and unknown fields pass for
 * forward compatibility. The credentials come off CREDENTIAL_UNITS, so the fields this parser carries are the fields
 * that table claims.
 */
export function parseGroupConfiguration(
	configuration: unknown,
	report?: CredentialRejectionReport
): GroupServer | undefined {
	if (!isRecord(configuration)) {
		return undefined;
	}
	// The host hands back whatever spelling created the group (older versions wrote the user's text), so this boundary
	// canonicalizes too: a group created at "HTTP://Host" is the entry now declared at "http://host".
	const rawBaseUrl = usableHttpText(configuration.baseUrl);
	const baseUrl = rawBaseUrl === undefined ? undefined : canonicalBaseUrl(rawBaseUrl);
	if (baseUrl === undefined) {
		return undefined;
	}
	// The entry label the sync engine stamps into the configuration; not an OPTIONAL_ENTRY_FIELDS member because it is
	// a required field of the declared entry itself, read explicitly here like baseUrl.
	const label = usableHttpText(configuration.label);
	const raw: { -readonly [K in OptionalEntryFieldId]?: unknown } = {};
	for (const { id } of OPTIONAL_ENTRY_FIELDS) {
		raw[id] = configuration[id];
	}
	return { baseUrl, ...narrowGroupCredentials(raw, report), ...(label !== undefined ? { label } : {}) };
}

/** `detail` is dropped so the host fills it with the group name. */
export function attachGroup(info: PreAttachModelInfo, group: string): AttachedModelInfo {
	const { detail: _detail, ...rest } = info;
	return {
		...rest,
		litellm: {
			rawModelId: info.litellm.rawModelId,
			supportsPromptCaching: modelSupportsPromptCaching(info),
			defaultMaxTokens: modelDefaultMaxTokens(info),
			supportsAudioInput: modelSupportsAudioInput(info),
			...(info.litellm.declared === true ? { declared: true } : {}),
			group,
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
	 * The identity of the group that served the model, or undefined when the model object carries none - a state the
	 * provider never serves, which the request path fails loudly on.
	 */
	readonly group: string | undefined;
	/**
	 * A model object whose round trip lost the stamp falls back to its exposed ID, which group registrations mint raw
	 * anyway.
	 */
	readonly rawModelId: string;
	/** The host's token limits as the model object carries them; the request path reads them from here only. */
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly supportsPromptCaching: boolean;
	readonly supportsAudioInput: boolean;
	/** The registered imageInput capability, re-narrowed like the litellm fields; gates image message conversion. */
	readonly imageInput: boolean;
	/** See LiteLLMModelMetadataBase.defaultMaxTokens. */
	readonly defaultMaxTokens: number;
}

/** The group identity is compared with the window's, never derived from, so any usable string is taken as-is. */
export function parseModelMetadata(model: LiteLLMModelInfo): ParsedModelMetadata {
	const rawModelId = model.litellm?.rawModelId;
	return {
		group: usableHttpText(model.litellm?.group),
		rawModelId: typeof rawModelId === "string" && rawModelId.length > 0 ? rawModelId : model.id,
		maxInputTokens: model.maxInputTokens,
		maxOutputTokens: model.maxOutputTokens,
		supportsPromptCaching: modelSupportsPromptCaching(model),
		supportsAudioInput: modelSupportsAudioInput(model),
		imageInput: model.capabilities?.imageInput === true,
		defaultMaxTokens: modelDefaultMaxTokens(model),
	};
}

export function modelSupportsPromptCaching(model: LiteLLMModelInfo): boolean {
	return model.litellm?.supportsPromptCaching === true;
}

/** Re-narrowed like every host round trip: absent (older metadata) or malformed reads as false. */
function modelSupportsAudioInput(model: LiteLLMModelInfo): boolean {
	return model.litellm?.supportsAudioInput === true;
}

function modelDefaultMaxTokens(model: LiteLLMModelInfo): number {
	const stamped: unknown = model.litellm?.defaultMaxTokens;
	if (typeof stamped === "number" && stamped > 0) {
		return stamped;
	}
	// Metadata minted before the stamp existed carries the word the cap decision used to read instead.
	//   "provider", "user" -> was sent whole
	//   anything else      -> was capped as a guess
	const legacy: unknown = isRecord(model.litellm) ? model.litellm.outputLimitSource : undefined;
	return legacy === "provider" || legacy === "user"
		? model.maxOutputTokens
		: guessedMaxTokensDefault(model.maxOutputTokens);
}

/** The host never hands the group NAME to the extension, so the URL host stands in. */
export function groupServerLabel(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}
