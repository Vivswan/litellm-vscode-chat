/**
 * A server whose label outgrows the old fixed name track, on a wide pane.
 *
 * The name column must spend the row's free space (the URL track's slack)
 * before it truncates: at this fixture's own width the label renders whole,
 * every URL stays on one line, and nothing scrolls sideways. The folded tiers
 * may still ellipsize the label - there the drawer's Label fact is the
 * full-text path - which the sweep proves fits at every declared width. The
 * SAME tier out of slack, with the URL parked on its 12ch floor, is
 * servers-long-label-squeeze.ts's subject.
 *
 * Usage joins the rows by LABEL (servers-floor's trap), so the rename below
 * renames the row's usage card too. Steps run ONCE, at this fixture's own
 * viewport (the sweep resizes afterwards without replaying them), so the pane
 * width the whole-label and wbr-rule assertions need is asserted outright
 * rather than tested: a check that skips itself is not forward-defense.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, EXTERNAL_SERVER, GATEWAY_SERVER, MISCONFIGURED_SERVER, PROD_SERVER, USAGE } from "./shared.ts";

const LONG_LABEL = "Dev Error (unreachable host for connection diagnostics)";

/** Shared with servers-long-label-squeeze.ts: same page, the other end of the tier. */
export const LONG_LABEL_MESSAGES: readonly unknown[] = [
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
];

const fixture: RenderFixture = {
	messages: LONG_LABEL_MESSAGES,
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
			// own viewport, so the width is asserted rather than tested: a pane
			// that stopped reaching 1300 would silently disarm everything below
			// it, which is how an assertion quietly stops being one.
			const pane = document.querySelector(".pane");
			if (pane === null || pane.clientWidth < 1300) {
				throw new Error("the pane is " + (pane === null ? "missing" : pane.clientWidth + "px") + ", not the >=1300px this fixture's whole-label and wbr assertions are written for");
			}
			const label = row.querySelector(".server-label-text");
			if (!(label instanceof HTMLElement) || label.scrollWidth > label.clientWidth) {
				throw new Error("the long label should render whole at this width");
			}
			// The wide tier suppresses the URL's <wbr> break opportunities so a
			// squeezed track ellipsizes instead of folding onto three lines. The
			// rule is pinned rather than its outcome: a blockified grid item
			// reports one client rect whether it holds one line or three, so
			// counting line boxes here can never fail. The squeezed state that
			// the rule actually protects is servers-long-label-squeeze.ts.
			const wbrs = [...document.querySelectorAll(".server-row .server-url wbr")];
			// Counted, not assumed per row: a URL with no break points carries
			// none, but the markup dropping them everywhere would leave the
			// display check below with nothing to prove.
			if (wbrs.length === 0) {
				throw new Error("no row URL carries a wbr; the markup stopped offering the break opportunities this pins");
			}
			for (const wbr of wbrs) {
				const display = getComputedStyle(wbr).display;
				if (display !== "none") {
					throw new Error("a row URL's wbr computes display: " + display + " at the wide tier; its break opportunities are back and a squeezed track will wrap instead of ellipsizing");
				}
			}
		})()`,
	],
	viewport: { width: 1600, height: 1200 },
};

export default fixture;
