/**
 * The agent tools' planner: tool input in, dashboard requests out. Pure and
 * vscode-free, so every rule here is provable in a bun test.
 *
 * Nothing is validated here beyond the tool's own grammar. Each plan is a list
 * of `{ method, payload }` pairs the wiring submits to the dashboard
 * controller, where parseDashboardRequest and executeDashboardIntent judge the
 * payload exactly as they judge the webview's. The method union is the
 * type-level fence: readInlineSecrets (secret values), executeCommand (export,
 * import, report), and the handshake are not constructible here.
 */

import type {
	DashboardMethod,
	ReplacedEntryIdentity,
	SaveServerPayload,
	SecretDirective,
} from "../../../dashboard/endpoints";
import type {
	DashboardServer,
	DashboardState,
	EditableDashboardServer,
	ScopedRecordSetting,
} from "../../../dashboard/viewModels";
import { isEditableServer } from "../../../dashboard/viewModels";
import type {
	AgentToolsSettingId,
	BooleanSettingId,
	FeatureModelId,
	NumberSettingId,
	SettingId,
} from "../../../shared/config/settingSpec";
import {
	AGENT_TOOLS_SETTING_KEYS,
	BOOLEAN_SETTING_SPECS,
	INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY,
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	NUMBER_SETTING_SPECS,
	SERVERS_SETTING_KEY,
} from "../../../shared/config/settingSpec";
import type { SecretFieldId } from "../../../shared/serverEntry";
import { pickNonSecretOptionalFields, SECRET_FIELD_IDS, secretDestination } from "../../../shared/serverEntry";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { displayUrl } from "../../../shared/util/displayUrl";
import { isRecord, recordFromKeys } from "../../../shared/util/json";
import type { AgentSecretDirective, AgentToolInput } from "./inputSchema";

/** The dashboard methods an agent tool may address; the excluded four are unrepresentable, not refused. */
type AgentReachableMethod = Exclude<
	DashboardMethod,
	"ready" | "readInlineSecrets" | "executeCommand" | "revealSetting"
>;

/** One request to submit; the payload is judged by the dashboard's own schema, never here. */
export interface AgentRequest {
	readonly method: AgentReachableMethod;
	readonly payload: unknown;
}

/**
 * Why a plan refused before anything was submitted. Classifications, rendered
 * into words at the wiring boundary; `detail` carries the identifiers the
 * words need (setting keys, labels, field names), never a secret value.
 */
export type RefusalReason =
	| "unknown-setting"
	| "setting-owned-by-tool"
	| "agent-tools-switch"
	| "server-not-found"
	| "server-not-declared"
	| "external-group-not-found"
	| "hidden-group-not-found"
	| "secret-locations-unproven"
	| "secret-value-refused"
	| "kept-secret-host-change"
	| "base-url-required"
	| "feature-model-not-set"
	| "model-not-found"
	| "nothing-to-change"
	| "language-filter-one-half";

/** A secret the user must type: the planner leaves the directive valueless and the wiring prompts. */
export interface SecretPrompt {
	readonly field: SecretFieldId;
	readonly location: "settings" | "secure";
}

export type ToolPlan =
	| { readonly kind: "requests"; readonly requests: readonly AgentRequest[]; readonly prompts: readonly SecretPrompt[] }
	| { readonly kind: "refused"; readonly reason: RefusalReason; readonly detail: Readonly<Record<string, string>> };

function requests(...list: AgentRequest[]): ToolPlan {
	return { kind: "requests", requests: list, prompts: [] };
}

function refused(reason: RefusalReason, detail: Record<string, string> = {}): ToolPlan {
	return { kind: "refused", reason, detail };
}

// ---------------------------------------------------------------------------
// set_setting: one (setting, value) pair to the intent that owns the setting
// ---------------------------------------------------------------------------

type SettingRoute = (value: unknown) => readonly AgentRequest[];

/** The settings set_setting may address: everything but the three structured families other tools own and this feature's own switches. */
type PlainSettingId = Exclude<
	SettingId,
	| typeof SERVERS_SETTING_KEY
	| typeof MODEL_PARAMETERS_SETTING_KEY
	| typeof MODEL_CAPABILITIES_SETTING_KEY
	| AgentToolsSettingId
