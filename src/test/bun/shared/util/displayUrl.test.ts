import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { displayUrl, redactUrlCredentials, urlScrubbingReplacer } from "../../../../shared/util/displayUrl";

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

describe("shared/util/redactUrlCredentials", () => {
	test("every URL the parser reads with userinfo loses it; a refused spelling is left to the known values", () => {
		// Each row is a shape a log line, an error message, a stack line, or a configured prose value carries. Prose
		// the parser reads as a URL is cut too: a request would carry it that way.
		assertTable(redactUrlCredentials, [
			{
				input: "Invalid URL: http://user:pass@litellm.test:4000/v1",
				expected: "Invalid URL: http://litellm.test:4000/v1",
				reason: "a URL quoted inside prose",
			},
			{ input: "see http://a@b@host/x", expected: "see http://host/x", reason: "multi-@ userinfo leaves no tail" },
			{ input: "contact admin@example.com", expected: "contact admin@example.com", reason: "a bare email" },
			{
				input: "GET http://litellm.test:4000/v1/models",
				expected: "GET http://litellm.test:4000/v1/models",
				reason: "a credential-free URL",
			},
			{
				input: "Failed at http:user:pass@litellm.test:4000: failed",
				expected: "Failed at http://litellm.test:4000: failed",
				reason: "no slashes after the scheme, and a closing colon that is not part of the URL",
			},
			{
				input: "at http://user:pass a b c d e@litellm.test now",
				expected: "at http://litellm.test now",
				reason: "a password of six words: the span grows to the run holding the @",
			},
			{
				input: "connect http://secret user@litellm.test",
				expected: "connect http://litellm.test",
				reason: "a username only, with a space",
			},
			{
				input: "http://user:pa@ss word@litellm.test:4000",
				expected: "http://litellm.test:4000",
				reason: "an @ inside the password: the longest accepted span wins",
			},
			{
				input: "Failed at https://user:pw first@part tail@litellm.test",
				expected: "Failed at https://litellm.test",
				reason: "two spaces and an @ inside the password",
			},
			{
				input: "First https://u:pw word@one.test/path then https://v:secret@two.test",
				expected: "First https://one.test/path then https://two.test",
				reason: "a second URL inside what the parser read as the first run's path is still reached",
			},
			{
				input: "connect http://user:pa@ss word@[::1]",
				expected: "connect http://[::1]",
				reason: "an IPv6 host",
			},
			{
				input: "Failed at url:http://user:pass@litellm.test:4000",
				expected: "Failed at url:http://litellm.test:4000",
				reason: "an opaque word glued before the URL does not hide it",
			},
			{
				input: "URLs: https://one.test/a,https://u:pw@two.test/b",
				expected: "URLs: https://one.test/a,https://two.test/b",
				reason: "a second URL glued to the first's path by a comma",
			},
			{
				input: "see https://one.test/a //u:pw word@host.test",
				expected: "see https://one.test/a //host.test",
				reason: "a protocol-relative URL with a spaced password after another URL",
			},
			{
				input: "X-Team: https://u:pw@one.test",
				expected: "X-Team: https://one.test",
				reason: "a header-like word and colon before the URL",
			},
			{
				input: '"baseUrl": "https://litellm.test?email=owner@contact.test",',
				expected: '"baseUrl": "https://litellm.test?email=owner@contact.test",',
				reason: "a credential-free URL with an @ in its query keeps its host; quotes bound the run",
			},
			{
				input: "Visit https://example.test and email user@example.test",
				expected: "Visit https://example.test",
				reason: "prose after a URL is a username to the parser, and a request would carry it that way",
			},
			{
				input: "connect https://u:pa'ss@host.test",
				expected: "connect https://host.test",
				reason: "a quote inside a run is a character of the URL, not a string delimiter",
			},
			{
				input: '{"api_base":"http://u:p@h","model":"m"}',
				expected: '{"api_base":"http://h","model":"m"}',
				reason: "compact JSON: the double quote after the colon delimits the value",
			},
			{
				input: "Note: contact admin@example.test",
				expected: "Note: contact admin@example.test",
				reason: "an opaque note: URL has no userinfo",
			},
			{
				input: "Stack trace: Error: connect http://user:pass@host:4000\n    at real (x.ts:1:1)",
				expected: "Stack trace: Error: connect http://host:4000\n    at real (x.ts:1:1)",
				reason: "a stack line: the frame's x.ts:1:1 is an opaque word, not a URL",
			},
			{
				input: "at load (file:///tmp/http:user@fixture.test.js:2:1)",
				expected: "at load (file:///tmp/http:user@fixture.test.js:2:1)",
				reason: "inside a URL's path a scheme-like component is a file name, not a second URL",
			},
			{
				input: '{ "https://host.test": "user@contact.test" }',
				expected: '{ "https://host.test": "user@contact.test" }',
				reason: "a JSON key and its value are two quoted strings, never one URL",
			},
			{
				input: "connect ht\ttp:u:pw@host now",
				expected: "connect http://host now",
				reason: "a tab inside the scheme: the parser drops it, so the run is one URL and the tab goes with the cut",
			},
			{
				input: `GET https://u:pw@host/${"a".repeat(9000)} failed`,
				expected: `GET https://host/${"a".repeat(9000)} failed`,
				reason: "a path past the authority cap: the cap bounds the authority, never the path",
			},
			{
				input: "contact admin@example.test,https://user:secret@host.test",
				expected: "contact admin@example.test,https://host.test",
				reason: "a URL glued to an email by a comma: the email's @ opens nothing, the URL's // does",
			},
			{
				input: "connect https://user:sec\nret@host.test now",
				expected: "connect https://user:sec\nret@host.test now",
				reason: "a line break inside the password: a URL never crosses one, the as-written value is known instead",
			},
			{
				input: "https://u:p@one.test\nhttps://x:s@two.test",
				expected: "https://one.test\nhttps://two.test",
				reason: "two URLs on two lines, each cut alone: to the parser the pair would be one host one.testhttps",
			},
			{
				input: "Invalid URL: http://user:pa?ss@litellm.test:4000",
				expected: "Invalid URL: http://user:pa?ss@litellm.test:4000",
				reason: "a ? inside the password: the parser refuses it, no request carries it, the known values catch it",
			},
		]);
	});
});

