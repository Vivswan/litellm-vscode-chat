/** The Usage tab: cards under/over thresholds, past 100%, stale, and budget-less. */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "usage" },
	],
	viewport: { width: 1300, height: 1100 },
};

export default fixture;
