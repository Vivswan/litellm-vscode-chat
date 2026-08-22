/**
 * The inline-completions model row with a LANDED test-completion probe: the
 * steps click the probe button and answer its posted request with a canned
 * ack, so the screenshot shows the outcome in the row's covered description
 * slot (SettingRow's notice tenant). The fixture proves its own subject by
 * throwing when the outcome never appears.
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
					featureModelScopes: {
						...state.settings.featureModelScopes,
						inlineCompletions: "global",
						commitGeneration: null,
					},
				},
			},
		},
		{ kind: "focusSection", section: "features" },
	],
	steps: [
		`(() => {
			const row = document.querySelector('.setting-row:has([id="setting-inlineCompletions.model"])');
			const button = Array.from(row.querySelectorAll("button")).find(
				(candidate) => candidate.textContent === "Test model"
			);
			if (button === undefined) {
				throw new Error("the inline model row must render the Test model button");
			}
			button.click();
			const posted = (window.__posted || []).filter((message) => message.method === "testFeatureModel").at(-1);
			if (posted === undefined) {
				throw new Error("clicking Test model must post one testFeatureModel request");
			}
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						kind: "ack",
						id: posted.id,
						method: "testFeatureModel",
						message: "Completion received - 42 characters",
					},
				})
			);
		})()`,
		`(() => {
			const status = document.querySelector(
				'.setting-row:has([id="setting-inlineCompletions.model"]) [role="status"]'
			);
			if (status === null || !status.textContent.includes("Completion received")) {
				throw new Error("the landed probe ack must render the outcome in the covered description slot");
			}
		})()`,
	],
	viewport: { width: 1300, height: 1400 },
};

export default fixture;
