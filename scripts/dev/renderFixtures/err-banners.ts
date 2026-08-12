/**
 * The overview tab's two failure banners under the redesigned two-part
 * errors: the classified-failures banner mixing a two-part entry (headline +
 * dimmed detail + Troubleshoot link) with a single-line one (the "; " join
 * seam), and the expected-failures banner mixing a two-part and a
 * single-line expected error (the "(expected)" frame carries the headline).
 */
import type { DashboardServer } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, minutesAgoIso, NO_SECRETS, PROD_SERVER } from "./shared.ts";

const TWO_PART_404: DashboardServer = {
	origin: "declared",
	label: "prod-eu",
	baseUrl: "https://litellm-eu.example.com",
	modelCount: 0,
	hasApiKey: true,
	hasOAuth: false,
	state: "error",
	error:
		"The server replied, but not with a model list - this address may not be a LiteLLM proxy. Check the base URL: the extension appends /v1 unless the URL already ends in a version segment like /v1 or /v2; LiteLLM's default port is 4000.\nUnparseable response from https://litellm-eu.example.com/v1/models: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
	classification: { kind: "http", status: 404, setupHint: "check-base-url" },
	lastChecked: minutesAgoIso(3),
	config: { secrets: NO_SECRETS },
};

const SINGLE_LINE_REFUSED: DashboardServer = {
	origin: "declared",
	label: "beta",
	baseUrl: "http://beta.internal:4000",
	modelCount: 0,
	hasApiKey: true,
	hasOAuth: false,
	state: "error",
	error: "The server refused the model-list request.",
	classification: { kind: "http", status: 418 },
	lastChecked: minutesAgoIso(4),
	config: { secrets: NO_SECRETS },
};

const EXPECTED_TWO_PART: DashboardServer = {
	origin: "declared",
	label: "gateway",
	baseUrl: "https://gateway.internal",
	modelCount: 0,
	hasApiKey: true,
	hasOAuth: false,
	state: "error",
	error:
		"This key is not allowed to list the server's models.\nLiteLLM 403 auth_error: key missing /model/info permission",
	expected: true,
	declaredModelCount: 2,
	lastChecked: minutesAgoIso(6),
	config: { secrets: NO_SECRETS, declaredModels: ["gpt-5", "claude-sonnet-5"], expectedFailures: ["modelListing"] },
};

const EXPECTED_SINGLE_LINE: DashboardServer = {
	origin: "declared",
	label: "edge",
	baseUrl: "https://edge.internal",
	modelCount: 0,
	hasApiKey: false,
	hasOAuth: false,
	state: "error",
	error: "The server refused the model-list request.",
	expected: true,
	declaredModelCount: 1,
	lastChecked: minutesAgoIso(7),
	config: { secrets: NO_SECRETS, declaredModels: ["gpt-5-mini"], expectedFailures: ["modelListing"] },
};

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: baseState({
				servers: [PROD_SERVER, TWO_PART_404, SINGLE_LINE_REFUSED, EXPECTED_TWO_PART, EXPECTED_SINGLE_LINE],
			}),
		},
	],
	viewport: { width: 1300, height: 1500 },
};

export default fixture;
