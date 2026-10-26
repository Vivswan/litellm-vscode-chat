/**
 * The server form's pure model: one parser yields either the assembled saveServerSetting intent or the field problems
 * that block it, so validation and assembly cannot diverge.
 *
 *   DOM-free -> shared across the trust boundary
 */

import * as l10n from "@vscode/l10n";
import type {
	ExpectedFailureCategory,
	McpOptIn,
	NonChatMode,
	NonSecretOptionalFieldId,
	SecretFieldId,
	SecretLocation,
} from "../shared/serverEntry";
import {
	NON_SECRET_OPTIONAL_FIELD_IDS,
	SECRET_FIELD_IDS,
	sameSecretDestination,
	secretDestination,
} from "../shared/serverEntry";
import { canonicalUrl, normalizeBaseUrl } from "../shared/util/baseUrl";
import { parseDecimalText } from "../shared/util/decimalText";
import type { HeaderScalar } from "../shared/util/headers";
import { headerValue, isValidHeaderName, trimHttpWhitespace } from "../shared/util/headers";
import { isUnsafeRecordKey } from "../shared/util/json";
import type { ReplacedEntryIdentity, SaveServerPayload, SecretDirective } from "./endpoints";
import type {
	CapabilityGroupIssues,
	CapabilityGroupsParse,
	GroupHints,
	GroupProblems,
	GroupsParse,
	HeaderRow,
	HeaderRowsParse,
	PrefixGroup,
} from "./recordDraft";
import { draftRowsKey, parseCapabilityGroups, parseGroups, parseHeaderRows } from "./recordDraft";

/**
 * One secret field as the form edits it. `existing` is where the value lives now; an empty `value` means keep it there,
 * typing replaces it in `location`, `clear` removes it outright.
 */
export interface SecretFieldDraft {
	readonly value: string;
	readonly location: "settings" | "secure";
	readonly clear: boolean;
	readonly existing: SecretLocation;
	readonly prefill?: string | undefined;
}

/**
 * Lower-ranked companions ride along where the grammar allows (oauth carries apiKey/virtualKey, apiKey carries
 * virtualKey).
 *
 *   The selector -> IS the exactly-one-form rule
 */
export type AuthFormId = "none" | "apiKey" | "virtualKey" | "oauth";

/**
 * The API version control: three modes so "custom with no text yet" stays representable instead of collapsing into
 * "none". Maps onto the entry's apiVersion: auto writes no key, none writes "", custom writes the trimmed text.
 */
export interface ApiVersionDraft {
	readonly mode: "auto" | "none" | "custom";
	readonly custom: string;
}

/** The edit form's prefill from a stored entry's apiVersion: absent is auto, "" is none, anything else is custom. */
export function apiVersionDraftOf(value: string | undefined): ApiVersionDraft {
	if (value === undefined) {
		return { mode: "auto", custom: "" };
	}
	return value === "" ? { mode: "none", custom: "" } : { mode: "custom", custom: value };
}

/**
 * The MCP control: an opt-in switch plus the optional endpoint URL, kept apart so "opted in, no custom URL yet" stays
 * representable instead of collapsing into "opted out". Maps onto the entry's `mcp`: off writes no key, on with no URL
 * writes `true`, on with a URL writes `{ url }`.
 */
export interface McpDraft {
	readonly enabled: boolean;
	readonly url: string;
}

/** The edit form's prefill from a stored entry's mcp: absent is off, `true` is on, the object form fills the URL. */
export function mcpDraftOf(value: McpOptIn | undefined): McpDraft {
	if (value === undefined) {
		return { enabled: false, url: "" };
	}
	return { enabled: true, url: value === true ? "" : (value.url ?? "") };
}

/** The whole draft, its field set derived from the entry descriptor. */
export type ServerFormDraft = {
	readonly label: string;
	readonly baseUrl: string;
	readonly apiVersion: ApiVersionDraft;
	readonly authForm: AuthFormId;
	readonly headers: readonly HeaderRow[];
	readonly declaredModels: string;
	readonly budget: string;
	readonly mcp: McpDraft;
	readonly modelParameters: readonly PrefixGroup[];
	readonly modelCapabilities: readonly PrefixGroup[];
	readonly expectedFailures: readonly ExpectedFailureCategory[];
	readonly includeModes: readonly NonChatMode[];
} & Readonly<Record<NonSecretOptionalFieldId, string>> &
	Readonly<Record<SecretFieldId, SecretFieldDraft>>;

const EMPTY_SECRET: SecretFieldDraft = { value: "", location: "secure", clear: false, existing: "none" };

export const EMPTY_SERVER_FORM: ServerFormDraft = {
	label: "",
	baseUrl: "",
	apiVersion: { mode: "auto", custom: "" },
	authForm: "none",
	oauthTokenUrl: "",
	oauthClientId: "",
	oauthScopes: "",
	virtualKeyHeader: "",
	apiKey: EMPTY_SECRET,
	oauthClientSecret: EMPTY_SECRET,
	virtualKeyValue: EMPTY_SECRET,
	headers: [],
	declaredModels: "",
	budget: "",
	mcp: { enabled: false, url: "" },
	modelParameters: [],
	modelCapabilities: [],
	expectedFailures: [],
	includeModes: [],
};

export type ServerFormField = keyof ServerFormDraft;

