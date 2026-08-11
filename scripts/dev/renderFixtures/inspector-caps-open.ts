/**
 * The caps inspector over an OPEN vocabulary resolution, diagnostics
 * included: the worst-case field bag (the full Anthropic-style cost family
 * with sub-micro values, the three consumed booleans, the 27-element
 * supported_openai_params list, an unknown supports_web_search override,
 * mixed provenance across every level) plus one advisory unrecognized-key
 * note rendered apart from a real invalid-value problem.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, worstCaseCapabilityFields } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [{ type: "state", state: baseState() }],
	respond: {
		readModelCapabilities: {
			type: "modelCapabilities",
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
	steps: ['[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Capabilities").click()'],
	viewport: { width: 1300, height: 1500 },
	settleMs: 500,
};

export default fixture;
