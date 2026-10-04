/**
 * The one descriptor of a server entry's flat credential fields, shared by the
 * settings parser, the sync engine, and the dashboard protocol. Every field
 * list elsewhere derives from here, so adding a field means extending
 * OPTIONAL_ENTRY_FIELDS and following the compile errors. The entry's
 * extension-side-only fields (headers, models.*, discovery.*, budget, mcp)
 * stay out of the descriptor because they must never reach the provider-group
 * args or their fingerprint; they get the deliberately separate sibling
 * registry at the bottom of this file (ENTRY_VIEW_FIELD_SET), whose order is
 * NOT load-bearing.
 */

import type { ModelRecordMap } from "./config/modelMatcher";
import { normalizeBaseUrl } from "./util/baseUrl";

/**
 * The optional fields an entry may carry beyond label and baseUrl, secret ones flagged (inline storage is legal for
 * those; a SecretStorage blob is the alternative). THE ORDER IS LOAD-BEARING while migrations/fingerprintProjection.ts
 * lives: buildGroupArgs emits the provider-group args in this order, and that migration recognises a pre-projection
 * record by re-rendering the full-args JSON, so a reorder changes the rendering of every record whose args carry two
 * or more reordered fields and leaves those to the migration's ledger proof. The current "i1:" fingerprint reads only
 * the identity projection (serverSync/engine.ts groupIdentityArgs) and is order-free.
 */
export const OPTIONAL_ENTRY_FIELDS = [
	{ id: "apiKey", secret: true },
	{ id: "oauthTokenUrl", secret: false },
	{ id: "oauthClientId", secret: false },
	{ id: "oauthClientSecret", secret: true },
	{ id: "oauthScopes", secret: false },
	{ id: "virtualKeyHeader", secret: false },
	{ id: "virtualKeyValue", secret: true },
] as const;

type OptionalEntryField = (typeof OPTIONAL_ENTRY_FIELDS)[number];

/** Any optional field of an entry, secret or not. */
export type OptionalEntryFieldId = OptionalEntryField["id"];

/** The three secret fields of an entry; everything else is plain configuration. */
export type SecretFieldId = Extract<OptionalEntryField, { secret: true }>["id"];

/** The optional fields that are plain configuration, safe to show in views and payloads. */
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

/** Copy the non-secret optional fields that are present; absent ones stay omitted. */
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

/** Where one secret field of a declared server lives. */
export type SecretLocation = "settings" | "secure" | "none";

/**
 * The ownership stamp serverSync/secrets.ts records at store time and resolveOwnedSecrets compares at use time.
 * src/dashboard/serverForm.ts's stale-key detection reads this same rule instead of re-deriving it webview-side.
 *
 *   key                 -> base URL, normalized (the transport treats a trailing slash there as insignificant)
 *   OAuth client secret -> token URL VERBATIM (the exchange fetches it exactly, so /token and /token/ differ)
 *   no token URL        -> "", a real stamp, so gaining a token URL later still needs a deliberate re-pairing
 */
export function secretDestination(
	entry: { readonly baseUrl: string; readonly oauthTokenUrl?: string | undefined },
	field: SecretFieldId
): string {
	return field === "oauthClientSecret" ? (entry.oauthTokenUrl ?? "") : normalizeBaseUrl(entry.baseUrl);
}

/**
 * The non-secret fields a secret field rides with: the unit rule, owned once for every reader. entryUsesSecretField
 * below judges an ENTRY by the carriers' presence; usageConnectionFor (extension/servers/usage/spendClient.ts) builds
 * an entry's auth units from the carriers presentCarriers hands it; parseGroupConfiguration
 * (provider/catalog/groupModels.ts) narrows a host configuration to the entry shape and asks presentCarriers the
 * same way. So neither the chat path nor the usage path can send a secret whose carriers the rule denies;
 * the no-server arm is each path's own refusal (the parser yields no configuration, the usage GET has no absolute
 * URL to form). Total over SecretFieldId: a new secret field declares its carriers here before any reader compiles.
 */
const SECRET_FIELD_CARRIERS = {
	apiKey: [],
	oauthClientSecret: ["oauthTokenUrl", "oauthClientId"],
	virtualKeyValue: ["virtualKeyHeader"],
} as const satisfies Record<SecretFieldId, readonly NonSecretOptionalFieldId[]>;

/** The carriers of one secret field, as a name union. */
export type SecretFieldCarrier<F extends SecretFieldId> = (typeof SECRET_FIELD_CARRIERS)[F][number];

/**
 * A secret field's carriers (SECRET_FIELD_CARRIERS) as the entry carries them, or undefined when any is absent: the
 * value-bearing form of the unit rule. A unit built from the result cannot require fewer carriers than the table
 * lists, so it can form only where entryUsesSecretField attributes the field to an entry that has a server; the
 * value's own presence and legality narrow the send further.
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
 * The discovery-endpoint failure categories an entry's `expectedFailures` may
 * list: "modelListing" is GET /models, "modelInfo" is GET /model/info. Like
 * the other extension-side-only fields, this one stays out of
 * OPTIONAL_ENTRY_FIELDS: it must never reach the provider-group args or their
 * fingerprint.
 */
