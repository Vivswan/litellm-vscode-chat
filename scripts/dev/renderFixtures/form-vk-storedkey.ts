/**
 * The server form, virtual-key shape with a STORED API key: block-and-tell -
 * the picked form does not send the stored key, so the warn line and Remove
 * checkbox render and Save refuses until it is removed or the form switches back.
 */
import type { DashboardServer, DashboardState } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, PROD_SERVER, provenSecrets } from "./shared.ts";

const state: DashboardState = baseState({
	servers: [
		{
			...PROD_SERVER,
			label: "vk-gateway",
			config: {
				secrets: provenSecrets({ apiKey: "secure", virtualKeyValue: "secure" }),
				virtualKeyHeader: "x-litellm-api-key",
			},
		} as DashboardServer,
	],
	models: [],
});

const fixture: RenderFixture = {
	messages: [{ kind: "push", state }],
	steps: [
		`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Edit").click()`,
		// The derived form for header+stored-value is the virtual-key shape? A
		// stored apiKey ranks it as the API-key form; flip to the virtual-key
		// form so the stored-key activation hint renders.
		`Array.from(document.querySelectorAll(".auth-selector label")).find((l) => l.textContent.includes("Virtual key")).querySelector("input").click()`,
	],
	viewport: { width: 1300, height: 1800 },
	settleMs: 400,
};

export default fixture;
