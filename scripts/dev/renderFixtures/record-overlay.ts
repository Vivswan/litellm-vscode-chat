/**
 * The full matcher editor overlay over the Settings tab: the gpt-5* record's
 * pencil opened into the slide-over editor - matcher input, Inherits control,
 * field rows with their flag checkboxes, Add parameter, Remove matcher.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "settings" },
	],
	steps: [
		`document.querySelector('button[aria-label=\\'Open the full editor for "gpt-5*"\\']').click()`,
		`(() => {
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 950 },
	settleMs: 400,
};

export default fixture;
