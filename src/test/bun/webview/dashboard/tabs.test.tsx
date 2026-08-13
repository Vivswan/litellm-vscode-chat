/**
 * The rail's section navigation: WAI-ARIA tabs wiring, click and keyboard
 * switching, the kept-mounted panels (an open filter or form must survive a
 * visit to another section, so inactive panels hide instead of unmounting),
 * and the bridge between the two destinations a server's models span - a
 * server row's model count navigating to Models scoped to that server.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { App } from "../../../../webview/dashboard/app";
import { makeDeclaredServer, makeModel, makeState, makeUsage, makeUsageServer, statePush } from "../fixtures";
import { cleanup, fireClick, fireInput, fireKeyDown, mount, pushToWebview, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

/** A rail item's label, without the count the item now carries beside it. */
function labelOf(item: Element): string {
	const count = item.querySelector(".rail-count")?.textContent ?? "";
	return (item.textContent ?? "").slice(0, (item.textContent ?? "").length - count.length).trim();
}

function tab(root: ParentNode, name: string): HTMLButtonElement {
	const found = Array.from(root.querySelectorAll("[role='tab']")).find((candidate) => labelOf(candidate) === name);
	if (found === undefined) {
		throw new Error(`no tab named ${name}`);
	}
	return found as HTMLButtonElement;
}

function panel(root: ParentNode, section: string): HTMLElement {
	const found = root.querySelector(`#panel-${section}`);
	if (found === null) {
		throw new Error(`no panel for ${section}`);
	}
	return found as HTMLElement;
}

function mountApp() {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				// The count matches the models below it: a row claiming zero while
				// serving two renders its count as plain text, and the navigation
				// this file pins hangs off the count link.
				servers: [makeDeclaredServer({ modelCount: 2 })],
				models: [makeModel(), makeModel({ id: "second", name: "Second" })],
			})
		)
	);
	return root;
}

/** Two servers with attributable models, for the count-link scoping tests. */
function scopedState() {
	return makeState({
		servers: [
			makeDeclaredServer({ label: "Prod", modelCount: 2 }),
			makeDeclaredServer({ label: "Staging", baseUrl: "http://localhost:4001", modelCount: 1 }),
		],
		models: [
			makeModel({ id: "gpt-a", name: "Alpha", serverLabel: "Prod" }),
			makeModel({ id: "gpt-b", name: "Bravo", serverLabel: "Prod" }),
			makeModel({ id: "gpt-c", name: "Charlie", serverLabel: "Staging" }),
		],
	});
}

function visibleModelNames(root: ParentNode): string[] {
	return Array.from(root.querySelectorAll("#models-section tbody tr:not(.spacer)")).map((row) =>
		(row.querySelector("td")?.textContent ?? "").trim()
	);
}

test("five rail items in reading order, servers selected by default, and panels wired by aria", () => {
	const root = mountApp();
	const tabs = Array.from(root.querySelectorAll("[role='tab']"));
	// Order is the rail's order: the two you look at, then the one that tells
	// you something is wrong, then the one you visit on purpose.
	expect(tabs.map(labelOf)).toEqual(["Servers", "Models", "Usage", "Diagnostics", "Settings"]);
	// A count inside the button would otherwise announce as "Servers & Models
	// 4" - a number with no noun - and the tabpanel inherits that name too. So
	// an item carrying a count names itself in words, with the visible label
	// still inside the accessible name (Label in Name).
	const named = tabs.filter((t) => t.querySelector(".rail-count") !== null);
	expect(named.length).toBeGreaterThan(0);
	for (const t of named) {
		const label = t.getAttribute("aria-label") ?? "";
		expect(label).toContain(labelOf(t));
		expect(label).not.toBe(labelOf(t));
	}
	// An item with nothing to count says only its name.
	for (const t of tabs.filter((t) => t.querySelector(".rail-count") === null)) {
		expect(t.hasAttribute("aria-label")).toBe(false);
	}
	// The rail is vertical and has to say so, or the arrow keys it answers to
	// are not the ones a screen reader tells the user about.
	expect(root.querySelector("[role='tablist']")?.getAttribute("aria-orientation")).toBe("vertical");
	// Each item points at the panel it controls; the panel points back. Only
	// the second half was pinned before, so a half-wired pair would have passed.
	for (const t of tabs) {
		const panelId = t.getAttribute("aria-controls") ?? "";
		expect(panelId).not.toBe("");
		expect(root.querySelector(`#${panelId}`)?.getAttribute("aria-labelledby")).toBe(t.id);
	}

	const overview = tab(root, "Servers");
	expect(overview.getAttribute("aria-selected")).toBe("true");
	expect(overview.tabIndex).toBe(0);
	expect(tab(root, "Usage").tabIndex).toBe(-1);
	expect(tab(root, "Settings").tabIndex).toBe(-1);
	expect(tab(root, "Diagnostics").tabIndex).toBe(-1);

	for (const section of ["overview", "models", "usage", "settings", "diagnostics"]) {
		const pane = panel(root, section);
		expect(pane.getAttribute("role")).toBe("tabpanel");
		expect(pane.getAttribute("aria-labelledby")).toBe(`tab-${section}`);
		expect(pane.hidden).toBe(section !== "overview");
	}
});

