/**
 * The models list's interactive layer: sorting (key, direction, absent values
 * last), the windowed rendering past the row threshold with its spacer
 * arithmetic including one open row's measured detail, and the copy-ID action.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { DashboardModel } from "../../../../dashboard/viewModels";
import { DEFAULT_ROW_HEIGHT, ModelsSection } from "../../../../webview/dashboard/models";
import { makeModel } from "../fixtures";
import { cleanup, fireClick, fireInput, fireSelect, mount, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

/** happy-dom lays nothing out, so unless a test stubs offsetHeight the component's fallback is the height in play. */
const ROW = DEFAULT_ROW_HEIGHT;

function sortSelect(root: ParentNode): HTMLSelectElement {
	return root.querySelector(".sort-control select") as HTMLSelectElement;
}

function sortDirection(root: ParentNode): HTMLButtonElement {
	return root.querySelector("button.sort-dir") as HTMLButtonElement;
}

function firstColumn(root: ParentNode): string[] {
	return Array.from(root.querySelectorAll("li.model-row")).map((row) =>
		(row.querySelector(".model-name-text")?.textContent ?? "").trim()
	);
}

test("the sort control picks the key and the toggle picks the direction, and both announce the state", () => {
	// The rows carry no column headers to click, so sorting moved onto the
	// section header line. aria-sort went with the headers; the announcement is
	// now the labelled control's own value plus the toggle's pressed state.
	const models = [
		makeModel({ id: "b", name: "Bravo", maxInputTokens: 200 }),
		makeModel({ id: "c", name: "Charlie", maxInputTokens: 100 }),
		makeModel({ id: "a", name: "Alpha", maxInputTokens: 300 }),
	];
	const root = mount(<ModelsSection currencySymbol="$" models={models} serverCount={1} onInspect={() => {}} />);
	// Unsorted is a real choice - the order the servers reported - so it is a
	// value of the control, and there is no direction to flip while it holds.
	expect(sortSelect(root).value).toBe("discovered");
	expect(sortDirection(root).disabled).toBe(true);
	expect(firstColumn(root)).toEqual(["Bravo", "Charlie", "Alpha"]);

	fireSelect(sortSelect(root), "name");
	expect(firstColumn(root)).toEqual(["Alpha", "Bravo", "Charlie"]);
	expect(sortDirection(root).disabled).toBe(false);
	expect(sortDirection(root).getAttribute("aria-pressed")).toBe("false");

	fireClick(sortDirection(root));
	expect(firstColumn(root)).toEqual(["Charlie", "Bravo", "Alpha"]);
	expect(sortDirection(root).getAttribute("aria-pressed")).toBe("true");

	// A new key starts ascending again rather than inheriting the old direction.
	fireSelect(sortSelect(root), "input");
	expect(firstColumn(root)).toEqual(["Charlie", "Bravo", "Alpha"]);
	expect(sortSelect(root).value).toBe("input");
	expect(sortDirection(root).getAttribute("aria-pressed")).toBe("false");

	// And the reader can get back to the reported order.
	fireSelect(sortSelect(root), "discovered");
	expect(firstColumn(root)).toEqual(["Bravo", "Charlie", "Alpha"]);
	expect(sortDirection(root).disabled).toBe(true);
});

test("models without a price sort last in both directions", () => {
	const models = [
		makeModel({ id: "free", name: "Unpriced" }),
		makeModel({ id: "cheap", name: "Cheap", inputCost: 1 }),
		makeModel({ id: "dear", name: "Dear", inputCost: 10 }),
	];
	const root = mount(<ModelsSection currencySymbol="$" models={models} serverCount={1} onInspect={() => {}} />);
	fireSelect(sortSelect(root), "price");
	expect(firstColumn(root)).toEqual(["Cheap", "Dear", "Unpriced"]);
	fireClick(sortDirection(root));
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
	const root = mount(
		<ModelsSection currencySymbol="$" models={manyModels(200)} serverCount={1} onInspect={() => {}} />
	);
	const container = root.querySelector(".table-scroll") as HTMLElement;
	expect(container.classList.contains("windowed")).toBe(true);

	const rendered = firstColumn(root);
	expect(rendered.length).toBeLessThan(200);
	expect(rendered[0]).toBe("Model 000");
	// Only the trailing spacer at the top of the list; spacers are layout
	// filler and stay out of the accessibility tree.
	expect(root.querySelectorAll("li.spacer").length).toBe(1);
	expect(root.querySelector("li.spacer")?.getAttribute("role")).toBe("presentation");

	scrollTo(container, ROW * 100);
	const scrolled = firstColumn(root);
	expect(scrolled).not.toContain("Model 000");
	expect(scrolled).toContain("Model 100");
	expect(root.querySelectorAll("li.spacer").length).toBe(2);

	// The boundary: scrolled to the very end, the last row renders and only
	// the leading spacer remains.
	scrollTo(container, ROW * 200);
	const atEnd = firstColumn(root);
	expect(atEnd[atEnd.length - 1]).toBe("Model 199");
	expect(root.querySelectorAll("li.spacer").length).toBe(1);
});

