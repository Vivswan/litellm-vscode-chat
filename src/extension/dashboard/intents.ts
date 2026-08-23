/**
 * Validation and execution of webview intents. Intents arrive already
 * schema-checked (intentSchema.ts); this module holds the value constraints
 * the schema cannot express and dispatches each validated intent against the
 * injected IntentEnvironment, so everything is unit-testable without a
 * webview or a real configuration store. panel.ts owns the vscode wiring.
 */

import * as l10n from "@vscode/l10n";
import type {
	DashboardCommandId,
	DashboardIntent,
	IntentAckTone,
	ReplacedEntryIdentity,
	SaveServerPayload,
	SecretDirective,
} from "../../dashboard/endpoints";
import { unitBehavior, zeroModelExplanation } from "../../dashboard/presenters";
import { isUsableHttpUrl } from "../../dashboard/serverForm";
import { usableThresholds } from "../../dashboard/spendFormat";
import { CMD, INTERNAL_CMD, manageCommandTitle } from "../../shared/config/commandIds";
import type { FeatureModelId, FeatureModelRef, NumberSettingId } from "../../shared/config/settingSpec";
import {
	ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY,
	COMMIT_GENERATION_PROMPT_SETTING_KEY,
	CONFIG_SECTION,
	CURRENCY_SYMBOL_SETTING_KEY,
	FEATURE_MODEL_SETTING_KEYS,
	INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY,
	isIntegerSetting,
	isUsableThreshold,
	NUMBER_SETTING_SPECS,
	TOKEN_ESTIMATION_SETTING_KEY,
	UI_ACCENT_SETTING_KEY,
	UI_THEME_SETTING_KEY,
} from "../../shared/config/settingSpec";
import {
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	normalizeInlineLanguageFilter,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
	USAGE_STATUS_BAR_SETTING_KEY,
} from "../../shared/config/settings";
import type { TransportErrorClassification } from "../../shared/errorClassification";
import { transportClassificationOf } from "../../shared/errorClassification";
import { MirroredError } from "../../shared/mirroredError";
import type { SecretFieldId } from "../../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { isValidHeaderName, isValidHeaderValue } from "../../shared/util/headers";
import { isRecord, isUnsafeRecordKey } from "../../shared/util/json";
import { EXTENSION_SETTINGS_FILTER } from "../servers/serverManagement";
import { acceptedEntry, inlineSecretValues } from "../servers/serverSync";
import type { StoredSecretsRecord } from "../servers/serverSync/secrets";
import { nonSecretIdentityMatches } from "../servers/serverSync/setting";
import type { AdoptableGroupCredentials } from "./adopt";
import { applyAdoptServer } from "./adopt";
import { applySaveServerSetting } from "./saveServer";
import type { DraftConnection } from "./testDraftConnection";
import { applyTestServerDraft } from "./testDraftConnection";

/**
 * A constraint violation detected by this module's own validation. Its
 * message may travel to the webview verbatim so the user sees which rule
 * failed, but never to the log: some messages quote an entered key (a header
 * name, a modelParameters prefix), and the log buffer feeds public issue
 * reports. The panel boundary logs a classification only.
 */
export class DashboardValidationError extends Error {
	/**
	 * The transport classification behind the failure, when a probe supplied
	 * one: enum ids and a status number only, never message text, so it rides
	 * both the fail envelope and the boundary's rejection log line.
	 */
	readonly classification?: TransportErrorClassification;

	constructor(message: string, options?: { classification?: TransportErrorClassification | undefined }) {
		super(message);
		this.name = "DashboardValidationError";
		if (options?.classification !== undefined) {
			this.classification = options.classification;
		}
	}
}

/**
 * An intent that partially applied: the durable write landed but a follow-up
 * effect did not, so the intent must report failure with an accurate way
 * forward. Like DashboardValidationError, the message is webview-safe
 * (actionable, never a value) and the panel boundary logs a classification.
 */
export class DashboardOperationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DashboardOperationError";
	}
}

/**
 * The per-feature model probes, keyed by feature: each runs the feature's
 * exact pipeline over a fixed sample (the inline-completions probe is the
 * shared FIM send - connection resolution, `_fim_template` application, fixed
 * bounds). Partial: a feature without a probe has no key, the model row
 * renders no Test button for it, and a forged intent is refused. Read-only;
 * each resolves to the probe's answer text or undefined when the 200 body
 * carried none, and throws the transport's classified error. Declared here
 * because the intent executor is the contract's consumer; the feature wirings
 * build the record and the dashboard wiring passes it through.
 */