/** The field catalog in render order; thunks, as a module-level string freezes the English before l10n.config runs. */
const SERVER_FORM_FIELDS: Readonly<Record<ServerFormField, () => string>> = {
	label: () => l10n.t("Label"),
	baseUrl: () => l10n.t("Base URL"),
	apiVersion: () => l10n.t("API version"),
	authForm: () => l10n.t("Authentication"),
	apiKey: () => l10n.t("API key"),
	oauthTokenUrl: () => l10n.t("OAuth token URL"),
	oauthClientId: () => l10n.t("OAuth client ID"),
	oauthClientSecret: () => l10n.t("OAuth client secret"),
	oauthScopes: () => l10n.t("OAuth scopes"),
	virtualKeyHeader: () => l10n.t("Virtual key header"),
	virtualKeyValue: () => l10n.t("Virtual key value"),
	modelParameters: () => l10n.t("Model parameters"),
	modelCapabilities: () => l10n.t("Model capabilities"),
	declaredModels: () => l10n.t("Declared models"),
	expectedFailures: () => l10n.t("Expected failures"),
	includeModes: () => l10n.t("Include skipped modes"),
	headers: () => l10n.t("Custom headers"),
	budget: () => l10n.t("Budget"),
	mcp: () => l10n.t("MCP server"),
};

/** The form's fields in render order; problem summaries name the first offender in this order. */
export const SERVER_FORM_FIELD_ORDER = Object.keys(SERVER_FORM_FIELDS) as readonly ServerFormField[];

/** The display name of one form field, shared by labels and problem summaries. */
export function serverFormFieldLabel(field: ServerFormField): string {
	return SERVER_FORM_FIELDS[field]();
}

/** Set equality for the canonical-order token lists: a stored entry keeps its author's order. */
function sameTokenSet(now: readonly string[], baseline: readonly string[]): boolean {
	const set = new Set(now);
	return set.size === baseline.length && baseline.every((token) => set.has(token));
}

/** Problems keyed by the field they belong to; an empty record means the draft is savable. */
export type ServerFormProblems = Partial<Record<ServerFormField, string>>;

/** A switch, not an if: a fourth directive variant then fails to compile instead of comparing by action alone. */
function sameSecretDirective(a: SecretDirective, b: SecretDirective): boolean {
	switch (a.action) {
		case "keep":
		case "clear":
			return a.action === b.action;
		case "set":
			return b.action === "set" && a.location === b.location && a.value === b.value;
	}
}

/**
 * The canonical http(s) spelling of the text (canonicalUrl), or undefined: the form's and the intent's shared rule,
 * and the spelling the form's intents carry so the stale-key question and the save judge the stored text.
 */
function usableHttpUrl(text: string): string | undefined {
	const url = canonicalUrl(text);
	return url !== undefined && (url.startsWith("http://") || url.startsWith("https://")) ? url : undefined;
}

export function isUsableHttpUrl(text: string): boolean {
	return usableHttpUrl(text) !== undefined;
}

/** The base URL Save writes for the text: its canonical http(s) spelling under the identity rule, or undefined. */
function savedBaseUrl(text: string): string | undefined {
	const url = usableHttpUrl(text);
	return url === undefined ? undefined : normalizeBaseUrl(url);
}

/**
 * One secret field parsed once: the directive the save will carry, whether the field still resolves afterwards, and the
 * value the form can see. Validation and assembly read this one derivation, so a field the directive retires can never
 * block Save on its stale input text.
 */
interface SecretParse {
	readonly directive: SecretDirective;
	readonly resolves: boolean;
	readonly visibleValue: string | undefined;
}

/** Whether a secret draft holds nothing after the one credential trim; the field's reveal toggle and keep hint key off this. */
export function secretDraftIsEmpty(value: string): boolean {
	return trimHttpWhitespace(value).length === 0;
}

function parseSecret(draft: SecretFieldDraft): SecretParse {
	if (draft.clear) {
		return { directive: { action: "clear" }, resolves: false, visibleValue: undefined };
	}
	// The one credential trim rule (HTTP whitespace only): a Latin-1 byte at the edge of a key is the key's, and a
	// prefilled stored value with such a byte compares equal to itself below instead of reading as an edit.
	const value = trimHttpWhitespace(draft.value);
	if (value.length === 0) {
		return { directive: { action: "keep" }, resolves: draft.existing !== "none", visibleValue: undefined };
	}
	if (draft.prefill !== undefined && value === draft.prefill && draft.location === "settings") {
		// The prefilled inline value, unedited and staying inline: nothing to rewrite. A changed value or a storage
		// move falls through to a real set.
		return { directive: { action: "keep" }, resolves: true, visibleValue: value };
	}
	return { directive: { action: "set", location: draft.location, value }, resolves: true, visibleValue: value };
}

/**
 * Never "set": a value typed before the form switched away must not land in storage for a shape that does not send it.
 * Clear stays honored, everything else is "keep", and `resolves` still reports a kept stored value - the extension's
 * pairing rules see it too.
 */
function parseInactiveSecret(draft: SecretFieldDraft): SecretParse {
	if (draft.clear) {
		return { directive: { action: "clear" }, resolves: false, visibleValue: undefined };
	}
	return { directive: { action: "keep" }, resolves: draft.existing !== "none", visibleValue: undefined };
}

/** Which credential fields the picked auth form sends. */
interface AuthFormActivity {
	readonly oauth: boolean;
	readonly apiKey: boolean;
	readonly virtualKey: boolean;
}

/**
 * Keyed on the picked selector, NOT on entryUsesSecretField's wire rule, so a stored-but-unsent value can still
 * block a save.
 */
function authFormActivity(authForm: AuthFormId): AuthFormActivity {
	const oauth = authForm === "oauth";
	return { oauth, apiKey: authForm === "apiKey" || oauth, virtualKey: authForm !== "none" };
}

/**
 * The stored secrets the picked form does not send: the webview's orphan rows (warn line plus Remove checkbox) read
 * this, the same activity ring the blocking rules use, so a drift can never make a block unreachable.
 */
