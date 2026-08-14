/**
 * The Models destination with structured filter pills pressed: one family and
 * one capability, composed AND, so the shot shows the pressed (filled) pill
 * state beside resting (outline) siblings, the live "showing N of M" count
 * mid-narrowing, and the clear-all action that appears with the first press.
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
		// Throw on a missing pill rather than photograph an unfiltered page that
		// claims to show the filtered one.
		`(() => {
			const pill = (text) => {
				const node = Array.from(document.querySelectorAll("button.filter-pill")).find(
					(button) => button.textContent === text
				);
				if (!node) { throw new Error("no filter pill labelled " + text); }
				return node;
			};
			pill("gpt").click();
			pill("vision").click();
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 700 },
};

export default fixture;
