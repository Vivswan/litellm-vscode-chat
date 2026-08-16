/**
 * The resolution table's pinned Inspect column, held by throwing steps at a
 * width where the table genuinely overflows its scrollport: the row's one
 * action must sit at the scrollport's right edge at rest (scrollLeft 0, the
 * state every visit opens in), mid-scroll, and at the far end. The overflow
 * sweep accepts a scrollport by design and the geometry sweep never scrolls
 * one, so this claim lives here or nowhere. The overflow guard fails closed: a
 * table that starts fitting at this width reads as never-ran, not as a pass.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import base from "./diagnostics.ts";

const fixture: RenderFixture = {
	...base,
	// 700px window: past the rail's collapse, a ~651px pane, where the resolved
	// table's columns outrun the scrollport.
	viewport: { width: 700, height: 2300 },
	steps: [
		...(base.steps ?? []),
		`(async () => {
			const scroll = document.querySelector(".resolved-scroll");
			if (scroll === null) {
				throw new Error("no .resolved-scroll on the page; the pinned-Inspect claim was measured over the wrong subject");
			}
			if (scroll.scrollWidth <= scroll.clientWidth + 1) {
				throw new Error(
					"the resolution table does not overflow at this width (scrollWidth " + scroll.scrollWidth +
					"px inside " + scroll.clientWidth + "px); the sticky pin was never exercised - re-point the fixture"
				);
			}
			const settle = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
			const scrollRect = scroll.getBoundingClientRect();
			const hold = (label) => {
				const button = scroll.querySelector("td.actions button");
				if (button === null) { throw new Error("no Inspect button in the resolution table"); }
				const cell = button.closest("td").getBoundingClientRect();
				const rect = button.getBoundingClientRect();
				if (Math.abs(cell.right - scrollRect.right) > 1.5) {
					throw new Error(
						label + ": the Inspect cell's right edge sits " + (scrollRect.right - cell.right).toFixed(1) +
						"px from the scrollport's right edge; the action is not pinned"
					);
				}
				if (rect.left < scrollRect.left - 0.5 || rect.right > scrollRect.right + 0.5) {
					throw new Error(label + ": the Inspect button is outside the scrollport's visible box");
				}
				// Pinned is not enough: what the cell PAINTS is the cell's own box,
				// so a button whose border box escapes it flaps over the content
				// scrolling past and takes the pointer with it.
				if (rect.left < cell.left - 0.5 || rect.right > cell.right + 0.5) {
					const escape = Math.max(cell.left - rect.left, rect.right - cell.right);
					throw new Error(
						label + ": the Inspect button's border box escapes its sticky cell by " + escape.toFixed(1) +
						"px, so the cell's opaque paint and seam do not cover it"
					);
				}
			};
			scroll.scrollLeft = 0;
			await settle();
			hold("at rest (scrollLeft 0)");
			scroll.scrollLeft = Math.floor((scroll.scrollWidth - scroll.clientWidth) / 2);
			await settle();
			hold("mid-scroll");
			scroll.scrollLeft = scroll.scrollWidth;
			await settle();
			hold("at the far end");
			// Reproducible capture: back to the rest state before the shot.
			scroll.scrollLeft = 0;
			await settle();
		})()`,
	],
};

export default fixture;
