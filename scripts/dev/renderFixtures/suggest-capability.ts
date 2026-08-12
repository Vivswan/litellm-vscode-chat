/**
 * The capability key input's suggestion listbox open (the datalist
 * replacement): the consumed vocabulary extended by the servers' observed
 * /model/info key names (sorted after the consumed block), directives last,
 * rendered in the catalog-results dropdown chrome at normal weight. The step
 * focuses the first capability-name input on the Settings tab.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: baseState({
				observedModelInfoKeys: ["mode", "litellm_provider", "base_model", "context_window", "max_pdf_size_mb"],
			}),
		},
		{ kind: "focusSection", section: "settings" },
	],
	steps: [
		// A fresh matcher opens the editor overlay; a fresh row's key input
		// anchors the suggestion listbox.
		`[...document.querySelectorAll("button")]
			.find((b) => b.textContent.trim() === "Add capability matcher")
			.click()`,
		`[...document.querySelectorAll(".matcher-editor button")]
			.find((b) => b.textContent.trim() === "Add capability")
			.click()`,
		// Typing "context" filters to both halves of the merged vocabulary -
		// the consumed context_length above the server-observed context_window
		// - so the screenshot shows the composition, not just one block.
		`(() => {
			const inputs = [...document.querySelectorAll("input[placeholder^='Capability']")];
			const input = inputs[inputs.length - 1];
			input.scrollIntoView({ block: "center" });
			input.focus();
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
			setter.call(input, "context");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		})()`,
	],
	viewport: { width: 1300, height: 900 },
	settleMs: 500,
};

export default fixture;
