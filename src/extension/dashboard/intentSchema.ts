/**
 * Extension-side only: zod must never enter the webview bundle, so the endpoint table and its types live in
 * src/dashboard/endpoints.ts and the schemas here validate against them from outside. One request schema per table
 * method, mapped over DashboardMethod in both directions: a method without a schema, or a schema without a table row,
 * fails compilation.
 *
 * The webview is outside the trust boundary, so its payloads are data to parse, never types to trust. Size bounds come
 * from the endpoint table's WIRE_LIMITS, so both sides of the wire read the same numbers.
 */

import { z } from "zod";
import type {
	DashboardMethod,
	ReplacedEntryIdentity,
	RequestPayload,
	RpcRequest,
	RpcRequestType,
	SecretDirective,
} from "../../dashboard/endpoints";
import { DASHBOARD_COMMAND_IDS, DASHBOARD_ENDPOINTS, WIRE_LIMITS } from "../../dashboard/endpoints";
import {
	BOOLEAN_SETTING_IDS,
	NUMBER_SETTING_IDS,
	RESETTABLE_SETTING_IDS,
	REVEALABLE_SETTING_IDS,
} from "../../dashboard/viewModels";
import {
	FEATURE_MODEL_IDS,
	LANGUAGE_FILTER_MODES,
	SESSION_ID_MODES,
	TOKEN_ESTIMATION_MODES,
	UI_ACCENTS,
	UI_THEMES,
	USAGE_STATUS_BAR_MODES,
} from "../../shared/config/settingSpec";
import {
	EXPECTED_FAILURE_CATEGORIES,
	NON_CHAT_MODES,
	NON_SECRET_OPTIONAL_FIELD_IDS,
	SECRET_FIELD_IDS,
} from "../../shared/serverEntry";
import { recordFromKeys } from "../../shared/util/json";

const asEnum = <T extends string>(values: readonly T[]) => z.enum(values as [T, ...T[]]);
const labelSchema = z.string().max(WIRE_LIMITS.label);

/** Whether a parsed record serializes within the budget; cycles and pathological depth read as over it. */
function withinRecordBudget(value: unknown): boolean {
	try {
		return JSON.stringify(value).length <= WIRE_LIMITS.recordJsonUnits;
	} catch {
		// A cyclic or absurdly deep structure cannot come from an honest page.
		return false;
	}
}

/** A record map bounded on every axis WIRE_LIMITS names: groups, fields per group, key lengths, serialized size. */
const recordMapSchema = z
	.record(
		z.string().max(WIRE_LIMITS.recordKey),
		z
			.record(z.string().max(WIRE_LIMITS.recordFieldName), z.unknown())
			.refine((fields) => Object.keys(fields).length <= WIRE_LIMITS.recordFields)
	)
	.refine((record) => Object.keys(record).length <= WIRE_LIMITS.recordGroups)
	.refine(withinRecordBudget);

/** Exported so tests can drive the same per-field parse path the save schemas embed. */
export const secretDirectiveSchema: z.ZodType<SecretDirective> = z.discriminatedUnion("action", [
	z.strictObject({ action: z.literal("keep") }),
	z.strictObject({ action: z.literal("clear") }),
	z.strictObject({
		action: z.literal("set"),
		location: z.union([z.literal("settings"), z.literal("secure")]),
		value: z.string().max(WIRE_LIMITS.secretValue),
	}),
]);

/** Strict, so unknown fields never ride into the setting; the value rules live in validateSaveServerSetting. */
const saveServerSchema = z.strictObject({
	label: labelSchema,
	baseUrl: z.string().max(WIRE_LIMITS.url),
	apiVersion: z.string().max(256).optional(),
	...recordFromKeys(NON_SECRET_OPTIONAL_FIELD_IDS, () => z.string().max(WIRE_LIMITS.textField).optional()),
	modelParameters: recordMapSchema.optional(),
	modelCapabilities: recordMapSchema,
	// The categories are a closed enum, so any honest list fits in one of each.
	expectedFailures: z.array(asEnum(EXPECTED_FAILURE_CATEGORIES)).max(EXPECTED_FAILURE_CATEGORIES.length),
	// Header values are scalars (parseHeaderValue's contract); the charset and name rules live in
	// validateSaveServerSetting.
	headers: z
		.record(z.string().max(256), z.union([z.string().max(4096), z.number(), z.boolean()]))
		.refine((record) => Object.keys(record).length <= 64),
	declaredModels: z.array(z.string().max(WIRE_LIMITS.modelId)).max(WIRE_LIMITS.declaredModels),
	// Closed like expectedFailures: only the modes discovery drops can be included.
	includeModes: z.array(asEnum(NON_CHAT_MODES)).max(NON_CHAT_MODES.length),
	budget: z.union([z.number().finite(), z.null()]),
	// `true` is the derived-endpoint opt-in; the object form may name the URL, bounded like every other webview-minted
	// string. null clears the opt-in.
	mcp: z.union([z.literal(true), z.strictObject({ url: z.string().max(WIRE_LIMITS.url).optional() }), z.null()]),
});

