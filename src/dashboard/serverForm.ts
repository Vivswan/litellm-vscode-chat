/**
 * The server form's pure model: one parser yields either the assembled
 * saveServerSetting intent or the field problems that block it, so validation
 * and assembly cannot diverge. DOM-free, and shared across the trust boundary:
 * the extension re-validates the assembled payload with the same rules.
 */

import * as l10n from "@vscode/l10n";
import type {
	ExpectedFailureCategory,
	NonSecretOptionalFieldId,
	SecretFieldId,
	SecretLocation,
} from "../shared/serverEntry";
import { NON_SECRET_OPTIONAL_FIELD_IDS, SECRET_FIELD_IDS } from "../shared/serverEntry";
import type { HeaderScalar } from "../shared/util/headers";
import { isValidHeaderName, isValidHeaderValue } from "../shared/util/headers";
import { isUnsafeRecordKey } from "../shared/util/json";
import type { SaveServerPayload, SecretDirective } from "./endpoints";
import type { CapabilityGroupIssues, GroupHints, GroupProblems, HeaderRow, PrefixGroup } from "./recordDraft";
import { parseCapabilityGroups, parseGroups, parseHeaderRows } from "./recordDraft";

/**
 * One secret field as the form edits it. `existing` is where the value lives
 * now; an empty `value` means keep it there, typing replaces it in `location`,
 * `clear` removes it outright. A value equal to `prefill` saves as "keep", so
 * an untouched prefill never rewrites.
 */
export interface SecretFieldDraft {
	readonly value: string;
	readonly location: "settings" | "secure";
	readonly clear: boolean;
	readonly existing: SecretLocation;
	readonly prefill?: string | undefined;
}

/**
 * The picked auth form. The selector IS the exactly-one-form rule: only the
 * picked form's fields are validated and assembled, so a second form is
 * unreachable by construction. Lower-ranked companions ride along where the
 * grammar allows (oauth carries apiKey/virtualKey, apiKey carries virtualKey).
 */
export type AuthFormId = "none" | "apiKey" | "virtualKey" | "oauth";

/**
 * The API version control: three modes so "custom with no text yet" stays
 * representable instead of collapsing into "none". Maps onto the entry's
 * apiVersion: auto writes no key, none writes "", custom writes the trimmed text.
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

/** The whole draft, its field set derived from the entry descriptor. */
export type ServerFormDraft = {
	readonly label: string;
	readonly baseUrl: string;
	readonly apiVersion: ApiVersionDraft;
	readonly authForm: AuthFormId;
	readonly headers: readonly HeaderRow[];
	readonly declaredModels: string;
	readonly budget: string;
	readonly modelParameters: readonly PrefixGroup[];
	readonly modelCapabilities: readonly PrefixGroup[];
	readonly expectedFailures: readonly ExpectedFailureCategory[];
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
	modelParameters: [],
	modelCapabilities: [],
	expectedFailures: [],
};

export type ServerFormField = keyof ServerFormDraft;

/** The form's fields in render order; problem summaries name the first offender in this order. */
export const SERVER_FORM_FIELD_ORDER: readonly ServerFormField[] = [
	"label",
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
	"modelParameters",
	"modelCapabilities",
	"declaredModels",
	"expectedFailures",
	"headers",
	"budget",
];

/**
 * The display name of one form field, shared by labels and problem summaries.
 * A function, not a module-level catalog: a constant record would freeze the
 * English text before l10n.config runs.
 */
export function serverFormFieldLabel(field: ServerFormField): string {
	switch (field) {
		case "label":
			return l10n.t("Label");
		case "baseUrl":
			return l10n.t("Base URL");
		case "apiVersion":
			return l10n.t("API version");
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
		case "authForm":
			return l10n.t("Authentication");
		case "headers":
			return l10n.t("Custom headers");
		case "declaredModels":
			return l10n.t("Declared models");
		case "budget":
			return l10n.t("Budget");
		case "modelParameters":
			return l10n.t("Model parameters");
		case "modelCapabilities":
			return l10n.t("Model capabilities");
		case "expectedFailures":
			return l10n.t("Expected failures");
	}
}

/** Problems keyed by the field they belong to; an empty record means the draft is savable. */
export type ServerFormProblems = Partial<Record<ServerFormField, string>>;

/**
 * Which fields the draft has moved away from the baseline it opened with (the
 * save bar counts them). A secret field compares on what the user can change -
 * the typed value, the storage pick, the remove mark - never on `existing` or
 * `prefill`.
 */
