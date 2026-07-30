import * as assert from "node:assert";
import * as fc from "fast-check";
import { validateHeadersRecord } from "../../extension/dashboard/state";
import type { HeaderScalar } from "../../shared/headers";
import { HEADER_NAME_PATTERN, isHeaderScalar, isValidHeaderValue } from "../../shared/headers";
import { isUnsafeRecordKey } from "../../shared/json";
import { normalizeCustomHeaders } from "../../shared/settings";
import { resolveFuzzSeed } from "../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

/**
 * normalizeCustomHeaders sits between user-typed settings and the platform's
 * Headers, whose TypeError on an invalid value embeds the full plaintext -
 * and header values can be secrets. So the headline property is totality:
 * whatever the setting holds, the function returns a record and never throws,
 * and everything it returns is sendable.
 */

/**
 * Header-name-ish keys: valid tokens, arbitrary code points (fast-check 4's
 * default string unit is ASCII-only, so the "binary" arm is what actually
 * supplies unicode, lone surrogates, and control characters), plus reserved
 * and deliberately malformed names.
 */
const tokenChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&'*+-.^_`|~");
const headerNameArb = fc.oneof(
	fc.string({ unit: tokenChar, minLength: 1, maxLength: 12 }),
	fc.string({ maxLength: 12 }),
	fc.string({ unit: "binary", maxLength: 12 }),
	fc.constantFrom("__proto__", "constructor", "prototype", "x header", "x\theader", "", " x", "héader", "x:y")
);

/** Header-value-ish values: sendable strings, CR/LF smuggling, arbitrary code points, non-scalars, junk numbers. */
const headerValueArb = fc.oneof(
	fc.string({ maxLength: 24 }),
	fc.string({ unit: "binary", maxLength: 24 }),
	fc.constantFrom("ok", "with\r\nnewline", "nul\0byte", "tab\tis fine", "", "trailing "),
	fc.double(),
	fc.boolean(),
	fc.constantFrom(null, undefined, Number.NaN, Number.POSITIVE_INFINITY),
	fc.jsonValue({ maxDepth: 1 })
);

const headersRecordArb = fc.dictionary(headerNameArb, headerValueArb, { maxKeys: 8 });

suite("shared/settings normalizeCustomHeaders properties", () => {
	test("never throws, over JSON values and arbitrary values alike", () => {
		fc.assert(
			fc.property(fc.oneof(fc.jsonValue(), fc.anything()), (raw) => {
				normalizeCustomHeaders(raw);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("every output entry is a sendable header: token name, safe key, valid value", () => {
		fc.assert(
			fc.property(headersRecordArb, (raw) => {
				const headers = normalizeCustomHeaders(raw);
				for (const [name, value] of Object.entries(headers)) {
					assert.ok(HEADER_NAME_PATTERN.test(name), `name "${name}" must be an RFC 9110 token`);
					assert.ok(!isUnsafeRecordKey(name), `name "${name}" must not be a reserved record key`);
					assert.strictEqual(typeof value, "string");
					assert.ok(isValidHeaderValue(value), `value of "${name}" must be sendable`);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("normalization is idempotent", () => {
		fc.assert(
			fc.property(headersRecordArb, (raw) => {
				const once = normalizeCustomHeaders(raw);
				assert.deepStrictEqual(normalizeCustomHeaders(once), once);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("a record the dashboard validator accepts round-trips whole: every accepted write is sent", () => {
		// validateHeadersRecord guards dashboard setHeaders intents; the request
		// path re-reads the written setting through normalizeCustomHeaders. If
		// the validator accepted something the normalizer drops, a write would
		// silently not be sent - this pins the accepted domain. The converse
		// does not hold (see the padded-name test below), so this property says
		// nothing about names only the normalizer takes.
		const scalarArb: fc.Arbitrary<HeaderScalar> = fc.oneof(
			fc.string({ maxLength: 24 }),
			fc.double({ noNaN: true, noDefaultInfinity: true }),
			fc.boolean()
		);
		fc.assert(
			fc.property(fc.dictionary(headerNameArb, scalarArb, { maxKeys: 8 }), (record) => {
				fc.pre(Object.values(record).every(isHeaderScalar));
				const verdict = validateHeadersRecord(record);
				const normalized = normalizeCustomHeaders(record);
				if (verdict === undefined) {
					assert.strictEqual(
						Object.keys(normalized).length,
						Object.keys(record).length,
						"an accepted record must survive normalization entry for entry"
					);
					for (const [name, value] of Object.entries(record)) {
						assert.strictEqual(normalized[name], String(value));
					}
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("padded names trim in settings but the dashboard editor refuses them (pinned asymmetry)", () => {
		// headerNameSchema trims before matching, so a hand-authored padded name
		// is sent under its trimmed form; validateHeadersRecord checks the raw
		// name and refuses, so the dashboard cannot create such an entry. Two
		// names that collide after trimming collapse to one header, last wins.
		assert.deepStrictEqual(normalizeCustomHeaders({ " x": "1" }), { x: "1" });
		assert.notStrictEqual(validateHeadersRecord({ " x": "1" }), undefined);
		assert.deepStrictEqual(normalizeCustomHeaders({ x: "a", " x": "b" }), { x: "b" });
	});
});
