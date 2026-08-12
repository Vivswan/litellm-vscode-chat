/**
 * The per-entry record tables inside the server edit form: prod's entry
 * carries model parameters AND capabilities, so both disclosures open with
 * their compact matcher tables (chips wrap in the narrow panel).
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
				headers: { "x-routing-env": "prod" },
				modelParameters: {
					"gpt-5*": { temperature: 0.2, _force: ["temperature"] },
					"*": { top_p: 0.9, _inheritable: true },
				},
				modelCapabilities: {
					"deepseek-r1": { context_length: 131072, supports_vision: false },
					"my-alias": { _openrouter_model: "anthropic/claude-sonnet-4" },
				},
				budget: 50,
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
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 2400 },
	settleMs: 400,
};

export default fixture;