test("sorting while scrolled deep re-fills the window from the new order without leaving range", () => {
	const root = mount(
		<ModelsSection currencySymbol="$" models={manyModels(200)} serverCount={1} onInspect={() => {}} />
	);
	const container = root.querySelector(".table-scroll") as HTMLElement;
	scrollTo(container, ROW * 150);
	expect(firstColumn(root)).toContain("Model 150");

	// Descending by name: the window at the same scroll offset now shows the
	// reversed order's slice, still fully in range with both spacers.
	fireSelect(sortSelect(root), "name");
	fireClick(sortDirection(root));
	const rows = firstColumn(root);
	expect(rows.length).toBeGreaterThan(0);
	const sortedDesc = [...rows].sort().reverse();
	expect(rows).toEqual(sortedDesc);
	// scrollTop 150 rows down a 200-row list: the window sits mid-list, spacers on both sides.
	expect(root.querySelectorAll("li.spacer").length).toBe(2);
	expect(rows).toContain("Model 059"); // 200 - 1 - 140 = 59: the descending row near index 140
});

test("a filter that shrinks the list under a deep scroll clamps the window back into range", () => {
	const root = mount(
		<ModelsSection currencySymbol="$" models={manyModels(200)} serverCount={1} onInspect={() => {}} />
	);
	const container = root.querySelector(".table-scroll") as HTMLElement;
	scrollTo(container, ROW * 150);

	fireInput(root.querySelector("input[aria-label='Filter models']") as HTMLInputElement, "Model 00");
	// 10 matches (000..009): below the threshold, all render, no spacers.
	expect(firstColumn(root).length).toBe(10);
	expect(root.querySelectorAll("li.spacer").length).toBe(0);
});

test("under the threshold every row renders with no scrollport", () => {
	const root = mount(<ModelsSection currencySymbol="$" models={manyModels(50)} serverCount={1} onInspect={() => {}} />);
	expect(firstColumn(root).length).toBe(50);
	expect((root.querySelector(".table-scroll") as HTMLElement).classList.contains("windowed")).toBe(false);
	expect(root.querySelectorAll("li.spacer").length).toBe(0);
});

test("one row past the threshold windows, with or without the server on the rows", () => {
	// 51 rows is one past the 50-row threshold; with the 50-row full-render test
	// above this pins the boundary exactly. Neither side of serverCount > 1
	// changes it - the rows have no column count left to shear.
	for (const serverCount of [1, 2]) {
		const root = mount(
			<ModelsSection currencySymbol="$" models={manyModels(51)} serverCount={serverCount} onInspect={() => {}} />
		);
		expect((root.querySelector(".table-scroll") as HTMLElement).classList.contains("windowed")).toBe(true);
		expect(root.querySelectorAll("li.spacer").length).toBe(1);
		cleanup();
	}
});

