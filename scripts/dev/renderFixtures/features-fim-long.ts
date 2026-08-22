/**
 * The covered slot under LONG text: the commit row's vanished-server warning
 * carries a long label, and the inline row lands a long two-part probe
 * FAILURE whose Details disclosure the steps open. Both covers must render
 * one truncated line (never overrunning the reserved description height),
 * with the full selectable text in the opened detail block. Swept at every
 * declared width, so the truncation and the open block are priced at the
 * narrow tiers.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const state = baseState();

const LONG_FAIL_MESSAGE =
	"The LiteLLM server is unreachable or overloaded - try again shortly.\n" +
	"Connection Error: Unable to connect to http://litellm.internal.staging.example-corporation.com:4000. " +
	"Please check that the server is running and the URL is correct. (cause: connect ECONNREFUSED 10.20.30.40:4000)";

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
						"commitGeneration.enabled": true,
					},
					configuredScopes: {
						...state.settings.configuredScopes,
						booleans: {
							...state.settings.configuredScopes.booleans,
							"inlineCompletions.enabled": "global",
							"commitGeneration.enabled": "global",
						},
					},
					featureModels: {
						...state.settings.featureModels,
						inlineCompletions: { server: "prod", model: "gpt-5-mini" },
						commitGeneration: {
							server: "decommissioned-staging-litellm-gateway-eu-central-legacy",
							model: "claude-4",
						},
					},
					featureModelScopes: {
						...state.settings.featureModelScopes,
						inlineCompletions: "global",
						commitGeneration: "global",
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
			button.click();
			const posted = (window.__posted || []).filter((message) => message.method === "testFeatureModel").at(-1);
			if (posted === undefined) {
				throw new Error("clicking Test model must post one testFeatureModel request");
			}
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						kind: "fail",
						id: posted.id,
						method: "testFeatureModel",
						message: ${JSON.stringify(LONG_FAIL_MESSAGE)},
						failureKind: "validation",
					},
				})
			);
		})()`,
		`(() => {
			const row = document.querySelector('.setting-row:has([id="setting-inlineCompletions.model"])');
			const details = Array.from(row.querySelectorAll("button")).find(
				(candidate) => candidate.textContent === "Details"
			);
			if (details === undefined) {
				throw new Error("a long probe failure must offer the Details disclosure");
			}
			details.click();
		})()`,
		`(() => {
			const detail = document.querySelector(
				'.setting-row:has([id="setting-inlineCompletions.model"]) .setting-detail'
			);
			if (detail === null || !detail.textContent.includes("ECONNREFUSED")) {
				throw new Error("the opened detail block must carry the full selectable failure text");
			}
		})()`,
	],
	viewport: { width: 1300, height: 1600 },
};

export default fixture;
