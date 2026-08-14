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
	SaveServerPayload,
	SecretDirective,
} from "../../dashboard/endpoints";
import { unitBehavior } from "../../dashboard/presenters";
import { isUsableHttpUrl } from "../../dashboard/serverForm";
import { CMD, INTERNAL_CMD, manageCommandTitle } from "../../shared/config/commandIds";
import type { NumberSettingId } from "../../shared/config/settingSpec";
import {
	ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY,
	CONFIG_SECTION,
	CURRENCY_SYMBOL_SETTING_KEY,
	NUMBER_SETTING_SPECS,
	TOKEN_ESTIMATION_SETTING_KEY,
	UI_ACCENT_SETTING_KEY,
	UI_THEME_SETTING_KEY,
} from "../../shared/config/settingSpec";
import {
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
	USAGE_STATUS_BAR_SETTING_KEY,
} from "../../shared/config/settings";
import type { TransportErrorClassification } from "../../shared/errorClassification";
import type { SecretFieldId } from "../../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { isValidHeaderName, isValidHeaderValue } from "../../shared/util/headers";
import { isRecord, isUnsafeRecordKey } from "../../shared/util/json";
import { EXTENSION_SETTINGS_FILTER } from "../servers/serverManagement";
import { acceptedEntry, inlineSecretValues } from "../servers/serverSync";
import type { AdoptableGroupCredentials } from "./adopt";
import { applyAdoptServer } from "./adopt";
import { applySaveServerSetting } from "./saveServer";
import type { DraftConnection } from "./testDraftConnection";
import { applyTestServerDraft } from "./testDraftConnection";

/**
 * A constraint violation detected by this module's own validation. Its
 * message may travel to the webview verbatim so the user sees which rule
 * failed, but never to the log: some messages quote an entered key (a header
 * name, a modelParameters prefix), the entered text can be anything the user
 * pasted, and the log buffer feeds public issue reports. The panel boundary
 * logs a classification only.
 */
export class DashboardValidationError extends Error {
	/**
	 * The transport classification behind the failure, when a probe supplied
	 * one: enum ids and a status number only, never message text, so it rides
	 * both the fail envelope and the boundary's rejection log
	 * line.
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
 * effect the user asked for did not, so the intent must report failure with an
 * accurate way forward. Like DashboardValidationError, the message is written
 * to be safe for the webview (actionable, never a value) and the panel
 * boundary logs a classification only.
 */
export class DashboardOperationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DashboardOperationError";
	}
}

