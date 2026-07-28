/**
 * The server form's pure model: the draft the inline Add/Edit server form
 * edits, its validation, and the assembly into the saveServerSetting intent.
 * DOM-free by construction so the extension-host unit suite covers it, and
 * shared across the trust boundary: the webview renders the problems this
 * module computes, and the extension re-validates the assembled payload with
 * the same rules (state.ts) before anything is written.
 */

import type {
	NonSecretOptionalFieldId,
	SaveServerPayload,
	SecretDirective,
	SecretFieldId,
	SecretLocation,
} from "./protocol";
import {
	isUnsafeRecordKey,
	isValidHeaderName,
	isValidHeaderValue,
	NON_SECRET_OPTIONAL_FIELD_IDS,
	SECRET_FIELD_IDS,
} from "./protocol";

/**
 * One secret field as the form edits it. `existing` is where the value lives
 * now ("none" on a fresh form); an empty `value` means keep it there. Typing
 * a value replaces it in the chosen `location`; `clear` removes it outright.
 * `prefill` is set when the field was prefilled with the stored inline value
 * (applyInlinePrefill): a value equal to it saves as "keep", so an untouched
 * prefill never rewrites anything.
 */
export interface SecretFieldDraft {
	readonly value: string;
	readonly location: "settings" | "secure";
	readonly clear: boolean;
	readonly existing: SecretLocation;
	readonly prefill?: string | undefined;
}

/**
 * The whole draft, its field set derived from the entry descriptor: label and
 * base URL, the non-secret optional fields as plain text inputs, and one
 * SecretFieldDraft per secret field.
 */
export type ServerFormDraft = { readonly label: string; readonly baseUrl: string } & Readonly<
	Record<NonSecretOptionalFieldId, string>
> &
	Readonly<Record<SecretFieldId, SecretFieldDraft>>;

const EMPTY_SECRET: SecretFieldDraft = { value: "", location: "secure", clear: false, existing: "none" };

export const EMPTY_SERVER_FORM: ServerFormDraft = {
	label: "",
	baseUrl: "",
	oauthTokenUrl: "",
	oauthClientId: "",
	oauthScopes: "",
	virtualKeyHeader: "",
	apiKey: EMPTY_SECRET,
	oauthClientSecret: EMPTY_SECRET,
	virtualKeyValue: EMPTY_SECRET,
};

export type ServerFormField = keyof ServerFormDraft;

/** The form's fields in render order; problem summaries name the first offender in this order. */
export const SERVER_FORM_FIELD_ORDER: readonly ServerFormField[] = [
	"label",
	"baseUrl",
	"apiKey",
	"oauthTokenUrl",
	"oauthClientId",
	"oauthClientSecret",
	"oauthScopes",
	"virtualKeyHeader",
	"virtualKeyValue",
];

/** Display names for the form's fields, shared by labels and problem summaries. */
export const SERVER_FORM_FIELD_LABELS: Record<ServerFormField, string> = {
	label: "Label",
	baseUrl: "Base URL",
	apiKey: "API key",
	oauthTokenUrl: "OAuth token URL",
	oauthClientId: "OAuth client ID",
	oauthClientSecret: "OAuth client secret",
	oauthScopes: "OAuth scopes",
	virtualKeyHeader: "Virtual key header",
	virtualKeyValue: "Virtual key value",
};

/**
 * The fields rendered inside the collapsible "OAuth and virtual key" section.
 * A problem on any of them must force the section open: a collapsed section
 * hiding the one blocking error would make Save a silent no-op.
 */
export const OAUTH_SECTION_FIELDS: readonly ServerFormField[] = [
	"oauthTokenUrl",
	"oauthClientId",
	"oauthClientSecret",
	"oauthScopes",
	"virtualKeyHeader",
	"virtualKeyValue",
];

/** Problems keyed by the field they belong to; an empty record means the draft is savable. */
export type ServerFormProblems = Partial<Record<ServerFormField, string>>;

