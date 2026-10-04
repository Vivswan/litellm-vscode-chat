import { describe, test } from "bun:test";
import * as assert from "node:assert";
import {
	EXPECTED_FAILURE_CATEGORIES,
	entryUsesSecretField,
	isExpectedFailureCategory,
} from "../../../shared/serverEntry";

describe("shared/serverEntry: expected failure categories", () => {
	test("isExpectedFailureCategory accepts exactly the declared tokens", () => {
		for (const category of EXPECTED_FAILURE_CATEGORIES) {
			assert.ok(isExpectedFailureCategory(category));
		}
		assert.strictEqual(isExpectedFailureCategory("models"), false);
		assert.strictEqual(isExpectedFailureCategory("MODELLISTING"), false);
		assert.strictEqual(isExpectedFailureCategory(1), false);
		assert.strictEqual(isExpectedFailureCategory(undefined), false);
	});
});

describe("shared/serverEntry: entryUsesSecretField", () => {
	const base = { baseUrl: "http://x.test" };

	test("a resolved apiKey is sent on every servable entry shape", () => {
		// parseGroupConfiguration reads any string apiKey and the transport
		// carries it on each request regardless of the other auth fields; a
		// missing one merely means a keyless server.
		assert.strictEqual(entryUsesSecretField(base, "apiKey"), true);
		assert.strictEqual(entryUsesSecretField({ ...base, virtualKeyHeader: "x-key" }, "apiKey"), true);
		assert.strictEqual(
			entryUsesSecretField({ ...base, oauthTokenUrl: "https://idp.test/token", oauthClientId: "cid" }, "apiKey"),
			true
		);
	});

	test("the client secret is used only through an active oauth unit: BOTH tokenUrl and clientId", () => {
		// narrowOAuth's unit rule; the settings parser rejects one half without
		// the other, so on parsed entries the halves never split.
		assert.strictEqual(entryUsesSecretField(base, "oauthClientSecret"), false);
		assert.strictEqual(
			entryUsesSecretField({ ...base, oauthTokenUrl: "https://idp.test/token" }, "oauthClientSecret"),
			false
		);
		assert.strictEqual(entryUsesSecretField({ ...base, oauthClientId: "cid" }, "oauthClientSecret"), false);
		assert.strictEqual(
			entryUsesSecretField(
				{ ...base, oauthTokenUrl: "https://idp.test/token", oauthClientId: "cid" },
				"oauthClientSecret"
			),
			true
		);
	});

	test("a virtual key value is used only through a declared header", () => {
		// narrowVirtualKey sends only with both halves; the header's presence is
		// the entry-side half (the parser already enforced its name validity).
		assert.strictEqual(entryUsesSecretField(base, "virtualKeyValue"), false);
		assert.strictEqual(entryUsesSecretField({ ...base, virtualKeyHeader: "x-litellm-key" }, "virtualKeyValue"), true);
		assert.strictEqual(
			entryUsesSecretField(
				{ ...base, oauthTokenUrl: "https://idp.test/token", oauthClientId: "cid" },
				"virtualKeyValue"
			),
			false
		);
	});

	test("a base URL that normalizes to nothing forms no server, so no field is used", () => {
		// parseGroupConfiguration refuses a normalized-empty base URL outright:
		// nothing of such an entry ever reaches the wire.
		for (const baseUrl of ["/", "///"]) {
			assert.strictEqual(entryUsesSecretField({ baseUrl }, "apiKey"), false);
			assert.strictEqual(
				entryUsesSecretField(
					{ baseUrl, oauthTokenUrl: "https://idp.test/token", oauthClientId: "cid" },
					"oauthClientSecret"
				),
				false
			);
			assert.strictEqual(entryUsesSecretField({ baseUrl, virtualKeyHeader: "x-key" }, "virtualKeyValue"), false);
		}
	});
});
