import * as assert from "node:assert";
import * as fc from "fast-check";
import {
	formatHeaderValue,
	formatJsonValue,
	type HeaderScalar,
	parseHeaderValue,
	parseJsonValue,
} from "../../dashboard/protocol";
import { isHeaderScalar } from "../../shared/util/headers";
import { resolveFuzzSeed } from "../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 100;
const SEED = resolveFuzzSeed();

const whitespaceOnly = fc.string({ unit: fc.constantFrom(" ", "\t", "\n", "\r"), maxLength: 6 });

const finiteNumber = fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => (Object.is(n, -0) ? 0 : n));

// parseHeaderValue trims its input, so only strings equal to their trim can round-trip.
const trimmedString = fc.string({ maxLength: 20 }).map((s) => s.trim());

const headerScalar: fc.Arbitrary<HeaderScalar> = fc.oneof(fc.boolean(), finiteNumber, trimmedString);

suite("dashboard/protocol JSON value properties", () => {
	test("parseJsonValue inverts formatJsonValue over JSON values", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (raw) => {
				const value: unknown = JSON.parse(JSON.stringify(raw));
				const parsed = parseJsonValue(formatJsonValue(value));
				assert.ok(parsed.ok, "formatted JSON must parse back cleanly");
				assert.deepStrictEqual(parsed.value, value);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("parseJsonValue never throws and every failure carries a non-empty error", () => {
		fc.assert(
			fc.property(fc.string(), (text) => {
				const parsed = parseJsonValue(text);
				if (!parsed.ok) {
					assert.ok(parsed.error.length > 0, "a failure must explain itself");
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("whitespace-only input is always a validation error", () => {
		fc.assert(
			fc.property(whitespaceOnly, (text) => {
				assert.strictEqual(parseJsonValue(text).ok, false);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

suite("dashboard/protocol header value properties", () => {
	test("parseHeaderValue inverts formatHeaderValue and preserves the scalar type", () => {
		fc.assert(
			fc.property(headerScalar, (value) => {
				const roundTripped = parseHeaderValue(formatHeaderValue(value));
				assert.strictEqual(typeof roundTripped, typeof value);
				assert.strictEqual(roundTripped, value);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("a string that spells a JSON scalar stays a string through the round trip", () => {
		fc.assert(
			fc.property(fc.oneof(finiteNumber, fc.integer(), fc.boolean()), (scalar) => {
				const text = String(scalar);
				const roundTripped = parseHeaderValue(formatHeaderValue(text));
				assert.strictEqual(typeof roundTripped, "string", `"${text}" must not collapse into a ${typeof scalar}`);
				assert.strictEqual(roundTripped, text);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("parseHeaderValue never throws and always returns a sendable scalar", () => {
		fc.assert(
			fc.property(fc.string(), (text) => {
				const value = parseHeaderValue(text);
				assert.ok(
					isHeaderScalar(value),
					"header values satisfy the same predicate the setHeaders intent schema enforces"
				);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
