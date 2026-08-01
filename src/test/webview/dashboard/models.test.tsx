/**
 * ModelsSection rendering: formatter behavior (tokens, pricing, capabilities,
 * the pricing tooltip) and the filter, server-scope, and server-column rules.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ModelsSection } from "../../../webview/dashboard/models";
import { makeModel } from "../fixtures";
import { cleanup, fireClick, fireInput, mount, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

test("renders one row per model with formatted tokens, pricing, capabilities, and the full pricing detail tip", () => {
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
	const root = mount(<ModelsSection models={[priced, bare]} serverCount={1} requestScopes={{}} modelParameters={{}} />);

	const rows = Array.from(root.querySelectorAll("tbody tr"));
	expect(rows.length).toBe(2);

	// The pricing cell's tip text lives inside the cell, so read cell text
	// from the cells' first text nodes and the pricing from its own span.
	const cells = Array.from(rows[0]?.querySelectorAll("td") ?? []).map((cell) =>
		(cell.querySelector(".tip-wrap > span")?.textContent ?? cell.textContent ?? "").trim()
	);
	// toLocaleString is the formatter under test; compute the expectation the same way.
	expect(cells).toContain((128000).toLocaleString());
	expect(cells).toContain((16384).toLocaleString());
	// Three significant digits, no binary-fraction noise.
	expect(cells).toContain("$2.5 in / $10.1 out");
	expect(cells).toContain("tools, vision, caching, reasoning");

	// The cache and long-context tiers render in a hover tip element (native
	// title attributes do not show inside the webview host).
	const pricingTip = rows[0]?.querySelector("td .tip-wrap .help-tip");
	expect(pricingTip?.textContent).toBe(
		"USD per million tokens, cache read $0.257, cache write $3.13, long-context tier: $5 in, $20 out, cache read $0.5, cache write $6.25"
	);

	// The capabilities cell truncates with a CSS ellipsis, so its tip must
	// carry the full list, focus-reachable (the trimmed tail is invisible
	// without a pointer): the wrapper joins the Tab order and names the tip
	// as its description. A model with no capabilities renders no tip shell.
	const capsWrap = rows[0]?.querySelector("td.caps .tip-wrap") as HTMLElement;
	const capsTip = capsWrap.querySelector(".help-tip") as HTMLElement;
	expect(capsTip.textContent).toBe("tools, vision, caching, reasoning");
	expect(capsWrap.getAttribute("tabindex")).toBe("0");
	expect(capsWrap.getAttribute("aria-describedby")).toBe(capsTip.id);
	expect(rows[1]?.querySelector("td.caps .tip-wrap")).toBeNull();

	const bareCells = Array.from(rows[1]?.querySelectorAll("td") ?? []).map((cell) =>
		(cell.querySelector(".tip-wrap > span")?.textContent ?? cell.textContent ?? "").trim()
	);
	expect(bareCells).toContain("-");
	expect(bareCells).toContain("");
});

test("filter narrows rows by name, id, family, and server label and updates 'showing N of M'", () => {
	const models = [
		makeModel({ id: "gpt-4o", name: "Omni", family: "gpt", serverLabel: "Prod" }),
		makeModel({ id: "claude-sonnet", name: "Sonnet", family: "claude", serverLabel: "Staging" }),
	];
	const root = mount(<ModelsSection models={models} serverCount={2} requestScopes={{}} modelParameters={{}} />);
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
	const single = mount(<ModelsSection models={models} serverCount={1} requestScopes={{}} modelParameters={{}} />);
	const singleHeaders = Array.from(single.querySelectorAll("th")).map((th) => (th.textContent ?? "").trim());
	expect(singleHeaders).not.toContain("Server");

	// Two groups can share one label; their models must stay attributable.
	const dual = mount(<ModelsSection models={models} serverCount={2} requestScopes={{}} modelParameters={{}} />);
	const dualHeaders = Array.from(dual.querySelectorAll("th")).map((th) => (th.textContent ?? "").trim());
	expect(dualHeaders).toContain("Server");
});

test("a server scope narrows the rows before the text filter and renders as a clearable chip", () => {
	const models = [
		makeModel({ id: "gpt-4o", name: "Omni", serverLabel: "Prod" }),
		makeModel({ id: "gpt-4o-b", name: "Omni B", serverLabel: "Prod" }),
		makeModel({ id: "claude-sonnet", name: "Sonnet", serverLabel: "Staging" }),
	];
	let cleared = 0;
	const root = mount(
		<ModelsSection
			models={models}
			serverCount={2}
			scope={{ label: "Prod", onClear: () => cleared++ }}
			requestScopes={{}}
			modelParameters={{}}
		/>
	);
	const visibleNames = () =>
		Array.from(root.querySelectorAll("tbody tr")).map((row) => (row.querySelector("td")?.textContent ?? "").trim());

	// The scope alone: only Prod's models, and the denominator follows it.
	expect(visibleNames()).toEqual(["Omni", "Omni B"]);
	expect(root.textContent).toContain("showing 2 of 2");
	expect((root.querySelector(".chip")?.textContent ?? "").trim()).toContain("Server: Prod");

	// The text filter composes on top of the scope, never around it.
	const filter = root.querySelector("input[aria-label='Filter models']") as HTMLInputElement;
	fireInput(filter, "sonnet");
	expect(visibleNames()).toEqual([]);
	expect(root.textContent).toContain("No models match the filter.");

	// Clearing is the owner's job: the chip's button only reports back.
	fireClick(root.querySelector("button[aria-label='Clear the server filter']") as HTMLElement);
	expect(cleared).toBe(1);
});
