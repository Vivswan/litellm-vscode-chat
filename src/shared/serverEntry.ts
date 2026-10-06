/**
 * The one descriptor of a server entry's flat credential fields, shared by the settings parser, the sync engine, and
 * the dashboard protocol.
 * The entry's extension-side-only fields (headers, models.*, discovery.*, budget, mcp) stay out of the descriptor
 * because they must never reach the provider-group args or their fingerprint; they get the deliberately separate
 * sibling registry at the bottom of this file (ENTRY_VIEW_FIELD_SET), whose order is NOT load-bearing.
 */

import type { ModelRecordMap } from "./config/modelMatcher";
import { canonicalStoredBaseUrl, canonicalUrl, normalizeBaseUrl } from "./util/baseUrl";

/**
 * THE ORDER IS LOAD-BEARING while migrations/fingerprintProjection.ts lives: buildGroupArgs emits the provider-group
 * args in this order, and that migration recognises a pre-projection record by re-rendering the full-args JSON.
 * The `format` flag reaches only the generated provider configuration in package.json (scripts/dev/manifest); the
 * readers here walk `id` and `secret`.
 *
 *   secret ones flagged -> inline storage is legal for those; a SecretStorage blob is the alternative
 *   the current "i1:" fingerprint reads only the identity projection (serverSync/engine.ts groupIdentityArgs) -> is
 *     order-free
 *   a URL field (format "uri") names its nested key too -> URL_FIELD_KEYS derives every key a configured URL is
 *     serialized under
 */
export const OPTIONAL_ENTRY_FIELDS = [
	{ id: "apiKey", secret: true },
	{ id: "oauthTokenUrl", secret: false, format: "uri", nestedKey: "tokenUrl" },
	{ id: "oauthClientId", secret: false },
	{ id: "oauthClientSecret", secret: true },
	{ id: "oauthScopes", secret: false },
	{ id: "virtualKeyHeader", secret: false },
	{ id: "virtualKeyValue", secret: true },
] as const;

type OptionalEntryField = (typeof OPTIONAL_ENTRY_FIELDS)[number];

/**
 * The keys a configured URL is serialized under, for a reader that must fail closed on a URL the parser refuses
 * (displayUrl's JSON replacer) and treat any other string as text: the required `baseUrl`, every optional field of
 * format "uri" with its nested key, and McpOptIn's one key.
 */
export const URL_FIELD_KEYS: ReadonlySet<string> = new Set([
	"baseUrl",
	...OPTIONAL_ENTRY_FIELDS.flatMap((field) =>
		"format" in field && field.format === "uri" ? [field.id, field.nestedKey] : []
	),
	"url",
]);

export type OptionalEntryFieldId = OptionalEntryField["id"];

export type SecretFieldId = Extract<OptionalEntryField, { secret: true }>["id"];

export type NonSecretOptionalFieldId = Exclude<OptionalEntryFieldId, SecretFieldId>;

export const SECRET_FIELD_IDS: readonly SecretFieldId[] = OPTIONAL_ENTRY_FIELDS.filter(
	(field): field is Extract<OptionalEntryField, { secret: true }> => field.secret
).map((field) => field.id);

export const NON_SECRET_OPTIONAL_FIELD_IDS: readonly NonSecretOptionalFieldId[] = OPTIONAL_ENTRY_FIELDS.filter(
	(field): field is Extract<OptionalEntryField, { secret: false }> => !field.secret
).map((field) => field.id);

/** An entry's optional fields as parsed values: present only with usable text. */
export type OptionalEntryFields = { readonly [K in OptionalEntryFieldId]?: string | undefined };

/** The non-secret subset: the shape declared views and dashboard payloads carry. */
export type NonSecretOptionalFields = { readonly [K in NonSecretOptionalFieldId]?: string | undefined };

export function pickNonSecretOptionalFields(source: NonSecretOptionalFields): NonSecretOptionalFields {
	const picked: { -readonly [K in NonSecretOptionalFieldId]?: string } = {};
	for (const field of NON_SECRET_OPTIONAL_FIELD_IDS) {
		const value = source[field];
		if (value !== undefined) {
			picked[field] = value;
		}
	}
	return picked;
}

