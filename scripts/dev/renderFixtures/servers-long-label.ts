/**
 * A server whose label outgrows the old fixed name track, on a wide pane.
 *
 * The name column must spend the row's free space (the URL track's slack)
 * before it truncates: at this fixture's own width the label renders whole,
 * every URL stays on one line, and nothing scrolls sideways. The folded tiers
 * may still ellipsize the label - there the drawer's Label fact is the
 * full-text path - which the sweep proves fits at every declared width.
 *
 * Usage joins the rows by LABEL (servers-floor's trap), so the rename below
 * renames the row's usage card too. Steps run ONCE, at this fixture's own
 * viewport (the sweep resizes afterwards without replaying them): the join
 * guard always fires, and the whole-label and one-line-URL assertions fire
 * behind a pane-width check that is true here and stands as forward-defense
 * should a runner ever replay steps at swept widths.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, EXTERNAL_SERVER, GATEWAY_SERVER, MISCONFIGURED_SERVER, PROD_SERVER, USAGE } from "./shared.ts";

const LONG_LABEL = "Dev Error (unreachable host for connection diagnostics)";

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: baseState({
				servers: [{ ...PROD_SERVER, label: LONG_LABEL }, GATEWAY_SERVER, MISCONFIGURED_SERVER, EXTERNAL_SERVER],
				usage: {
					...USAGE,
					servers: USAGE.servers.map((card) => (card.label === "prod" ? { ...card, label: LONG_LABEL } : card)),
				},
			}),
		},
	],
	steps: [
		`(() => {
			const row = document.querySelector(".server-list > li.server-item");
			if (!row) {
				throw new Error("no server rows rendered");
			}
			if (!row.querySelector(".spend-unit")) {
				throw new Error("the long-label row lost its usage join - rename the usage card with the server");
			}
			// A green sweep only proves the page FITS; these prove the fixture shows
			// the behavior it exists to photograph. Steps run once at the fixture's
			// own viewport, where the width check holds; getClientRects counts an
			// inline's line boxes.
			const pane = document.querySelector(".pane");
			if (pane !== null && pane.clientWidth >= 1300) {
				const label = row.querySelector(".server-label-text");
				if (!(label instanceof HTMLElement) || label.scrollWidth > label.clientWidth) {
					throw new Error("the long label should render whole at this width");
				}
				for (const url of document.querySelectorAll(".server-row .server-url")) {
					if (url.getClientRects().length > 1) {
						throw new Error("a row URL wrapped at the wide tier");
					}
				}
			}
		})()`,
	],
	viewport: { width: 1600, height: 1200 },
};

export default fixture;
