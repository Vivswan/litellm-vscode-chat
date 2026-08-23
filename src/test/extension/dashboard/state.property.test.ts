/**
 * Property coverage for the dashboard's trust boundary: panel.ts acts on
 * nothing that has not passed parseDashboardRequest, so a hole in that parse
 * turns hostile webview JSON into settings writes, SecretStorage writes, and
 * command execution. Pins that the parse is total, that every table method's
 * well-formed request is admitted, that near-miss mutants (unknown keys,
 * wrong-typed fields, oversized correlation tokens) are refused, and that
 * secretDirectiveSchema admits exactly its documented shapes.
 */

import * as assert from "node:assert";
import * as fc from "fast-check";
import type { DashboardMethod } from "../../../dashboard/endpoints";
import { DASHBOARD_COMMAND_IDS, DASHBOARD_ENDPOINTS, WIRE_LIMITS } from "../../../dashboard/endpoints";
import {
	BOOLEAN_SETTING_IDS,
	NUMBER_SETTING_IDS,
	RESETTABLE_SETTING_IDS,
	REVEALABLE_SETTING_IDS,
} from "../../../dashboard/viewModels";
import { parseDashboardRequest, secretDirectiveSchema } from "../../../extension/dashboard/intentSchema";
import {
	FEATURE_MODEL_IDS,
	LANGUAGE_FILTER_MODES,
	TOKEN_ESTIMATION_MODES,
	UI_ACCENTS,
	UI_THEMES,
} from "../../../shared/config/settingSpec";
import {
	EXPECTED_FAILURE_CATEGORIES,
	NON_SECRET_OPTIONAL_FIELD_IDS,
	SECRET_FIELD_IDS,
} from "../../../shared/serverEntry";
import { isUnsafeRecordKey } from "../../../shared/util/json";
import { REFUSED_DASHBOARD_REQUESTS } from "../../fuzzCorpus";
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
		headers: fc.dictionary(
			fc.string({ maxLength: 32 }),
			fc.oneof(fc.string({ maxLength: 64 }), finiteNumber, fc.boolean()),
			{
				maxKeys: 3,
			}
		),
		declaredModels: fc.array(fc.string({ maxLength: 64 }), { maxLength: 4 }),
		budget: fc.oneof(finiteNumber, fc.constant(null)),
		mcp: fc.oneof(
			fc.constant(true as const),
			fc.record({ url: fc.string({ maxLength: 64 }) }, { requiredKeys: [] }),
			fc.constant(null)
		),
	},
	// The always-sent fields are schema-required; only modelParameters and the
	// non-secret text fields may be absent.
	{
		requiredKeys: [
			"label",
			"baseUrl",
			"modelCapabilities",
			"expectedFailures",
			"headers",
			"declaredModels",
			"budget",
			"mcp",
		],
	}
);

const secretLocation = fc.constantFrom("settings", "secure", "none");

const serverDraftPayload = fc.record(
	{
		server: saveServerPayload,
		secrets: secretDirectives,
		replace: fc.record({
			label: fc.string(),
			baseUrl: fc.string(),
			secrets: fc.record({
				apiKey: secretLocation,
				oauthClientSecret: secretLocation,
				virtualKeyValue: secretLocation,
			}),
		}),
	},
	{ requiredKeys: ["server", "secrets"] }
);

/**
 * One well-formed payload generator per table method. A Record over the
 * endpoint table's own keys, so a method added to DASHBOARD_ENDPOINTS stops
 * compiling until it is covered here.
 */
