/**
 * The Diagnostics tab's OutcomeGrid with the redesigned errors: a two-part
 * unexpected error rendered headline-over-dimmed-detail in the note cell, an
 * expected two-part error carrying its "(expected)" annotation on the
 * headline line, and a healthy row for contrast.
 */
import type { DashboardServer, DashboardState } from "../../../src/extension/dashboard/protocol.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, minutesAgoIso, NO_SECRETS, PROD_SERVER } from "./shared.ts";

const TWO_PART_ERROR: DashboardServer = {
	origin: "declared",
	label: "prod-eu",
	baseUrl: "https://litellm-eu.example.com",
	modelCount: 0,
	hasApiKey: true,
	hasOAuth: false,
	state: "error",
	error:
		"Could not reach https://litellm-eu.example.com to list its models. Check your network, VPN, or proxy settings, and that the server is up.\nfetch failed (cause: getaddrinfo ENOTFOUND litellm-eu.example.com)",
	classification: { kind: "network" },
	lastChecked: minutesAgoIso(2),
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
	lastChecked: minutesAgoIso(5),
	config: { secrets: NO_SECRETS, declaredModels: ["gpt-5", "claude-sonnet-5"], expectedFailures: ["modelListing"] },
};

const state: DashboardState = baseState({
	servers: [PROD_SERVER, TWO_PART_ERROR, EXPECTED_TWO_PART],
});

const fixture: RenderFixture = {
	messages: [
		{ type: "state", state },
		{ type: "focusSection", section: "diagnostics" },
	],
	viewport: { width: 1300, height: 1200 },
	settleMs: 500,
};

export default fixture;
