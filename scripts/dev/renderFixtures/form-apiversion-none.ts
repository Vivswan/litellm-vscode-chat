/** The server form's API version disclosure: "" (No version) prefill, open with the None choice selected. */
import type { DashboardServer, DashboardState } from "../../../src/dashboard/protocol.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, MODELS, PROD_SERVER } from "./shared.ts";

const state: DashboardState = baseState({
	servers: [
		{
			...PROD_SERVER,
			config: {
				...PROD_SERVER.config,
				apiVersion: "",
			},
		} as DashboardServer,
	],
	models: MODELS.filter((model) => model.serverLabel === "prod"),
});

const fixture: RenderFixture = {
	messages: [{ type: "state", state }],
	steps: [`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Edit").click()`],
	viewport: { width: 1300, height: 2200 },
	settleMs: 400,
};

export default fixture;