const payloadArbs: Readonly<Record<DashboardMethod, fc.Arbitrary<unknown>>> = {
	ready: fc.constant(null),
	syncModels: fc.constant(null),
	setNumberSetting: fc.record({
		setting: fc.constantFrom(...NUMBER_SETTING_IDS),
		value: fc.oneof(finiteNumber, fc.constant(null)),
	}),
	setBooleanSetting: fc.record({
		setting: fc.constantFrom(...BOOLEAN_SETTING_IDS),
		value: fc.boolean(),
	}),
	resetSetting: fc.record({ setting: fc.constantFrom(...RESETTABLE_SETTING_IDS) }),
	revealSetting: fc.record({ setting: fc.constantFrom(...REVEALABLE_SETTING_IDS) }),
	setModelParameters: fc.record({
		value: fc.dictionary(safeRecordKey, fc.dictionary(safeRecordKey, fc.jsonValue(), { maxKeys: 3 }), { maxKeys: 3 }),
	}),
	setModelCapabilities: fc.record({
		value: fc.dictionary(safeRecordKey, fc.dictionary(safeRecordKey, fc.jsonValue(), { maxKeys: 3 }), { maxKeys: 3 }),
	}),
	refreshCatalog: fc.constant(null),
	refreshUsage: fc.constant(null),
	setUsageStatusBar: fc.record({ value: fc.constantFrom("always", "alerts-only", "off") }),
	setTokenEstimation: fc.record({ value: fc.constantFrom(...TOKEN_ESTIMATION_MODES) }),
	setCurrencySymbol: fc.record({ value: fc.string({ maxLength: WIRE_LIMITS.currencySymbol }) }),
	setAdditionalToolSchemaKeywords: fc.record({
		values: fc.array(fc.string({ maxLength: 256 }), { maxLength: 64 }),
	}),
	setUiTheme: fc.record({ value: fc.constantFrom(...UI_THEMES) }),
	setUiAccent: fc.record({ value: fc.constantFrom(...UI_ACCENTS) }),
	setUsageAlertThresholds: fc.record({ values: fc.array(finiteNumber, { maxLength: 32 }) }),
	setFeatureModel: fc.record({
		feature: fc.constantFrom(...FEATURE_MODEL_IDS),
		value: fc.oneof(
			fc.record({
				server: fc.string({ minLength: 1, maxLength: 64 }),
				model: fc.string({ minLength: 1, maxLength: 64 }),
			}),
			fc.constant(null)
		),
	}),
	setCommitPrompt: fc.record({ value: fc.string({ maxLength: 256 }) }),
	// One field per patch, like the dashboard rows: each sends only its own
	// half, and the schema refuses a payload naming both fields or neither.
	setLanguageFilter: fc.oneof(
		fc.record({ mode: fc.constantFrom(...LANGUAGE_FILTER_MODES) }),
		fc.record({ languages: fc.array(fc.string({ maxLength: 128 }), { maxLength: 16 }) })
	),
	saveServerSetting: serverDraftPayload,
	testServerDraft: serverDraftPayload,
	testFeatureModel: fc.record({
		feature: fc.constantFrom(...FEATURE_MODEL_IDS),
		model: fc.record({
			server: fc.string({ minLength: 1, maxLength: 64 }),
			model: fc.string({ minLength: 1, maxLength: 128 }),
		}),
	}),
	removeServerSetting: fc.record({ label: fc.string() }),
	declareExpectedFailure: fc.record({
		label: fc.string(),
		category: fc.constantFrom(...EXPECTED_FAILURE_CATEGORIES),
	}),
	hideExternalServer: fc.record({ baseUrl: fc.string(), sourceHandle: requestId }),
	unhideServer: fc.record({ label: fc.string(), baseUrl: fc.string() }),
	readInlineSecrets: fc.record({
		replace: fc.record({
			label: fc.string(),
			baseUrl: fc.string(),
			secrets: fc.record({
				apiKey: secretLocation,
				oauthClientSecret: secretLocation,
				virtualKeyValue: secretLocation,
			}),
		}),
	}),
	readModelCapabilities: fc.record({
		scopeKey: fc.string({ minLength: 1, maxLength: REQUEST_ID_MAX_LENGTH }),
		rawId: fc.string({ minLength: 1, maxLength: 64 }),
	}),
	readModelParameters: fc.record({
		scopeKey: fc.string({ minLength: 1, maxLength: REQUEST_ID_MAX_LENGTH }),
		rawId: fc.string({ minLength: 1, maxLength: 64 }),
	}),
	readResolvedModels: fc.constant(null),
	searchCatalog: fc.record({ query: fc.string({ maxLength: 200 }) }),
	adoptServer: fc.record({
		label: fc.string(),
		baseUrl: fc.string(),
		sourceHandle: requestId,
		secrets: adoptSecrets,
	}),
	executeCommand: fc.record({ command: fc.constantFrom(...DASHBOARD_COMMAND_IDS) }),
};

const METHODS = Object.keys(DASHBOARD_ENDPOINTS) as readonly DashboardMethod[];

interface RawRequest {
	readonly kind: "request";
	readonly id: string;
	readonly method: DashboardMethod;
	readonly payload: unknown;
}

const validRequest: fc.Arbitrary<RawRequest> = fc.constantFrom(...METHODS).chain((method) =>
	fc.record({
		kind: fc.constant("request" as const),
		id: requestId,
		method: fc.constant(method),
		payload: payloadArbs[method],
	})
);

