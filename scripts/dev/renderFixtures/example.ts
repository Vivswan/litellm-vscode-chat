/**
 * A minimal plausible dashboard state for the render harness: the shared
 * builders' base state on the overview tab. Type-only protocol imports keep
 * this module load-light; the state compiles against DashboardState so
 * wire-shape drift breaks the fixture instead of silently rendering the
 * loading skeleton.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [{ kind: "push", state: baseState() }],
	viewport: { width: 1300, height: 950 },
};

export default fixture;
