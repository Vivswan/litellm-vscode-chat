import * as assert from "node:assert";
import { SETUP_HINT_KINDS, TRANSPORT_ERROR_KINDS, transportClassificationOf } from "../../shared/errorClassification";

suite("shared/errorClassification", () => {
	test("a full classification shape extracts kind, status, and setupHint", () => {
		const extracted = transportClassificationOf({ kind: "http", status: 404, setupHint: "check-base-url" });
		assert.deepStrictEqual(extracted, { kind: "http", status: 404, setupHint: "check-base-url" });
	});

	test("a kind-only shape extracts without status or setupHint properties", () => {
		const extracted = transportClassificationOf({ kind: "network" });
		assert.deepStrictEqual(extracted, { kind: "network" });
		// Absent fields are truly absent, not present-as-undefined
		// (exactOptionalPropertyTypes consumers spread these into literals).
		assert.ok(extracted !== undefined && !("status" in extracted) && !("setupHint" in extracted));
	});

	test("every declared kind round-trips; anything else answers undefined", () => {
		for (const kind of TRANSPORT_ERROR_KINDS) {
			assert.deepStrictEqual(transportClassificationOf({ kind }), { kind });
		}
		for (const junk of ["HTTP", "auth ", "", 404, null, undefined, {}, ["http"]]) {
			assert.strictEqual(transportClassificationOf({ kind: junk }), undefined, `kind ${JSON.stringify(junk)}`);
		}
	});

	test("a junk setupHint drops the field, never the classification", () => {
		for (const hint of SETUP_HINT_KINDS) {
			assert.deepStrictEqual(transportClassificationOf({ kind: "connection", setupHint: hint }), {
				kind: "connection",
				setupHint: hint,
			});
		}
		for (const junk of ["reboot", "", 1, null, {}]) {
			const extracted = transportClassificationOf({ kind: "connection", setupHint: junk });
			assert.deepStrictEqual(extracted, { kind: "connection" }, `setupHint ${JSON.stringify(junk)}`);
		}
	});

	test("a non-number status drops the field, never the classification", () => {
		for (const junk of ["404", null, {}, [404], true]) {
			const extracted = transportClassificationOf({ kind: "http", status: junk });
			assert.deepStrictEqual(extracted, { kind: "http" }, `status ${JSON.stringify(junk)}`);
		}
	});

	test("a non-integer number status drops the field: HTTP statuses are integers", () => {
		for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 404.5]) {
			const extracted = transportClassificationOf({ kind: "http", status: junk });
			assert.deepStrictEqual(extracted, { kind: "http" }, `status ${String(junk)}`);
		}
	});

	test("null, undefined, and primitive inputs answer undefined", () => {
		for (const input of [null, undefined, "http", 404, true, Symbol("http")]) {
			assert.strictEqual(transportClassificationOf(input), undefined);
		}
	});

	test("hostile getters answer undefined instead of throwing", () => {
		const hostileKind = new Proxy(
			{},
			{
				get() {
					throw new Error("hostile getter");
				},
			}
		);
		assert.strictEqual(transportClassificationOf(hostileKind), undefined);

		// A valid kind whose OTHER fields throw must not poison the extraction
		// either: the whole read is guarded, so it degrades to undefined.
		const hostileStatus = {
			kind: "http",
			get status(): number {
				throw new Error("hostile getter");
			},
		};
		assert.strictEqual(transportClassificationOf(hostileStatus), undefined);
	});
});