/** One directive per secret field; the save and draft-test payloads embed it. */
const secretDirectivesSchema = z.strictObject(recordFromKeys(SECRET_FIELD_IDS, () => secretDirectiveSchema));

/** Where a secret lands: the settings file ("settings") or SecretStorage ("secure"). */
const secretLocationChoiceSchema = z.union([z.literal("settings"), z.literal("secure")]);

/** The identity the edit form displayed, re-checked by save, draft-test, and inline prefill: locations, not values. */
const replacedEntrySchema: z.ZodType<ReplacedEntryIdentity> = z.strictObject({
	label: labelSchema,
	baseUrl: z.string().max(WIRE_LIMITS.url),
	apiVersion: z.string().max(256).optional(),
	...recordFromKeys(NON_SECRET_OPTIONAL_FIELD_IDS, () => z.string().max(WIRE_LIMITS.textField).optional()),
	secrets: z.strictObject(
		recordFromKeys(SECRET_FIELD_IDS, () => z.union([secretLocationChoiceSchema, z.literal("none")]))
	),
});

/** Where each of an adoption's copied secrets should land; never the values themselves. */
const adoptSecretsSchema = z.strictObject(recordFromKeys(SECRET_FIELD_IDS, () => secretLocationChoiceSchema));

/** Bounds the webview-minted tokens (request IDs, the echoed adopt handle): room for any honest one, no ballooning. */
const REQUEST_ID_MAX_LENGTH = 128;

/** Non-empty and bounded; the adopt and hide payloads' sourceHandle rides under the same bound. */
const requestIdSchema = z.string().min(1).max(REQUEST_ID_MAX_LENGTH);

/** One wire shape for saveServerSetting and testServerDraft; their value rules differ in intents.ts. */
const serverDraftPayloadSchema = z.strictObject({
	server: saveServerSchema,
	secrets: secretDirectivesSchema,
	replace: replacedEntrySchema.optional(),
});

