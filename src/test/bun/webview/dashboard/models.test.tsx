/**
 * ModelsSection rendering: formatter behavior (tokens, pricing, capabilities,
 * the pricing tooltip) and the filter, server-scope, and server-column rules.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ModelsSection } from "../../../../webview/dashboard/models";
import { makeModel } from "../fixtures";
import { cleanup, fireClick, fireInput, mount, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

test("a row reads as two lines - name and meta, then a spec sentence - with the exact figures in its detail", () => {
	const priced = makeModel({
		id: "gpt-priced",
		rawId: "gpt-priced-raw",
		name: "GPT Priced",
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		outputLimitDeclared: true,
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
	const root = mount(<ModelsSection models={[priced, bare]} serverCount={1} onInspect={() => {}} />);

	const rows = Array.from(root.querySelectorAll("li.model-row"));
	expect(rows.length).toBe(2);

	// The second line is one readable sentence: limits, price, capabilities.
	// Token counts read compact here - the exact figures are in the detail.
	const line2 = (row: Element) => (row.querySelector(".model-line-2")?.textContent ?? "").trim();
	expect(rows[0]?.querySelector(".model-limits")?.textContent).toBe("128k context, 16k out");
	// Three significant digits, no binary-fraction noise.
	expect(rows[0]?.querySelector(".model-price")?.textContent).toBe("$2.5 in / $10.1 out");
	expect(line2(rows[0] as Element)).toContain("per M");

	// The row prints only what the model CAN do. It does not strike through the
	// rest: a strikethrough means SUPERSEDED everywhere in this dashboard (the
	// inspector's chain strikes a value a higher-precedence record beat, and
	// that mark is accessibility-pinned there), so one mark cannot also mean
	// "cannot". Absence carries it here and the detail answers explicitly.
	expect(rows[0]?.querySelector(".model-caps")?.textContent).toBe("tools, vision, caching, reasoning");
	expect(rows[0]?.querySelectorAll("del").length).toBe(0);

	// What is drawn and what is spoken are the same string now, so there is no
	// aria-hidden visual half and no visually-hidden spoken half to disagree.
	const caps = rows[0]?.querySelector(".model-caps") as HTMLElement;
	expect(caps.getAttribute("aria-hidden")).toBeNull();
	expect(rows[0]?.querySelector(".model-line-2 .sr-only")).toBeNull();

	// The bare model: no price at all says so in words rather than with a dash
	// nobody can read, and a model that can do none of the four prints no
	// capability clause at all rather than an empty one.
	expect(line2(rows[1] as Element)).toContain("price unknown");
	expect(rows[1]?.querySelector(".model-caps")).toBeNull();
	expect(rows[1]?.querySelectorAll("del").length).toBe(0);

	// The exact limits and the cache and long-context tiers live in the row's
	// detail. They used to be reachable only by pointing at the price cell, and
	// the exact token counts were not shown at all.
	fireClick(rows[0]?.querySelector("button.model-disclosure") as HTMLElement);
	const detail = rows[0]?.querySelector(".model-detail") as HTMLElement;
	const field = (label: string) =>
		Array.from(detail.querySelectorAll(".model-detail-field"))
			.find((entry) => entry.querySelector("dt")?.textContent === label)
			?.querySelector("dd")?.textContent;
	// toLocaleString is the formatter under test; compute the expectation the same way.
	expect(field("Max input tokens")).toBe((128000).toLocaleString());
	expect(field("Max output tokens")).toBe((16384).toLocaleString());
	// The RAW id: what a request's `model` field carries, which is not always
	// what the row is titled with and was previously readable only from the
	// copy button's accessible name.
	expect(field("Model ID")).toBe("gpt-priced-raw");
	expect(field("Cache read")).toBe("$0.257");
	expect(field("Cache write")).toBe("$3.13");
	expect(field("Long-context input")).toBe("$5");
	expect(field("Long-context output")).toBe("$20");
	expect(field("Long-context cache read")).toBe("$0.5");
	expect(field("Long-context cache write")).toBe("$6.25");
	expect(detail.textContent).toContain("USD per million tokens");

	// The negative answer lives here, explicitly, named and valued the way the
	// inspector's capabilities table names and values it.
	expect(field("Tool calling")).toBe("yes");
	expect(field("Vision")).toBe("yes");
	expect(field("Prompt caching")).toBe("yes");
	expect(field("Reasoning")).toBe("yes");
});

test("a capability the model lacks is answered in the detail, since the row only prints what it has", () => {
	const bare = makeModel({ id: "bare", toolCalling: true, imageInput: false, promptCaching: false, reasoning: false });
	const root = mount(<ModelsSection models={[bare]} serverCount={1} onInspect={() => {}} />);
	expect(root.querySelector(".model-caps")?.textContent).toBe("tools");

	fireClick(root.querySelector("button.model-disclosure") as HTMLElement);
	const detail = root.querySelector(".model-detail") as HTMLElement;
	const answer = (label: string) =>
		Array.from(detail.querySelectorAll(".model-detail-field"))
			.find((entry) => entry.querySelector("dt")?.textContent === label)
			?.querySelector("dd")?.textContent;
	expect(answer("Tool calling")).toBe("yes");
	expect(answer("Vision")).toBe("no");
	expect(answer("Prompt caching")).toBe("no");
	expect(answer("Reasoning")).toBe("no");
	// Never by drawing a line through it; that mark belongs to the inspector.
	expect(detail.querySelectorAll("del").length).toBe(0);
});

test("an undeclared output limit says so where the number is read", () => {
	// The extension picked that number and it caps requests, which is worth
	// saying next to it; a declared limit needs no such note.
	const assumed = makeModel({ id: "assumed", maxOutputTokens: 4096, outputLimitDeclared: false });
	const root = mount(<ModelsSection models={[assumed]} serverCount={1} onInspect={() => {}} />);
	fireClick(root.querySelector("button.model-disclosure") as HTMLElement);
	const detail = root.querySelector(".model-detail") as HTMLElement;
	const maxOutput = Array.from(detail.querySelectorAll(".model-detail-field")).find(
		(entry) => entry.querySelector("dt")?.textContent === "Max output tokens"
	);
	expect(maxOutput?.querySelector("dd")?.textContent).toBe(`${(4096).toLocaleString()} (assumed)`);
});

test("each spec segment owns the separator that follows it, so a dropped segment takes its dash with it", () => {
	// A narrow pane hides the token limits (the most derivable segment, and
	// frequently identical down the whole list) so that price and capabilities
	// - what the list is actually scanned for - stay on screen instead of being
	// clipped away. happy-dom runs no cascade, so what is pinned here is the
	// STRUCTURE that rule needs: every separator is a real element following
	// its segment, never a text node stranded between two spans and never a CSS
	// ::after a screen reader might not read.
	const priced = makeModel({ id: "priced", inputCost: 3, outputCost: 15, imageInput: true });
	const root = mount(<ModelsSection models={[priced]} serverCount={1} onInspect={() => {}} />);
	const line2 = root.querySelector(".model-line-2") as HTMLElement;

	// The children alternate segment, separator, segment, separator, segment,
	// and the separators carry real text.
	const classes = Array.from(line2.children).map((child) => child.className);
	expect(classes).toEqual(["model-limits", "model-sep", "model-cost", "model-sep", "model-caps"]);
	expect(Array.from(line2.querySelectorAll(".model-sep")).map((sep) => sep.textContent)).toEqual([" - ", " - "]);

	// The separator the narrow rule hides is the one immediately after the
	// limits, which is what makes `.model-limits + .model-sep` reach it.
	const limits = line2.querySelector(".model-limits") as HTMLElement;
	expect(limits.nextElementSibling?.className).toBe("model-sep");

	// A model with no capabilities has no trailing separator to dangle.
	const bare = makeModel({ id: "bare", toolCalling: false, inputCost: 1, outputCost: 2 });
	cleanup();
	const bareRoot = mount(<ModelsSection models={[bare]} serverCount={1} onInspect={() => {}} />);
	const bareLine = bareRoot.querySelector(".model-line-2") as HTMLElement;
	expect(Array.from(bareLine.children).map((child) => child.className)).toEqual([
		"model-limits",
		"model-sep",
		"model-cost",
	]);
	expect(bareLine.lastElementChild?.className).toBe("model-cost");
});

test("filter narrows rows by name, id, family, and server label and updates 'showing N of M'", () => {
	const models = [
		makeModel({ id: "gpt-4o", name: "Omni", family: "gpt", serverLabel: "Prod" }),
		makeModel({ id: "claude-sonnet", name: "Sonnet", family: "claude", serverLabel: "Staging" }),
	];
	const root = mount(<ModelsSection models={models} serverCount={2} onInspect={() => {}} />);
	const filter = root.querySelector("input[aria-label='Filter models']") as HTMLInputElement;
	const visibleNames = () =>
		Array.from(root.querySelectorAll("li.model-row")).map((row) =>
			(row.querySelector(".model-name-text")?.textContent ?? "").trim()
		);

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

test("the server names itself on the row only when serverCount > 1, keyed to the count rather than distinct labels", () => {
	// The rows carry no column headers, so the server rides in the row's meta
	// line - and it is still keyed to the count, because two groups can share
	// one label and their models must stay attributable.
	const models = [makeModel({ serverLabel: "Shared" }), makeModel({ id: "b", serverLabel: "Shared" })];
	const single = mount(<ModelsSection models={models} serverCount={1} onInspect={() => {}} />);
	expect(single.querySelector(".model-meta")?.textContent).toBe("gpt");

	const dual = mount(<ModelsSection models={models} serverCount={2} onInspect={() => {}} />);
	expect(dual.querySelector(".model-meta")?.textContent).toBe("gpt - Shared");

	// It is also what there is to sort by: no second server, no Server key.
	const sortKeys = (root: HTMLElement) =>
		Array.from(root.querySelectorAll(".sort-control option")).map((option) => (option.textContent ?? "").trim());
	expect(sortKeys(single)).not.toContain("Server");
	expect(sortKeys(dual)).toContain("Server");
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
			onInspect={() => {}}
		/>
	);
	const visibleNames = () =>
		Array.from(root.querySelectorAll("li.model-row")).map((row) =>
			(row.querySelector(".model-name-text")?.textContent ?? "").trim()
		);

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

test("a declared model says so on its row, and its detail explains what that means; discovered models do not", () => {
	// It used to be a badge with a hover tip. Being declared is the same kind
	// of fact as the family it sits beside, so it reads as part of the meta
	// line, and the explanation moved into the detail - where it is readable
	// without a pointer rather than only on hover.
	const root = mount(
		<ModelsSection
			models={[makeModel({ id: "my-model", name: "Mine", declared: true }), makeModel({ id: "gpt", name: "Found" })]}
			serverCount={1}
			onInspect={() => {}}
		/>
	);
	const rows = Array.from(root.querySelectorAll("li.model-row"));
	// Unsorted, so the rows keep the given order: Mine first, Found second.
	expect(rows.map((row) => row.querySelector(".model-meta")?.textContent)).toEqual(["gpt, declared", "gpt"]);

	fireClick(rows[0]?.querySelector("button.model-disclosure") as HTMLElement);
	expect(rows[0]?.querySelector(".model-detail")?.textContent).toContain("discovery.declared");

	// The discovered model's detail has nothing to say about it.
	fireClick(rows[1]?.querySelector("button.model-disclosure") as HTMLElement);
	expect(rows[1]?.querySelector(".model-detail")?.textContent).not.toContain("discovery.declared");
});

test("the Inspect action reports the clicked row's full identity to the inspector owner", () => {
	const model = makeModel({ id: "gpt-4", rawId: "gpt-4", scopeKey: "s3" });
	const opened: { scopeKey: string; rawId: string; serverLabel: string }[] = [];
	const root = mount(<ModelsSection models={[model]} serverCount={1} onInspect={(target) => opened.push(target)} />);
	const inspect = root.querySelector("button[aria-label='Inspect GPT Test on Prod']");
	expect(inspect).not.toBeNull();
	expect((inspect?.textContent ?? "").trim()).toBe("Inspect");
	fireClick(inspect as HTMLElement);
	// The overlay itself is App's (it opens over any tab); the section names
	// the full row identity - serverLabel included, since one snapshot can
	// render under several labels.
	expect(opened).toEqual([{ scopeKey: "s3", rawId: "gpt-4", serverLabel: "Prod" }]);
});
