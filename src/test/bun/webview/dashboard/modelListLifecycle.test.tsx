import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { DashboardModel } from "../../../../dashboard/viewModels";
import { DEFAULT_ROW_HEIGHT, ModelsSection } from "../../../../webview/dashboard/models";
import { makeModel } from "../fixtures";
import { cleanup, fireClick, mount, render, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

/** happy-dom lays nothing out, so the component's fallback row height is the one the window arithmetic runs on. */
const ROW = DEFAULT_ROW_HEIGHT;

function manyModels(count: number): DashboardModel[] {
	return Array.from({ length: count }, (_, index) =>
		makeModel({ id: `model-${String(index).padStart(3, "0")}`, name: `Model ${String(index).padStart(3, "0")}` })
	);
}

function section(models: readonly DashboardModel[]) {
	return <ModelsSection currencySymbol="$" models={models} serverCount={1} onInspect={() => {}} />;
}

function scrollportOf(root: ParentNode): HTMLElement {
	return root.querySelector(".table-scroll") as HTMLElement;
}

function scrollTo(container: HTMLElement, top: number): void {
	void act(() => {
		container.scrollTop = top;
		container.dispatchEvent(new Event("scroll"));
	});
}

function rowNamed(root: ParentNode, name: string): HTMLElement | undefined {
	return Array.from(root.querySelectorAll<HTMLElement>("li.model-row")).find(
		(row) => row.querySelector(".model-name-text")?.textContent === name
	);
}

function renderedNames(root: ParentNode): string[] {
	return Array.from(root.querySelectorAll("li.model-row")).map(
		(row) => row.querySelector(".model-name-text")?.textContent ?? ""
	);
}

/** The copy button's glyph, told apart by its path: a check mark while the flash shows, the copy icon at rest. */
function copyGlyph(root: ParentNode, id: string): string | undefined {
	return (
		root
			.querySelector(`button[aria-label='Copy model ID ${id} from Prod']`)
			?.querySelector("svg path")
			?.getAttribute("d") ?? undefined
	);
}

test("the open row, its copy flash, and the scroll offset survive the models emptying and refilling", () => {
	// A server resync delivers an empty models push and then the models again. To the reader it is the same list, so
	// what they opened, copied, and scrolled to stays; a list mounted only while models exist would start over.
	const models = manyModels(200);
	const root = mount(section(models));
	scrollTo(scrollportOf(root), ROW * 100);
	expect(renderedNames(root)).toContain("Model 105");

	const restingGlyph = copyGlyph(root, "model-105");
	fireClick(rowNamed(root, "Model 105")?.querySelector("button.model-disclosure") as HTMLElement);
	fireClick(root.querySelector("button[aria-label='Copy model ID model-105 from Prod']") as HTMLElement);
	const flashGlyph = copyGlyph(root, "model-105");
	expect(flashGlyph).not.toBe(restingGlyph);
	expect(rowNamed(root, "Model 105")?.classList.contains("is-open")).toBe(true);

	render(section([]), root);
	expect(root.querySelector("li.model-row")).toBeNull();
	expect(root.textContent).toContain("No models discovered yet.");

	render(section(models), root);
	expect(scrollportOf(root).scrollTop).toBe(ROW * 100);
	expect(renderedNames(root)).toContain("Model 105");
	expect(renderedNames(root)).not.toContain("Model 000");
	const row = rowNamed(root, "Model 105");
	expect(row?.classList.contains("is-open")).toBe(true);
	expect(row?.querySelector(".model-detail")?.id).toBe("model-detail-105");
	expect(copyGlyph(root, "model-105")).toBe(flashGlyph);
});

test("an offset remembered through a refill inside a hidden panel is taken once the scrollport has a layout box", () => {
	// CSSOM: a scrollTop write on an element without a layout box does nothing, and a scrollport born while another tab
	// shows (the refill arriving behind a hidden panel) has none. happy-dom models no layout, so the setter drops writes
	// while `boxless` holds; the write has to be retried on the render that shows the panel, not only once per element.
	const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop") as PropertyDescriptor;
	let boxless = false;
	Object.defineProperty(Element.prototype, "scrollTop", {
		...descriptor,
		set(this: Element, top: number) {
			if (!boxless) {
				descriptor.set?.call(this, top);
			}
		},
	});
	try {
		const models = manyModels(200);
		const root = mount(section(models));
		scrollTo(scrollportOf(root), ROW * 100);
		render(section([]), root);

		boxless = true;
		render(section(models), root);
		expect(scrollportOf(root).scrollTop).toBe(0);

		boxless = false;
		render(section(models), root);
		expect(scrollportOf(root).scrollTop).toBe(ROW * 100);
		expect(renderedNames(root)).toContain("Model 105");
	} finally {
		Object.defineProperty(Element.prototype, "scrollTop", descriptor);
	}
});

test("the scrollport's page offset is published when the models arrive after an empty first render", () => {
	// The first push of a session often carries no models yet (discovery still running), and the stylesheet caps the
	// scrollport from this variable. A measurement taken once at mount, before the scrollport exists, would leave the
	// cap unset until something else republished it.
	const measured = Element.prototype.getBoundingClientRect;
	// happy-dom reports every box as zero, which the publisher reads as "not placed yet", so every box measures as a
	// placed one here.
	Element.prototype.getBoundingClientRect = () => ({ top: 90, width: 800, height: 500 }) as DOMRect;
	try {
		const root = mount(section([]));
		expect(root.querySelector(".table-scroll")).toBeNull();

		render(section([makeModel()]), root);
		const scrollport = root.querySelector(".table-scroll") as HTMLElement;
		expect(scrollport.style.getPropertyValue("--models-scroll-top")).toBe("90px");
	} finally {
		Element.prototype.getBoundingClientRect = measured;
	}
});
