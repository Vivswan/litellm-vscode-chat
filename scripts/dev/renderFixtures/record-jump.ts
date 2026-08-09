/**
 * The configure-jump's landing: no record matches DeepSeek R1, so the
 * inspector's button creates a fresh draft group keyed by the exact model ID
 * and opens its matcher editor overlay over the Settings tab, unapplied. The
 * first step opens R1's params inspector, the second clicks Configure.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [{ type: "state", state: baseState() }],
	respond: {
		readModelParameters: {
			type: "modelParameters",
			projection: {
				rows: [],
				maxTokens: { source: "capped-default", value: 4096 },
				diagnostics: [],
			},
		},
	},
	steps: [
		'[...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Parameters").at(-1).click()',
		'[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Configure parameters for this model").click()',
	],
	viewport: { width: 1300, height: 2100 },
	settleMs: 500,
};

export default fixture;
