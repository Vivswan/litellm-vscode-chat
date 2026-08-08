/**
 * The Settings tab: scalar groups, the Usage rows (thresholds list + status
 * bar mode), the catalog row with a standing failure, and both record editors
 * with directive controls (force/inheritable marks, the inherit-from select,
 * fallback marks and the _openrouter_model row).
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, minutesAgoMs } from "./shared.ts";

const state = baseState();

const fixture: RenderFixture = {
	messages: [
		{
			type: "state",
			state: {
				...state,
				settings: {
					...state.settings,
					catalog: {
						modelCount: 324,
						lastSuccessAt: minutesAgoMs(60 * 26),
						lastFailure: { classification: "HTTP 503", at: minutesAgoMs(30) },
						refreshing: false,
					},
				},
			},
		},
		{ type: "focusSection", section: "settings" },
	],
	viewport: { width: 1300, height: 2400 },
};

export default fixture;
