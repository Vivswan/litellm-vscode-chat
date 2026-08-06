/**
 * The server form's pure model: the draft the inline Add/Edit server form
 * edits and its parse into the saveServerSetting intent. One parser does both
 * jobs - it either yields the assembled intent body or the field problems that
 * block it - so validation and assembly cannot diverge. DOM-free by
 * construction so the extension-host unit suite covers it, and shared across
 * the trust boundary: the webview renders the problems this module computes,
 * and the extension re-validates the assembled payload with the same rules
 * (intents.ts) before anything is written.
 */

import * as l10n from "@vscode/l10n";
import type {
	ExpectedFailureCategory,
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
import type { CapabilityGroupIssues, GroupHints, GroupProblems, PrefixGroup } from "./recordDraft";
import { parseCapabilityGroups, parseGroups } from "./recordDraft";

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
 * base URL, the non-secret optional fields as plain text inputs, one
 * SecretFieldDraft per secret field, the entry's per-entry modelParameters
 * and modelCapabilities as the same draft rows the record editors edit, and
 * the expected-failure categories as the checkbox set's list.
 */
export type ServerFormDraft = {
	readonly label: string;
	readonly baseUrl: string;
	readonly modelParameters: readonly PrefixGroup[];
	readonly modelCapabilities: readonly PrefixGroup[];
	readonly expectedFailures: readonly ExpectedFailureCategory[];
} & Readonly<Record<NonSecretOptionalFieldId, string>> &
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
	modelParameters: [],
	modelCapabilities: [],
	expectedFailures: [],
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
	"modelParameters",
	"modelCapabilities",
	"expectedFailures",
];

/**
 * The display name of one form field, shared by labels and problem summaries.
 * A function, not a module-level catalog: the names localize, and a constant
 * record would freeze the English text before l10n.config runs.
 */
export function serverFormFieldLabel(field: ServerFormField): string {
	switch (field) {
		case "label":
			return l10n.t("Label");
		case "baseUrl":
			return l10n.t("Base URL");
		case "apiKey":
			return l10n.t("API key");
		case "oauthTokenUrl":
			return l10n.t("OAuth token URL");
		case "oauthClientId":
			return l10n.t("OAuth client ID");
		case "oauthClientSecret":
			return l10n.t("OAuth client secret");
		case "oauthScopes":
			return l10n.t("OAuth scopes");
		case "virtualKeyHeader":
			return l10n.t("Virtual key header");
		case "virtualKeyValue":
			return l10n.t("Virtual key value");
		case "modelParameters":
			return l10n.t("Model parameters");
		case "modelCapabilities":
			return l10n.t("Model capabilities");
		case "expectedFailures":
			return l10n.t("Expected failures");
	}
}

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

/**
 * One secret field parsed once: the protocol directive the save will carry,
 * whether the field still resolves to a value afterwards, and the value that
 * will be in effect when the form can see it (a typed value or an unedited
 * prefill; nothing for cleared fields or values resting in storage). Both the
 * validation rules and the assembled intent read this one derivation, so a
 * field the directive says is going away can never block Save on its stale
 * input text.
 */
interface SecretParse {
	readonly directive: SecretDirective;
	readonly resolves: boolean;
	readonly visibleValue: string | undefined;
}

function parseSecret(draft: SecretFieldDraft): SecretParse {
	if (draft.clear) {
		return { directive: { action: "clear" }, resolves: false, visibleValue: undefined };
	}
	const value = draft.value.trim();
	if (value.length === 0) {
		return { directive: { action: "keep" }, resolves: draft.existing !== "none", visibleValue: undefined };
	}
	if (draft.prefill !== undefined && value === draft.prefill && draft.location === "settings") {
		// The prefilled inline value, unedited and staying inline: nothing to
		// rewrite. A changed value or a storage move (the secure radio) falls
		// through to a real set.
		return { directive: { action: "keep" }, resolves: true, visibleValue: value };
	}
	return { directive: { action: "set", location: draft.location, value }, resolves: true, visibleValue: value };
}