export type FeatureProbes = Readonly<
	Partial<Record<FeatureModelId, (model: FeatureModelRef) => Promise<string | undefined>>>
>;

/** The effects an intent can have; injected so intents are testable without vscode. */
export interface IntentEnvironment {
	/** Write one litellm-vscode-chat.* setting (the key is relative to the section). */
	updateSetting(key: string, value: unknown): Promise<void>;
	/** Remove one litellm-vscode-chat.* setting from the highest-precedence scope that sets it (resolveConfiguredScope). */
	removeSetting(key: string): Promise<void>;
	/** Read one litellm-vscode-chat.* setting's effective (scope-merged) value, reflecting landed writes. */
	readSetting(key: string): unknown;
	executeCommand(command: string, ...args: readonly unknown[]): Thenable<unknown>;
	/** The servers array a write would replace (the user-scope value; the setting is machine-scoped). */
	readServersSetting(): unknown;
	writeServersSetting(value: readonly unknown[]): Promise<void>;
	/**
	 * Write one secure-side secret field for a label; undefined deletes it.
	 * `owner` is the ownership stamp - the destination the value is being
	 * paired with (secretDestination), or undefined only when deleting or
	 * restoring a recorded pre-write state. The value must never be logged.
	 */
	storeServerSecret(
		label: string,
		field: SecretFieldId,
		value: string | undefined,
		owner: string | undefined
	): Promise<void>;
	/** A label's secure-side blob with its ownership stamps; read for pairing validation and write rollback, never logged. */
	readServerSecrets(label: string): Promise<StoredSecretsRecord>;
	/** Delete a label's whole secure-side blob (the cleanup half of a rename). */
	deleteServerSecrets(label: string): Promise<void>;
	/** Ask the sync engine for a pass; secure-only changes fire no configuration event. */
	requestServerSync(): void;
	/**
	 * The live credentials of the external group an adopt intent names by its
	 * opaque row handle. Resolves only groups that are still external and still
	 * at `baseUrl`. The returned values go straight into the setting or
	 * SecretStorage and are never logged.
	 */
	resolveAdoptionCredentials(baseUrl: string, sourceHandle: string): AdoptableGroupCredentials | undefined;
	/**
	 * The identity (status label and base URL) of the external group a hide
	 * intent names by its opaque row handle; same resolution rules as the
	 * adopt path, no credential material.
	 */
	resolveExternalGroup(baseUrl: string, sourceHandle: string): { label: string; baseUrl: string } | undefined;
	/** Persist one removed-group tombstone; the group answers with no models until unhidden. */
	hideGroup(identity: { label: string; baseUrl: string }): Promise<void>;
	/** Clear one removed-group tombstone. Resolves false when no tombstone matched the identity. */
	unhideGroup(identity: { label: string; baseUrl: string }): Promise<boolean>;
	/** Classification-only logging (the buffer feeds public issue reports); never a payload value. */
	log(message: string, data?: unknown): void;
	/**
	 * One discovery probe against a fully resolved draft connection. Read-only
	 * by contract - no settings write, no group or status mutation, no caching
	 * across probes - bounded by the discovery.timeout setting, and the
	 * connection's credential values are never logged. Resolves to the
	 * discovered raw model IDs; throws the transport's classified error.
	 */
	probeDraftConnection(connection: DraftConnection): Promise<readonly string[]>;
	/** The per-feature model probes; see FeatureProbes. */
	featureProbes: FeatureProbes;
	/**
	 * Kick one immediate OpenRouter catalog refresh. Fire-and-forget: the
	 * wiring re-pushes state when the refresh settles, and the row status
	 * carries the outcome.
	 */
	refreshCatalogNow(): void;
	/** Kick one immediate usage refresh; same fire-and-forget contract. */
	refreshUsageNow(): void;
}

const COMMANDS_BY_ID: Record<DashboardCommandId, { command: string; args: readonly unknown[] }> = {
	openGroupsFile: { command: INTERNAL_CMD.openGroupsFile, args: [] },
	testConnection: { command: CMD.testConnection, args: [] },
	openSettings: { command: "workbench.action.openSettings", args: [EXTENSION_SETTINGS_FILTER] },
	reportIssue: { command: CMD.reportIssue, args: [] },
	openOutput: { command: INTERNAL_CMD.openOutput, args: [] },
	exportSettings: { command: CMD.exportSettings, args: [] },
	importSettings: { command: CMD.importSettings, args: [] },
};

/**
 * Value constraints the message schema cannot express. Returns the reason a
 * number is not writable, or undefined when it is. Reasons are two-part - a
 * localized headline, then a technical detail line - and the detail names the
 * setting id because the failure banner is page-global and names no field;
 * the id stays an ASCII identifier outside the translation.
 */
