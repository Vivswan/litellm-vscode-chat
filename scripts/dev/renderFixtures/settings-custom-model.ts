/**
 * The inline-completions model row with the CUSTOM-ENTRY editor open and a
 * deliberately long typed model ID: the two-line editor state (inputs above,
 * ranked actions below) that the picker's select alone never shows. Swept at
 * every declared width, so the editor's fit is priced at the narrow tiers
 * with long values, not just at the build width.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const state = baseState();

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: {
				...state,
				settings: {
					...state.settings,
					booleans: {
						...state.settings.booleans,
						"inlineCompletions.enabled": true,
					},
					configuredScopes: {
						...state.settings.configuredScopes,
						booleans: {
							...state.settings.configuredScopes.booleans,
							"inlineCompletions.enabled": "global",
						},
					},
					featureModels: {
						...state.settings.featureModels,
						inlineCompletions: { server: "prod", model: "gpt-5-mini" },
					},
					featureModelScopes: { inlineCompletions: "global", commitGeneration: null },
				},
			},
		},
		{ kind: "focusSection", section: "settings" },
	],
	steps: [
		`(() => {
			const select = document.querySelector('[id="setting-inlineCompletions.model"]');
			if (select === null) {
				throw new Error("the inline model row must render its select");
			}
			const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
			setter.call(select, "custom");
			select.dispatchEvent(new Event("change", { bubbles: true }));
		})()`,
		`(() => {
			const input = document.querySelector(
				'.setting-row:has([id="setting-inlineCompletions.model"]) input[aria-label="Model ID"]'
			);
			if (input === null) {
				throw new Error("selecting Custom model ID... must open the two-line editor");
			}
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
			setter.call(input, "very-long-organization/very-long-fill-in-the-middle-code-model-identifier-v2-2508-fim-instruct");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		})()`,
		`(() => {
			const row = document.querySelector('.setting-row:has([id="setting-inlineCompletions.model"])');
			const use = Array.from(row.querySelectorAll("button")).find(
				(candidate) => candidate.textContent === "Use model"
			);
			if (use === undefined || use.hasAttribute("disabled")) {
				throw new Error("a declared server plus a typed model ID must arm the Use model action");
			}
		})()`,
	],
	viewport: { width: 1300, height: 1400 },
};

export default fixture;
