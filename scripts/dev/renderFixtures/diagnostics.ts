/**
 * The Diagnostics destination: the Configuration section ranking record lints,
 * legacy leftovers, an accepted entry's ignored pieces and a dropped threshold
 * across the three severity tiers, the Resolution tree + flat table (answered
 * through the harness's canned respond map), and the support tools.
 *
 * Two diagnostics are deliberately NOT rendered - the misconfigured entry and
 * the hidden groups, both reported by a Servers row instead. They stay in the
 * fixture so a render shows that the page refuses to repeat them.
 */
import type { DashboardState } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import {
	baseState,
	EXTERNAL_SERVER,
	GATEWAY_SERVER,
	MISCONFIGURED_SERVER,
	PROD_SERVER,
	RESOLVED_VIEW,
} from "./shared.ts";

const state: DashboardState = baseState({
	servers: [PROD_SERVER, GATEWAY_SERVER, MISCONFIGURED_SERVER, EXTERNAL_SERVER],
	diagnostics: [
		{
			kind: "record",
			setting: "models.parameters",
			diagnostic: { kind: "invalid-matcher", recordKey: "gpt*5", key: "gpt*5" },
			severity: "warning",
		},
		{
			kind: "record",
			setting: "models.parameters",
			entryLabel: "prod",
			diagnostic: { kind: "unknown-inherit-key", recordKey: "gpt-5.6", key: "gtp-5*" },
			severity: "warning",
		},
		{
			kind: "record",
			setting: "models.parameters",
			diagnostic: { kind: "unforceable-key", recordKey: "gpt-5*", key: "messages" },
			severity: "warning",
		},
		{
			kind: "record",
			setting: "models.capabilities",
			diagnostic: { kind: "unrecognized-key", recordKey: "gpt-5*", key: "supports_web_search" },
			severity: "advisory",
		},
		{
			kind: "entry",
			label: "broken",
			position: 3,
			problems: ["has auth.apiKey beside auth.oauth; move it to auth.oauth.apiKey"],
			misconfigured: true,
			rowOwned: true,
			severity: "warning",
		},
		{
			kind: "entry",
			position: 5,
			problems: ["no usable label"],
			misconfigured: true,
			rowOwned: false,
			severity: "warning",
		},
		{
			kind: "entry",
			label: "gateway",
			position: 2,
			problems: ["dropped an unknown discovery key"],
			misconfigured: false,
			rowOwned: false,
			severity: "warning",
		},
		{ kind: "hidden-groups", labels: ["retired-eu"], severity: "warning" },
		{
			kind: "legacy",
			hint: "inert-url-scoped-key",
			oldKey: "https://litellm.example.com/gpt-4",
			detail: "models.parameters",
			severity: "warning",
		},
		{
			kind: "legacy",
			hint: "parked-global-headers",
			oldKey: "headers",
			detail: "x-routing-env, x-trace-source",
			severity: "warning",
		},
		{ kind: "thresholds", dropped: 1, severity: "warning" },
	],
});

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state },
		{ kind: "focusSection", section: "diagnostics" },
	],
	respond: {
		readResolvedModels: { kind: "response", payload: { view: RESOLVED_VIEW } },
	},
	// The focusSection message above is the real deep link and is what the
	// product uses; this click is belt-and-braces for the HARNESS only, whose
	// synchronous dispatch can land focusSection before React has committed the
	// first state render. A real webview delivers the two posts as separate
	// tasks, so the deep link works there (tabs.test.tsx pins it).
	steps: [`document.getElementById("tab-diagnostics")?.click()`],
	viewport: { width: 1300, height: 1600 },
	settleMs: 500,
};

export default fixture;
