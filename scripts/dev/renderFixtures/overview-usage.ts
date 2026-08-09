/**
 * The servers table's usage column across its shapes: ok/warn/error spend
 * percentages, a plain no-budget spend, and rows without usage data keeping
 * an empty cell (the external group and the misconfigured entry).
 */
import type { DashboardServer } from "../../../src/extension/dashboard/protocol.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, EXTERNAL_SERVER, GATEWAY_SERVER, MISCONFIGURED_SERVER, PROD_SERVER } from "./shared.ts";

const RESEARCH_SERVER: DashboardServer = {
	...PROD_SERVER,
	label: "research",
	baseUrl: "https://research.example.com",
	modelCount: 2,
};

const SANDBOX_SERVER: DashboardServer = {
	...PROD_SERVER,
	label: "sandbox",
	baseUrl: "http://localhost:4000",
	modelCount: 1,
	hasApiKey: false,
};

const fixture: RenderFixture = {
	messages: [
		{
			type: "state",
			state: baseState({
				servers: [PROD_SERVER, GATEWAY_SERVER, RESEARCH_SERVER, SANDBOX_SERVER, EXTERNAL_SERVER, MISCONFIGURED_SERVER],
			}),
		},
	],
	viewport: { width: 1300, height: 1200 },
};

export default fixture;
