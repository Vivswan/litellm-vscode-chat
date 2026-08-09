/**
 * The capability key input's suggestion listbox open (the datalist
 * replacement): the closed vocabulary plus directives rendered in the
 * catalog-results dropdown chrome at normal weight. The step focuses the
 * first capability-name input on the Settings tab.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ type: "state", state: baseState() },
		{ type: "focusSection", section: "settings" },
	],
	steps: [
		// A fresh row: an empty key input shows the whole vocabulary.
		`[...document.querySelectorAll("button")]
			.find((b) => b.textContent.trim() === "Add capability matcher")
			.click()`,
		`(() => {
			const inputs = [...document.querySelectorAll("input[placeholder^='Capability']")];
			const input = inputs[inputs.length - 1];
			input.scrollIntoView({ block: "center" });
			input.focus();
		})()`,
	],
	viewport: { width: 1300, height: 900 },
	settleMs: 500,
};

export default fixture;