export function storedInactiveSecrets(draft: ServerFormDraft): Readonly<Record<SecretFieldId, boolean>> {
	const active = authFormActivity(draft.authForm);
	return {
		apiKey: !active.apiKey && draft.apiKey.existing !== "none",
		oauthClientSecret: !active.oauth && draft.oauthClientSecret.existing !== "none",
		virtualKeyValue: !active.virtualKey && draft.virtualKeyValue.existing !== "none",
	};
}

/**
 * The draft's three secret parses, active or inactive per the picked auth form: the one selection the intent assembly
 * and the changed-field count both read. Spelled out per field (no cast-and-loop): a secret field added to the catalog
 * fails to compile here instead of surfacing at runtime.
 */
function parseSecrets(draft: ServerFormDraft): Record<SecretFieldId, SecretParse> {
	const active = authFormActivity(draft.authForm);
	return {
		apiKey: active.apiKey ? parseSecret(draft.apiKey) : parseInactiveSecret(draft.apiKey),
		oauthClientSecret: active.oauth
			? parseSecret(draft.oauthClientSecret)
			: parseInactiveSecret(draft.oauthClientSecret),
		virtualKeyValue: active.virtualKey
			? parseSecret(draft.virtualKeyValue)
			: parseInactiveSecret(draft.virtualKeyValue),
	};
}

/**
 * The four optional auth texts of the active form: trimmed, and zeroed on any form that does not send them - the same
 * activity selection the secret parses use, so a collapsed form's leftover text never saves and never counts. The
 * token URL gets its saved spelling where Save and the dirty count read it.
 */
function activeOptionalText(draft: ServerFormDraft): Readonly<Record<NonSecretOptionalFieldId, string>> {
	const active = authFormActivity(draft.authForm);
	return {
		oauthTokenUrl: active.oauth ? trimHttpWhitespace(draft.oauthTokenUrl) : "",
		oauthClientId: active.oauth ? trimHttpWhitespace(draft.oauthClientId) : "",
		oauthScopes: active.oauth ? trimHttpWhitespace(draft.oauthScopes) : "",
		virtualKeyHeader: active.virtualKey ? trimHttpWhitespace(draft.virtualKeyHeader) : "",
	};
}

/**
 * The budget text parsed once: empty clears (null), a positive finite number saves, anything else blocks and keeps its
 * trimmed text. Validation, assembly, and the changed-field count all read this one derivation.
 */
type BudgetParse = { readonly ok: true; readonly value: number | null } | { readonly ok: false; readonly text: string };

export function parseBudgetText(text: string): BudgetParse {
	const trimmed = trimHttpWhitespace(text);
	if (trimmed.length === 0) {
		return { ok: true, value: null };
	}
	const value = parseDecimalText(trimmed);
	return value !== undefined && value > 0 ? { ok: true, value } : { ok: false, text: trimmed };
}

function sameBudget(a: BudgetParse, b: BudgetParse): boolean {
	return a.ok ? b.ok && a.value === b.value : !b.ok && a.text === b.text;
}

/**
 * The MCP control parsed once: off clears (null), on with no URL publishes the derived endpoint (true), on with a
 * usable http(s) URL publishes that URL, and anything else blocks while keeping its trimmed text.
 *
 *   The http(s) rule -> is the form's, not the settings parser's: the setting keeps any scheme with a host and
 *                       reports the rest, like `baseUrl`; the guided path refuses one it can see is broken
 */
type McpParse = { readonly ok: true; readonly value: McpOptIn | null } | { readonly ok: false; readonly text: string };

function parseMcpDraft(draft: McpDraft): McpParse {
	if (!draft.enabled) {
		return { ok: true, value: null };
	}
	const url = trimHttpWhitespace(draft.url);
	if (url.length === 0) {
		return { ok: true, value: true };
	}
	const canonical = usableHttpUrl(url);
	return canonical === undefined ? { ok: false, text: url } : { ok: true, value: { url: canonical } };
}

function sameMcp(a: McpParse, b: McpParse): boolean {
	if (!a.ok || !b.ok) {
		return !a.ok && !b.ok && a.text === b.text;
	}
	if (a.value === null || b.value === null || a.value === true || b.value === true) {
		return a.value === b.value;
	}
	return a.value.url === b.value.url;
}

/**
 * Which auth form a saved entry's configuration reads as, for the edit form's initial selector state: oauth when the
 * token URL and client ID pair is configured, else apiKey when a key is stored anywhere, else virtualKey when the
 * pair's header or stored value exists, else none.
 */
export function deriveAuthForm(config: {
	readonly oauthTokenUrl?: string | undefined;
	readonly oauthClientId?: string | undefined;
	readonly virtualKeyHeader?: string | undefined;
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;
}): AuthFormId {
	if (
		trimHttpWhitespace(config.oauthTokenUrl ?? "").length > 0 &&
		trimHttpWhitespace(config.oauthClientId ?? "").length > 0
	) {
		return "oauth";
	}
	if (config.secrets.apiKey !== "none") {
		return "apiKey";
	}
	if (trimHttpWhitespace(config.virtualKeyHeader ?? "").length > 0 || config.secrets.virtualKeyValue !== "none") {
		return "virtualKey";
	}
	return "none";
}

/**
 * The declared-models textarea's reading: one exact ID per line, trimmed, empties dropped, duplicates removed in
 * first-seen order.
 */
export function parseDeclaredModelsText(text: string): string[] {
	return [
		...new Set(
			text
				.split("\n")
				.map((line) => trimHttpWhitespace(line))
				.filter((line) => line.length > 0)
		),
	];
}

/** The two readings a changed-field comparison takes of a draft: its secret parses and its active optional text. */
interface FormReading {
	readonly draft: ServerFormDraft;
	readonly secrets: Readonly<Record<SecretFieldId, SecretParse>>;
	readonly text: Readonly<Record<NonSecretOptionalFieldId, string>>;
}

