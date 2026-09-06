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
import { baseState, PROD_SERVER, provenSecrets } from "./shared.ts";

const OLLAMA_ROW: DashboardServer = {
	origin: "declared",
	label: "ollama",
	baseUrl: "http://localhost:11434",
	servedModelCount: 4,
	credentials: "absent",
	hasOAuth: false,
	state: "ok",
	modelInfoUnsupported: "timeout",
	lastChecked: Date.now() - 3 * 60 * 1000,
	config: { secrets: provenSecrets() },
};

/** The unserved-listing hint as the engine words it, localized and English alike. */
const BARE_GATEWAY_ERROR =
	"The models listing failed, but this server answers. If it never serves the models listing, declare that on the " +
	'"bare-gateway" entry: "expectedFailures": ["modelListing"], with model IDs in "discovery.declared".\n' +
	"GET https://gateway.example.com/v1/models answered HTTP 404; model info answered";

const LISTING_UNSERVED_ROW: DashboardServer = {
	origin: "declared",
	label: "bare-gateway",
	baseUrl: "https://gateway.example.com",
	servedModelCount: 0,
	credentials: "present",
	hasOAuth: false,
	state: "error",
	error: BARE_GATEWAY_ERROR,
	errorEnglish: BARE_GATEWAY_ERROR,
	classification: { kind: "http", status: 404, unsupportedEndpoint: "modelListing" },
	lastChecked: Date.now() - 60 * 1000,
	config: { secrets: provenSecrets({ apiKey: "secure" }) },
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