/** The effects an intent can have; injected so intents are testable without vscode. */
export interface IntentEnvironment {
	/** Write one litellm-vscode-chat.* setting (the key is relative to the section). */
	updateSetting(key: string, value: unknown): Promise<void>;
	/** Remove one litellm-vscode-chat.* setting from the highest-precedence scope that sets it (resolveConfiguredScope). */
	removeSetting(key: string): Promise<void>;
	executeCommand(command: string, ...args: readonly unknown[]): Thenable<unknown>;
	/** The servers array a write would replace (the user-scope value; the setting is machine-scoped). */
	readServersSetting(): unknown;
	writeServersSetting(value: readonly unknown[]): Promise<void>;
	/** Write one secure-side secret field for a label; undefined deletes it. The value must never be logged. */
	storeServerSecret(label: string, field: SecretFieldId, value: string | undefined): Promise<void>;
	/** A label's secure-side blob; read for pairing validation and write rollback, never logged. */
	readServerSecrets(label: string): Promise<Partial<Readonly<Record<SecretFieldId, string>>>>;
	/** Copy a label's secure-side secrets to a new name (the additive half of a rename). */
	copyServerSecrets(fromLabel: string, toLabel: string): Promise<void>;
	/** Delete a label's whole secure-side blob (the cleanup half of a rename). */
	deleteServerSecrets(label: string): Promise<void>;
	/** Ask the sync engine for a pass; secure-only changes fire no configuration event. */
	requestServerSync(): void;
	/**
	 * The live credentials of the external group an adopt intent names by its
	 * opaque row handle, from the provider's in-memory status window. Resolves
	 * only groups that are still external and still at `baseUrl` (see
	 * resolveAdoptableCredentials). The returned values go straight into the
	 * setting or SecretStorage and are never logged.
	 */
	resolveAdoptionCredentials(baseUrl: string, sourceHandle: string): AdoptableGroupCredentials | undefined;
	/**
	 * The identity (status label and base URL) of the external group a hide
	 * intent names by its opaque row handle; same resolution rules as the
	 * adopt path (still external, still at `baseUrl`), no credential material.
	 */
	resolveExternalGroup(baseUrl: string, sourceHandle: string): { label: string; baseUrl: string } | undefined;
	/** Persist one removed-group tombstone; the group answers with no models until unhidden. */
	hideGroup(identity: { label: string; baseUrl: string }): Promise<void>;
	/** Clear one removed-group tombstone. Resolves false when no tombstone matched the identity. */
	unhideGroup(identity: { label: string; baseUrl: string }): Promise<boolean>;
	/** Classification-only logging (the buffer feeds public issue reports); never a payload value. */
	log(message: string, data?: unknown): void;
	/**
	 * One discovery probe against a fully resolved draft connection (the
	 * testServerDraft intent). Read-only by contract - no settings write, no
	 * group or status mutation, no caching across probes - bounded by the
	 * discovery.timeout setting, and the connection's credential values are
	 * never logged. Resolves to the discovered raw model IDs (the caller
	 * counts them and checks declared-ID inertness against them); throws the
	 * transport's classified error on failure.
	 */
	probeDraftConnection(connection: DraftConnection): Promise<readonly string[]>;
	/**
	 * Kick one immediate OpenRouter catalog refresh (the settings row's
	 * Refresh). Fire-and-forget from the intent's view: the wiring re-pushes
	 * state when the refresh settles, and the row status carries the outcome.
	 */
	refreshCatalogNow(): void;
	/** Kick one immediate usage refresh (the Usage tab's Refresh now); same fire-and-forget contract. */
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
 * the id stays an ASCII identifier outside the translation, like the form
 * messages' fieldId prefixes.
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
 * Cross-field pairing (OAuth's token URL and client ID, the virtual key's
 * header and value) is enforced in applySaveServerSetting, where the resolved
 * secrets context exists. Returns the reason the intent is not applicable, or
 * undefined when it is. Reasons name fields, never values: payloads carry
 * secrets, and the message is echoed to the webview.
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
		// The same reserved-key rules the global setModelParameters intent
		// enforces; the message already names the offending rule.
		const problem = validateModelParametersRecord(server.modelParameters);
		if (problem !== undefined) {
			return `modelParameters: ${problem}`;
		}
	}
	// Same record-of-records shape, same reserved-key rules; capability
	// vocabulary and value typing stay with the resolver's parse, which
	// diagnoses rather than refuses (the setting is lenient by design).
	const capabilitiesProblem = validateModelParametersRecord(server.modelCapabilities);
	if (capabilitiesProblem !== undefined) {
		return `modelCapabilities: ${capabilitiesProblem}`;
	}
	// Mirrors the form's header-row rules (recordDraft's parse) and the
	// request path's normalizeCustomHeaders acceptance: names and the value
	// charset are refused here so a save can never "succeed" on a header the
	// wire would drop. Header NAMES are structural configuration and may be
	// echoed; values never are.
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
	return undefined;
}

/**
 * The value constraints on a testServerDraft intent: the connection-relevant
 * subset of the save rules. The label deliberately goes unchecked (empty and
 * reserved labels probe fine; the label only addresses "keep" resolution),
 * and cross-field pairing is enforced in applyTestServerDraft, where the
 * resolved secrets exist - the same split the save path uses.
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
 * Whether a raw entry carries this label. Compared trimmed on both sides:
 * parseServersSetting trims labels, so a hand-written `" Prod "` entry
 * displays as "Prod" and its edits and removals must find it again. Removal
 * matches every raw carrier of the label on purpose; per-entry resolution
 * (the edit prefill, the save target) goes through acceptedEntry instead,
 * so it lands on the same entry the parsed views describe.
 */
