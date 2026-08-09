/**
 * The Diagnostics tab with an inspector overlay open IN PLACE: the
 * Resolved-models flat table's Parameters action opens the effective-values
 * slide-over without leaving the tab. The respond map answers both the
 * resolved-models read and the inspector's own read (chains included).
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, RESOLVED_VIEW } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ type: "state", state: baseState() },
		{ type: "focusSection", section: "diagnostics" },
	],
	respond: {
		readResolvedModels: { type: "resolvedModels", view: RESOLVED_VIEW },
		readModelParameters: {
			type: "modelParameters",
			entryLabel: "prod",
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
	steps: [
		`[...document.querySelectorAll("table.resolved-models button")]
			.find((b) => b.textContent.trim() === "Parameters")
			.click()`,
	],
	viewport: { width: 1300, height: 1100 },
	settleMs: 500,
};

export default fixture;
