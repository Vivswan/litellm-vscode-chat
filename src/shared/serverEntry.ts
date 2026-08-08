/**
 * The one descriptor of a server entry's flat credential fields, shared by
 * the settings side (the parser flattens the entry's nested `auth` object
 * onto these fields; the SecretStorage blobs key on the secret ids), the
 * sync engine, and the dashboard protocol. Every field list elsewhere - the
 * provider-group args, the declared views, the dashboard payloads and their
 * schemas - derives from here, so adding a field means extending
 * OPTIONAL_ENTRY_FIELDS and following the compile errors.
 * The entry's extension-side-only fields (headers, models.parameters,
 * models.capabilities, discovery.*, budget) stay out of the descriptor
 * because they must never reach the provider-group args or their fingerprint
 * (see extension/servers/serverSync/setting.ts and engine.ts;
 * serverEntry.test.ts pins the schema split). Pure constants: no vscode,
 * no DOM, no Node (the dashboard protocol pulls this module into the
 * webview bundle).
 */

/**
 * The optional fields an entry may carry beyond label and baseUrl, secret
 * ones flagged (inline storage is legal for those; a SecretStorage blob is
 * the alternative). THE ORDER IS LOAD-BEARING: buildGroupArgs emits the
 * provider-group args in this order after name, vendor, and baseUrl, and the
 * sync engine persists a hash of JSON.stringify of that object as the entry's
 * fingerprint, so reordering silently invalidates every stored fingerprint
 * and re-pushes every group. Secrets and non-secrets interleave on purpose;
 * serverSync.test.ts pins the exact sequence.
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
 * The discovery-endpoint failure categories an entry's `expectedFailures`
 * field may list: "modelListing" is GET /models, "modelInfo" is GET
 * /model/info. One list for the dashboard's checkbox set, the setting
 * parser, and the provider's single-attempt/info-severity demotion. Like an
 * entry's `modelParameters`, the field stays out of OPTIONAL_ENTRY_FIELDS:
 * it must never reach the provider-group args or their fingerprint.
 */
export const EXPECTED_FAILURE_CATEGORIES = ["modelListing", "modelInfo"] as const;

/** A discovery failure the user told us to expect on an entry's server. */
export type ExpectedFailureCategory = (typeof EXPECTED_FAILURE_CATEGORIES)[number];

/** The one membership check for the category tokens, shared by the setting parser and the dashboard's form. */
export function isExpectedFailureCategory(value: unknown): value is ExpectedFailureCategory {
	return typeof value === "string" && (EXPECTED_FAILURE_CATEGORIES as readonly string[]).includes(value);
}