>;

/** The plain settings with no scalar spec; the scalar families derive their routes from the spec tables below. */
type StructuredPlainSettingId = Exclude<PlainSettingId, NumberSettingId | BooleanSettingId>;

const valueRoute =
	(method: AgentReachableMethod): SettingRoute =>
	(value) => [{ method, payload: { value } }];

const valuesRoute =
	(method: AgentReachableMethod): SettingRoute =>
	(value) => [{ method, payload: { values: value } }];

const featureModelRoute =
	(feature: FeatureModelId): SettingRoute =>
	(value) => [{ method: "setFeatureModel", payload: { feature, value } }];

/**
 * One half per call, exactly the dashboard's grammar: each row sends only its
 * own half, and the intent reads the stored filter and merges. Two halves in
 * one call are refused rather than split into two requests, because the
 * second request's merge would read a filter the first one just moved between
 * scopes. A value that is not an object goes through as-is so the schema, not
 * this table, refuses it.
 */
const languageFilterRoute: SettingRoute = (value) => [{ method: "setLanguageFilter", payload: value }];

/** Total over the structured plain settings by type: a new one fails compilation until it names its intent. */
const STRUCTURED_SETTING_ROUTES = {
	"chat.additionalToolSchemaKeywords": valuesRoute("setAdditionalToolSchemaKeywords"),
	"chat.tokenEstimation": valueRoute("setTokenEstimation"),
	"usage.alertThresholds": valuesRoute("setUsageAlertThresholds"),
	"usage.statusBar": valueRoute("setUsageStatusBar"),
	"usage.currencySymbol": valueRoute("setCurrencySymbol"),
	"ui.theme": valueRoute("setUiTheme"),
	"ui.accent": valueRoute("setUiAccent"),
	"inlineCompletions.model": featureModelRoute("inlineCompletions"),
	"commitGeneration.model": featureModelRoute("commitGeneration"),
	"prGeneration.model": featureModelRoute("prGeneration"),
	"consultTool.model": featureModelRoute("consultTool"),
	"quickFix.model": featureModelRoute("quickFix"),
	"reviewComments.model": featureModelRoute("reviewComments"),
	"inlineCompletions.languageFilter": languageFilterRoute,
	"commitGeneration.prompt": valueRoute("setCommitPrompt"),
} satisfies Record<StructuredPlainSettingId, SettingRoute>;

const AGENT_TOOLS_KEYS: ReadonlySet<string> = new Set(AGENT_TOOLS_SETTING_KEYS);

const SETTING_ROUTES: ReadonlyMap<string, SettingRoute> = new Map<string, SettingRoute>([
	...Object.keys(NUMBER_SETTING_SPECS).map((setting): [string, SettingRoute] => [
		setting,
		(value) => [{ method: "setNumberSetting", payload: { setting, value } }],
	]),
	...Object.keys(BOOLEAN_SETTING_SPECS)
		.filter((setting) => !AGENT_TOOLS_KEYS.has(setting))
		.map((setting): [string, SettingRoute] => [
			setting,
			(value) => [{ method: "setBooleanSetting", payload: { setting, value } }],
		]),
	...Object.entries(STRUCTURED_SETTING_ROUTES),
]);

/** Which tool owns a setting set_setting must refuse. */
const SETTINGS_OWNED_ELSEWHERE: Readonly<Record<string, string>> = {
	[SERVERS_SETTING_KEY]: "saveServer",
	[MODEL_PARAMETERS_SETTING_KEY]: "editModelRecords",
	[MODEL_CAPABILITIES_SETTING_KEY]: "editModelRecords",
};