export type SecretLocation = "settings" | "secure" | "none";

/**
 * The ownership stamp serverSync/secrets.ts records at store time and resolveOwnedSecrets compares at use time; the
 * dashboard's stale-key detection (src/dashboard/serverForm.ts) reads this same rule, and the edit page renders it
 * through l10n.
 *
 *   key                 -> base URL, normalized (the transport treats a trailing slash there as insignificant)
 *   OAuth client secret -> { tokenUrl, clientId }: the token URL in its one spelling, trailing slash kept (the exchange
 *                          fetches it exactly, so /token and /token/ differ) and the client whose secret it is
 *   no token URL        -> {}, a real stamp, so gaining a token URL later still needs a deliberate re-pairing
 */
export function secretDestination(entry: SecretDestinationEntry, field: SecretFieldId): SecretOwner {
	if (field !== "oauthClientSecret") {
		return normalizeBaseUrl(entry.baseUrl);
	}
	return {
		...(entry.oauthTokenUrl !== undefined ? { tokenUrl: entry.oauthTokenUrl } : {}),
		...(entry.oauthClientId !== undefined ? { clientId: entry.oauthClientId } : {}),
	};
}

export interface SecretDestinationEntry {
	readonly baseUrl: string;
	readonly oauthTokenUrl?: string | undefined;
	readonly oauthClientId?: string | undefined;
}

/** An OAuth client secret's destination; an absent part matches only an absent part. */
interface OAuthSecretDestination {
	readonly tokenUrl?: string;
	readonly clientId?: string;
}

/** A stored field's ownership stamp as secretDestination renders it; see its rows. */
export type SecretOwner = string | OAuthSecretDestination;

export function sameSecretDestination(a: SecretOwner, b: SecretOwner): boolean {
	if (typeof a === "string" || typeof b === "string") {
		return a === b;
	}
	return a.tokenUrl === b.tokenUrl && a.clientId === b.clientId;
}

/**
 * The one decoder of a persisted stamp (a SecretStorage blob's `_owner` value, a snapshot's `owners` value): a string
 * ("" included) or an OAuth destination object with no other key; anything else is no stamp. URLs are read in their
 * one spelling, because a stamp written as the user typed the URL must keep pairing with the entry the parser now
 * reads canonically; a string with no canonical spelling stays as stored, a mismatch under both rules.
 *
 *   `field` other than the OAuth client secret -> the string is a base URL stamp (canonicalStoredBaseUrl)
 *   the OAuth client secret                     -> a string is the pre-structured token URL stamp (canonicalUrl), the
 *                                                  object's tokenUrl likewise
 */
export function parseSecretOwner(raw: unknown, field: SecretFieldId): SecretOwner | undefined {
	if (typeof raw === "string") {
		if (raw === "") {
			return raw;
		}
		return (field === "oauthClientSecret" ? canonicalUrl(raw) : canonicalStoredBaseUrl(raw)) ?? raw;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return undefined;
	}
	const { tokenUrl, clientId, ...rest } = raw as Record<string, unknown>;
	if (Object.keys(rest).length > 0) {
		return undefined;
	}
	if (
		(tokenUrl !== undefined && typeof tokenUrl !== "string") ||
		(clientId !== undefined && typeof clientId !== "string")
	) {
		return undefined;
	}
	return {
		...(tokenUrl !== undefined ? { tokenUrl: canonicalUrl(tokenUrl) ?? tokenUrl } : {}),
		...(clientId !== undefined ? { clientId } : {}),
	};
}

/**
 * Where each secret field's value may sit inside a raw entry's `auth` object: the one table the settings parser
 * assigns secret values through (parseAuth), pinned position by position by a host test, so a nested secret the
 * parser reads is always a secret field the known-value collector receives from the parsed entry. The flat position
 * is the field id itself (SECRET_FIELD_IDS).
 */
export const SECRET_FIELD_NESTED_PATHS = {
	apiKey: [
		["auth", "apiKey"],
		["auth", "oauth", "apiKey"],
	],
	oauthClientSecret: [["auth", "oauth", "clientSecret"]],
	virtualKeyValue: [
		["auth", "virtualKey", "value"],
		["auth", "oauth", "virtualKey", "value"],
	],
} as const satisfies Record<SecretFieldId, readonly (readonly string[])[]>;

