import * as assert from "node:assert";
import { parseServersSetting, serverSettingReports } from "../../../extension/servers/serverSync";

/**
 * The `mcp` entry field's acceptance rules. The field is opt-in by presence,
 * so the negative space matters most: nothing here may reject an entry
 * outright, because MCP is not auth - a broken opt-in costs tools, never the
 * server.
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
		// The Configuration diagnostics distinguish "reported" from "refused":
		// only auth shape refuses an entry, and MCP must not join it.
		const [report] = serverSettingReports([entry({ url: 42, endpoint: "x" })]);
		assert.strictEqual(report?.accepted, true);
		assert.deepStrictEqual([...(report?.problems ?? [])].sort(), [
			"has an mcp.url that is not a string, ignored",
			'has an unknown mcp key "endpoint", ignored',
		]);
	});

	test("the url is taken as written: the parser does not second-guess its shape", () => {
		// The dashboard's write path enforces http(s); the setting stays as
		// lenient here as it is for baseUrl, so a scheme we did not anticipate
		// is the user's business.
		assert.deepStrictEqual(parseOne({ url: "not a url" }), { mcp: { url: "not a url" }, problems: [] });
	});
});
