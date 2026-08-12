/**
 * The usage.alertThresholds row's three states in one shot is impossible, so
 * this fixture covers the one-set state: a stored single-element list fills
 * the Error box alone with the goes-straight-to-error hint. The step scrolls
 * the row into view; render with --clip-viewport for a focused shot.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const state = baseState();

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: {
				...state,
				settings: {
					...state.settings,
					usage: { statusBarMode: "always", statusBarScope: null, alertThresholds: [0.9], thresholdsScope: "global" },
				},
			},
		},
		{ kind: "focusSection", section: "settings" },
	],
	steps: ['document.getElementById("setting-usage.alertThresholds-error-at").scrollIntoView({ block: "center" })'],
	viewport: { width: 1300, height: 700 },
	settleMs: 500,
};

export default fixture;
