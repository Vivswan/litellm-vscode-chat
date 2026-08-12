/**
 * The server edit form's capability section over an open-vocabulary entry
 * record: prod's entry sets a cost field, supported_openai_params, and an
 * unknown supports_web_search key, with the server's observed /model/info
 * key set as the hint evidence. The caps matcher opens in the overlay so the
 * typed inputs, the applied-as-is hint, and the open-field fallback boxes
 * render inside the form's slide-over.
 */
import type { DashboardServer, DashboardState } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, MODELS, PROD_SERVER } from "./shared.ts";

const state: DashboardState = baseState({
	servers: [
		{
			...PROD_SERVER,
			observedModelInfoKeys: [
				"context_length",
				"input_cost_per_token",
				"litellm_provider",
				"max_output_tokens",
				"mode",
				"supported_openai_params",
			],
			config: {
				secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelCapabilities: {
					"gpt-5*": {
						input_cost_per_token: 0.00000175,
						supported_openai_params: ["temperature", "top_p", "max_tokens"],
						supports_web_search: true,
						supports_prompt_caching: true,
						_fallback: ["input_cost_per_token"],
					},
				},
			},
		} as DashboardServer,
	],
	models: MODELS.filter((model) => model.serverLabel === "prod"),
});

const fixture: RenderFixture = {
	messages: [{ kind: "push", state }],
	steps: [
		`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Edit").click()`,
		`document.querySelector('button[aria-label=\\'Open the full editor for "gpt-5*"\\']').click()`,
		`(() => {
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 1250 },
	settleMs: 400,
};

export default fixture;
