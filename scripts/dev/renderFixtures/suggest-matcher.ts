/**
 * The matcher-key input's suggestion listbox open: the discovered model IDs
 * under the Model parameters editor's prefix input, in the shared dropdown
 * chrome. The step focuses the first matcher input on the Settings tab.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ type: "state", state: baseState() },
		{ type: "focusSection", section: "settings" },
	],
	steps: [
		// A fresh matcher: an empty prefix input suggests every model ID.
		`[...document.querySelectorAll("button")]
			.find((b) => b.textContent.trim() === "Add model matcher")
			.click()`,
		`(() => {
			const input = [...document.querySelectorAll("input[placeholder^='Model ID or matcher']")]
				.find((el) => el.value === "" && !el.disabled);
			input.scrollIntoView({ block: "center" });
			input.focus();
		})()`,
	],
	viewport: { width: 1300, height: 900 },
	settleMs: 500,
};

export default fixture;
