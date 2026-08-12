/**
 * The global capabilities editor over an open-vocabulary record: the gpt-5.6
 * matcher carries an unknown field (supports_web_search, hinted against the
 * observed /model/info union), a cost field (decimal number input allowing
 * 0), and supported_openai_params (JSON list input), opened in the full
 * matcher editor overlay so the typed value controls, the hint, and the
 * open-field fallback checkboxes are all on screen.
 */
import type { DashboardState } from "../../../src/dashboard/protocol.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const capabilitiesValue = {
	"*": { _inheritable: true, _fallback: ["context_length"], context_length: 131072 },
	"gpt-5.6": {
		input_cost_per_token: 0.00000175,
		supported_openai_params: ["temperature", "top_p", "max_tokens"],
		supports_web_search: true,
		supports_prompt_caching: true,
	},
};

const base = baseState();
const state: DashboardState = {
	...base,
	// The cross-server union of observed /model/info keys: the evidence behind
	// the unknown-key hint on supports_web_search (the union does not name it).
	observedModelInfoKeys: ["context_length", "input_cost_per_token", "litellm_provider", "max_output_tokens", "mode"],
	settings: {
		...base.settings,
		modelCapabilities: {
			editScope: "global",
			value: capabilitiesValue,
			otherScopes: [],
			effective: capabilitiesValue,
		},
	},
};

const fixture: RenderFixture = {
	messages: [
		{ type: "state", state },
		{ type: "focusSection", section: "settings" },
	],
	steps: [
		`document.querySelector('button[aria-label=\\'Open the full editor for "gpt-5.6"\\']').click()`,
		`(() => {
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 1250 },
	settleMs: 400,
};

export default fixture;
