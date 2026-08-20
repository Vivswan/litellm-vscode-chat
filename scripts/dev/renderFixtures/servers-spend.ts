/**
 * The merged Servers page with a row in every spend state: healthy under budget
 * (prod, 42%), warning (gateway, 87%), over budget AND stale with a failed
 * refresh (research, 112%), spend with no budget (sandbox), a denied key
 * (locked-down, the user-ruled DEGRADED diagnostic), an external row with no
 * usage join, and a misconfigured entry.
 *
 * In frame: the spend units' percent-over-meter shape lined up down the page,
 * the empty spend cells on the external and misconfigured rows, the header meta
 * counting the one list, and the diagnostic tiers ranked under their rows.
 */
import type { DashboardServer } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import {
	baseState,
	EXTERNAL_SERVER,
	GATEWAY_SERVER,
	MISCONFIGURED_SERVER,
	minutesAgoIso,
	PROD_SERVER,
} from "./shared.ts";

const RESEARCH_SERVER: DashboardServer = {
	...PROD_SERVER,
	label: "research",
	baseUrl: "https://research.example.com",
	servedModelCount: 2,
	lastChecked: minutesAgoIso(25),
};

const SANDBOX_SERVER: DashboardServer = {
	...PROD_SERVER,
	label: "sandbox",
	baseUrl: "http://localhost:4000",
	servedModelCount: 1,
	credentials: "absent",
	lastChecked: minutesAgoIso(2),
};

const LOCKED_SERVER: DashboardServer = {
	...PROD_SERVER,
	label: "locked-down",
	baseUrl: "https://locked.example.com",
	servedModelCount: 4,
	lastChecked: minutesAgoIso(4),
};

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: baseState({
				servers: [
					PROD_SERVER,
					GATEWAY_SERVER,
					RESEARCH_SERVER,
					SANDBOX_SERVER,
					LOCKED_SERVER,
					EXTERNAL_SERVER,
					MISCONFIGURED_SERVER,
				],
			}),
		},
	],
	viewport: { width: 1300, height: 1500 },
};

export default fixture;