export const EXPECTED_FAILURE_CATEGORIES = ["modelListing", "modelInfo"] as const;

/** A discovery failure the user told us to expect on an entry's server. */
export type ExpectedFailureCategory = (typeof EXPECTED_FAILURE_CATEGORIES)[number];

/** The one membership check for the category tokens, shared by the setting parser and the dashboard's form. */
export function isExpectedFailureCategory(value: unknown): value is ExpectedFailureCategory {
	return typeof value === "string" && (EXPECTED_FAILURE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The model_info modes that provably serve a non-chat endpoint, so discovery
 * drops them unless the entry's `discovery.includeModes` names them.
 * Deliberately not the inverse (an allow-list of chat modes): an absent or
 * unrecognized mode keeps registering, never losing a model to a vocabulary
 * this extension has not learned yet. `completion` is listed because text
 * completion models are the inline-completions feature's targets; LiteLLM
 * still bridges chat requests to them, which is what includeModes admits.
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

/** A mode discovery drops by default: the only tokens `discovery.includeModes` may name. */
export type NonChatMode = (typeof NON_CHAT_MODES)[number];

/** The one membership check for the mode tokens, shared by discovery, the setting parser, and the dashboard's form. */
export function isNonChatMode(value: unknown): value is NonChatMode {
	return typeof value === "string" && (NON_CHAT_MODES as readonly string[]).includes(value);
}

/** How many usable /model/info entries discovery dropped per mode: the dashboard's evidence for offering includeModes. */
export type SkippedModeCounts = Readonly<Partial<Record<NonChatMode, number>>>;

/**
 * An entry's `mcp` opt-in: `true` publishes the server's MCP endpoint at
 * <baseUrl>/mcp, and the object form may name the exact endpoint URL instead.
 * Another extension-side-only field, so it stays out of OPTIONAL_ENTRY_FIELDS
 * and with it out of the provider-group args and their fingerprint. It lives
 * here rather than in the MCP feature because the settings parser, the sync
 * engine's views, and the dashboard's payloads all speak it - the feature
 * consumes the vocabulary, it does not own it.
 */
export type McpOptIn = true | { readonly url?: string | undefined };

/**
 * One model-record map (matcher key to field record): the canonical
 * ModelRecordMap shape the per-entry models.parameters and models.capabilities
 * records share on every view and payload - aliased, not redeclared, so the
 * two cannot drift. Type-only, so nothing extra rides into the webview bundle.
 */
type EntryModelRecordMap = ModelRecordMap;

/**
 * These fields must never reach the provider-group args or their fingerprint; buildGroupArgs walks OPTIONAL_ENTRY_FIELDS alone,
 * so unlike that descriptor this table's order is NOT load-bearing.
 */
export interface EntryViewFieldValues {
	/** What apiRootOf appends to the base URL: "" is a real value (append nothing), absent means auto-detect. */
	readonly apiVersion: string;
	/** The entry's custom HTTP headers, sent on every request to its server; auth headers win conflicts. */
	readonly headers: Readonly<Record<string, string>>;
	/** The entry's per-entry models.parameters record: model matcher to request parameters, like the global setting. */
	readonly modelParameters: EntryModelRecordMap;
	/** The entry's per-entry models.capabilities record: model matcher to capability record, like the global setting. */
	readonly modelCapabilities: EntryModelRecordMap;
	/** The discovery-failure categories the entry expects. */
	readonly expectedFailures: readonly ExpectedFailureCategory[];
	/** Exact model IDs to register when discovery does not list them (discovery.declared). */
	readonly declaredModels: readonly string[];
	/** The non-chat modes discovery admits to the chat catalog for this entry (discovery.includeModes). */
	readonly includeModes: readonly NonChatMode[];
	/** The entry's manual usage budget in USD; the usage surfaces read it. */
	readonly budget: number;
	/** The entry's MCP opt-in; the MCP publisher and the edit form's prefill read it. */
	readonly mcp: McpOptIn;
}

/**
 * The registry's id half; `satisfies` pins it to the value table both ways
 * (a missing key fails the Record, an extra key fails excess-property
 * checking), so the iterable list below can never drift from the type.
 */
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

/** Any extension-side entry field beyond label, baseUrl, and the credential fields. */
export type EntryViewFieldId = keyof typeof ENTRY_VIEW_FIELD_SET;

export const ENTRY_VIEW_FIELD_IDS = Object.keys(ENTRY_VIEW_FIELD_SET) as readonly EntryViewFieldId[];

/** The extension-side fields as parsed entries and views carry them: present only with usable content. */
export type EntryViewFields = { readonly [K in EntryViewFieldId]?: EntryViewFieldValues[K] | undefined };

/** The mutable builder shape the settings parser assembles an entry's fields into. */
export type MutableEntryViewFields = { -readonly [K in EntryViewFieldId]?: EntryViewFieldValues[K] };

/** Copy the extension-side fields that are present; absent ones stay omitted. */
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