/** One payload schema per table method: strict objects, and the literal null for parameterless methods. */
const payloadSchemas: { readonly [K in DashboardMethod]: z.ZodType<RequestPayload<K>> } = {
	ready: z.null(),
	setNumberSetting: z.strictObject({
		setting: asEnum(NUMBER_SETTING_IDS),
		value: z.union([z.number().finite(), z.null()]),
	}),
	setBooleanSetting: z.strictObject({
		setting: asEnum(BOOLEAN_SETTING_IDS),
		value: z.boolean(),
	}),
	resetSetting: z.strictObject({ setting: asEnum(RESETTABLE_SETTING_IDS) }),
	revealSetting: z.strictObject({ setting: asEnum(REVEALABLE_SETTING_IDS) }),
	setModelParameters: z.strictObject({ value: recordMapSchema }),
	setModelCapabilities: z.strictObject({ value: recordMapSchema }),
	setUsageStatusBar: z.strictObject({ value: asEnum(USAGE_STATUS_BAR_MODES) }),
	setChatSessionId: z.strictObject({ value: asEnum(SESSION_ID_MODES) }),
	setTokenEstimation: z.strictObject({ value: asEnum(TOKEN_ESTIMATION_MODES) }),
	setCurrencySymbol: z.strictObject({ value: z.string().max(WIRE_LIMITS.currencySymbol) }),
	setAdditionalToolSchemaKeywords: z.strictObject({
		values: z.array(z.string().max(WIRE_LIMITS.schemaKeyword)).max(WIRE_LIMITS.schemaKeywords),
	}),
	setUiTheme: z.strictObject({ value: asEnum(UI_THEMES) }),
	setUiAccent: z.strictObject({ value: asEnum(UI_ACCENTS) }),
	setUsageAlertThresholds: z.strictObject({ values: z.array(z.number().finite()).max(32) }),
	setFeatureModel: z.strictObject({
		feature: asEnum(FEATURE_MODEL_IDS),
		value: z.union([
			z.strictObject({
				server: z.string().min(1).max(WIRE_LIMITS.label),
				model: z.string().min(1).max(WIRE_LIMITS.modelId),
			}),
			z.null(),
		]),
	}),
	// Free text, model-facing user configuration (not a secret; it rides state pushes like every other setting value);
	// bounded so a hostile page cannot balloon the setting.
	setCommitPrompt: z.strictObject({ value: z.string().max(WIRE_LIMITS.commitPrompt) }),
	// Each dashboard row patches only its own half, so the wire shape is exactly one field per request - a payload
	// naming both fields or neither is malformed, not a merge. The value constraints (non-empty language IDs) live in
	// executeDashboardIntent.
	setLanguageFilter: z.union([
		z.strictObject({ mode: asEnum(LANGUAGE_FILTER_MODES) }),
		z.strictObject({
			languages: z.array(z.string().max(WIRE_LIMITS.languageId)).max(WIRE_LIMITS.languageList),
		}),
	]),
	refreshCatalog: z.null(),
	refreshUsage: z.null(),
	saveServerSetting: serverDraftPayloadSchema,
	testServerDraft: serverDraftPayloadSchema,
	// The probe tests exactly one feature's picked pair, bounded like setFeatureModel's non-null arm; probe existence
	// is judged extension-side.
	testFeatureModel: z.strictObject({
		feature: asEnum(FEATURE_MODEL_IDS),
		model: z.strictObject({
			server: z.string().min(1).max(WIRE_LIMITS.label),
			model: z.string().min(1).max(WIRE_LIMITS.modelId),
		}),
	}),
	// Row-bound writes carry the row's identity (label and base URL); the entry-existence and identity checks live in
	// executeDashboardIntent.
	removeServerSetting: z.strictObject({ label: labelSchema, baseUrl: z.string().max(WIRE_LIMITS.url) }),
	declareExpectedFailure: z.strictObject({
		label: labelSchema,
		baseUrl: z.string().max(WIRE_LIMITS.url),
		category: asEnum(EXPECTED_FAILURE_CATEGORIES),
	}),
	adoptServer: z.strictObject({
		label: labelSchema,
		baseUrl: z.string().max(WIRE_LIMITS.url),
		sourceHandle: requestIdSchema,
		secrets: adoptSecretsSchema,
	}),
	hideExternalServer: z.strictObject({ baseUrl: z.string().max(WIRE_LIMITS.url), sourceHandle: requestIdSchema }),
	unhideServer: z.strictObject({ label: labelSchema, baseUrl: z.string().max(WIRE_LIMITS.url) }),
	manageHiddenGroup: z.strictObject({ label: labelSchema, baseUrl: z.string().max(WIRE_LIMITS.url) }),
	readInlineSecrets: z.strictObject({ replace: replacedEntrySchema }),
	readModelCapabilities: z.strictObject({
		scopeKey: z.string().min(1).max(REQUEST_ID_MAX_LENGTH),
		rawId: z.string().min(1).max(WIRE_LIMITS.modelId),
	}),
	readModelParameters: z.strictObject({
		scopeKey: z.string().min(1).max(REQUEST_ID_MAX_LENGTH),
		rawId: z.string().min(1).max(WIRE_LIMITS.modelId),
	}),
	readResolvedModels: z.null(),
	searchCatalog: z.strictObject({ query: z.string().max(200) }),
	executeCommand: z.strictObject({ command: asEnum(DASHBOARD_COMMAND_IDS) }),
	copyDiagnostics: z.strictObject({ text: z.string().max(WIRE_LIMITS.copyText) }),
	syncModels: z.null(),
};

/**
 * The return type stays inferred so each map entry below is checked at its concrete method, where zod's object
 * inference matches RpcRequest exactly.
 */
function requestSchema<K extends DashboardMethod>(method: K) {
	return z.strictObject({
		kind: z.literal("request"),
		id: requestIdSchema,
		method: z.literal(method),
		payload: payloadSchemas[method],
	});
}

