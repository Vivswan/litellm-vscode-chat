/**
 * The same unpriced rows at the COLUMNAR tier (`@container pane (width >=
 * 1136px)`), where each second-line segment is PINNED to its own grid column.
 * models-unpriced.ts guards the stacked tier, and a fixture's steps run once
 * at its own viewport, so the pins have no guard without this sibling: an
 * unpriced row renders no cost segment at all, and without the pins
 * auto-placement slides its capabilities left into the empty price column -
 * aligned rows down the page are the whole reason the tier exists.
 *
 * The steps assert the tier was actually caught and then compare cell
 * x-positions across rows: a render that fell back to the stacked tier, or a
 * lost pin, throws instead of exiting 0 with a plausible PNG.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { UNPRICED_ROWS } from "./models-unpriced.ts";
import { baseState, PROD_SERVER } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState({ servers: [PROD_SERVER], models: UNPRICED_ROWS }) },
		{ kind: "focusSection", section: "models" },
	],
	steps: [
		// Scoped to the VISIBLE Models panel: every tab panel stays mounted
		// (hidden attribute only), so an unscoped selector would measure rows on
		// a page this shot does not show.
		`(() => {
			const panel = document.querySelector("#panel-models");
			if (!panel || panel.hidden) { throw new Error("the Models panel is hidden; these rows are not the ones on screen"); }
			const line = panel.querySelector(".model-line-2");
			if (!line) { throw new Error("no .model-line-2 rendered; the models list is not on screen"); }
			const display = getComputedStyle(line).display;
			if (display !== "contents") {
				throw new Error(
					"expected the columnar tier (.model-line-2 display: contents) but got display: " + display +
					"; the pane sits below 1136px and this shot would assert nothing about the column pins"
				);
			}
			const rows = [...panel.querySelectorAll("button.model-disclosure")];
			if (rows.length !== 4) { throw new Error("expected the fixture's 4 rows, got " + rows.length); }
			if (!rows.some((row) => row.querySelector(".model-cost"))) {
				throw new Error("no priced row rendered a cost cell; the priced/unpriced contrast is gone");
			}
			if (rows.every((row) => row.querySelector(".model-cost"))) {
				throw new Error("every row rendered a cost cell; there is no unpriced row to catch sliding");
			}
			// The priced first row anchors each column; every other row's same
			// cell must sit at the same x. The unpriced row is the one that
			// drifts when a grid-column pin goes missing: its capabilities
			// auto-place into the empty price column instead of staying put.
			// The computed grid-column-start is asserted too, because losing
			// the limits or cost pin alone leaves auto-placement landing them
			// in the same columns by coincidence of DOM order - the x-position
			// check alone would stay green while the pin is gone.
			const anchor = rows[0];
			const columns = [[".model-limits", "3"], [".model-cost", "4"], [".model-caps", "5"]];
			for (const [selector, start] of columns) {
				const reference = anchor.querySelector(selector);
				if (!reference) { throw new Error("the priced reference row lost its " + selector + " cell"); }
				const expected = Math.round(reference.getBoundingClientRect().x);
				rows.forEach((row, index) => {
					// The bare row prints no capabilities and unpriced rows no cost;
					// absence is the design, only a PRESENT cell must line up.
					const cell = row.querySelector(selector);
					if (!cell) { return; }
					const pinned = getComputedStyle(cell).gridColumnStart;
					if (pinned !== start) {
						throw new Error(
							selector + " computes grid-column-start " + pinned + " instead of " + start + " on row " + index +
							"; its grid-column pin is missing from the columnar tier"
						);
					}
					const seen = Math.round(cell.getBoundingClientRect().x);
					if (Math.abs(seen - expected) > 1) {
						throw new Error(
							selector + " sits at x=" + seen + " on row " + index + " but x=" + expected +
							" on the priced reference row; a grid-column pin is missing and the column slid"
						);
					}
				});
			}
		})()`,
	],
	viewport: { width: 1600, height: 600 },
	clipViewport: true,
};

export default fixture;
