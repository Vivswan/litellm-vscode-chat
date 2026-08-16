/**
 * The servers page's endpoint-declaration hints (#261): an ok row whose
 * model-info probe looked unserved (the quiet advisory with the Declare expected
 * failure action, armed to its confirm step below), and an error row whose
 * models listing looked unserved while model-info answered.
 *
 * In frame: the advisory reading as the quiet tier, the armed confirm pair
 * inline without wrapping the page, and the error row's action cluster carrying
 * four actions without crowding.
 */
import type { DashboardServer } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, PROD_SERVER } from "./shared.ts";

const OLLAMA_ROW: DashboardServer = {
	origin: "declared",
	label: "ollama",
	baseUrl: "http://localhost:11434",
	modelCount: 4,
	hasApiKey: false,
	hasOAuth: false,
	state: "ok",
	modelInfoUnsupported: "timeout",
	lastChecked: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
	config: { secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } },
};

const LISTING_UNSERVED_ROW: DashboardServer = {
	origin: "declared",
	label: "bare-gateway",
	baseUrl: "https://gateway.example.com",
	modelCount: 0,
	hasApiKey: true,
	hasOAuth: false,
	state: "error",
	error:
		'The models listing failed, but this server answers. If it never serves the models listing, declare that on the "bare-gateway" entry: "expectedFailures": ["modelListing"], with model IDs in "discovery.declared".\nGET https://gateway.example.com/v1/models answered HTTP 404; model info answered',
	errorEnglish:
		'The models listing failed, but this server answers. If it never serves the models listing, declare that on the "bare-gateway" entry: "expectedFailures": ["modelListing"], with model IDs in "discovery.declared".\nGET https://gateway.example.com/v1/models answered HTTP 404; model info answered',
	classification: { kind: "http", status: 404, unsupportedEndpoint: "modelListing" },
	lastChecked: new Date(Date.now() - 60 * 1000).toISOString(),
	config: { secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" } },
};

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: baseState({ servers: [OLLAMA_ROW, LISTING_UNSERVED_ROW, PROD_SERVER] }),
		},
	],
	steps: [
		// Arm the advisory's declare control so the confirm pair is in frame.
		`Array.from(document.querySelectorAll(".row-diagnostic-actions button")).find((b) => b.textContent.trim() === "Declare expected failure")?.click()`,
	],
	viewport: { width: 1300, height: 1100 },
};

export default fixture;
