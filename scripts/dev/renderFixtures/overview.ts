/**
 * The overview tab under load: declared, expected-failure, misconfigured, and
 * external rows; notices and banners; the models table with a declared badge.
 */
import type { DashboardServer } from "../../../src/extension/dashboard/protocol.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, EXTERNAL_SERVER, GATEWAY_SERVER, MISCONFIGURED_SERVER, PROD_SERVER } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{
			type: "state",
			state: baseState({
				servers: [
					PROD_SERVER,
					GATEWAY_SERVER,
					MISCONFIGURED_SERVER,
					EXTERNAL_SERVER,
					{
						...PROD_SERVER,
						label: "renamed",
						baseUrl: "https://old.example.com",
						state: "ok",
						modelCount: 1,
						notices: ["entry-params-inactive", "entry-headers-inactive", "entry-api-version-inactive"],
					} as DashboardServer,
				],
				hiddenGroups: [{ label: "old-staging", baseUrl: "http://staging.example:4000" }],
			}),
		},
	],
	viewport: { width: 1300, height: 1600 },
};

export default fixture;