/** The base URL in its saved spelling where one exists, else the trimmed text. */
function baseUrlForCompare(text: string): string {
	const trimmed = trimHttpWhitespace(text);
	return savedBaseUrl(trimmed) ?? trimmed;
}

/**
 * Save reads the custom text only in custom mode, so another mode's leftover text never counts; a mode switch always
 * does.
 */
function sameApiVersion(now: ApiVersionDraft, was: ApiVersionDraft): boolean {
	if (now.mode !== was.mode) {
		return false;
	}
	return now.mode !== "custom" || trimHttpWhitespace(now.custom) === trimHttpWhitespace(was.custom);
}

/** Whether each field differs between two readings; each entry names the comparison that field needs. */
const FIELD_CHANGED: Readonly<Record<ServerFormField, (now: FormReading, was: FormReading) => boolean>> = {
	label: (now, was) => trimHttpWhitespace(now.draft.label) !== trimHttpWhitespace(was.draft.label),
	baseUrl: (now, was) => baseUrlForCompare(now.draft.baseUrl) !== baseUrlForCompare(was.draft.baseUrl),
	apiVersion: (now, was) => !sameApiVersion(now.draft.apiVersion, was.draft.apiVersion),
	// The selector by raw draft: a switch can leave every secret directive "keep" and every optional text empty,
	// invisible to the parsed comparisons.
	authForm: (now, was) => now.draft.authForm !== was.draft.authForm,
	apiKey: (now, was) => !sameSecretDirective(now.secrets.apiKey.directive, was.secrets.apiKey.directive),
	oauthTokenUrl: (now, was) =>
		(usableHttpUrl(now.text.oauthTokenUrl) ?? now.text.oauthTokenUrl) !==
		(usableHttpUrl(was.text.oauthTokenUrl) ?? was.text.oauthTokenUrl),
	oauthClientId: (now, was) => now.text.oauthClientId !== was.text.oauthClientId,
	oauthClientSecret: (now, was) =>
		!sameSecretDirective(now.secrets.oauthClientSecret.directive, was.secrets.oauthClientSecret.directive),
	oauthScopes: (now, was) => now.text.oauthScopes !== was.text.oauthScopes,
	virtualKeyHeader: (now, was) => now.text.virtualKeyHeader !== was.text.virtualKeyHeader,
	virtualKeyValue: (now, was) =>
		!sameSecretDirective(now.secrets.virtualKeyValue.directive, was.secrets.virtualKeyValue.directive),
	// The row grids by raw draft, since a row can sit mid-edit and unparseable.
	modelParameters: (now, was) => draftRowsKey(now.draft.modelParameters) !== draftRowsKey(was.draft.modelParameters),
	modelCapabilities: (now, was) =>
		draftRowsKey(now.draft.modelCapabilities) !== draftRowsKey(was.draft.modelCapabilities),
	declaredModels: (now, was) =>
		parseDeclaredModelsText(now.draft.declaredModels).join("\n") !==
		parseDeclaredModelsText(was.draft.declaredModels).join("\n"),
	// Sets, not lists: comparing sequences would report a change for a check-then-uncheck round trip (the toggle
	// canonicalizes the order while a stored entry keeps its author's).
	expectedFailures: (now, was) => !sameTokenSet(now.draft.expectedFailures, was.draft.expectedFailures),
	includeModes: (now, was) => !sameTokenSet(now.draft.includeModes, was.draft.includeModes),
	headers: (now, was) => draftRowsKey(now.draft.headers) !== draftRowsKey(was.draft.headers),
	budget: (now, was) => !sameBudget(parseBudgetText(now.draft.budget), parseBudgetText(was.draft.budget)),
	mcp: (now, was) => !sameMcp(parseMcpDraft(now.draft.mcp), parseMcpDraft(was.draft.mcp)),
};

/**
 * The save bar counts these, so a quiet bar under a move the user can see reads as broken, and one that goes quiet
 * on an edit that blocks is worse: text Save would refuse still counts, by its trimmed form.
 */
export function changedServerFormFields(draft: ServerFormDraft, baseline: ServerFormDraft): readonly ServerFormField[] {
	const now: FormReading = { draft, secrets: parseSecrets(draft), text: activeOptionalText(draft) };
	const was: FormReading = { draft: baseline, secrets: parseSecrets(baseline), text: activeOptionalText(baseline) };
	return SERVER_FORM_FIELD_ORDER.filter((field) => FIELD_CHANGED[field](now, was));
}

/**
 * The context a draft is parsed against: sibling labels for rename-collision checks, and the hint evidence. The
 * `replace` identity lets the extension refuse a save or probe when the label's entry no longer matches what the form
 * showed, and the unknown-key suppression is the host's advisory filter, run live.
 */
export interface ServerFormContext {
	/** The labels the other declared entries hold; a rename onto one of them is refused. */
	readonly takenLabels?: readonly string[];

	/** The entry being edited, as the form displayed it; absent when adding. Rides the intents as `replace`. */
	readonly original?: ReplacedEntryIdentity;

	/** The edited entry's observed /model/info keys; absent or empty keeps every unknown-key hint suppressed. */
	readonly observedModelInfoKeys?: readonly string[] | undefined;
}

/** The saveServerSetting intent body a clean draft parses to; the webview adds only the requestId. */
export interface ServerFormIntent {
	readonly server: SaveServerPayload;
	readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
	readonly replace?: ReplacedEntryIdentity | undefined;
}

/**
 * A draft parsed into the saveServerSetting intent, or the problems that block it. The row-aligned fields come from
 * the same parse passes that judged the draft, so they cannot disagree with the summary.
 *
 *   modelCapabilityIssues  -> both arms; advisory hints never block a save but must still render
 *   modelParameterHints    -> both arms; directive semantics and wrong-type notes, never blocking
 *   modelParameterProblems -> blocked arm; empty when the parameter rows are clean and another field blocks
 *   headerProblems         -> blocked arm, like modelParameterProblems; problems.headers holds the summary
 */