test("servers and models are separate destinations, each holding only its own table", () => {
	// They are one workflow, but sharing a page cost more than it bought: a rail
	// item could only count one of its two nouns, and the models table had to
	// virtualize into an inner scrollport with a height budget tuned against
	// whatever chrome sat above it.
	const root = mountApp();
	const servers = panel(root, "overview");
	const models = panel(root, "models");
	expect(servers.querySelector("table.servers")).not.toBeNull();
	expect(servers.querySelector("table.models")).toBeNull();
	expect(models.querySelector("#models-section table.models")).not.toBeNull();
	expect(models.querySelector("table.servers")).toBeNull();
});

test("a server's model count navigates to Models filtered to that server", () => {
	// The jump used to scroll down a shared page. Across destinations it has to
	// navigate, carry the filter, and move focus - otherwise Tab continues from
	// a link on a panel that is no longer visible.
	const root = mountApp();
	const countLink = panel(root, "overview").querySelector("table.servers .count-link") as HTMLElement | null;
	expect(countLink).not.toBeNull();
	fireClick(countLink as HTMLElement);
	expect(tab(root, "Models").getAttribute("aria-selected")).toBe("true");
	expect(panel(root, "models").hidden).toBe(false);
	// The scope chip names the server the reader came from.
	expect(panel(root, "models").textContent).toContain("Server: Prod");
});

test("with zero servers the guided start is the whole story, and Models says it has none", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	expect(panel(root, "overview").querySelector(".empty-start")).not.toBeNull();
	// The models destination still exists - a rail item that vanishes is worse
	// than one that explains itself - and says plainly that there is nothing
	// yet. With no servers at all it must not suggest a sync: there is nobody
	// to ask, and the reader's next step is adding a server. Scoped to the
	// empty block, because the section's help text mentions Sync models too.
	const empty = panel(root, "models").querySelector(".empty-block") as HTMLElement;
	expect(empty).not.toBeNull();
	expect(empty.textContent).toContain("No models yet.");
	expect(empty.textContent).toContain("Add a server under Servers");
	expect(empty.textContent).not.toContain("Sync models");
});

test("clicking a tab switches the visible panel and aria-selected follows", () => {
	const root = mountApp();
	fireClick(tab(root, "Settings"));
	expect(panel(root, "settings").hidden).toBe(false);
	expect(panel(root, "overview").hidden).toBe(true);
	expect(tab(root, "Settings").getAttribute("aria-selected")).toBe("true");
	expect(tab(root, "Servers").getAttribute("aria-selected")).toBe("false");

	fireClick(tab(root, "Servers"));
	expect(panel(root, "overview").hidden).toBe(false);
	expect(panel(root, "settings").hidden).toBe(true);
});

test("the Usage tab renders the pushed usage snapshot's cards", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				servers: [makeDeclaredServer()],
				usage: makeUsage({ servers: [makeUsageServer({ label: "Prod", spend: 12.5 })] }),
			})
		)
	);
	fireClick(tab(root, "Usage"));
	const usagePanel = panel(root, "usage");
	expect(usagePanel.hidden).toBe(false);
	expect(usagePanel.querySelector(".usage-row")).not.toBeNull();
	expect(usagePanel.textContent).toContain("Prod");
});

test("a focusSection push switches the active tab: the litellm.showDiagnostics deep link", () => {
	const root = mountApp();
	pushToWebview({ kind: "focusSection", section: "diagnostics" });

	expect(panel(root, "diagnostics").hidden).toBe(false);
	expect(panel(root, "overview").hidden).toBe(true);
	expect(tab(root, "Diagnostics").getAttribute("aria-selected")).toBe("true");
});

