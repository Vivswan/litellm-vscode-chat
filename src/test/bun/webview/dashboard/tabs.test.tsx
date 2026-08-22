/**
 * The rail's section navigation: WAI-ARIA tabs wiring, click and keyboard
 * switching, the kept-mounted panels (an open filter or form survives a visit
 * elsewhere), and a server row's model count scoping the Models destination.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { App } from "../../../../webview/dashboard/app";
import { DEFAULT_ROW_HEIGHT } from "../../../../webview/dashboard/models";
import { makeDeclaredServer, makeModel, makeState, makeUsage, makeUsageServer, statePush } from "../fixtures";
import { cleanup, fireClick, fireInput, fireKeyDown, mount, pushToWebview, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

/** A rail item's label: the item's own label element, not its whole text run -
 *  the button also carries a count and, for the collapsed rail, a tip. */
function labelOf(item: Element): string {
	return (item.querySelector(".rail-label")?.textContent ?? "").trim();
}

test("the rail's footer actions and its verdict keep their words in the DOM behind aria-hidden glyphs", () => {
	// The collapsed rail paints these three as glyphs alone, so each one's whole
	// meaning rests on the label element that survives as the accessible name;
	// the glyph beside it is aria-hidden so the name is said once.
	const root = mountApp();
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	for (const action of Array.from(root.querySelectorAll(".rail-action"))) {
		const label = action.querySelector(".rail-action-label")?.textContent ?? "";
		expect(label.length).toBeGreaterThan(0);
		expect(action.querySelector(".rail-action-icon")?.getAttribute("aria-hidden")).toBe("true");
	}
	const dot = root.querySelector(".rail-status .dot");
	expect(dot?.getAttribute("aria-hidden")).toBe("true");
	const word = root.querySelector(".rail-word")?.textContent ?? "";
	expect(word.length).toBeGreaterThan(0);
});

test("every rail item carries its label in a .rail-label element, behind an aria-hidden icon", () => {
	// The label element keeps the accessible name once the rail paints icons
	// only - and these suites read labels from it, so a rename would leave them
	// reading "" and still passing. The icon is aria-hidden: the name is said once.
	const root = mountApp();
	const items = Array.from(root.querySelectorAll("[role='tab']"));
	expect(items.length).toBeGreaterThan(0);
	for (const item of items) {
		const label = item.querySelector(".rail-label")?.textContent ?? "";
		expect(label.length).toBeGreaterThan(0);
		expect(item.querySelector(".rail-icon")?.getAttribute("aria-hidden")).toBe("true");
	}
});

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
				servers: [makeDeclaredServer({ servedModelCount: 2 })],
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
			makeDeclaredServer({ label: "Prod", servedModelCount: 2 }),
			makeDeclaredServer({ label: "Staging", baseUrl: "http://localhost:4001", servedModelCount: 1 }),
		],
		models: [
			makeModel({ id: "gpt-a", name: "Alpha", serverLabel: "Prod" }),
			makeModel({ id: "gpt-b", name: "Bravo", serverLabel: "Prod" }),
			makeModel({ id: "gpt-c", name: "Charlie", serverLabel: "Staging" }),
		],
	});
}

function visibleModelNames(root: ParentNode): string[] {
	return Array.from(root.querySelectorAll("#models-section li.model-row")).map((row) =>
		(row.querySelector(".model-name-text")?.textContent ?? "").trim()
	);
}

/** Open a server row's drawer and click its model-count link (the drawer is where the link lives). */
function clickCountLink(root: ParentNode, label: string): void {
	const link = () => root.querySelector(`button[aria-label='Show models from ${label}']`);
	if (link() === null) {
		const line = Array.from(root.querySelectorAll("#panel-overview button.server-line")).find(
			(candidate) => (candidate.querySelector(".server-label-text")?.textContent ?? "").trim() === label
		);
		if (!(line instanceof HTMLElement)) {
			throw new Error(`no server row named ${label}`);
		}
		fireClick(line);
	}
	const found = link();
	if (!(found instanceof HTMLElement)) {
		throw new Error(`no model-count link for ${label}`);
	}
	fireClick(found);
}

