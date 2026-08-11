/**
 * The caps inspector popup with the configure-jump affordances: the
 * "Configure capabilities for this model" button and per-row "edit" actions
 * on record-sourced rows only (server-reported, catalog, derived, and floor
 * rows carry none). Renders the worst-case field bag - the full cost family,
 * the consumed booleans, the 27-element params list, an unknown extra - so
 * the sectioned layout is what this fixture reviews.
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
				diagnostics: [],
			},
		},
	},
	steps: ['[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Capabilities").click()'],
	viewport: { width: 1300, height: 1400 },
	settleMs: 500,
};

export default fixture;
