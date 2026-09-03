import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { displayUrl, redactUrlCredentials } from "../../../../shared/util/displayUrl";

describe("shared/util/displayUrl", () => {
	test("userinfo is dropped; scheme, host, port, path, query, and fragment are retained", () => {
		const cases: readonly { input: string; expected: string; reason: string }[] = [
			{
				input: "http://user:pass@litellm.test:4000/v1",
				expected: "http://litellm.test:4000/v1",
				reason: "user:pass, keeping scheme/host/port/path",
			},
			{
				input: "https://user@litellm.test/v1",
				expected: "https://litellm.test/v1",
				reason: "a username-only userinfo",
			},
			{
				input: "http://:secret@litellm.test:4000",
				expected: "http://litellm.test:4000",
				reason: "a password-only userinfo",
			},
			{
				input: "http://u:p@host.test/path?a=1#frag",
				expected: "http://host.test/path?a=1#frag",
				reason: "query and fragment are kept",
			},
			{
				input: "http://u:p@host.test:8001",
				expected: "http://host.test:8001",
				reason: "no trailing slash added to a stripped bare origin",
			},
			{
				input: "http://u:p@host.test:8001/",
				expected: "http://host.test:8001/",
				reason: "a trailing slash the configured URL had is kept",
			},
		];
		for (const { input, expected, reason } of cases) {
			assert.strictEqual(displayUrl(input), expected, reason);
		}
	});

	test("a URL without userinfo passes through byte-identical, unnormalized", () => {
		for (const url of ["http://LITELLM.test:4000/v1/", "https://litellm.test:443", "http://localhost:4000"]) {
			assert.strictEqual(displayUrl(url), url);
		}
	});

	test("junk that does not parse as a URL passes through untouched", () => {
		for (const junk of ["", "not a url", "litellm.test:4000"]) {
			assert.strictEqual(displayUrl(junk), junk);
		}
	});

	test("a malformed URL carrying userinfo fails closed through the text scrub", () => {
		assert.strictEqual(displayUrl("http://user:pass@"), "http://");
	});
});

describe("shared/util/redactUrlCredentials", () => {
	test("userinfo inside free text is scrubbed; emails and credential-free URLs are untouched", () => {
		const cases: readonly { input: string; expected: string; reason: string }[] = [
			{
				input: "Invalid URL: http://user:pass@litellm.test:4000/v1",
				expected: "Invalid URL: http://litellm.test:4000/v1",
				reason: "userinfo is scrubbed out of a URL quoted inside prose",
			},
			{
				input: "see http://a@b@host/x",
				expected: "see http://host/x",
				reason: "greedy to the run's last @, so multi-@ userinfo leaves no tail",
			},
			{
				input: "contact admin@example.com",
				expected: "contact admin@example.com",
				reason: "a bare email in prose is not a credential",
			},
			{
				input: "GET http://litellm.test:4000/v1/models",
				expected: "GET http://litellm.test:4000/v1/models",
				reason: "a credential-free URL",
			},
		];
		for (const { input, expected, reason } of cases) {
			assert.strictEqual(redactUrlCredentials(input), expected, reason);
		}
	});
});