export function validateNumberSetting(setting: NumberSettingId, value: number | null): string | undefined {
	const spec = NUMBER_SETTING_SPECS[setting];
	if (value === null) {
		if (spec.nullable) {
			return undefined;
		}
		return `${l10n.t("This setting needs a number and cannot be left empty.")}\n${l10n.t(
			"setting {0}: no value given; the setting is not clearable",
			setting
		)}`;
	}
	if (value < spec.minimum) {
		const minimum = unitBehavior(setting).minimumText(spec.minimum);
		return `${l10n.t("Enter a number that is at least {0}.", minimum)}\n${l10n.t(
			"setting {0}, minimum {1}",
			setting,
			minimum
		)}`;
	}
	// The schema layer admits any finite number (the webview is outside the
	// trust boundary), so the spec's integer-only rule is re-enforced here:
	// without it a crafted message would write a fraction into a settings.json
	// field whose contribution declares "integer".
	if (isIntegerSetting(setting) && !Number.isInteger(value)) {
		return `${l10n.t("Enter a whole number.")}\n${l10n.t("setting {0}: fractional values are not accepted", setting)}`;
	}
	return undefined;
}

/** Refuse prototype-polluting keys anywhere in a modelParameters record. */
export function validateModelParametersRecord(
	value: Readonly<Record<string, Readonly<Record<string, unknown>>>>
): string | undefined {
	for (const [prefix, params] of Object.entries(value)) {
		if (isUnsafeRecordKey(prefix)) {
			return `"${prefix}" is a reserved name and cannot be used as a model prefix`;
		}
		for (const key of Object.keys(params)) {
			if (isUnsafeRecordKey(key)) {
				return `"${key}" is a reserved name and cannot be used as a parameter name`;
			}
		}
	}
	return undefined;
}

/**
 * The connection-relevant value constraints shared by the save and the draft
 * test: usable URLs, header charset, and per-directive value rules. Label and
 * modelParameters constraints stay in validateSaveServerSetting - neither
 * gates a connection probe. Reasons name fields, never values.
 */
function validateConnectionFields(
	server: SaveServerPayload,
	secrets: Readonly<Record<SecretFieldId, SecretDirective>>
): string | undefined {
	const baseUrl = server.baseUrl.trim();
	if (baseUrl.length === 0) {
		return "baseUrl: enter the server URL";
	}
	if (!isUsableHttpUrl(baseUrl)) {
		return "baseUrl: not a usable http(s) URL";
	}
	// Empty-string optionals count as absent: the merge omits them from the
	// written entry, so only fields with content need to be usable.
	const tokenUrl = server.oauthTokenUrl?.trim();
	if (tokenUrl !== undefined && tokenUrl.length > 0 && !isUsableHttpUrl(tokenUrl)) {
		return "oauthTokenUrl: not a usable http(s) URL";
	}
	const header = server.virtualKeyHeader?.trim();
	if (header !== undefined && header.length > 0 && !isValidHeaderName(header)) {
		return "virtualKeyHeader: not a valid HTTP header name";
	}
	for (const field of SECRET_FIELD_IDS) {
		const directive = secrets[field];
		if (directive.action === "set" && directive.value.length === 0) {
			return `${field}: an empty value cannot be set; use clear`;
		}
	}
	const virtualKeyDirective = secrets.virtualKeyValue;
	if (virtualKeyDirective.action === "set" && !isValidHeaderValue(virtualKeyDirective.value)) {
		return "virtualKeyValue: the value cannot be sent as an HTTP header";
	}
	return undefined;
}

/**
 * The value constraints on a saveServerSetting intent, mirroring the webview
 * form's field-level rules (serverForm.ts) for messages that bypassed it.
 * Cross-field pairing is enforced in applySaveServerSetting, where the
 * resolved secrets context exists. Reasons name fields, never values: payloads
 * carry secrets, and the message is echoed to the webview.
 */