/** The words of a header name that make it a credential; whole words, so "X-Monkey" is no key. */
const CREDENTIAL_HEADER_WORDS = new Set([
	"auth",
	"authentication",
	"authorization",
	"token",
	"apikey",
	"key",
	"secret",
	"password",
	"credential",
	"cookie",
]);

/**
 * The ONE "this header carries a credential" judgment by NAME, for every reader that must treat a configured header
 * value as a secret (the known-value collector, model-facing output). Trimmed: the entry's own
 * virtual-key carriers, and any name one of whose words (split at non-alphanumerics) says so. The issue report's
 * redactSecrets keeps its own textual patterns: it finds header VALUES inside free text by shape, not names.
 *   Authorization, Authentication, X-API-Key, X-Gateway-Token, " Cookie " -> credential
 *   Content-Type, X-Request-Id, X-Monkey, X-Hockey-Team   -> not
 */
export function isCredentialHeader(name: string, carriers: Iterable<string> = []): boolean {
	const lower = name.trim().toLowerCase();
	for (const carrier of carriers) {
		if (carrier.trim().toLowerCase() === lower) {
			return true;
		}
	}
	return lower.split(/[^a-z0-9]+/).some((word) => CREDENTIAL_HEADER_WORDS.has(word));
}

/**
 * The non-secret fields a secret field rides with: the unit rule, owned once for every reader. Every path that forms an
 * auth unit takes its carriers from presentCarriers below, and entryUsesSecretField judges an ENTRY by the same
 * presence.
 */
const SECRET_FIELD_CARRIERS = {
	apiKey: [],
	oauthClientSecret: ["oauthTokenUrl", "oauthClientId"],
	virtualKeyValue: ["virtualKeyHeader"],
} as const satisfies Record<SecretFieldId, readonly NonSecretOptionalFieldId[]>;

export type SecretFieldCarrier<F extends SecretFieldId> = (typeof SECRET_FIELD_CARRIERS)[F][number];

/**
 * A secret field's carriers (SECRET_FIELD_CARRIERS) as the entry carries them, or undefined when any is absent: the
 * value-bearing form of the unit rule. A unit built from the result cannot require fewer carriers than the table lists.
 */
export function presentCarriers<F extends SecretFieldId>(
	field: F,
	entry: NonSecretOptionalFields
): { readonly [K in SecretFieldCarrier<F>]: string } | undefined {
	const values: { -readonly [K in NonSecretOptionalFieldId]?: string } = {};
	for (const carrier of SECRET_FIELD_CARRIERS[field]) {
		const value = entry[carrier];
		if (value === undefined) {
			return undefined;
		}
		values[carrier] = value;
	}
	// Every carrier of `field` was assigned above; the loop's partial record type cannot say so.
	return values as { readonly [K in SecretFieldCarrier<F>]: string };
}

/**
 * The ONE "entry uses this credential field" judgment; it judges the ENTRY alone, so it errs toward "uses it".
 * Wire narrowing still drops what cannot ride, so consumers gate refusals, never the send.
 *
 * Authorization-named header resolved  -> skips the OAuth exchange
 * X-API-Key-named header resolved      -> owns that carrier
 * declared header, value unknown       -> lowers no other field's judgment
 */
export function entryUsesSecretField(
	entry: { readonly baseUrl: string } & NonSecretOptionalFields,
	field: SecretFieldId
): boolean {
	return normalizeBaseUrl(entry.baseUrl).length > 0 && presentCarriers(field, entry) !== undefined;
}

/**
 * The discovery-endpoint failure categories an entry's `expectedFailures` may list.
 *
 *   "modelListing" -> GET /models
 *   "modelInfo"    -> GET /model/info
 */
export const EXPECTED_FAILURE_CATEGORIES = ["modelListing", "modelInfo"] as const;

export type ExpectedFailureCategory = (typeof EXPECTED_FAILURE_CATEGORIES)[number];