export type ServerFormParse =
	| {
			readonly ok: true;
			readonly intent: ServerFormIntent;
			readonly modelCapabilityIssues: readonly CapabilityGroupIssues[];
			readonly modelParameterHints: readonly GroupHints[];
	  }
	| {
			readonly ok: false;
			readonly problems: ServerFormProblems;
			readonly modelParameterProblems: readonly GroupProblems[];
			readonly modelCapabilityIssues: readonly CapabilityGroupIssues[];
			readonly modelParameterHints: readonly GroupHints[];
			readonly headerProblems: readonly (string | undefined)[];
	  };

/** The intent's secret directives, one per field, straight from the analysis' secret parses. */
function secretDirectives(
	secrets: Readonly<Record<SecretFieldId, SecretParse>>
): Record<SecretFieldId, SecretDirective> {
	return {
		apiKey: secrets.apiKey.directive,
		oauthClientSecret: secrets.oauthClientSecret.directive,
		virtualKeyValue: secrets.virtualKeyValue.directive,
	};
}

/** The connection's fields: an edit here clears the draft-test result, and only their problems block the probe. */
export const CONNECTION_FIELDS: readonly ServerFormField[] = [
	"baseUrl",
	"apiVersion",
	"authForm",
	"apiKey",
	"oauthTokenUrl",
	"oauthClientId",
	"oauthClientSecret",
	"oauthScopes",
	"virtualKeyHeader",
	"virtualKeyValue",
	"headers",
];

/** The values the draft-connection probe sends; the save adds the save-only fields (ServerFormValues). */
interface ServerConnectionValues {
	/** The draft's trimmed label, possibly empty or reserved (only the save blocks on that). */
	readonly label: string;

	/** The canonical http(s) spelling under the identity rule (savedBaseUrl); the probe and the save both send it. */
	readonly baseUrl: string;

	/** The entry apiVersion the draft means: undefined for auto, "" for none, the trimmed text for custom. */
	readonly apiVersion: string | undefined;

	/** One directive per secret field, per the picked auth form; an inactive field keeps or clears, never sets. */
	readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;

	/** The active auth form's non-empty text fields, ready to spread into the payload. */
	readonly optionalText: Readonly<Partial<Record<NonSecretOptionalFieldId, string>>>;

	/** The parsed custom headers; a connection field, so a clean connection implies clean header rows. */
	readonly headers: Record<string, HeaderScalar>;

	/** The parsed capability rows when clean, else `{}`: the probe carries what it can (not a connection field). */
	readonly modelCapabilities: Record<string, Record<string, unknown>>;
}

/** What a fully clean draft assembles to: the connection values plus the save-only fields. */
interface ServerFormValues extends ServerConnectionValues {
	readonly modelParameters: Record<string, Record<string, unknown>>;
	readonly budget: number | null;
	readonly mcp: McpOptIn | null;
}

/**
 * The one shared analysis behind both parsers, discriminated so each consumer reads its arm instead of re-deriving it:
 * a clean draft IS its assembled values, a blocked one carries the problems - with the connection slice discriminated
 * again inside it, because the probe blocks only on CONNECTION_FIELDS problems (the fields whose edit also clears a
 * draft-test result: a stale PASS on edited credentials is worse than none). The save and probe rules cannot drift
 * because both read this one result.
 */
type ServerFormAnalysis = {
	/** Row-aligned capability issues from the parse that judged the draft; hints render on both arms. */
	readonly modelCapabilityIssues: readonly CapabilityGroupIssues[];

	/** Row-aligned model-parameter hints (directive semantics and wrong-type notes); never blocking. */
	readonly modelParameterHints: readonly GroupHints[];
} & (
	| { readonly blocked: false; readonly values: ServerFormValues }
	| {
			readonly blocked: true;
			readonly problems: ServerFormProblems;
			readonly modelParameterProblems: readonly GroupProblems[];
			readonly headerProblems: readonly (string | undefined)[];
			readonly connection:
				| { readonly blocked: false; readonly values: ServerConnectionValues }
				| { readonly blocked: true; readonly problems: ServerFormProblems };
	  }
);

/** The label's problem: empty, a reserved name, or a rename onto a sibling (two entries with one identity). */
function labelProblems(label: string, context: ServerFormContext): ServerFormProblems {
	if (label.length === 0) {
		return { label: l10n.t("Enter a label") };
	}
	if (isUnsafeRecordKey(label)) {
		return { label: l10n.t("This label is a reserved name and cannot be used") };
	}
	// The extension refuses the collision too (adds keep their replace-by-label upsert).
	if (
		context.original !== undefined &&
		label !== context.original.label &&
		(context.takenLabels ?? []).includes(label)
	) {
		return { label: l10n.t("An entry with this label already exists") };
	}
	return {};
}

/** The base URL's problem: empty, or no usable http(s) spelling (`saved` is savedBaseUrl's reading of the text). */
function baseUrlProblems(text: string, saved: string | undefined): ServerFormProblems {
	if (text.length === 0) {
		return { baseUrl: l10n.t("Enter the server URL") };
	}
	if (saved === undefined) {
		return { baseUrl: l10n.t("Must be a usable http(s) URL, e.g. http://localhost:4000") };
	}
	return {};
}

/** The entry apiVersion a draft means (undefined: auto, "": none, trimmed text: custom), or its problem. */
interface ApiVersionParse {
	readonly value: string | undefined;
	readonly problems: ServerFormProblems;
}

/**
 * Custom text must exist, or a picked "custom" would silently save as "none". Slashes and inner whitespace are named
 * problems, not silently rewritten: "/v2" appended verbatim builds http://host//v2.
 */