/** Whether the text parses as an http(s) URL with a host; the form's and the intent's shared rule. */
export function isUsableHttpUrl(text: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		return false;
	}
	return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
}

/** Whether a secret field will hold a value after this draft is applied. */
function secretWillExist(draft: SecretFieldDraft): boolean {
	if (draft.clear) {
		return false;
	}
	return draft.value.trim().length > 0 || draft.existing !== "none";
}

/** The context a draft is validated against: sibling labels for rename-collision checks. */
export interface ServerFormContext {
	/** Labels of the other declared entries. */
	readonly takenLabels?: readonly string[];
	/** The label of the entry being edited; absent when adding. */
	readonly originalLabel?: string;
}

/**
 * Validate a draft. The messages never repeat an entered value: drafts carry
 * secrets, and the extension surfaces the same messages through logs and the
 * intentFailed notice.
 */
export function validateServerForm(draft: ServerFormDraft, context: ServerFormContext = {}): ServerFormProblems {
	const problems: { -readonly [K in ServerFormField]?: string } = {};
	const label = draft.label.trim();
	if (label.length === 0) {
		problems.label = "Enter a label";
	} else if (isUnsafeRecordKey(label)) {
		problems.label = "This label is a reserved name and cannot be used";
	} else if (
		context.originalLabel !== undefined &&
		label !== context.originalLabel &&
		(context.takenLabels ?? []).includes(label)
	) {
		// Renaming onto a sibling would leave two entries with one identity;
		// the extension refuses it too (adds keep their replace-by-label upsert).
		problems.label = "An entry with this label already exists";
	}
	const baseUrl = draft.baseUrl.trim();
	if (baseUrl.length === 0) {
		problems.baseUrl = "Enter the server URL";
	} else if (!isUsableHttpUrl(baseUrl)) {
		problems.baseUrl = "Must be a usable http(s) URL, e.g. http://localhost:4000";
	}

	// OAuth is one unit: the request path drops partial configurations
	// silently, so a partial one must not save as if it worked.
	const tokenUrl = draft.oauthTokenUrl.trim();
	const clientId = draft.oauthClientId.trim();
	const oauthExtras = secretWillExist(draft.oauthClientSecret) || draft.oauthScopes.trim().length > 0;
	if (tokenUrl.length > 0 && !isUsableHttpUrl(tokenUrl)) {
		problems.oauthTokenUrl = "Must be a usable http(s) URL";
	} else if ((clientId.length > 0 || oauthExtras) && tokenUrl.length === 0) {
		problems.oauthTokenUrl = "OAuth needs the token URL and client ID";
	}
	if ((tokenUrl.length > 0 || oauthExtras) && clientId.length === 0) {
		problems.oauthClientId = "OAuth needs the token URL and client ID";
	}

	// The virtual key is likewise both-or-neither, and must be sendable as an
	// HTTP header: the request path drops anything less without a trace.
	const header = draft.virtualKeyHeader.trim();
	const valueTyped = draft.virtualKeyValue.value.trim();
	if (header.length > 0 && !isValidHeaderName(header)) {
		problems.virtualKeyHeader = "Not a valid HTTP header name";
	} else if (secretWillExist(draft.virtualKeyValue) && header.length === 0) {
		problems.virtualKeyHeader = "Name the header that carries the key";
	}
	if (header.length > 0 && !secretWillExist(draft.virtualKeyValue)) {
		problems.virtualKeyValue = "Enter the key sent in this header";
	} else if (valueTyped.length > 0 && !isValidHeaderValue(valueTyped)) {
		problems.virtualKeyValue = "The value cannot be sent as an HTTP header";
	}
	return problems;
}

export function hasServerFormProblems(problems: ServerFormProblems): boolean {
	return Object.values(problems).some((problem) => problem !== undefined);
}

/**
 * The adopt form's label rule: the same constraints the full form applies,
 * plus a hard collision refusal (adoption always creates a new entry, never
 * replaces one). The extension re-checks the same rules on the intent.
 */
