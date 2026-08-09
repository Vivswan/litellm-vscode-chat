/**
 * The params inspector popup with the configure-jump affordances and the
 * inheritance chain figure: the "Configure parameters for this model" button,
 * the per-row "edit" actions (global record and server entry sourced rows),
 * and the record-path lines with a barrier marker. The step opens the
 * inspector from the GPT-5.6 row; the respond map answers its read.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [{ type: "state", state: baseState() }],
	respond: {
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
						{ key: "gpt-5.6", barrier: false, inheritFrom: "*" },
					],
				},
				{
					layer: "entry",
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
						inheritedFrom: "gpt-5*",
						shadowed: [{ layer: "global", key: "*", value: 0.7 }],
					},
					{
						name: "top_p",
						value: 0.9,
						sent: true,
						source: { layer: "entry", key: "*" },
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
	steps: ['[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Parameters").click()'],
	viewport: { width: 1300, height: 1100 },
	settleMs: 500,
};

export default fixture;
