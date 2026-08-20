import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { displayUrl, redactUrlCredentials } from "../../../../shared/util/displayUrl";

describe("shared/util/displayUrl", () => {
	test("strips user:pass userinfo and keeps scheme, host, port, and path", () => {
		assert.strictEqual(displayUrl("http://user:pass@litellm.test:4000/v1"), "http://litellm.test:4000/v1");
	});

	test("strips a username-only userinfo", () => {
		assert.strictEqual(displayUrl("https://user@litellm.test/v1"), "https://litellm.test/v1");
	});

	test("strips a password-only userinfo", () => {
		assert.strictEqual(displayUrl("http://:secret@litellm.test:4000"), "http://litellm.test:4000");
	});

	test("keeps query and fragment", () => {
		assert.strictEqual(displayUrl("http://u:p@host.test/path?a=1#frag"), "http://host.test/path?a=1#frag");
	});

	test("does not add a trailing slash to a stripped bare origin", () => {
		assert.strictEqual(displayUrl("http://u:p@host.test:8001"), "http://host.test:8001");
	});

	test("keeps a trailing slash the configured URL had", () => {
		assert.strictEqual(displayUrl("http://u:p@host.test:8001/"), "http://host.test:8001/");
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
	test("scrubs userinfo out of URLs quoted inside free text", () => {
		assert.strictEqual(
			redactUrlCredentials("Invalid URL: http://user:pass@litellm.test:4000/v1"),
			"Invalid URL: http://litellm.test:4000/v1"
		);
	});

	test("is greedy to the run's last @, so multi-@ userinfo leaves no password tail", () => {
		assert.strictEqual(redactUrlCredentials("see http://a@b@host/x"), "see http://host/x");
	});

	test("leaves bare emails in prose untouched", () => {
		assert.strictEqual(redactUrlCredentials("contact admin@example.com"), "contact admin@example.com");
	});

	test("leaves credential-free URLs untouched", () => {
		assert.strictEqual(
			redactUrlCredentials("GET http://litellm.test:4000/v1/models"),
			"GET http://litellm.test:4000/v1/models"
		);
	});
});