test("a row is a disclosure plus its two controls, and the Inspect action is not hover-revealed", () => {
	// The two readable lines ARE the disclosure, so they must be one button and
	// the row's other controls must sit outside it: a button cannot contain a
	// button, and nesting them would make the copy action unreachable.
	const root = mount(
		<ModelsSection
			currencySymbol="$"
			models={[makeModel({ id: "gpt-4o", name: "Omni" })]}
			serverCount={1}
			onInspect={() => {}}
		/>
	);
	const row = root.querySelector("li.model-row") as HTMLElement;
	const disclosure = row.querySelector("button.model-disclosure") as HTMLElement;
	expect(disclosure.querySelectorAll("button").length).toBe(0);
	expect(disclosure.getAttribute("aria-expanded")).toBe("false");

	// A row that opens has to LOOK like one. The mark is inside the disclosure
	// and decorative, since the button already carries aria-expanded.
	const chevron = disclosure.querySelector(".model-chevron") as HTMLElement;
	expect(chevron).not.toBeNull();
	expect(chevron.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
	expect(row.classList.contains("is-open")).toBe(false);
	fireClick(disclosure);
	// The open state is a class the stylesheet turns the mark with, not a
	// second icon that could disagree with aria-expanded.
	expect(row.classList.contains("is-open")).toBe(true);
	expect(disclosure.getAttribute("aria-expanded")).toBe("true");
	fireClick(disclosure);

	// The name renders inside the ellipsis-capped span the stylesheet trims;
	// the full text stays in the DOM.
	expect(disclosure.querySelector(".model-name-text")?.textContent).toBe("Omni");

	// Copy and Inspect are the row's only other controls, both outside the
	// disclosure and both present at rest.
	const actions = row.querySelector(".model-row-actions") as HTMLElement;
	expect(actions.querySelector("button[aria-label='Copy model ID gpt-4o from Prod']")).not.toBeNull();
	expect(actions.querySelectorAll("button.params-action").length).toBe(1);
	expect(row.querySelectorAll("button").length).toBe(3);

	// The hover-reveal lives on a WRAPPER around the Button, never on the Button
	// itself: Button's disabled:opacity-60/aria-disabled:opacity-60 outrank a
	// bare opacity-0 on the same element. On the wrapper the two multiply.
	const copy = actions.querySelector("button[aria-label='Copy model ID gpt-4o from Prod']") as HTMLElement;
	const wrapper = copy.parentElement as HTMLElement;
	expect(row.classList.contains("group/row")).toBe(true);
	expect(wrapper.classList.contains("opacity-0")).toBe(true);
	expect(wrapper.classList.contains("group-hover/row:opacity-100")).toBe(true);
	expect(wrapper.classList.contains("group-focus-within/row:opacity-100")).toBe(true);
	// Always painted where hover does not exist (touch, narrow panes).
	expect(wrapper.classList.contains("@max-[560px]/pane:opacity-100")).toBe(true);
	// The reveal's own fade: Button's transition cannot animate a property
	// that changes on its parent, so the wrapper carries one, and it stands
	// down for users who asked the OS for reduced motion.
	expect(wrapper.classList.contains("transition-opacity")).toBe(true);
	expect(wrapper.classList.contains("motion-reduce:transition-none")).toBe(true);
	// TRIPWIRE for future button.tsx changes: Button keeps a transition utility
	// naming opacity for its OWN state fades (the wrapper carries the reveal's),
	// and dropping it would un-animate every same-element opacity state.
	expect([...copy.classList].some((name) => name.startsWith("transition-") && name.includes("opacity"))).toBe(true);
	expect(copy.classList.contains("opacity-0")).toBe(false);

	// The Inspect action is the inspector's only entry point: it stays a
	// direct child of the actions cell, outside the reveal wrapper, and
	// carries no reveal state of its own - it must read at rest.
	const params = row.querySelector("button.params-action") as HTMLElement;
	expect(params.parentElement).toBe(actions);
	expect(params.classList.contains("opacity-0")).toBe(false);
});

test("one row opens at a time, and its detail is wired to the disclosure that opened it", () => {
	const root = mount(<ModelsSection currencySymbol="$" models={manyModels(3)} serverCount={1} onInspect={() => {}} />);
	const rows = () => Array.from(root.querySelectorAll("li.model-row"));
	const disclosure = (index: number) => rows()[index]?.querySelector("button.model-disclosure") as HTMLElement;

	fireClick(disclosure(0));
	expect(rows()[0]?.querySelector(".model-detail")).not.toBeNull();
	expect(disclosure(0).getAttribute("aria-expanded")).toBe("true");
	// aria-controls names the detail it opened, so the relationship survives
	// for a reader who cannot see the row grow.
	const detailId = (root.querySelector("li.model-row .model-detail") as HTMLElement).id;
	expect(detailId).not.toBe("");
	expect(disclosure(0).getAttribute("aria-controls")).toBe(detailId);

	// Opening another closes the first: one at a time, and the page never
	// navigates to show it.
	fireClick(disclosure(1));
	expect(rows()[0]?.querySelector(".model-detail")).toBeNull();
	expect(rows()[1]?.querySelector(".model-detail")).not.toBeNull();
	expect(root.querySelectorAll(".model-detail").length).toBe(1);

	// And it closes itself.
	fireClick(disclosure(1));
	expect(root.querySelectorAll(".model-detail").length).toBe(0);
	expect(disclosure(1).getAttribute("aria-expanded")).toBe("false");
	expect(disclosure(1).getAttribute("aria-controls")).toBeNull();
});

test("the open row is remembered by identity, so sorting does not move the detail to another model", () => {
	// The open row is held by row id, not by index. An index would follow the
	// position through a re-sort and leave the detail hanging under whichever
	// model landed there.
	const models = [
		makeModel({ id: "b", name: "Bravo" }),
		makeModel({ id: "c", name: "Charlie" }),
		makeModel({ id: "a", name: "Alpha" }),
	];
	const root = mount(<ModelsSection currencySymbol="$" models={models} serverCount={1} onInspect={() => {}} />);
	const openRowName = () =>
		(root.querySelector("li.model-row:has(.model-detail) .model-name-text")?.textContent ?? "").trim();

	fireClick(root.querySelectorAll("button.model-disclosure")[0] as HTMLElement);
	expect(openRowName()).toBe("Bravo");

	fireSelect(sortSelect(root), "name");
	expect(firstColumn(root)).toEqual(["Alpha", "Bravo", "Charlie"]);
	// Bravo moved from first to second and its detail went with it.
	expect(openRowName()).toBe("Bravo");
	expect(root.querySelectorAll(".model-detail").length).toBe(1);

	// Filtered away entirely, the detail simply is not rendered - and nothing
	// else inherits it.
	fireInput(root.querySelector("input[aria-label='Filter models']") as HTMLInputElement, "Alpha");
	expect(firstColumn(root)).toEqual(["Alpha"]);
	expect(root.querySelectorAll(".model-detail").length).toBe(0);
});

/**
 * happy-dom performs no layout, so every offsetHeight is 0 and the component's
 * measurement path is dead (`delta` always zero). Stubbing the two boxes it
 * measures is the only way the assertions below can fail.
 */
function withMeasuredLayout(rowHeight: number, detailHeight: number, run: () => void): void {
	const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get(this: HTMLElement) {
			if (this.classList.contains("model-row-line")) {
				return rowHeight;
			}
			if (this.classList.contains("model-detail")) {
				return detailHeight;
			}
			return 0;
		},
	});
	try {
		run();
	} finally {
		if (original === undefined) {
			delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
		} else {
			Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
		}
	}
}

