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
	SecretFieldId,
	SecretLocation,
} from "../shared/serverEntry";
import { NON_SECRET_OPTIONAL_FIELD_IDS, SECRET_FIELD_IDS } from "../shared/serverEntry";
import { isValidHeaderName, isValidHeaderValue } from "../shared/util/headers";
import { isUnsafeRecordKey } from "../shared/util/json";
import type { SaveServerPayload, SecretDirective } from "./endpoints";
import type { CapabilityGroupIssues, GroupHints, GroupProblems, HeaderRow, PrefixGroup } from "./recordDraft";
import { parseCapabilityGroups, parseGroups, parseHeaderRows } from "./recordDraft";

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
 * The auth form the user picked in the form's Authentication selector. The
 * selector IS the exactly-one-form rule (docs/servers.md#authentication): only
 * the picked form's fields are validated and assembled, so a second form is
 * unreachable by construction. Lower-ranked companions ride along where the
 * grammar allows them: oauth carries an apiKey and/or virtualKey companion,
 * apiKey carries a virtualKey companion, virtualKey and none carry nothing.
 */
export type AuthFormId = "none" | "apiKey" | "virtualKey" | "oauth";

/**
 * The API version control as the form edits it: the three modes explicit, so
 * "custom with no text yet" stays representable (and validatable) instead of
 * collapsing into "none". Maps onto the entry's apiVersion field: auto writes
 * no key, none writes "" (append nothing), custom writes the trimmed text.
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
 * The whole draft, its field set derived from the entry descriptor: label and
 * base URL, the Authentication selector's form pick, the non-secret optional
 * fields as plain text inputs, one SecretFieldDraft per secret field, the
 * entry's custom-header rows, the entry's per-entry modelParameters and
 * modelCapabilities as the same draft rows the record editors edit, the
 * declared-models textarea (one exact model ID per line) and budget text
 * input, and the expected-failure categories as the checkbox set's list.
 */
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
 * A function, not a module-level catalog: the names localize, and a constant
 * record would freeze the English text before l10n.config runs.
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
			return l10n.t("Budget (USD)");
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
 * Which fields the draft has moved away from the baseline it opened with; the
 * flat edit page's save bar counts them, so the reader can see there is
 * something to save without hunting the scroll for it.
 *
 * A secret field compares on what the user can actually change - the typed
 * value, the storage pick, the remove mark - and never on `existing` or
 * `prefill`, which describe where the value already lives. That makes the
 * inline prefill invisible here only because the caller re-baselines with the
 * same values; a field the prefill filled while the baseline stayed empty is a
 * real difference and counts, which is the honest reading of "unsaved".
 */
export function changedServerFormFields(draft: ServerFormDraft, baseline: ServerFormDraft): readonly ServerFormField[] {
	return SERVER_FORM_FIELD_ORDER.filter((field) => {
		if (field === "apiKey" || field === "oauthClientSecret" || field === "virtualKeyValue") {
			return secretEdited(draft[field], baseline[field]);
		}
		if (field === "expectedFailures") {
			// A set, not a list: the checkbox toggle canonicalizes the order
			// while a stored entry keeps its author's, so comparing sequences
			// would report a change for a check-then-uncheck round trip.
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
		// The structured fields (the API version pair, the record groups, the
		// header rows) are small, JSON-safe drafts, so their serialization IS
		// their identity - no field-by-field walk that a new sub-field could
		// silently fall out of.
		return JSON.stringify(now) !== JSON.stringify(was);
	});
}

/**
 * Whether a secret field would write anything different. It reads the same
 * rule parseSecret does, so the count promises exactly what Save performs: an
 * empty field's storage pick reaches no directive at all (the parse returns
 * "keep" whatever the radio says), so flipping it is not an edit however it
 * looks.
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

/**
 * A secret field whose auth form is not the selected one. Never "set": a value
 * typed before the form switched away must not land in storage for a shape
 * that does not send it. Clear stays honored (the Remove checkbox is reachable
 * on every shape, per the stored-secret legibility rule), and everything else
 * is "keep" - switching forms never silently deletes a stored secret.
 * `resolves` still reports a kept stored value, because the extension's
 * pairing rules see it too (a kept client secret makes a save OAuth-shaped).
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
 * configured, else apiKey when an API key is stored anywhere (rank reads a
 * stored key beside a virtual-key pair as the API-key form with a companion),
 * else virtualKey when the pair's header or stored value exists, else none.
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
 * The declared-models textarea's reading: one exact model ID per line,
 * trimmed, empties dropped, duplicates removed in first-seen order. No
 * validation beyond that - IDs are exact strings by contract.
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
	 * The edited entry's observed /model/info key set
	 * (DashboardServer.observedModelInfoKeys), the evidence behind the
	 * capability rows' unknown-key hints: with no set (a fresh add, a
	 * declared-only entry, a /models-fallback discovery) or an empty one,
	 * every such hint stays suppressed - the host's advisory filter, run
	 * live as the user types.
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
			 * the advisory hints (an unknown key the entry's observed
			 * /model/info evidence does not name, an invalid consumed value)
			 * never block a save but must still render.
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
			/** Row-aligned custom-header problems, like modelParameterProblems; problems.headers holds the summary. */
			readonly headerProblems: readonly (string | undefined)[];
	  };

/**
 * The one shared analysis behind both parsers: every field's problem plus the
 * parsed pieces the intents assemble from. parseServerForm blocks on any
 * problem; parseServerFormForTest blocks only on the CONNECTION_FIELDS
 * problems - both read this one pass, so the save and probe rules cannot
 * drift.
 */
interface ServerFormAnalysis {
	readonly problems: ServerFormProblems;
	/** The draft's trimmed label, possibly empty or reserved (only the save blocks on that). */
	readonly label: string;
	readonly baseUrl: string;
	/** The entry apiVersion the draft means: undefined for auto, "" for none, the trimmed text for custom. */
	readonly apiVersion: string | undefined;
	readonly secrets: Readonly<Record<SecretFieldId, SecretParse>>;
	readonly groupsParse: ReturnType<typeof parseGroups>;
	readonly capabilitiesParse: ReturnType<typeof parseCapabilityGroups>;
	readonly headersParse: ReturnType<typeof parseHeaderRows>;
	readonly budget: number | null;
	/** The active auth form's non-empty text fields, ready to spread into the payload. */
	readonly optionalText: Readonly<Partial<Record<NonSecretOptionalFieldId, string>>>;
}

function analyzeServerForm(draft: ServerFormDraft, context: ServerFormContext): ServerFormAnalysis {
	// The selector decides which credential fields are live: only the picked
	// form's fields (and its lower-ranked companions) are validated and
	// assembled; everything else is excluded from the payload and demoted to
	// keep/clear directives, whatever text sits in its (hidden) inputs.
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

	// The apiVersion the saved entry will carry: auto omits the field, none
	// writes "" (append nothing), custom writes the trimmed text - which must
	// exist, or a picked "custom" would silently save as "none". Slashes and
	// inner whitespace are named problems, not silently rewritten: "/v2"
	// appended verbatim would build http://host//v2, which routers do not
	// collapse, and every request would 404 with no hint.
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

	// OAuth is one unit: the request path drops partial configurations
	// silently, so a partial one must not save as if it worked. The rules run
	// only while OAuth is the picked form; on any other form a KEPT stored
	// client secret still blocks, because the extension's pairing rules would
	// read it as OAuth-shaped and refuse the save - the Remove checkbox (or
	// switching back to OAuth) is the way out.
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

	// The virtual key is likewise both-or-neither, and must be sendable as an
	// HTTP header: the request path drops anything less without a trace. The
	// sendability check reads the parsed visible value, not the raw input, so
	// a cleared field's stale text (sitting in a disabled input) cannot block.
	// The pair is live on every form but "none" (its own form, the API-key
	// form's companion, OAuth's companion); on "none" a kept stored value
	// blocks like the client secret above, for the same extension-side reason.
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

	// The per-entry model-parameter rows share the global editor's parse, so a
	// draft that renders clean there is exactly a draft that saves here; the
	// rows carry their own problems and the field slot holds the summary. The
	// capability rows follow the same pattern with their own parser (typed
	// vocabulary instead of free JSON), and the header rows with theirs.
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
	// read as a finite number greater than zero, the same rule the extension
	// re-checks.
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
	// leftover text (typed, then the selector moved on) is excluded exactly
	// like an empty input, so the saved entry carries one auth form only.
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

	return {
		problems,
		label,
		baseUrl,
		apiVersion,
		secrets,
		groupsParse,
		capabilitiesParse,
		headersParse,
		budget,
		optionalText,
	};
}

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
 * Parse a draft into the saveServerSetting intent it assembles to, or the
 * problems that block it; there is no separate validation pass to drift from
 * the assembly. The problem messages never repeat an entered value: drafts
 * carry secrets, and the extension surfaces the same messages through logs
 * and the fail envelope's notice.
 */
export function parseServerForm(draft: ServerFormDraft, context: ServerFormContext = {}): ServerFormParse {
	const {
		problems,
		label,
		baseUrl,
		apiVersion,
		secrets,
		groupsParse,
		capabilitiesParse,
		headersParse,
		budget,
		optionalText,
	} = analyzeServerForm(draft, context);
	// The parse-failure conditions are redundant with the problems check (a
	// failed parse set its field's problem); they are spelled out so the ok
	// branch below narrows to the parsed values.
	if (
		!groupsParse.ok ||
		!capabilitiesParse.ok ||
		!headersParse.ok ||
		Object.values(problems).some((problem) => problem !== undefined)
	) {
		return {
			ok: false,
			problems,
			modelParameterProblems: groupsParse.ok ? [] : groupsParse.problems,
			modelCapabilityIssues: capabilitiesParse.issues,
			modelParameterHints: groupsParse.hints,
			headerProblems: headersParse.ok ? [] : headersParse.problems,
		};
	}

	// The record and list fields are always sent, even empty (the payload
	// requires them); modelParameters is the one optional field - absent and
	// empty both mean "none".
	const server: SaveServerPayload = {
		label,
		baseUrl,
		...(apiVersion !== undefined ? { apiVersion } : {}),
		...optionalText,
		...(Object.keys(groupsParse.value).length > 0 ? { modelParameters: groupsParse.value } : {}),
		modelCapabilities: capabilitiesParse.value,
		expectedFailures: draft.expectedFailures,
		headers: headersParse.value,
		declaredModels: parseDeclaredModelsText(draft.declaredModels),
		budget,
	};
	return {
		ok: true,
		intent: {
			server,
			secrets: secretDirectives(secrets),
			...(context.originalLabel !== undefined ? { replaceLabel: context.originalLabel } : {}),
		},
		modelCapabilityIssues: capabilitiesParse.issues,
		modelParameterHints: groupsParse.hints,
	};
}

/**
 * The fields whose edit invalidates a draft-connection test result: the base
 * URL and its API version override, the auth-form pick, every credential input (value, storage choice, or
 * remove mark), the OAuth text fields, and the custom-header rows (the probe
 * sends them). A stale PASS on edited credentials is worse than no result, so
 * the form clears the result when any of these change; the label and the
 * model-parameter rows do not touch the connection and keep it.
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
 * problems that block it. The same analyzeServerForm pass judges the draft,
 * so no rule is re-derived; the probe blocks only on CONNECTION_FIELDS
 * problems - a missing or colliding label, broken record rows, and a
 * malformed budget do not gate a probe, while broken header rows do (the
 * probe sends the headers, so probing without them would test a different
 * configuration). The assembled intent omits modelParameters and the budget
 * (the probe never sends them), carries the capability rows only when they
 * parse clean, and keeps the draft's real trimmed label: the label addresses
 * "keep" resolution extension-side, including an orphan secret blob a fresh
 * label would inherit.
 */
export function parseServerFormForTest(draft: ServerFormDraft, context: ServerFormContext = {}): ServerTestParse {
	const analysis = analyzeServerForm(draft, context);
	const { headersParse, capabilitiesParse } = analysis;
	const problems: { -readonly [K in ServerFormField]?: string } = {};
	for (const field of CONNECTION_FIELDS) {
		const problem = analysis.problems[field];
		if (problem !== undefined) {
			problems[field] = problem;
		}
	}
	// The headers-parse condition is redundant with the problems check (a
	// failed parse set problems.headers, a connection field); it is spelled
	// out so the ok branch narrows to the parsed rows.
	if (!headersParse.ok || Object.values(problems).some((problem) => problem !== undefined)) {
		return { ok: false, problems };
	}
	const server: SaveServerPayload = {
		label: analysis.label,
		baseUrl: analysis.baseUrl,
		...(analysis.apiVersion !== undefined ? { apiVersion: analysis.apiVersion } : {}),
		...analysis.optionalText,
		modelCapabilities: capabilitiesParse.ok ? capabilitiesParse.value : {},
		expectedFailures: draft.expectedFailures,
		headers: headersParse.value,
		declaredModels: parseDeclaredModelsText(draft.declaredModels),
		budget: null,
	};
	return {
		ok: true,
		intent: {
			server,
			secrets: secretDirectives(analysis.secrets),
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
