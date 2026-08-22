/**
 * setOwnedHeader and plainFetchBaseHeaders directly: the ownership and
 * fail-closed rules every plain-fetch transport (usage, one-shot chat, FIM)
 * rides on. Previously pinned only through consumers; the rules are
 * load-bearing enough to hold on their own - a header value the platform's
 * Headers would reject must never reach it, because the thrown TypeError
 * embeds the full plaintext value and these values are secrets.
 */
import * as assert from "node:assert";
import { plainFetchBaseHeaders, setOwnedHeader } from "../../../provider/transport/authOverlay";

suite("provider/transport/authOverlay", () => {
	suite("setOwnedHeader", () => {
		test("owns the name outright: every existing spelling is removed, whatever the case", () => {
			const headers: Record<string, string> = {
				authorization: "custom-a",
				AUTHORIZATION: "custom-b",
				"X-Other": "kept",
			};
			assert.strictEqual(setOwnedHeader(headers, "Authorization", "Bearer token"), true);
			assert.deepStrictEqual(headers, { "X-Other": "kept", Authorization: "Bearer token" });
		});

		test("an invalid value is dropped fail-closed, and the displaced spellings are not resurrected", () => {
			const headers: Record<string, string> = { authorization: "custom" };
			assert.strictEqual(setOwnedHeader(headers, "Authorization", "Bearer bad\r\nX-Evil: 1"), false);
			assert.deepStrictEqual(headers, {}, "neither the invalid value nor the old spelling survives");
		});

		for (const [label, value] of [
			["a newline", "line\nbreak"],
			["a carriage return", "line\rbreak"],
			["a NUL byte", "nul\u0000byte"],
		] as const) {
			test(`${label} in the value fails closed`, () => {
				const headers: Record<string, string> = {};
				assert.strictEqual(setOwnedHeader(headers, "X-API-Key", value), false);
				assert.deepStrictEqual(headers, {});
			});
		}

		test("setting a fresh valid header reports true and leaves unrelated names alone", () => {
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			assert.strictEqual(setOwnedHeader(headers, "X-LiteLLM-Key", "sk-virtual"), true);
			assert.deepStrictEqual(headers, { "Content-Type": "application/json", "X-LiteLLM-Key": "sk-virtual" });
		});
	});

	suite("plainFetchBaseHeaders", () => {
		test("a set API key owns both auth headers and adds the explicit Bearer no SDK adds on plain fetch", () => {
			const headers = plainFetchBaseHeaders({
				apiKey: "sk-key",
				userAgent: "ua/1.0",
				customHeaders: { Authorization: "custom", "x-api-key": "conflicting", "X-Trace": "t1" },
			});
			assert.deepStrictEqual(headers, {
				"X-Trace": "t1",
				"User-Agent": "ua/1.0",
				"X-API-Key": "sk-key",
				Authorization: "Bearer sk-key",
			});
		});

		test("keyless keeps a custom Authorization and sends no bearer of its own", () => {
			const headers = plainFetchBaseHeaders({
				apiKey: "",
				userAgent: "ua/1.0",
				customHeaders: { Authorization: "Basic abc" },
			});
			assert.deepStrictEqual(headers, { Authorization: "Basic abc", "User-Agent": "ua/1.0" });
		});

		test("keyless without custom auth sends no auth header at all", () => {
			const headers = plainFetchBaseHeaders({ apiKey: "", userAgent: "ua/1.0", customHeaders: {} });
			assert.deepStrictEqual(headers, { "User-Agent": "ua/1.0" });
		});

		test("a custom header with an invalid value is filtered fail-closed", () => {
			const headers = plainFetchBaseHeaders({
				apiKey: "",
				userAgent: "ua/1.0",
				customHeaders: { "X-Bad": "evil\r\nInjected: 1", "X-Good": "fine" },
			});
			assert.deepStrictEqual(headers, { "X-Good": "fine", "User-Agent": "ua/1.0" });
		});

		test("an API key the platform would reject never reaches the header record", () => {
			const headers = plainFetchBaseHeaders({
				apiKey: "sk\r\nX-Evil: 1",
				userAgent: "ua/1.0",
				customHeaders: {},
			});
			// buildDefaultHeaders sets X-API-Key from the key and the explicit
			// Bearer goes through setOwnedHeader; both are value-filtered, so the
			// header-illegal secret is dropped everywhere rather than thrown by
			// the platform with the plaintext embedded.
			assert.deepStrictEqual(headers, { "User-Agent": "ua/1.0" });
		});
	});
});