function parseApiVersionDraft(draft: ApiVersionDraft): ApiVersionParse {
	if (draft.mode === "auto") {
		return { value: undefined, problems: {} };
	}
	if (draft.mode === "none") {
		return { value: "", problems: {} };
	}
	const custom = trimHttpWhitespace(draft.custom);
	if (custom.length === 0) {
		return { value: undefined, problems: { apiVersion: l10n.t("Enter the version segment, e.g. v2") } };
	}
	if (custom.includes("/") || /\s/.test(custom)) {
		return { value: undefined, problems: { apiVersion: l10n.t("Just the segment, no slashes or spaces - e.g. v2") } };
	}
	return { value: custom, problems: {} };
}

/** The auth form's activity, secret parses, and active optional text: the one reading every credential rule takes. */
interface CredentialReading {
	readonly active: AuthFormActivity;
	readonly secrets: Readonly<Record<SecretFieldId, SecretParse>>;
	readonly text: Readonly<Record<NonSecretOptionalFieldId, string>>;
}

/**
 * OAuth is one unit: the request path drops partial configurations silently, so a partial one must not save as if it
 * worked. On any other form a KEPT stored client secret still blocks - the extension reads it as OAuth-shaped.
 */
function oauthProblems({ active, secrets, text }: CredentialReading): ServerFormProblems {
	if (!active.oauth) {
		if (secrets.oauthClientSecret.resolves) {
			return {
				oauthClientSecret: l10n.t(
					"A stored OAuth client secret is still attached; remove it with its checkbox, or switch the form to OAuth"
				),
			};
		}
		return {};
	}
	const problems: ServerFormProblems = {};
	const tokenUrl = text.oauthTokenUrl;
	const clientId = text.oauthClientId;
	const oauthExtras = secrets.oauthClientSecret.resolves || text.oauthScopes.length > 0;
	if (tokenUrl.length > 0 && !isUsableHttpUrl(tokenUrl)) {
		problems.oauthTokenUrl = l10n.t("Must be a usable http(s) URL");
	} else if ((clientId.length > 0 || oauthExtras) && tokenUrl.length === 0) {
		problems.oauthTokenUrl = l10n.t("OAuth needs the token URL and client ID");
	}
	if ((tokenUrl.length > 0 || oauthExtras) && clientId.length === 0) {
		problems.oauthClientId = l10n.t("OAuth needs the token URL and client ID");
	}
	return problems;
}

/**
 * On a form that does not send the key, a kept stored key blocks: storage counts as part of the shape
 * (docs/servers.md#secrets-and-secret-storage), so saving would no-op and snap back on reopen. Otherwise a newly
 * entered key the platform's Headers would refuse does not save: the request path would read it as keyless, so the
 * form says so beside the field (a kept stored key is not visible here; the Diagnostics tab reports that one). Edge
 * whitespace is tolerated (trimmed on the way out), an interior control character is not.
 */
function apiKeyProblems({ active, secrets }: CredentialReading): ServerFormProblems {
	if (!active.apiKey && secrets.apiKey.resolves) {
		return {
			apiKey: l10n.t("A stored API key is still attached; remove it with its checkbox, or pick a form that sends it"),
		};
	}
	if (secrets.apiKey.visibleValue !== undefined && headerValue(secrets.apiKey.visibleValue) === undefined) {
		return { apiKey: l10n.t("The value cannot be sent as an HTTP header") };
	}
	return {};
}

/**
 * Both-or-neither like OAuth, and must be sendable as an HTTP header: the request path drops a value it cannot send
 * and reports that drop on the Diagnostics tab, while a missing value shows as a missing secret. The sendability check
 * reads the parsed visible value, so a cleared field's stale text cannot block; on "none" a kept stored value blocks
 * like the client secret.
 */
function virtualKeyProblems({ active, secrets, text }: CredentialReading): ServerFormProblems {
	const virtualKey = secrets.virtualKeyValue;
	if (!active.virtualKey) {
		if (virtualKey.resolves) {
			return {
				virtualKeyValue: l10n.t(
					"A stored virtual key value is still attached; remove it with its checkbox, or pick a form that sends it"
				),
			};
		}
		return {};
	}
	const problems: ServerFormProblems = {};
	const header = text.virtualKeyHeader;
	if (header.length > 0 && !isValidHeaderName(header)) {
		problems.virtualKeyHeader = l10n.t("Not a valid HTTP header name");
	} else if (virtualKey.resolves && header.length === 0) {
		problems.virtualKeyHeader = l10n.t("Name the header that carries the key");
	}
	if (header.length > 0 && !virtualKey.resolves) {
		problems.virtualKeyValue = l10n.t("Enter the key sent in this header");
	} else if (virtualKey.visibleValue !== undefined && headerValue(virtualKey.visibleValue) === undefined) {
		problems.virtualKeyValue = l10n.t("The value cannot be sent as an HTTP header");
	}
	return problems;
}

/** The record rows', header rows', budget's, and MCP control's parses: one derivation each for rules and assembly. */
interface ValueParses {
	readonly groups: GroupsParse;
	readonly capabilities: CapabilityGroupsParse;
	readonly headers: HeaderRowsParse;
	readonly budget: BudgetParse;
	readonly mcp: McpParse;
}

/**
 * Each parsed value's summary problem; the row grids' row-aligned detail rides on the parses themselves. The budget
 * must be empty (none) or a finite number greater than zero, the rule the extension re-checks; the MCP URL, when on
 * and given, must be a usable http(s) URL.
 */
