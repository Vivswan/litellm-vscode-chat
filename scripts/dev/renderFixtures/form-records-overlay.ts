/**
 * The matcher editor overlay ABOVE the server form's slide-over: the entry's
 * gpt-5* parameters record opened through its pencil, stacking a second
 * panel (own scrim) over the form.
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
		`document.querySelector('button[aria-label=\\'Open the full editor for "gpt-5*"\\']').click()`,
		`(() => {
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 950 },
	settleMs: 400,
};

export default fixture;
