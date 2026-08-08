/**
 * Property coverage for the dashboard's trust boundary. Every message the
 * webview posts arrives as untrusted JSON, and panel.ts acts on nothing that
 * has not passed webviewMessageSchema.safeParse (handleMessage). A hole in
 * that schema turns hostile webview data directly into extension action:
 * settings writes, SecretStorage writes, command execution. These properties
 * pin that the parse is total, that every documented intent shape is
 * admitted, that near-miss mutants (unknown keys, wrong-typed fields,
 * oversized correlation tokens) are refused, that secretDirectiveSchema
 * admits exactly its documented shapes.
 */

import * as assert from "node:assert";
import * as fc from "fast-check";
import { secretDirectiveSchema, webviewMessageSchema } from "../../../extension/dashboard/intentSchema";
import {
	BOOLEAN_SETTING_IDS,
	DASHBOARD_COMMAND_IDS,
	EXPECTED_FAILURE_CATEGORIES,
	NON_SECRET_OPTIONAL_FIELD_IDS,
	NUMBER_SETTING_IDS,
	REVEALABLE_SETTING_IDS,
	SECRET_FIELD_IDS,
	type WebviewToExtensionMessage,
} from "../../../extension/dashboard/protocol";
import { isUnsafeRecordKey } from "../../../shared/util/json";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 100;
const SEED = resolveFuzzSeed();

/** Pins REQUEST_ID_MAX_LENGTH in intentSchema.ts: correlation tokens longer than this must be refused. */
const REQUEST_ID_MAX_LENGTH = 128;

const finiteNumber = fc.double({ noNaN: true, noDefaultInfinity: true });

const requestId = fc.string({ minLength: 1, maxLength: REQUEST_ID_MAX_LENGTH });

const safeRecordKey = fc.string({ maxLength: 12 }).filter((key) => !isUnsafeRecordKey(key));

// The schema admits an empty "set" value on purpose; refusing it is
// validateSaveServerSetting's job, one validation layer later.
const validSecretDirective: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
	fc.constant({ action: "keep" }),
	fc.constant({ action: "clear" }),
	fc.record({
		action: fc.constant("set"),
		location: fc.constantFrom("settings", "secure"),
		value: fc.string(),
	})
);

const secretDirectives = fc.record(Object.fromEntries(SECRET_FIELD_IDS.map((field) => [field, validSecretDirective])));

const adoptSecrets = fc.record(
	Object.fromEntries(SECRET_FIELD_IDS.map((field) => [field, fc.constantFrom("settings", "secure")]))
);

const saveServerPayload = fc.record(
	{
		label: fc.string(),
		baseUrl: fc.string(),
		...Object.fromEntries(NON_SECRET_OPTIONAL_FIELD_IDS.map((field) => [field, fc.string()])),
		modelParameters: fc.dictionary(safeRecordKey, fc.dictionary(safeRecordKey, fc.jsonValue(), { maxKeys: 3 }), {
			maxKeys: 3,
		}),
		modelCapabilities: fc.dictionary(safeRecordKey, fc.dictionary(safeRecordKey, fc.jsonValue(), { maxKeys: 3 }), {
			maxKeys: 3,
		}),
		expectedFailures: fc.uniqueArray(fc.constantFrom(...EXPECTED_FAILURE_CATEGORIES)),
	},
	{ requiredKeys: ["label", "baseUrl"] }
);

/**
 * One well-formed generator per schema discriminant. A Record over the wire
 * union's own "type" field, so a message added to WebviewToExtensionMessage
 * stops compiling until it is covered here.
 */
