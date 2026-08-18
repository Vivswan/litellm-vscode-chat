/**
 * ModelsSection rendering: formatter behavior (tokens, pricing, capabilities,
 * the pricing tooltip) and the filter, server-scope, and server-column rules.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { priceFilterLabel } from "../../../../dashboard/modelFilters";
import { ModelsSection } from "../../../../webview/dashboard/models";
import { makeModel } from "../fixtures";
import { buttonByText, cleanup, fireClick, fireInput, fireSelect, mount, render, resetPosted } from "../harness";

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
	const root = mount(<ModelsSection currencySymbol="$" models={[priced, bare]} serverCount={1} onInspect={() => {}} />);

	const rows = Array.from(root.querySelectorAll("li.model-row"));
	expect(rows.length).toBe(2);

	// The second line is one readable sentence: limits, price, capabilities.
	// Token counts read compact here - the exact figures are in the detail.
	const line2 = (row: Element) => (row.querySelector(".model-line-2")?.textContent ?? "").trim();
	expect(rows[0]?.querySelector(".model-limits")?.textContent).toBe("128k context, 16k out");
	// Three significant digits, no binary-fraction noise.
	expect(rows[0]?.querySelector(".model-price")?.textContent).toBe("$2.5 in / $10.1 out");
	expect(line2(rows[0] as Element)).toContain("per M");

	// The row prints only what the model CAN do; it never strikes through the
	// rest, because a strikethrough means SUPERSEDED everywhere in this
	// dashboard (the inspector's chain). Absence carries it, the detail answers.
	expect(rows[0]?.querySelector(".model-caps")?.textContent).toBe("tools, vision, caching, reasoning");
	expect(rows[0]?.querySelectorAll("del").length).toBe(0);

	// What is drawn and what is spoken are the same string now, so there is no
	// aria-hidden visual half and no visually-hidden spoken half to disagree.
	const caps = rows[0]?.querySelector(".model-caps") as HTMLElement;
	expect(caps.getAttribute("aria-hidden")).toBeNull();
	expect(rows[0]?.querySelector(".model-line-2 .visually-hidden")).toBeNull();

	// The bare model: no price at all says so in words rather than with a dash
	// nobody can read - and in the price pills' OWN words (priceFilterLabel), so
	// the row and the filter can never disagree - and a model that can do none
	// of the four prints no capability clause at all rather than an empty one.
	expect(rows[1]?.querySelector(".model-cost")?.textContent).toBe(priceFilterLabel("unpriced"));
	expect(rows[1]?.querySelector(".model-caps")).toBeNull();
	expect(rows[1]?.querySelectorAll("del").length).toBe(0);

	// The exact limits and the cache and long-context tiers live in the row's
	// detail.
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
	// what the row is titled with.
	expect(field("Model ID")).toBe("gpt-priced-raw");
	expect(field("Cache read")).toBe("$0.257");
	expect(field("Cache write")).toBe("$3.13");
	expect(field("Long-context input")).toBe("$5");
	expect(field("Long-context output")).toBe("$20");
	expect(field("Long-context cache read")).toBe("$0.5");
	expect(field("Long-context cache write")).toBe("$6.25");
	expect(detail.textContent).toContain("$ per million tokens");

	// The negative answer lives here, explicitly, named and valued the way the
	// inspector's capabilities table names and values it.
	expect(field("Tool calling")).toBe("yes");
	expect(field("Vision")).toBe("yes");
	expect(field("Prompt caching")).toBe("yes");
	expect(field("Reasoning")).toBe("yes");
});

test("a capability the model lacks is answered in the detail, since the row only prints what it has", () => {
	const bare = makeModel({ id: "bare", toolCalling: true, imageInput: false, promptCaching: false, reasoning: false });
	const root = mount(<ModelsSection currencySymbol="$" models={[bare]} serverCount={1} onInspect={() => {}} />);
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
	const root = mount(<ModelsSection currencySymbol="$" models={[assumed]} serverCount={1} onInspect={() => {}} />);
	fireClick(root.querySelector("button.model-disclosure") as HTMLElement);
	const detail = root.querySelector(".model-detail") as HTMLElement;
	const maxOutput = Array.from(detail.querySelectorAll(".model-detail-field")).find(
		(entry) => entry.querySelector("dt")?.textContent === "Max output tokens"
	);
	expect(maxOutput?.querySelector("dd")?.textContent).toBe(`${(4096).toLocaleString()} (assumed)`);
});

test("each spec segment owns the separator that follows it, so a dropped segment takes its dash with it", () => {
	// A narrow pane hides the token limits so price and capabilities survive.
	// happy-dom runs no cascade, so what is pinned is the STRUCTURE that rule
	// needs: every separator is a real element following its segment.
	const priced = makeModel({ id: "priced", inputCost: 3, outputCost: 15, imageInput: true });
	const root = mount(<ModelsSection currencySymbol="$" models={[priced]} serverCount={1} onInspect={() => {}} />);
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
	const bareRoot = mount(<ModelsSection currencySymbol="$" models={[bare]} serverCount={1} onInspect={() => {}} />);
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
	const root = mount(<ModelsSection currencySymbol="$" models={models} serverCount={2} onInspect={() => {}} />);
	const filter = root.querySelector("input[aria-label='Filter models']") as HTMLInputElement;
	const visibleNames = () =>
		Array.from(root.querySelectorAll("li.model-row")).map((row) =>
			(row.querySelector(".model-name-text")?.textContent ?? "").trim()
		);

	expect(visibleNames()).toEqual(["Omni", "Sonnet"]);
	// At rest the header carries no count: "showing 2 of 2" is a tautology.
	expect(root.textContent).not.toContain("showing");

	fireInput(filter, "omni"); // name
	expect(visibleNames()).toEqual(["Omni"]);
	fireInput(filter, "claude-son"); // id
	expect(visibleNames()).toEqual(["Sonnet"]);
	fireInput(filter, "GPT"); // family, case-insensitive
	expect(visibleNames()).toEqual(["Omni"]);
	fireInput(filter, "staging"); // server label
	expect(visibleNames()).toEqual(["Sonnet"]);
	// The count lives in the header's meta slot, beside the title it belongs to.
	expect(root.querySelector(".section-meta")?.textContent).toBe("showing 1 of 2");

	fireInput(filter, "no-such-model");
	expect(visibleNames()).toEqual([]);
	expect(root.textContent).toContain("No models match the filter.");
});

test("the server names itself on the row only when serverCount > 1, keyed to the count rather than distinct labels", () => {
	// The rows carry no column headers, so the server rides in the row's meta
	// line - and it is still keyed to the count, because two groups can share
	// one label and their models must stay attributable.
	const models = [makeModel({ serverLabel: "Shared" }), makeModel({ id: "b", serverLabel: "Shared" })];
	const single = mount(<ModelsSection currencySymbol="$" models={models} serverCount={1} onInspect={() => {}} />);
	expect(single.querySelector(".model-meta")?.textContent).toBe("gpt");

	const dual = mount(<ModelsSection currencySymbol="$" models={models} serverCount={2} onInspect={() => {}} />);
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
			currencySymbol="$"
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

	// The scope alone: only Prod's models, no count - the scope moves the
	// denominator, not the numerator, so an unfiltered scoped list is still
	// "everything", and a count would only say "2 of 2".
	expect(visibleNames()).toEqual(["Omni", "Omni B"]);
	expect(root.textContent).not.toContain("showing");
	expect((root.querySelector(".chip")?.textContent ?? "").trim()).toContain("Server: Prod");
	// Under the chip the rows drop the server suffix: every row's meta would
	// only repeat the label the chip already states.
	expect(root.querySelector(".model-meta")?.textContent).toBe("gpt");

	// The text filter composes on top of the scope, never around it - and the
	// count's denominator follows the scope.
	const filter = root.querySelector("input[aria-label='Filter models']") as HTMLInputElement;
	fireInput(filter, "sonnet");
	expect(visibleNames()).toEqual([]);
	expect(root.textContent).toContain("showing 0 of 2");
	expect(root.textContent).toContain("No models match the filter.");

	// Clearing is the owner's job: the chip's button only reports back.
	fireClick(root.querySelector("button[aria-label='Clear the server filter']") as HTMLElement);
	expect(cleared).toBe(1);
});

test("a declared model says so on its row, and its detail explains what that means; discovered models do not", () => {
	// Being declared is the same kind of fact as the family beside it, so it
	// reads as part of the meta line, and the explanation lives in the detail -
	// readable without a pointer rather than only on hover.
	const root = mount(
		<ModelsSection
			currencySymbol="$"
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
	const root = mount(
		<ModelsSection currencySymbol="$" models={[model]} serverCount={1} onInspect={(target) => opened.push(target)} />
	);
	const inspect = root.querySelector("button[aria-label='Inspect GPT Test on Prod']");
	expect(inspect).not.toBeNull();
	expect((inspect?.textContent ?? "").trim()).toBe("Inspect");
	fireClick(inspect as HTMLElement);
	// The overlay itself is App's (it opens over any tab); the section names
	// the full row identity - serverLabel included, since one snapshot can
	// render under several labels.
	expect(opened).toEqual([{ scopeKey: "s3", rawId: "gpt-4", serverLabel: "Prod" }]);
});

test("filter pills sit between the header and the list, dimension groups in the columns' order", () => {
	const models = [
		makeModel({ id: "a", family: "gpt", scopeKey: "s1", serverLabel: "Prod", inputCost: 1, toolCalling: true }),
		makeModel({ id: "b", family: "claude", scopeKey: "s2", serverLabel: "Staging", toolCalling: false }),
	];
	const root = mount(<ModelsSection currencySymbol="$" models={models} serverCount={2} onInspect={() => {}} />);
	const pills = root.querySelector(".filter-pills") as HTMLElement;
	// Between the header line and the list: the filter input lives in the
	// header's actions slot (the Settings filter's home), so nothing floats
	// between the header and the rows but the pills themselves.
	expect(root.querySelector(".section-actions input[aria-label='Filter models']")).not.toBeNull();
	expect(pills.previousElementSibling?.classList.contains("section-head")).toBe(true);
	expect(pills.nextElementSibling?.classList.contains("table-scroll")).toBe(true);
	// Groups follow the columnar tier's column order: the identity column's two
	// facts (family, then server), then price, then capabilities.
	const groups = Array.from(pills.querySelectorAll(".filter-pill-group"));
	expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
		"Filter by family",
		"Filter by server",
		"Filter by price",
		"Filter by capability",
	]);
	// Every pill is a toggle button carrying its state.
	const buttons = Array.from(pills.querySelectorAll("button.filter-pill"));
	expect(buttons.length).toBeGreaterThan(0);
	for (const button of buttons) {
		expect(button.getAttribute("aria-pressed")).toBe("false");
	}
	// Nothing is pressed, so there is nothing to clear.
	expect(Array.from(pills.querySelectorAll("button")).some((b) => b.textContent === "Clear filters")).toBe(false);
});

test("a pill toggles with aria-pressed, narrows the rows, and moves the live count", () => {
	const models = [
		makeModel({ id: "a", name: "Tools", toolCalling: true }),
		makeModel({ id: "b", name: "Bare", toolCalling: false }),
	];
	const root = mount(<ModelsSection currencySymbol="$" models={models} serverCount={1} onInspect={() => {}} />);
	const visibleNames = () =>
		Array.from(root.querySelectorAll("li.model-row")).map((row) =>
			(row.querySelector(".model-name-text")?.textContent ?? "").trim()
		);
	const pill = buttonByText(root.querySelector(".filter-pills") as HTMLElement, "tools");

	expect(root.textContent).not.toContain("showing");
	fireClick(pill);
	expect(pill.getAttribute("aria-pressed")).toBe("true");
	expect(visibleNames()).toEqual(["Tools"]);
	expect(root.textContent).toContain("showing 1 of 2");
	// A toggle, one by one: pressing again clears exactly this pill, and the
	// count retires with the narrowing.
	fireClick(pill);
	expect(pill.getAttribute("aria-pressed")).toBe("false");
	expect(visibleNames()).toEqual(["Tools", "Bare"]);
	expect(root.textContent).not.toContain("showing");
});

test("pills compose with the text filter and the server scope", () => {
	const models = [
		makeModel({ id: "a", name: "Omni", family: "gpt", serverLabel: "Prod", imageInput: true }),
		makeModel({ id: "b", name: "Mini", family: "gpt", serverLabel: "Prod", imageInput: false }),
		makeModel({ id: "c", name: "Sonnet Vision", family: "claude", serverLabel: "Staging", imageInput: true }),
	];
	const root = mount(
		<ModelsSection
			currencySymbol="$"
			models={models}
			serverCount={2}
			scope={{ label: "Prod", onClear: () => {} }}
			onInspect={() => {}}
		/>
	);
	const visibleNames = () =>
		Array.from(root.querySelectorAll("li.model-row")).map((row) =>
			(row.querySelector(".model-name-text")?.textContent ?? "").trim()
		);
	// The scope narrows first: Staging's vision model is out before any pill.
	fireClick(buttonByText(root.querySelector(".filter-pills") as HTMLElement, "vision"));
	expect(visibleNames()).toEqual(["Omni"]);
	// The text filter is the third condition on top.
	fireInput(root.querySelector("input[aria-label='Filter models']") as HTMLInputElement, "mini");
	expect(visibleNames()).toEqual([]);
	expect(root.textContent).toContain("showing 0 of 2");
});

test("server pills are offered per scopeKey - two servers sharing a label stay two pills", () => {
	const models = [
		makeModel({ id: "a", name: "On S1", scopeKey: "s1", serverLabel: "prod" }),
		makeModel({ id: "b", name: "On S2", scopeKey: "s2", serverLabel: "prod" }),
	];
	const root = mount(<ModelsSection currencySymbol="$" models={models} serverCount={2} onInspect={() => {}} />);
	const serverGroup = root.querySelector("[aria-label='Filter by server']") as HTMLElement;
	const pills = Array.from(serverGroup.querySelectorAll("button.filter-pill"));
	// Numbered apart: two controls reading identically could not be chosen
	// between on purpose; the scopeKey stays the identity underneath.
	expect(pills.map((pill) => pill.textContent)).toEqual(["prod (1)", "prod (2)"]);
	fireClick(pills[0] as HTMLElement);
	const visibleNames = Array.from(root.querySelectorAll("li.model-row")).map((row) =>
		(row.querySelector(".model-name-text")?.textContent ?? "").trim()
	);
	expect(visibleNames).toEqual(["On S1"]);
});

test("one serving server means no server pills, matching the rows' own rule", () => {
	const models = [makeModel({ id: "a" }), makeModel({ id: "b", family: "claude" })];
	const root = mount(<ModelsSection currencySymbol="$" models={models} serverCount={1} onInspect={() => {}} />);
	expect(root.querySelector("[aria-label='Filter by server']")).toBeNull();
	// The family dimension still offers its pills.
	expect(root.querySelector("[aria-label='Filter by family']")).not.toBeNull();
});

test("a pressed server pill survives the fleet dropping to one server, so its filter stays clearable", () => {
	const twoServers = [
		makeModel({ id: "a", name: "On S1", scopeKey: "s1", serverLabel: "prod" }),
		makeModel({ id: "b", name: "On S2", scopeKey: "s2", serverLabel: "staging" }),
	];
	const root = mount(<ModelsSection currencySymbol="$" models={twoServers} serverCount={2} onInspect={() => {}} />);
	fireClick(buttonByText(root.querySelector("[aria-label='Filter by server']") as HTMLElement, "staging"));
	// The staging group disappears and the fleet is one server again, hiding the
	// server DIMENSION - but the pressed pill still applies, so it alone stays,
	// pressed and unpressable back to nothing.
	const oneServer = [twoServers[0] as ReturnType<typeof makeModel>];
	render(<ModelsSection currencySymbol="$" models={oneServer} serverCount={1} onInspect={() => {}} />, root);
	expect(root.textContent).toContain("showing 0 of 1");
	const pill = buttonByText(root.querySelector("[aria-label='Filter by server']") as HTMLElement, "staging");
	expect(pill.getAttribute("aria-pressed")).toBe("true");
	fireClick(pill);
	// Nothing narrows anymore: the row is back and the count retires with it.
	expect(root.querySelectorAll("li.model-row").length).toBe(1);
	expect(root.textContent).not.toContain("showing");
	// Nothing pressed anywhere anymore, so the one-server rule hides the group again.
	expect(root.querySelector("[aria-label='Filter by server']")).toBeNull();
});

test("Clear filters clears every pill and the text at once", () => {
	const models = [
		makeModel({ id: "a", name: "Omni", family: "gpt", toolCalling: true }),
		makeModel({ id: "b", name: "Sonnet", family: "claude", toolCalling: false }),
	];
	const root = mount(<ModelsSection currencySymbol="$" models={models} serverCount={1} onInspect={() => {}} />);
	const pillRow = () => root.querySelector(".filter-pills") as HTMLElement;
	const input = root.querySelector("input[aria-label='Filter models']") as HTMLInputElement;

	fireClick(buttonByText(pillRow(), "gpt"));
	fireClick(buttonByText(pillRow(), "tools"));
	fireInput(input, "omni");
	expect(root.textContent).toContain("showing 1 of 2");

	fireClick(buttonByText(pillRow(), "Clear filters"));
	expect(root.querySelectorAll("li.model-row").length).toBe(2);
	expect(root.textContent).not.toContain("showing");
	expect(input.value).toBe("");
	for (const pill of Array.from(root.querySelectorAll("button.filter-pill"))) {
		expect(pill.getAttribute("aria-pressed")).toBe("false");
	}
	// Everything cleared, so the clear-all affordance retires.
	expect(Array.from(pillRow().querySelectorAll("button")).some((b) => b.textContent === "Clear filters")).toBe(false);
	// The press unmounted the button that held focus; the filter input is
	// where the cleared filters live on, so focus lands there instead of
	// falling to the body.
	expect(document.activeElement).toBe(input);
});

test("a scope over two groups sharing the label keeps the server UI: the numbered pills are the only thing apart", () => {
	// A scope is a LABEL, so both groups are inside it. Their rows' suffixes
	// read identically, but the server pills stay offered (numbered per
	// scopeKey) because they are the one control that can still split the two.
	const models = [
		makeModel({ id: "a", name: "On S1", scopeKey: "s1", serverLabel: "prod" }),
		makeModel({ id: "b", name: "On S2", scopeKey: "s2", serverLabel: "prod" }),
	];
	const root = mount(
		<ModelsSection
			currencySymbol="$"
			models={models}
			serverCount={2}
			scope={{ label: "prod", onClear: () => {} }}
			onInspect={() => {}}
		/>
	);
	expect(root.querySelector(".model-meta")?.textContent).toBe("gpt - prod");
	const serverGroup = root.querySelector("[aria-label='Filter by server']") as HTMLElement;
	expect(serverGroup).not.toBeNull();
	expect(Array.from(serverGroup.querySelectorAll("button.filter-pill")).map((pill) => pill.textContent)).toEqual([
		"prod (1)",
		"prod (2)",
	]);
});

test("a hidden Server sort key reads and renders as unsorted, and comes back with the scope's clearing", () => {
	// Discovered order deliberately disagrees with server order, so the two
	// are tellable apart in every assertion below.
	const models = [
		makeModel({ id: "a", name: "Alpha", scopeKey: "s2", serverLabel: "staging" }),
		makeModel({ id: "b", name: "Bravo", scopeKey: "s1", serverLabel: "prod" }),
	];
	const root = mount(<ModelsSection currencySymbol="$" models={models} serverCount={2} onInspect={() => {}} />);
	const select = () => root.querySelector(".sort-control select") as HTMLSelectElement;
	const dir = () => root.querySelector("button.sort-dir") as HTMLButtonElement;
	const visibleNames = () =>
		Array.from(root.querySelectorAll("li.model-row")).map((row) =>
			(row.querySelector(".model-name-text")?.textContent ?? "").trim()
		);
	fireSelect(select(), "server");
	expect(visibleNames()).toEqual(["Bravo", "Alpha"]);

	// Scoping hides the Server key. The picked state survives underneath, but
	// the list must not follow an order the control cannot display: it renders
	// in discovered order and the control reads unsorted, direction disabled.
	render(
		<ModelsSection
			currencySymbol="$"
			models={models}
			serverCount={2}
			scope={{ label: "prod", onClear: () => {} }}
			onInspect={() => {}}
		/>,
		root
	);
	expect(select().value).toBe("discovered");
	expect(dir().disabled).toBe(true);

	// Clearing the scope restores the sort exactly as it was picked.
	render(<ModelsSection currencySymbol="$" models={models} serverCount={2} onInspect={() => {}} />, root);
	expect(select().value).toBe("server");
	expect(dir().disabled).toBe(false);
	expect(visibleNames()).toEqual(["Bravo", "Alpha"]);
});

test("an all-filtered list is one sentence plus a clear action that brings the models back", () => {
	const models = [
		makeModel({ id: "a", name: "Omni", family: "gpt" }),
		makeModel({ id: "b", name: "Sonnet", family: "claude" }),
	];
	const root = mount(<ModelsSection currencySymbol="$" models={models} serverCount={1} onInspect={() => {}} />);
	// A family pill plus a text needle from the other family: nothing survives.
	fireClick(buttonByText(root.querySelector(".filter-pills") as HTMLElement, "gpt"));
	fireInput(root.querySelector("input[aria-label='Filter models']") as HTMLInputElement, "sonnet");
	const empty = root.querySelector("p.empty") as HTMLElement;
	expect(empty.textContent).toContain("No models match the filter.");

	// EXACTLY one clear control: the pill row has its own solo case, but with
	// the empty sentence carrying a clear beside it, a second identical button
	// a line above read as a different action.
	const clears = Array.from(root.querySelectorAll("button")).filter((b) => b.textContent === "Clear filters");
	expect(clears.length).toBe(1);
	expect(empty.contains(clears[0] as HTMLElement)).toBe(true);

	// Pressing the sole clear unmounts the button under the keyboard user, so
	// focus must land on the filter input. happy-dom's click does not focus, so
	// the test takes the position deliberately before pressing.
	const clear = clears[0] as HTMLButtonElement;
	clear.focus();
	fireClick(clear);
	expect(root.querySelector("p.empty")).toBeNull();
	expect(root.querySelectorAll("li.model-row").length).toBe(2);
	expect(root.textContent).not.toContain("showing");
	expect(document.activeElement).toBe(root.querySelector("input[aria-label='Filter models']"));
});
