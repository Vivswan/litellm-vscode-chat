/**
 * ModelsSection rendering: formatter behavior (tokens, pricing, capabilities,
 * the pricing tooltip) and the filter/server-column rules.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ModelsSection } from "../../../webview/dashboard/models";
import { makeModel } from "../fixtures";
import { cleanup, fireInput, mount, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

test("renders one row per model with formatted tokens, pricing, capabilities, and the full pricing tooltip", () => {
	const priced = makeModel({
		id: "gpt-priced",
		name: "GPT Priced",
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		inputCost: 2.5,
		outputCost: 10.1234,
		cacheReadCost: 0.256789,
		cacheWriteCost: 3.125,
		longContextInputCost: 5,
		longContextOutputCost: 20,
		longContextCacheReadCost: 0.5,
		longContextCacheWriteCost: 6.25,
		toolCalling: true,
		imageInput: true,
		promptCaching: true,
		reasoning: true,
	});
	const bare = makeModel({ id: "bare", name: "Bare", toolCalling: false, imageInput: false });
	const root = mount(<ModelsSection models={[priced, bare]} serverCount={1} />);

	const rows = Array.from(root.querySelectorAll("tbody tr"));
	expect(rows.length).toBe(2);

	const cells = Array.from(rows[0]?.querySelectorAll("td") ?? []).map((cell) => (cell.textContent ?? "").trim());
	// toLocaleString is the formatter under test; compute the expectation the same way.
	expect(cells).toContain((128000).toLocaleString());
	expect(cells).toContain((16384).toLocaleString());
	// Three significant digits, no binary-fraction noise.
	expect(cells).toContain("$2.5 in / $10.1 out");
	expect(cells).toContain("tools, vision, caching, reasoning");

	const pricingCell = rows[0]?.querySelector("td[title]");
	expect(pricingCell?.getAttribute("title")).toBe(
		"USD per million tokens, cache read $0.257, cache write $3.13, long-context tier: $5 in, $20 out, cache read $0.5, cache write $6.25"
	);

	const bareCells = Array.from(rows[1]?.querySelectorAll("td") ?? []).map((cell) => (cell.textContent ?? "").trim());
	expect(bareCells).toContain("-");
	expect(bareCells).toContain("");
});

test("filter narrows rows by name, id, family, and server label and updates 'showing N of M'", () => {
	const models = [
		makeModel({ id: "gpt-4o", name: "Omni", family: "gpt", serverLabel: "Prod" }),
		makeModel({ id: "claude-sonnet", name: "Sonnet", family: "claude", serverLabel: "Staging" }),
	];
	const root = mount(<ModelsSection models={models} serverCount={2} />);
	const filter = root.querySelector("input[aria-label='Filter models']") as HTMLInputElement;
	const visibleNames = () =>
		Array.from(root.querySelectorAll("tbody tr")).map((row) => (row.querySelector("td")?.textContent ?? "").trim());

	expect(visibleNames()).toEqual(["Omni", "Sonnet"]);

	fireInput(filter, "omni"); // name
	expect(visibleNames()).toEqual(["Omni"]);
	fireInput(filter, "claude-son"); // id
	expect(visibleNames()).toEqual(["Sonnet"]);
	fireInput(filter, "GPT"); // family, case-insensitive
	expect(visibleNames()).toEqual(["Omni"]);
	fireInput(filter, "staging"); // server label
	expect(visibleNames()).toEqual(["Sonnet"]);
	expect(root.textContent).toContain("showing 1 of 2");

	fireInput(filter, "no-such-model");
	expect(visibleNames()).toEqual([]);
	expect(root.textContent).toContain("No models match the filter.");
});

test("the server column appears only when serverCount > 1, keyed to the count rather than distinct labels", () => {
	const models = [makeModel({ serverLabel: "Shared" }), makeModel({ id: "b", serverLabel: "Shared" })];
	const single = mount(<ModelsSection models={models} serverCount={1} />);
	const singleHeaders = Array.from(single.querySelectorAll("th")).map((th) => (th.textContent ?? "").trim());
	expect(singleHeaders).not.toContain("Server");

	// Two groups can share one label; their models must stay attributable.
	const dual = mount(<ModelsSection models={models} serverCount={2} />);
	const dualHeaders = Array.from(dual.querySelectorAll("th")).map((th) => (th.textContent ?? "").trim());
	expect(dualHeaders).toContain("Server");
});
