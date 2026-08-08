import * as assert from "node:assert";
import * as fc from "fast-check";
import { normalizeCustomHeaders } from "../../../shared/config/settings";
import { HEADER_NAME_PATTERN, isValidHeaderValue } from "../../../shared/util/headers";
import { isUnsafeRecordKey } from "../../../shared/util/json";
import { resolveFuzzSeed } from "../../fuzzStream";

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

suite("shared/config/settings normalizeCustomHeaders properties", () => {
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

	test("padded names trim, and colliding names collapse to one header with the first winning", () => {
		// headerNameSchema trims before matching, so a hand-authored padded name
		// is sent under its trimmed form. Two names that collide after trimming
		// (or that differ only by case) are one HTTP header: the first one in
		// the object wins and the collision is reported as a diagnostic.
		assert.deepStrictEqual(normalizeCustomHeaders({ " x": "1" }), { x: "1" });
		assert.deepStrictEqual(normalizeCustomHeaders({ x: "a", " x": "b" }), { x: "a" });
		assert.deepStrictEqual(normalizeCustomHeaders({ "X-Env": "a", "x-env": "b" }), { "X-Env": "a" });
	});
});
