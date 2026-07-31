/**
 * The one descriptor of a litellm-vscode-chat.servers entry's fields, shared
 * by the settings side (the servers setting and its SecretStorage blobs), the
 * sync engine, and the dashboard protocol. Every field list elsewhere - the
 * parser's accepted fields, the provider-group args, the declared views, the
 * dashboard payloads and their schemas - derives from here, so adding a field
 * means extending OPTIONAL_ENTRY_FIELDS and following the compile errors.
 * One deliberate exception: an entry's `modelParameters` record stays out of
 * the descriptor because it must never reach the provider-group args or their
 * fingerprint (see extension/servers/serverSync/setting.ts and engine.ts;
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
