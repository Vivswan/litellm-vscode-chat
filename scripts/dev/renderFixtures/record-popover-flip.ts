/**
 * A chip popover that would hang past the viewport's bottom edge, flipped above its chip instead. That is the case the
 * mount measurement alone cannot see and the size observer can.
 *
 *   the browser scrolls its input into view on focus -> the popover opens at a comfortable spot
 *   the reader THEN scrolls it down to the edge      -> only then does its content change
 *   nothing re-focuses                               -> nothing scrolls it back
 *   the flip is a question about the bottom edge, and a full-page capture expands the viewport until there is no edge
 *   left to overflow -> It captures the viewport alone (clipViewport)
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
			const adds = [...document.querySelectorAll("button.chip-add")];
			const add = adds[adds.length - 1];
			add.scrollIntoView({ block: "end" });
			add.click();
		})()`,
		`(() => {
			const input = document.querySelector(".chip-popover input");
			window.scrollBy(0, input.getBoundingClientRect().bottom - (window.innerHeight - 20));
		})()`,
		`(() => {
			const input = document.querySelector(".chip-popover input");
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
			setter.call(input, "s");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		})()`,
	],
	viewport: { width: 1300, height: 620 },
	clipViewport: true,
	settleMs: 400,
	// Opened by a step that MEASURED its anchor, so the side it hangs on belongs to this width; a sweep that narrowed
	// the viewport afterwards would judge a page the dashboard never builds.
	measuredAtOwnWidth: true,
};

export default fixture;
