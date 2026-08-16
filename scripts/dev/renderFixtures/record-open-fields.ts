/**
 * The global capabilities editor over an open-vocabulary record at full density:
 * a genuinely LONG regex matcher key carries the shared worst case (the
 * eight-field cost family with sub-micro scientific values, the 27-entry
 * supported_openai_params JSON-list input) plus an unknown field hinted against
 * the observed /model/info union, opened in the matcher editor overlay so the
 * typed value controls, the hint, and the open-field fallback checkboxes are all
 * on screen. The shorter gpt-5.6 record stays behind it for both key lengths.
 */
import type { DashboardState } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, LONG_MATCHER_KEY, worstCaseRecordFields } from "./shared.ts";

const capabilitiesValue = {
	"*": { _inheritable: true, _fallback: ["context_length"], context_length: 131072 },
	"gpt-5.6": {
		input_cost_per_token: 0.00000175,
		supports_prompt_caching: true,
	},
	[LONG_MATCHER_KEY]: {
		...worstCaseRecordFields(),
		supports_web_search: true,
		supports_prompt_caching: true,
	},
};

const base = baseState();
const state: DashboardState = {
	...base,
	// The cross-server union of observed /model/info keys: the evidence behind
	// the unknown-key hint on supports_web_search (the union does not name it).
	observedModelInfoKeys: [
		"context_length",
		"input_cost_per_token",
		"litellm_provider",
		"max_output_tokens",
		"mode",
		"supported_openai_params",
	],
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
		{ kind: "push", state },
		{ kind: "focusSection", section: "settings" },
	],
	steps: [
		// The long key holds backslashes and quotes no attribute selector
		// survives, so the opener is found by scanning and THROWS when absent -
		// a step that opens nothing must not exit 0 behind a large PNG.
		`(() => {
			const opener = [...document.querySelectorAll("button")].find((button) =>
				(button.getAttribute("aria-label") ?? "").includes('Open the full editor for "/^(openrouter')
			);
			if (!opener) { throw new Error("no full-editor opener for the long regex matcher key"); }
			opener.click();
		})()`,
		`(() => {
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 1250 },
	settleMs: 400,
};

export default fixture;
