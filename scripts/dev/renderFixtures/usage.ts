/** The Usage tab: cards under/over thresholds, past 100%, stale, and budget-less. */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ type: "state", state: baseState() },
		{ type: "focusSection", section: "usage" },
	],
	viewport: { width: 1300, height: 1100 },
};

export default fixture;
