/**
 * The zod schemas that guard the webview boundary. Extension-side only: zod
 * must never enter the webview bundle, so the endpoint table and its types
 * live in src/dashboard/endpoints.ts and the schemas here validate against
 * them from outside.
 *
 * One request schema per table method, mapped over DashboardMethod in both
 * directions: a method added to the table without a schema, or a schema
 * without a table row, fails compilation.
 */

import { z } from "zod";
import type {
	DashboardMethod,
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
import { TOKEN_ESTIMATION_MODES, UI_ACCENTS, UI_THEMES } from "../../shared/config/settingSpec";
import { EXPECTED_FAILURE_CATEGORIES, NON_SECRET_OPTIONAL_FIELD_IDS, SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { recordFromKeys } from "../../shared/util/json";

const asEnum = <T extends string>(values: readonly T[]) => z.enum(values as [T, ...T[]]);

// The size bounds live in the endpoint table's WIRE_LIMITS declaration, so
// both sides of the wire read the same numbers; this module only enforces
// them.
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

/** One matcher-keyed record map (models.parameters / models.capabilities shaped) under the WIRE_LIMITS bounds. */
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

/**
 * The saveServerSetting payload's server shape. Strict, so unknown fields
 * never ride along into the setting, and the record and list fields are
 * required - the form always sends them (empty means "none"), so a payload
 * that omits one is malformed rather than a signal to carry stored values
 * forward. The value constraints (usable URLs, header charset, paired OAuth
 * fields, reserved labels) live in validateSaveServerSetting, whose rules the
 * webview form shares through serverForm.ts.
 */
const saveServerSchema = z.strictObject({
	label: labelSchema,
	baseUrl: z.string().max(WIRE_LIMITS.url),
	// Bounded like every other webview-minted token: no honest version
	// segment needs more.
	apiVersion: z.string().max(256).optional(),
	...recordFromKeys(NON_SECRET_OPTIONAL_FIELD_IDS, () => z.string().max(WIRE_LIMITS.textField).optional()),
	modelParameters: recordMapSchema.optional(),
	modelCapabilities: recordMapSchema,
	// The categories are a closed enum, so any honest list fits in one of each.
	expectedFailures: z.array(asEnum(EXPECTED_FAILURE_CATEGORIES)).max(EXPECTED_FAILURE_CATEGORIES.length),
	// Header values are scalars (parseHeaderValue's contract); the charset and
	// name rules live in validateSaveServerSetting. Sizes are bounded like
	// every other webview-minted list: no honest entry needs more.
	headers: z
		.record(z.string().max(256), z.union([z.string().max(4096), z.number(), z.boolean()]))
		.refine((record) => Object.keys(record).length <= 64),
	declaredModels: z.array(z.string().max(512)).max(WIRE_LIMITS.declaredModels),
	budget: z.union([z.number().finite(), z.null()]),
});

const secretDirectivesSchema = z.strictObject(recordFromKeys(SECRET_FIELD_IDS, () => secretDirectiveSchema));

const secretLocationChoiceSchema = z.union([z.literal("settings"), z.literal("secure")]);

/** Where each of an adoption's copied secrets should land; never the values themselves. */
const adoptSecretsSchema = z.strictObject(recordFromKeys(SECRET_FIELD_IDS, () => secretLocationChoiceSchema));

/**
 * Bound on the correlation tokens the webview mints (request IDs and the
 * adopt handle it echoes back): long enough for any honest token, short
 * enough that a hostile page cannot balloon the message.
 */
const REQUEST_ID_MAX_LENGTH = 128;

const requestIdSchema = z.string().min(1).max(REQUEST_ID_MAX_LENGTH);

/** The save and draft-test intents share one payload shape (same strict schemas, same value rules). */
const serverDraftPayloadSchema = z.strictObject({
	server: saveServerSchema,
	secrets: secretDirectivesSchema,
	replaceLabel: labelSchema.optional(),
});

/**
 * One payload schema per table method; the webview is outside the trust
 * boundary, so its payloads are data, not types. Strict objects keep unknown
 * fields from riding along; parameterless methods carry the literal null.
 */
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
	setUsageStatusBar: z.strictObject({
		value: z.union([z.literal("always"), z.literal("alerts-only"), z.literal("off")]),
	}),
	setTokenEstimation: z.strictObject({ value: asEnum(TOKEN_ESTIMATION_MODES) }),
	setUiTheme: z.strictObject({ value: asEnum(UI_THEMES) }),
	setUiAccent: z.strictObject({ value: asEnum(UI_ACCENTS) }),
	// Bounded like every webview-minted list; the value constraints
	// (fractions in (0, 1]) live in executeDashboardIntent.
	setUsageAlertThresholds: z.strictObject({ values: z.array(z.number().finite()).max(32) }),
	refreshCatalog: z.null(),
	refreshUsage: z.null(),
	saveServerSetting: serverDraftPayloadSchema,
	testServerDraft: serverDraftPayloadSchema,
	removeServerSetting: z.strictObject({ label: labelSchema }),
	// Two closed vocabularies: an entry label and a category token; the
	// entry-existence check lives in executeDashboardIntent.
	declareExpectedFailure: z.strictObject({ label: labelSchema, category: asEnum(EXPECTED_FAILURE_CATEGORIES) }),
	adoptServer: z.strictObject({
		label: labelSchema,
		baseUrl: z.string().max(WIRE_LIMITS.url),
		sourceHandle: requestIdSchema,
		secrets: adoptSecretsSchema,
	}),
	hideExternalServer: z.strictObject({ baseUrl: z.string().max(WIRE_LIMITS.url), sourceHandle: requestIdSchema }),
	unhideServer: z.strictObject({ label: labelSchema, baseUrl: z.string().max(WIRE_LIMITS.url) }),
	readInlineSecrets: z.strictObject({ label: labelSchema }),
	// The inspector reads: the opaque scope key plus the model's raw ID, both
	// length-bounded like every webview-minted token.
	readModelCapabilities: z.strictObject({
		scopeKey: z.string().min(1).max(REQUEST_ID_MAX_LENGTH),
		rawId: z.string().min(1).max(512),
	}),
	readModelParameters: z.strictObject({
		scopeKey: z.string().min(1).max(REQUEST_ID_MAX_LENGTH),
		rawId: z.string().min(1).max(512),
	}),
	readResolvedModels: z.null(),
	// The catalog picker's search; the query is filter text, bounded so a
	// hostile page cannot balloon the message.
	searchCatalog: z.strictObject({ query: z.string().max(200) }),
	executeCommand: z.strictObject({ command: asEnum(DASHBOARD_COMMAND_IDS) }),
	syncModels: z.null(),
};

/**
 * One method's full request-envelope schema: the strict envelope around the
 * method's own payload schema. The return type stays inferred so each map
 * entry below is checked at its concrete method, where zod's object inference
 * matches RpcRequest exactly.
 */
function requestSchema<K extends DashboardMethod>(method: K) {
	return z.strictObject({
		kind: z.literal("request"),
		id: requestIdSchema,
		method: z.literal(method),
		payload: payloadSchemas[method],
	});
}

/**
 * The full envelope schema per method. Concrete entries on purpose: indexing
 * this map with a union-typed method yields a union of concrete schemas, so
 * the parse result is the properly discriminated RpcRequestType without a
 * cast (a generic construction cannot re-correlate method and payload).
 */
const requestSchemas: { readonly [K in DashboardMethod]: z.ZodType<RpcRequest<K>> } = {
	ready: requestSchema("ready"),
	setNumberSetting: requestSchema("setNumberSetting"),
	setBooleanSetting: requestSchema("setBooleanSetting"),
	resetSetting: requestSchema("resetSetting"),
	revealSetting: requestSchema("revealSetting"),
	setModelParameters: requestSchema("setModelParameters"),
	setModelCapabilities: requestSchema("setModelCapabilities"),
	setUsageStatusBar: requestSchema("setUsageStatusBar"),
	setTokenEstimation: requestSchema("setTokenEstimation"),
	setUiTheme: requestSchema("setUiTheme"),
	setUiAccent: requestSchema("setUiAccent"),
	setUsageAlertThresholds: requestSchema("setUsageAlertThresholds"),
	refreshCatalog: requestSchema("refreshCatalog"),
	refreshUsage: requestSchema("refreshUsage"),
	saveServerSetting: requestSchema("saveServerSetting"),
	testServerDraft: requestSchema("testServerDraft"),
	removeServerSetting: requestSchema("removeServerSetting"),
	declareExpectedFailure: requestSchema("declareExpectedFailure"),
	adoptServer: requestSchema("adoptServer"),
	hideExternalServer: requestSchema("hideExternalServer"),
	unhideServer: requestSchema("unhideServer"),
	readInlineSecrets: requestSchema("readInlineSecrets"),
	readModelCapabilities: requestSchema("readModelCapabilities"),
	readModelParameters: requestSchema("readModelParameters"),
	readResolvedModels: requestSchema("readResolvedModels"),
	searchCatalog: requestSchema("searchCatalog"),
	executeCommand: requestSchema("executeCommand"),
	syncModels: requestSchema("syncModels"),
};

/** The envelope's method-bearing frame, parsed first to pick the method's own full schema. */
const envelopeSchema = z.strictObject({
	kind: z.literal("request"),
	id: requestIdSchema,
	method: asEnum(Object.keys(DASHBOARD_ENDPOINTS) as DashboardMethod[]),
	payload: z.unknown(),
});

export type ParsedDashboardRequest =
	| { readonly success: true; readonly request: RpcRequestType }
	| {
			readonly success: false;
			readonly issues: readonly unknown[];
			/**
			 * Present when the envelope frame itself parsed (kind, bounded id, a
			 * table method) and only the payload failed its method schema: enough
			 * identity for the panel to answer with a correlated refusal instead
			 * of dropping the message - an editor waiting on this id would
			 * otherwise stay pending forever.
			 */
			readonly frame?: { readonly id: string; readonly method: DashboardMethod } | undefined;
	  };

/**
 * The parse every message from the webview must pass before anything acts on
 * it: the envelope frame first (kind, bounded id, a table method), then the
 * named method's own full schema.
 */
export function parseDashboardRequest(raw: unknown): ParsedDashboardRequest {
	const envelope = envelopeSchema.safeParse(raw);
	if (!envelope.success) {
		return { success: false, issues: envelope.error.issues };
	}
	const parsed = requestSchemas[envelope.data.method].safeParse(raw);
	if (!parsed.success) {
		return {
			success: false,
			issues: parsed.error.issues,
			frame: { id: envelope.data.id, method: envelope.data.method },
		};
	}
	return { success: true, request: parsed.data };
}