export function planSetSetting(input: AgentToolInput<"setSetting">): ToolPlan {
	const { setting, value } = input;
	if (AGENT_TOOLS_KEYS.has(setting)) {
		return refused("agent-tools-switch", { setting });
	}
	const owner = SETTINGS_OWNED_ELSEWHERE[setting];
	if (owner !== undefined) {
		return refused("setting-owned-by-tool", { setting, tool: owner });
	}
	const route = SETTING_ROUTES.get(setting);
	if (route === undefined) {
		return refused("unknown-setting", { setting });
	}
	if (value === null) {
		return requests({ method: "resetSetting", payload: { setting } });
	}
	if (
		setting === INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY &&
		isRecord(value) &&
		"mode" in value &&
		"languages" in value
	) {
		return refused("language-filter-one-half", { setting });
	}
	return requests(...route(value));
}

// ---------------------------------------------------------------------------
// Servers: the accepted entry as a save payload, and the secrets rules
// ---------------------------------------------------------------------------

type DeclaredRow = Extract<DashboardServer, { origin: "declared" }>;
type ExternalRow = Extract<DashboardServer, { origin: "external" }>;

export function declaredRow(state: DashboardState, label: string): DeclaredRow | undefined {
	return state.servers.find((server): server is DeclaredRow => server.origin === "declared" && server.label === label);
}

/** A declared row the save intents may target, or the refusal that says why not. */
function editableRow(state: DashboardState, label: string): EditableDashboardServer | ToolPlan {
	const row = declaredRow(state, label);
	if (row === undefined) {
		return refused("server-not-found", { label });
	}
	return isEditableServer(row) ? row : refused("secret-locations-unproven", { label });
}

function isPlan(value: EditableDashboardServer | ToolPlan): value is ToolPlan {
	return "kind" in value;
}

/**
 * Two base URLs name the same host once trailing slashes and userinfo are
 * dropped. The agent only ever sees URLs with their credentials removed
 * (render.ts), so the URL it hands back must match the stored one this way.
 */
function sameHost(a: string, b: string): boolean {
	return displayUrl(normalizeBaseUrl(a)) === displayUrl(normalizeBaseUrl(b));
}

/** The external group at exactly this label and base URL; two groups can share a URL, so the label is part of the identity. */
function externalRow(state: DashboardState, label: string, baseUrl: string): ExternalRow | undefined {
	return state.servers.find(
		(server): server is ExternalRow =>
			server.origin === "external" && server.label === label && sameHost(server.baseUrl, baseUrl)
	);
}

/** The stored entry as the edit form would submit it unchanged; every field the save rebuilds is present. */
export function savePayloadFromRow(row: DeclaredRow): SaveServerPayload {
	const config = row.config;
	return {
		label: row.label,
		baseUrl: row.baseUrl,
		...(config.apiVersion !== undefined ? { apiVersion: config.apiVersion } : {}),
		...pickNonSecretOptionalFields(config),
		...(config.modelParameters !== undefined ? { modelParameters: config.modelParameters } : {}),
		modelCapabilities: config.modelCapabilities ?? {},
		expectedFailures: config.expectedFailures ?? [],
		headers: config.headers ?? {},
		declaredModels: config.declaredModels ?? [],
		budget: config.budget ?? null,
		mcp: config.mcp ?? null,
	};
}

/** The displayed identity a save must name to edit `row`. */
function replaceIdentityOf(row: EditableDashboardServer): ReplacedEntryIdentity {
	return {
		label: row.label,
		baseUrl: row.baseUrl,
		...(row.config.apiVersion !== undefined ? { apiVersion: row.config.apiVersion } : {}),
		...pickNonSecretOptionalFields(row.config),
		secrets: row.config.secrets.locations,
	};
}

const KEEP_ALL: Readonly<Record<SecretFieldId, SecretDirective>> = recordFromKeys(SECRET_FIELD_IDS, () => ({
	action: "keep",
}));

/** A directive with the value the prompt will supply; the placeholder is what withSecretValues replaces. */
const PENDING_VALUE = "";

/**
 * Splice prompted secret values into a save (or draft-test) request's
 * directives: the one place a typed value meets the payload, after the user
 * typed it, so nothing before this point ever holds it.
 */
export function withSecretValues(
	request: AgentRequest,
	values: Readonly<Partial<Record<SecretFieldId, string>>>
): AgentRequest {
	if (!isRecord(request.payload) || !isRecord(request.payload.secrets)) {
		return request;
	}
	const secrets = { ...request.payload.secrets };
	for (const field of SECRET_FIELD_IDS) {
		const value = values[field];
		const directive = secrets[field];
		if (value !== undefined && isRecord(directive) && directive.action === "set") {
			secrets[field] = { ...directive, value };
		}
	}
	return { method: request.method, payload: { ...request.payload, secrets } };
}

