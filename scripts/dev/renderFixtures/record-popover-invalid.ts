/**
 * A chip popover holding a validation error: the value input rejects "not
 * json", the message renders inside the popover, and the chip behind it is
 * marked invalid - Apply is blocked meanwhile.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "settings" },
	],
	steps: [
		`(() => {
			const chips = [...document.querySelectorAll("button.chip-field")]
				.filter((chip) => chip.querySelector(".chip-key")?.textContent === "temperature");
			chips[1].click();
		})()`,
		`(() => {
			const input = document.querySelector(".chip-popover input.value");
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
			setter.call(input, "not json");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		})()`,
		`(() => {
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 1600 },
	settleMs: 400,
	// Opened by a step that MEASURED its anchor, so the side it hangs on
	// belongs to this width; a sweep that narrowed the viewport afterwards
	// would judge a page the dashboard never builds.
	measuredAtOwnWidth: true,
};

export default fixture;