test("a focusSection push naming an unknown section is dropped instead of blanking every panel", () => {
	const root = mountApp();
	pushToWebview({ kind: "focusSection", section: "definitely-not-a-section" });

	expect(panel(root, "overview").hidden).toBe(false);
	expect(tab(root, "Servers").getAttribute("aria-selected")).toBe("true");
});

test("arrow keys move selection with wrap-around; Home and End jump", () => {
	// Down and Up, not Right and Left: the rail is vertical and says so with
	// aria-orientation, and the arrow keys have to follow the axis a reader
	// sees or the roving tabindex contract is a lie.
	const root = mountApp();
	const tablist = root.querySelector("[role='tablist']") as HTMLElement;

	fireKeyDown(tablist, "ArrowDown");
	expect(tab(root, "Models").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowDown");
	expect(tab(root, "Usage").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowDown");
	expect(tab(root, "Diagnostics").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowDown");
	expect(tab(root, "Settings").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowDown");
	expect(tab(root, "Servers").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowUp");
	expect(tab(root, "Settings").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "Home");
	expect(tab(root, "Servers").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "End");
	expect(tab(root, "Settings").getAttribute("aria-selected")).toBe("true");
});

test("section-local state survives a round trip through another tab", () => {
	const root = mountApp();
	// The filter belongs to Models, so the round trip has to actually go there
	// and back. Editing it from Servers and returning to Servers never leaves
	// or re-enters the panel under test, so it would pass even if Models
	// unmounted and lost every bit of its state.
	fireClick(tab(root, "Models"));
	const filter = root.querySelector("input[aria-label='Filter models']") as HTMLInputElement;
	fireInput(filter, "second");
	expect(root.textContent).toContain("showing 1 of 2");

	fireClick(tab(root, "Settings"));
	expect(panel(root, "models").hidden).toBe(true);
	fireClick(tab(root, "Models"));
	expect(panel(root, "models").hidden).toBe(false);
	const restored = root.querySelector("input[aria-label='Filter models']") as HTMLInputElement;
	expect(restored.value).toBe("second");
	expect(root.textContent).toContain("showing 1 of 2");
});

test("controls inside an inactive panel sit under a hidden ancestor, out of the Tab order", () => {
	const root = mountApp();
	fireClick(tab(root, "Settings"));

	// hidden => display:none => unfocusable; this is the property that keeps
	// background panels Tab-unreachable, so pin it on a real control.
	const addServer = Array.from(root.querySelectorAll("button")).find(
		(b) => (b.textContent ?? "").trim() === "Add server"
	);
	expect(addServer).toBeDefined();
	expect(addServer?.closest("[hidden]")).not.toBeNull();

	// The active panel's controls have no hidden ancestor.
	const settingInput = panel(root, "settings").querySelector("input");
	expect(settingInput).not.toBeNull();
	expect(settingInput?.closest("[hidden]")).toBeNull();
});

test("a server row's model count scopes the models list, and the chip's clear restores it", () => {
	const root = mount(<App />);
	pushToWebview(statePush(scopedState()));
	expect(visibleModelNames(root)).toEqual(["Alpha", "Bravo", "Charlie"]);

	fireClick(root.querySelector("button[aria-label='Show models from Staging']") as HTMLElement);
	expect(visibleModelNames(root)).toEqual(["Charlie"]);
	// The jump moves the keyboard position with the viewport: focus lands on
	// the models section, so Tab continues into the filter and the table.
	expect(document.activeElement?.id).toBe("models-section");
	const chip = root.querySelector(".chip");
	expect((chip?.textContent ?? "").trim()).toContain("Server: Staging");
	// The denominator follows the scope: one of Staging's one model.
	expect(root.textContent).toContain("showing 1 of 1");

	fireClick(chip?.querySelector("button[aria-label='Clear the server filter']") as HTMLElement);
	expect(root.querySelector(".chip")).toBeNull();
	expect(visibleModelNames(root)).toEqual(["Alpha", "Bravo", "Charlie"]);
});

test("the server scope and the text filter compose, and switching scope replaces the chip", () => {
	const root = mount(<App />);
	pushToWebview(statePush(scopedState()));

	fireClick(root.querySelector("button[aria-label='Show models from Prod']") as HTMLElement);
	const filter = root.querySelector("input[aria-label='Filter models']") as HTMLInputElement;
	fireInput(filter, "bra");
	expect(visibleModelNames(root)).toEqual(["Bravo"]);
	expect(root.textContent).toContain("showing 1 of 2");

	// A second count link retargets the one scope; the typed filter stays.
	fireClick(root.querySelector("button[aria-label='Show models from Staging']") as HTMLElement);
	expect(root.querySelectorAll(".chip").length).toBe(1);
	expect((root.querySelector(".chip")?.textContent ?? "").trim()).toContain("Server: Staging");
	expect(visibleModelNames(root)).toEqual([]);
	expect(root.textContent).toContain("No models match the filter.");
});

test("the scope clears itself when the scoped server leaves the list", () => {
	const root = mount(<App />);
	pushToWebview(statePush(scopedState()));
	fireClick(root.querySelector("button[aria-label='Show models from Staging']") as HTMLElement);
	expect(root.querySelector(".chip")).not.toBeNull();

	const remaining = makeState({
		servers: [makeDeclaredServer({ label: "Prod", modelCount: 2 })],
		models: [
			makeModel({ id: "gpt-a", name: "Alpha", serverLabel: "Prod" }),
			makeModel({ id: "gpt-b", name: "Bravo", serverLabel: "Prod" }),
		],
	});
	pushToWebview(statePush(remaining));
	expect(root.querySelector(".chip")).toBeNull();
	expect(visibleModelNames(root)).toEqual(["Alpha", "Bravo"]);
});

test("a zero model count renders as plain text, not a scope link", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				servers: [makeDeclaredServer({ label: "Fresh", modelCount: 0 })],
				models: [],
			})
		)
	);
	expect(root.querySelector("button[aria-label='Show models from Fresh']")).toBeNull();
	expect(root.textContent).toContain("No models discovered yet.");
});