export function validateSaveServerSetting(
	server: SaveServerPayload,
	secrets: Readonly<Record<SecretFieldId, SecretDirective>>
): string | undefined {
	const label = server.label.trim();
	if (label.length === 0) {
		return "label: enter a label";
	}
	if (isUnsafeRecordKey(label)) {
		return "label: reserved name";
	}
	const connectionProblem = validateConnectionFields(server, secrets);
	if (connectionProblem !== undefined) {
		return connectionProblem;
	}
	if (server.modelParameters !== undefined) {
		const problem = validateModelParametersRecord(server.modelParameters);
		if (problem !== undefined) {
			return `modelParameters: ${problem}`;
		}
	}
	// Same reserved-key rules; capability vocabulary and value typing stay with
	// the resolver's parse, which diagnoses rather than refuses (the setting is
	// lenient by design).
	const capabilitiesProblem = validateModelParametersRecord(server.modelCapabilities);
	if (capabilitiesProblem !== undefined) {
		return `modelCapabilities: ${capabilitiesProblem}`;
	}
	// Mirrors the form's header-row rules and the request path's
	// normalizeCustomHeaders acceptance: names and the value charset are
	// refused here so a save can never "succeed" on a header the wire would
	// drop. Header NAMES are structural configuration and may be echoed;
	// values never are.
	const seenLower = new Set<string>();
	for (const [name, value] of Object.entries(server.headers)) {
		if (isUnsafeRecordKey(name)) {
			return `headers: "${name}" is a reserved name and cannot be used`;
		}
		if (!isValidHeaderName(name)) {
			return `headers: "${name}" is not a valid HTTP header name`;
		}
		const lower = name.toLowerCase();
		if (seenLower.has(lower)) {
			return `headers: "${name}" repeats an earlier header name (names are case-insensitive)`;
		}
		seenLower.add(lower);
		if (!isValidHeaderValue(String(value))) {
			return `headers: the value of "${name}" cannot be sent as an HTTP header`;
		}
	}
	if (server.budget !== null) {
		if (!Number.isFinite(server.budget) || server.budget <= 0) {
			return "budget: must be a number greater than 0";
		}
	}
	// The guided path refuses an MCP endpoint it can see is broken, the same
	// rule the form applies; the setting itself takes a URL as written and
	// reports an unusable one, exactly as it does for baseUrl.
	if (server.mcp !== null && server.mcp !== true) {
		const url = server.mcp.url?.trim();
		if (url !== undefined && url.length > 0 && !isUsableHttpUrl(url)) {
			return "mcp.url: not a usable http(s) URL";
		}
	}
	return undefined;
}

/**
 * The value constraints on a testServerDraft intent: the connection-relevant
 * subset of the save rules. The label deliberately goes unchecked (empty and
 * reserved labels probe fine; the label only addresses "keep" resolution).
 */
export function validateTestServerDraft(
	server: SaveServerPayload,
	secrets: Readonly<Record<SecretFieldId, SecretDirective>>
): string | undefined {
	return validateConnectionFields(server, secrets);
}

/**
 * The servers-setting array as a mutable copy, entries preserved verbatim:
 * junk siblings (non-objects, entries without labels) must survive a rewrite
 * untouched so a save never deletes what the user typed by hand. Non-arrays
 * read as empty so a save can still land.
 */
export function rawServerEntries(raw: unknown): unknown[] {
	return Array.isArray(raw) ? [...raw] : [];
}

/**
 * Whether a raw entry carries this label, trimmed on both sides:
 * parseServersSetting trims labels, so a hand-written `" Prod "` entry
 * displays as "Prod" and its edits and removals must find it again. Removal
 * matches every raw carrier of the label on purpose; per-entry resolution goes
 * through acceptedEntry instead.
 */
function entryHasLabel(entry: unknown, label: string): entry is Record<string, unknown> {
	return isRecord(entry) && typeof entry.label === "string" && entry.label.trim() === label.trim();
}

/**
 * What a probe that answered NOTHING says, per feature. The probes run
 * different wire paths, so the advice must name the right cause: an empty
 * /completions answer is the classic symptom of a chat model configured where
 * a fill-in-the-middle one belongs, while an empty /chat/completions answer is
 * just a model that said nothing. Total over FeatureModelId by exhaustive
 * switch - a new model-picking feature must choose which reading it gets.
 */
function probeEmptyAnswerText(feature: FeatureModelId): string {
	switch (feature) {
		case "inlineCompletions":
			return l10n.t(
				"The server answered without a completion. Check that the model is a text-completion (FIM) model served on /completions."
			);
		case "prGeneration":
			// This probe parses before it answers, so an empty result means the
			// reply carried no readable TITLE, not merely no text.
			return l10n.t(
				"The server answered, but no pull request title could be read from the reply. Check that the model follows instructions well enough to draft a description."
			);
		case "commitGeneration":
		case "consultTool":
		case "quickFix":
		case "reviewComments":
			return l10n.t("The model answered with no text. Try again, or pick a different model.");
	}
}

/**
 * What a probe that DID answer says: the count and the vocabulary of what came
 * back, never the text itself. Exhaustive like its sibling above, so a new
 * model-picking feature has to choose its vocabulary rather than inherit one.
 */
