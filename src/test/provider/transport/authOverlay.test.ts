/**
 * setOwnedHeader and plainFetchBaseHeaders directly: the ownership rule every plain-fetch transport (usage, one-shot
 * chat, FIM) rides on, and the type that keeps an unminted value off the wire.
 *
 *   a value only the brand can carry -> no sending path re-checks it or drops it
 */
import * as assert from "node:assert";
import { plainFetchBaseHeaders, setOwnedHeader } from "../../../provider/transport/authOverlay";
import { fixedHeaderValue, type HeaderValue } from "../../../shared/util/headers";

suite("provider/transport/authOverlay", () => {
	suite("setOwnedHeader", () => {
		test("owns the name outright: every existing spelling is removed, whatever the case", () => {
			const headers: Record<string, HeaderValue> = {
				authorization: fixedHeaderValue("custom-a"),
				AUTHORIZATION: fixedHeaderValue("custom-b"),
				"X-Other": fixedHeaderValue("kept"),
			};
			setOwnedHeader(headers, "Authorization", fixedHeaderValue("Bearer token"));
			assert.deepStrictEqual(headers, { "X-Other": "kept", Authorization: "Bearer token" });
		});

		test("setting a fresh header leaves unrelated names alone", () => {
			const headers: Record<string, HeaderValue> = { "Content-Type": fixedHeaderValue("application/json") };
			setOwnedHeader(headers, "X-LiteLLM-Key", fixedHeaderValue("sk-virtual"));
			assert.deepStrictEqual(headers, { "Content-Type": "application/json", "X-LiteLLM-Key": "sk-virtual" });
		});

		test("accepts minted values only, so a value the platform's Headers would throw on cannot reach the wire", () => {
			// The drop that used to live here is gone with the input that needed it: a raw string does not compile.
			const rejected = (headers: Record<string, HeaderValue>) =>
				// @ts-expect-error only headerValue mints a HeaderValue; a raw string is not one
				setOwnedHeader(headers, "Authorization", "Bearer bad\r\nX-Evil: 1");
			void rejected;
		});
	});

	suite("plainFetchBaseHeaders", () => {
		const ua = fixedHeaderValue("ua/1.0");

		test("a set API key owns both auth headers and adds the explicit Bearer no SDK adds on plain fetch", () => {
			const headers = plainFetchBaseHeaders({
				apiKey: fixedHeaderValue("sk-key"),
				userAgent: ua,
				customHeaders: {
					Authorization: fixedHeaderValue("custom"),
					"x-api-key": fixedHeaderValue("conflicting"),
					"X-Trace": fixedHeaderValue("t1"),
				},
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
				userAgent: ua,
				customHeaders: { Authorization: fixedHeaderValue("Basic abc") },
			});
			assert.deepStrictEqual(headers, { Authorization: "Basic abc", "User-Agent": "ua/1.0" });
		});

		test("keyless without custom auth sends no auth header at all", () => {
			const headers = plainFetchBaseHeaders({ apiKey: "", userAgent: ua, customHeaders: {} });
			assert.deepStrictEqual(headers, { "User-Agent": "ua/1.0" });
		});
	});
});