/** The context a draft is parsed against: sibling labels for rename-collision checks. */
export interface ServerFormContext {
	/** Labels of the other declared entries. */
	readonly takenLabels?: readonly string[];
	/** The label of the entry being edited; absent when adding. Doubles as the intent's replaceLabel. */
	readonly originalLabel?: string;
}

/** The saveServerSetting intent body a clean draft parses to; the webview adds only the requestId. */
export interface ServerFormIntent {
	readonly server: SaveServerPayload;
	readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
	readonly replaceLabel?: string | undefined;
}

export type ServerFormParse =
	| {
			readonly ok: true;
			readonly intent: ServerFormIntent;
			/**
			 * Row-aligned capability issues from the same parseCapabilityGroups
			 * pass that assembled the intent. Non-empty even on a clean parse:
			 * unknown-key hints never block a save but must still render.
			 */
			readonly modelCapabilityIssues: readonly CapabilityGroupIssues[];
			/** Row-aligned model-parameter hints (the _force semantic warnings); non-blocking, like the capability issues. */
			readonly modelParameterHints: readonly GroupHints[];
	  }
	| {
			readonly ok: false;
			readonly problems: ServerFormProblems;
			/**
			 * Row-aligned problems for the model-parameters rows, from the same
			 * parseGroups pass that judged the draft; empty when those rows are
			 * clean and some other field blocks. problems.modelParameters carries
			 * the field-level summary for the save toolbar.
			 */
			readonly modelParameterProblems: readonly GroupProblems[];
			/** Row-aligned capability issues; see the ok branch. */
			readonly modelCapabilityIssues: readonly CapabilityGroupIssues[];
			/** Row-aligned model-parameter hints; see the ok branch. */
			readonly modelParameterHints: readonly GroupHints[];
	  };

/**
 * Parse a draft into the saveServerSetting intent it assembles to, or the
 * problems that block it; there is no separate validation pass to drift from
 * the assembly. The problem messages never repeat an entered value: drafts
 * carry secrets, and the extension surfaces the same messages through logs
 * and the intentFailed notice.
 */
