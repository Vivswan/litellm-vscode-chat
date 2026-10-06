/**
 * The overview tab's two failure banners: the classified-failures banner mixing a hinted entry (headline + Troubleshoot
 * link) with an unhinted one (the "; " join seam), and the expected-failures banner mixing two expected errors (the
 * "(expected)" frame carries the headline). The rows carry causes; the banners render them.
 */
import type { DashboardServer } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, minutesAgoMs, NO_SECRETS, PROD_SERVER } from "./shared.ts";

const HINTED_404: DashboardServer = {
	origin: "declared",
	label: "prod-eu",
	baseUrl: "https://litellm-eu.example.com",
	servedModelCount: 0,
	credentials: "present",
	hasOAuth: false,
	hasVirtualKey: false,
	state: "error",
	cause: { kind: "transport", classification: { kind: "http", status: 404, setupHint: "check-base-url" } },
	lastChecked: minutesAgoMs(3),
	config: { secrets: NO_SECRETS },
};

const UNHINTED_418: DashboardServer = {
	origin: "declared",
	label: "beta",
	baseUrl: "http://beta.internal:4000",
	servedModelCount: 0,
	credentials: "present",
	hasOAuth: false,
	hasVirtualKey: false,
	state: "error",
	cause: { kind: "transport", classification: { kind: "http", status: 418 } },
	lastChecked: minutesAgoMs(4),
	config: { secrets: NO_SECRETS },
};

const EXPECTED_403: DashboardServer = {
	origin: "declared",
	label: "gateway",
	baseUrl: "https://gateway.internal",
	servedModelCount: 2,
	credentials: "present",
	hasOAuth: false,
	hasVirtualKey: false,
	state: "error",
	cause: { kind: "transport", classification: { kind: "http", status: 403 } },
	expected: true,
	declaredModelCount: 2,
	lastChecked: minutesAgoMs(6),
	config: { secrets: NO_SECRETS, declaredModels: ["gpt-5", "claude-sonnet-5"], expectedFailures: ["modelListing"] },
};

const EXPECTED_418: DashboardServer = {
	origin: "declared",
	label: "edge",
	baseUrl: "https://edge.internal",
	servedModelCount: 1,
	credentials: "absent",
	hasOAuth: false,
	hasVirtualKey: false,
	state: "error",
	cause: { kind: "transport", classification: { kind: "http", status: 418 } },
	expected: true,
	declaredModelCount: 1,
	lastChecked: minutesAgoMs(7),
	config: { secrets: NO_SECRETS, declaredModels: ["gpt-5-mini"], expectedFailures: ["modelListing"] },
};

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: baseState({
				servers: [PROD_SERVER, HINTED_404, UNHINTED_418, EXPECTED_403, EXPECTED_418],
			}),
		},
	],
	viewport: { width: 1300, height: 1500 },
};

export default fixture;
