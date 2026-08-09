/**
 * A chip popover open INSIDE the server form's slide-over: anchored to the
 * fields cell so it fits the 460px panel (a chip-anchored popover would clip
 * past the panel's unreachable left edge).
 */
import type { DashboardServer, DashboardState } from "../../../src/extension/dashboard/protocol.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, MODELS, PROD_SERVER } from "./shared.ts";

const state: DashboardState = baseState({
	servers: [
		{
			...PROD_SERVER,
			config: {
				secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelParameters: {
					"gpt-5*": { temperature: 0.2, _force: ["temperature"] },
					"*": { top_p: 0.9, _inheritable: true },
				},
				budget: 50,
			},
		} as DashboardServer,
	],
	models: MODELS.filter((model) => model.serverLabel === "prod"),
});

const fixture: RenderFixture = {
	messages: [{ type: "state", state }],
	steps: [
		`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Edit").click()`,
		`(() => {
			const chips = [...document.querySelectorAll(".slide-over button.chip-field")]
				.filter((chip) => chip.querySelector(".chip-key")?.textContent === "temperature");
			chips[0].click();
		})()`,
	],
	viewport: { width: 1300, height: 950 },
	settleMs: 400,
};

export default fixture;
