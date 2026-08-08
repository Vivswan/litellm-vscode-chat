/**
 * The caps inspector popup with the configure-jump affordances: the
 * "Configure capabilities for this model" button and per-row "edit" actions
 * on record-sourced rows only (server-reported, catalog, derived, and floor
 * rows carry none).
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [{ type: "state", state: baseState() }],
	respond: {
		readModelCapabilities: {
			type: "modelCapabilities",
			globalRecordKey: "gpt-5*",
			capabilities: {
				fields: {
					context_length: {
						value: 272000,
						level: "global",
						key: "gpt-5*",
						shadowed: [{ level: "server", value: 128000 }],
					},
					max_input_tokens: { value: 272000, level: "derived", shadowed: [] },
					max_output_tokens: { value: 16384, level: "server", shadowed: [] },
					supports_function_calling: { value: true, level: "server", shadowed: [] },
					supports_vision: { value: true, level: "entry", key: "gpt-5.6", shadowed: [] },
					supports_reasoning: { value: true, level: "global-fallback", key: "*", shadowed: [] },
					supports_audio_input: { value: false, level: "floor", shadowed: [] },
				},
				outputLimitSource: "provider",
				diagnostics: [],
			},
		},
	},
	steps: ['[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Caps").click()'],
	viewport: { width: 1300, height: 1100 },
	settleMs: 500,
};

export default fixture;