describe("shared/util/urlScrubbingReplacer", () => {
	test("a URL field in a serialized tree fails closed when refused; every other string is free text", () => {
		// Agent-tool results serialize configuration values beside prose; a scrubbed copy of the tree would go through
		// Object.fromEntries, which drops toJSON, so a Date would serialize as {}. Under a URL key a refused value with
		// an "@" shows only what follows it; a model id or a prompt keeps the parser-based scrub.
		assert.deepStrictEqual(
			JSON.parse(
				JSON.stringify(
					{
						servers: [
							{
								label: "Prod",
								baseUrl: "http:\\\\user:pass@litellm.test:4000",
								tokenUrl: "https://u:p@idp.test/token",
							},
							{ label: "HTTP:admin@example.test", baseUrl: "https://u:123 word@litellm.test" },
							{ label: "Refused", baseUrl: "http://user:pass@host:bad" },
						],
						prompt: "Use https://user:pass@litellm.test:4000 in the prompt",
						models: ["\\\\models\\\\weights\\\\owner@revision", "gpt-4o", "mailto:admin@example.com", "Note: a@b"],
						at: new Date("2000-01-01T00:00:00.000Z"),
					},
					urlScrubbingReplacer()
				)
			),
			{
				servers: [
					{ label: "Prod", baseUrl: "http://litellm.test:4000", tokenUrl: "https://idp.test/token" },
					{ label: "HTTP://example.test", baseUrl: "https://litellm.test" },
					{ label: "Refused", baseUrl: "host:bad" },
				],
				prompt: "Use https://litellm.test:4000 in the prompt",
				models: ["\\\\models\\\\weights\\\\owner@revision", "gpt-4o", "mailto:admin@example.com", "Note: a@b"],
				at: "2000-01-01T00:00:00.000Z",
			}
		);
	});
});
