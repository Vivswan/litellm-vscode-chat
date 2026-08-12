/**
 * The Diagnostics tab with the merged inspector open IN PLACE: the
 * Resolved-models flat table's Parameters action opens the model panel
 * without leaving the tab, anchored on its Parameters section. The respond
 * map answers the resolved-models read and both of the inspector's own reads
 * (chains included).
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
		readModelCapabilities: {
			type: "modelCapabilities",
			globalRecordKey: "gpt-5*",
			capabilities: {
				fields: {
					context_length: { value: 272000, level: "server", shadowed: [] },
					max_input_tokens: { value: 255616, level: "derived", shadowed: [] },
					max_output_tokens: { value: 16384, level: "server", shadowed: [] },
					supports_function_calling: { value: true, level: "server", shadowed: [] },
					supports_vision: { value: true, level: "server", shadowed: [] },
					supports_reasoning: { value: true, level: "server", shadowed: [] },
					supports_audio_input: { value: false, level: "floor", shadowed: [] },
					input_cost_per_token: { value: 0.00000175, level: "server", shadowed: [] },
					output_cost_per_token: { value: 0.000012, level: "server", shadowed: [] },
					supported_openai_params: { value: ["temperature", "top_p", "max_tokens"], level: "server", shadowed: [] },
				},
				outputLimitSource: "provider",
				diagnostics: [],
			},
		},
	},
	steps: [
		`[...document.querySelectorAll("table.resolved-models button")]
			.find((b) => b.textContent.trim() === "Parameters")
			.click()`,
	],
	viewport: { width: 1300, height: 1500 },
	settleMs: 500,
};

export default fixture;
