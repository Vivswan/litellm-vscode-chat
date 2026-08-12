/** The server form, OAuth shape with companions (X-API-Key rider + virtual-key header). */
import type { DashboardServer, DashboardState } from "../../../src/dashboard/protocol.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, GATEWAY_SERVER } from "./shared.ts";

const state: DashboardState = baseState({
	servers: [
		{
			...GATEWAY_SERVER,
			config: {
				secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
				oauthTokenUrl: "https://idp.example.com/oauth2/token",
				oauthClientId: "litellm-vscode",
				oauthScopes: "litellm.read litellm.write",
				virtualKeyHeader: "x-litellm-api-key",
				expectedFailures: ["modelListing", "modelInfo"],
				declaredModels: ["deepseek-r1", "qwen2.5-vl-72b"],
			},
		} as DashboardServer,
	],
	models: [],
});

const fixture: RenderFixture = {
	messages: [{ type: "state", state }],
	steps: [`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Edit").click()`],
	viewport: { width: 1300, height: 2400 },
	settleMs: 400,
};

export default fixture;
