/**
 * A FailureNote in the Model parameters record editor: the fixed headline
 * ("Saving failed - your edits are kept...") with the extension's message
 * rendered verbatim as its own line through FailureText. The steps make the
 * draft dirty and Apply it; the respond map answers the posted
 * setModelParameters with its correlated fail envelope, which returns the
 * draft dirty and renders the note.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "settings" },
	],
	respond: {
		setModelParameters: {
			kind: "fail",
			message:
				'The write to models.parameters was rejected.\nsetting litellm-vscode-chat.models.parameters: "o4-mini*" refused by configuration target',
			failureKind: "validation",
		},
	},
	steps: [
		`[...document.querySelectorAll("button")]
			.find((b) => b.textContent.trim() === "Add model matcher")
			.click()`,
		`(() => {
			const input = [...document.querySelectorAll("input[placeholder^='Model ID or matcher']")]
				.find((el) => el.value === "" && !el.disabled);
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
			setter.call(input, "o4-mini*");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		})()`,
		// Apply posts the draft; the respond map fails it, so the note renders
		// over the still-dirty draft. The wait lets the async fail envelope land.
		`(() => {
			[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Apply").click();
			return new Promise((resolve) => setTimeout(resolve, 50));
		})()`,
		// Pinned to the top: the sticky tab bar repaints at the scroll offset in
		// full-page captures, so a scrolled capture shows it twice.
		`(() => {
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 900 },
	settleMs: 500,
};

export default fixture;
