/**
 * The usage.alertThresholds row's both-set state: the default [0.8, 0.95]
 * rendered as the Warning/Error percent pair. The step scrolls the row into
 * view; render with --clip-viewport for a focused shot.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ type: "state", state: baseState() },
		{ type: "focusSection", section: "settings" },
	],
	steps: ['document.getElementById("setting-usage.alertThresholds-warning").scrollIntoView({ block: "center" })'],
	viewport: { width: 1300, height: 700 },
	settleMs: 500,
};

export default fixture;