interface SecretsPlan {
	readonly directives: Readonly<Record<SecretFieldId, SecretDirective>>;
	readonly prompts: readonly SecretPrompt[];
	readonly refusedValues: readonly SecretFieldId[];
}

/**
 * The agent's directives as the dashboard's, with the two rules of this
 * feature applied: a value in tool input needs the secretValues switch, and a
 * valueless `set` becomes a prompt to the user. Fields the agent did not name
 * take `fallback` (keep on an edit, clear on a new entry).
 */
function planSecrets(
	directives: { readonly [K in SecretFieldId]?: AgentSecretDirective | undefined } | undefined,
	fallback: SecretDirective,
	acceptSecretValues: boolean
): SecretsPlan {
	const prompts: SecretPrompt[] = [];
	const refusedValues: SecretFieldId[] = [];
	const out = recordFromKeys(SECRET_FIELD_IDS, (field): SecretDirective => {
		const directive = directives?.[field];
		if (directive === undefined) {
			return fallback;
		}
		if (directive.action !== "set") {
			return directive;
		}
		if (directive.value === undefined) {
			prompts.push({ field, location: directive.location });
			return { action: "set", location: directive.location, value: PENDING_VALUE };
		}
		if (!acceptSecretValues) {
			refusedValues.push(field);
		}
		return { action: "set", location: directive.location, value: directive.value };
	});
	return { directives: out, prompts, refusedValues };
}

/** A clearable string field's edit: null clears, a string sets, absent keeps `current`. */
function edited(current: string | undefined, next: string | null | undefined): string | undefined {
	if (next === undefined) {
		return current;
	}
	return next === null ? undefined : next;
}

/**
 * The secret fields a save would send to a NEW destination while keeping the
 * stored value: a kept key must never follow a changed host, so these refuse
 * (the agent sets the secret again, which prompts the user).
 */
function keptSecretsChangingDestination(
	before: EditableDashboardServer,
	after: { readonly baseUrl: string; readonly oauthTokenUrl?: string | undefined },
	directives: Readonly<Record<SecretFieldId, SecretDirective>>
): SecretFieldId[] {
	const locations = before.config.secrets.locations;
	return SECRET_FIELD_IDS.filter(
		(field) =>
			directives[field].action === "keep" &&
			locations[field] !== "none" &&
			secretDestination({ baseUrl: before.baseUrl, oauthTokenUrl: before.config.oauthTokenUrl }, field) !==
				secretDestination(after, field)
	);
}

/** The composed save payload's typed corner: what the destination rule reads; the rest the dashboard judges. */
interface ComposedServer {
	readonly baseUrl: string;
	readonly oauthTokenUrl?: string | undefined;
	readonly [field: string]: unknown;
}

/** A value the agent gave, else the stored one, else the empty default; spread-shaped so an absent optional stays absent. */
function fieldOf(name: string, given: unknown, stored: unknown, empty?: unknown): Record<string, unknown> {
	const value = given !== undefined ? given : stored !== undefined ? stored : empty;
	return value === undefined ? {} : { [name]: value };
}

