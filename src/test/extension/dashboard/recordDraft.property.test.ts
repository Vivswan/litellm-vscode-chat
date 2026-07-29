import * as assert from "node:assert";
import * as fc from "fast-check";
import type { HeaderScalar } from "../../../extension/dashboard/protocol";
import { parseGroups, parseHeaderRows, toGroups, toHeaderRows } from "../../../extension/dashboard/recordDraft";
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

// The request path drops CR/LF values and parseHeaderValue trims, so the
// clean domain is trim-stable strings without line breaks.
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