/** Concrete entries: a generic construction cannot re-correlate method and payload, so the parse would need a cast. */
const requestSchemas: { readonly [K in DashboardMethod]: z.ZodType<RpcRequest<K>> } = {
	ready: requestSchema("ready"),
	setNumberSetting: requestSchema("setNumberSetting"),
	setBooleanSetting: requestSchema("setBooleanSetting"),
	resetSetting: requestSchema("resetSetting"),
	revealSetting: requestSchema("revealSetting"),
	setModelParameters: requestSchema("setModelParameters"),
	setModelCapabilities: requestSchema("setModelCapabilities"),
	setUsageStatusBar: requestSchema("setUsageStatusBar"),
	setChatSessionId: requestSchema("setChatSessionId"),
	setTokenEstimation: requestSchema("setTokenEstimation"),
	setCurrencySymbol: requestSchema("setCurrencySymbol"),
	setAdditionalToolSchemaKeywords: requestSchema("setAdditionalToolSchemaKeywords"),
	setUiTheme: requestSchema("setUiTheme"),
	setUiAccent: requestSchema("setUiAccent"),
	setUsageAlertThresholds: requestSchema("setUsageAlertThresholds"),
	setFeatureModel: requestSchema("setFeatureModel"),
	setCommitPrompt: requestSchema("setCommitPrompt"),
	setLanguageFilter: requestSchema("setLanguageFilter"),
	refreshCatalog: requestSchema("refreshCatalog"),
	refreshUsage: requestSchema("refreshUsage"),
	saveServerSetting: requestSchema("saveServerSetting"),
	testServerDraft: requestSchema("testServerDraft"),
	testFeatureModel: requestSchema("testFeatureModel"),
	removeServerSetting: requestSchema("removeServerSetting"),
	declareExpectedFailure: requestSchema("declareExpectedFailure"),
	adoptServer: requestSchema("adoptServer"),
	hideExternalServer: requestSchema("hideExternalServer"),
	unhideServer: requestSchema("unhideServer"),
	manageHiddenGroup: requestSchema("manageHiddenGroup"),
	readInlineSecrets: requestSchema("readInlineSecrets"),
	readModelCapabilities: requestSchema("readModelCapabilities"),
	readModelParameters: requestSchema("readModelParameters"),
	readResolvedModels: requestSchema("readResolvedModels"),
	searchCatalog: requestSchema("searchCatalog"),
	executeCommand: requestSchema("executeCommand"),
	copyDiagnostics: requestSchema("copyDiagnostics"),
	syncModels: requestSchema("syncModels"),
};

/** The frame alone, parsed first so a payload failure still has an id and method to answer (ParsedDashboardRequest). */
const envelopeSchema = z.strictObject({
	kind: z.literal("request"),
	id: requestIdSchema,
	method: asEnum(Object.keys(DASHBOARD_ENDPOINTS) as DashboardMethod[]),
	payload: z.unknown(),
});

/** One parse issue without the schema library's shape, so callers outside this module never depend on it. */
export interface DashboardParseIssue {
	readonly path: string;
	readonly code: string;
	readonly message: string;
}

function flattenIssues(issues: readonly z.core.$ZodIssue[]): DashboardParseIssue[] {
	return issues.map((issue) => ({
		path: issue.path.map(String).join("."),
		code: issue.code,
		message: issue.message,
	}));
}

/**
 * The failure arm's `frame` is present when the envelope frame itself parsed (kind, bounded id, a table method) and
 * only the payload failed its method schema: enough identity for the panel to answer with a correlated refusal instead
 * of dropping the message. An editor waiting on this id would otherwise stay pending forever.
 */
export type ParsedDashboardRequest =
	| { readonly success: true; readonly request: RpcRequestType }
	| {
			readonly success: false;
			readonly issues: readonly DashboardParseIssue[];
			readonly frame?: { readonly id: string; readonly method: DashboardMethod } | undefined;
	  };

export function parseDashboardRequest(raw: unknown): ParsedDashboardRequest {
	const envelope = envelopeSchema.safeParse(raw);
	if (!envelope.success) {
		return { success: false, issues: flattenIssues(envelope.error.issues) };
	}
	const parsed = requestSchemas[envelope.data.method].safeParse(raw);
	if (!parsed.success) {
		return {
			success: false,
			issues: flattenIssues(parsed.error.issues),
			frame: { id: envelope.data.id, method: envelope.data.method },
		};
	}
	return { success: true, request: parsed.data };
}
