/**
 * The section tab bar and the combined Servers & Models view: WAI-ARIA tabs
 * wiring, click and keyboard switching, the kept-mounted panels (an open
 * filter or form must survive a visit to another section, so inactive panels
 * hide instead of unmounting), and the bridge between the two halves of the
 * combined tab - a server row's model count scoping the models list.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "preact/test-utils";
import { App } from "../../../webview/dashboard/app";
import { makeDeclaredServer, makeModel, makeState, makeUsage, makeUsageServer, statePush } from "../fixtures";
import { cleanup, fireClick, fireInput, fireKeyDown, mount, pushToWebview, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

function tab(root: ParentNode, name: string): HTMLButtonElement {
	const found = Array.from(root.querySelectorAll("[role='tab']")).find(
		(candidate) => (candidate.textContent ?? "").trim() === name
	);
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
				servers: [makeDeclaredServer()],
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

test("four tabs render without count badges, the combined view selected by default, and panels wired by aria", () => {
	const root = mountApp();
	const tabs = Array.from(root.querySelectorAll("[role='tab']"));
	expect(tabs.map((t) => (t.textContent ?? "").trim())).toEqual([
		"Servers & Models",
		"Usage",
		"Settings",
		"Diagnostics",
	]);
	// No count badges on the tabs: the hero directly above carries the server
	// and model totals, so the tab labels stay plain text.
	expect(root.querySelectorAll(".tabs .count").length).toBe(0);
	for (const t of tabs) {
		expect(t.hasAttribute("aria-label")).toBe(false);
	}

	const overview = tab(root, "Servers & Models");
	expect(overview.getAttribute("aria-selected")).toBe("true");
	expect(overview.tabIndex).toBe(0);
	expect(tab(root, "Usage").tabIndex).toBe(-1);
	expect(tab(root, "Settings").tabIndex).toBe(-1);
	expect(tab(root, "Diagnostics").tabIndex).toBe(-1);

	for (const section of ["overview", "usage", "settings", "diagnostics"]) {
		const pane = panel(root, section);
		expect(pane.getAttribute("role")).toBe("tabpanel");
		expect(pane.getAttribute("aria-labelledby")).toBe(`tab-${section}`);
		expect(pane.hidden).toBe(section !== "overview");
	}
});

test("the combined tab renders the servers section above the models section in one panel", () => {
	const root = mountApp();
	const overview = panel(root, "overview");
	const headings = Array.from(overview.querySelectorAll("h2")).map((h) => (h.textContent ?? "").trim());
	// Both section headings (with their help glyphs) live in the one panel,
	// servers first because setup starts there.
	expect(headings[0]).toContain("Servers");
	expect(headings[1]).toContain("Models");
	expect(overview.querySelector("table.servers")).not.toBeNull();
	expect(overview.querySelector("#models-section table.models")).not.toBeNull();
});

test("with zero servers the guided start is the combined tab's whole story: the models section folds away", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const overview = panel(root, "overview");
	expect(overview.querySelector(".empty-start")).not.toBeNull();
	expect(overview.querySelector("#models-section")).toBeNull();
	expect(root.textContent).not.toContain("No models discovered yet.");
});

test("clicking a tab switches the visible panel and aria-selected follows", () => {
	const root = mountApp();
	fireClick(tab(root, "Settings"));
	expect(panel(root, "settings").hidden).toBe(false);
	expect(panel(root, "overview").hidden).toBe(true);
	expect(tab(root, "Settings").getAttribute("aria-selected")).toBe("true");
	expect(tab(root, "Servers & Models").getAttribute("aria-selected")).toBe("false");

	fireClick(tab(root, "Servers & Models"));
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
	expect(usagePanel.querySelector(".usage-card")).not.toBeNull();
	expect(usagePanel.textContent).toContain("Prod");
});

test("a focusSection push switches the active tab: the litellm.showDiagnostics deep link", () => {
	const root = mountApp();
	pushToWebview({ type: "focusSection", section: "diagnostics" });

	expect(panel(root, "diagnostics").hidden).toBe(false);
	expect(panel(root, "overview").hidden).toBe(true);
	expect(tab(root, "Diagnostics").getAttribute("aria-selected")).toBe("true");
});

test("a focusSection push naming an unknown section is dropped instead of blanking every panel", () => {
	const root = mountApp();
	pushToWebview({ type: "focusSection", section: "definitely-not-a-section" });

	expect(panel(root, "overview").hidden).toBe(false);
	expect(tab(root, "Servers & Models").getAttribute("aria-selected")).toBe("true");
});

test("arrow keys move selection with wrap-around; Home and End jump", () => {
	const root = mountApp();
	const tablist = root.querySelector("[role='tablist']") as HTMLElement;

	fireKeyDown(tablist, "ArrowRight");
	expect(tab(root, "Usage").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowRight");
	expect(tab(root, "Settings").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowRight");
	expect(tab(root, "Diagnostics").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowRight");
	expect(tab(root, "Servers & Models").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowLeft");
	expect(tab(root, "Diagnostics").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "Home");
	expect(tab(root, "Servers & Models").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "End");
	expect(tab(root, "Diagnostics").getAttribute("aria-selected")).toBe("true");
});

test("section-local state survives a round trip through another tab", () => {
	const root = mountApp();
	const filter = root.querySelector("input[aria-label='Filter models']") as HTMLInputElement;
	fireInput(filter, "second");
	expect(root.textContent).toContain("showing 1 of 2");

	fireClick(tab(root, "Settings"));
	fireClick(tab(root, "Servers & Models"));
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
