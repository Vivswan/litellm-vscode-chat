/**
 * The Models destination filtered to nothing: a pressed family pill plus a
 * text needle from another family, so the shot shows the one-sentence empty
 * state with its clear-filters action beside it.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, GATEWAY_SERVER, MODELS, PROD_SERVER } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: baseState({
				servers: [PROD_SERVER, GATEWAY_SERVER],
				models: [...MODELS],
			}),
		},
		{ kind: "focusSection", section: "models" },
	],
	steps: [
		`(() => {
			const pill = Array.from(document.querySelectorAll("button.filter-pill")).find(
				(button) => button.textContent === "claude"
			);
			if (!pill) { throw new Error("no filter pill labelled claude"); }
			pill.click();
			const input = document.querySelector("input[aria-label='Filter models']");
			if (!input) { throw new Error("no filter input"); }
			// React reads the value through its own setter, so a controlled input
			// only notices the change when the prototype setter writes it.
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
			setter.call(input, "deepseek");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 700 },
};

export default fixture;
