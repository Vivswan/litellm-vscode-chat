/**
 * The models list at its COLUMNAR tier: `@container pane (width >= 1136px)`
 * unfolds the two-line sentence rows into one line of aligned columns by
 * handing `.model-line-2` to the row grid with `display: contents` (the base
 * tier keeps it a block). The tier is a PANE width; at this fixture's
 * geometry the conversion is 1410 window - 216 rail - 1 rail border - 48 pane
 * padding = a 1145px pane (a 1400 window gives 1135, one pixel short of the
 * tier). Windowed like models.ts, because the tier's own threshold arithmetic
 * budgets for the windowed scrollport's scrollbar.
 *
 * The steps ASSERT the tier was actually caught: a render that silently fell
 * back to the stacked tier would still exit 0 with a large, plausible PNG,
 * which is exactly the wrong-page failure this fixture exists to prevent.
 */
import type { DashboardModel } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, GATEWAY_SERVER, MODELS, PROD_SERVER } from "./shared.ts";

/** Past WINDOW_THRESHOLD (50), so the table renders windowed, as models.ts does. */
const FILLER: readonly DashboardModel[] = Array.from({ length: 60 }, (_, index) => {
	const base = MODELS[index % MODELS.length] as DashboardModel;
	const suffix = String(index).padStart(2, "0");
	return {
		...base,
		id: `${base.id}-${suffix}`,
		rawId: `${base.rawId}-${suffix}`,
		name: `${base.name} ${suffix}`,
	};
});

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: baseState({
				servers: [PROD_SERVER, GATEWAY_SERVER],
				models: [...MODELS, ...FILLER],
			}),
		},
		{ kind: "focusSection", section: "models" },
	],
	steps: [
		// Scoped to the VISIBLE Models panel: every tab panel stays mounted
		// (hidden attribute only), so an unscoped selector would find a line in
		// a hidden panel and happily assert a page the shot does not show.
		`(() => {
			const panel = document.querySelector("#panel-models");
			if (!panel || panel.hidden) { throw new Error("the Models panel is hidden; the shot would photograph another page"); }
			const line = panel.querySelector(".model-line-2");
			if (!line) { throw new Error("no .model-line-2 rendered; the models list is not on screen"); }
			const display = getComputedStyle(line).display;
			if (display !== "contents") {
				throw new Error(
					"expected the columnar tier (.model-line-2 display: contents) but got display: " + display +
					"; the pane sits below 1136px and this shot would silently show the stacked tier"
				);
			}
			// display: contents boxes have no geometry of their own; the row
			// carries it, and a zero-width row means nothing is actually painted.
			const row = line.closest("button.model-disclosure");
			if (!row || row.getBoundingClientRect().width === 0) {
				throw new Error("the columnar model row has no on-screen geometry; nothing would be photographed");
			}
		})()`,
	],
	viewport: { width: 1410, height: 1000 },
};

export default fixture;
