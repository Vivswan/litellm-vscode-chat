/**
 * The record matcher table with a chip popover open: the Settings tab's
 * Model parameters editor, the gpt-5* row's temperature chip expanded into
 * its anchored editor (value input, force/inheritable toggles, Remove field).
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ type: "state", state: baseState() },
		{ type: "focusSection", section: "settings" },
	],
	steps: [
		`(() => {
			const chips = [...document.querySelectorAll("button.chip-field")]
				.filter((chip) => chip.querySelector(".chip-key")?.textContent === "temperature");
			chips[1].click();
		})()`,
		`(() => {
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 1600 },
	settleMs: 400,
};

export default fixture;