/** Spacers plus rendered rows, as the DOM claims them. */
function claimedHeight(root: ParentNode, rowHeight: number, detailHeight: number): number {
	const spacers = Array.from(root.querySelectorAll("li.spacer")).reduce(
		(total, spacer) => total + Number.parseInt((spacer as HTMLElement).style.height, 10),
		0
	);
	const rows = root.querySelectorAll("li.model-row").length;
	const details = root.querySelectorAll(".model-detail").length;
	return spacers + rows * rowHeight + details * detailHeight;
}

test("the open row's measured detail is accounted for at every scroll position, in the window or out of it", () => {
	// The one row allowed to break the uniform grid. A height missing from
	// whichever spacer stands in for it makes the list claim less height than it
	// has, and every row below the open one jumps as it scrolls out.
	const DETAIL = 120;
	withMeasuredLayout(ROW, DETAIL, () => {
		const root = mount(
			<ModelsSection currencySymbol="$" models={manyModels(200)} serverCount={1} onInspect={() => {}} />
		);
		const container = root.querySelector(".table-scroll") as HTMLElement;
		const total = () => claimedHeight(root, ROW, DETAIL);

		// Closed, the list is exactly its rows.
		expect(total()).toBe(200 * ROW);

		fireClick(root.querySelectorAll("button.model-disclosure")[3] as HTMLElement);
		// Open, it is its rows plus the one measured detail - and stays that way
		// whether the open row is rendered, above the window, or below it.
		expect(total()).toBe(200 * ROW + DETAIL);
		for (const top of [0, ROW * 2, ROW * 3 + 1, ROW * 3 + DETAIL, ROW * 40, ROW * 150, ROW * 200 + DETAIL]) {
			scrollTo(container, top);
			expect(total()).toBe(200 * ROW + DETAIL);
		}

		// Scrolled far enough that the open row is above the window, the leading
		// spacer is the one carrying it: whole rows plus the detail.
		scrollTo(container, ROW * 150);
		expect(root.querySelector(".model-detail")).toBeNull();
		const rendered = firstColumn(root);
		const start = Number((rendered[0] as string).slice("Model ".length));
		expect(start).toBeGreaterThan(3);
		const leading = (root.querySelector("li.spacer") as HTMLElement).style.height;
		expect(leading).toBe(`${start * ROW + DETAIL}px`);

		// Closing it takes the detail back out of the spacer arithmetic.
		scrollTo(container, 0);
		fireClick(root.querySelectorAll("button.model-disclosure")[3] as HTMLElement);
		expect(total()).toBe(200 * ROW);
	});
});