export function planSaveServer(
	input: AgentToolInput<"saveServer">,
	state: DashboardState,
	acceptSecretValues: boolean
): ToolPlan {
	if ("adoptFrom" in input) {
		const source = externalRow(state, input.adoptFrom.label, input.adoptFrom.baseUrl);
		if (source === undefined) {
			return refused("external-group-not-found", { label: input.adoptFrom.label, baseUrl: input.adoptFrom.baseUrl });
		}
		const secrets = recordFromKeys(SECRET_FIELD_IDS, (field) => input.secretLocations?.[field] ?? "secure");
		return requests({
			method: "adoptServer",
			payload: { label: input.label, baseUrl: source.baseUrl, sourceHandle: source.adoptHandle, secrets },
		});
	}
	const existingLabel = input.renameFrom ?? input.label;
	const existingRow = declaredRow(state, existingLabel);
	if (input.renameFrom !== undefined && existingRow === undefined) {
		return refused("server-not-found", { label: input.renameFrom });
	}
	let existing: EditableDashboardServer | undefined;
	if (existingRow !== undefined) {
		const editable = editableRow(state, existingLabel);
		if (isPlan(editable)) {
			return editable;
		}
		existing = editable;
	}
	const base = existing === undefined ? undefined : savePayloadFromRow(existing);
	const baseUrl = input.baseUrl ?? base?.baseUrl;
	if (baseUrl === undefined) {
		return refused("base-url-required", { label: input.label });
	}
	const secrets = planSecrets(
		input.secrets,
		existing === undefined ? { action: "clear" } : { action: "keep" },
		acceptSecretValues
	);
	if (secrets.refusedValues.length > 0) {
		return refused("secret-value-refused", { fields: secrets.refusedValues.join(", ") });
	}
	const apiVersion = edited(base?.apiVersion, input.apiVersion);
	const server: ComposedServer = {
		label: input.label,
		baseUrl,
		...(apiVersion !== undefined ? { apiVersion } : {}),
		...pickNonSecretOptionalFields({
			oauthTokenUrl: edited(base?.oauthTokenUrl, input.oauthTokenUrl),
			oauthClientId: edited(base?.oauthClientId, input.oauthClientId),
			oauthScopes: edited(base?.oauthScopes, input.oauthScopes),
			virtualKeyHeader: edited(base?.virtualKeyHeader, input.virtualKeyHeader),
		}),
		...fieldOf("modelParameters", input.modelParameters, base?.modelParameters),
		...fieldOf("modelCapabilities", input.modelCapabilities, base?.modelCapabilities, {}),
		...fieldOf("expectedFailures", input.expectedFailures, base?.expectedFailures, []),
		...fieldOf("headers", input.headers, base?.headers, {}),
		...fieldOf("declaredModels", input.declaredModels, base?.declaredModels, []),
		...fieldOf("budget", input.budget, base?.budget, null),
		...fieldOf("mcp", input.mcp, base?.mcp, null),
	};
	if (existing !== undefined) {
		const moving = keptSecretsChangingDestination(existing, server, secrets.directives);
		if (moving.length > 0) {
			return refused("kept-secret-host-change", { label: existing.label, fields: moving.join(", ") });
		}
	}
	const replace = existing === undefined ? undefined : replaceIdentityOf(existing);
	return {
		kind: "requests",
		requests: [
			{
				method: "saveServerSetting",
				payload: { server, secrets: secrets.directives, ...(replace !== undefined ? { replace } : {}) },
			},
		],
		prompts: secrets.prompts,
	};
}

export function planRemoveServer(input: AgentToolInput<"removeServer">, state: DashboardState): ToolPlan {
	const action = input.action ?? "remove";
	if (action === "unhide") {
		const hidden = state.hiddenGroups.find(
			(group) => group.label === input.label && (input.baseUrl === undefined || sameHost(group.baseUrl, input.baseUrl))
		);
		if (hidden === undefined) {
			return refused("hidden-group-not-found", { label: input.label });
		}
		return requests({ method: "unhideServer", payload: { label: hidden.label, baseUrl: hidden.baseUrl } });
	}
	if (action === "hide") {
		if (input.baseUrl === undefined) {
			return refused("base-url-required", { label: input.label });
		}
		const row = externalRow(state, input.label, input.baseUrl);
		if (row === undefined) {
			return refused("external-group-not-found", { label: input.label, baseUrl: input.baseUrl });
		}
		return requests({ method: "hideExternalServer", payload: { baseUrl: row.baseUrl, sourceHandle: row.adoptHandle } });
	}
	const declared = state.servers.find(
		(server) => server.label === input.label && (server.origin === "declared" || server.origin === "misconfigured")
	);
	if (declared === undefined) {
		const external = state.servers.some((server) => server.origin === "external" && server.label === input.label);
		return refused(external ? "server-not-declared" : "server-not-found", { label: input.label });
	}
	return requests({ method: "removeServerSetting", payload: { label: input.label } });
}

