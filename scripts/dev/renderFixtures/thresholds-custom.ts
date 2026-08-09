/**
 * The usage.alertThresholds row's custom-list state: a hand-written list of
 * 3+ values the two boxes cannot represent renders read-only with the values,
 * the edit-in-settings.json hint, and the reveal button. The step scrolls the
 * row into view; render with --clip-viewport for a focused shot.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const state = baseState();

const fixture: RenderFixture = {
	messages: [
		{
			type: "state",
			state: {
				...state,
				settings: {
					...state.settings,
					usage: {
						statusBarMode: "always",
						statusBarScope: null,
						alertThresholds: [0.5, 0.8, 0.95],
						thresholdsScope: "global",
					},
				},
			},
		},
		{ type: "focusSection", section: "settings" },
	],
	steps: [
		`[...document.querySelectorAll("button")]
			.find((b) => b.getAttribute("aria-label") === "Open Usage alert thresholds in settings.json")
			.scrollIntoView({ block: "center" })`,
	],
	viewport: { width: 1300, height: 700 },
	settleMs: 500,
};

export default fixture;
