/**
 * The pure wire and draft helpers the panel and webview share: failure retirement, message guards, header and
 * JSON value parsing, draft sync keys.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { failuresAfterStatePush, isExtensionMessage } from "../../../dashboard/endpoints";
import {
	draftSyncKey,
	equivalence,
	formatHeaderValue,
	parseHeaderValue,
	parseJsonValue,
	parseNumberDraft,
} from "../../../dashboard/presenters";
import type { NumberSettingId } from "../../../shared/config/settingSpec";

describe("dashboard: protocol value helpers", () => {
	describe("wire and draft helpers", () => {
		test("failuresAfterStatePush: acked server-intent notices survive a push, push-signaled ones retire", () => {
			// The operation-kind save failure is the load-bearing case: the save
			// itself requests a sync whose push arrives moments later and must not
			// erase the warning that the stored secret is still in effect.
			const failures = {
				saveServerSetting: { seq: 1, message: "the stored secret remains", kind: "operation" },
				removeServerSetting: { seq: 2, message: "not applied", kind: "validation" },
				setHeaders: { seq: 3, message: "not applied", kind: "validation" },
				setNumberSetting: { seq: 4, message: "not applied", kind: "validation" },
			};

			const after = failuresAfterStatePush(failures);

			assert.deepStrictEqual(Object.keys(after).sort(), ["removeServerSetting", "saveServerSetting"]);
			assert.strictEqual(after.saveServerSetting, failures.saveServerSetting, "the surviving notice is unchanged");
		});

		test("failuresAfterStatePush returns the same object when nothing retires", () => {
			const failures = { saveServerSetting: { seq: 1, message: "m", kind: "operation" } };
			assert.strictEqual(failuresAfterStatePush(failures), failures);
		});

		test("isExtensionMessage accepts exactly the extension-to-webview envelope kinds", () => {
			for (const kind of ["push", "focusSection", "response", "ack", "fail"]) {
				assert.ok(isExtensionMessage({ kind }), kind);
			}
			assert.ok(!isExtensionMessage({ kind: "request" }), "webview-to-extension requests are not accepted");
			assert.ok(!isExtensionMessage({ kind: "__proto__" }), "inherited names never pass the own-key test");
			assert.ok(!isExtensionMessage({ type: "state" }), "the retired flat discriminant does not pass");
			assert.ok(!isExtensionMessage(undefined));
			assert.ok(!isExtensionMessage(42));
		});

		test("parseJsonValue is strict JSON with an error for junk and empty input", () => {
			assert.deepStrictEqual(parseJsonValue("0.2"), { ok: true, value: 0.2 });
			assert.deepStrictEqual(parseJsonValue(' ["stop"] '), { ok: true, value: ["stop"] });
			assert.strictEqual(parseJsonValue("hello").ok, false);
			assert.strictEqual(parseJsonValue("").ok, false);
		});

		test("parseHeaderValue takes JSON scalars typed and everything else as the literal string", () => {
			assert.strictEqual(parseHeaderValue("true"), true);
			assert.strictEqual(parseHeaderValue("42"), 42);
			assert.strictEqual(parseHeaderValue('"42"'), "42");
			assert.strictEqual(parseHeaderValue("abc def"), "abc def");
			assert.strictEqual(parseHeaderValue("[1]"), "[1]", "non-scalar JSON stays a string");
			// Overflowing numeric literals parse to Infinity, which isHeaderScalar
			// refuses at the intent boundary; the literal string is the only
			// reading that keeps Apply from being a silent no-op.
			assert.strictEqual(parseHeaderValue("1e999"), "1e999", "non-finite numbers stay strings");
			assert.strictEqual(parseHeaderValue("-1e999"), "-1e999", "non-finite numbers stay strings");
		});

		test("formatHeaderValue round-trips through parseHeaderValue", () => {
			const values = [true, 42, "42", "true", "plain", "x y"] as const;
			for (const value of values) {
				assert.strictEqual(parseHeaderValue(formatHeaderValue(value)), value);
			}
		});

		test("parseNumberDraft: invalid, clear, and value verdicts follow the spec", () => {
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", " 300000 "), { kind: "value", value: 300000 });
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", ""), {
				kind: "invalid",
				problem: "Enter a number",
			});
			// ms settings read drafts under the duration grammar, so their junk
			// verdict names the grammar.
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "soon"), {
				kind: "invalid",
				problem: "Not a duration - use ms, s, m, or h",
			});
			assert.strictEqual(parseNumberDraft("chat.timeout", "999").kind, "invalid", "below the 1000 minimum");
			assert.deepStrictEqual(parseNumberDraft("discovery.cacheTtl", "0"), { kind: "value", value: 0 });
		});

		test("parseNumberDraft: the duration grammar on ms settings - suffixes scale, bare numbers stay ms", () => {
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "1500ms"), { kind: "value", value: 1500 });
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "90s"), { kind: "value", value: 90000 });
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "5m"), { kind: "value", value: 300000 });
			assert.deepStrictEqual(parseNumberDraft("discovery.cacheTtl", "1h"), { kind: "value", value: 3600000 });
			// Case-insensitive, whitespace-tolerant, fractional prefixes allowed.
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", " 5 M "), { kind: "value", value: 300000 });
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "1.5h"), { kind: "value", value: 5400000 });
			// Suffixed values commit whole milliseconds: sub-ms precision in a
			// duration string is noise, and fractional timeouts are unusable.
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "1.0005s"), { kind: "value", value: 1001 });
			// A suffix needs a number, and a suffixed value still honors the bound.
			assert.strictEqual(parseNumberDraft("chat.timeout", "ms").kind, "invalid");
			assert.strictEqual(parseNumberDraft("chat.timeout", "h").kind, "invalid");
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "500ms"), {
				kind: "invalid",
				problem: "Must be at least 1000",
			});
			// Unit typos are grammar errors, never silent guesses.
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "5 min"), {
				kind: "invalid",
				problem: "Not a duration - use ms, s, m, or h",
			});
			assert.strictEqual(parseNumberDraft("chat.timeout", "5d").kind, "invalid");
			// A product that overflows to Infinity is as unwritable as junk.
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "9e307h"), {
				kind: "invalid",
				problem: "Not a duration - use ms, s, m, or h",
			});
		});

		/** The hint the settings form shows for a draft: parse once, then the equivalence of the committed value. */
		function equivalenceOfDraft(id: NumberSettingId, draft: string): string | undefined {
			const parse = parseNumberDraft(id, draft);
			return parse.kind === "value" ? equivalence(id, parse.value) : undefined;
		}

		test("equivalence renders millisecond durations in clock units, pinned at the unit boundaries", () => {
			const cases: [string, string | undefined][] = [
				["59999", "= ~59 s"],
				["60000", "= 1 min"],
				["300000", "= 5 min"],
				["3599999", "= ~59 min 59 s"],
				["3600000", "= 1 h"],
				["3661000", "= ~1 h 1 min"],
				// Duration-grammar drafts feed the same one parse, so the hint
				// echoes the suffixed spelling back in clock units.
				["90s", "= 1 min 30 s"],
				["5m", "= 5 min"],
				["1.5h", "= 1 h 30 min"],
			];
			for (const [draft, expected] of cases) {
				assert.strictEqual(equivalenceOfDraft("chat.timeout", draft), expected, `draft ${draft}`);
			}
		});

		test("equivalence yields nothing for empty, unparsable, below-minimum, or sub-second drafts", () => {
			assert.strictEqual(equivalenceOfDraft("chat.timeout", ""), undefined);
			assert.strictEqual(equivalenceOfDraft("chat.timeout", "soon"), undefined);
			assert.strictEqual(equivalenceOfDraft("chat.timeout", "999"), undefined, "below the 1000 minimum");
			assert.strictEqual(
				equivalenceOfDraft("discovery.cacheTtl", "500"),
				undefined,
				"sub-second reads as milliseconds"
			);
		});

		test("equivalence reads the TTL's zero through zeroMeaning, and only where 0 is legal", () => {
			assert.strictEqual(equivalenceOfDraft("discovery.cacheTtl", "0"), "= every refresh");
			assert.strictEqual(equivalenceOfDraft("chat.timeout", "0"), undefined, "0 never parses below the minimum");
			assert.strictEqual(equivalence("chat.timeout", 0), undefined, "and the hint itself has no zero reading");
		});

		test("draftSyncKey changes on a reset that only removes the configured scope, so a stale draft resyncs", () => {
			// The sequence this pins: a setting pinned to exactly its default holds
			// a rejected draft, Reset changes the configured scope but not the
			// value, and the field's draft-resync effect keys on draftSyncKey - so
			// the key must change or the invalid draft survives the reset.
			const beforeReset = draftSyncKey(300000, "workspace");
			const afterReset = draftSyncKey(300000, null);
			assert.notStrictEqual(afterReset, beforeReset);

			// Stable across pushes that change nothing, so typing is never
			// clobbered by an unrelated refresh; sensitive to value changes and
			// to null values becoming numbers.
			assert.strictEqual(draftSyncKey(300000, "workspace"), beforeReset);
			assert.notStrictEqual(draftSyncKey(60000, "workspace"), beforeReset);
			assert.notStrictEqual(draftSyncKey(null, null), draftSyncKey(300000, null));
		});
	});
});
