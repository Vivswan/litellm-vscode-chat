/**
 * A FailureNote in the Model parameters record editor: the footer's message slot
 * speaking the refusal, the edits-kept frame around the message HEADLINE only,
 * inline beside the bar's buttons. The steps make the draft dirty and Apply it;
 * the respond map answers the posted setModelParameters with its correlated fail
 * envelope, which returns the draft dirty and marks the slot.
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
		// Close the matcher editor overlay Add opened: the refusal lands in the
		// FOOTER's message slot, and the shot must show that slot, not the
		// overlay standing over it.
		`[...document.querySelectorAll(".matcher-editor button")]
			.find((b) => b.textContent.trim() === "Done")
			.click()`,
		// Apply posts the draft; the respond map fails it, so the note renders
		// over the still-dirty draft. The wait lets the async fail envelope land.
		`(() => {
			[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Apply").click();
			return new Promise((resolve) => setTimeout(resolve, 50));
		})()`,
		// The fixture's own subject, asserted: a run that never grew the refusal
		// note must fail rather than photograph a quiet editor.
		`(() => {
			const note = document.querySelector(".record-frame .failure-note.error");
			if (note === null || !note.textContent.includes("rejected")) {
				throw new Error("no refusal note is speaking in the params frame");
			}
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