test("five rail items in reading order, servers selected by default, and panels wired by aria", () => {
	const root = mountApp();
	const tabs = Array.from(root.querySelectorAll("[role='tab']"));
	// Order is the rail's order: what the fleet IS (the servers, then the models
	// they serve), then what it DOES (the features and the settings behind
	// them), then the destination that tells you something is wrong.
	expect(tabs.map(labelOf)).toEqual(["Servers", "Models", "Features", "Settings", "Diagnostics"]);
	// A count inside the button would announce as "Servers & Models 4" - a
	// number with no noun - and the tabpanel inherits that name, so an item
	// carrying a count names itself in words (Label in Name still holds).
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
	expect(tab(root, "Settings").tabIndex).toBe(-1);
	expect(tab(root, "Diagnostics").tabIndex).toBe(-1);

	for (const section of ["overview", "models", "features", "settings", "diagnostics"]) {
		const pane = panel(root, section);
		expect(pane.getAttribute("role")).toBe("tabpanel");
		expect(pane.getAttribute("aria-labelledby")).toBe(`tab-${section}`);
		expect(pane.hidden).toBe(section !== "overview");
	}
});

test("servers and models are separate destinations, each holding only its own list", () => {
	// They are one workflow, but sharing a page cost more than it bought: a rail
	// item could count only one of its two nouns, and the models table needed a
	// height budget tuned against whatever chrome sat above it.
	const root = mountApp();
	const servers = panel(root, "overview");
	const models = panel(root, "models");
	expect(servers.querySelector("ul.server-list")).not.toBeNull();
	expect(servers.querySelector("ul.model-list")).toBeNull();
	expect(models.querySelector("#models-section ul.model-list")).not.toBeNull();
	expect(models.querySelector("ul.server-list")).toBeNull();
});

test("a server's model count navigates to Models filtered to that server", () => {
	// Across destinations the jump has to navigate, carry the filter, and move
	// focus, or Tab continues from a link on an invisible panel. The link lives
	// in the row's drawer: the row is a disclosure, and buttons cannot nest.
	const root = mountApp();
	clickCountLink(root, "Prod");
	expect(tab(root, "Models").getAttribute("aria-selected")).toBe("true");
	expect(panel(root, "models").hidden).toBe(false);
	// The scope chip names the server the reader came from.
	expect(panel(root, "models").textContent).toContain("Server: Prod");
});

