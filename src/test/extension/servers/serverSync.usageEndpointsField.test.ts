import * as assert from "node:assert";
import { parseServersSetting, serverSettingReports } from "../../../extension/servers/serverSync/setting";

/**
 * The `usageEndpoints` entry field's acceptance rules. What would drift silently: a malformed member refusing the
 * entry (the paths are not auth - a bad one costs a usage endpoint, never the server), or a malformed member reading as
 * the default without a word (the client would then call a path the user did not name, and every usage surface would
 * describe that wrong path).
 */

function entry(usageEndpoints: unknown): unknown {
	return { label: "Prod", baseUrl: "https://litellm.example.com", usageEndpoints };
}

function parseOne(usageEndpoints: unknown): { usageEndpoints?: unknown; problems: readonly string[] } {
	const { entries, problems } = parseServersSetting([entry(usageEndpoints)]);
	assert.strictEqual(entries.length, 1, "the entry stays usable whatever usageEndpoints says");
	return { usageEndpoints: entries[0]?.usageEndpoints, problems };
}

const NOT_A_PATH =
	'has a usageEndpoints.userInfo that is not a path starting with "/" and free of "?" and "#", ignored';

suite("servers setting: the usageEndpoints entry field", () => {
	test("each member is a root-relative path, trimmed; a member left out stays out", () => {
		assert.deepStrictEqual(parseOne({ userInfo: "  /customer/info ", dailyActivity: "/customer/daily/activity" }), {
			usageEndpoints: { userInfo: "/customer/info", dailyActivity: "/customer/daily/activity" },
			problems: [],
		});
	});

	test("a value that is not an object is reported and ignored", () => {
		for (const raw of ["/customer/info", true, ["/customer/info"], null]) {
			assert.deepStrictEqual(
				parseOne(raw),
				{ usageEndpoints: undefined, problems: ["entry 1 has a usageEndpoints value that is not an object, ignored"] },
				JSON.stringify(raw)
			);
		}
	});

	test("a member that is not a string is reported and ignored; its siblings stand", () => {
		assert.deepStrictEqual(parseOne({ keyInfo: 42, userInfo: "/customer/info" }), {
			usageEndpoints: { userInfo: "/customer/info" },
			problems: ["entry 1 has a usageEndpoints.keyInfo that is not a string, ignored"],
		});
	});

	test("a member without the leading slash, an absolute URL, or one carrying a query or fragment is reported and ignored", () => {
		// The daily-activity call appends its own start_date and end_date query, so a query in the path would produce
		// a URL with two "?"; an absolute URL would be sent to a host the entry's credentials were never paired with.
		for (const path of [
			"customer/info",
			"https://litellm.example.com/customer/info",
			"/customer/info?x=1",
			"/customer/info#top",
			"",
			"   ",
		]) {
			assert.deepStrictEqual(
				parseOne({ userInfo: path }),
				{ usageEndpoints: undefined, problems: [`entry 1 ${NOT_A_PATH}`] },
				JSON.stringify(path)
			);
		}
	});

	test("an unknown member is named, because a typo reading as the default would be invisible", () => {
		assert.deepStrictEqual(parseOne({ keyinfo: "/customer/key/info" }), {
			usageEndpoints: undefined,
			problems: ['entry 1 has an unknown usageEndpoints key "keyinfo", ignored'],
		});
	});

	test("a malformed field never makes the entry misconfigured", () => {
		// The Configuration diagnostics distinguish "reported" from "refused": only the auth shape and the base URL
		// refuse an entry, and the usage paths must not join them.
		const [report] = serverSettingReports([entry({ keyInfo: 42, keyinfo: "/x" })]);
		assert.strictEqual(report?.accepted, true);
		assert.deepStrictEqual([...(report?.problems ?? [])].sort(), [
			"has a usageEndpoints.keyInfo that is not a string, ignored",
			'has an unknown usageEndpoints key "keyinfo", ignored',
		]);
	});
});
