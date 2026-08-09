/**
 * The Settings tab's scalar-failure line with a two-part message: the
 * localized frame carries the headline, the technical detail renders as its
 * own dimmed line beneath (the setUsageAlertThresholds wiring into the
 * scalar-failure chain).
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ type: "state", state: baseState() },
		{ type: "focusSection", section: "settings" },
		{
			type: "intentFailed",
			intentType: "setUsageAlertThresholds",
			message:
				"Alert thresholds must be above 0% and at most 100% - enter values like 80% or 0.8.\nsetting litellm-vscode-chat.usage.alertThresholds: allowed range 0 < value <= 1",
			kind: "validation",
		},
	],
	steps: [
		// Pinned to the top: the sticky tab bar repaints at the scroll offset in
		// full-page captures, so a scrolled capture shows it twice.
		`(() => {
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 900 },
	settleMs: 500,
};

export default fixture;
