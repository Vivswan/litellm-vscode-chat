/**
 * The whole shell at the width a split editor actually gives it: the rail as
 * icons, and every server row folded onto two lines.
 *
 * 500px is the width the narrow work was designed against, and it is the one
 * that photographs all of it at once - the rail's collapse, the fold, the
 * list-owned columns, and the row that broke every earlier attempt. That row is
 * `broken`: it is the only one whose action set is wider than a pair of short
 * buttons, so it is where a wrapping cluster shows up as a hole in the middle
 * of the list, and where an action column sized by the widest row starves every
 * name beside it. A shot of five healthy rows proves none of that.
 *
 * None of it can be caught by the component suites: happy-dom runs no cascade,
 * so a container query, a subgrid track and a collapsed rail all measure as
 * whatever the markup says and never as what the reader sees.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import overview from "./overview.ts";

const fixture: RenderFixture = {
	...overview,
	viewport: { width: 500, height: 900 },
};

export default fixture;
