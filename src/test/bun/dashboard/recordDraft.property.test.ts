/**
 * Round-trip and hint-coupling properties for the record draft editors, over clean domains the parsers accept
 * unchanged.
 *
 * A clean record key is trimmed, non-empty, and outside the reserved set: validation rejects reserved names and
 * assembly trims keys. The clean capability domain is known fields with correctly typed values plus the two
 * directives, the retired `_declare` riding along as reserved-underscore noise. Unknown keys are legal too (a hint,
 * not a block) but stay out because their values are free JSON.
 *
 * A clean header value is a trim-stable string without line breaks: the request path drops values outside the shared
 * header-value charset (no CR/LF or other control octets; empty is legal) and parseHeaderValue trims. A clean header
 * record has an ordinary prototype, since parseHeaderRows always returns one and the round trip compares prototypes,
 * and names unique case-insensitively (headerNameKey), the one spelling the host accepts per header.
 *
 * The advisory-hint domain mixes open fields with consumed fields carrying valid values and no directives, so
 * unknown-key is the only hint either side can emit. The charsets carry no underscore, so an open key can never
 * collide with a consumed or core name. The observed-key evidence is absent entirely, or a mix of open-shaped keys
 * and consumed names: an observed key is real either way.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as l10n from "@vscode/l10n";
import * as fc from "fast-check";
import {
	newParamRow,
	parseCapabilityGroups,
	parseGroups,
	parseHeaderRows,
	toCapabilityGroups,
	toGroups,
	toHeaderRows,
} from "../../../dashboard/recordDraft";
import {
	CONSUMED_CAPABILITY_FIELDS,
	filterUnrecognizedKeyDiagnostics,
	lintCapabilityRecords,
} from "../../../shared/config/capabilityResolution";
import type { HeaderScalar } from "../../../shared/util/headers";
import { headerNameKey } from "../../../shared/util/headers";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 100;
const SEED = resolveFuzzSeed();

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const recordKeyChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.-/");
const recordKey = fc
	.string({ unit: recordKeyChar, minLength: 1, maxLength: 12 })
	.filter((key) => !RESERVED_KEYS.has(key));

const paramsRecord = fc.dictionary(recordKey, fc.jsonValue({ maxDepth: 2 }), { maxKeys: 5 });
const modelParametersRecord = fc.dictionary(recordKey, paramsRecord, { maxKeys: 5 });

const capabilityFieldEntry: fc.Arbitrary<[string, unknown]> = fc.oneof(
	fc.tuple(
		fc.constantFrom("context_length", "max_input_tokens", "max_output_tokens"),
		fc.integer({ min: 1, max: 10_000_000 })
	),
	fc.tuple(
		fc.constantFrom("supports_function_calling", "supports_vision", "supports_reasoning", "supports_audio_input"),
		fc.boolean()
	),
	fc.tuple(fc.constant("_declare"), fc.boolean()),
	fc.tuple(fc.constant("_openrouter_model"), recordKey)
);

const capabilityRecord = fc.dictionary(
	recordKey,
	fc.array(capabilityFieldEntry, { maxLength: 6 }).map((entries) => Object.fromEntries(entries)),
	{ maxKeys: 5, noNullPrototype: true }
);

const headerNameChar = fc.constantFrom(
	..."!#$%&'*+.^_|~-",
	..."abcdefghijklmnopqrstuvwxyz",
	..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
	..."0123456789"
);
const headerName = fc
	.string({ unit: headerNameChar, minLength: 1, maxLength: 12 })
	.filter((name) => !RESERVED_KEYS.has(name));

const finiteNumber = fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => (Object.is(n, -0) ? 0 : n));

const headerValueString = fc.string({ maxLength: 20 }).map((s) => s.replace(/[\r\n]/g, " ").trim());

const headerScalar: fc.Arbitrary<HeaderScalar> = fc.oneof(fc.boolean(), finiteNumber, headerValueString);

const headersRecord = fc
	.dictionary(headerName, headerScalar, { maxKeys: 6, noNullPrototype: true })
	.filter((record) => new Set(Object.keys(record).map(headerNameKey)).size === Object.keys(record).length);

const hostileText = fc.oneof(
	fc.string({ maxLength: 15 }),
	fc.constantFrom("__proto__", "constructor", "prototype", '{"polluted":true}', "")
);
const hostileGroups = fc.array(
	fc.record({
		prefix: hostileText,
		params: fc.array(
			fc.record({ key: hostileText, valueText: hostileText }).map(({ key, valueText }) => newParamRow(key, valueText)),
			{ maxLength: 4 }
		),
	}),
	{ maxLength: 4 }
);
const hostileRows = fc.array(fc.record({ name: hostileText, valueText: hostileText }), { maxLength: 6 });

describe("dashboard/recordDraft round-trip properties", () => {
	test("clean modelParameters records parse clean and reassemble unchanged", () => {
		fc.assert(
			fc.property(modelParametersRecord, (raw) => {
				const value = JSON.parse(JSON.stringify(raw)) as Record<string, Record<string, unknown>>;
				const parse = parseGroups(toGroups(value));
				assert.ok(parse.ok, "the clean domain must parse clean");
				assert.deepStrictEqual(parse.value, value);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("clean modelCapabilities records parse clean and reassemble unchanged", () => {
		fc.assert(
			fc.property(capabilityRecord, (value) => {
				const parse = parseCapabilityGroups(toCapabilityGroups(value));
				assert.ok(parse.ok, "the clean domain must parse clean");
				assert.deepStrictEqual(parse.value, value);
				for (const group of parse.issues) {
					for (const row of group.rows) {
						assert.strictEqual(row.hint, undefined, "the clean domain carries no hints");
					}
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("clean header records parse clean and reassemble with their scalar types intact", () => {
		fc.assert(
			fc.property(headersRecord, (value) => {
				const parse = parseHeaderRows(toHeaderRows(value));
				assert.ok(parse.ok, "the clean domain must parse clean");
				assert.deepStrictEqual(parse.value, value);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

const openFieldRecord = fc.dictionary(recordKey, fc.jsonValue({ maxDepth: 2 }), { maxKeys: 3, noNullPrototype: true });

const validConsumedEntry: fc.Arbitrary<[string, unknown]> = fc.oneof(
	fc.tuple(
		fc.constantFrom("input_cost_per_token", "output_cost_per_token", "cache_read_input_token_cost"),
		fc.double({ min: 0, noNaN: true, noDefaultInfinity: true }).map((n) => (Object.is(n, -0) ? 0 : n))
	),
	fc.tuple(fc.constantFrom("supports_prompt_caching", "supports_pdf_input", "supports_response_schema"), fc.boolean()),
	fc.tuple(
		fc.constant("supported_openai_params"),
		fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 })
	)
);
const mixedFieldsRecord: fc.Arbitrary<Record<string, unknown>> = fc
	.tuple(openFieldRecord, fc.array(validConsumedEntry, { maxLength: 3 }))
	.map(([open, consumed]) => ({ ...open, ...Object.fromEntries(consumed) }));
const advisoryRecordMap = fc.dictionary(recordKey, mixedFieldsRecord, { maxKeys: 3, noNullPrototype: true });

const observedKeySet = fc.option(
	fc.array(fc.oneof(recordKey, fc.constantFrom(...Object.keys(CONSUMED_CAPABILITY_FIELDS))), { maxLength: 6 }),
	{ nil: undefined }
);

describe("dashboard/recordDraft advisory-hint coupling properties", () => {
	test("the editor's live unknown-key hints equal the host filter's surviving diagnostics, record for record", () => {
		// The twice-implemented boundary: the host path (lintCapabilityRecords ->
		// filterUnrecognizedKeyDiagnostics) and the editor path must hint the same (record key, field key) set, or live
		// drafts drift from what the Diagnostics tab shows after the save.
		fc.assert(
			fc.property(advisoryRecordMap, observedKeySet, (record, observed) => {
				const value = JSON.parse(JSON.stringify(record)) as Record<string, Record<string, unknown>>;
				const hostHinted = filterUnrecognizedKeyDiagnostics(lintCapabilityRecords(value), observed)
					.filter((diagnostic) => diagnostic.kind === "unrecognized-key")
					.map((diagnostic) => `${diagnostic.recordKey}\u0000${diagnostic.key}`)
					.sort();
				const groups = toCapabilityGroups(value);
				const parse = parseCapabilityGroups(groups, observed === undefined ? undefined : new Set(observed));
				assert.ok(parse.ok, "the clean domain must parse clean");
				const editorHinted: string[] = [];
				parse.issues.forEach((groupIssues, groupIndex) => {
					const prefix = groups[groupIndex]?.prefix ?? "";
					groupIssues.rows.forEach((row, rowIndex) => {
						if (row.hint === undefined) {
							return;
						}
						const key = groups[groupIndex]?.params[rowIndex]?.key ?? "";
						assert.strictEqual(
							row.hint,
							l10n.t('"{0}" is not a field this extension knows; it is applied as an override as-is', key),
							"the clean domain hints only as unknown-key"
						);
						editorHinted.push(`${prefix}\u0000${key}`);
					});
				});
				assert.deepStrictEqual(editorHinted.sort(), hostHinted);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

describe("dashboard/recordDraft hostile-input properties", () => {
	test("hostile drafts never throw and never touch Object.prototype", () => {
		fc.assert(
			fc.property(hostileGroups, hostileRows, (groups, rows) => {
				const before = Object.getOwnPropertyNames(Object.prototype).sort();

				const parsedGroups = parseGroups(groups);
				const parsedHeaders = parseHeaderRows(rows);
				const parsedCaps = parseCapabilityGroups(groups);

				if (parsedCaps.ok) {
					assert.strictEqual(
						Object.getPrototypeOf(parsedCaps.value),
						Object.prototype,
						"capability prototype stays ordinary"
					);
				}

				if (parsedGroups.ok) {
					assert.strictEqual(
						Object.getPrototypeOf(parsedGroups.value),
						Object.prototype,
						"group prototype stays ordinary"
					);
				}
				if (parsedHeaders.ok) {
					assert.strictEqual(
						Object.getPrototypeOf(parsedHeaders.value),
						Object.prototype,
						"header prototype stays ordinary"
					);
				}
				assert.deepStrictEqual(
					Object.getOwnPropertyNames(Object.prototype).sort(),
					before,
					"Object.prototype gains and loses nothing"
				);
				assert.strictEqual(({} as Record<string, unknown>).polluted, undefined, "no pollution through JSON values");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