/**
 * Values invalid for every field the payload shapes declare: NaN fails even
 * z.number(); an array fails records, strict objects, and strings; the one-key
 * object fails strict shapes, both record fields, and strings. All three also
 * fail the parameterless methods' literal null.
 */
const junkValue: fc.Arbitrary<unknown> = fc.constantFrom(Number.NaN, [], { unexpected: [] });

suite("extension/dashboard/state webview request schema properties", () => {
	test("parseDashboardRequest is total over arbitrary values", () => {
		fc.assert(
			fc.property(fc.oneof(fc.jsonValue(), fc.anything()), (input) => {
				const request = parseDashboardRequest(input);
				const directive = secretDirectiveSchema.safeParse(input);
				assert.strictEqual(typeof request.success, "boolean");
				assert.strictEqual(typeof directive.success, "boolean");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("every method's well-formed request parses, echoing the method and id", () => {
		fc.assert(
			fc.property(validRequest, (request) => {
				const parsed = parseDashboardRequest(request);
				if (!parsed.success) {
					assert.fail(JSON.stringify(parsed.issues));
				}
				assert.strictEqual(parsed.request.method, request.method);
				assert.strictEqual(parsed.request.id, request.id);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("a single mutation of a valid request is refused", () => {
		// The corpus replays first: every request a past fuzz run found accepted
		// stays refused after the generators or the mutation model change.
		for (const entry of REFUSED_DASHBOARD_REQUESTS) {
			assert.strictEqual(parseDashboardRequest(entry.request).success, false, `corpus entry ${entry.name}`);
		}
		fc.assert(
			fc.property(
				validRequest,
				fc.constantFrom("unknown-key", "wrong-type", "oversized-token"),
				fc.string({ minLength: 1, maxLength: 8 }),
				junkValue,
				fc.integer({ min: REQUEST_ID_MAX_LENGTH + 1, max: REQUEST_ID_MAX_LENGTH + 64 }),
				fc.nat(),
				(request, kind, extraKey, junk, oversize, pick) => {
					const mutant: Record<string, unknown> = { ...request };
					const payload = request.payload;
					if (kind === "unknown-key") {
						// Strict shapes refuse any undeclared key, envelope and payload
						// alike; the suffix keeps the key unknown, never a prototype setter.
						const target = payload !== null && pick % 2 === 0 ? (payload as Record<string, unknown>) : mutant;
						const key = Object.hasOwn(target, extraKey) || isUnsafeRecordKey(extraKey) ? `${extraKey}Extra` : extraKey;
						if (target === mutant) {
							mutant[key] = junk;
						} else {
							mutant.payload = { ...target, [key]: junk };
						}
					} else if (kind === "wrong-type") {
						if (payload === null) {
							// The parameterless methods take the literal null and nothing else.
							mutant.payload = junk;
						} else {
							const record = payload as Record<string, unknown>;
							const keys = Object.keys(record);
							const key = keys[pick % keys.length] ?? "label";
							// setUsageAlertThresholds.values, the schema-keywords list, and
							// the language filter's languages patch legally hold any bounded
							// array of their element type, so the array junk is not a wrong
							// type there; NaN still is.
							mutant.payload = {
								...record,
								[key]: (key === "values" || key === "languages") && Array.isArray(junk) ? Number.NaN : junk,
							};
						}
					} else {
						// Every request carries the envelope id; the adopt and hide
						// payloads carry a second bounded token.
						const record = payload !== null ? (payload as Record<string, unknown>) : {};
						if (Object.hasOwn(record, "sourceHandle") && pick % 2 === 0) {
							mutant.payload = { ...record, sourceHandle: "x".repeat(oversize) };
						} else {
							mutant.id = "x".repeat(oversize);
						}
					}
					assert.strictEqual(parseDashboardRequest(mutant).success, false, `a ${kind} mutant must be refused`);
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("correlation tokens pin their bounds", () => {
		const base = { kind: "request", method: "removeServerSetting", payload: { label: "a" } };
		assert.ok(parseDashboardRequest({ ...base, id: "x".repeat(REQUEST_ID_MAX_LENGTH) }).success);
		assert.strictEqual(parseDashboardRequest({ ...base, id: "x".repeat(REQUEST_ID_MAX_LENGTH + 1) }).success, false);
		assert.strictEqual(parseDashboardRequest({ ...base, id: "" }).success, false);
	});
});

/**
 * The schema by hand (the oracle): strict keep/clear with no other key riding
 * along, and set with a location literal and a string value. The property
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
