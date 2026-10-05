import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { failuresAfterStatePush, isExtensionMessage } from "../../../dashboard/endpoints";
import type { NumberDraftParse } from "../../../dashboard/presenters";
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
			// The operation-kind save failure is the load-bearing case: the save itself requests a sync whose push
			// arrives moments later and must not erase the warning that the stored secret is still in effect.
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

		test("parseJsonValue is strict JSON with an error for junk, empty, and overflowing input", () => {
			assert.deepStrictEqual(parseJsonValue("0.2"), { ok: true, value: 0.2 });
			assert.deepStrictEqual(parseJsonValue(' ["stop"] '), { ok: true, value: ["stop"] });
			assert.strictEqual(parseJsonValue("hello").ok, false);
			assert.strictEqual(parseJsonValue("").ok, false);
			// JSON.parse("1e999") is Infinity, which the setting would store as null and the row would render "null"; the
			// refusal names where in a structured value.
			const overflowing: readonly (readonly [string, string])[] = [
				["1e999", "Number too large for JSON; it would be saved as null"],
				["-1e999", "Number too large for JSON; it would be saved as null"],
				["[1e999]", "Number too large for JSON at [0]; it would be saved as null"],
				['{"temperature": 1e999}', "Number too large for JSON at temperature; it would be saved as null"],
				['{"a": {"b": [0, 1e999]}}', "Number too large for JSON at a.b[1]; it would be saved as null"],
			];
			for (const [text, error] of overflowing) {
				assert.deepStrictEqual(parseJsonValue(text), { ok: false, error }, text);
			}
			// The scan for those must survive whatever JSON.parse survives: a recursive walk overflowed the stack on the
			// deep value, and spreading children into push overflowed it on the wide one.
			for (const large of [`${"[".repeat(5000)}0${"]".repeat(5000)}`, `[${"0,".repeat(199999)}0]`]) {
				assert.deepStrictEqual(parseJsonValue(large), { ok: true, value: JSON.parse(large) as unknown });
			}
		});

		test("parseHeaderValue takes JSON scalars typed and everything else as the literal string", () => {
			assert.strictEqual(parseHeaderValue("true"), true);
			assert.strictEqual(parseHeaderValue("42"), 42);
			assert.strictEqual(parseHeaderValue('"42"'), "42");
			assert.strictEqual(parseHeaderValue("abc def"), "abc def");
			assert.strictEqual(parseHeaderValue("[1]"), "[1]", "non-scalar JSON stays a string");
			// Overflowing numeric literals parse to Infinity, which isHeaderScalar refuses at the intent boundary; the
			// literal string is the only reading that keeps Apply from being a silent no-op.
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
			// ms settings read drafts under the duration grammar, so their junk verdict names the grammar.
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "soon"), {
				kind: "invalid",
				problem: "Not a duration - use ms, s, m, or h",
			});
			assert.strictEqual(parseNumberDraft("chat.timeout", "999").kind, "invalid", "below the 1000 minimum");
			// 2^31 would make the timer fire after 1 ms and 1000.5 would throw in it; both are refused as typed, never
			// clamped or rounded, with the one message the host write and the settings reader judge by.
			for (const text of ["2147483648", "1000.5"]) {
				assert.deepStrictEqual(parseNumberDraft("chat.timeout", text), {
					kind: "invalid",
					problem: "chat.timeout must be a whole number between 1000 and 2147483647.",
				});
			}
			assert.deepStrictEqual(parseNumberDraft("discovery.cacheTtl", "0"), { kind: "value", value: 0 });
		});

		test("parseNumberDraft: the duration grammar on ms settings - suffixes scale, bare numbers stay ms", () => {
			const refused: NumberDraftParse = {
				kind: "invalid",
				problem: "chat.timeout must be a whole number between 1000 and 2147483647.",
			};
			const value = (ms: number): NumberDraftParse => ({ kind: "value", value: ms });
			// Case-insensitive, whitespace-tolerant, fractional prefixes allowed; the product is exact decimal arithmetic, so
			// "1.001s" (float product 1000.9999999999999) reads as 1001 while an authored fraction is refused, never rounded
			// ("1.0005s" used to commit as 1001).
			const cases: readonly (readonly [string, NumberDraftParse])[] = [
				["1500ms", value(1500)],
				["90s", value(90000)],
				["5m", value(300000)],
				[" 5 M ", value(300000)],
				["1.5h", value(5400000)],
				["1.1s", value(1100)],
				["1.001s", value(1001)],
				["1.001 s", value(1001)],
				["1.001e0s", value(1001)],
				["1.0005s", refused],
				["2147483647.4ms", refused],
				["2147483.647000007s", refused],
				["1000.0000001ms", refused],
				// Below float precision: the exact remainder is nonzero, and Number must not round it back to 1000.
				["1000.0000000000000001ms", refused],
				["1.0000000000000000001s", refused],
				["1000.0000000000000001", refused],
				// An exponent past any millisecond count is a refusal, not a power of ten the runtime cannot build; one
				// that cancels against spelled zeros is exact; a result past Number's range is refused by its bound.
				["1e999999999999999999999s", refused],
				[`1${"0".repeat(401)}e-401s`, value(1000)],
				["1e309s", refused],
				["9e307h", refused],
				["500ms", refused],
			];
			for (const [text, expected] of cases) {
				assert.deepStrictEqual(parseNumberDraft("chat.timeout", text), expected, JSON.stringify(text));
			}
			assert.deepStrictEqual(parseNumberDraft("discovery.cacheTtl", "1h"), value(3600000));
			assert.deepStrictEqual(parseNumberDraft("discovery.cacheTtl", "0e401s"), value(0), "an all-zero mantissa is 0");
			// A suffix needs a number.
			assert.strictEqual(parseNumberDraft("chat.timeout", "ms").kind, "invalid");
			assert.strictEqual(parseNumberDraft("chat.timeout", "h").kind, "invalid");
			// Unit typos are grammar errors, never silent guesses.
			assert.deepStrictEqual(parseNumberDraft("chat.timeout", "5 min"), {
				kind: "invalid",
				problem: "Not a duration - use ms, s, m, or h",
			});
			assert.strictEqual(parseNumberDraft("chat.timeout", "5d").kind, "invalid");
		});

		test("parseNumberDraft: a million-digit draft is refused on its digit count, never converted", () => {
			// The field parses every change twice; building this draft's BigInt took 133 ms each time and stalled the
			// dashboard for a quarter second per keystroke.
			const draft = "1".repeat(1_000_000);
			const started = performance.now();
			const parse = parseNumberDraft("chat.timeout", draft);
			const elapsedMs = performance.now() - started;
			assert.deepStrictEqual(parse, {
				kind: "invalid",
				problem: "chat.timeout must be a whole number between 1000 and 2147483647.",
			});
			assert.ok(elapsedMs < 50, `refusing the draft took ${elapsedMs} ms`);
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
				// Duration-grammar drafts feed the same one parse, so the hint echoes the suffixed spelling back in
				// clock units.
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
			// The sequence this pins: a setting pinned to exactly its default holds a rejected draft, Reset changes the
			// configured scope but not the value, and the field's draft-resync effect keys on draftSyncKey - so the
			// key must change or the invalid draft survives the reset.
			const beforeReset = draftSyncKey(300000, "workspace");
			const afterReset = draftSyncKey(300000, null);
			assert.notStrictEqual(afterReset, beforeReset);

			// Stable across pushes that change nothing, so typing is never clobbered by an unrelated refresh; sensitive
			// to value changes and to null values becoming numbers.
			assert.strictEqual(draftSyncKey(300000, "workspace"), beforeReset);
			assert.notStrictEqual(draftSyncKey(60000, "workspace"), beforeReset);
			assert.notStrictEqual(draftSyncKey(null, null), draftSyncKey(300000, null));
		});
	});
});
