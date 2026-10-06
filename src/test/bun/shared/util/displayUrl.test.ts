import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { displayUrl } from "../../../../shared/util/displayUrl";

type Case = { input: string; expected: string; reason: string };

function assertTable(scrub: (text: string) => string, cases: readonly Case[]): void {
	for (const { input, expected, reason } of cases) {
		assert.strictEqual(scrub(input), expected, `${reason}: ${JSON.stringify(input)}`);
	}
}

describe("shared/util/displayUrl", () => {
	test("userinfo is cut in every spelling the settings parser lets through and the transport requests", () => {
		// The settings parser only trims a base URL; the WHATWG parser, which the transport also uses, reads each of
		// these as a URL with userinfo, so each is a spelling a request would carry.
		assertTable(displayUrl, [
			{
				input: "http://user:pass@litellm.test:4000/v1",
				expected: "http://litellm.test:4000/v1",
				reason: "user:pass, keeping scheme/host/port/path",
			},
			{ input: "https://user@litellm.test/v1", expected: "https://litellm.test/v1", reason: "a username only" },
			{ input: "http://:secret@litellm.test:4000", expected: "http://litellm.test:4000", reason: "a password only" },
			{
				input: "http://u:p@host.test/path?a=1#frag",
				expected: "http://host.test/path?a=1#frag",
				reason: "query and fragment are kept",
			},
			{ input: "http://u:p@host.test:8001/", expected: "http://host.test:8001/", reason: "a trailing slash is kept" },
			{ input: "http:u:p@host.test:8001", expected: "http://host.test:8001", reason: "no slash after the scheme" },
			{ input: "http:/u:p@host.test", expected: "http://host.test", reason: "one slash" },
			{ input: "http:\\\\u:p@host.test", expected: "http://host.test", reason: "backslashes" },
			{ input: "ht\ttps:u:p@host.test", expected: "https://host.test", reason: "a tab inside the scheme" },
			{
				input: "ht\ttp:/user:pass@host.test",
				expected: "http://host.test",
				reason: "a tab inside the scheme, one slash",
			},
			{ input: "https://u:123 word@host.test", expected: "https://host.test", reason: "a space inside the password" },
			{ input: "https://u word:pw@host.test", expected: "https://host.test", reason: "a space inside the username" },
			{
				input: "https://secret user@host.test",
				expected: "https://host.test",
				reason: "a username only, with a space",
			},
			{
				input: "http://user:pass a b c d e@host.test",
				expected: "http://host.test",
				reason: "a password of six space-separated words",
			},
			{
				input: "https://u:123 https:pw@host.test",
				expected: "https://host.test",
				reason: "a scheme word inside the password: the whole value is one URL to the parser",
			},
			{
				input: "\u0000https://secret user@host.test",
				expected: "\u0000https://host.test",
				reason: "a leading control character, which the parser drops and trim() keeps",
			},
			{
				input: "https://u:p@one.test/a https://x:s@two.test/b",
				expected: "https://one.test/a https://two.test/b",
				reason: "two URLs in one value: the parser reads the second as the first's path",
			},
			{
				input: "https://u:p@one.test/p //v:pw@two.test",
				expected: "https://one.test/p //two.test",
				reason: "a protocol-relative URL after the first",
			},
			{ input: "//u:pw word@host.test", expected: "//host.test", reason: "protocol-relative, read against http" },
			{ input: "https://u:pa'ss@host.test", expected: "https://host.test", reason: "a quote inside the password" },
			{ input: "https://u:'a@host.test", expected: "https://host.test", reason: "a quote opening the password" },
			{
				input: "abc://u:pa\\ss@host.test",
				expected: "abc://host.test",
				reason: "a backslash inside the password of a non-special scheme, where it is no slash",
			},
			{
				input: " https://u:p@host.test\\path@tail",
				expected: " https://host.test\\path@tail",
				reason: "a leading space, which the parser drops, before a special scheme whose backslash opens the path",
			},
			{
				input: "https://user:secret\nextra@host.test",
				expected: "https://host.test",
				reason: "a newline inside the password, which the parser ignores and a line split would not",
			},
		]);
	});

	test("a URL without userinfo passes through byte-identical, unnormalized", () => {
		for (const url of [
			"http://LITELLM.test:4000/v1/",
			"https://litellm.test:443",
			"http://localhost:4000",
			"https://litellm.test?email=owner@contact.test&label=hello world",
		]) {
			assert.strictEqual(displayUrl(url), url);
		}
	});

	test("junk that does not parse as a URL and holds no @ passes through untouched", () => {
		for (const junk of ["", "not a url", "litellm.test:4000"]) {
			assert.strictEqual(displayUrl(junk), junk);
		}
	});

	test("a refused configured value with an @ fails closed: only the text after its last @ shows", () => {
		// The settings parser only trims, so each of these reaches every surface that calls displayUrl; echoing the
		// input would show the password. No scheme anchor, whitespace exclusion, or control-character check narrows
		// the rule: a refused value with an "@" is a credential until the parser says otherwise.
		assertTable(displayUrl, [
			{ input: "http://user:pass@host:bad", expected: "host:bad", reason: "a bad port" },
			{ input: "http://user:pa?ss@host:4000", expected: "host:4000", reason: "a ? inside the password" },
			{ input: "http://user:pa ss@host:bad", expected: "host:bad", reason: "a space inside the password" },
			{
				input: "http://user:pass@host:bad/path with space",
				expected: "host:bad/path with space",
				reason: "a space inside the path",
			},
			{
				input: "http://user:pass@host:bad?query=hello world",
				expected: "host:bad?query=hello world",
				reason: "a space inside the query",
			},
			{
				input: "http://user:pass@host:bad#hello world",
				expected: "host:bad#hello world",
				reason: "a space inside the fragment",
			},
			{
				input: "http://user:pa\u00a0ss@host:bad",
				expected: "host:bad",
				reason: "non-ASCII whitespace in the password",
			},
			{ input: "//user:pass@host:bad", expected: "host:bad", reason: "protocol-relative, read against http" },
			{ input: "//user:pass@", expected: "[unparseable URL]", reason: "protocol-relative, nothing after the @" },
			{ input: "\u0000http://user:pass@host:bad", expected: "host:bad", reason: "a leading control character" },
			{ input: "http://user:pass@", expected: "[unparseable URL]", reason: "nothing after the @" },
			{
				input: "Note: contact admin@example.test",
				expected: "Note: contact admin@example.test",
				reason: "an opaque URL the parser accepts, with no userinfo",
			},
		]);
	});
});