export function changedServerFormFields(draft: ServerFormDraft, baseline: ServerFormDraft): readonly ServerFormField[] {
	return SERVER_FORM_FIELD_ORDER.filter((field) => {
		if (field === "apiKey" || field === "oauthClientSecret" || field === "virtualKeyValue") {
			return secretEdited(draft[field], baseline[field]);
		}
		if (field === "expectedFailures") {
			// A set, not a list: comparing sequences would report a change for a
			// check-then-uncheck round trip (the toggle canonicalizes the order
			// while a stored entry keeps its author's).
			const now = new Set(draft.expectedFailures);
			return (
				now.size !== baseline.expectedFailures.length ||
				baseline.expectedFailures.some((category) => !now.has(category))
			);
		}
		const now = draft[field];
		const was = baseline[field];
		if (typeof now === "string" || typeof was === "string") {
			return now !== was;
		}
		// Small JSON-safe drafts, so their serialization IS their identity - no
		// field-by-field walk that a new sub-field could silently fall out of.
		return JSON.stringify(now) !== JSON.stringify(was);
	});
}

/**
 * Whether a secret field would write anything different. Reads the same rule
 * parseSecret does, so the count promises exactly what Save performs: an empty
 * field's storage pick reaches no directive, so flipping it is not an edit.
 */
function secretEdited(now: SecretFieldDraft, was: SecretFieldDraft): boolean {
	if (now.clear !== was.clear || now.value !== was.value) {
		return true;
	}
	return now.value.trim().length > 0 && now.location !== was.location;
}

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
 * One secret field parsed once: the directive the save will carry, whether the
 * field still resolves afterwards, and the value the form can see. Validation
 * and assembly read this one derivation, so a field the directive retires can
 * never block Save on its stale input text.
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
		// rewrite. A changed value or a storage move falls through to a real set.
		return { directive: { action: "keep" }, resolves: true, visibleValue: value };
	}
	return { directive: { action: "set", location: draft.location, value }, resolves: true, visibleValue: value };
}

/**
 * A secret field whose auth form is not the selected one. Never "set": a value
 * typed before the form switched away must not land in storage for a shape
 * that does not send it. Clear stays honored, everything else is "keep", and
 * `resolves` still reports a kept stored value - the extension's pairing rules
 * see it too.
 */
function parseInactiveSecret(draft: SecretFieldDraft): SecretParse {
	if (draft.clear) {
		return { directive: { action: "clear" }, resolves: false, visibleValue: undefined };
	}
	return { directive: { action: "keep" }, resolves: draft.existing !== "none", visibleValue: undefined };
}

/**
 * Which auth form a saved entry's configuration reads as, for the edit form's
 * initial selector state: oauth when the token URL and client ID pair is
 * configured, else apiKey when a key is stored anywhere, else virtualKey when
 * the pair's header or stored value exists, else none.
 */
export function deriveAuthForm(config: {
	readonly oauthTokenUrl?: string | undefined;
	readonly oauthClientId?: string | undefined;
	readonly virtualKeyHeader?: string | undefined;
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;
}): AuthFormId {
	if ((config.oauthTokenUrl ?? "").trim().length > 0 && (config.oauthClientId ?? "").trim().length > 0) {
		return "oauth";
	}
	if (config.secrets.apiKey !== "none") {
		return "apiKey";
	}
	if ((config.virtualKeyHeader ?? "").trim().length > 0 || config.secrets.virtualKeyValue !== "none") {
		return "virtualKey";
	}
	return "none";
}

/**
 * The declared-models textarea's reading: one exact ID per line, trimmed,
 * empties dropped, duplicates removed in first-seen order.
 */
export function parseDeclaredModelsText(text: string): string[] {
	return [
		...new Set(
			text
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
		),
	];
}

