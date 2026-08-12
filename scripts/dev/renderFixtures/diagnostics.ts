/**
 * The Diagnostics tab: connection summary with a misconfigured row,
 * Configuration diagnostics (record lints, entry problems, legacy hints,
 * dropped thresholds), and the Resolved-models tree + flat table (answered
 * through the harness's canned respond map).
 */
import type { DashboardState } from "../../../src/extension/dashboard/protocol.ts";
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
			problems: ["sets another auth form beside oauth; companions belong inside the oauth object"],
			misconfigured: true,
			severity: "warning",
		},
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
		{ type: "state", state },
		{ type: "focusSection", section: "diagnostics" },
	],
	respond: {
		readResolvedModels: { type: "resolvedModels", view: RESOLVED_VIEW },
	},
	viewport: { width: 1300, height: 1600 },
	settleMs: 500,
};

export default fixture;