// ---------------------------------------------------------------------------
// Model records: one matcher key patched into the scope the dashboard edits
// ---------------------------------------------------------------------------

type RecordMap = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

interface RecordPatch {
	readonly key: string;
	readonly set?: Readonly<Record<string, unknown>> | undefined;
	readonly unset?: readonly string[] | undefined;
	readonly removeKey?: boolean | undefined;
}

/** One key's patch applied to a record map; the intent's own validation judges the keys and fields. */
export function applyRecordPatch(map: RecordMap, patch: RecordPatch): RecordMap {
	if (patch.removeKey === true) {
		const { [patch.key]: _removed, ...rest } = map;
		return rest;
	}
	const fields: Record<string, unknown> = { ...map[patch.key], ...patch.set };
	for (const name of patch.unset ?? []) {
		delete fields[name];
	}
	// A patch that would only mint an empty record for a missing key is no
	// edit: an empty, more specific record would still win the walk and hide
	// broader records' fields.
	if (!(patch.key in map) && Object.keys(fields).length === 0) {
		return map;
	}
	return { ...map, [patch.key]: fields };
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function planEditModelRecords(input: AgentToolInput<"editModelRecords">, state: DashboardState): ToolPlan {
	if (input.server !== undefined) {
		const row = editableRow(state, input.server);
		if (isPlan(row)) {
			return row;
		}
		const base = savePayloadFromRow(row);
		const current = input.kind === "capabilities" ? base.modelCapabilities : (base.modelParameters ?? {});
		const patched = applyRecordPatch(current, input);
		if (sameJson(current, patched)) {
			return refused("nothing-to-change", { key: input.key });
		}
		const server: SaveServerPayload =
			input.kind === "capabilities" ? { ...base, modelCapabilities: patched } : { ...base, modelParameters: patched };
		return requests({
			method: "saveServerSetting",
			payload: { server, secrets: KEEP_ALL, replace: replaceIdentityOf(row) },
		});
	}
	const scoped: ScopedRecordSetting<Readonly<Record<string, unknown>>> =
		input.kind === "capabilities" ? state.settings.modelCapabilities : state.settings.modelParameters;
	const patched = applyRecordPatch(scoped.value, input);
	if (sameJson(scoped.value, patched)) {
		return refused("nothing-to-change", { key: input.key });
	}
	return requests({
		method: input.kind === "capabilities" ? "setModelCapabilities" : "setModelParameters",
		payload: { value: patched },
	});
}

// ---------------------------------------------------------------------------
// Actions and reads
// ---------------------------------------------------------------------------

export function planRunAction(input: AgentToolInput<"runAction">, state: DashboardState): ToolPlan {
	switch (input.action) {
		case "syncModels":
		case "refreshCatalog":
		case "refreshUsage":
			return requests({ method: input.action, payload: null });
		case "testConnection": {
			const row = editableRow(state, input.label);
			if (isPlan(row)) {
				return row;
			}
			// The STORED entry only: a probe of an agent-supplied draft would send
			// the kept credentials wherever the draft points.
			return requests({
				method: "testServerDraft",
				payload: { server: savePayloadFromRow(row), secrets: KEEP_ALL, replace: replaceIdentityOf(row) },
			});
		}
		case "testFeatureModel": {
			const model = state.settings.featureModels[input.feature];
			if (model === null) {
				return refused("feature-model-not-set", { feature: input.feature });
			}
			return requests({ method: "testFeatureModel", payload: { feature: input.feature, model } });
		}
	}
}

/** The two inspector reads for one model, addressed by its server label and raw ID as the agent knows them. */
export function planInspectModel(input: AgentToolInput<"inspectModel">, state: DashboardState): ToolPlan {
	const model = state.models.find((m) => m.serverLabel === input.server && m.rawId === input.model);
	if (model === undefined) {
		return refused("model-not-found", { server: input.server, model: input.model });
	}
	const payload = { scopeKey: model.scopeKey, rawId: model.rawId };
	return requests({ method: "readModelCapabilities", payload }, { method: "readModelParameters", payload });
}
