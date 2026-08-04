import * as assert from "node:assert";
import * as fc from "fast-check";
import type { HeaderScalar } from "../../../extension/dashboard/protocol";
import {
	parseCapabilityGroups,
	parseGroups,
	parseHeaderRows,
	toCapabilityGroups,
	toGroups,
	toHeaderRows,
} from "../../../extension/dashboard/recordDraft";
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