const validMessageArbs: Readonly<Record<WebviewToExtensionMessage["type"], fc.Arbitrary<Record<string, unknown>>>> = {
	ready: fc.constant({ type: "ready" }),
	setNumberSetting: fc.record({
		type: fc.constant("setNumberSetting"),
		setting: fc.constantFrom(...NUMBER_SETTING_IDS),
		value: fc.oneof(finiteNumber, fc.constant(null)),
	}),
	setBooleanSetting: fc.record({
		type: fc.constant("setBooleanSetting"),
		setting: fc.constantFrom(...BOOLEAN_SETTING_IDS),
		value: fc.boolean(),
	}),
	resetSetting: fc.record({
		type: fc.constant("resetSetting"),
		setting: fc.constantFrom(...NUMBER_SETTING_IDS, ...BOOLEAN_SETTING_IDS),
	}),
	revealSetting: fc.record({
		type: fc.constant("revealSetting"),
		setting: fc.constantFrom(...REVEALABLE_SETTING_IDS),
	}),
	setModelParameters: fc.record({
		type: fc.constant("setModelParameters"),
		value: fc.dictionary(safeRecordKey, fc.dictionary(safeRecordKey, fc.jsonValue(), { maxKeys: 3 }), { maxKeys: 3 }),
	}),
	setModelCapabilities: fc.record({
		type: fc.constant("setModelCapabilities"),
		value: fc.dictionary(safeRecordKey, fc.dictionary(safeRecordKey, fc.jsonValue(), { maxKeys: 3 }), { maxKeys: 3 }),
	}),
	refreshCatalog: fc.constant({ type: "refreshCatalog" }),
	refreshUsage: fc.constant({ type: "refreshUsage" }),
	setUsageStatusBar: fc.record({
		type: fc.constant("setUsageStatusBar"),
		value: fc.constantFrom("always", "alerts-only", "off"),
	}),
	setUsageAlertThresholds: fc.record({
		type: fc.constant("setUsageAlertThresholds"),
		values: fc.array(finiteNumber, { maxLength: 32 }),
	}),
	saveServerSetting: fc.record(
		{
			type: fc.constant("saveServerSetting"),
			server: saveServerPayload,
			secrets: secretDirectives,
			replaceLabel: fc.string(),
			requestId,
		},
		{ requiredKeys: ["type", "server", "secrets", "requestId"] }
	),
	testServerDraft: fc.record(
		{
			type: fc.constant("testServerDraft"),
			server: saveServerPayload,
			secrets: secretDirectives,
			replaceLabel: fc.string(),
			requestId,
		},
		{ requiredKeys: ["type", "server", "secrets", "requestId"] }
	),
	removeServerSetting: fc.record({ type: fc.constant("removeServerSetting"), label: fc.string(), requestId }),
	hideExternalServer: fc.record({
		type: fc.constant("hideExternalServer"),
		baseUrl: fc.string(),
		sourceHandle: requestId,
		requestId,
	}),
	unhideServer: fc.record({
		type: fc.constant("unhideServer"),
		label: fc.string(),
		baseUrl: fc.string(),
		requestId,
	}),
	readInlineSecrets: fc.record({ type: fc.constant("readInlineSecrets"), label: fc.string(), requestId }),
	readModelCapabilities: fc.record({
		type: fc.constant("readModelCapabilities"),
		scopeKey: fc.string({ minLength: 1, maxLength: REQUEST_ID_MAX_LENGTH }),
		rawId: fc.string({ minLength: 1, maxLength: 64 }),
		requestId,
	}),
	readModelParameters: fc.record({
		type: fc.constant("readModelParameters"),
		scopeKey: fc.string({ minLength: 1, maxLength: REQUEST_ID_MAX_LENGTH }),
		rawId: fc.string({ minLength: 1, maxLength: 64 }),
		requestId,
	}),
	readResolvedModels: fc.record({ type: fc.constant("readResolvedModels"), requestId }),
	searchCatalog: fc.record({ type: fc.constant("searchCatalog"), query: fc.string({ maxLength: 200 }), requestId }),
	adoptServer: fc.record({
		type: fc.constant("adoptServer"),
		label: fc.string(),
		baseUrl: fc.string(),
		sourceHandle: requestId,
		secrets: adoptSecrets,
		requestId,
	}),
	executeCommand: fc.record({
		type: fc.constant("executeCommand"),
		command: fc.constantFrom(...DASHBOARD_COMMAND_IDS),
	}),
};

const MESSAGE_TYPES = Object.keys(validMessageArbs) as readonly WebviewToExtensionMessage["type"][];

const validMessage = fc.constantFrom(...MESSAGE_TYPES).chain((type) => validMessageArbs[type]);

/**
 * Values invalid for every field the message shapes declare: NaN fails even
 * z.number(); an array fails records, strict objects, and strings; the
 * one-key object fails strict shapes (unknown key, missing required fields),
 * both record fields (its value is neither a record nor a header scalar),
 * and strings.
 */
const junkValue: fc.Arbitrary<unknown> = fc.constantFrom(Number.NaN, [], { unexpected: [] });

