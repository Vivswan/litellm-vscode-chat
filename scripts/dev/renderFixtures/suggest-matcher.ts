/**
 * The matcher-key input's suggestion listbox open: the discovered model IDs
 * under the matcher editor overlay's prefix input, in the shared dropdown
 * chrome. The steps add a fresh matcher (which opens the overlay) and focus
 * its empty prefix input.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "settings" },
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
