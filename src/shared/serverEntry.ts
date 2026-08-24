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
 * The optional fields an entry may carry beyond label and baseUrl, secret ones
 * flagged (inline storage is legal for those; a SecretStorage blob is the
 * alternative). THE ORDER IS LOAD-BEARING: buildGroupArgs emits the
 * provider-group args in this order, and the sync engine fingerprints a
 * JSON.stringify of that object, so reordering silently invalidates every
 * stored fingerprint and re-pushes every group.
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
 * The destination one secret field's value is sent to when paired with an
 * entry: the keys go to the base URL (compared under the shared normalization,
 * because the transport itself treats a trailing slash there as insignificant)
 * and the OAuth client secret to the token URL, compared VERBATIM as parsed -
 * the token exchange fetches the configured URL exactly, so /token and /token/
 * are different wire requests and must be different stamps ("" when the entry
 * configures none - a real stamp, so gaining a token URL later still requires
 * a deliberate re-pairing). This is what ownership stamps record at store time
 * (serverSync/secrets.ts) and what resolveOwnedSecrets compares at use time;
 * it lives here so the dashboard's stale-key detection reads the SAME rule the
 * extension stamps by, instead of a webview-side re-derivation.
 */
export function secretDestination(
	entry: { readonly baseUrl: string; readonly oauthTokenUrl?: string | undefined },
	field: SecretFieldId
): string {
	return field === "oauthClientSecret" ? (entry.oauthTokenUrl ?? "") : normalizeBaseUrl(entry.baseUrl);
}

/**
 * Whether an entry's shape would actually SEND a value in `field`, were one to
 * resolve (inline or from SecretStorage): the ONE judgment of "this entry uses
 * this credential field", each arm derived from the wire narrowing in
 * provider/catalog's parseGroupConfiguration. An entry whose base URL
 * normalizes to nothing forms no server at all (parseGroupConfiguration
 * refuses it), so it uses no field. Otherwise: a resolved apiKey is sent on
 * every entry shape - the transport carries it on each request regardless of
 * the other auth fields, and a missing key merely means a keyless server; the
 * OAuth client secret goes out only through an active oauth unit (narrowOAuth
 * requires BOTH tokenUrl and clientId - the settings parser also rejects one
 * without the other, so on parsed entries checking both is equivalent to
 * checking either); a virtual key value goes out only through a declared
 * header (narrowVirtualKey requires both halves; on a parsed entry the header
 * NAME's validity is already enforced by the parser).
 *
 * Deliberately a judgment of the ENTRY alone, given some value: the VALUE's
 * own sendability (narrowVirtualKey also drops a header-value-illegal virtual
 * key) cannot be judged without the value in hand, so a caller holding only a
 * stored value's existence errs toward "uses it" - the safe direction, since
 * consumers gate refusals and questions about stored values (the sync engine's
 * secretsMismatched skip, MCP's resolve refusal, the stale-stamp and import
 * consent questions), never the send itself: the wire narrowing still drops
 * what cannot ride. Header-name collisions are value-contingent the same way:
 * a virtual key displaces another credential (an Authorization-named header
 * skips the OAuth exchange, an X-API-Key-named one owns that carrier) only
 * when its own value RESOLVES, which the entry cannot show - so a declared
 * header never lowers another field's judgment. The dashboard form's activity
 * ring (serverForm's authFormActivity) is deliberately NOT this rule: it keys
 * on the picked auth selector so a stored-but-unsent value can still block a
 * save.
 */
export function entryUsesSecretField(
	entry: {
		readonly baseUrl: string;
		readonly oauthTokenUrl?: string | undefined;
		readonly oauthClientId?: string | undefined;
		readonly virtualKeyHeader?: string | undefined;
	},
	field: SecretFieldId
): boolean {
	if (normalizeBaseUrl(entry.baseUrl).length === 0) {
		return false;
	}
	switch (field) {
		case "apiKey":
			return true;
		case "oauthClientSecret":
			return entry.oauthTokenUrl !== undefined && entry.oauthClientId !== undefined;
		case "virtualKeyValue":
			return entry.virtualKeyHeader !== undefined;
	}
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
 * The value each extension-side entry field carries: the sibling registry to
 * OPTIONAL_ENTRY_FIELDS for everything an entry declares BEYOND label,
 * baseUrl, and the flat credential fields. These fields are read
 * extension-side only and must never reach the provider-group args or their
 * fingerprint (buildGroupArgs walks OPTIONAL_ENTRY_FIELDS alone), so unlike
 * that descriptor this registry's order is NOT load-bearing. One table drives
 * the parsed entry type, the sync engine's views, the dashboard's fallback
 * views, and the state push's config, via EntryViewFields and
 * pickEntryViewFields: a field added here rides every copy site by
 * construction, and a field added to only one half of the registry (this
 * table or ENTRY_VIEW_FIELD_SET below) does not compile.
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