/** The one membership check for the category tokens, shared by the setting parser and the dashboard's form. */
export function isExpectedFailureCategory(value: unknown): value is ExpectedFailureCategory {
	return typeof value === "string" && (EXPECTED_FAILURE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Deliberately not the inverse (an allow-list of chat modes): an absent or unrecognized mode keeps registering, never
 * losing a model to a vocabulary this extension has not learned yet. `completion` is listed because text completion
 * models are the inline-completions feature's targets; LiteLLM still bridges chat requests to them, which is what
 * includeModes admits.
 *
 *   The model_info modes that provably serve a non-chat endpoint -> discovery drops them unless the entry's
 *     `discovery.includeModes` names them
 */
export const NON_CHAT_MODES = [
	"embedding",
	"image_generation",
	"audio_speech",
	"audio_transcription",
	"rerank",
	"moderation",
	"completion",
] as const;

export type NonChatMode = (typeof NON_CHAT_MODES)[number];

/** The one membership check for the mode tokens, shared by discovery, the setting parser, and the dashboard's form. */
export function isNonChatMode(value: unknown): value is NonChatMode {
	return typeof value === "string" && (NON_CHAT_MODES as readonly string[]).includes(value);
}

/**
 * How many usable /model/info entries discovery dropped per mode: the dashboard's evidence for offering includeModes.
 */
export type SkippedModeCounts = Readonly<Partial<Record<NonChatMode, number>>>;

/**
 * An entry's `mcp` opt-in: `true` publishes the server's MCP endpoint at <baseUrl>/mcp, and the object form may name
 * the exact endpoint URL instead.
 * It lives here rather than in the MCP feature because the settings parser, the sync engine's views, and the
 * dashboard's payloads all speak it - the feature consumes the vocabulary, it does not own it.
 */
export type McpOptIn = true | { readonly url?: string | undefined };

type EntryModelRecordMap = ModelRecordMap;

/**
 * These fields must never reach the provider-group args or their fingerprint; buildGroupArgs walks
 * OPTIONAL_ENTRY_FIELDS alone, so unlike that descriptor this table's order is NOT load-bearing.
 */
export interface EntryViewFieldValues {
	/** What apiRootOf appends to the base URL: "" is a real value (append nothing), absent means auto-detect. */
	readonly apiVersion: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly modelParameters: EntryModelRecordMap;
	readonly modelCapabilities: EntryModelRecordMap;
	readonly expectedFailures: readonly ExpectedFailureCategory[];
	/** Exact model IDs to register when discovery does not list them (discovery.declared). */
	readonly declaredModels: readonly string[];
	/** The non-chat modes discovery admits to the chat catalog for this entry (discovery.includeModes). */
	readonly includeModes: readonly NonChatMode[];
	readonly budget: number;
	readonly mcp: McpOptIn;
}

const ENTRY_VIEW_FIELD_SET = {
	apiVersion: true,
	headers: true,
	modelParameters: true,
	modelCapabilities: true,
	expectedFailures: true,
	declaredModels: true,
	includeModes: true,
	budget: true,
	mcp: true,
} as const satisfies Readonly<Record<keyof EntryViewFieldValues, true>>;

export type EntryViewFieldId = keyof typeof ENTRY_VIEW_FIELD_SET;

export const ENTRY_VIEW_FIELD_IDS = Object.keys(ENTRY_VIEW_FIELD_SET) as readonly EntryViewFieldId[];

/** The extension-side fields as parsed entries and views carry them: present only with usable content. */
export type EntryViewFields = { readonly [K in EntryViewFieldId]?: EntryViewFieldValues[K] | undefined };

export type MutableEntryViewFields = { -readonly [K in EntryViewFieldId]?: EntryViewFieldValues[K] };

export function pickEntryViewFields(source: EntryViewFields): EntryViewFields {
	const picked: MutableEntryViewFields = {};
	for (const field of ENTRY_VIEW_FIELD_IDS) {
		copyPresentField(picked, field, source[field]);
	}
	return picked;
}

/** The per-field copy, generic so the assignment stays typed to the field's own value. */
function copyPresentField<K extends EntryViewFieldId>(
	target: MutableEntryViewFields,
	field: K,
	value: EntryViewFieldValues[K] | undefined
): void {
	if (value !== undefined) {
		target[field] = value;
	}
}
