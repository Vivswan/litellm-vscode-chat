/** The server form, API-key shape: bearer key + virtual-key companion, headers, discovery, budget, MCP. */
import type { DashboardServer, DashboardState } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, MODELS, PROD_SERVER, provenSecrets } from "./shared.ts";

const state: DashboardState = baseState({
	servers: [
		{
			...PROD_SERVER,
			config: {
				secrets: provenSecrets({ apiKey: "secure", virtualKeyValue: "secure" }),
				virtualKeyHeader: "x-litellm-api-key",
				headers: { "x-routing-env": "prod", "x-trace-source": "vscode" },
				modelParameters: { "gpt-5*": { temperature: 0.2, _force: ["temperature"] } },
				declaredModels: ["deepseek-r1"],
				expectedFailures: ["modelInfo"],
				budget: 50,
				mcp: { url: "https://litellm.example.com/tools/mcp" },
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
