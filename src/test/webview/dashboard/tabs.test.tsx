/**
 * The section tab bar: WAI-ARIA tabs wiring, click and keyboard switching,
 * and the kept-mounted panels (an open filter or form must survive a visit
 * to another section, so inactive panels hide instead of unmounting).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { App } from "../../../webview/dashboard/app";
import { makeDeclaredServer, makeModel, makeState, statePush } from "../fixtures";
import { cleanup, fireClick, fireInput, fireKeyDown, mount, pushToWebview, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

function tab(root: ParentNode, name: string): HTMLButtonElement {
	const found = Array.from(root.querySelectorAll("[role='tab']")).find((candidate) =>
		(candidate.textContent ?? "").trim().startsWith(name)
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

test("three tabs render with counts, servers selected by default, and panels wired by aria", () => {
	const root = mountApp();
	const tabs = Array.from(root.querySelectorAll("[role='tab']"));
	// The accessible name separates label and count ("Servers (1)", not the
	// visual concatenation "Servers1"), and the count badge stays visual-only.
	expect(tabs.map((t) => t.getAttribute("aria-label"))).toEqual(["Servers (1)", "Models (2)", "Settings"]);
	for (const t of tabs) {
		expect(t.querySelector(".count")?.getAttribute("aria-hidden") ?? "true").toBe("true");
	}

	const servers = tab(root, "Servers");
	expect(servers.getAttribute("aria-selected")).toBe("true");
	expect(servers.tabIndex).toBe(0);
	expect(tab(root, "Models").tabIndex).toBe(-1);

	for (const section of ["servers", "models", "settings"]) {
		const pane = panel(root, section);
		expect(pane.getAttribute("role")).toBe("tabpanel");
		expect(pane.getAttribute("aria-labelledby")).toBe(`tab-${section}`);
		expect(pane.hidden).toBe(section !== "servers");
	}
});

test("clicking a tab switches the visible panel and aria-selected follows", () => {
	const root = mountApp();
	fireClick(tab(root, "Models"));
	expect(panel(root, "models").hidden).toBe(false);
	expect(panel(root, "servers").hidden).toBe(true);
	expect(tab(root, "Models").getAttribute("aria-selected")).toBe("true");
	expect(tab(root, "Servers").getAttribute("aria-selected")).toBe("false");

	fireClick(tab(root, "Settings"));
	expect(panel(root, "settings").hidden).toBe(false);
	expect(panel(root, "models").hidden).toBe(true);
});

test("arrow keys move selection with wrap-around; Home and End jump", () => {
	const root = mountApp();
	const tablist = root.querySelector("[role='tablist']") as HTMLElement;

	fireKeyDown(tablist, "ArrowRight");
	expect(tab(root, "Models").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowRight");
	expect(tab(root, "Settings").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowRight");
	expect(tab(root, "Servers").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "ArrowLeft");
	expect(tab(root, "Settings").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "Home");
	expect(tab(root, "Servers").getAttribute("aria-selected")).toBe("true");
	fireKeyDown(tablist, "End");
	expect(tab(root, "Settings").getAttribute("aria-selected")).toBe("true");
});

test("section-local state survives a round trip through another tab", () => {
	const root = mountApp();
	fireClick(tab(root, "Models"));
	const filter = root.querySelector("input[aria-label='Filter models']") as HTMLInputElement;
	fireInput(filter, "second");
	expect(root.textContent).toContain("showing 1 of 2");

	fireClick(tab(root, "Settings"));
	fireClick(tab(root, "Models"));
	const restored = root.querySelector("input[aria-label='Filter models']") as HTMLInputElement;
	expect(restored.value).toBe("second");
	expect(root.textContent).toContain("showing 1 of 2");
});

test("controls inside an inactive panel sit under a hidden ancestor, out of the Tab order", () => {
	const root = mountApp();
	fireClick(tab(root, "Models"));

	// hidden => display:none => unfocusable; this is the property that keeps
	// background panels Tab-unreachable, so pin it on a real control.
	const addServer = Array.from(root.querySelectorAll("button")).find(
		(b) => (b.textContent ?? "").trim() === "Add server"
	);
	expect(addServer).toBeDefined();
	expect(addServer?.closest("[hidden]")).not.toBeNull();

	// The active panel's controls have no hidden ancestor.
	const filter = root.querySelector("input[aria-label='Filter models']");
	expect(filter?.closest("[hidden]")).toBeNull();
});
