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
				expected: ["user", "base-pass", "user:base-pass", "flat%20pass", "u:flat%20pass", "mcp%20pass", "u:mcp%20pass"],
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
				expected: ["secret", "u:sec\nret", "sec\nret"],
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
				title:
					"a three-letter value is a credential; a one-letter user or a two-letter password would blank every line",
				entries: [entry({ urls: ["http://a:bb@localhost:4000"], secrets: ["dev"] })],
				stored: ["x"],
				expected: ["dev", "a:bb"],
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

	test("a minted value redacts like a configured one until retired; the configured rebuild leaves it in place", () => {
		// A token the identity provider issued at runtime is in no setting and no blob, so the collector never publishes
		// it; a settings change rebuilt the whole set and would have dropped it had the two shared one list.
		const secrets = new KnownSecrets();
		secrets.set(["configured-Q7"]);
		secrets.mint("oauth-access-Q7");
		const probe = 'Authorization: Bearer oauth-access-Q7 for configured-Q7, {"t":"oauth-access-Q7"}';
		assert.strictEqual(secrets.redact(probe), 'Authorization: Bearer [redacted] for [redacted], {"t":"[redacted]"}');
		assert.deepStrictEqual(secrets.values(), ["configured-Q7", "oauth-access-Q7"]);

		secrets.set(["configured-Q8"]);
		assert.strictEqual(secrets.redact(probe), 'Authorization: Bearer [redacted] for configured-Q7, {"t":"[redacted]"}');

		secrets.retire("oauth-access-Q7");
		secrets.mint("oauth-access-Q8");
		assert.strictEqual(
			secrets.redact("old oauth-access-Q7, new oauth-access-Q8, set configured-Q8"),
			"old oauth-access-Q7, new [redacted], set [redacted]"
		);
	});

	test("a minted value is counted per holder: two mints need two retires, and a short one is never minted", () => {
		// The live client and a draft probe's throwaway client receive the same token from the identity provider; the
		// probe's retire must not strip the live client's hold.
		const secrets = new KnownSecrets();
		secrets.mint("shared-tok-Q7");
		secrets.mint("shared-tok-Q7");
		secrets.mint("ab");
		secrets.retire("shared-tok-Q7");
		assert.strictEqual(secrets.redact("shared-tok-Q7 ab"), "[redacted] ab");
		secrets.retire("shared-tok-Q7");
		secrets.retire("never-minted");
		assert.deepStrictEqual(
			{ text: secrets.redact("shared-tok-Q7"), values: secrets.values() },
			{
				text: "shared-tok-Q7",
				values: [],
			}
		);
	});

	test("a refused URL of ten thousand @ yields the capped candidates, and set() takes milliseconds", () => {
		// 64 "@" positions: 64 whole candidates, "user", and the 61 tails of three or more "@".
		const urls = [`http://user:${"@".repeat(10000)}host:bad`];
		const started = performance.now();
		const values = collectKnownSecretValues([entry({ urls })], []);
		const secrets = new KnownSecrets();
		secrets.set(values);
		const elapsed = performance.now() - started;
		assert.deepStrictEqual(
			{ count: values.length, first: values[0], redacted: secrets.redact("rejected user: again") },
			{ count: 126, first: "user:", redacted: "rejected [redacted] again" }
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
