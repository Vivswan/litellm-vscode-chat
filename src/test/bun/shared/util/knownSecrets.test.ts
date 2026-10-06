import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { Logger } from "../../../../shared/logger";
import { type CollectableEntry, collectKnownSecretValues } from "../../../../shared/util/knownSecrets";

/** A parsed entry as the collector sees it, with the fields a row leaves out empty. */
function entry(fields: Partial<CollectableEntry>): CollectableEntry {
	return { secrets: [], headers: {}, carriers: [], ...fields };
}

describe("shared/util/knownSecrets", () => {
	test("collectKnownSecretValues reads every value of the parsed entries plus the stored values", () => {
		// Drifts silently: a value missing from this list reaches the output channel and the issue report unmasked the
		// next time a line quotes it, and only the reader of that line would notice.
		const cases: readonly {
			title: string;
			entries: readonly CollectableEntry[];
			stored: readonly (string | undefined)[];
			expected: readonly string[];
		}[] = [
			{
				title: "the parsed secret fields and the stored values; an absent or empty stored value is no value",
				entries: [entry({ secrets: ["inline-test-Q7", "cs-Q7"] })],
				stored: ["stored-test-Q7", undefined, ""],
				expected: ["inline-test-Q7", "cs-Q7", "stored-test-Q7"],
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
				title: "the floor shared with the masker: a three-letter key is out, a four-character one is in",
				entries: [entry({ secrets: ["dev", "abcd"] })],
				stored: ["x"],
				expected: ["abcd"],
			},
		];
		for (const { title, entries, stored, expected } of cases) {
			assert.deepStrictEqual(collectKnownSecretValues(entries, stored), expected, title);
		}
	});

	test("a URL's userinfo is the door's shape rule, never a registered value: a user name stays a word elsewhere", () => {
		// The collector sees the secret positions of a record, and a URL is none of them. Were "alice" or "alice:pw"
		// registered from a configured http://alice:pw@host, every "/Users/alice/x" on every line would blank.
		Logger.registerSecrets(collectKnownSecretValues([entry({ secrets: ["cfg-alice-key-Q7"] })], []));
		assert.strictEqual(
			Logger.redact("open /Users/alice/x for http://alice:pw@hub.test/v1 with cfg-alice-key-Q7"),
			"open /Users/alice/x for http://[redacted]@hub.test/v1 with [redacted]"
		);
	});
});
