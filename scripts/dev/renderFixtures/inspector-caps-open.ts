/**
 * The caps inspector over an OPEN vocabulary resolution: the core seven rows
 * first, then the sorted open fields - a cost override, the server-reported
 * supported_openai_params list (long value, CSS-truncated), and an unknown
 * supports_web_search override - plus one advisory unrecognized-key note
 * rendered apart from a real invalid-value problem.
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
					input_cost_per_token: { value: 0.00000175, level: "global", key: "gpt-5*", shadowed: [] },
					supported_openai_params: {
						value: ["temperature", "top_p", "max_tokens", "stream", "stop", "tools", "tool_choice", "response_format"],
						level: "server",
						shadowed: [],
					},
					supports_web_search: { value: true, level: "global", key: "gpt-5*", shadowed: [] },
				},
				outputLimitSource: "provider",
				diagnostics: [
					{ kind: "unrecognized-key", key: "supports_web_search", layer: "global", recordKey: "gpt-5*" },
					{ kind: "invalid-value", key: "output_cost_per_token", layer: "global", recordKey: "gpt-5*" },
				],
			},
		},
	},
	steps: ['[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Capabilities").click()'],
	viewport: { width: 1300, height: 1250 },
	settleMs: 500,
};

export default fixture;
