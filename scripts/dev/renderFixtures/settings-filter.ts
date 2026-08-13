/**
 * The Settings tab with a filter typed in: the rows that do not match hide via
 * the hidden attribute, never by unmounting, so a half-typed draft survives
 * being filtered away and back. The shot exists because the hiding is a
 * cascade question - a row carrying a display utility ignores the user agent's
 * own [hidden] rule - and the component suites run in a DOM with no cascade.
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
			const filter = document.querySelector('input[aria-label="Filter settings"]');
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
			setter.call(filter, "timeout");
			filter.dispatchEvent(new Event("input", { bubbles: true }));
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 700 },
};

export default fixture;
