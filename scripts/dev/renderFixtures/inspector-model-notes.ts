/**
 * The merged model inspector with capability diagnostics: the same worst-case
 * field bag as inspector-model, plus one advisory unrecognized-key note
 * rendered apart from a real invalid-value problem (both close the
 * Capabilities section, before Pricing), while the parameters feed stays
 * unanswered - the panel's per-feed loading state is part of what this
 * fixture reviews.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, worstCaseCapabilityFields } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [{ kind: "push", state: baseState() }],
	respond: {
		readModelCapabilities: {
			kind: "response",
			payload: {
				globalRecordKey: "gpt-5*",
				capabilities: {
					fields: worstCaseCapabilityFields(),
					outputLimitSource: "provider",
					diagnostics: [
						{ kind: "unrecognized-key", key: "supports_web_search", layer: "global", recordKey: "gpt-5*" },
						{ kind: "invalid-value", key: "output_cost_per_token", layer: "global", recordKey: "gpt-5*" },
					],
				},
			},
		},
	},
	steps: ['[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Inspect").click()'],
	viewport: { width: 1300, height: 2200 },
	settleMs: 500,
};

export default fixture;
