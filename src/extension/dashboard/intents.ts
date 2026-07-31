/**
 * Validation and execution of webview intents. Intents arrive already
 * schema-checked (intentSchema.ts); this module holds the value constraints
 * the schema cannot express and dispatches each validated intent against the
 * injected IntentEnvironment, so everything is unit-testable without a
 * webview or a real configuration store. panel.ts owns the vscode wiring.
 */

import { CMD, INTERNAL_CMD } from "../../shared/config/commandIds";
import { HEADERS_SETTING_KEY, MODEL_PARAMETERS_SETTING_KEY } from "../../shared/config/settings";
import { isValidHeaderName, isValidHeaderValue } from "../../shared/util/headers";
import { isRecord, isUnsafeRecordKey } from "../../shared/util/json";
import { EXTENSION_SETTINGS_FILTER } from "../serverManagement";
import { acceptedEntry, inlineSecretValues } from "../serverSync";
import type { AdoptableGroupCredentials } from "./adopt";
import { applyAdoptServer } from "./adopt";
import type { DashboardIntent } from "./intentSchema";
import type {
	DashboardCommandId,
	HeaderScalar,
	NumberSettingId,
	SaveServerPayload,
	SecretDirective,
	SecretFieldId,
} from "./protocol";
import { NUMBER_SETTINGS, SECRET_FIELD_IDS } from "./protocol";
import { applySaveServerSetting } from "./saveServer";
import { isUsableHttpUrl } from "./serverForm";

/**
 * A constraint violation detected by this module's own validation. Its
 * message may travel to the webview verbatim so the user sees which rule
 * failed, but never to the log: some messages quote an entered key (a header
 * name, a modelParameters prefix), the entered text can be anything the user
 * pasted, and the log buffer feeds public issue reports. The panel boundary
 * logs a classification only.
 */
export class DashboardValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DashboardValidationError";
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
	/** Classification-only logging (the buffer feeds public issue reports); never a payload value. */
	log(message: string, data?: unknown): void;
}

const COMMANDS_BY_ID: Record<DashboardCommandId, { command: string; args: readonly unknown[] }> = {
	manageServers: { command: INTERNAL_CMD.manageServers, args: [] },
	syncModels: { command: CMD.syncModels, args: [] },
	testConnection: { command: CMD.testConnection, args: [] },
	showDiagnostics: { command: CMD.showDiagnostics, args: [] },
	openSettings: { command: "workbench.action.openSettings", args: [EXTENSION_SETTINGS_FILTER] },
};

/**
 * Value constraints the message schema cannot express. Returns the reason a
 * number is not writable, or undefined when it is.
 */
export function validateNumberSetting(setting: NumberSettingId, value: number | null): string | undefined {
	const spec = NUMBER_SETTINGS[setting];
	if (value === null) {
		return spec.nullable ? undefined : `${setting} requires a number`;
	}
	if (value < spec.minimum) {
		return `${setting} must be at least ${spec.minimum}`;
	}
	return undefined;
}

/**
 * Header-record parity with the request path (shared/config/settings silently drops
 * offenders at request time): names must be RFC 9110 tokens and values must
 * pass the same isValidHeaderValue predicate normalizeCustomHeaders applies,
 * so an accepted write is a header that is actually sent. Also refuses
 * prototype-polluting keys, mirroring the editors' validation for messages
 * that bypassed them.
 */
export function validateHeadersRecord(value: Readonly<Record<string, HeaderScalar>>): string | undefined {
	for (const [name, headerValue] of Object.entries(value)) {
		if (isUnsafeRecordKey(name)) {
			return `"${name}" is a reserved name and cannot be used as a header name`;
		}
		if (!isValidHeaderName(name)) {
			return `"${name}" is not a valid HTTP header name`;
		}
		if (!isValidHeaderValue(String(headerValue))) {
			return `The value of header "${name}" cannot be sent as an HTTP header`;
		}
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
	if (server.modelParameters !== undefined) {
		// The same reserved-key rules the global setModelParameters intent
		// enforces; the message already names the offending rule.
		const problem = validateModelParametersRecord(server.modelParameters);
		if (problem !== undefined) {
			return `modelParameters: ${problem}`;
		}
	}
	return undefined;
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
 * an optional user-facing caveat for the success notice (only adoptServer
 * produces one today). Throws on constraint violations without logging; the
 * panel controller is the boundary that logs and reports the failure back to
 * the webview.
 */
export async function executeDashboardIntent(
	intent: DashboardIntent,
	env: IntentEnvironment
): Promise<string | undefined> {
	switch (intent.type) {
		case "setNumberSetting": {
			const problem = validateNumberSetting(intent.setting, intent.value);
			if (problem !== undefined) {
				throw new DashboardValidationError(problem);
			}
			await env.updateSetting(intent.setting, intent.value);
			return undefined;
		}
		case "setBooleanSetting":
			await env.updateSetting(intent.setting, intent.value);
			return undefined;
		case "resetSetting":
			// Removes the key from the highest-precedence scope that sets it
			// (workspaceFolder > workspace > user), which is what the native
			// Settings editor's reset does in that scope: the next scope's value
			// or the default shows through, and repeated resets walk down the
			// scopes. Deliberately not updateSetting's write-scope rule, which
			// never targets the folder scope and would leave a folder value
			// standing while removing a hidden lower-scope one.
			await env.removeSetting(intent.setting);
			return undefined;
		case "setModelParameters": {
			const problem = validateModelParametersRecord(intent.value);
			if (problem !== undefined) {
				throw new DashboardValidationError(problem);
			}
			await env.updateSetting(MODEL_PARAMETERS_SETTING_KEY, intent.value);
			return undefined;
		}
		case "setHeaders": {
			const problem = validateHeadersRecord(intent.value);
			if (problem !== undefined) {
				throw new DashboardValidationError(problem);
			}
			await env.updateSetting(HEADERS_SETTING_KEY, intent.value);
			return undefined;
		}
		case "saveServerSetting": {
			const problem = validateSaveServerSetting(intent.server, intent.secrets);
			if (problem !== undefined) {
				throw new DashboardValidationError(problem);
			}
			await applySaveServerSetting(intent, env);
			return undefined;
		}
		case "removeServerSetting": {
			const entries = rawServerEntries(env.readServersSetting());
			const next = entries.filter((entry) => !entryHasLabel(entry, intent.label));
			if (next.length === entries.length) {
				throw new DashboardValidationError(
					"No servers setting entry has this label; the server is managed outside the setting"
				);
			}
			// The label's secure-side secrets are kept on purpose: re-adding the
			// label picks them up again, and the provider group itself survives
			// anyway (VS Code offers no programmatic group removal).
			await env.writeServersSetting(next);
			env.requestServerSync();
			return undefined;
		}
		case "adoptServer":
			return applyAdoptServer(intent, env);
		case "executeCommand": {
			const { command, args } = COMMANDS_BY_ID[intent.command];
			await env.executeCommand(command, ...args);
			return undefined;
		}
	}
}
