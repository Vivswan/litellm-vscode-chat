/**
 * The zod schemas that guard the webview boundary. Extension-side only: zod
 * must never enter the webview bundle, so the message and intent types the
 * webview shares live in protocol.ts and the schemas here validate against
 * those types from outside.
 */

import { z } from "zod";
import { isHeaderScalar } from "../../shared/util/headers";
import { recordFromKeys } from "../../shared/util/json";
import type { DashboardIntentType, HeaderScalar, SecretDirective, WebviewToExtensionMessage } from "./protocol";
import {
	BOOLEAN_SETTING_IDS,
	DASHBOARD_COMMAND_IDS,
	NON_SECRET_OPTIONAL_FIELD_IDS,
	NUMBER_SETTING_IDS,
	SECRET_FIELD_IDS,
} from "./protocol";

const asEnum = <T extends string>(values: readonly T[]) => z.enum(values as [T, ...T[]]);

const headerScalarSchema = z.custom<HeaderScalar>(isHeaderScalar);

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
 * along into the setting; the value constraints (usable URLs, header charset,
 * paired OAuth fields, reserved labels) live in validateSaveServerSetting,
 * whose rules the webview form shares through serverForm.ts.
 */
const saveServerSchema = z.strictObject({
	label: z.string(),
	baseUrl: z.string(),
	...recordFromKeys(NON_SECRET_OPTIONAL_FIELD_IDS, () => z.string().optional()),
	modelParameters: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
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
		setting: asEnum([...NUMBER_SETTING_IDS, ...BOOLEAN_SETTING_IDS]),
	}),
	z.strictObject({
		type: z.literal("setModelParameters"),
		value: z.record(z.string(), z.record(z.string(), z.unknown())),
	}),
	z.strictObject({
		type: z.literal("setHeaders"),
		value: z.record(z.string(), headerScalarSchema),
	}),
	z.strictObject({
		type: z.literal("saveServerSetting"),
		server: saveServerSchema,
		secrets: secretDirectivesSchema,
		replaceLabel: z.string().optional(),
		requestId: requestIdSchema,
	}),
	z.strictObject({ type: z.literal("removeServerSetting"), label: z.string(), requestId: requestIdSchema }),
	z.strictObject({ type: z.literal("readInlineSecrets"), label: z.string(), requestId: requestIdSchema }),
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