export function parseServerForm(draft: ServerFormDraft, context: ServerFormContext = {}): ServerFormParse {
	// Spelled out per field (no cast-and-loop): a secret field added to the
	// catalog fails to compile here instead of surfacing at runtime.
	const secrets: Record<SecretFieldId, SecretParse> = {
		apiKey: parseSecret(draft.apiKey),
		oauthClientSecret: parseSecret(draft.oauthClientSecret),
		virtualKeyValue: parseSecret(draft.virtualKeyValue),
	};

	const problems: { -readonly [K in ServerFormField]?: string } = {};
	const label = draft.label.trim();
	if (label.length === 0) {
		problems.label = l10n.t("Enter a label");
	} else if (isUnsafeRecordKey(label)) {
		problems.label = l10n.t("This label is a reserved name and cannot be used");
	} else if (
		context.originalLabel !== undefined &&
		label !== context.originalLabel &&
		(context.takenLabels ?? []).includes(label)
	) {
		// Renaming onto a sibling would leave two entries with one identity;
		// the extension refuses it too (adds keep their replace-by-label upsert).
		problems.label = l10n.t("An entry with this label already exists");
	}
	const baseUrl = draft.baseUrl.trim();
	if (baseUrl.length === 0) {
		problems.baseUrl = l10n.t("Enter the server URL");
	} else if (!isUsableHttpUrl(baseUrl)) {
		problems.baseUrl = l10n.t("Must be a usable http(s) URL, e.g. http://localhost:4000");
	}

	// OAuth is one unit: the request path drops partial configurations
	// silently, so a partial one must not save as if it worked.
	const tokenUrl = draft.oauthTokenUrl.trim();
	const clientId = draft.oauthClientId.trim();
	const oauthExtras = secrets.oauthClientSecret.resolves || draft.oauthScopes.trim().length > 0;
	if (tokenUrl.length > 0 && !isUsableHttpUrl(tokenUrl)) {
		problems.oauthTokenUrl = l10n.t("Must be a usable http(s) URL");
	} else if ((clientId.length > 0 || oauthExtras) && tokenUrl.length === 0) {
		problems.oauthTokenUrl = l10n.t("OAuth needs the token URL and client ID");
	}
	if ((tokenUrl.length > 0 || oauthExtras) && clientId.length === 0) {
		problems.oauthClientId = l10n.t("OAuth needs the token URL and client ID");
	}

	// The virtual key is likewise both-or-neither, and must be sendable as an
	// HTTP header: the request path drops anything less without a trace. The
	// sendability check reads the parsed visible value, not the raw input, so
	// a cleared field's stale text (sitting in a disabled input) cannot block.
	const header = draft.virtualKeyHeader.trim();
	const virtualKey = secrets.virtualKeyValue;
	if (header.length > 0 && !isValidHeaderName(header)) {
		problems.virtualKeyHeader = l10n.t("Not a valid HTTP header name");
	} else if (virtualKey.resolves && header.length === 0) {
		problems.virtualKeyHeader = l10n.t("Name the header that carries the key");
	}
	if (header.length > 0 && !virtualKey.resolves) {
		problems.virtualKeyValue = l10n.t("Enter the key sent in this header");
	} else if (virtualKey.visibleValue !== undefined && !isValidHeaderValue(virtualKey.visibleValue)) {
		problems.virtualKeyValue = l10n.t("The value cannot be sent as an HTTP header");
	}

	// The per-entry model-parameter rows share the global editor's parse, so a
	// draft that renders clean there is exactly a draft that saves here; the
	// rows carry their own problems and the field slot holds the summary. The
	// capability rows follow the same pattern with their own parser (typed
	// vocabulary instead of free JSON).
	const groupsParse = parseGroups(draft.modelParameters);
	if (!groupsParse.ok) {
		problems.modelParameters = l10n.t("Fix the model parameter rows");
	}
	const capabilitiesParse = parseCapabilityGroups(draft.modelCapabilities);
	if (!capabilitiesParse.ok) {
		problems.modelCapabilities = l10n.t("Fix the model capability rows");
	}

	if (Object.values(problems).some((problem) => problem !== undefined)) {
		return {
			ok: false,
			problems,
			modelParameterProblems: groupsParse.ok ? [] : groupsParse.problems,
			modelCapabilityIssues: capabilitiesParse.issues,
			modelParameterHints: groupsParse.hints,
		};
	}

	const server: {
		label: string;
		baseUrl: string;
		modelParameters?: Record<string, Record<string, unknown>>;
		modelCapabilities?: Record<string, Record<string, unknown>>;
		expectedFailures?: readonly ExpectedFailureCategory[];
	} & {
		-readonly [K in NonSecretOptionalFieldId]?: string;
	} = {
		label,
		baseUrl,
	};
	for (const field of NON_SECRET_OPTIONAL_FIELD_IDS) {
		const value = draft[field].trim();
		if (value.length > 0) {
			server[field] = value;
		}
	}
	// groupsParse.ok always holds here (a blocked parse returned above); the
	// guard is the narrowing. Same for capabilitiesParse below.
	if (groupsParse.ok && Object.keys(groupsParse.value).length > 0) {
		server.modelParameters = groupsParse.value;
	}
	// Always present, even empty: the save distinguishes a deliberate clear
	// (empty here) from a payload that predates these fields (absent), which
	// carries the stored values forward instead of deleting them.
	if (capabilitiesParse.ok) {
		server.modelCapabilities = capabilitiesParse.value;
	}
	server.expectedFailures = draft.expectedFailures;
	const directives: Record<SecretFieldId, SecretDirective> = {
		apiKey: secrets.apiKey.directive,
		oauthClientSecret: secrets.oauthClientSecret.directive,
		virtualKeyValue: secrets.virtualKeyValue.directive,
	};
	return {
		ok: true,
		intent: {
			server,
			secrets: directives,
			...(context.originalLabel !== undefined ? { replaceLabel: context.originalLabel } : {}),
		},
		modelCapabilityIssues: capabilitiesParse.issues,
		modelParameterHints: groupsParse.hints,
	};
}