function probeAnswerText(feature: FeatureModelId, characters: number): string {
	switch (feature) {
		case "inlineCompletions":
			return characters === 1
				? l10n.t("Completion received - 1 character")
				: l10n.t("Completion received - {0} characters", characters);
		case "prGeneration":
			// The PR probe returns the parsed title, so the count is the title's.
			return characters === 1
				? l10n.t("Title received - 1 character")
				: l10n.t("Title received - {0} characters", characters);
		case "commitGeneration":
		case "consultTool":
		case "quickFix":
		case "reviewComments":
			return characters === 1
				? l10n.t("Reply received - 1 character")
				: l10n.t("Reply received - {0} characters", characters);
	}
}

/**
 * One declared entry's inline secret values, for the edit form's on-demand
 * prefill (the readInlineSecrets request). The entry resolves through
 * acceptedEntry and must still match the DISPLAYED identity the form sends:
 * a same-label replacement racing the prefill gets an empty answer, never its
 * inline values into a form showing another entry. The check is blob-free by
 * construction - inline locations derive from the entry alone, so only fields
 * the identity showed as "settings" are compared and returned. Fields stored
 * securely or absent get NO key: their values must never reach the webview.
 * The returned values are never logged.
 */
export function readInlineSecretValues(
	raw: unknown,
	replace: ReplacedEntryIdentity
): Readonly<Partial<Record<SecretFieldId, string>>> {
	const accepted = acceptedEntry(raw, replace.label);
	if (accepted === undefined || !nonSecretIdentityMatches(accepted.entry, replace)) {
		return {};
	}
	const values = inlineSecretValues(accepted.entry);
	// Location agreement, per field: an inline value where the form displayed
	// none (or the reverse) is a different entry, and nothing is prefilled.
	if (SECRET_FIELD_IDS.some((field) => (values[field] !== undefined) !== (replace.secrets[field] === "settings"))) {
		return {};
	}
	return values;
}

/**
 * An acked intent's success notice: plain text renders as the quiet success,
 * the object form adds a tone. Only the draft probe's nothing-to-serve
 * outcomes warn today - the shared zero-model and needs-declare vocabulary,
 * never a green result over nothing to serve.
 */
export type IntentAckNotice = string | { readonly message: string; readonly tone: IntentAckTone };

/**
 * Execute one validated intent against the injected environment. Resolves to
 * an optional user-facing notice for the success ack: adoptServer's caveat,
 * and testServerDraft's static classification plus model count.
 * Throws on constraint violations without logging; the panel controller is
 * the boundary that logs and reports the failure back to the webview.
 */