function entryHasLabel(entry: unknown, label: string): entry is Record<string, unknown> {
	return isRecord(entry) && typeof entry.label === "string" && entry.label.trim() === label.trim();
}

/**
 * One declared entry's inline secret values, for the edit form's on-demand
 * prefill (the readInlineSecrets request). The entry resolves through
 * acceptedEntry, so the values come from exactly the entry the dashboard
 * row describes (a rejected same-label sibling cannot shadow it, and a label
 * the parser rejects yields nothing), and the values come from
 * inlineSecretValues, the sync engine's own rule for what counts as inline -
 * so the prefilled fields are exactly the ones whose pushed location reads
 * "settings". Fields stored securely or absent get NO key: their values must
 * never reach the webview. The returned values are never logged.
 */
export function readInlineSecretValues(raw: unknown, label: string): Readonly<Partial<Record<SecretFieldId, string>>> {
	const accepted = acceptedEntry(raw, label);
	return accepted === undefined ? {} : inlineSecretValues(accepted.entry);
}

/**
 * Execute one validated intent against the injected environment. Resolves to
 * an optional user-facing message for the success notice: adoptServer's
 * caveat, and testServerDraft's static classification plus model count.
 * Throws on constraint violations without logging; the panel controller is
 * the boundary that logs and reports the failure back to the webview.
 */
