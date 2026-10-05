import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { configuredUserinfo, displayUrl } from "../../../../shared/util/displayUrl";
import { type CollectableEntry, collectKnownSecretValues, KnownSecrets } from "../../../../shared/util/knownSecrets";

/** A parsed entry as the collector sees it, with the fields a row leaves out empty. */
function entry(fields: Partial<CollectableEntry>): CollectableEntry {
	return { urls: [], secrets: [], headers: {}, carriers: [], ...fields };
}

describe("shared/util/knownSecrets", () => {
	test("collectKnownSecretValues reads every value of the parsed entries plus the stored values", () => {
		// Drifts silently: a value missing from this list reaches the output channel and the issue report the next time
		// a line quotes it, and only the reader of that line would notice.
		const cases: readonly {
			title: string;
			entries: readonly CollectableEntry[];
			stored: readonly (string | undefined)[];
			expected: readonly string[];
		}[] = [
			{
				title: "the parsed secret fields and the stored values; an absent or empty stored value is no value",
				entries: [entry({ urls: ["http://one.test"], secrets: ["inline-test-Q7", "cs-Q7"] })],
				stored: ["stored-test-Q7", undefined, ""],
				expected: ["inline-test-Q7", "cs-Q7", "stored-test-Q7"],
			},
			{
				title:
					"the userinfo of every configured URL the parser accepts, edge whitespace aside: as written, whole and split at the first colon",
				entries: [
					entry({
						urls: [
							"http://user:base-pass@one.test",
							"http://u:flat%20pass@idp.test",
							"http://u:mcp%20pass@one.test/mcp",
							" //user:p a$Q7@host.test ",
						],
					}),
				],
				stored: [],
				expected: [
					"user:base-pass",
					"user",
					"base-pass",
					"u:flat%20pass",
					"flat%20pass",
					"u:mcp%20pass",
					"mcp%20pass",
					"user:p a$Q7",
					"p a$Q7",
				],
			},
			{
				title:
					"a URL the parser refuses yields the text up to every @ before its end: whole and split at the first colon",
				entries: [
					entry({
						urls: [
							"http://user:pa?ss/extra@x@host:4000 note",
							"http://user:p w@host:bad",
							'http://user:pa"ss@host:bad',
							`http://user:${"p".repeat(8200)}@host:bad`,
						],
					}),
				],
				stored: [],
				expected: [
					"user:pa?ss/extra",
					"user",
					"pa?ss/extra",
					"user:pa?ss/extra@x",
					"pa?ss/extra@x",
					"user:p w",
					"p w",
					'user:pa"ss',
					'pa"ss',
					`user:${"p".repeat(8200)}`,
					"p".repeat(8200),
				],
			},
			{
				title: "a newline inside a password rides as written; the matcher spells the parser's form",
				entries: [entry({ urls: ["https://u:sec\nret@host.test", "\t//sk-cred\nential-Q7:pw@host.test"] })],
				stored: [],
				expected: ["u:sec\nret", "sec\nret", "sk-cred\nential-Q7:pw", "sk-cred\nential-Q7"],
			},
			{
				title: "an opaque URL has no userinfo to the parser, so the word before its @ is no credential",
				entries: [entry({ urls: ["mailto:admin@example.test"] })],
				stored: [],
				expected: [],
			},
			{
				title:
					"what displayUrl hides is a value: a URL embedded in a query parameter, a scheme-less value@host spelling, and a protocol-relative URL behind whitespace the parser keeps",
				entries: [
					entry({
						urls: [
							"https://a.test/?next=https://u:query-pw@b.test",
							"sk-credential-Q7@a.test:443",
							"\u00a0//sk-credential-Q7:@a.test",
						],
					}),
				],
				stored: [],
				expected: ["u:query-pw", "query-pw", "sk-credential-Q7", "sk-credential-Q7:"],
			},
			{
				title: "credential headers by the one predicate (whole words, trimmed) and the entry's carrier",
				entries: [
					entry({
						carriers: ["X-Tenant"],
						headers: {
							"X-Gateway-Token": "gateway-Q7",
							Authorization: "Bearer bearer-Q7",
							Authentication: "authn-Q7",
							"X-Tenant": "tenant-Q7",
							" Cookie ": "cookie-Q7",
							"X-Numeric-Key": "12345678",
							"Content-Type": "application/json",
							"X-Monkey": "platform-Q7",
						},
					}),
				],
				stored: [],
				expected: ["gateway-Q7", "Bearer bearer-Q7", "authn-Q7", "tenant-Q7", "cookie-Q7", "12345678"],
			},
			{
				title:
					"a three-letter value is a credential; a one-letter user or a two-letter password would blank every line",
				entries: [entry({ urls: ["http://a:bb@localhost:4000"], secrets: ["dev"] })],
				stored: ["x"],
				expected: ["dev", "a:bb"],
			},
			{
				title:
					"a refused URL keeps its scheme word under edge whitespace or a space before the colon, so the candidates start after it",
				entries: [entry({ urls: [" http://user:secret-Q7@host:bad ", "http ://user:secret-Q7@host"] })],
				stored: [],
				expected: ["user:secret-Q7", "user", "secret-Q7"],
			},
			{
				title: "empty userinfo after a separator is no value, whatever the word before the separator spells",
				entries: [entry({ urls: ["@a.test", "http://@host:bad", "sk-credential-Q7 :@a.test:443"] })],
				stored: [],
				expected: [],
			},
			{
				title: "a one-character password counts through its percent form, which clears the floor",
				entries: [entry({ urls: ["http://u:\u00e9@a.test"] })],
				stored: [],
				expected: ["u:\u00e9", "\u00e9"],
			},
		];
		for (const { title, entries, stored, expected } of cases) {
			assert.deepStrictEqual(collectKnownSecretValues(entries, stored), expected, title);
		}
		const known = new KnownSecrets();
		known.set(
			collectKnownSecretValues(
				[
					entry({
						urls: [
							"https://a.test/?next=https://u:query-pw@b.test",
							"sk-credential-Q7@a.test:443",
							"https://c.test/?next=https://u:split\n-pw@d.test",
						],
					}),
				],
				[]
			)
		);
		assert.strictEqual(
			known.redact("Denied query-pw for sk-credential-Q7 at a.test:443; split\n-pw and split-pw too"),
			"Denied [redacted] for [redacted] at a.test:443; [redacted] and [redacted] too"
		);
	});

	// Drifts silently: the finder feeds the known-value collector and the export's secret count, displayUrl the shown
	// text, and nothing but this table holds the two to one answer per spelling. A tab or newline alone, and empty
	// userinfo, are the spellings displayUrl rewrites with no span to yield.
	test("configuredUserinfo yields exactly the as-written text displayUrl hides", () => {
		const cases: readonly [string, readonly string[], string][] = [
			["http://user:pass@host", ["user:pass"], "http://host"],
			["http://a.test\t/v1", [], "http://a.test/v1"],
			["https://u:sec\nret@host.test", ["u:sec\nret"], "https://host.test"],
			["\t//sk-cred\nential-Q7:pw@host.test", ["sk-cred\nential-Q7:pw"], "//host.test"],
			["https://a.test/?next=https://u:query-pw@b.test", ["u:query-pw"], "https://a.test/?next=https://b.test"],
			["https://a.test/?next=https://u:query\n-pw@b.test", ["u:query\n-pw"], "https://a.test/?next=https://b.test"],
			["http://user:pa?ss/extra@x@host:4000 note", ["user:pa?ss/extra", "user:pa?ss/extra@x"], "host:4000 note"],
			["//user:pass@", ["user:pass"], "[unparseable URL]"],
			["sk-credential-Q7@a.test:443", ["sk-credential-Q7"], "a.test:443"],
			["admin@example.test", ["admin"], "example.test"],
			["mailto:admin@example.test", [], "mailto:admin@example.test"],
			["u:p@host", [], "u:p@host"],
			["\u00a0mailto:admin@example.test", ["admin"], "example.test"],
			["mailto:https://u:secret-Q7@b.test\u00a0", [], "mailto:https://u:secret-Q7@b.test\u00a0"],
			[" http://u:pw@host ", ["u:pw"], " http://host "],
			[" http://user:secret-Q7@host:bad ", ["user:secret-Q7"], "host:bad "],
			["http ://user:secret-Q7@host", ["user:secret-Q7"], "host"],
			["\u0001http://user:secret-Q7@host:bad", ["user:secret-Q7"], "host:bad"],
			["\u0001//a.test/path:secret-Q7@b.test", [], "\u0001//a.test/path:secret-Q7@b.test"],
			["\u0001//user:pass@host", ["user:pass"], "\u0001//host"],
			["\u00a0//sk-credential-Q7:@a.test", ["sk-credential-Q7:"], "a.test"],
			["\ufeff//sk-credential-Q7:@a.test", ["sk-credential-Q7:"], "a.test"],
			["@a.test", [], "a.test"],
			["http://@host:bad", [], "host:bad"],
		];
		for (const [value, hidden, shown] of cases) {
			assert.deepStrictEqual(configuredUserinfo(value), hidden, JSON.stringify(value));
			assert.strictEqual(displayUrl(value), shown, JSON.stringify(value));
		}
	});

	test("a budget cuts the text before the pass; a value or a URL astride the cut is redacted whole", () => {
		// Drifts silently: a stack cut at the budget would show the head of the value or the password it split.
		const secrets = new KnownSecrets();
		secrets.set(["secret-value-Q7"]);
		const url = `${"x".repeat(65500)}https://u:${"p".repeat(2000)}@host.test tail`;
		const value = `${"y".repeat(65530)}secret-value-Q7 tail`;
		assert.deepStrictEqual(
			{
				url: secrets.redact(url, [], 65536),
				value: secrets.redact(value, [], 65536),
				short: secrets.redact("short", [], 65536),
			},
			{
				url: `${"x".repeat(65500)}https://host.test [5 more characters cut]`,
				value: `${"y".repeat(65530)}[redacted] [5 more characters cut]`,
				short: "short",
			}
		);
	});

	test("a site that knows its one value sets the floor: the OAuth detail redacts a two-character client secret", () => {
		const secrets = new KnownSecrets();
		secrets.set(["ab", " x \t "], { minLength: 1 });
		// The padded value's trimmed spelling is a value too, as the transport would send it.
		assert.strictEqual(
			secrets.redact("the secret ab does not match x"),
			"the secret [redacted] does not match [redacted]"
		);
	});

	test("a refused URL of ten thousand @ yields the capped candidates, and set() takes milliseconds", () => {
		// 64 "@" positions: 64 whole candidates, "user", and the 63 tails ("@" and "@@" count through "%40" and "%40%40",
		// what the parser would send for them).
		const urls = [`http://user:${"@".repeat(10000)}host:bad`];
		const started = performance.now();
		const values = collectKnownSecretValues([entry({ urls })], []);
		const secrets = new KnownSecrets();
		secrets.set(values);
		const elapsed = performance.now() - started;
		assert.deepStrictEqual(
			{ count: values.length, first: values[0], redacted: secrets.redact("rejected user: again") },
			{ count: 128, first: "user:", redacted: "rejected [redacted] again" }
		);
		assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
	});

	test("KnownSecrets.redact replaces every value spelling and every URL userinfo once, over the original text", () => {
		// Drifts silently: a sequential replace leaves the tail of whichever overlapping value went second, a value
		// split across a JSON escape or a percent-encoding survives untouched, and a pass that runs after the URL cut
		// never sees a password the cut split.
		const keep = "[credential header: value kept in settings, not shown]";
		const cases: readonly {
			text: string;
			values: readonly string[];
			keep?: readonly string[];
			expected: string;
			reason: string;
		}[] = [
			{
				text: "403: key sk-live-Q7 rejected",
				values: ["sk-live-Q7"],
				expected: "403: key [redacted] rejected",
				reason: "a body quoting the key",
			},
			{
				text: "abc123xyz",
				values: ["abc123", "123xyz"],
				expected: "[redacted]",
				reason: "overlapping values merge into one span",
			},
			{
				text: "abcdefghi",
				values: ["abc", "def", "bcdefghi"],
				expected: "[redacted]",
				reason: "a value starting inside the first match and reaching past the adjacent one",
			},
			{
				text: "pre<P>postxyz and <P> alone",
				values: ["pre<P>post", "postxyz"],
				expected: "[redacted] and <P> alone",
				reason: "a prefix pair merges; the bare inner part elsewhere stays",
			},
			{
				text: 'card: {"note":"a \\"quoted\\" key"}',
				values: ['a "quoted" key'],
				expected: 'card: {"note":"[redacted]"}',
				reason: "the JSON-escaped form inside a serialized card",
			},
			{
				text: "rejected key pa%20ss, then a%3ab, then %3a%2F%3f",
				values: ["pa ss", "a:b", ":/?"],
				expected: "rejected key [redacted], then [redacted], then [redacted]",
				reason: "the percent-encoded forms, each escape in either hex case",
			},
			{
				text: "rejected user pa?ss and token-Q7, echoed pa%3fss",
				values: ["us%65r", "pa%3Fss", " Bearer token-Q7 "],
				expected: "rejected [redacted] [redacted] and [redacted], echoed [redacted]",
				reason: "a pre-encoded value decoded, its escapes in either case, and a padded scheme-prefixed value's token",
			},
			{
				text: "https://tok-1234-tail.test rejected",
				values: ["tok-\t1234-tail"],
				expected: "https://[redacted].test rejected",
				reason: "a stored value holding a tab reaches a rendered URL without it, as the URL parser drops it",
			},
			{
				text: "https://alice:pw-Q7@host.test",
				values: ["@host.test"],
				expected: "https://host.test",
				reason: "a value holding the URL's @: the cut is judged on the original text, which the value cannot eat",
			},
			{
				text: "https://u:pw@proxy.dev",
				values: ["dev"],
				expected: "https://proxy.[redacted]",
				reason: "a value inside the host: the cut first, then the host it kept",
			},
			{
				text: "connect https://u:part@host.test 'tail@host.test now",
				values: ["part@host.test 'tail"],
				expected: "connect https://host.test now",
				reason: "the cut takes the password's head, the value's tail goes by span, and the next pass cuts the rest",
			},
			{
				text: `x${"ab".repeat(4000)}ay`,
				values: [`${"ab".repeat(4000)}a`],
				expected: "x[redacted]y",
				reason: "a long value is one alternative, never split",
			},
			{
				text: `${keep} for settings`,
				values: ["settings"],
				keep: [keep],
				expected: `${keep} for [redacted]`,
				reason: "an occurrence inside a keep marker stays, the one outside goes",
			},
			{
				text: keep,
				values: [keep],
				keep: [keep],
				expected: keep,
				reason: "a value equal to the keep marker is no form",
			},
			{
				text: "abcdefghi",
				values: ["defghi"],
				keep: ["abcdefghi", "def"],
				expected: "abcdefghi",
				reason: "inside the longer of two nested markers, whichever starts nearer",
			},
			{
				text: "xKEEP and KEEP",
				values: ["xKEEP"],
				keep: ["KEEP"],
				expected: "[redacted] and KEEP",
				reason: "a value containing the marker is replaced with it; the bare marker elsewhere stays",
			},
			{
				text: "hello secret",
				values: ["secret"],
				keep: [""],
				expected: "hello [redacted]",
				reason: "an empty marker is no marker",
			},
			{
				text: '{"count": 12345678}',
				values: ["12345678"],
				expected: '{"count": [redacted]}',
				reason: "a numeric value is still a value",
			},
			{
				text: "aaabbbccc",
				values: ["aaa", "[redacted]bbb", "[redacted]ccc"],
				expected: "[redacted]",
				reason: "a chain of values each visible only after the last replacement, within the three passes",
			},
			{
				text: "User red rejected, [redacted] kept",
				values: ["red"],
				expected: "User [redacted] rejected, [redacted] kept",
				reason: "a value inside the marker itself never nests another: the pass is a fixed point",
			},
			{
				text: "https://u:pw@h//x:pw@two.test",
				values: ["h//x"],
				expected: "https://h//two.test",
				reason: "a value the cuts consumed entirely leaves no marker between them",
			},
			{
				text: "a".repeat(64),
				values: [`${"a".repeat(31)}b`],
				expected: "a".repeat(64),
				reason: "a long near-match stays whole",
			},
			{
				text: "Denied access to chat",
				values: ["a"],
				expected: "Denied access to chat",
				reason: "a one-letter value is ignored, or every letter would go",
			},
			{
				text: "valid-key-Q7 and bad\ud800key, sent as bad%EF%BF%BDkey, read back as bad\ufffdkey",
				values: ["valid-key-Q7", "bad\ud800key"],
				expected: "[redacted] and [redacted], sent as [redacted], read back as [redacted]",
				reason:
					"encodeURIComponent refuses a lone surrogate; the parser's form and its decoding are spellings, the raw value too",
			},
			{ text: "nothing here", values: [], expected: "nothing here", reason: "no values, text untouched" },
			{
				text: "Denied p%20a$Q7 and p%20a%24Q7 and p%2520a%24Q7",
				values: ["p a$Q7"],
				expected: "Denied [redacted] and [redacted] and [redacted]",
				reason: "the parser's userinfo encoding of a password, which keeps the $, with its own spellings",
			},
			{
				text: "Denied p%20a%5C$Q7 and %5C",
				values: ["p a\\$Q7", "\\"],
				expected: "Denied [redacted] and [redacted]",
				reason:
					"under a non-special scheme a backslash is sent percent-encoded; a one-character one clears the floor so",
			},
			{
				text: "Denied p%20a%24Q7 and %C3%A9, not \u00e9",
				values: ["p a%24Q7", "\u00e9"],
				expected: "Denied [redacted] and [redacted], not \u00e9",
				reason:
					"a written escape rides as the parser sends it; a one-character password matches only as its percent form",
			},
		];
		for (const { text, values, keep: markers, expected, reason } of cases) {
			const secrets = new KnownSecrets();
			secrets.set(values);
			assert.strictEqual(secrets.redact(text, markers), expected, reason);
		}
	});
});