/** The context a draft is parsed against: sibling labels for rename-collision checks, and the hint evidence. */
export interface ServerFormContext {
	/** Labels of the other declared entries. */
	readonly takenLabels?: readonly string[];
	/** The label of the entry being edited; absent when adding. Doubles as the intent's replaceLabel. */
	readonly originalLabel?: string;
	/**
	 * The edited entry's observed /model/info key set, the evidence behind the
	 * capability rows' unknown-key hints: with no set or an empty one, every
	 * such hint stays suppressed - the host's advisory filter, run live.
	 */
	readonly observedModelInfoKeys?: readonly string[] | undefined;
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
			 * advisory hints never block a save but must still render.
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
			 * clean and some other field blocks.
			 */
			readonly modelParameterProblems: readonly GroupProblems[];
			/** Row-aligned capability issues; see the ok branch. */
			readonly modelCapabilityIssues: readonly CapabilityGroupIssues[];
			/** Row-aligned model-parameter hints; see the ok branch. */
			readonly modelParameterHints: readonly GroupHints[];
			/** Row-aligned custom-header problems, like modelParameterProblems; problems.headers holds the summary. */
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

/**
 * The fields whose edit invalidates a draft-connection test result: a stale
 * PASS on edited credentials is worse than no result, so the form clears the
 * result when any of these change. The label and the model-parameter rows do
 * not touch the connection and keep it. Also the probe's blocking set: only
 * these fields' problems reach the connection arm of the analysis.
 */
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

/**
 * What a connection-clean draft assembles to: everything the draft-connection
 * probe sends. `modelCapabilities` is the parsed rows when they are clean and
 * `{}` otherwise - the probe carries what it can, and the capability rows are
 * not connection fields.
 */
interface ServerConnectionValues {
	/** The draft's trimmed label, possibly empty or reserved (only the save blocks on that). */
	readonly label: string;
	readonly baseUrl: string;
	/** The entry apiVersion the draft means: undefined for auto, "" for none, the trimmed text for custom. */
	readonly apiVersion: string | undefined;
	readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
	/** The active auth form's non-empty text fields, ready to spread into the payload. */
	readonly optionalText: Readonly<Partial<Record<NonSecretOptionalFieldId, string>>>;
	readonly headers: Record<string, HeaderScalar>;
	readonly modelCapabilities: Record<string, Record<string, unknown>>;
}

/** What a fully clean draft assembles to: the connection values plus the save-only fields. */
interface ServerFormValues extends ServerConnectionValues {
	readonly modelParameters: Record<string, Record<string, unknown>>;
	readonly budget: number | null;
}

/**
 * The one shared analysis behind both parsers, discriminated so each consumer
 * reads its arm instead of re-deriving it: a clean draft IS its assembled
 * values, a blocked one carries the problems - with the connection slice
 * discriminated again inside it, because the probe blocks only on
 * CONNECTION_FIELDS problems. The save and probe rules cannot drift because
 * both read this one result.
 */
type ServerFormAnalysis = {
	/** Row-aligned capability issues from the parse that judged the draft; hints render on both arms. */
	readonly modelCapabilityIssues: readonly CapabilityGroupIssues[];
	/** Row-aligned model-parameter hints (the _force semantic warnings); non-blocking, like the capability issues. */
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

function analyzeServerForm(draft: ServerFormDraft, context: ServerFormContext): ServerFormAnalysis {
	// The selector decides which credential fields are live: everything else is
	// excluded from the payload and demoted to keep/clear directives.
	const oauthActive = draft.authForm === "oauth";
	const apiKeyActive = draft.authForm === "apiKey" || oauthActive;
	const virtualKeyActive = draft.authForm !== "none";

	// Spelled out per field (no cast-and-loop): a secret field added to the
	// catalog fails to compile here instead of surfacing at runtime.
	const secrets: Record<SecretFieldId, SecretParse> = {
		apiKey: apiKeyActive ? parseSecret(draft.apiKey) : parseInactiveSecret(draft.apiKey),
		oauthClientSecret: oauthActive
			? parseSecret(draft.oauthClientSecret)
			: parseInactiveSecret(draft.oauthClientSecret),
		virtualKeyValue: virtualKeyActive ? parseSecret(draft.virtualKeyValue) : parseInactiveSecret(draft.virtualKeyValue),
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

	// Custom text must exist, or a picked "custom" would silently save as "none".
	// Slashes and inner whitespace are named problems, not silently rewritten:
	// "/v2" appended verbatim builds http://host//v2 and every request 404s.
	let apiVersion: string | undefined;
	if (draft.apiVersion.mode === "none") {
		apiVersion = "";
	} else if (draft.apiVersion.mode === "custom") {
		const custom = draft.apiVersion.custom.trim();
		if (custom.length === 0) {
			problems.apiVersion = l10n.t("Enter the version segment, e.g. v2");
		} else if (custom.includes("/") || /\s/.test(custom)) {
			problems.apiVersion = l10n.t("Just the segment, no slashes or spaces - e.g. v2");
		} else {
			apiVersion = custom;
		}
	}

	// OAuth is one unit: the request path drops partial configurations silently,
	// so a partial one must not save as if it worked. On any other form a KEPT
	// stored client secret still blocks - the extension reads it as OAuth-shaped.
	const tokenUrl = draft.oauthTokenUrl.trim();
	const clientId = draft.oauthClientId.trim();
	if (oauthActive) {
		const oauthExtras = secrets.oauthClientSecret.resolves || draft.oauthScopes.trim().length > 0;
		if (tokenUrl.length > 0 && !isUsableHttpUrl(tokenUrl)) {
			problems.oauthTokenUrl = l10n.t("Must be a usable http(s) URL");
		} else if ((clientId.length > 0 || oauthExtras) && tokenUrl.length === 0) {
			problems.oauthTokenUrl = l10n.t("OAuth needs the token URL and client ID");
		}
		if ((tokenUrl.length > 0 || oauthExtras) && clientId.length === 0) {
			problems.oauthClientId = l10n.t("OAuth needs the token URL and client ID");
		}
	} else if (secrets.oauthClientSecret.resolves) {
		problems.oauthClientSecret = l10n.t(
			"A stored OAuth client secret is still attached; remove it with its checkbox, or switch the form to OAuth"
		);
	}

	// Both-or-neither like OAuth, and must be sendable as an HTTP header (the
	// request path drops anything less without a trace). The sendability check
	// reads the parsed visible value, so a cleared field's stale text cannot
	// block; on "none" a kept stored value blocks like the client secret above.
	const header = draft.virtualKeyHeader.trim();
	const virtualKey = secrets.virtualKeyValue;
	if (virtualKeyActive) {
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
	} else if (virtualKey.resolves) {
		problems.virtualKeyValue = l10n.t(
			"A stored virtual key value is still attached; remove it with its checkbox, or pick a form that sends it"
		);
	}

	// The record and header rows share the global editors' parsers, so a draft
	// that renders clean there is exactly a draft that saves here.
	const groupsParse = parseGroups(draft.modelParameters);
	if (!groupsParse.ok) {
		problems.modelParameters = l10n.t("Fix the model parameter rows");
	}
	const capabilitiesParse = parseCapabilityGroups(
		draft.modelCapabilities,
		context.observedModelInfoKeys === undefined ? undefined : new Set(context.observedModelInfoKeys)
	);
	if (!capabilitiesParse.ok) {
		problems.modelCapabilities = l10n.t("Fix the model capability rows");
	}
	const headersParse = parseHeaderRows(draft.headers);
	if (!headersParse.ok) {
		problems.headers = l10n.t("Fix the header rows");
	}

	// Budget: empty means none (the payload's null clear); anything else must
	// be a finite number greater than zero, the rule the extension re-checks.
	const budgetText = draft.budget.trim();
	let budget: number | null = null;
	if (budgetText.length > 0) {
		const budgetValue = Number(budgetText);
		if (Number.isFinite(budgetValue) && budgetValue > 0) {
			budget = budgetValue;
		} else {
			problems.budget = l10n.t("Must be a number greater than 0");
		}
	}

	// Only the active form's text fields reach the payload: an inactive form's
	// leftover text is excluded exactly like an empty input.
	const activeText: Readonly<Record<NonSecretOptionalFieldId, string>> = {
		oauthTokenUrl: oauthActive ? draft.oauthTokenUrl : "",
		oauthClientId: oauthActive ? draft.oauthClientId : "",
		oauthScopes: oauthActive ? draft.oauthScopes : "",
		virtualKeyHeader: virtualKeyActive ? draft.virtualKeyHeader : "",
	};
	const optionalText: { -readonly [K in NonSecretOptionalFieldId]?: string } = {};
	for (const field of NON_SECRET_OPTIONAL_FIELD_IDS) {
		const value = activeText[field].trim();
		if (value.length > 0) {
			optionalText[field] = value;
		}
	}

	const directives = secretDirectives(secrets);
	if (
		groupsParse.ok &&
		capabilitiesParse.ok &&
		headersParse.ok &&
		!Object.values(problems).some((problem) => problem !== undefined)
	) {
		return {
			blocked: false,
			values: {
				label,
				baseUrl,
				apiVersion,
				secrets: directives,
				optionalText,
				headers: headersParse.value,
				modelCapabilities: capabilitiesParse.value,
				modelParameters: groupsParse.value,
				budget,
			},
			modelCapabilityIssues: capabilitiesParse.issues,
			modelParameterHints: groupsParse.hints,
		};
	}
	const connectionProblems: { -readonly [K in ServerFormField]?: string } = {};
	for (const field of CONNECTION_FIELDS) {
		const problem = problems[field];
		if (problem !== undefined) {
			connectionProblems[field] = problem;
		}
	}
	// headers is a connection field, so a clean connection implies clean header
	// rows; the narrowing states the half the type system cannot see.
	const connection =
		headersParse.ok && !Object.values(connectionProblems).some((problem) => problem !== undefined)
			? {
					blocked: false as const,
					values: {
						label,
						baseUrl,
						apiVersion,
						secrets: directives,
						optionalText,
						headers: headersParse.value,
						modelCapabilities: capabilitiesParse.ok ? capabilitiesParse.value : {},
					},
				}
			: { blocked: true as const, problems: connectionProblems };
	return {
		blocked: true,
		problems,
		modelParameterProblems: groupsParse.ok ? [] : groupsParse.problems,
		headerProblems: headersParse.ok ? [] : headersParse.problems,
		connection,
		modelCapabilityIssues: capabilitiesParse.issues,
		modelParameterHints: groupsParse.hints,
	};
}

/**
 * Parse a draft into the saveServerSetting intent, or the problems that block
 * it; there is no separate validation pass to drift from the assembly. The
 * problem messages never repeat an entered value: drafts carry secrets, and
 * the extension surfaces the same messages through logs and the fail notice.
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
	// The record and list fields are always sent, even empty (the payload
	// requires them); modelParameters is the one optional field.
	const server: SaveServerPayload = {
		label: values.label,
		baseUrl: values.baseUrl,
		...(values.apiVersion !== undefined ? { apiVersion: values.apiVersion } : {}),
		...values.optionalText,
		...(Object.keys(values.modelParameters).length > 0 ? { modelParameters: values.modelParameters } : {}),
		modelCapabilities: values.modelCapabilities,
		expectedFailures: draft.expectedFailures,
		headers: values.headers,
		declaredModels: parseDeclaredModelsText(draft.declaredModels),
		budget: values.budget,
	};
	return {
		ok: true,
		intent: {
			server,
			secrets: values.secrets,
			...(context.originalLabel !== undefined ? { replaceLabel: context.originalLabel } : {}),
		},
		modelCapabilityIssues: analysis.modelCapabilityIssues,
		modelParameterHints: analysis.modelParameterHints,
	};
}

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
 * problems that block it, from the same analyzeServerForm pass. Broken header
 * rows block (the probe sends them); label, record-row, and budget problems do
 * not. The intent omits modelParameters and the budget, carries the capability
 * rows only when they parse clean, and keeps the draft's real trimmed label:
 * the label addresses "keep" resolution extension-side.
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
		...(values.apiVersion !== undefined ? { apiVersion: values.apiVersion } : {}),
		...values.optionalText,
		modelCapabilities: values.modelCapabilities,
		expectedFailures: draft.expectedFailures,
		headers: values.headers,
		declaredModels: parseDeclaredModelsText(draft.declaredModels),
		budget: null,
	};
	return {
		ok: true,
		intent: {
			server,
			secrets: values.secrets,
			...(context.originalLabel !== undefined ? { replaceLabel: context.originalLabel } : {}),
		},
	};
}

/**
 * The adopt form's label rule: the full form's constraints plus a hard
 * collision refusal (adoption always creates a new entry, never replaces one).
 * The extension re-checks the same rules on the intent.
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
 * What the form does with its own save failure: a validation-kind failure left
 * the setting untouched (the draft is still the truth, return to editing); an
 * operation-kind failure committed the save, so the draft is stale and the
 * form closes.
 */
export function saveFailureDisposition(kind: "validation" | "operation"): "edit" | "close" {
	return kind === "operation" ? "close" : "edit";
}

/**
 * The section-level failure notice text. A recognized field prefix in the
 * message ("label: ...") is promoted to the field's display name and the
 * section prefix dropped, avoiding a stuttering double prefix.
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
 * Merge an inlineSecrets response into the draft, marked as the prefill
 * parseSecret treats as "keep". Only inline-stored fields the user has not
 * typed into or marked for removal are touched, so a slow response never
 * clobbers an edit in progress.
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