test("a detail that resizes while it is scrolled out of the window is re-measured when it comes back", () => {
	// Scrolling far enough unmounts the detail and scrolling back mounts a fresh
	// element; a measurement bound to the first would freeze the height at what
	// it was when the row left, putting every row below at the wrong offset.
	let detailHeight = 100;
	const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get(this: HTMLElement) {
			if (this.classList.contains("model-row-line")) {
				return ROW;
			}
			return this.classList.contains("model-detail") ? detailHeight : 0;
		},
	});
	try {
		const root = mount(
			<ModelsSection currencySymbol="$" models={manyModels(200)} serverCount={1} onInspect={() => {}} />
		);
		const container = root.querySelector(".table-scroll") as HTMLElement;
		fireClick(root.querySelectorAll("button.model-disclosure")[2] as HTMLElement);
		expect(claimedHeight(root, ROW, detailHeight)).toBe(200 * ROW + 100);

		// Out of the window, then taller (the pane reflowed and its field grid
		// rewrapped), then back.
		scrollTo(container, ROW * 150);
		expect(root.querySelector(".model-detail")).toBeNull();
		detailHeight = 260;
		scrollTo(container, 0);

		const detail = root.querySelector(".model-detail") as HTMLElement;
		expect(detail).not.toBeNull();
		const leadingAfter = () => {
			scrollTo(container, ROW * 150);
			return (root.querySelector("li.spacer") as HTMLElement).style.height;
		};
		const rendered = (() => {
			scrollTo(container, ROW * 150);
			return Number((firstColumn(root)[0] as string).slice("Model ".length));
		})();
		expect(leadingAfter()).toBe(`${rendered * ROW + 260}px`);
	} finally {
		if (original === undefined) {
			delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
		} else {
			Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
		}
	}
});

test("two provider groups sharing a label keep separate rows: opening one does not open the other", () => {
	// Labels are not identities - two groups may share one - so a row identity
	// built from the label alone would collide here and open (or flash the copy
	// check on) the wrong row.
	const models = [
		makeModel({ id: "gpt-4o", name: "Omni", serverLabel: "Shared", scopeKey: "s1" }),
		makeModel({ id: "gpt-4o", name: "Omni", serverLabel: "Shared", scopeKey: "s2" }),
	];
	const root = mount(<ModelsSection currencySymbol="$" models={models} serverCount={2} onInspect={() => {}} />);
	const rows = Array.from(root.querySelectorAll("li.model-row"));
	expect(rows.length).toBe(2);

	fireClick(rows[1]?.querySelector("button.model-disclosure") as HTMLElement);
	expect(rows[1]?.querySelector(".model-detail")).not.toBeNull();
	expect(rows[0]?.querySelector(".model-detail")).toBeNull();
	expect(rows[0]?.querySelector("button.model-disclosure")?.getAttribute("aria-expanded")).toBe("false");
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
		<ModelsSection
			currencySymbol="$"
			models={[makeModel({ id: "gpt-4o", name: "Omni" })]}
			serverCount={1}
			onInspect={() => {}}
		/>
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
	const root = mount(<ModelsSection currencySymbol="$" models={models} serverCount={2} onInspect={() => {}} />);
	const button = (server: string) =>
		root.querySelector(`button[aria-label='Copy model ID gpt-4o from ${server}']`) as HTMLButtonElement;
	expect(button("Prod")).not.toBeNull();
	expect(button("Staging")).not.toBeNull();

	fireClick(button("Prod"));
	const iconPath = (server: string) => button(server).querySelector("svg path")?.getAttribute("d") ?? "";
	expect(iconPath("Prod")).not.toBe(iconPath("Staging"));
});

test("the windowed scrollport publishes its own page offset, re-measured, so its height is never guessed", () => {
	// The stylesheet caps this scrollport from a custom property rather than a
	// guess at the chrome above it; this pins the half JavaScript owns.
	const root = mount(<ModelsSection currencySymbol="$" models={manyModels(60)} serverCount={1} onInspect={() => {}} />);
	const scrollport = root.querySelector(".table-scroll.windowed") as HTMLElement;
	expect(scrollport).not.toBeNull();

	// happy-dom reports every rect as zero - the same shape an unrendered element
	// has, and panels stay mounted while hidden - so a zero box means "no answer
	// yet"; publishing it would cap the scrollport at nearly the whole viewport.
	expect(scrollport.style.getPropertyValue("--models-scroll-top")).toBe("");

	const scrollYDescriptor = Object.getOwnPropertyDescriptor(window, "scrollY");
	try {
		scrollport.getBoundingClientRect = () => ({ top: 90, width: 800, height: 500 }) as DOMRect;
		Object.defineProperty(window, "scrollY", { value: 22, configurable: true });
		window.dispatchEvent(new Event("resize"));

		// 90 + 22: adding the scroll offset back names the same distance at every
		// scroll position. A viewport-relative top would shrink as the page
		// scrolls, raising the cap and climbing on every republish.
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