export async function executeDashboardIntent(
	intent: DashboardIntent,
	env: IntentEnvironment
): Promise<IntentAckNotice | undefined> {
	switch (intent.method) {
		case "setNumberSetting": {
			const problem = validateNumberSetting(intent.payload.setting, intent.payload.value);
			if (problem !== undefined) {
				throw new DashboardValidationError(problem);
			}
			await env.updateSetting(intent.payload.setting, intent.payload.value);
			return undefined;
		}
		case "setBooleanSetting":
			await env.updateSetting(intent.payload.setting, intent.payload.value);
			return undefined;
		case "resetSetting":
			// Removes the key from the highest-precedence scope that sets it
			// (workspaceFolder > workspace > user), which is what the native
			// Settings editor's reset does in that scope. Deliberately not
			// updateSetting's write-scope rule, which never targets the folder
			// scope and would leave a folder value standing.
			await env.removeSetting(intent.payload.setting);
			return undefined;
		case "revealSetting":
			// The schema already pinned the setting to REVEALABLE_SETTING_IDS; the
			// command resolves the full "litellm-vscode-chat.<key>" itself and is
			// best-effort by design.
			await env.executeCommand(INTERNAL_CMD.openSettingKey, intent.payload.setting);
			return undefined;
		case "setModelParameters": {
			const problem = validateModelParametersRecord(intent.payload.value);
			if (problem !== undefined) {
				throw new DashboardValidationError(problem);
			}
			await env.updateSetting(MODEL_PARAMETERS_SETTING_KEY, intent.payload.value);
			return undefined;
		}
		case "setModelCapabilities": {
			// The same reserved-key gate as the parameters record; the capability
			// vocabulary stays with the resolver's lenient, diagnosing parse.
			const problem = validateModelParametersRecord(intent.payload.value);
			if (problem !== undefined) {
				throw new DashboardValidationError(problem);
			}
			await env.updateSetting(MODEL_CAPABILITIES_SETTING_KEY, intent.payload.value);
			return undefined;
		}
		case "setUsageStatusBar":
			await env.updateSetting(USAGE_STATUS_BAR_SETTING_KEY, intent.payload.value);
			return undefined;
		case "setTokenEstimation":
			// The tokenizer wiring reacts to the configuration change like a hand
			// edit of settings.json.
			await env.updateSetting(TOKEN_ESTIMATION_SETTING_KEY, intent.payload.value);
			return undefined;
		case "setCurrencySymbol":
			// Free text by design (any currency reads as its owner wrote it);
			// display-only, length-bounded by the schema, and never sent anywhere.
			await env.updateSetting(CURRENCY_SYMBOL_SETTING_KEY, intent.payload.value);
			return undefined;
		case "setAdditionalToolSchemaKeywords": {
			// Empty and prototype-polluting names are refused rather than silently
			// dropped: the dashboard's editor already trims empties away, so
			// anything else is a bypassing caller. Written deduplicated in the
			// given order - the canonical form normalization would produce anyway.
			if (intent.payload.values.some((value) => value.length === 0 || isUnsafeRecordKey(value))) {
				throw new DashboardValidationError(
					`${l10n.t("Tool schema keywords must be plain, non-empty names, e.g. propertyNames.")}\n${l10n.t(
						"setting {0}: allowed range {1}",
						`${CONFIG_SECTION}.${ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY}`,
						"plain non-empty strings"
					)}`
				);
			}
			await env.updateSetting(ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY, [...new Set(intent.payload.values)]);
			return undefined;
		}
		case "setUiTheme":
			// Writing the setting is the whole intent: the configuration change
			// re-pushes state and the webview restamps the root element from it,
			// so the picker and a hand edit travel the same path.
			await env.updateSetting(UI_THEME_SETTING_KEY, intent.payload.value);
			return undefined;
		case "setUiAccent":
			await env.updateSetting(UI_ACCENT_SETTING_KEY, intent.payload.value);
			return undefined;
		case "setFeatureModel": {
			const key = FEATURE_MODEL_SETTING_KEYS[intent.payload.feature];
			if (intent.payload.value === null) {
				// Clearing the pick resets the setting instead of writing the literal
				// null: the default IS null, and a written null would mark the row
				// modified while saying nothing.
				await env.removeSetting(key);
				return undefined;
			}
			// The getter trims both halves, so the canonical trimmed form is
			// written; a value that trims away entirely is a bypassing caller.
			const server = intent.payload.value.server.trim();
			const model = intent.payload.value.model.trim();
			if (server.length === 0 || model.length === 0) {
				throw new DashboardValidationError(
					`${l10n.t("Pick a server and model, or Not set to clear the pick.")}\n${l10n.t(
						"setting {0}: allowed range {1}",
						`${CONFIG_SECTION}.${key}`,
						"non-empty server label and model ID"
					)}`
				);
			}
			await env.updateSetting(key, { server, model });
			return undefined;
		}
		case "setCommitPrompt":
			// Verbatim, like the currency symbol (model-facing text; whitespace can
			// be intended); the empty string resets the setting so the built-in
			// instruction applies without a modified mark.
			if (intent.payload.value.length === 0) {
				await env.removeSetting(COMMIT_GENERATION_PROMPT_SETTING_KEY);
			} else {
				await env.updateSetting(COMMIT_GENERATION_PROMPT_SETTING_KEY, intent.payload.value);
			}
			return undefined;
		case "setLanguageFilter": {
			// A partial patch: each dashboard row sends only its own half, and the
			// merge onto the STORED filter happens here on the chained channel, so
			// two quick writes from different rows can never revert each other.
			if (intent.payload.mode === undefined && intent.payload.languages === undefined) {
				// The rows always name their own field; an empty patch is a
				// bypassing caller.
				throw new DashboardValidationError(
					`${l10n.t("A language filter change names a mode, languages, or both.")}\n${l10n.t(
						"setting {0}: allowed range {1}",
						`${CONFIG_SECTION}.${INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY}`,
						"mode and/or languages"
					)}`
				);
			}
			const current = normalizeInlineLanguageFilter(env.readSetting(INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY));
			let languages = current.languages;
			if (intent.payload.languages !== undefined) {
				// Entries that trim away are refused rather than dropped: the row's
				// editor already trims empties out, so anything else is a bypassing
				// caller. Written trimmed and deduplicated in the given order - the
				// canonical form normalization would produce anyway.
				const trimmed = intent.payload.languages.map((value) => value.trim());
				if (trimmed.some((value) => value.length === 0)) {
					throw new DashboardValidationError(
						`${l10n.t("Language IDs must be plain, non-empty identifiers, e.g. typescript.")}\n${l10n.t(
							"setting {0}: allowed range {1}",
							`${CONFIG_SECTION}.${INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY}`,
							"plain non-empty strings"
						)}`
					);
				}
				languages = [...new Set(trimmed)];
			}
			const mode = intent.payload.mode ?? current.mode;
			if (mode === "block" && languages.length === 0) {
				// Block-nothing IS the default: resetting instead of writing it keeps
				// the row unmarked, like the other empty-equals-default writes.
				await env.removeSetting(INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY);
			} else {
				await env.updateSetting(INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY, {
					mode,
					languages: [...languages],
				});
			}
			return undefined;
		}
		case "setUsageAlertThresholds": {
			// Out-of-range values are refused rather than silently dropped: the
			// dashboard's editor validates the same rule, so anything else is a
			// bypassing caller. Written in the canonical deduplicated ascending
			// form the normalization pipeline would produce anyway.
			const invalid = intent.payload.values.some((value) => !isUsableThreshold(value));
			if (invalid) {
				throw new DashboardValidationError(
					`${l10n.t("Alert thresholds must be above 0% and at most 100% - enter values like 80% or 0.8.")}\n${l10n.t(
						"setting {0}: allowed range {1}",
						`${CONFIG_SECTION}.${USAGE_ALERT_THRESHOLDS_SETTING_KEY}`,
						"0 < value <= 1"
					)}`
				);
			}
			await env.updateSetting(USAGE_ALERT_THRESHOLDS_SETTING_KEY, usableThresholds(intent.payload.values));
			return undefined;
		}
		case "refreshCatalog":
			// Fire-and-forget: the wiring pushes state when the refresh settles,
			// and the settings row's catalog status carries the outcome (no toast).
			env.refreshCatalogNow();
			return undefined;
		case "refreshUsage":
			env.refreshUsageNow();
			return undefined;
		case "saveServerSetting": {
			const problem = validateSaveServerSetting(intent.payload.server, intent.payload.secrets);
			if (problem !== undefined) {
				throw new DashboardValidationError(problem);
			}
			await applySaveServerSetting(intent.payload, env);
			return undefined;
		}
		case "testServerDraft": {
			const problem = validateTestServerDraft(intent.payload.server, intent.payload.secrets);
			if (problem !== undefined) {
				throw new DashboardValidationError(problem);
			}
			const outcome = await applyTestServerDraft(intent.payload, env);
			// Static classification plus counts; never payload or response text.
			if (outcome.kind === "expected-failure") {
				if (outcome.declaredCount === 0) {
					// The needs-declare state the hero and notifier warn about: the
					// failure is declared normal, but nothing serves through it until
					// the draft lists model IDs under Declared models.
					return {
						message: l10n.t(
							"Discovery failed (expected) and no models are declared. Add model IDs to Declared models."
						),
						tone: "warning",
					};
				}
				return outcome.declaredCount === 1
					? l10n.t("Discovery failed (expected) - serving 1 declared model")
					: l10n.t("Discovery failed (expected) - serving {0} declared models", outcome.declaredCount);
			}
			if (outcome.declaredCount > 0) {
				return outcome.modelCount === 1
					? l10n.t("Connected - 1 model (declared)")
					: l10n.t("Connected - {0} models ({1} declared)", outcome.modelCount, outcome.declaredCount);
			}
			if (outcome.modelCount === 0) {
				// The shared zero-model vocabulary (one server answered, nothing to
				// serve): the same warning the bar, hero, and notifier give this
				// state, never a green success over an empty listing.
				return { message: l10n.t("Connected - 0 models. {0}", zeroModelExplanation(0, 1)), tone: "warning" };
			}
			return outcome.modelCount === 1
				? l10n.t("Connected - 1 model")
				: l10n.t("Connected - {0} models", outcome.modelCount);
		}
		case "testFeatureModel": {
			const probe = env.featureProbes[intent.payload.feature];
			if (probe === undefined) {
				// The button renders only where a probe exists, so this is a
				// bypassing caller (or a stale page across an upgrade).
				throw new DashboardValidationError(
					l10n.t("This feature has no model test; pick the model and use it directly.")
				);
			}
			let text: string | undefined;
			try {
				text = await probe(intent.payload.model);
			} catch (error) {
				// The transport's classified errors render at the button like the
				// draft probe's: the message is the transport's own two-part text,
				// and the classification drives the row's setup hints.
				if (error instanceof MirroredError) {
					throw new DashboardValidationError(error.message, { classification: transportClassificationOf(error) });
				}
				throw error;
			}
			if (text === undefined || text === "") {
				// Counts and classifications only: never a probe's reply text.
				return { message: probeEmptyAnswerText(intent.payload.feature), tone: "warning" };
			}
			return probeAnswerText(intent.payload.feature, text.length);
		}
		case "removeServerSetting": {
			const entries = rawServerEntries(env.readServersSetting());
			const next = entries.filter((entry) => !entryHasLabel(entry, intent.payload.label));
			if (next.length === entries.length) {
				throw new DashboardValidationError(
					l10n.t("No servers setting entry has this label; the server is managed outside the setting")
				);
			}
			// The label's secure-side secrets are kept on purpose: a hand-written
			// re-add of the entry still resolves them, and the provider group
			// itself survives anyway (VS Code offers no programmatic group
			// removal). A dashboard create over the label wipes them instead - the
			// form showed no credentials, so none may resurrect (saveServer.ts).
			await env.writeServersSetting(next);
			env.requestServerSync();
			return undefined;
		}
		case "declareExpectedFailure": {
			const entries = rawServerEntries(env.readServersSetting());
			// The entry written is the one the dashboard row described, never a
			// rejected same-label sibling.
			const accepted = acceptedEntry(entries, intent.payload.label);
			const rawEntry = accepted !== undefined ? entries[accepted.index] : undefined;
			if (!isRecord(rawEntry) || accepted === undefined) {
				throw new DashboardValidationError(
					l10n.t("No servers setting entry has this label; the server is managed outside the setting")
				);
			}
			const category = intent.payload.category;
			const discovery = isRecord(rawEntry.discovery) ? rawEntry.discovery : {};
			const declared = Array.isArray(discovery.expectedFailures) ? discovery.expectedFailures : [];
			if (declared.includes(category)) {
				// Already declared (a stale row, a double click): the ack is
				// truthful with nothing written.
				return undefined;
			}
			// Everything else on the entry - junk keys included - is preserved
			// verbatim; only discovery.expectedFailures grows by one category. The
			// one exception: a non-record `discovery` or a non-array
			// `expectedFailures` is replaced by the valid shape, since preserving
			// it would leave the declaration unable to land at all.
			const next = [...entries];
			next[accepted.index] = {
				...rawEntry,
				discovery: { ...discovery, expectedFailures: [...declared, category] },
			};
			await env.writeServersSetting(next);
			env.requestServerSync();
			return undefined;
		}
		case "adoptServer":
			return applyAdoptServer(intent.payload, env);
		case "hideExternalServer": {
			const baseUrl = intent.payload.baseUrl.trim();
			if (baseUrl.length === 0 || !isUsableHttpUrl(baseUrl)) {
				// The "fieldId:" prefix stays an ASCII identifier outside the
				// translation: sectionFailureText routes the failure by it.
				throw new DashboardValidationError(`baseUrl: ${l10n.t("not a usable http(s) URL")}`);
			}
			// Resolution binds the opaque handle to a group that is external RIGHT
			// NOW: a stale or forged intent cannot tombstone a declared group's
			// identity or a group at another host.
			const identity = env.resolveExternalGroup(baseUrl, intent.payload.sourceHandle);
			if (identity === undefined) {
				throw new DashboardValidationError(
					`${l10n.t(
						"This row no longer matches a hideable server - it may have just been adopted or removed, or it predates provider groups."
					)}\n${l10n.t(
						"The row did not resolve to an external VS Code provider group. Legacy servers are removed with the {0} command instead.",
						manageCommandTitle()
					)}`
				);
			}
			await env.hideGroup(identity);
			return undefined;
		}
		case "unhideServer": {
			if (intent.payload.label.trim().length === 0) {
				throw new DashboardValidationError(`label: ${l10n.t("enter a label")}`);
			}
			// The identity is echoed back verbatim (no trimming): the webview
			// sends exactly what the HiddenGroup row carried.
			const removed = await env.unhideGroup({ label: intent.payload.label, baseUrl: intent.payload.baseUrl });
			if (!removed) {
				throw new DashboardValidationError(l10n.t("No hidden group matches this identity; it may already be visible"));
			}
			return undefined;
		}
		case "executeCommand": {
			const { command, args } = COMMANDS_BY_ID[intent.payload.command];
			await env.executeCommand(command, ...args);
			return undefined;
		}
		case "syncModels": {
			// The same registered command the palette and the status bar run, so
			// there is one definition of what a sync is. What sets this method
			// apart from executeCommand is its outcome class: this ack answers
			// only once the pass has settled, and a second caller arriving
			// mid-pass joins the running one rather than being waved through.
			await env.executeCommand(CMD.syncModels);
			return undefined;
		}
	}
}
