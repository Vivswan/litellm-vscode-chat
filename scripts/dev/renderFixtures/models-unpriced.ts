/**
 * The unpriced rows, which print NOTHING where a price would be. Four rows
 * covering the row's second line at its extremes: priced with capabilities,
 * unpriced with capabilities, unpriced with none, and priced again, so a drift
 * shows against neighbours on both sides.
 *
 * The step is the guard the component tests cannot be: happy-dom runs no
 * cascade, so nothing there notices when an EMPTY second line collapses the
 * row's second grid track and the row-line's centring drops the model name out
 * of line with every other row. It empties that line itself rather than asking
 * a container query to do it, because a fixture's steps run ONCE at its own
 * declared viewport (the harness sweeps widths afterwards, and the sweep only
 * measures overflow) - a narrow tier is simply not reachable from here, and a
 * step that waited for one would assert nothing at all.
 */
import type { DashboardModel } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, MODELS, PROD_SERVER } from "./shared.ts";

const PRICED = MODELS[0] as DashboardModel;

/** Shared with models-unpriced-columnar.ts: same rows, the other tier. */
export const UNPRICED_ROWS: readonly DashboardModel[] = [
	PRICED,
	{
		...PRICED,
		id: "unpriced-caps",
		rawId: "unpriced-caps",
		name: "Unpriced, capable",
		inputCost: undefined,
		outputCost: undefined,
	},
	{
		...PRICED,
		id: "unpriced-bare",
		rawId: "unpriced-bare",
		name: "Unpriced, no capabilities",
		inputCost: undefined,
		outputCost: undefined,
		toolCalling: false,
		imageInput: false,
		promptCaching: false,
		reasoning: false,
	},
	{ ...PRICED, id: "priced-b", rawId: "priced-b", name: "Priced again", inputCost: 0.3, outputCost: 1.2 },
];

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
			const rows = [...panel.querySelectorAll(".model-row .model-row-line")];
			if (rows.length !== 4) { throw new Error("expected the fixture's 4 rows, got " + rows.length); }
			const offsets = () => rows.map((row) => {
				const name = row.querySelector(".model-name-text");
				if (!name) { throw new Error("a row rendered without its name"); }
				return Math.round(name.getBoundingClientRect().top - row.getBoundingClientRect().top);
			});
			const assertAligned = (what) => {
				const seen = offsets();
				// One shared baseline: a row whose second line stopped occupying
				// its box centres a shorter block and sits lower than the rest.
				if (Math.max(...seen) - Math.min(...seen) > 1) {
					throw new Error("the model name sits at different heights down the list " + what + ": offsets " + seen.join(", "));
				}
			};
			assertAligned("as rendered");

			// The unpriced row with no capabilities is the one the narrow tiers
			// strip to nothing (they hide the token limits, and it has no price
			// and no capabilities left to print). Emptied here directly, since
			// this step cannot reach those tiers, and put back before the shot.
			const line = rows[2].querySelector(".model-line-2");
			if (!line) { throw new Error("the unpriced row rendered without its second line"); }
			if (line.childNodes.length === 0) { throw new Error("that line is already empty; this step would prove nothing"); }
			const kept = [...line.childNodes];
			line.replaceChildren();
			try {
				assertAligned("once a row's second line is empty");
			} finally {
				line.replaceChildren(...kept);
			}
		})()`,
	],
	// 990, not 1000: the stylesheet's rail query reads `width < 1000px`, but
	// the harness's emulation lands the flip a pixel over (rail collapsed at
	// 1000, expanded at 1001 in a render), so 1000 sits exactly on it. This
	// fixture's subject is row alignment, not the rail.
	viewport: { width: 990, height: 600 },
	clipViewport: true,
};

export default fixture;
