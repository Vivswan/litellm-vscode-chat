/**
 * The Diagnostics tab with the merged inspector open IN PLACE: the
 * Resolved-models flat table's Inspect action opens the model panel
 * without leaving the tab, anchored on its Parameters section. The respond
 * map answers the resolved-models read and both of the inspector's own reads
 * (chains included).
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, RESOLVED_VIEW, worstCaseCapabilityFields } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "diagnostics" },
	],
	respond: {
		readResolvedModels: { kind: "response", payload: { view: RESOLVED_VIEW } },
		readModelParameters: {
			kind: "response",
			payload: {
				globalRecordKey: "gpt-5*",
				chains: [
					{
						layer: "global",
						links: [
							{ key: "*", barrier: false },
							{ key: "gpt-5*", barrier: true, inheritFrom: "false" },
						],
					},
				],
				projection: {
					rows: [
						{
							name: "temperature",
							value: 0.3,
							sent: true,
							source: { layer: "global", key: "gpt-5*" },
							shadowed: [],
						},
					],
					maxTokens: { source: "declared", value: 16384 },
					diagnostics: [],
				},
			},
		},
		readModelCapabilities: {
			kind: "response",
			payload: {
				globalRecordKey: "gpt-5*",
				capabilities: {
					// The shared worst case, not a hand-rolled subset: the full
					// eight-field cost family with sub-micro scientific values and
					// the 27-entry params list are what the inspector's capability
					// table has to stay readable against.
					fields: worstCaseCapabilityFields(),
					outputLimitSource: "provider",
					diagnostics: [],
				},
			},
		},
	},
	steps: [
		`[...document.querySelectorAll("table.resolved-models button")]
			.find((b) => b.textContent.trim() === "Inspect")
			.click()`,
	],
	viewport: { width: 1300, height: 1500 },
	settleMs: 500,
};

export default fixture;