suite("extension/dashboard/state webview message schema properties", () => {
	test("safeParse is total over arbitrary values", () => {
		fc.assert(
			fc.property(fc.oneof(fc.jsonValue(), fc.anything()), (input) => {
				const message = webviewMessageSchema.safeParse(input);
				const directive = secretDirectiveSchema.safeParse(input);
				assert.strictEqual(typeof message.success, "boolean");
				assert.strictEqual(typeof directive.success, "boolean");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("every discriminant's well-formed message parses", () => {
		fc.assert(
			fc.property(validMessage, (message) => {
				const parsed = webviewMessageSchema.safeParse(message);
				if (!parsed.success) {
					assert.fail(JSON.stringify(parsed.error.issues));
				}
				assert.strictEqual(parsed.data.type, message.type);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("a single mutation of a valid message is refused", () => {
		fc.assert(
			fc.property(
				validMessage,
				fc.constantFrom("unknown-key", "wrong-type", "oversized-token"),
				fc.string({ minLength: 1, maxLength: 8 }),
				junkValue,
				fc.integer({ min: REQUEST_ID_MAX_LENGTH + 1, max: REQUEST_ID_MAX_LENGTH + 64 }),
				fc.nat(),
				(message, requestedKind, extraKey, junk, oversize, pick) => {
					const tokenFields = ["requestId", "sourceHandle"].filter((field) => Object.hasOwn(message, field));
					// Discriminants without a bounded token get the strictness mutation instead.
					const kind = requestedKind === "oversized-token" && tokenFields.length === 0 ? "unknown-key" : requestedKind;
					const mutant: Record<string, unknown> = { ...message };
					if (kind === "unknown-key") {
						// Strict shapes must refuse any key they do not declare. The suffix
						// keeps the key genuinely unknown (and never a prototype setter).
						const key = Object.hasOwn(message, extraKey) || isUnsafeRecordKey(extraKey) ? `${extraKey}Extra` : extraKey;
						mutant[key] = junk;
					} else if (kind === "wrong-type") {
						const keys = Object.keys(message);
						const key = keys[pick % keys.length] ?? "type";
						// setUsageAlertThresholds.values legally holds ANY bounded number
						// array (empty = alerts off), so the array junk is not a wrong
						// type there; NaN still is.
						mutant[key] = key === "values" && Array.isArray(junk) ? Number.NaN : junk;
					} else {
						mutant[tokenFields[pick % tokenFields.length] ?? "requestId"] = "x".repeat(oversize);
					}
					assert.strictEqual(webviewMessageSchema.safeParse(mutant).success, false, `a ${kind} mutant must be refused`);
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("correlation tokens pin their bounds", () => {
		const base = { type: "removeServerSetting", label: "a", requestId: "r" };
		assert.ok(webviewMessageSchema.safeParse({ ...base, requestId: "x".repeat(REQUEST_ID_MAX_LENGTH) }).success);
		assert.strictEqual(
			webviewMessageSchema.safeParse({ ...base, requestId: "x".repeat(REQUEST_ID_MAX_LENGTH + 1) }).success,
			false
		);
		assert.strictEqual(webviewMessageSchema.safeParse({ ...base, requestId: "" }).success, false);
	});
});

/**
 * The schema by hand: strict keep/clear (no other key rides along), and set
 * with a location literal and a string value, nothing more. The property
 * below holds the schema to this oracle in both directions.
 */
function isLegalDirective(candidate: Record<string, unknown>): boolean {
	const keys = Object.keys(candidate).sort().join(",");
	if (candidate.action === "keep" || candidate.action === "clear") {
		return keys === "action";
	}
	return (
		candidate.action === "set" &&
		keys === "action,location,value" &&
		(candidate.location === "settings" || candidate.location === "secure") &&
		typeof candidate.value === "string"
	);
}

const directiveFieldValue: fc.Arbitrary<unknown> = fc.constantFrom(
	"keep",
	"clear",
	"set",
	"settings",
	"secure",
	"",
	"token",
	7,
	true,
	null
);

const directiveCandidate: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
	validSecretDirective,
	fc
		.array(fc.tuple(fc.constantFrom("action", "location", "value", "mode"), directiveFieldValue), { maxLength: 4 })
		.map((pairs) => Object.fromEntries(pairs))
);

suite("extension/dashboard/state secret directive schema properties", () => {
	test("secretDirectiveSchema admits exactly the documented shapes", () => {
		fc.assert(
			fc.property(directiveCandidate, (candidate) => {
				assert.strictEqual(secretDirectiveSchema.safeParse(candidate).success, isLegalDirective(candidate));
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
