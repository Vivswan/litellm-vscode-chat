/**
 * The Settings tab with the two appearance rows explicitly configured: their
 * modified gutter markers and their "Modified in User settings" notes. (Their
 * Reset buttons are hover- and focus-revealed, so they are not in a plain shot;
 * add `--hover ".setting-row.modified:last-of-type"` to photograph one.)
 *
 * The shot exists because those states were unrenderable until the harness
 * stopped overwriting the appearance scopes. It stamps the theme and accent
 * VALUES from its own flags - the webview restamps the root element from every
 * push, so a fixture that disagreed would render every --app-theme and --accent
 * as the default - but the scopes say only whether a scope configures the row,
 * and nothing stamps those. Pinning them to null meant an appearance row could
 * only ever be photographed clean, and this fixture is what keeps that from
 * silently returning.
 *
 * This is the explicit-scope half of the harness rule. The other half is that a
 * forced non-default value implies a scope even when the fixture names none,
 * since such a value exists only because something wrote it: no fixture can
 * express that, because it is the flags that trigger it, so
 * `--app-theme dark --accent violet` over any settings fixture is the shot -
 * both rows come back marked, and neither claims a dark violet dashboard that
 * nothing configured.
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