test("with zero servers the guided start is the whole story, and Models says it has none", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	expect(panel(root, "overview").querySelector(".empty-start")).not.toBeNull();
	// The models destination still exists and says plainly that there is nothing
	// yet. With no servers it must not suggest a sync - the next step is adding
	// one. Scoped to the empty block: the section's help mentions Sync models.
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

test("the servers page renders the pushed usage snapshot's spend on its rows", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				servers: [makeDeclaredServer()],
				usage: makeUsage({ servers: [makeUsageServer({ label: "Prod", spend: 12.5, spentFraction: 0.25 })] }),
			})
		)
	);
	const overview = panel(root, "overview");
	expect(overview.hidden).toBe(false);
	expect(overview.querySelector(".spend-unit")).not.toBeNull();
	expect(overview.textContent).toContain("25%");
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

	// The retired "usage" id rides this same guard, and it is load-bearing: the
	// usage status bar item's command outlives a running webview, so a stale
	// deep link can still name the destination that no longer exists.
	pushToWebview({ kind: "focusSection", section: "usage" });
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
	expect(tab(root, "Features").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowDown");
	expect(tab(root, "Settings").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowDown");
	expect(tab(root, "Diagnostics").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowDown");
	expect(tab(root, "Servers").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowUp");
	expect(tab(root, "Diagnostics").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "Home");
	expect(tab(root, "Servers").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "End");
	expect(tab(root, "Diagnostics").getAttribute("aria-selected")).toBe("true");
});

test("section-local state survives a round trip through another tab", () => {
	const root = mountApp();
	// The filter belongs to Models, so the round trip has to go there and back.
	// Editing it from Servers and returning to Servers never leaves the panel
	// under test, so it would pass even if Models unmounted and lost its state.
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

	clickCountLink(root, "Staging");
	expect(visibleModelNames(root)).toEqual(["Charlie"]);
	// The jump moves the keyboard position with the viewport: focus lands on
	// the models section, so Tab continues into the filter and the table.
	expect(document.activeElement?.id).toBe("models-section");
	const chip = root.querySelector(".chip");
	expect((chip?.textContent ?? "").trim()).toContain("Server: Staging");
	// The scope moves the denominator, not the numerator: unfiltered, the
	// count would only read "1 of 1", so the header stays quiet.
	expect(root.textContent).not.toContain("showing");

	fireClick(chip?.querySelector("button[aria-label='Clear the server filter']") as HTMLElement);
	expect(root.querySelector(".chip")).toBeNull();
	expect(visibleModelNames(root)).toEqual(["Alpha", "Bravo", "Charlie"]);
});

test("the server scope and the text filter compose, and switching scope replaces the chip", () => {
	const root = mount(<App />);
	pushToWebview(statePush(scopedState()));

	clickCountLink(root, "Prod");
	const filter = root.querySelector("input[aria-label='Filter models']") as HTMLInputElement;
	fireInput(filter, "bra");
	expect(visibleModelNames(root)).toEqual(["Bravo"]);
	expect(root.textContent).toContain("showing 1 of 2");

	// A second count link retargets the one scope; the typed filter stays.
	clickCountLink(root, "Staging");
	expect(root.querySelectorAll(".chip").length).toBe(1);
	expect((root.querySelector(".chip")?.textContent ?? "").trim()).toContain("Server: Staging");
	expect(visibleModelNames(root)).toEqual([]);
	expect(root.textContent).toContain("No models match the filter.");
});

test("the scope clears itself when the scoped server leaves the list", () => {
	const root = mount(<App />);
	pushToWebview(statePush(scopedState()));
	clickCountLink(root, "Staging");
	expect(root.querySelector(".chip")).not.toBeNull();

	const remaining = makeState({
		servers: [makeDeclaredServer({ label: "Prod", servedModelCount: 2 })],
		models: [
			makeModel({ id: "gpt-a", name: "Alpha", serverLabel: "Prod" }),
			makeModel({ id: "gpt-b", name: "Bravo", serverLabel: "Prod" }),
		],
	});
	pushToWebview(statePush(remaining));
	expect(root.querySelector(".chip")).toBeNull();
	expect(visibleModelNames(root)).toEqual(["Alpha", "Bravo"]);
});

test("a zero model count renders as plain text in the drawer, not a scope link", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				servers: [makeDeclaredServer({ label: "Fresh", servedModelCount: 0 })],
				models: [],
			})
		)
	);
	// Open the row's drawer, where the count lives; an empty scoped list has
	// nothing to show, so the count stays words.
	fireClick(root.querySelector("#panel-overview button.server-line") as HTMLElement);
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
					makeDeclaredServer({ label: "Prod", servedModelCount: 60 }),
					makeDeclaredServer({ label: "Staging", baseUrl: "http://localhost:4001", servedModelCount: 60 }),
				],
				models,
			})
		)
	);

	// 120 rows exceed the windowing threshold; scroll deep into the list.
	const scrollport = root.querySelector(".table-scroll.windowed") as HTMLElement;
	void act(() => {
		scrollport.scrollTop = DEFAULT_ROW_HEIGHT * 100;
		scrollport.dispatchEvent(new Event("scroll"));
	});
	expect(visibleModelNames(root)).not.toContain("A 00");

	// The scope jump lands at the new list's first row, not at an inherited
	// scroll offset partway through it.
	clickCountLink(root, "Staging");
	expect(scrollport.scrollTop).toBe(0);
	expect(visibleModelNames(root)[0]).toBe("B 00");
});

test("arrow keys move focus with selection, and only the selected item is tabbable", () => {
	// The roving tabindex is the whole keyboard contract: exactly one stop in the
	// tab order, and the arrows move FOCUS rather than merely repainting
	// aria-selected, which a selection-only assertion would not catch.
	const root = mountApp();
	const tablist = root.querySelector("[role='tablist']") as HTMLElement;
	const tabIndexes = () => Array.from(root.querySelectorAll("[role='tab']")).map((t) => (t as HTMLElement).tabIndex);
	expect(tabIndexes()).toEqual([0, -1, -1, -1, -1]);

	fireKeyDown(tablist, "ArrowDown");
	expect(tabIndexes()).toEqual([-1, 0, -1, -1, -1]);
	expect(document.activeElement).toBe(tab(root, "Models"));

	fireKeyDown(tablist, "End");
	expect(tabIndexes()).toEqual([-1, -1, -1, -1, 0]);
	expect(document.activeElement).toBe(tab(root, "Diagnostics"));
});
