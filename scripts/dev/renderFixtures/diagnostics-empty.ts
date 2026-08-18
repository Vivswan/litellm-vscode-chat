/**
 * The Diagnostics destination at rest on a fresh, healthy install: zero
 * configuration diagnostics, a resolution with no matcher records and no
 * discovered models (both empty-state sentences), and the support tools. The
 * page most readers open, and the only fixture photographing its three quiet
 * states together. Server errors belong to the servers fixtures, since that grid
 * moved to the Servers destination; this page's worst case is diagnostics.ts.
 */
import type { DashboardState } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, NO_SECRETS } from "./shared.ts";

// A just-declared server before its first sync: nothing checked, nothing
// discovered, no records written - the state every empty sentence below is
// about. Usage and the record maps are empty too: a rail wearing spend, or a
// Settings destination showing four matcher records, would contradict "no
// matcher records configured" one tab away.
const base = baseState({
	servers: [
		{
			origin: "declared",
			label: "prod",
			baseUrl: "https://litellm.example.com",
			servedModelCount: 0,
			hasApiKey: true,
			hasOAuth: false,
			state: "unchecked",
			config: { secrets: NO_SECRETS },
		},
	],
	models: [],
	diagnostics: [],
});

const state: DashboardState = {
	...base,
	usage: { ...base.usage, servers: [] },
	settings: {
		...base.settings,
		modelParameters: { ...base.settings.modelParameters, value: {}, effective: {} },
		modelCapabilities: { ...base.settings.modelCapabilities, value: {}, effective: {} },
	},
};

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state },
		{ kind: "focusSection", section: "diagnostics" },
	],
	respond: {
		readResolvedModels: { kind: "response", payload: { view: { trees: [], rows: [], recordCount: 0 } } },
	},
	viewport: { width: 1300, height: 900 },
	settleMs: 500,
};

export default fixture;
