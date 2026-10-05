import { describe, test } from "bun:test";
import * as assert from "node:assert";
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
				title: "the userinfo of every configured URL the parser accepts: as the parser reads it and as written",
				entries: [
					entry({
						urls: [
							"http://user:base-pass@one.test",
							"http://u:flat%20pass@idp.test",
							"http://u:mcp%20pass@one.test/mcp",
						],
					}),
				],
				stored: [],
				expected: [
					"user",
					"base-pass",
					"user:base-pass",
					"u",
					"flat%20pass",
					"u:flat%20pass",
					"mcp%20pass",
					"u:mcp%20pass",
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
				title: "a newline inside a password: the parser drops it, the as-written spelling is a value too",
				entries: [entry({ urls: ["https://u:sec\nret@host.test"] })],
				stored: [],
				expected: ["u", "secret", "u:sec\nret", "sec\nret"],
			},
			{
				title: "an opaque URL has no userinfo to the parser, so the word before its @ is no credential",
				entries: [entry({ urls: ["mailto:admin@example.test"] })],
				stored: [],
				expected: [],
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
				title: "short values are collected like any other; the matchers decide where a floor applies",
				entries: [entry({ urls: ["http://a:bb@localhost:4000"], secrets: ["dev"] })],
				stored: ["x"],
				expected: ["dev", "a", "bb", "a:bb", "x"],
			},
		];
		for (const { title, entries, stored, expected } of cases) {
			assert.deepStrictEqual(collectKnownSecretValues(entries, stored), expected, title);
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

	test("hold accounting: a minted value beside the configured list, per holder, until its last retire", () => {
		// A token the identity provider issued at runtime is in no setting and no blob, so the collector never publishes
		// it, and a settings change rebuilds the configured list, which must leave it in place. The live client and
		// a draft probe's throwaway client receive the same token, so one retire must not strip the other's hold.
		const T = "oauth-access-Q7";
		const cases: readonly {
			title: string;
			arrange: (secrets: KnownSecrets) => void;
			text: string;
			expected: string;
			values: readonly string[];
		}[] = [
			{
				title: "minted beside configured: every spelling of both",
				arrange: (s) => {
					s.set(["configured-Q7"]);
					s.mint(T);
				},
				text: `Authorization: Bearer ${T} for configured-Q7, {"t":"${T}"}`,
				expected: 'Authorization: Bearer [redacted] for [redacted], {"t":"[redacted]"}',
				values: ["configured-Q7", T],
			},
			{
				title: "the configured rebuild replaces its own list and leaves the minted value in place",
				arrange: (s) => {
					s.set(["configured-Q7"]);
					s.mint(T);
					s.set(["configured-Q8"]);
				},
				text: `${T} configured-Q7 configured-Q8`,
				expected: "[redacted] configured-Q7 [redacted]",
				values: ["configured-Q8", T],
			},
			{
				title: "retire ends the minted value; a later mint of another starts it",
				arrange: (s) => {
					s.mint(T);
					s.retire(T);
					s.mint("oauth-access-Q8");
				},
				text: `${T} oauth-access-Q8`,
				expected: `${T} [redacted]`,
				values: ["oauth-access-Q8"],
			},
			{
				title: "two holds survive one retire",
				arrange: (s) => {
					s.mint(T);
					s.mint(T);
					s.retire(T);
				},
				text: T,
				expected: "[redacted]",
				values: [T],
			},
			{
				title: "two holds end at the second retire; a retire of a value never minted changes nothing",
				arrange: (s) => {
					s.mint(T);
					s.mint(T);
					s.retire(T);
					s.retire(T);
					s.retire("never-minted");
				},
				text: T,
				expected: T,
				values: [],
			},
			{
				title: "a value both configured and minted stays known after its minted hold is retired",
				arrange: (s) => {
					s.set([T]);
					s.mint(T);
					s.retire(T);
				},
				text: T,
				expected: "[redacted]",
				values: [T],
			},
			{
				title: "a two-character value is held and kept out of the whole-log pass",
				arrange: (s) => {
					s.mint("ab");
				},
				text: "ab",
				expected: "ab",
				values: ["ab"],
			},
		];
		for (const { title, arrange, text, expected, values } of cases) {
			const secrets = new KnownSecrets();
			arrange(secrets);
			assert.deepStrictEqual(
				{ text: secrets.redact(text), values: secrets.values() },
				{ text: expected, values },
				title
			);
		}
	});

	test("redactShort takes every value: the OAuth detail redacts a two-character client secret", () => {
		// The whole-log pass leaves a short value out before its spellings: "/" is "%2F" percent-encoded, long enough
		// to match, and would blank every encoded slash in a logged URL.
		const secrets = new KnownSecrets();
		secrets.set(["ab", "/"]);
		secrets.mint("x");
		assert.deepStrictEqual(
			{
				whole: secrets.redact("rejected ab x at /models?next=a%2Fb"),
				short: secrets.redactShort("rejected ab x"),
			},
			{ whole: "rejected ab x at /models?next=a%2Fb", short: "rejected [redacted] [redacted]" }
		);
	});

	test("a refused URL of ten thousand @ yields the capped candidates, and set() takes milliseconds", () => {
		// 64 "@" positions: 64 whole candidates, "user", and the 63 tails of one or more "@".
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
				text: "rejected alpha beta",
				values: ["alpha  beta"],
				expected: "rejected [redacted]",
				reason: "an identity provider echoing the client secret with its whitespace collapsed",
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
				text: "valid-key-Q7 and bad\ud800key",
				values: ["valid-key-Q7", "bad\ud800key"],
				expected: "[redacted] and [redacted]",
				reason: "a lone surrogate has no percent form and still redacts raw; the other value is unaffected",
			},
			{ text: "nothing here", values: [], expected: "nothing here", reason: "no values, text untouched" },
		];
		for (const { text, values, keep: markers, expected, reason } of cases) {
			const secrets = new KnownSecrets();
			secrets.set(values);
			assert.strictEqual(secrets.redact(text, markers), expected, reason);
		}
	});
});