function valueProblems(parses: ValueParses): ServerFormProblems {
	const problems: ServerFormProblems = {};
	if (!parses.groups.ok) {
		problems.modelParameters = l10n.t("Fix the model parameter rows");
	}
	if (!parses.capabilities.ok) {
		problems.modelCapabilities = l10n.t("Fix the model capability rows");
	}
	if (!parses.headers.ok) {
		problems.headers = l10n.t("Fix the header rows");
	}
	if (!parses.budget.ok) {
		problems.budget = l10n.t("Must be a number greater than 0");
	}
	if (!parses.mcp.ok) {
		problems.mcp = l10n.t("Must be a usable http(s) URL");
	}
	return problems;
}

/**
 * Only the active form's text fields reach the payload: an inactive form's leftover text is excluded exactly like an
 * empty input. The token URL goes in its canonical spelling (it validated already, so one exists).
 */
function payloadOptionalText(
	text: Readonly<Record<NonSecretOptionalFieldId, string>>
): Readonly<Partial<Record<NonSecretOptionalFieldId, string>>> {
	const optionalText: { -readonly [K in NonSecretOptionalFieldId]?: string } = {};
	for (const field of NON_SECRET_OPTIONAL_FIELD_IDS) {
		const value = field === "oauthTokenUrl" ? (usableHttpUrl(text[field]) ?? text[field]) : text[field];
		if (value.length > 0) {
			optionalText[field] = value;
		}
	}
	return optionalText;
}

/** The connection half of the assembled values, before the row grids and the save-only fields join. */
interface ConnectionFacts {
	readonly label: string;
	readonly baseUrl: string | undefined;
	readonly apiVersion: string | undefined;
	readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
	readonly optionalText: Readonly<Partial<Record<NonSecretOptionalFieldId, string>>>;
}

/** The problems on CONNECTION_FIELDS alone: what blocks the draft-connection probe. */
function connectionProblemsOf(problems: ServerFormProblems): ServerFormProblems {
	const connectionProblems: ServerFormProblems = {};
	for (const field of CONNECTION_FIELDS) {
		const problem = problems[field];
		if (problem !== undefined) {
			connectionProblems[field] = problem;
		}
	}
	return connectionProblems;
}

/**
 * The blocked arm, its connection slice discriminated again. headers is a connection field, so a clean connection
 * implies clean header rows; the narrowing states the half the type system cannot see.
 */
function blockedAnalysis(
	parses: ValueParses,
	problems: ServerFormProblems,
	facts: ConnectionFacts
): ServerFormAnalysis {
	const connectionProblems = connectionProblemsOf(problems);
	const connection =
		parses.headers.ok &&
		facts.baseUrl !== undefined &&
		!Object.values(connectionProblems).some((problem) => problem !== undefined)
			? {
					blocked: false as const,
					values: {
						...facts,
						baseUrl: facts.baseUrl,
						headers: parses.headers.value,
						modelCapabilities: parses.capabilities.ok ? parses.capabilities.value : {},
					},
				}
			: { blocked: true as const, problems: connectionProblems };
	return {
		blocked: true,
		problems,
		modelParameterProblems: parses.groups.ok ? [] : parses.groups.problems,
		headerProblems: parses.headers.ok ? [] : parses.headers.problems,
		connection,
		modelCapabilityIssues: parses.capabilities.issues,
		modelParameterHints: parses.groups.hints,
	};
}

function analyzeServerForm(draft: ServerFormDraft, context: ServerFormContext): ServerFormAnalysis {
	// The selector decides which credential fields are live: everything else is excluded from the payload and demoted
	// to keep/clear directives. Validation and assembly both read this one reading.
	const reading: CredentialReading = {
		active: authFormActivity(draft.authForm),
		secrets: parseSecrets(draft),
		text: activeOptionalText(draft),
	};
	const label = trimHttpWhitespace(draft.label);
	const baseUrlText = trimHttpWhitespace(draft.baseUrl);
	const baseUrl = savedBaseUrl(baseUrlText);
	const apiVersion = parseApiVersionDraft(draft.apiVersion);
	const parses: ValueParses = {
		groups: parseGroups(draft.modelParameters),
		capabilities: parseCapabilityGroups(
			draft.modelCapabilities,
			context.observedModelInfoKeys === undefined ? undefined : new Set(context.observedModelInfoKeys)
		),
		headers: parseHeaderRows(draft.headers),
		budget: parseBudgetText(draft.budget),
		mcp: parseMcpDraft(draft.mcp),
	};

	const problems: ServerFormProblems = {
		...labelProblems(label, context),
		...baseUrlProblems(baseUrlText, baseUrl),
		...apiVersion.problems,
		...oauthProblems(reading),
		...apiKeyProblems(reading),
		...virtualKeyProblems(reading),
		...valueProblems(parses),
	};
	const facts: ConnectionFacts = {
		label,
		baseUrl,
		apiVersion: apiVersion.value,
		secrets: secretDirectives(reading.secrets),
		optionalText: payloadOptionalText(reading.text),
	};

	if (
		parses.groups.ok &&
		parses.capabilities.ok &&
		parses.headers.ok &&
		parses.budget.ok &&
		parses.mcp.ok &&
		baseUrl !== undefined &&
		!Object.values(problems).some((problem) => problem !== undefined)
	) {
		return {
			blocked: false,
			values: {
				...facts,
				baseUrl,
				headers: parses.headers.value,
				modelCapabilities: parses.capabilities.value,
				modelParameters: parses.groups.value,
				budget: parses.budget.value,
				mcp: parses.mcp.value,
			},
			modelCapabilityIssues: parses.capabilities.issues,
			modelParameterHints: parses.groups.hints,
		};
	}
	return blockedAnalysis(parses, problems, facts);
}

/**
 * Parse a draft into the saveServerSetting intent, or the problems that block it; there is no separate validation pass
 * to drift from the assembly.
 *
 *   drafts carry secrets -> The problem messages never repeat an entered value
 */