export function validateAdoptLabel(label: string, takenLabels: readonly string[]): string | undefined {
	const trimmed = label.trim();
	if (trimmed.length === 0) {
		return "Enter a label";
	}
	if (isUnsafeRecordKey(trimmed)) {
		return "This label is a reserved name and cannot be used";
	}
	if (takenLabels.includes(trimmed)) {
		return "An entry with this label already exists";
	}
	return undefined;
}

/**
 * What the form does with its own save failure. A validation-kind failure
 * left the setting untouched: the draft is still the truth, so the form
 * returns to editing for a retry. An operation-kind failure means the save
 * committed and only a follow-up effect failed: the draft is stale (after a
 * rename, even the label a resubmit would replace no longer exists), so the
 * form closes and the section-level notice carries the recovery path.
 */
export function saveFailureDisposition(kind: "validation" | "operation"): "edit" | "close" {
	return kind === "operation" ? "close" : "edit";
}

/**
 * The section-level failure notice text. The boundary's validation messages
 * are field-prefixed by design ("label: reserved name"), which behind a
 * generic section prefix reads as a stuttering double colon; a recognized
 * field prefix is therefore promoted to the field's display name and the
 * section prefix dropped. Messages without a field prefix keep the prefix.
 */
export function sectionFailureText(prefix: string, message: string): string {
	const colon = message.indexOf(":");
	const field = colon > 0 ? message.slice(0, colon) : undefined;
	if (field !== undefined && Object.hasOwn(SERVER_FORM_FIELD_LABELS, field)) {
		return `${SERVER_FORM_FIELD_LABELS[field as ServerFormField]}${message.slice(colon)}`;
	}
	return `${prefix} ${message}`;
}

function toDirective(draft: SecretFieldDraft): SecretDirective {
	if (draft.clear) {
		return { action: "clear" };
	}
	const value = draft.value.trim();
	if (value.length === 0) {
		return { action: "keep" };
	}
	if (draft.prefill !== undefined && value === draft.prefill && draft.location === "settings") {
		// The prefilled inline value, unedited and staying inline: nothing to
		// rewrite. A changed value or a storage move (the secure radio) falls
		// through to a real set.
		return { action: "keep" };
	}
	return { action: "set", location: draft.location, value };
}

/**
 * Merge an inlineSecrets response into the draft: each returned value lands
 * in its field's input, marked as the prefill toDirective treats as "keep".
 * Only fields whose storage is inline and that the user has not already typed
 * into or marked for removal are touched, so a slow response never clobbers
 * an edit in progress.
 */
export function applyInlinePrefill(
	draft: ServerFormDraft,
	values: Readonly<Partial<Record<SecretFieldId, string>>>
): ServerFormDraft {
	let next = draft;
	for (const field of SECRET_FIELD_IDS) {
		const value = values[field];
		const current = draft[field];
		if (
			value === undefined ||
			value.length === 0 ||
			current.existing !== "settings" ||
			current.clear ||
			current.value.length > 0
		) {
			continue;
		}
		next = { ...next, [field]: { ...current, value, prefill: value } };
	}
	return next;
}

/** The saveServerSetting intent for a validated draft. Call only when validateServerForm is clean. */
export function assembleServerForm(
	draft: ServerFormDraft,
	replaceLabel?: string
): {
	server: SaveServerPayload;
	secrets: Record<SecretFieldId, SecretDirective>;
	replaceLabel?: string | undefined;
} {
	const server: { label: string; baseUrl: string } & { -readonly [K in NonSecretOptionalFieldId]?: string } = {
		label: draft.label.trim(),
		baseUrl: draft.baseUrl.trim(),
	};
	for (const field of NON_SECRET_OPTIONAL_FIELD_IDS) {
		const value = draft[field].trim();
		if (value.length > 0) {
			server[field] = value;
		}
	}
	const secrets = {} as Record<SecretFieldId, SecretDirective>;
	for (const field of SECRET_FIELD_IDS) {
		secrets[field] = toDirective(draft[field]);
	}
	return {
		server,
		secrets,
		...(replaceLabel !== undefined ? { replaceLabel } : {}),
	};
}
