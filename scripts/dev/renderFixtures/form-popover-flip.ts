/**
 * The same bottom-edge flip as record-popover-flip, inside the server form's
 * panel - a different geometry, not a second copy of the same one: in a
 * slide-over the popover is positioned against the row's field LIST rather
 * than the chip itself (a chip-anchored popover can fall past the panel's
 * unreachable left edge), so the box the flip measures and moves against is
 * a different element here.
 *
 * It captures the viewport alone, for the reason record-popover-flip gives.
 */
import type { DashboardServer, DashboardState } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, MODELS, PROD_SERVER } from "./shared.ts";

const state: DashboardState = baseState({
	servers: [
		{
			...PROD_SERVER,
			config: {
				secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelCapabilities: { "deepseek-r1": { context_length: 131072 } },
				modelParameters: { "gpt-5*": { temperature: 0.2 } },
			},
		} as DashboardServer,
	],
	models: MODELS.filter((model) => model.serverLabel === "prod"),
});

const fixture: RenderFixture = {
	messages: [{ kind: "push", state }],
	steps: [
		`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Edit").click()`,
		`(() => {
			const adds = [...document.querySelectorAll(".slide-over button.chip-add")];
			const add = adds[adds.length - 1];
			add.scrollIntoView({ block: "end" });
			add.click();
		})()`,
		`(() => {
			// The panel is its own scrollport, so the reader's scroll is the
			// panel's, not the window's.
			const panel = document.querySelector(".slide-over");
			const input = document.querySelector(".chip-popover input");
			panel.scrollTop += input.getBoundingClientRect().bottom - (window.innerHeight - 20);
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
};

export default fixture;
