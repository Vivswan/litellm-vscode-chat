/**
 * The Settings tab with the two appearance rows explicitly configured: their
 * modified gutter markers, which are the whole at-rest signal. (Reset and any
 * note are hover- and focus-revealed; add `--hover
 * ".setting-row.modified:last-of-type"` to photograph one.)
 *
 * The explicit-scope half of the harness's appearance rule: the fixture names
 * the SCOPES, which nothing stamps, while the flags stamp the theme and accent
 * VALUES. Pinning the scopes to null once made a marked appearance row
 * unrenderable by any fixture. The other half needs no fixture: a forced
 * non-default value implies a scope, so `--app-theme dark --accent violet` over
 * any settings fixture is that shot.
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
					// theme and accent are the harness's to decide; the scopes are this
					// fixture's whole subject.
					appearance: { ...state.settings.appearance, themeScope: "global", accentScope: "global" },
				},
			},
		},
		{ kind: "focusSection", section: "settings" },
	],
	viewport: { width: 1300, height: 2400 },
};

export default fixture;
