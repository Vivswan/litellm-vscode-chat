/**
 * The models table's interactive layer: column sorting (toggle, aria-sort,
 * absent values last), the windowed rendering past the row threshold with its
 * spacer arithmetic, and the per-row copy-ID action.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "preact/test-utils";
import type { DashboardModel } from "../../../extension/dashboard/protocol";
import { ModelsSection } from "../../../webview/dashboard/models";
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
	const root = mount(<ModelsSection models={models} serverCount={1} />);
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
	const root = mount(<ModelsSection models={models} serverCount={1} />);
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
	const root = mount(<ModelsSection models={manyModels(200)} serverCount={1} />);
	const container = root.querySelector(".table-scroll") as HTMLElement;
	expect(container.classList.contains("windowed")).toBe(true);

	const rendered = firstColumn(root);
	expect(rendered.length).toBeLessThan(200);
	expect(rendered[0]).toBe("Model 000");
	// Only the trailing spacer at the top of the list.
	expect(root.querySelectorAll("tbody tr.spacer").length).toBe(1);

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
	const root = mount(<ModelsSection models={manyModels(200)} serverCount={1} />);
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
	const root = mount(<ModelsSection models={manyModels(200)} serverCount={1} />);
	const container = root.querySelector(".table-scroll") as HTMLElement;
	scrollTo(container, 26 * 150);

	fireInput(root.querySelector("input[aria-label='Filter models']") as HTMLInputElement, "Model 00");
	// 10 matches (000..009): below the threshold, all render, no spacers.
	expect(firstColumn(root).length).toBe(10);
	expect(root.querySelectorAll("tbody tr.spacer").length).toBe(0);
});

test("under the threshold every row renders with no scrollport", () => {
	const root = mount(<ModelsSection models={manyModels(50)} serverCount={1} />);
	expect(firstColumn(root).length).toBe(50);
	expect((root.querySelector(".table-scroll") as HTMLElement).classList.contains("windowed")).toBe(false);
	expect(root.querySelectorAll("tbody tr.spacer").length).toBe(0);
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

	const root = mount(<ModelsSection models={[makeModel({ id: "gpt-4o", name: "Omni" })]} serverCount={1} />);
	const copy = root.querySelector("button[aria-label='Copy model ID gpt-4o']") as HTMLButtonElement;
	expect(copy).not.toBeNull();
	fireClick(copy);
	expect(written).toEqual(["gpt-4o"]);
});
