/** The server form's API version disclosure: custom "v2" prefill, disclosure open with the select and input. */
import type { DashboardServer, DashboardState } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, MODELS, PROD_SERVER } from "./shared.ts";

const state: DashboardState = baseState({
	servers: [
		{
			...PROD_SERVER,
			config: {
				...PROD_SERVER.config,
				apiVersion: "v2",
			},
		} as DashboardServer,
	],
	models: MODELS.filter((model) => model.serverLabel === "prod"),
});

const fixture: RenderFixture = {
	messages: [{ kind: "push", state }],
	steps: [`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Edit").click()`],
	viewport: { width: 1300, height: 2200 },
	settleMs: 400,
};

export default fixture;
