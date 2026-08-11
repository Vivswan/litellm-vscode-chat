import * as assert from "node:assert";
import * as l10n from "@vscode/l10n";
import * as fc from "fast-check";
import type { HeaderScalar } from "../../../extension/dashboard/protocol";
import { CONSUMED_CAPABILITY_FIELDS } from "../../../extension/dashboard/protocol";
import {
	parseCapabilityGroups,
	parseGroups,
	parseHeaderRows,
	toCapabilityGroups,
	toGroups,
	toHeaderRows,
} from "../../../extension/dashboard/recordDraft";
import { filterUnrecognizedKeyDiagnostics } from "../../../extension/dashboard/state";
import { lintCapabilityRecords } from "../../../shared/config/capabilityResolution";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 100;
const SEED = resolveFuzzSeed();

// Reserved names are rejected by validation, and assembly trims keys, so the
// clean domain is trimmed non-empty keys outside the reserved set.
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const recordKeyChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.-/");
const recordKey = fc
	.string({ unit: recordKeyChar, minLength: 1, maxLength: 12 })
	.filter((key) => !RESERVED_KEYS.has(key));

const paramsRecord = fc.dictionary(recordKey, fc.jsonValue({ maxDepth: 2 }), { maxKeys: 5 });
const modelParametersRecord = fc.dictionary(recordKey, paramsRecord, { maxKeys: 5 });

// The clean capability domain: known fields with correctly typed values,
// plus the two directives. Unknown keys are legal too (hint, not block) but
// stay out of the clean round-trip domain because their values are free JSON.
const capabilityFieldEntry: fc.Arbitrary<[string, unknown]> = fc.oneof(
	fc.tuple(
		fc.constantFrom("context_length", "max_input_tokens", "max_output_tokens"),
		fc.integer({ min: 1, max: 10_000_000 })
	),
	fc.tuple(
		fc.constantFrom("supports_function_calling", "supports_vision", "supports_reasoning", "supports_audio_input"),
		fc.boolean()
	),
	// The retired _declare directive stays as reserved-underscore noise.
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

// The request path drops values outside the shared header-value charset
// (isValidHeaderValue: no CR/LF or other control octets; empty is legal) and
// parseHeaderValue trims, so the clean domain is trim-stable strings without
// line breaks.
const headerValueString = fc.string({ maxLength: 20 }).map((s) => s.replace(/[\r\n]/g, " ").trim());

const headerScalar: fc.Arbitrary<HeaderScalar> = fc.oneof(fc.boolean(), finiteNumber, headerValueString);
// Ordinary prototype: parseHeaderRows always returns one, and the round trip compares prototypes.
const headersRecord = fc.dictionary(headerName, headerScalar, { maxKeys: 6, noNullPrototype: true });

const hostileText = fc.oneof(
	fc.string({ maxLength: 15 }),
	fc.constantFrom("__proto__", "constructor", "prototype", '{"polluted":true}', "")
);
const hostileGroups = fc.array(
	fc.record({
		prefix: hostileText,
		params: fc.array(fc.record({ key: hostileText, valueText: hostileText }), { maxLength: 4 }),
	}),
	{ maxLength: 4 }
);
const hostileRows = fc.array(fc.record({ name: hostileText, valueText: hostileText }), { maxLength: 6 });

suite("extension/dashboard/recordDraft round-trip properties", () => {
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

// The advisory-hint coupling domain: records mixing OPEN fields (unknown
// keys, arbitrary JSON values) with consumed fields carrying VALID values,
// and no directives - so the only hint the editor can emit is the
// unknown-key one, and the only surviving host diagnostic of interest is
// unrecognized-key. The charsets carry no underscore, so an open key can
// never collide with a consumed or core name (all of which contain one).
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
/** The evidence side: absent entirely, or a mix of open-shaped keys and consumed names (an observed key is real either way). */
const observedKeySet = fc.option(
	fc.array(fc.oneof(recordKey, fc.constantFrom(...Object.keys(CONSUMED_CAPABILITY_FIELDS))), { maxLength: 6 }),
	{ nil: undefined }
);

suite("extension/dashboard/recordDraft advisory-hint coupling properties", () => {
	test("the editor's live unknown-key hints equal the host filter's surviving diagnostics, record for record", () => {
		// The one coupling test over the twice-implemented boundary: the host
		// path (lintCapabilityRecords -> filterUnrecognizedKeyDiagnostics) and
		// the editor path (parseCapabilityGroups with the recognizedKeys Set)
		// must produce the same (record key, field key) hint set for the same
		// record and evidence, or the dashboard's live drafts drift from what
		// the Diagnostics tab shows after the save.
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

suite("extension/dashboard/recordDraft hostile-input properties", () => {
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
