/**
 * The merged model inspector over the worst-case payloads: the parameters side
 * with the configure-jump affordances, the inheritance chain figure, per-row
 * "edit" actions, and a not-sent directive row; the capabilities side with the
 * full field bag (the eight-field cost family with sub-micro values, the
 * consumed booleans, the 27-element supported_openai_params list rendering in
 * the PARAMETERS section, an unknown extra under Other fields, mixed provenance
 * across every level); and the Pricing section. The step opens the inspector
 * from the GPT-5.6 row; the respond map answers both reads.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, worstCaseCapabilityFields } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [{ kind: "push", state: baseState() }],
	respond: {
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
							{ key: "gpt-5.6", barrier: false, inheritFrom: "*" },
						],
					},
					{
						layer: "entry",
						entryLabel: "prod",
						links: [
							{ key: "*", barrier: false },
							{ key: "gpt-5*", barrier: false },
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
							inheritedBy: "gpt-5.6",
							shadowed: [{ layer: "global", key: "*", value: 0.7 }],
						},
						{
							name: "top_p",
							value: 0.9,
							sent: true,
							source: { layer: "entry", key: "*", entryLabel: "prod" },
							shadowed: [],
						},
						{
							name: "_meta",
							value: "trace",
							sent: false,
							skipReason: "underscore",
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
					fields: worstCaseCapabilityFields(),
					outputLimitSource: "provider",
					diagnostics: [],
				},
			},
		},
	},
	steps: ['[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Inspect").click()'],
	viewport: { width: 1300, height: 2600 },
	settleMs: 500,
};

export default fixture;