export async function executeDashboardIntent(
	intent: DashboardIntent,
	env: IntentEnvironment
): Promise<string | undefined> {
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
			// Settings editor's reset does in that scope: the next scope's value
			// or the default shows through, and repeated resets walk down the
			// scopes. Deliberately not updateSetting's write-scope rule, which
			// never targets the folder scope and would leave a folder value
			// standing while removing a hidden lower-scope one.
			await env.removeSetting(intent.payload.setting);
			return undefined;
		case "revealSetting":
			// The schema already pinned the setting to REVEALABLE_SETTING_IDS
			// (only known ids cross the boundary); the command resolves the full
			// "litellm-vscode-chat.<key>" itself and is best-effort by design.
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
			// vocabulary itself stays with the resolver's lenient, diagnosing parse.
			const problem = validateModelParametersRecord(intent.payload.value);
			if (problem !== undefined) {
				throw new DashboardValidationError(problem);
			}
			await env.updateSetting(MODEL_CAPABILITIES_SETTING_KEY, intent.payload.value);
			return undefined;
		}
		case "setUsageStatusBar":
			// The schema already pinned the value to the closed mode vocabulary.
			await env.updateSetting(USAGE_STATUS_BAR_SETTING_KEY, intent.payload.value);
			return undefined;
		case "setTokenEstimation":
			// Closed vocabulary, pinned by the schema; the tokenizer wiring reacts
			// to the configuration change like a hand edit of settings.json.
			await env.updateSetting(TOKEN_ESTIMATION_SETTING_KEY, intent.payload.value);
			return undefined;
		case "setCurrencySymbol":
			// Free text by design (any currency reads as its owner wrote it);
			// display-only, length-bounded by the schema, and never sent anywhere.
			await env.updateSetting(CURRENCY_SYMBOL_SETTING_KEY, intent.payload.value);
			return undefined;
		case "setAdditionalToolSchemaKeywords": {
			// Empty and prototype-polluting names are refused here rather than
			// silently dropped: the dashboard's editor already trims empties away,
			// so anything else is a bypassing caller. Written deduplicated in the
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
			// Closed vocabularies, pinned by the schema. Writing the setting is the
			// whole intent: the configuration change re-pushes state, and the
			// webview restamps the root element from it, so the picker and a hand
			// edit of settings.json travel the same path.
			await env.updateSetting(UI_THEME_SETTING_KEY, intent.payload.value);
			return undefined;
		case "setUiAccent":
			await env.updateSetting(UI_ACCENT_SETTING_KEY, intent.payload.value);
			return undefined;
		case "setUsageAlertThresholds": {
			// Out-of-range values are refused here rather than silently dropped:
			// the dashboard's editor validates the same rule, so anything else is
			// a bypassing caller. Written sorted and deduplicated - the canonical
			// form normalization would produce anyway.
			const invalid = intent.payload.values.some((value) => !(value > 0 && value <= 1));
			if (invalid) {
				throw new DashboardValidationError(
					`${l10n.t("Alert thresholds must be above 0% and at most 100% - enter values like 80% or 0.8.")}\n${l10n.t(
						"setting {0}: allowed range {1}",
						`${CONFIG_SECTION}.${USAGE_ALERT_THRESHOLDS_SETTING_KEY}`,
						"0 < value <= 1"
					)}`
				);
			}
			const canonical = [...new Set(intent.payload.values)].sort((a, b) => a - b);
			await env.updateSetting(USAGE_ALERT_THRESHOLDS_SETTING_KEY, canonical);
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
			// Static classification plus counts, composed here so the webview
			// renders it verbatim; never payload or response text.
			if (outcome.kind === "expected-failure") {
				return outcome.declaredCount === 1
					? l10n.t("Discovery failed (expected) - serving 1 declared model")
					: l10n.t("Discovery failed (expected) - serving {0} declared models", outcome.declaredCount);
			}
			if (outcome.declaredCount > 0) {
				return outcome.modelCount === 1
					? l10n.t("Connected - 1 model (declared)")
					: l10n.t("Connected - {0} models ({1} declared)", outcome.modelCount, outcome.declaredCount);
			}
			return outcome.modelCount === 1
				? l10n.t("Connected - 1 model")
				: l10n.t("Connected - {0} models", outcome.modelCount);
		}
		case "removeServerSetting": {
			const entries = rawServerEntries(env.readServersSetting());
			const next = entries.filter((entry) => !entryHasLabel(entry, intent.payload.label));
			if (next.length === entries.length) {
				throw new DashboardValidationError(
					l10n.t("No servers setting entry has this label; the server is managed outside the setting")
				);
			}
			// The label's secure-side secrets are kept on purpose: re-adding the
			// label picks them up again, and the provider group itself survives
			// anyway (VS Code offers no programmatic group removal).
			await env.writeServersSetting(next);
			env.requestServerSync();
			return undefined;
		}
		case "declareExpectedFailure": {
			const entries = rawServerEntries(env.readServersSetting());
			// Resolution agrees with the parsed world (the saveServerSetting rule):
			// the entry written is the one the dashboard row described, never a
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
				// Already declared (a stale row, a double click): the ack is truthful
				// with nothing written.
				return undefined;
			}
			// Everything else on the entry - junk keys included - is preserved
			// verbatim; only discovery.expectedFailures grows by one category. The
			// one deliberate exception: a non-record `discovery` or a non-array
			// `expectedFailures` (shapes the setting parser already reports and
			// ignores) is replaced by the valid shape, since preserving it would
			// leave the declaration unable to land at all.
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
				// translation: sectionFailureText matches it against the internal
				// field names to route the failure onto the right form section.
				throw new DashboardValidationError(`baseUrl: ${l10n.t("not a usable http(s) URL")}`);
			}
			// Resolution binds the opaque handle to a group that is external
			// RIGHT NOW: a stale or forged intent cannot tombstone a declared
			// group's identity or a group at another host.
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
			// The same registered command the palette and the status bar run,
			// read from the shared command declarations, so there is one
			// definition of what a sync is. What sets this method apart from
			// executeCommand is its outcome class: executeCommand is
			// fire-and-forget, while this ack answers only once the pass has
			// settled - and a second caller arriving mid-pass joins the running
			// one rather than being waved through, so the answer always
			// describes a pass that ran.
			await env.executeCommand(CMD.syncModels);
			return undefined;
		}
	}
}
