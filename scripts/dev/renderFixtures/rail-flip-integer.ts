/**
 * The rail collapse boundary's one ambiguous integer, held by a throwing step:
 * at exactly width 1000 the harness's layout applies the rail's narrow block
 * while matchMedia("(width < 1000px)") reports false, so a `<`-spelled pair
 * once left the PAINT collapsed and useCollapsedRail expanded on one and the
 * same page. Both spell `<=` now (rail.tsx RAIL_COLLAPSE_QUERY says why), and
 * this fixture proves the agreement AT the boundary: the painted state is read
 * off the rail's box, the hook's state off the one behavior only it controls
 * (the verdict pill's collapsed-only tab stop), and a mismatch throws. 999 and
 * 1001 are unambiguous on both sides and ride the overflow sweep.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import base from "./diagnostics-empty.ts";

const fixture: RenderFixture = {
	...base,
	steps: [
		...(base.steps ?? []),
		`(() => {
			const rail = document.querySelector(".rail");
			const pill = document.querySelector(".rail-status");
			if (rail === null || pill === null) {
				throw new Error("no .rail or .rail-status on the page; the flip agreement was not measured");
			}
			// 100 splits the rail's two boxes (49 collapsed, 217 expanded), the
			// same discriminator the rail-coverage fixtures use.
			const painted = rail.getBoundingClientRect().width < 100 ? "collapsed" : "expanded";
			// The hook's one observable the stylesheet cannot cause: collapsed, the
			// verdict pill takes a tab stop; expanded it must not.
			const hook = pill.getAttribute("tabindex") === "0" ? "collapsed" : "expanded";
			if (painted !== hook) {
				throw new Error(
					"at width 1000 the stylesheet paints the rail " + painted + " while useCollapsedRail behaves " + hook +
					"; the collapse's spellings disagree at the boundary integer again (rail.tsx RAIL_COLLAPSE_QUERY)"
				);
			}
			// The same agreement against the query string itself: the paint comes
			// from the stylesheet's block, this from the spelling the hook uses
			// (narrowThresholds.test.ts pins the two strings equal). A moved
			// threshold makes this stale and throws, which is the point.
			if (window.matchMedia("(width <= 1000px)").matches !== (painted === "collapsed")) {
				throw new Error(
					"matchMedia('(width <= 1000px)') and the painted rail disagree at width 1000: the layout engine and " +
					"the query API split at the boundary again; re-derive the collapse spelling"
				);
			}
		})()`,
	],
	viewport: { width: 1000, height: 700 },
};

export default fixture;