/**
 * The fields whose edit invalidates a draft-connection test result: the base
 * URL, every credential input (value, storage choice, or remove mark), and
 * the OAuth text fields. A stale PASS on edited credentials is worse than no
 * result, so the form clears the result when any of these change; the label
 * and the model-parameter rows do not touch the connection and keep it.
 */
export const CONNECTION_FIELDS: readonly ServerFormField[] = [
	"baseUrl",
	"apiKey",
	"oauthTokenUrl",
	"oauthClientId",
	"oauthClientSecret",
	"oauthScopes",
	"virtualKeyHeader",
	"virtualKeyValue",
];

/** The testServerDraft intent body a connection-clean draft parses to; the webview adds only the requestId. */
interface ServerTestIntent {
	readonly server: SaveServerPayload;
	readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
	readonly replaceLabel?: string | undefined;
}

export type ServerTestParse =
	| { readonly ok: true; readonly intent: ServerTestIntent }
	| { readonly ok: false; readonly problems: ServerFormProblems };

/**
 * Parse a draft into the testServerDraft intent, or the connection-relevant
 * problems that block it. One probe must test exactly what a save would send,
 * so this reuses parseServerForm wholesale rather than re-deriving any rule:
 * the parse runs on the draft with a placeholder label and no parameter or
 * capability rows, which by construction leaves exactly the CONNECTION_FIELDS
 * problems - a missing or colliding label and broken record rows do not gate
 * a probe. The assembled intent carries the draft's real trimmed label (it
 * addresses "keep" resolution extension-side, including an orphan secret blob
 * a fresh label would inherit) and the edited entry's label as replaceLabel.
 * Capability rows ride along only when they parse clean - the probe applies
 * their `_declare` directives and the draft's expectedFailures to report a
 * declared-count or expected outcome, but broken rows never block or distort
 * a connection probe.
 */
export function parseServerFormForTest(draft: ServerFormDraft, context: ServerFormContext = {}): ServerTestParse {
	const parse = parseServerForm({ ...draft, label: "draft", modelParameters: [], modelCapabilities: [] });
	if (!parse.ok) {
		return { ok: false, problems: parse.problems };
	}
	const capabilitiesParse = parseCapabilityGroups(draft.modelCapabilities);
	const capabilities =
		capabilitiesParse.ok && Object.keys(capabilitiesParse.value).length > 0 ? capabilitiesParse.value : undefined;
	return {
		ok: true,
		intent: {
			server: {
				...parse.intent.server,
				label: draft.label.trim(),
				...(capabilities !== undefined ? { modelCapabilities: capabilities } : {}),
			},
			secrets: parse.intent.secrets,
			...(context.originalLabel !== undefined ? { replaceLabel: context.originalLabel } : {}),
		},
	};
}

/**
 * The adopt form's label rule: the same constraints the full form applies,
 * plus a hard collision refusal (adoption always creates a new entry, never
 * replaces one). The extension re-checks the same rules on the intent.
 */
export function validateAdoptLabel(label: string, takenLabels: readonly string[]): string | undefined {
	const trimmed = label.trim();
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
	const prefixText = colon > 0 ? message.slice(0, colon) : undefined;
	const field = SERVER_FORM_FIELD_ORDER.find((candidate) => candidate === prefixText);
	if (field !== undefined) {
		return `${serverFormFieldLabel(field)}${message.slice(colon)}`;
	}
	return `${prefix} ${message}`;
}

/**
 * Merge an inlineSecrets response into the draft: each returned value lands
 * in its field's input, marked as the prefill parseSecret treats as "keep".
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
