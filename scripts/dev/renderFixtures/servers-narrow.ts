/**
 * The whole shell at the width a split editor actually gives it: the rail as
 * icons, and every server row folded onto two lines.
 *
 * 500px photographs the rail's collapse, the fold, the list-owned columns, and
 * the row that broke every earlier attempt at once. That row is `broken`: its
 * action set is the only one wider than a pair of short buttons, so it is where
 * a wrapping cluster shows as a hole in the list and where an action column
 * sized by the widest row starves every name beside it.
 *
 * None of it can be caught by the component suites: happy-dom runs no cascade,
 * so container queries, subgrid tracks and a collapsed rail all measure as
 * whatever the markup says.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import overview from "./overview.ts";

const fixture: RenderFixture = {
	...overview,
	viewport: { width: 500, height: 900 },
};

export default fixture;
