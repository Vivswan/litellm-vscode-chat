/**
 * The models table's interactive layer: column sorting (toggle, aria-sort,
 * absent values last), the windowed rendering past the row threshold with its
 * spacer arithmetic, and the per-row copy-ID action.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { DashboardModel } from "../../../../dashboard/viewModels";
import { ModelsSection } from "../../../../webview/dashboard/models";
import { makeModel } from "../fixtures";
import { cleanup, fireClick, fireInput, mount, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

function headerButton(root: ParentNode, label: string): HTMLButtonElement {
	const button = Array.from(root.querySelectorAll("th button.sort")).find(
		(candidate) => (candidate.textContent ?? "").trim() === label
	);
	if (button === undefined) {
		throw new Error(`no sortable header ${label}`);
	}
	return button as HTMLButtonElement;
}

function firstColumn(root: ParentNode): string[] {
	return Array.from(root.querySelectorAll("tbody tr:not(.spacer)")).map((row) =>
		(row.querySelector("td")?.textContent ?? "").trim()
	);
}

test("clicking a header sorts ascending, again descending, and aria-sort tracks the active column", () => {
	const models = [
		makeModel({ id: "b", name: "Bravo", maxInputTokens: 200 }),
		makeModel({ id: "c", name: "Charlie", maxInputTokens: 100 }),
		makeModel({ id: "a", name: "Alpha", maxInputTokens: 300 }),
	];
	const root = mount(<ModelsSection models={models} serverCount={1} onInspect={() => {}} />);
	expect(firstColumn(root)).toEqual(["Bravo", "Charlie", "Alpha"]);

	const modelHeader = headerButton(root, "Model");
	fireClick(modelHeader);
	expect(firstColumn(root)).toEqual(["Alpha", "Bravo", "Charlie"]);
	expect(modelHeader.closest("th")?.getAttribute("aria-sort")).toBe("ascending");

	fireClick(modelHeader);
	expect(firstColumn(root)).toEqual(["Charlie", "Bravo", "Alpha"]);
	expect(modelHeader.closest("th")?.getAttribute("aria-sort")).toBe("descending");

	// Switching columns starts ascending on the new column and clears the old aria-sort.
	fireClick(headerButton(root, "Input tokens"));
	expect(firstColumn(root)).toEqual(["Charlie", "Bravo", "Alpha"]);
	expect(modelHeader.closest("th")?.getAttribute("aria-sort")).toBeNull();
	expect(headerButton(root, "Input tokens").closest("th")?.getAttribute("aria-sort")).toBe("ascending");
});

test("models without a price sort last in both directions", () => {
	const models = [
		makeModel({ id: "free", name: "Unpriced" }),
		makeModel({ id: "cheap", name: "Cheap", inputCost: 1 }),
		makeModel({ id: "dear", name: "Dear", inputCost: 10 }),
	];
	const root = mount(<ModelsSection models={models} serverCount={1} onInspect={() => {}} />);
	const price = headerButton(root, "Pricing ($/M)");
	fireClick(price);
	expect(firstColumn(root)).toEqual(["Cheap", "Dear", "Unpriced"]);
	fireClick(price);
	expect(firstColumn(root)).toEqual(["Dear", "Cheap", "Unpriced"]);
});

function manyModels(count: number): DashboardModel[] {
	return Array.from({ length: count }, (_, index) =>
		makeModel({ id: `model-${String(index).padStart(3, "0")}`, name: `Model ${String(index).padStart(3, "0")}` })
	);
}

function scrollTo(container: HTMLElement, top: number): void {
	void act(() => {
		container.scrollTop = top;
		container.dispatchEvent(new Event("scroll"));
	});
}

test("past the threshold the table windows: spacers stand in for off-screen rows and scrolling moves the window", () => {
	const root = mount(<ModelsSection models={manyModels(200)} serverCount={1} onInspect={() => {}} />);
	const container = root.querySelector(".table-scroll") as HTMLElement;
	expect(container.classList.contains("windowed")).toBe(true);

	const rendered = firstColumn(root);
	expect(rendered.length).toBeLessThan(200);
	expect(rendered[0]).toBe("Model 000");
	// Only the trailing spacer at the top of the list; spacers are layout
	// filler and stay out of the accessibility tree.
	expect(root.querySelectorAll("tbody tr.spacer").length).toBe(1);
	expect(root.querySelector("tbody tr.spacer")?.getAttribute("role")).toBe("presentation");

	scrollTo(container, 26 * 100);
	const scrolled = firstColumn(root);
	expect(scrolled).not.toContain("Model 000");
	expect(scrolled).toContain("Model 100");
	expect(root.querySelectorAll("tbody tr.spacer").length).toBe(2);

	// The boundary: scrolled to the very end, the last row renders and only
	// the leading spacer remains.
	scrollTo(container, 26 * 200);
	const atEnd = firstColumn(root);
	expect(atEnd[atEnd.length - 1]).toBe("Model 199");
	expect(root.querySelectorAll("tbody tr.spacer").length).toBe(1);
});

test("sorting while scrolled deep re-fills the window from the new order without leaving range", () => {
	const root = mount(<ModelsSection models={manyModels(200)} serverCount={1} onInspect={() => {}} />);
	const container = root.querySelector(".table-scroll") as HTMLElement;
	scrollTo(container, 26 * 150);
	expect(firstColumn(root)).toContain("Model 150");

	// Descending by name: the window at the same scroll offset now shows the
	// reversed order's slice, still fully in range with both spacers.
	fireClick(headerButton(root, "Model"));
	fireClick(headerButton(root, "Model"));
	const rows = firstColumn(root);
	expect(rows.length).toBeGreaterThan(0);
	const sortedDesc = [...rows].sort().reverse();
	expect(rows).toEqual(sortedDesc);
	// scrollTop 150*26 with 200 rows: the window sits mid-list, spacers on both sides.
	expect(root.querySelectorAll("tbody tr.spacer").length).toBe(2);
	expect(rows).toContain("Model 059"); // 200 - 1 - 140 = 59: the descending row near index 140
});

test("a filter that shrinks the list under a deep scroll clamps the window back into range", () => {
	const root = mount(<ModelsSection models={manyModels(200)} serverCount={1} onInspect={() => {}} />);
	const container = root.querySelector(".table-scroll") as HTMLElement;
	scrollTo(container, 26 * 150);

	fireInput(root.querySelector("input[aria-label='Filter models']") as HTMLInputElement, "Model 00");
	// 10 matches (000..009): below the threshold, all render, no spacers.
	expect(firstColumn(root).length).toBe(10);
	expect(root.querySelectorAll("tbody tr.spacer").length).toBe(0);
});

test("under the threshold every row renders with no scrollport", () => {
	const root = mount(<ModelsSection models={manyModels(50)} serverCount={1} onInspect={() => {}} />);
	expect(firstColumn(root).length).toBe(50);
	expect((root.querySelector(".table-scroll") as HTMLElement).classList.contains("windowed")).toBe(false);
	expect(root.querySelectorAll("tbody tr.spacer").length).toBe(0);
});

test("the copy button lives inside the model-name cell; the trailing column holds only the Inspect action", () => {
	// The copy action moved from a trailing actions column into the first
	// cell, beside the name it copies; the header row and every data row must
	// agree on the column set, with the quiet Inspect action as the last column.
	const root = mount(
		<ModelsSection models={[makeModel({ id: "gpt-4o", name: "Omni" })]} serverCount={1} onInspect={() => {}} />
	);
	const headers = Array.from(root.querySelectorAll("thead th")).map((th) => (th.textContent ?? "").trim());
	expect(headers).toEqual(["Model", "Family", "Input tokens", "Output tokens", "Pricing ($/M)", "Capabilities", ""]);

	const row = root.querySelector("tbody tr") as HTMLElement;
	const cells = Array.from(row.querySelectorAll("td"));
	expect(cells.length).toBe(headers.length);
	const nameCell = cells[0] as HTMLElement;
	expect(nameCell.classList.contains("model-name")).toBe(true);
	expect(nameCell.textContent).toContain("Omni");
	// The name renders inside the ellipsis-capped span the stylesheet trims;
	// the full text stays in the DOM.
	expect(nameCell.querySelector(".model-name-text")?.textContent).toBe("Omni");
	expect(nameCell.querySelector("button[aria-label='Copy model ID gpt-4o from Prod']")).not.toBeNull();
	// The last cell carries the ONE Inspect action (the merged panel's only
	// entry point); copy and Inspect are the row's only controls.
	const lastCell = cells[cells.length - 1] as HTMLElement;
	expect(lastCell.classList.contains("actions")).toBe(true);
	expect(lastCell.querySelectorAll("button.params-action").length).toBe(1);
	expect(row.querySelectorAll("button").length).toBe(2);
});

test("the hideable columns carry their col- classes on header and cells, and the Inspect action is not hover-revealed", () => {
	// The narrow-viewport media queries drop whole columns by these classes;
	// a th/td that loses its class silently reopens the horizontal-scroll
	// dead zones. Both the 7- and 8-column layouts (without and with the
	// Server column) must stay wired.
	for (const serverCount of [1, 2]) {
		const root = mount(<ModelsSection models={[makeModel()]} serverCount={serverCount} onInspect={() => {}} />);
		for (const col of ["col-family", "col-input", "col-output", "col-price", "col-caps"]) {
			expect(root.querySelectorAll(`thead th.${col}`).length).toBe(1);
			expect(root.querySelectorAll(`tbody td.${col}`).length).toBe(1);
		}
		// The Inspect action is the inspector's only entry point: it must not
		// ride the hover-revealed icon-action styling the copy button uses.
		const params = root.querySelector("button.params-action") as HTMLElement;
		expect(params.classList.contains("icon-action")).toBe(false);
		cleanup();
	}
});

test("spacer colSpan tracks the rendered column count with and without the Server column", () => {
	// The spacer's one cell must span every rendered column or the table's
	// layout shears; the count changes with the Server column, so both sides
	// of serverCount > 1 are pinned. 51 rows is one past the 50-row
	// threshold - together with the 50-row full-render test above this pins
	// the boundary exactly - and windowing brings the trailing spacer with it.
	const spacerCell = (root: HTMLElement) => root.querySelector("tbody tr.spacer td") as HTMLTableCellElement;

	const single = mount(<ModelsSection models={manyModels(51)} serverCount={1} onInspect={() => {}} />);
	expect((single.querySelector(".table-scroll") as HTMLElement).classList.contains("windowed")).toBe(true);
	expect(single.querySelectorAll("thead th").length).toBe(7);
	expect(spacerCell(single).colSpan).toBe(7);

	const dual = mount(<ModelsSection models={manyModels(51)} serverCount={2} onInspect={() => {}} />);
	expect(dual.querySelectorAll("thead th").length).toBe(8);
	expect(spacerCell(dual).colSpan).toBe(8);
});

test("the row's copy action writes the model ID to the clipboard and flashes a check", async () => {
	const written: string[] = [];
	const clipboard = {
		writeText: (text: string) => {
			written.push(text);
			return Promise.resolve();
		},
	};
	Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });

	const root = mount(
		<ModelsSection models={[makeModel({ id: "gpt-4o", name: "Omni" })]} serverCount={1} onInspect={() => {}} />
	);
	const copy = root.querySelector("button[aria-label='Copy model ID gpt-4o from Prod']") as HTMLButtonElement;
	expect(copy).not.toBeNull();
	fireClick(copy);
	expect(written).toEqual(["gpt-4o"]);
});

test("one raw model ID on two servers renders two rows with distinct accessible names, and the copy flash hits only the clicked row", () => {
	// The same model registered through two groups is two rows; the aria-label
	// carries the server so the two copy buttons stay distinguishable, and the
	// check-mark feedback is keyed by server AND id, so the sibling row's
	// button stays a copy icon.
	const models = [
		makeModel({ id: "gpt-4o", name: "Omni", serverLabel: "Prod" }),
		makeModel({ id: "gpt-4o", name: "Omni", serverLabel: "Staging" }),
	];
	const root = mount(<ModelsSection models={models} serverCount={2} onInspect={() => {}} />);
	const button = (server: string) =>
		root.querySelector(`button[aria-label='Copy model ID gpt-4o from ${server}']`) as HTMLButtonElement;
	expect(button("Prod")).not.toBeNull();
	expect(button("Staging")).not.toBeNull();

	fireClick(button("Prod"));
	const iconPath = (server: string) => button(server).querySelector("svg path")?.getAttribute("d") ?? "";
	expect(iconPath("Prod")).not.toBe(iconPath("Staging"));
});

test("the windowed scrollport publishes its own page offset, re-measured, so its height is never guessed", () => {
	// The cap used to be calc(100vh - 11em): a guess at how much chrome sat above
	// this element, tuned against the page it shared and inherited unchanged when
	// models became a destination of its own. The stylesheet reads a custom
	// property now, and this pins the half that JavaScript owns.
	const root = mount(<ModelsSection models={manyModels(60)} serverCount={1} onInspect={() => {}} />);
	const scrollport = root.querySelector(".table-scroll.windowed") as HTMLElement;
	expect(scrollport).not.toBeNull();

	// happy-dom reports every rect as zero, which is exactly the shape an
	// element that is not rendered has - every tab panel stays mounted while
	// hidden, so a zero box means "no answer yet", not "the top of the page".
	// Publishing it would cap the scrollport at nearly the whole viewport until
	// something re-measured.
	expect(scrollport.style.getPropertyValue("--models-scroll-top")).toBe("");

	const scrollYDescriptor = Object.getOwnPropertyDescriptor(window, "scrollY");
	try {
		scrollport.getBoundingClientRect = () => ({ top: 90, width: 800, height: 500 }) as DOMRect;
		Object.defineProperty(window, "scrollY", { value: 22, configurable: true });
		window.dispatchEvent(new Event("resize"));

		// 90 + 22: the published distance adds the scroll offset back, so it names
		// the same distance at every scroll position. A viewport-relative top
		// would shrink as the page scrolls, raising the cap, lengthening the page
		// and allowing more scroll - a number that climbs on every republish
		// instead of settling on the height at which the page stops scrolling.
		expect(scrollport.style.getPropertyValue("--models-scroll-top")).toBe("112px");

		// And it keeps following: the chrome above this element reflows at the
		// container breakpoints, so a value measured once would go stale.
		scrollport.getBoundingClientRect = () => ({ top: 40, width: 800, height: 500 }) as DOMRect;
		window.dispatchEvent(new Event("resize"));
		expect(scrollport.style.getPropertyValue("--models-scroll-top")).toBe("62px");
	} finally {
		if (scrollYDescriptor !== undefined) {
			Object.defineProperty(window, "scrollY", scrollYDescriptor);
		}
	}
});
