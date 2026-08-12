/**
 * The zod schemas that guard the webview boundary. Extension-side only: zod
 * must never enter the webview bundle, so the message and intent types the
 * webview shares live in protocol.ts and the schemas here validate against
 * those types from outside.
 */

import { z } from "zod";
import type { DashboardIntentType, SecretDirective, WebviewToExtensionMessage } from "../../dashboard/protocol";
import {
	BOOLEAN_SETTING_IDS,
	DASHBOARD_COMMAND_IDS,
	EXPECTED_FAILURE_CATEGORIES,
	NON_SECRET_OPTIONAL_FIELD_IDS,
	NUMBER_SETTING_IDS,
	RESETTABLE_SETTING_IDS,
	REVEALABLE_SETTING_IDS,
	SECRET_FIELD_IDS,
} from "../../dashboard/protocol";
import { recordFromKeys } from "../../shared/util/json";

const asEnum = <T extends string>(values: readonly T[]) => z.enum(values as [T, ...T[]]);

/** Exported so tests can drive the same per-field parse path the webview message schema embeds. */
export const secretDirectiveSchema: z.ZodType<SecretDirective> = z.discriminatedUnion("action", [
	z.strictObject({ action: z.literal("keep") }),
	z.strictObject({ action: z.literal("clear") }),
	z.strictObject({
		action: z.literal("set"),
		location: z.union([z.literal("settings"), z.literal("secure")]),
		value: z.string(),
	}),
]);

/**
 * The saveServerSetting payload's shape. Strict, so unknown fields never ride
 * along into the setting, and the record and list fields are required - the
 * form always sends them (empty means "none"), so a payload that omits one is
 * malformed rather than a signal to carry stored values forward. The value
 * constraints (usable URLs, header charset, paired OAuth fields, reserved
 * labels) live in validateSaveServerSetting, whose rules the webview form
 * shares through serverForm.ts.
 */
const saveServerSchema = z.strictObject({
	label: z.string(),
	baseUrl: z.string(),
	// Bounded like every other webview-minted token: no honest version
	// segment needs more.
	apiVersion: z.string().max(256).optional(),
	...recordFromKeys(NON_SECRET_OPTIONAL_FIELD_IDS, () => z.string().optional()),
	modelParameters: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
	modelCapabilities: z.record(z.string(), z.record(z.string(), z.unknown())),
	expectedFailures: z.array(asEnum(EXPECTED_FAILURE_CATEGORIES)),
	// Header values are scalars (parseHeaderValue's contract); the charset and
	// name rules live in validateSaveServerSetting. Sizes are bounded like
	// every other webview-minted list: no honest entry needs more.
	headers: z
		.record(z.string().max(256), z.union([z.string().max(4096), z.number(), z.boolean()]))
		.refine((record) => Object.keys(record).length <= 64),
	declaredModels: z.array(z.string().max(512)).max(256),
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

/**
 * The schema every message from the webview must pass before anything acts on
 * it: the webview is outside the trust boundary, so its messages are data,
 * not types. Strict objects keep unknown fields from riding along.
 */
export const webviewMessageSchema: z.ZodType<WebviewToExtensionMessage> = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("ready") }),
	z.strictObject({
		type: z.literal("setNumberSetting"),
		setting: asEnum(NUMBER_SETTING_IDS),
		value: z.union([z.number().finite(), z.null()]),
	}),
	z.strictObject({
		type: z.literal("setBooleanSetting"),
		setting: asEnum(BOOLEAN_SETTING_IDS),
		value: z.boolean(),
	}),
	z.strictObject({
		type: z.literal("resetSetting"),
		setting: asEnum(RESETTABLE_SETTING_IDS),
	}),
	z.strictObject({
		type: z.literal("revealSetting"),
		setting: asEnum(REVEALABLE_SETTING_IDS),
	}),
	z.strictObject({
		type: z.literal("setModelParameters"),
		value: z.record(z.string(), z.record(z.string(), z.unknown())),
		requestId: requestIdSchema,
	}),
	z.strictObject({
		type: z.literal("setModelCapabilities"),
		value: z.record(z.string(), z.record(z.string(), z.unknown())),
		requestId: requestIdSchema,
	}),
	z.strictObject({
		type: z.literal("setUsageStatusBar"),
		value: z.union([z.literal("always"), z.literal("alerts-only"), z.literal("off")]),
	}),
	z.strictObject({
		// Bounded like every webview-minted list; the value constraints
		// (fractions in (0, 1]) live in executeDashboardIntent.
		type: z.literal("setUsageAlertThresholds"),
		values: z.array(z.number().finite()).max(32),
	}),
	z.strictObject({ type: z.literal("refreshCatalog") }),
	z.strictObject({ type: z.literal("refreshUsage") }),
	z.strictObject({
		type: z.literal("saveServerSetting"),
		server: saveServerSchema,
		secrets: secretDirectivesSchema,
		replaceLabel: z.string().optional(),
		requestId: requestIdSchema,
	}),
	z.strictObject({
		// The draft-connection test carries the save payload's exact shape (the
		// same strict schemas, so unknown fields cannot ride along), but the
		// intent only probes: value constraints live in validateTestServerDraft.
		type: z.literal("testServerDraft"),
		server: saveServerSchema,
		secrets: secretDirectivesSchema,
		replaceLabel: z.string().optional(),
		requestId: requestIdSchema,
	}),
	z.strictObject({ type: z.literal("removeServerSetting"), label: z.string(), requestId: requestIdSchema }),
	z.strictObject({
		type: z.literal("hideExternalServer"),
		baseUrl: z.string(),
		sourceHandle: requestIdSchema,
		requestId: requestIdSchema,
	}),
	z.strictObject({
		type: z.literal("unhideServer"),
		label: z.string(),
		baseUrl: z.string(),
		requestId: requestIdSchema,
	}),
	z.strictObject({ type: z.literal("readInlineSecrets"), label: z.string(), requestId: requestIdSchema }),
	z.strictObject({
		// The capability inspector's read: the opaque scope key plus the
		// model's raw ID, both length-bounded like every webview-minted token.
		type: z.literal("readModelCapabilities"),
		scopeKey: z.string().min(1).max(REQUEST_ID_MAX_LENGTH),
		rawId: z.string().min(1).max(512),
		requestId: requestIdSchema,
	}),
	z.strictObject({
		// The params inspector's read; addressed exactly like readModelCapabilities.
		type: z.literal("readModelParameters"),
		scopeKey: z.string().min(1).max(REQUEST_ID_MAX_LENGTH),
		rawId: z.string().min(1).max(512),
		requestId: requestIdSchema,
	}),
	z.strictObject({ type: z.literal("readResolvedModels"), requestId: requestIdSchema }),
	z.strictObject({
		// The catalog picker's search; the query is filter text, bounded so a
		// hostile page cannot balloon the message.
		type: z.literal("searchCatalog"),
		query: z.string().max(200),
		requestId: requestIdSchema,
	}),
	z.strictObject({
		type: z.literal("adoptServer"),
		label: z.string(),
		baseUrl: z.string(),
		sourceHandle: requestIdSchema,
		secrets: adoptSecretsSchema,
		requestId: requestIdSchema,
	}),
	z.strictObject({ type: z.literal("executeCommand"), command: asEnum(DASHBOARD_COMMAND_IDS) }),
]);

/** A schema-valid intent that asks the extension to do something (everything but the ready handshake). */
export type DashboardIntent = Extract<WebviewToExtensionMessage, { type: DashboardIntentType }>;
