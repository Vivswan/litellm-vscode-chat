/**
 * A chip popover that would hang past the viewport's bottom edge, flipped
 * above its chip instead. The sequence matters: the popover opens at a
 * comfortable spot (the browser scrolls its input into view on focus, which
 * is why a fresh popover almost never needs the flip), the reader THEN
 * scrolls it down to the edge, and only then does its content change - and
 * nothing re-focuses, so nothing scrolls it back. That is the case the mount
 * measurement alone cannot see and the size observer can.
 *
 * It captures the viewport alone (clipViewport): the flip is a question about
 * the viewport's bottom edge, and a full-page capture expands the viewport
 * until there is no edge left to overflow.
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
	// Opened by a step that MEASURED its anchor, so the side it hangs on
	// belongs to this width; a sweep that narrowed the viewport afterwards
	// would judge a page the dashboard never builds.
	measuredAtOwnWidth: true,
};

export default fixture;