test("scoping rewinds a deeply scrolled windowed table to the new list's top", () => {
	const pad = (i: number) => String(i).padStart(2, "0");
	const models = [
		...Array.from({ length: 60 }, (_, i) => makeModel({ id: `a-${pad(i)}`, name: `A ${pad(i)}`, serverLabel: "Prod" })),
		...Array.from({ length: 60 }, (_, i) =>
			makeModel({ id: `b-${pad(i)}`, name: `B ${pad(i)}`, serverLabel: "Staging" })
		),
	];
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				servers: [
					makeDeclaredServer({ label: "Prod", modelCount: 60 }),
					makeDeclaredServer({ label: "Staging", baseUrl: "http://localhost:4001", modelCount: 60 }),
				],
				models,
			})
		)
	);

	// 120 rows exceed the windowing threshold; scroll deep into the list.
	const scrollport = root.querySelector(".table-scroll.windowed") as HTMLElement;
	void act(() => {
		scrollport.scrollTop = 26 * 100;
		scrollport.dispatchEvent(new Event("scroll"));
	});
	expect(visibleModelNames(root)).not.toContain("A 00");

	// The scope jump lands at the new list's first row, not at an inherited
	// scroll offset partway through it.
	fireClick(root.querySelector("button[aria-label='Show models from Staging']") as HTMLElement);
	expect(scrollport.scrollTop).toBe(0);
	expect(visibleModelNames(root)[0]).toBe("B 00");
});

test("arrow keys move focus with selection, and only the selected item is tabbable", () => {
	// The roving tabindex is the whole keyboard contract: exactly one stop in
	// the tab order, and the arrows move focus rather than merely repainting
	// aria-selected. Asserting selection alone would pass on a rail that leaves
	// focus stranded on the item you arrowed away from.
	const root = mountApp();
	const tablist = root.querySelector("[role='tablist']") as HTMLElement;
	const tabIndexes = () => Array.from(root.querySelectorAll("[role='tab']")).map((t) => (t as HTMLElement).tabIndex);
	expect(tabIndexes()).toEqual([0, -1, -1, -1, -1]);

	fireKeyDown(tablist, "ArrowDown");
	expect(tabIndexes()).toEqual([-1, 0, -1, -1, -1]);
	expect(document.activeElement).toBe(tab(root, "Models"));

	fireKeyDown(tablist, "End");
	expect(tabIndexes()).toEqual([-1, -1, -1, -1, 0]);
	expect(document.activeElement).toBe(tab(root, "Settings"));
});
