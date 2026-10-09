import * as assert from "node:assert";
import { parseServersSetting, serverSettingReports } from "../../../extension/servers/serverSync/setting";

/**
 * The `mcp` entry field's acceptance rules. The field is opt-in by presence, so the negative space matters most:
 * nothing here may reject an entry outright, because MCP is not auth - a broken opt-in costs tools, never the server.
 */

function entry(mcp: unknown): unknown {
	return { label: "Prod", baseUrl: "http://localhost:4000", ...(mcp !== undefined ? { mcp } : {}) };
}

function parseOne(mcp: unknown): { mcp?: unknown; problems: readonly string[] } {
	const { entries, problems } = parseServersSetting([entry(mcp)]);
	assert.strictEqual(entries.length, 1, "the entry stays usable whatever mcp says");
	return { mcp: entries[0]?.mcp, problems };
}

suite("servers setting: the mcp entry field", () => {
	test("absent means absent: no opt-in, no diagnostic", () => {
		assert.deepStrictEqual(parseOne(undefined), { mcp: undefined, problems: [] });
	});

	test("true is the derived-endpoint opt-in", () => {
		assert.deepStrictEqual(parseOne(true), { mcp: true, problems: [] });
	});

	test("false is an explicit off switch, not a mistake", () => {
		assert.deepStrictEqual(parseOne(false), { mcp: undefined, problems: [] });
	});

	test("the object form opts in and carries a usable url, trimmed", () => {
		assert.deepStrictEqual(parseOne({ url: "  https://gw.example/tools/mcp  " }), {
			mcp: { url: "https://gw.example/tools/mcp" },
			problems: [],
		});
	});

	test("an object without a usable url opts in at the derived endpoint, like true", () => {
		for (const raw of [{}, { url: "" }, { url: "   " }]) {
			assert.deepStrictEqual(parseOne(raw), { mcp: true, problems: [] });
		}
	});

	test("a url of the wrong type is reported and the entry still opts in", () => {
		const { mcp, problems } = parseOne({ url: 42 });
		assert.strictEqual(mcp, true);
		assert.deepStrictEqual(problems, ["entry 1 has an mcp.url that is not a string, ignored"]);
	});

	test("an unknown key is named, because a typo reading as the default would be invisible", () => {
		const { mcp, problems } = parseOne({ endpoint: "https://gw.example/mcp" });
		assert.strictEqual(mcp, true, "the opt-in still stands; only the typo is dropped");
		assert.deepStrictEqual(problems, ['entry 1 has an unknown mcp key "endpoint", ignored']);
	});

	test("a value that is neither a boolean nor an object is reported and ignored", () => {
		for (const raw of ["https://gw.example/mcp", 1, ["https://gw.example/mcp"], null]) {
			const { mcp, problems } = parseOne(raw);
			assert.strictEqual(mcp, undefined, `${JSON.stringify(raw)} is not an opt-in`);
			assert.deepStrictEqual(problems, ["entry 1 has an mcp value that is not true, false, or an object, ignored"]);
		}
	});

	test("a malformed opt-in never makes the entry misconfigured", () => {
		// The Configuration diagnostics distinguish "reported" from "refused": only the auth shape and the base URL
		// refuse an entry, and MCP must not join them.
		const [report] = serverSettingReports([entry({ url: 42, endpoint: "x" })]);
		assert.strictEqual(report?.accepted, true);
		assert.deepStrictEqual([...(report?.problems ?? [])].sort(), [
			"has an mcp.url that is not a string, ignored",
			'has an unknown mcp key "endpoint", ignored',
		]);
	});

	test("the url keeps any scheme with a host in its one spelling; a url with none publishes nothing and is reported", () => {
		// The dashboard's write path, not the setting, insists on http(s). A junk explicit url is not repaired to the
		// derived endpoint: that origin would admit the entry's credentials to a server the user did not name.
		assert.deepStrictEqual(parseOne({ url: "WSS://GW.example/mcp" }), {
			mcp: { url: "wss://gw.example/mcp" },
			problems: [],
		});
		assert.deepStrictEqual(parseOne({ url: "not a url" }), {
			mcp: undefined,
			problems: ["entry 1 has an mcp.url that is not a URL with a host; no MCP server is published for this entry"],
		});
	});
});