export function parseServerForm(draft: ServerFormDraft, context: ServerFormContext = {}): ServerFormParse {
	const analysis = analyzeServerForm(draft, context);
	if (analysis.blocked) {
		return {
			ok: false,
			problems: analysis.problems,
			modelParameterProblems: analysis.modelParameterProblems,
			modelCapabilityIssues: analysis.modelCapabilityIssues,
			modelParameterHints: analysis.modelParameterHints,
			headerProblems: analysis.headerProblems,
		};
	}
	const { values } = analysis;
	// The record and list fields are always sent, even empty (the payload requires them); modelParameters is the one
	// optional field.
	const server: SaveServerPayload = {
		label: values.label,
		baseUrl: values.baseUrl,
		...(values.apiVersion === undefined ? {} : { apiVersion: values.apiVersion }),
		...values.optionalText,
		...(Object.keys(values.modelParameters).length > 0 ? { modelParameters: values.modelParameters } : {}),
		modelCapabilities: values.modelCapabilities,
		expectedFailures: draft.expectedFailures,
		headers: values.headers,
		declaredModels: parseDeclaredModelsText(draft.declaredModels),
		includeModes: draft.includeModes,
		budget: values.budget,
		mcp: values.mcp,
	};
	return {
		ok: true,
		intent: {
			server,
			secrets: values.secrets,
			...(context.original === undefined ? {} : { replace: context.original }),
		},
		modelCapabilityIssues: analysis.modelCapabilityIssues,
		modelParameterHints: analysis.modelParameterHints,
	};
}

/**
 * Judged by shared/serverEntry.ts secretDestination, never a webview re-derivation, so the question matches the
 * stamps the host wrote. "secure" means the stamp matched the displayed entry or predates stamping, which the host
 * re-stamps the same way.
 *
 *   kept stored secret, destination moved -> the save flow asks first; keeping re-stamps host-side, clearing deletes
 *   inline value                          -> no question
 *   it has no stamp and already sits in settings.json
 *                                         -> no question
 */
export function staleKeyFieldsOnSave(intent: ServerFormIntent): readonly SecretFieldId[] {
	const original = intent.replace;
	if (original === undefined) {
		return [];
	}
	return SECRET_FIELD_IDS.filter(
		(field) =>
			intent.secrets[field].action === "keep" &&
			original.secrets[field] === "secure" &&
			!sameSecretDestination(secretDestination(intent.server, field), secretDestination(original, field))
	);
}

/** The testServerDraft intent body a connection-clean draft parses to; the webview adds only the requestId. */
interface ServerTestIntent {
	readonly server: SaveServerPayload;
	readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
	readonly replace?: ReplacedEntryIdentity | undefined;
}

export type ServerTestParse =
	| { readonly ok: true; readonly intent: ServerTestIntent }
	| { readonly ok: false; readonly problems: ServerFormProblems };

/**
 * Broken header rows block (the probe sends them); label, record-row, and budget problems do not.
 *
 *   the label addresses "keep" resolution extension-side -> keeps the draft's real trimmed label
 */
export function parseServerFormForTest(draft: ServerFormDraft, context: ServerFormContext = {}): ServerTestParse {
	const analysis = analyzeServerForm(draft, context);
	const connection = analysis.blocked ? analysis.connection : { blocked: false as const, values: analysis.values };
	if (connection.blocked) {
		return { ok: false, problems: connection.problems };
	}
	const { values } = connection;
	const server: SaveServerPayload = {
		label: values.label,
		baseUrl: values.baseUrl,
		...(values.apiVersion === undefined ? {} : { apiVersion: values.apiVersion }),
		...values.optionalText,
		modelCapabilities: values.modelCapabilities,
		expectedFailures: draft.expectedFailures,
		headers: values.headers,
		declaredModels: parseDeclaredModelsText(draft.declaredModels),
		includeModes: draft.includeModes,
		budget: null,
		mcp: null,
	};
	return {
		ok: true,
		intent: {
			server,
			secrets: values.secrets,
			...(context.original === undefined ? {} : { replace: context.original }),
		},
	};
}

/**
 * The adopt form's label rule: the full form's constraints plus a hard collision refusal (adoption always creates a new
 * entry, never replaces one). The extension re-checks the same rules on the intent.
 */
export function validateAdoptLabel(label: string, takenLabels: readonly string[]): string | undefined {
	const trimmed = trimHttpWhitespace(label);
	if (trimmed.length === 0) {
		return l10n.t("Enter a label");
	}
	if (isUnsafeRecordKey(trimmed)) {
		return l10n.t("This label is a reserved name and cannot be used");
	}
	if (takenLabels.includes(trimmed)) {
		return l10n.t("An entry with this label already exists");
	}
	return undefined;
}

/**
 *   a validation-kind failure -> left the setting untouched (the draft is still the truth, return to editing)
 */
export function saveFailureDisposition(kind: "validation" | "operation"): "edit" | "close" {
	return kind === "operation" ? "close" : "edit";
}

/**
 * The section-level failure notice text. A recognized field prefix in the message ("label: ...") is promoted to the
 * field's display name and the section prefix dropped, avoiding a stuttering double prefix.
 */
export function sectionFailureText(prefix: string, message: string): string {
	const colon = message.indexOf(":");
	const prefixText = colon > 0 ? message.slice(0, colon) : undefined;
	const field = SERVER_FORM_FIELD_ORDER.find((candidate) => candidate === prefixText);
	if (field !== undefined) {
		return `${serverFormFieldLabel(field)}${message.slice(colon)}`;
	}
	return `${prefix} ${message}`;
}

/**
 * Merge an inlineSecrets response into the draft, marked as the prefill parseSecret treats as "keep". Only
 * inline-stored fields the user has not typed into or marked for removal are touched, so a slow response never clobbers
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
